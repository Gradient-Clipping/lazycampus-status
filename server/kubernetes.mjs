import { readFile } from "node:fs/promises";
import { CronExpressionParser } from "cron-parser";
import { request } from "./probes.mjs";
const resources = [
  ["Deployment", "/apis/apps/v1/deployments"],
  ["StatefulSet", "/apis/apps/v1/statefulsets"],
  ["DaemonSet", "/apis/apps/v1/daemonsets"],
  ["CronJob", "/apis/batch/v1/cronjobs"],
  ["Node", "/api/v1/nodes"],
  ["PersistentVolumeClaim", "/api/v1/persistentvolumeclaims"],
  ["Pod", "/api/v1/pods"],
  ["Job", "/apis/batch/v1/jobs"],
];
const annotationPrefix = "status.lazycampus.com/";
export function workloadResult(item, now = new Date(), jobs = []) {
  const { kind, spec = {}, status = {}, metadata = {} } = item;
  if (kind === "Node") {
    const conditions = status.conditions || [];
    if (!conditions.some((c) => c.type === "Ready" && c.status === "True"))
      return { status: "full_outage", reason: "节点未就绪" };
    return conditions.some(
      (c) =>
        [
          "MemoryPressure",
          "DiskPressure",
          "PIDPressure",
          "NetworkUnavailable",
        ].includes(c.type) && c.status === "True",
    )
      ? { status: "degraded_performance", reason: "节点资源压力" }
      : { status: "operational", reason: "节点就绪" };
  }
  if (kind === "PersistentVolumeClaim")
    return {
      status: status.phase === "Bound" ? "operational" : "full_outage",
      reason: status.phase === "Bound" ? "存储卷已绑定" : "存储卷未绑定",
    };
  if (kind === "CronJob") {
    if (spec.suspend)
      return { status: "maintenance", reason: "定时任务已暂停" };
    const base = new Date(
      status.lastSuccessfulTime || metadata.creationTimestamp,
    );
    if (!Number.isFinite(base.getTime()))
      return { status: "no_data", reason: "等待任务执行" };
    let next;
    try {
      next = CronExpressionParser.parse(spec.schedule, {
        currentDate: base,
        tz: spec.timeZone || "UTC",
      })
        .next()
        .toDate();
    } catch {
      return { status: "no_data", reason: "无法解析任务计划" };
    }
    const latest = jobs
      .filter((j) =>
        j.metadata?.ownerReferences?.some(
          (owner) => owner.uid === metadata.uid,
        ),
      )
      .sort(
        (a, b) =>
          new Date(b.metadata.creationTimestamp) -
          new Date(a.metadata.creationTimestamp),
      )[0];
    if (
      latest?.status?.conditions?.some(
        (c) => c.type === "Failed" && c.status === "True",
      ) &&
      (!status.lastSuccessfulTime ||
        new Date(latest.metadata.creationTimestamp) > base)
    )
      return { status: "full_outage", reason: "最近一次任务失败" };
    const grace = Math.max(
      300,
      Number(metadata.annotations?.[annotationPrefix + "grace-seconds"]) ||
        1800,
    );
    if (now > new Date(next.getTime() + grace * 1000))
      return { status: "full_outage", reason: "任务未在计划宽限期内成功完成" };
    return {
      status: status.lastSuccessfulTime ? "operational" : "no_data",
      reason: status.lastSuccessfulTime
        ? "最近任务执行成功"
        : "等待首次计划执行",
    };
  }
  const desired =
    kind === "DaemonSet"
      ? (status.desiredNumberScheduled ?? 0)
      : (spec.replicas ?? 1);
  const ready =
    kind === "DaemonSet"
      ? (status.numberReady ?? 0)
      : (status.readyReplicas ?? 0);
  if (!desired) return { status: "maintenance", reason: "工作负载已缩容为零" };
  if (ready === 0) return { status: "full_outage", reason: "没有就绪副本" };
  if (ready < desired)
    return { status: "partial_outage", reason: `就绪副本 ${ready}/${desired}` };
  if ((status.observedGeneration || 0) < (metadata.generation || 0))
    return { status: "degraded_performance", reason: "等待工作负载控制器同步" };
  return { status: "operational", reason: `就绪副本 ${ready}/${desired}` };
}
export function discover(items, groups = [], now = new Date()) {
  const results = [];
  const pods = items.filter((i) => i.kind === "Pod"),
    jobs = items.filter((i) => i.kind === "Job");
  for (const item of items) {
    if (["Pod", "Job"].includes(item.kind)) continue;
    const { metadata = {}, spec = {} } = item;
    const annotations = metadata.annotations || {};
    if (annotations[annotationPrefix + "enabled"] === "false") continue;
    const namespace = metadata.namespace || "cluster";
    const group = groups.find((g) => g.namespaces?.includes(namespace));
    const id = `k8s:${namespace}:${item.kind.toLowerCase()}:${metadata.name}`;
    const component = {
      id,
      name: annotations[annotationPrefix + "name"] || metadata.name,
      group: annotations[annotationPrefix + "group"] || group?.id || namespace,
      groupName: group?.name || namespace,
      kind: "kubernetes",
      public: annotations[annotationPrefix + "public"] === "true",
      namespace,
      resourceKind: item.kind,
      resourceName: metadata.name,
      intervalSeconds: 30,
    };
    results.push({ component, result: workloadResult(item, now, jobs) });
    const containers = spec.template?.spec?.containers || [];
    if (containers.length < 2) continue;
    const labels = spec.selector?.matchLabels || {};
    const selected = pods.filter(
      (p) =>
        p.metadata.namespace === namespace &&
        !p.metadata.deletionTimestamp &&
        Object.entries(labels).every(
          ([key, value]) => p.metadata.labels?.[key] === value,
        ),
    );
    for (const container of containers) {
      const ready = selected.some((p) =>
        p.status?.containerStatuses?.some(
          (c) => c.name === container.name && c.ready,
        ),
      );
      results.push({
        component: {
          ...component,
          id: `${id}:${container.name}`,
          name: `${metadata.name} · ${container.name}`,
          resourceKind: "Container",
        },
        result: {
          status: ready
            ? "operational"
            : selected.length
              ? "full_outage"
              : "no_data",
          reason: ready ? "容器就绪" : "容器未就绪",
        },
      });
    }
  }
  return results;
}
export async function clusterSnapshot(config) {
  const [token, ca] = await Promise.all([
    readFile(config.kubeDirectory + "/token", "utf8"),
    readFile(config.kubeDirectory + "/ca.crt"),
  ]);
  const results = await Promise.all(
    resources.map(async ([kind, path]) => {
      const items = [];
      let continuation = "";
      do {
        const response = await request(
          config.kubeURL +
            path +
            "?limit=250" +
            (continuation
              ? "&continue=" + encodeURIComponent(continuation)
              : ""),
          {
            timeout: 8000,
            limit: 8 * 1024 * 1024,
            headers: {
              Authorization: "Bearer " + token.trim(),
              Accept: "application/json",
            },
            ca,
            trusted: true,
          },
        );
        if (response.status !== 200)
          throw new Error(`Kubernetes ${kind} returned ${response.status}`);
        const data = JSON.parse(response.body);
        items.push(...data.items.map((item) => ({ ...item, kind })));
        continuation = data.metadata?.continue || "";
        if (items.length > 5000)
          throw new Error("Cluster inventory exceeds configured capacity");
      } while (continuation);
      return items;
    }),
  );
  return results.flat();
}
