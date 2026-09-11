import { randomUUID } from "node:crypto";
import { iso, json, sqlDate } from "./store.mjs";
export const statuses = [
  "operational",
  "degraded_performance",
  "partial_outage",
  "full_outage",
  "maintenance",
  "no_data",
];
const weights = {
  operational: 0,
  maintenance: 1,
  no_data: 2,
  degraded_performance: 3,
  partial_outage: 4,
  full_outage: 5,
};
export const worst = (items) =>
  items.length
    ? items.reduce((a, b) => (weights[b] > weights[a] ? b : a), "operational")
    : "no_data";
export const failed = (status) =>
  ["degraded_performance", "partial_outage", "full_outage"].includes(status);
export function effectiveStatus(component, now, staleAfter = 100000) {
  if (component.paused) return "maintenance";
  if (
    !component.checkedAt ||
    now - new Date(component.checkedAt) >
      Math.max(staleAfter, (component.intervalSeconds || 30) * 3000)
  )
    return "no_data";
  return component.status;
}
export function nextState(previous, result, now) {
  const continuous =
    previous.checkedAt &&
    now - new Date(previous.checkedAt) <=
      Math.max(100000, (previous.intervalSeconds || 30) * 3000);
  const streak =
    continuous &&
    (previous.rawStatus === result.status ||
      (failed(previous.rawStatus) && failed(result.status)))
      ? previous.streak + 1
      : 1;
  const required = failed(result.status)
    ? previous.failureThreshold || 3
    : result.status === "operational" && failed(previous.status)
      ? previous.recoveryThreshold || 2
      : 1;
  return {
    status:
      streak >= required
        ? result.status
        : continuous
          ? previous.status
          : "no_data",
    streak,
    continuous,
  };
}
export async function recordObservation(store, id, result, now = new Date()) {
  return store.transaction((db) =>
    writeObservation(store, db, id, result, now),
  );
}
export async function recordObservations(store, observations, batchSize = 25) {
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 100)
    throw new Error("Invalid observation batch size");
  // Probes finish before entering a transaction. A stable lock order and bounded
  // batches keep API edits responsive while amortizing durable commits.
  const ordered = [...observations].sort((a, b) => a.id.localeCompare(b.id));
  for (let offset = 0; offset < ordered.length; offset += batchSize) {
    await store.transaction(async (db) => {
      for (const {
        id,
        result,
        now = new Date(),
        seen = false,
      } of ordered.slice(offset, offset + batchSize))
        await writeObservation(store, db, id, result, now, seen);
    });
  }
}
async function writeObservation(store, db, id, result, now, seen = false) {
  const previous = await store.component(id, db, true);
  if (!previous || previous.archived) return;
  const state = nextState(previous, result, now);
  const at = sqlDate(now);
  await store.query(
    "INSERT INTO component_evidence (component_id,payload,updated_at) VALUES (?,?,?) ON DUPLICATE KEY UPDATE payload=VALUES(payload),updated_at=VALUES(updated_at)",
    [id, JSON.stringify(result.evidence || null), at],
    db,
  );
  await store.query(
    "UPDATE components SET status=?,raw_status=?,streak=?,checked_at=?,latency_ms=?,reason=?,last_seen=IF(?, ?, last_seen) WHERE id=?",
    [
      state.status,
      result.status,
      state.streak,
      at,
      result.latencyMs ?? null,
      (result.reason || "").slice(0, 255),
      seen,
      at,
      id,
    ],
    db,
  );
  await store.query(
    "INSERT INTO observations (component_id,checked_at,status,raw_status,latency_ms,reason) VALUES (?,?,?,?,?,?)",
    [
      id,
      at,
      state.status,
      result.status,
      result.latencyMs ?? null,
      (result.reason || "").slice(0, 255),
    ],
    db,
  );
  const [period] = await store.query(
    "SELECT * FROM periods WHERE component_id=? ORDER BY ended_at DESC,id DESC LIMIT 1",
    [id],
    db,
  );
  if (period && period.status === state.status && state.continuous) {
    await store.query(
      "UPDATE periods SET ended_at=? WHERE id=?",
      [at, period.id],
      db,
    );
  } else {
    if (period && state.continuous)
      await store.query(
        "UPDATE periods SET ended_at=? WHERE id=?",
        [at, period.id],
        db,
      );
    await store.query(
      "INSERT INTO periods (component_id,status,started_at,ended_at) VALUES (?,?,?,?)",
      [id, state.status, at, at],
      db,
    );
  }
  if (previous.incidentGroup) return state;
  if (failed(state.status)) {
    const [incident] = await store.query(
      "SELECT id FROM incidents WHERE automatic_key=?",
      [id],
      db,
    );
    if (!incident) {
      const incidentId = randomUUID();
      await store.query(
        `INSERT INTO incidents (id,title,message,component_ids,severity,phase,source,automatic_key,started_at,updated_at) VALUES (?,?,?,?,?,'investigating','monitor',?,?,?)`,
        [
          incidentId,
          `${previous.groupName || previous.group} · ${previous.name} 服务异常`.slice(
            0,
            200,
          ),
          "监测发现服务异常，正在确认影响。",
          JSON.stringify([id]),
          state.status,
          id,
          at,
          at,
        ],
        db,
      );
      await appendUpdate(
        store,
        db,
        incidentId,
        "investigating",
        "监测发现服务异常，正在确认影响。",
        at,
      );
    }
  } else if (state.status === "operational") {
    const [incident] = await store.query(
      "SELECT id FROM incidents WHERE automatic_key=?",
      [id],
      db,
    );
    if (incident) {
      await store.query(
        "UPDATE incidents SET phase='resolved', message='连续监测确认服务已恢复。', resolved_at=?,updated_at=?,automatic_key=NULL,version=version+1 WHERE id=?",
        [at, at, incident.id],
        db,
      );
      await appendUpdate(
        store,
        db,
        incident.id,
        "resolved",
        "连续监测确认服务已恢复。",
        at,
      );
    }
  }
  return state;
}
export async function reconcileGroupedIncidents(store, now = new Date()) {
  const components = await store.components();
  const groups = [
    ...new Set(
      components.filter((c) => c.incidentGroup).map((c) => c.incidentGroup),
    ),
  ];
  for (const group of groups)
    await store.transaction(async (db) => {
      const members = components.filter((c) => c.incidentGroup === group);
      const affected = members.filter((c) => failed(effectiveStatus(c, now)));
      const key = `group:${group}`;
      const [existing] = await store.query(
        "SELECT * FROM incidents WHERE automatic_key=? FOR UPDATE",
        [key],
        db,
      );
      const at = sqlDate(now);
      if (affected.length) {
        const ids = affected.map((c) => c.id).sort();
        const severity =
          affected.length === members.length &&
          affected.every((c) => c.status === "full_outage")
            ? "full_outage"
            : affected.some((c) =>
                  ["partial_outage", "full_outage"].includes(c.status),
                )
              ? "partial_outage"
              : "degraded_performance";
        if (!existing) {
          const id = randomUUID();
          await store.query(
            "INSERT INTO incidents (id,title,message,component_ids,severity,phase,source,automatic_key,started_at,updated_at) VALUES (?,?,?,?,?,'investigating','monitor',?,?,?)",
            [
              id,
              `${members[0].groupName || group} 服务异常`,
              "部分服务受到影响，正在确认。",
              JSON.stringify(ids),
              severity,
              key,
              at,
              at,
            ],
            db,
          );
          await appendUpdate(
            store,
            db,
            id,
            "investigating",
            "部分服务受到影响，正在确认。",
            at,
          );
        } else {
          // Keep the full impact set throughout the incident, including recovered
          // members, so scoped subscribers also receive its eventual resolution.
          const allIds = [
            ...new Set([...json(existing.component_ids), ...ids]),
          ].sort();
          if (
            JSON.stringify(allIds) !==
              JSON.stringify(json(existing.component_ids).sort()) ||
            severity !== existing.severity
          ) {
            await store.query(
              "UPDATE incidents SET component_ids=?,severity=?,updated_at=?,version=version+1 WHERE id=?",
              [JSON.stringify(allIds), severity, at, existing.id],
              db,
            );
            await appendUpdate(
              store,
              db,
              existing.id,
              existing.phase,
              "服务影响范围已更新。",
              at,
            );
          }
        }
      } else if (
        existing &&
        members.every((c) => effectiveStatus(c, now) === "operational")
      ) {
        await store.query(
          "UPDATE incidents SET phase='resolved',message='连续监测确认服务已恢复。',resolved_at=?,updated_at=?,automatic_key=NULL,version=version+1 WHERE id=?",
          [at, at, existing.id],
          db,
        );
        await appendUpdate(
          store,
          db,
          existing.id,
          "resolved",
          "连续监测确认服务已恢复。",
          at,
        );
      }
    });
}
export async function appendUpdate(store, db, incidentId, phase, message, at) {
  const id = randomUUID();
  await store.query(
    "INSERT INTO incident_updates (id,incident_id,message,phase,created_at) VALUES (?,?,?,?,?)",
    [id, incidentId, message, phase, at],
    db,
  );
  const [incident] = await store.query(
    "SELECT * FROM incidents WHERE id=?",
    [incidentId],
    db,
  );
  const affected = json(incident.component_ids);
  const visible = await store.components(false, db);
  if (!visible.some((c) => c.public !== false && affected.includes(c.id)))
    return id;
  const subscribers = await store.query(
    "SELECT id,component_ids FROM subscriptions WHERE active=TRUE",
    [],
    db,
  );
  for (const subscriber of subscribers) {
    const selected = json(subscriber.component_ids);
    if (selected.length && !selected.some((key) => affected.includes(key)))
      continue;
    await store.query(
      "INSERT IGNORE INTO deliveries (id,event_id,subscription_id,payload,next_at,updated_at) VALUES (?,?,?,?,?,?)",
      [
        randomUUID(),
        id,
        subscriber.id,
        JSON.stringify({ incidentId, title: incident.title, message, phase }),
        at,
        at,
      ],
      db,
    );
  }
  return id;
}
export function incidentFromRow(row, updates = []) {
  return {
    id: row.id,
    title: row.title,
    message: row.message,
    componentIds: json(row.component_ids),
    severity: row.severity,
    phase: row.phase,
    source: row.source,
    startedAt: iso(row.started_at),
    updatedAt: iso(row.updated_at),
    resolvedAt: iso(row.resolved_at),
    scheduledStart: iso(row.scheduled_start),
    scheduledEnd: iso(row.scheduled_end),
    version: row.version,
    updates: updates.map((u) => ({
      id: u.id,
      message: u.message,
      phase: u.phase,
      createdAt: iso(u.created_at),
    })),
  };
}
