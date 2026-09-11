import { iso } from "./store.mjs";
import { failure } from "./auth.mjs";
import { effectiveStatus, incidentFromRow, worst } from "./status.mjs";
export function dateKey(value, timeZone) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    })
      .formatToParts(value)
      .map((p) => [p.type, p.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day}`;
}
export function offsetDate(key, offset) {
  const date = new Date(key + "T12:00:00Z");
  date.setUTCDate(date.getUTCDate() + offset);
  return date.toISOString().slice(0, 10);
}
export function midnight(key, timeZone) {
  const desired = Date.parse(key + "T00:00:00Z");
  let value = desired;
  for (let index = 0; index < 4; index++) {
    const p = Object.fromEntries(
      new Intl.DateTimeFormat("en-GB", {
        timeZone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hourCycle: "h23",
      })
        .formatToParts(value)
        .map((p) => [p.type, p.value]),
    );
    const represented = Date.UTC(
      +p.year,
      +p.month - 1,
      +p.day,
      +p.hour,
      +p.minute,
      +p.second,
    );
    const next = value + desired - represented;
    if (next === value) break;
    value = next;
  }
  return value;
}
export function aggregateStatus(values) {
  if (!values.length) return "no_data";
  if (values.some((value) => ["partial_outage", "full_outage"].includes(value)))
    return values.every((value) => value === "full_outage")
      ? "full_outage"
      : "partial_outage";
  return worst(values);
}
export function historyFor(periods, days) {
  let healthy = 0,
    observed = 0;
  const history = days.map((day) => {
    let good = 0,
      known = 0,
      maintenance = 0;
    const states = [];
    for (const period of periods) {
      const duration = Math.max(
        0,
        Math.min(day.end, period.end) - Math.max(day.start, period.start),
      );
      if (!duration) continue;
      states.push(period.status);
      if (period.status === "maintenance") maintenance += duration;
      else if (period.status !== "no_data") {
        known += duration;
        if (period.status === "operational") good += duration;
      }
    }
    healthy += good;
    observed += known;
    return {
      date: day.key,
      status: states.some((status) => status !== "no_data")
        ? worst(states.filter((status) => status !== "no_data"))
        : "no_data",
      uptimePercentage: known ? +((good / known) * 100).toFixed(3) : null,
      observedSeconds: Math.round(known / 1000),
      maintenanceSeconds: Math.round(maintenance / 1000),
      coveragePercentage: +(
        ((known + maintenance) / (day.end - day.start)) *
        100
      ).toFixed(2),
    };
  });
  return {
    history,
    uptimePercentage: observed ? ((healthy / observed) * 100).toFixed(3) : null,
    observedSeconds: Math.round(observed / 1000),
  };
}
export function combinePeriods(byComponent) {
  if (!byComponent.length) return [];
  const events = [];
  byComponent.forEach((periods, index) =>
    periods.forEach((p) => {
      if (p.end <= p.start) return;
      events.push(
        { at: p.start, index, status: p.status, ending: false },
        { at: p.end, index, status: "no_data", ending: true },
      );
    }),
  );
  events.sort((a, b) => a.at - b.at || Number(b.ending) - Number(a.ending));
  const state = Array(byComponent.length).fill("no_data"),
    result = [];
  let previous = null,
    index = 0;
  while (index < events.length) {
    const at = events[index].at;
    if (previous !== null && at > previous)
      result.push({ start: previous, end: at, status: aggregateStatus(state) });
    while (index < events.length && events[index].at === at) {
      const event = events[index++];
      state[event.index] = event.status;
    }
    previous = at;
  }
  return result;
}
export class SnapshotService {
  constructor(store, config) {
    this.store = store;
    this.config = config;
    this.data = null;
    this.cache = new Map();
    this.lastError = null;
  }
  async refresh() {
    try {
      const [components, periods, incidents, updates] = await Promise.all([
        this.store.components(),
        this.store.query(
          "SELECT component_id,status,started_at,ended_at FROM periods WHERE ended_at >= DATE_SUB(UTC_TIMESTAMP(), INTERVAL 91 DAY) ORDER BY started_at",
        ),
        this.store.query(
          "SELECT * FROM incidents WHERE updated_at>=DATE_SUB(UTC_TIMESTAMP(),INTERVAL 91 DAY) OR phase NOT IN ('resolved','completed','cancelled') ORDER BY updated_at DESC LIMIT 1000",
        ),
        this.store.query(
          "SELECT * FROM incident_updates WHERE created_at>=DATE_SUB(UTC_TIMESTAMP(),INTERVAL 91 DAY) ORDER BY created_at DESC LIMIT 5000",
        ),
      ]);
      this.data = {
        components,
        periods,
        incidents: incidents.map((row) =>
          incidentFromRow(
            row,
            updates.filter((u) => u.incident_id === row.id),
          ),
        ),
        at: new Date(),
      };
      this.cache.clear();
      this.lastError = null;
    } catch {
      this.lastError = "STORAGE_UNAVAILABLE";
    }
  }
  snapshot(timeZone = "UTC", now = new Date()) {
    try {
      new Intl.DateTimeFormat("en", { timeZone }).format(now);
    } catch {
      throw failure("INVALID_TIME_ZONE", "无效的 IANA 时区");
    }
    if (!this.data)
      return {
        title: "LaZy Campus",
        overallStatus: "no_data",
        headline: "正在建立监测",
        message: "服务状态暂时不可用，请稍后重试。",
        groups: [],
        activeIncidents: [],
        scheduledMaintenances: [],
        updatedAt: null,
        stale: true,
        range: { start: dateKey(now, timeZone), end: dateKey(now, timeZone) },
        timeZone,
      };
    const stale =
      Boolean(this.lastError) || now - this.data.at > this.config.staleAfter;
    const cacheKey = timeZone + ":" + Math.floor(+now / 10000) + ":" + stale;
    if (this.cache.has(cacheKey)) return this.cache.get(cacheKey);
    if (this.cache.size > 48) this.cache.clear();
    const endKey = dateKey(now, timeZone);
    const days = Array.from({ length: 90 }, (_, i) => {
      const key = offsetDate(endKey, i - 89);
      return {
        key,
        start: midnight(key, timeZone),
        end: Math.min(+now, midnight(offsetDate(key, 1), timeZone)),
      };
    });
    const components = this.data.components.filter(
      (c) => c.public !== false && !c.archived,
    );
    const incidents = this.publicIncidents();
    const active = incidents.filter(
      (i) =>
        !["resolved", "completed", "cancelled", "scheduled"].includes(i.phase),
    );
    const groups = [];
    for (const component of components) {
      let group = groups.find((g) => g.id === component.group);
      if (!group) {
        group = {
          id: component.group,
          name: component.groupName || component.group,
          order: component.groupOrder ?? 100,
          components: [],
          periods: [],
        };
        groups.push(group);
      }
      const periods = this.data.periods
        .filter((p) => p.component_id === component.id)
        .map((p) => ({
          start: +new Date(iso(p.started_at)),
          end: +new Date(iso(p.ended_at)),
          status: p.status,
        }));
      let status = effectiveStatus(component, now, this.config.staleAfter);
      const manual = active.filter(
        (i) => i.componentIds.includes(component.id) && i.source !== "monitor",
      );
      if (manual.some((i) => i.phase === "in_progress")) status = "maintenance";
      else if (manual.length)
        status = worst([status, ...manual.map((i) => i.severity)]);
      group.components.push({
        id: component.id,
        name: component.name,
        description: component.description || "",
        status,
        checkedAt: component.checkedAt,
        latencyMs: component.latencyMs,
        kind: component.kind,
        url: component.publicUrl || "",
        ...historyFor(periods, days),
      });
      group.periods.push(periods);
    }
    groups.sort((a, b) => a.order - b.order || a.name.localeCompare(b.name));
    groups.forEach((group) => {
      group.status = aggregateStatus(group.components.map((c) => c.status));
      Object.assign(group, historyFor(combinePeriods(group.periods), days));
      delete group.periods;
      delete group.order;
    });
    const overallStatus = aggregateStatus(groups.map((g) => g.status));
    const headlines = {
      operational: "所有服务正常运行",
      degraded_performance: "部分服务性能下降",
      partial_outage: "部分服务出现异常",
      full_outage: "服务暂时不可用",
      maintenance: "部分服务正在维护",
      no_data: "部分服务状态待确认",
    };
    const result = {
      title: "LaZy Campus",
      overallStatus,
      headline: stale ? "监测数据更新延迟" : headlines[overallStatus],
      message: stale
        ? "正在重新连接监测服务；请留意各组件的最近检查时间。"
        : overallStatus === "operational"
          ? "所有已纳入监测的服务运行正常。"
          : overallStatus === "degraded_performance"
            ? "部分服务响应时间较长。"
            : "展开项目查看各组件状态与故障进展。",
      groups,
      activeIncidents: active,
      scheduledMaintenances: incidents.filter((i) => i.phase === "scheduled"),
      updatedAt: this.data.at.toISOString(),
      stale,
      range: { start: days[0].key, end: endKey },
      timeZone,
      subscriptionsEnabled: Boolean(
        this.config.senderKey && this.config.senderFrom,
      ),
    };
    this.cache.set(cacheKey, result);
    return result;
  }
  publicIncidents() {
    const publicIDs = new Set(
      (this.data?.components || [])
        .filter(
          (component) => component.public !== false && !component.archived,
        )
        .map((component) => component.id),
    );
    return (this.data?.incidents || [])
      .filter((incident) =>
        incident.componentIds.some((id) => publicIDs.has(id)),
      )
      .map((incident) => ({
        ...incident,
        componentIds: incident.componentIds.filter((id) => publicIDs.has(id)),
      }));
  }
  incident(id) {
    return (
      this.publicIncidents().find((incident) => incident.id === id) || null
    );
  }
  history(timeZone = "UTC", now = new Date()) {
    const snapshot = this.snapshot(timeZone, now),
      ids = new Set(
        snapshot.groups.flatMap((g) => g.components.map((c) => c.id)),
      );
    const months = [];
    for (let i = 0; i < 90; i++) {
      const key = offsetDate(snapshot.range.end, -i).slice(0, 7);
      if (!months.some((m) => m.key === key))
        months.push({ key, incidents: [] });
    }
    for (const incident of this.data?.incidents || []) {
      if (!incident.componentIds.some((id) => ids.has(id))) continue;
      const month = months.find(
        (m) =>
          m.key === dateKey(new Date(incident.startedAt), timeZone).slice(0, 7),
      );
      if (month)
        month.incidents.push({
          ...incident,
          componentIds: incident.componentIds.filter((id) => ids.has(id)),
        });
    }
    return {
      title: "LaZy Campus",
      range: snapshot.range,
      months,
      updatedAt: snapshot.updatedAt,
      stale: snapshot.stale,
      timeZone,
    };
  }
}
