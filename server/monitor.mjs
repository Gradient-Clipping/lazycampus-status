import { readCatalog } from "./config.mjs";
import { clusterSnapshot, discover } from "./kubernetes.mjs";
import { probe, validateTarget } from "./probes.mjs";
import { appendUpdate, effectiveStatus, recordObservation } from "./status.mjs";
import { sqlDate } from "./store.mjs";
import { deliverEmails } from "./subscriptions.mjs";

export class Monitor {
  constructor(store, config, snapshots, logger) {
    this.store = store;
    this.config = config;
    this.snapshots = snapshots;
    this.logger = logger;
    this.timer = null;
    this.mailTimer = null;
    this.mailRunning = null;
    this.running = null;
    this.lastRun = null;
    this.lastClusterSuccess = null;
    this.lastCleanup = 0;
    this.stopping = false;
  }
  async cycle() {
    if (this.running) return this.running;
    this.running = this.store
      .locked("lazycampus-status-monitor-v1", async () => {
        const now = new Date(),
          catalog = await readCatalog(this.config.configFile);
        const groups = catalog.groups || [];
        for (const spec of catalog.monitors) {
          validateTarget(spec, this.config.probeHosts);
          const group = groups.find((g) => g.id === spec.group);
          await this.store.upsert(
            {
              ...spec,
              groupName: group?.name || spec.group,
              groupOrder: Math.max(
                0,
                groups.findIndex((g) => g.id === spec.group),
              ),
            },
            "config",
            now,
          );
        }
        if (this.config.configFile) {
          const configured = new Set(catalog.monitors.map((c) => c.id));
          for (const component of await this.store.components()) {
            if (
              component.source === "config" &&
              !configured.has(component.id)
            ) {
              await this.store.query(
                "UPDATE components SET archived=TRUE WHERE id=?",
                [component.id],
              );
            }
          }
        }
        if (this.config.kube) {
          try {
            const items = await clusterSnapshot(this.config);
            const discovered = discover(items, groups, now);
            for (const { component, result } of discovered) {
              await this.store.upsert(component, "kubernetes", now);
              const current = await this.store.component(component.id);
              await recordObservation(
                this.store,
                component.id,
                current.paused
                  ? { status: "maintenance", reason: "监测已暂停" }
                  : result,
                now,
              );
            }
            this.lastClusterSuccess = now.toISOString();
            const existing = await this.store.components();
            const ids = new Set(discovered.map((d) => d.component.id));
            for (const component of existing.filter(
              (c) => c.source === "kubernetes" && !ids.has(c.id),
            )) {
              await recordObservation(
                this.store,
                component.id,
                { status: "no_data", reason: "工作负载已移除或不再纳入发现" },
                now,
              );
              if (now - new Date(component.lastSeen) > 10 * 60 * 1000)
                await this.store.query(
                  "UPDATE components SET archived=TRUE WHERE id=?",
                  [component.id],
                );
            }
          } catch {
            this.logger.warn(
              { event: "cluster_discovery_failed" },
              "Cluster discovery unavailable; previous checks will become unknown",
            );
          }
        }
        await this.advanceMaintenance(now);
        const components = await this.store.components();
        const byId = new Map(components.map((c) => [c.id, c]));
        const manual = components.filter(
          (c) =>
            c.kind !== "kubernetes" &&
            (!c.checkedAt ||
              now - new Date(c.checkedAt) >=
                (c.intervalSeconds || 30) * 1000 - 1000),
        );
        // A bounded pool avoids overlapping scheduled requests and uncontrolled fan-out.
        let next = 0;
        await Promise.all(
          Array.from({ length: Math.min(4, manual.length) }, async () => {
            while (next < manual.length) {
              const component = manual[next++];
              const maintenance = await this.store.query(
                "SELECT id FROM incidents WHERE phase='in_progress' AND JSON_CONTAINS(component_ids,JSON_QUOTE(?)) LIMIT 1",
                [component.id],
              );
              const result = maintenance.length
                ? { status: "maintenance", reason: "计划维护中" }
                : await probe(component, this.config.probeHosts, now);
              if (
                !maintenance.length &&
                !component.paused &&
                result.status === "operational"
              ) {
                const states = (component.dependencies || []).map((id) =>
                  byId.has(id)
                    ? effectiveStatus(byId.get(id), now, this.config.staleAfter)
                    : "no_data",
                );
                if (
                  states.some((s) =>
                    ["partial_outage", "full_outage"].includes(s),
                  )
                )
                  Object.assign(result, {
                    status: "partial_outage",
                    reason: "关联服务未就绪",
                  });
                else if (states.some((s) => s === "degraded_performance"))
                  Object.assign(result, {
                    status: "degraded_performance",
                    reason: "关联服务性能下降",
                  });
                else if (states.some((s) => s === "no_data"))
                  Object.assign(result, {
                    status: "no_data",
                    reason: "关联服务状态待确认",
                  });
              }
              await recordObservation(
                this.store,
                component.id,
                result,
                new Date(),
              );
            }
          }),
        );
        if (Date.now() - this.lastCleanup > 3600000) {
          await this.cleanup();
          this.lastCleanup = Date.now();
        }
        this.lastRun = new Date().toISOString();
      })
      .catch(() =>
        this.logger.error(
          { event: "monitor_cycle_failed" },
          "Monitor cycle could not complete",
        ),
      )
      .finally(async () => {
        await this.snapshots.refresh();
        this.running = null;
      });
    return this.running;
  }
  async advanceMaintenance(now) {
    await this.store.transaction(async (db) => {
      const rows = await this.store.query(
        "SELECT * FROM incidents WHERE phase='scheduled' AND scheduled_start<=? OR phase='in_progress' AND scheduled_end<=? FOR UPDATE",
        [sqlDate(now), sqlDate(now)],
        db,
      );
      for (const row of rows) {
        const phase = row.phase === "scheduled" ? "in_progress" : "completed";
        const message =
          phase === "in_progress"
            ? "计划维护已开始。"
            : "计划维护时间已结束，服务状态继续由监测确认。";
        await this.store.query(
          "UPDATE incidents SET phase=?,message=?,updated_at=?,resolved_at=?,version=version+1 WHERE id=?",
          [
            phase,
            message,
            sqlDate(now),
            phase === "completed" ? sqlDate(now) : null,
            row.id,
          ],
          db,
        );
        await appendUpdate(
          this.store,
          db,
          row.id,
          phase,
          message,
          sqlDate(now),
        );
      }
    });
  }
  async cleanup() {
    for (const [table, condition] of [
      ["observations", "checked_at<DATE_SUB(UTC_TIMESTAMP(),INTERVAL 7 DAY)"],
      ["periods", "ended_at<DATE_SUB(UTC_TIMESTAMP(),INTERVAL 100 DAY)"],
      ["rate_limits", "expires_at<UTC_TIMESTAMP()"],
      ["sessions", "expires_at<UTC_TIMESTAMP()"],
      ["audit", "created_at<DATE_SUB(UTC_TIMESTAMP(),INTERVAL 90 DAY)"],
      [
        "deliveries",
        "updated_at<DATE_SUB(UTC_TIMESTAMP(),INTERVAL 30 DAY) AND status NOT IN ('pending','sending')",
      ],
    ])
      await this.store.query(
        `DELETE FROM ${table} WHERE ${condition} LIMIT 10000`,
      );
  }
  start() {
    void this.cycle();
    void this.mailCycle();
    this.timer = setInterval(() => {
      void this.cycle();
    }, this.config.interval);
    this.mailTimer = setInterval(() => {
      void this.mailCycle();
    }, 30000);
  }
  async mailCycle() {
    if (this.mailRunning) return this.mailRunning;
    this.mailRunning = this.store
      .locked("lazycampus-status-mail-v1", () =>
        deliverEmails(this.store, this.config),
      )
      .catch(() =>
        this.logger.error(
          { event: "mail_worker_failed" },
          "Mail delivery could not complete",
        ),
      )
      .finally(() => {
        this.mailRunning = null;
      });
    return this.mailRunning;
  }
  async stop() {
    this.stopping = true;
    clearInterval(this.timer);
    clearInterval(this.mailTimer);
    await Promise.all([this.running, this.mailRunning]);
  }
}
