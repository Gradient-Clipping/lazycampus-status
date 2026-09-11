import { statuses, worst } from "./status.mjs";

// Only this allowlist crosses the public boundary. Never return report messages,
// URLs, dependency names, task names, credentials or arbitrary application data.
export function publicEvidence(value) {
  if (!value || typeof value !== "object") return null;
  const result = {};
  for (const key of [
    "requests",
    "errors",
    "limited",
    "p95Ms",
    "windowSeconds",
  ]) {
    if (Number.isFinite(value[key]) && value[key] >= 0)
      result[key] = Math.min(1e12, Math.round(value[key]));
  }
  if (
    Number.isFinite(value.requests) &&
    value.requests > 0 &&
    Number.isFinite(value.errors) &&
    value.errors >= 0 &&
    value.errors <= value.requests
  )
    result.successPercentage = 100 * (1 - value.errors / value.requests);
  else if (value.requests !== 0 && Number.isFinite(value.successPercentage))
    result.successPercentage = Math.max(
      0,
      Math.min(100, value.successPercentage),
    );
  if (Number.isFinite(Date.parse(value.observedAt)))
    result.observedAt = new Date(value.observedAt).toISOString();
  return Object.keys(result).length ? result : null;
}

export function freshEvidence(value, now, ttl = 100) {
  const at = Date.parse(value?.observedAt);
  return Number.isFinite(at) && at <= +now + 30000 && +now - at <= ttl * 1000
    ? publicEvidence(value)
    : null;
}

export function interpretReport(body, key, now, ttl = 100, policy = {}) {
  let report;
  try {
    report = JSON.parse(body);
  } catch {
    /* malformed reports are unknown */
  }
  const at = Date.parse(report?.observedAt);
  const item = report?.components?.[key];
  if (
    report?.version !== 1 ||
    !Number.isFinite(at) ||
    at > +now + 30000 ||
    +now - at > ttl * 1000 ||
    !item ||
    !statuses.includes(item.status) ||
    (item.healthStatus !== undefined && !statuses.includes(item.healthStatus))
  )
    return { status: "no_data", reason: "业务报告缺失、过期或格式无效" };
  let status = item.status;
  if (
    ["operational", "degraded_performance", "partial_outage"].includes(
      status,
    ) &&
    Number.isFinite(item.requests) &&
    item.requests > 0 &&
    Number.isFinite(item.errors) &&
    item.errors >= 0 &&
    item.errors <= item.requests
  ) {
    const significant =
      item.requests >= (policy.minRequests || 20) ||
      (item.errors >= 3 && item.errors === item.requests);
    const percent = (100 * item.errors) / item.requests;
    status = !significant
      ? "operational"
      : percent >= (policy.outageErrorPercentage || 50)
        ? "partial_outage"
        : percent >= (policy.degradedErrorPercentage || 5) ||
            item.p95Ms > (policy.degradedAfterMs || 3000)
          ? "degraded_performance"
          : "operational";
  }
  // Runtime traffic thresholds must never erase an independent readiness failure.
  status = worst([status, item.healthStatus ?? item.status]);
  return {
    status,
    reason: status === "no_data" ? "业务组件状态待确认" : "业务组件检查完成",
    evidence: publicEvidence({ ...item, observedAt: report.observedAt }),
  };
}

export function dependencyResult(component, result, byId, statusOf) {
  if (!["operational", "degraded_performance"].includes(result.status))
    return result;
  const dependencies = (component.dependencies || []).map((id) => ({
    id,
    status: statusOf(byId.get(id)),
  }));
  const cause = dependencies.find((d) =>
    ["full_outage", "partial_outage"].includes(d.status),
  );
  if (cause)
    return {
      ...result,
      status: "partial_outage",
      reason: "关联服务未就绪",
      cause: cause.id,
    };
  if (dependencies.some((d) => d.status === "no_data"))
    return { ...result, status: "no_data", reason: "关联服务状态待确认" };
  if (
    dependencies.some((d) => d.status === "degraded_performance") ||
    (component.optionalDependencies || []).some((id) =>
      ["full_outage", "partial_outage", "degraded_performance"].includes(
        statusOf(byId.get(id)),
      ),
    )
  )
    return {
      ...result,
      status: "degraded_performance",
      reason: "部分关联能力受影响",
    };
  return result;
}
