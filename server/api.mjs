import { randomUUID } from "node:crypto";
import { failure } from "./auth.mjs";
import { hash, secret, json, iso, sqlDate } from "./store.mjs";
import { appendUpdate, incidentFromRow, statuses } from "./status.mjs";
import { validateTarget } from "./probes.mjs";
import { publicResponses } from "./schemas.mjs";
import { feedEntries, renderFeed } from "./feeds.mjs";
const idSchema = {
  type: "string",
  minLength: 1,
  maxLength: 160,
  pattern: "^[a-zA-Z0-9][a-zA-Z0-9:._-]*$",
};
const idsSchema = {
  type: "array",
  minItems: 1,
  maxItems: 50,
  uniqueItems: true,
  items: idSchema,
};
const componentProperties = {
  id: idSchema,
  name: { type: "string", minLength: 1, maxLength: 100 },
  group: { type: "string", minLength: 1, maxLength: 80 },
  groupName: { type: "string", maxLength: 100 },
  description: { type: "string", maxLength: 500 },
  kind: { type: "string", enum: ["http", "tcp", "heartbeat"] },
  target: { type: "string", maxLength: 2048 },
  public: { type: "boolean" },
  publicUrl: { type: "string", maxLength: 2048 },
  paused: { type: "boolean" },
  intervalSeconds: { type: "integer", minimum: 30, maximum: 3600 },
  timeoutSeconds: { type: "integer", minimum: 1, maximum: 15 },
  failureThreshold: { type: "integer", minimum: 1, maximum: 10 },
  recoveryThreshold: { type: "integer", minimum: 1, maximum: 10 },
  heartbeatSeconds: { type: "integer", minimum: 60, maximum: 86400 },
  degradedAfterMs: { type: "integer", minimum: 100, maximum: 15000 },
  expectedCodes: {
    type: "array",
    minItems: 1,
    maxItems: 10,
    uniqueItems: true,
    items: { type: "integer", minimum: 100, maximum: 599 },
  },
  contains: { type: "string", maxLength: 200 },
  dependencies: { ...idsSchema, minItems: 0 },
  optionalDependencies: { ...idsSchema, minItems: 0 },
  reportKey: {
    type: "string",
    minLength: 1,
    maxLength: 80,
    pattern: "^[a-zA-Z0-9_-]+$",
  },
  reportTTLSeconds: { type: "integer", minimum: 30, maximum: 3600 },
  assetCheck: { type: "boolean" },
  minRequests: { type: "integer", minimum: 1, maximum: 10000 },
  degradedErrorPercentage: { type: "number", minimum: 0.1, maximum: 100 },
  outageErrorPercentage: { type: "number", minimum: 0.1, maximum: 100 },
};
const phases = [
  "investigating",
  "identified",
  "monitoring",
  "resolved",
  "scheduled",
  "in_progress",
  "completed",
  "cancelled",
];
const security = [{ AdminBearer: [] }, { AdminSession: [] }];
export async function installAPI(app, store, config, snapshots, monitor) {
  function route(method, url, scope, schema, handler) {
    app.route({
      method,
      url,
      preHandler: scope ? app.authorize(scope) : undefined,
      schema: {
        ...schema,
        ...(scope ? { security } : {}),
        response: {
          ...(publicResponses[url] ? { 200: publicResponses[url] } : {}),
          ...Object.fromEntries(
            [400, 401, 403, 404, 409, 429, 500, 503].map((code) => [
              code,
              { $ref: "StatusError#" },
            ]),
          ),
        },
      },
      handler,
    });
  }
  async function known(ids, db) {
    for (const id of ids)
      if (!(await store.component(id, db)))
        throw failure("INVALID_COMPONENT", "所选组件不存在");
  }
  async function validateComponent(spec) {
    if (
      (spec.degradedErrorPercentage || 5) > (spec.outageErrorPercentage || 50)
    )
      throw failure("INVALID_THRESHOLD", "严重异常阈值不能低于性能下降阈值");
    try {
      validateTarget(spec, config.probeHosts);
    } catch (error) {
      throw failure("INVALID_TARGET", error.message);
    }
    if (spec.publicUrl) {
      const url = new URL(spec.publicUrl);
      if (
        !["https:", "http:"].includes(url.protocol) ||
        url.username ||
        url.password
      )
        throw failure("INVALID_URL", "公开链接必须为 HTTP(S) 地址");
    }
    await known([
      ...(spec.dependencies || []),
      ...(spec.optionalDependencies || []),
    ]);
    const all = await store.components(),
      byId = new Map(all.map((c) => [c.id, c]));
    byId.set(spec.id, spec);
    function walk(id, stack) {
      if (stack.has(id))
        throw failure("CYCLIC_DEPENDENCY", "关联服务不能形成循环");
      const next = new Set(stack).add(id);
      for (const dep of [
        ...(byId.get(id)?.dependencies || []),
        ...(byId.get(id)?.optionalDependencies || []),
      ])
        walk(dep, next);
    }
    walk(spec.id, new Set());
  }
  const timeSchema = {
    type: "object",
    properties: { timeZone: { type: "string", maxLength: 100 } },
  };
  route(
    "GET",
    "/api/v1/status",
    null,
    {
      tags: ["公开状态"],
      summary: "项目总览、90 天历史与当前故障",
      querystring: timeSchema,
    },
    async (req) => snapshots.snapshot(req.query.timeZone || "UTC"),
  );
  route("GET", "/api/v1/status-page", null, { hide: true }, async (req) =>
    snapshots.snapshot(req.query.timeZone || "UTC"),
  );
  route(
    "GET",
    "/api/v1/history",
    null,
    {
      tags: ["公开状态"],
      summary: "按月份展示故障及维护历史",
      querystring: timeSchema,
    },
    async (req) => snapshots.history(req.query.timeZone || "UTC"),
  );
  route(
    "GET",
    "/api/v1/status-page/history",
    null,
    { hide: true },
    async (req) => snapshots.history(req.query.timeZone || "UTC"),
  );
  route(
    "GET",
    "/api/v1/components",
    null,
    { tags: ["公开状态"], summary: "仅返回公开组件", querystring: timeSchema },
    async (req) => ({
      components: snapshots
        .snapshot(req.query.timeZone || "UTC")
        .groups.flatMap((g) =>
          g.components.map((c) => ({ ...c, group: g.id, groupName: g.name })),
        ),
    }),
  );
  route(
    "GET",
    "/api/v1/components/:id",
    null,
    {
      tags: ["公开状态"],
      summary: "单个公开组件的状态及历史",
      params: {
        type: "object",
        properties: { id: idSchema },
        required: ["id"],
      },
      querystring: timeSchema,
    },
    async (req) => {
      const component = snapshots
        .snapshot(req.query.timeZone || "UTC")
        .groups.flatMap((g) => g.components)
        .find((c) => c.id === req.params.id);
      if (!component) throw failure("NOT_FOUND", "项目不存在", 404);
      return component;
    },
  );
  route(
    "GET",
    "/api/v1/incidents/:id",
    null,
    {
      tags: ["公开状态"],
      summary: "公开故障详情和更新记录",
      params: {
        type: "object",
        required: ["id"],
        properties: { id: { type: "string", format: "uuid" } },
      },
    },
    async (req) => {
      const incident = snapshots.incident(req.params.id);
      if (!incident) throw failure("NOT_FOUND", "记录不存在", 404);
      return incident;
    },
  );
  route(
    "GET",
    "/api/v1/summary",
    null,
    { tags: ["公开状态"], summary: "供其他网站可选使用的轻量摘要" },
    async () => {
      const snapshot = snapshots.snapshot();
      return {
        status: snapshot.overallStatus,
        headline: snapshot.headline,
        updatedAt: snapshot.updatedAt,
        stale: snapshot.stale,
        url: config.origin,
        projects: snapshot.groups.map((g) => ({
          id: g.id,
          name: g.name,
          status: g.status,
        })),
      };
    },
  );
  for (const format of ["rss", "atom"])
    app.get(
      "/feed." + format,
      {
        schema: {
          tags: ["订阅"],
          summary: format.toUpperCase() + " 故障及维护动态",
        },
      },
      async (_req, reply) => {
        const body = renderFeed(
          format,
          config.origin,
          feedEntries(snapshots.publicIncidents()),
          snapshots.data?.at.toISOString() || new Date().toISOString(),
        );
        return reply
          .type(
            format === "rss"
              ? "application/rss+xml; charset=utf-8"
              : "application/atom+xml; charset=utf-8",
          )
          .send(body);
      },
    );
  route(
    "GET",
    "/api/v1/admin/overview",
    "admin:read",
    { tags: ["管理"], summary: "监测器、消息投递与组件概览" },
    async () => ({
      revision: config.revision,
      lastRun: monitor.lastRun,
      lastClusterSuccess: monitor.lastClusterSuccess,
      storageError: snapshots.lastError,
      cycleDurationMs: monitor.cycleDurationMs,
      lastMailRun: monitor.lastMailRun,
      lastMailError: monitor.lastMailError,
      attention: await store.query(
        "SELECT status,error_code,COUNT(*) AS count,MIN(updated_at) AS oldest FROM deliveries WHERE status IN ('failed','uncertain') OR (status IN ('pending','sending') AND updated_at<DATE_SUB(UTC_TIMESTAMP(),INTERVAL 10 MINUTE)) GROUP BY status,error_code",
      ),
      components: await store.components(),
      incidents: (
        await store.query(
          "SELECT * FROM incidents ORDER BY started_at DESC LIMIT 100",
        )
      ).map((row) => incidentFromRow(row)),
      deliveries: await store.query(
        "SELECT status,COUNT(*) AS count FROM deliveries GROUP BY status",
      ),
      limits: {
        publicRequestsPerMinute: 120,
        heartbeatPerMinute: 6,
        verificationPerHour: 3,
      },
    }),
  );
  route(
    "GET",
    "/api/v1/admin/components/:id/observations",
    "admin:read",
    {
      tags: ["管理"],
      summary: "组件最近探测明细",
      params: {
        type: "object",
        required: ["id"],
        properties: { id: idSchema },
      },
      querystring: {
        type: "object",
        properties: {
          limit: { type: "integer", minimum: 1, maximum: 200, default: 50 },
        },
      },
    },
    async (req) => ({
      observations: (
        await store.query(
          "SELECT checked_at,status,raw_status,latency_ms,reason FROM observations WHERE component_id=? ORDER BY checked_at DESC LIMIT ?",
          [req.params.id, req.query.limit],
        )
      ).map((r) => ({
        checkedAt: iso(r.checked_at),
        status: r.status,
        rawStatus: r.raw_status,
        latencyMs: r.latency_ms,
        reason: r.reason,
      })),
    }),
  );
  route(
    "POST",
    "/api/v1/admin/components",
    "components:write",
    {
      tags: ["接入"],
      summary: "注册 HTTP、TCP 或心跳组件",
      body: {
        type: "object",
        additionalProperties: false,
        required: ["id", "name", "group", "kind"],
        properties: componentProperties,
      },
    },
    async (req, reply) => {
      const spec = {
        public: true,
        intervalSeconds: 30,
        failureThreshold: 3,
        recoveryThreshold: 2,
        ...req.body,
      };
      if (spec.id.startsWith("k8s:"))
        throw failure("RESERVED_ID", "此 ID 前缀由集群发现保留");
      if (await store.component(spec.id))
        throw failure("CONFLICT", "组件 ID 已存在", 409);
      if ((await store.components()).length >= 1000)
        throw failure("CAPACITY_EXCEEDED", "组件数量已达上限", 409);
      await validateComponent(spec);
      await store.upsert(spec, "manual");
      await store.audit(req.actor, "component.create", spec.id, {
        kind: spec.kind,
        public: spec.public,
      });
      await snapshots.refresh();
      return reply.code(201).send(await store.component(spec.id));
    },
  );
  route(
    "PATCH",
    "/api/v1/admin/components/:id",
    "components:write",
    {
      tags: ["管理"],
      summary: "修改组件或覆盖显示设置；version 防止覆盖并发编辑",
      params: {
        type: "object",
        required: ["id"],
        properties: { id: idSchema },
      },
      body: {
        type: "object",
        additionalProperties: false,
        required: ["version"],
        properties: {
          ...componentProperties,
          version: { type: "integer", minimum: 1 },
          archived: { type: "boolean" },
        },
      },
    },
    async (req) => {
      const previous = await store.component(req.params.id);
      if (!previous) throw failure("NOT_FOUND", "组件不存在", 404);
      if (req.body.id && req.body.id !== previous.id)
        throw failure("INVALID_ID", "组件 ID 不能修改");
      const { version, archived, ...patch } = req.body;
      if (
        previous.source !== "manual" &&
        Object.keys(patch).some(
          (k) =>
            ![
              "name",
              "description",
              "public",
              "paused",
              "group",
              "groupName",
              "publicUrl",
              "intervalSeconds",
              "timeoutSeconds",
              "failureThreshold",
              "recoveryThreshold",
              "degradedAfterMs",
              "reportTTLSeconds",
              "minRequests",
              "degradedErrorPercentage",
              "outageErrorPercentage",
            ].includes(k),
        )
      )
        throw failure("MANAGED_COMPONENT", "此组件的探测配置由 GitOps 管理");
      if (archived && previous.source !== "manual")
        throw failure("MANAGED_COMPONENT", "自动发现的组件请在 GitOps 中排除");
      const spec = { ...previous, ...patch };
      if (
        (spec.degradedErrorPercentage || 5) > (spec.outageErrorPercentage || 50)
      )
        throw failure("INVALID_THRESHOLD", "严重异常阈值不能低于性能下降阈值");
      if (previous.source === "manual") await validateComponent(spec);
      const result = await store.query(
        "UPDATE components SET overrides=JSON_MERGE_PATCH(overrides,CAST(? AS JSON)),archived=?,version=version+1,updated_at=UTC_TIMESTAMP(3) WHERE id=? AND version=?",
        [
          JSON.stringify(patch),
          archived ?? previous.archived,
          previous.id,
          version,
        ],
      );
      if (!result.affectedRows)
        throw failure("CONFLICT", "记录已被修改，请刷新后重试", 409);
      await store.audit(req.actor, "component.update", previous.id, {
        fields: Object.keys(patch),
        archived,
      });
      await snapshots.refresh();
      return store.component(previous.id);
    },
  );
  route(
    "POST",
    "/api/v1/admin/incidents",
    "incidents:write",
    {
      tags: ["管理"],
      summary: "发布故障或计划维护",
      headers: {
        type: "object",
        properties: {
          "idempotency-key": {
            type: "string",
            minLength: 8,
            maxLength: 128,
            pattern: "^[A-Za-z0-9._:-]+$",
          },
        },
      },
      body: {
        type: "object",
        additionalProperties: false,
        required: ["title", "message", "componentIds", "severity"],
        properties: {
          title: { type: "string", minLength: 1, maxLength: 160 },
          message: { type: "string", minLength: 1, maxLength: 4000 },
          componentIds: idsSchema,
          severity: {
            type: "string",
            enum: [
              "degraded_performance",
              "partial_outage",
              "full_outage",
              "maintenance",
            ],
          },
          scheduledStart: { type: "string", format: "date-time" },
          scheduledEnd: { type: "string", format: "date-time" },
        },
      },
    },
    async (req, reply) => {
      const body = req.body;
      await known(body.componentIds);
      const maintenance = body.severity === "maintenance";
      if (
        maintenance &&
        (!body.scheduledStart ||
          !body.scheduledEnd ||
          Date.parse(body.scheduledEnd) <=
            Math.max(Date.now(), Date.parse(body.scheduledStart)) ||
          Date.parse(body.scheduledStart) < Date.now() - 60000)
      )
        throw failure(
          "INVALID_SCHEDULE",
          "维护结束时间须晚于开始时间和当前时间",
        );
      if (!maintenance && (body.scheduledStart || body.scheduledEnd))
        throw failure("INVALID_SCHEDULE", "只有维护事件可以设置计划时间");
      let id = randomUUID();
      const at = sqlDate(new Date()),
        phase = maintenance ? "scheduled" : "investigating";
      await store.transaction(async (db) => {
        if (req.headers["idempotency-key"]) {
          const key = hash(
            req.actor + ":incident:" + req.headers["idempotency-key"],
          );
          const fingerprint = hash(JSON.stringify(body));
          await store.query(
            "INSERT IGNORE INTO idempotency (id,fingerprint,resource_id,created_at) VALUES (?,?,?,?)",
            [key, fingerprint, id, at],
            db,
          );
          const [entry] = await store.query(
            "SELECT * FROM idempotency WHERE id=? FOR UPDATE",
            [key],
            db,
          );
          if (entry.fingerprint !== fingerprint)
            throw failure(
              "IDEMPOTENCY_CONFLICT",
              "此幂等键已用于不同内容",
              409,
            );
          if (entry.resource_id !== id) {
            id = entry.resource_id;
            return;
          }
        }
        await store.query(
          "INSERT INTO incidents (id,title,message,component_ids,severity,phase,source,started_at,updated_at,scheduled_start,scheduled_end) VALUES (?,?,?,?,?,?,'manual',?,?,?,?)",
          [
            id,
            body.title,
            body.message,
            JSON.stringify(body.componentIds),
            body.severity,
            phase,
            at,
            at,
            maintenance ? sqlDate(body.scheduledStart) : null,
            maintenance ? sqlDate(body.scheduledEnd) : null,
          ],
          db,
        );
        await appendUpdate(store, db, id, phase, body.message, at);
        await store.audit(
          req.actor,
          "incident.create",
          id,
          { phase, componentIds: body.componentIds },
          db,
        );
      });
      await snapshots.refresh();
      return reply.code(201).send({ id, version: 1 });
    },
  );
  route(
    "POST",
    "/api/v1/admin/incidents/:id/updates",
    "incidents:write",
    {
      tags: ["管理"],
      summary: "更新故障进展或结束维护",
      params: {
        type: "object",
        required: ["id"],
        properties: { id: { type: "string", format: "uuid" } },
      },
      body: {
        type: "object",
        additionalProperties: false,
        required: ["version", "phase", "message"],
        properties: {
          version: { type: "integer", minimum: 1 },
          phase: { type: "string", enum: phases },
          message: { type: "string", minLength: 1, maxLength: 4000 },
        },
      },
    },
    async (req) => {
      await store.transaction(async (db) => {
        const [row] = await store.query(
          "SELECT * FROM incidents WHERE id=? FOR UPDATE",
          [req.params.id],
          db,
        );
        if (!row) throw failure("NOT_FOUND", "记录不存在", 404);
        if (row.version !== req.body.version)
          throw failure("CONFLICT", "记录已更新，请刷新后重试", 409);
        const transitions = {
          investigating: [
            "investigating",
            "identified",
            "monitoring",
            "resolved",
          ],
          identified: ["identified", "monitoring", "resolved"],
          monitoring: ["monitoring", "identified", "resolved"],
          scheduled: ["scheduled", "in_progress", "cancelled"],
          in_progress: ["in_progress", "completed"],
          resolved: [],
          completed: [],
          cancelled: [],
        };
        if (!transitions[row.phase]?.includes(req.body.phase))
          throw failure("INVALID_TRANSITION", "此记录不能切换到所选状态");
        if (row.source === "monitor" && req.body.phase === "resolved")
          throw failure("MONITOR_OWNED", "自动故障会在连续监测确认恢复后关闭");
        const at = sqlDate(new Date()),
          resolved = ["resolved", "completed", "cancelled"].includes(
            req.body.phase,
          );
        await store.query(
          "UPDATE incidents SET phase=?,message=?,updated_at=?,resolved_at=?,version=version+1 WHERE id=?",
          [req.body.phase, req.body.message, at, resolved ? at : null, row.id],
          db,
        );
        await appendUpdate(
          store,
          db,
          row.id,
          req.body.phase,
          req.body.message,
          at,
        );
        await store.audit(
          req.actor,
          "incident.update",
          row.id,
          { phase: req.body.phase },
          db,
        );
      });
      await snapshots.refresh();
      return { ok: true };
    },
  );
  route(
    "GET",
    "/api/v1/admin/tokens",
    "admin:read",
    { tags: ["接入"], summary: "查看接入凭据；不返回密钥" },
    async () => ({
      tokens: (
        await store.query(
          "SELECT id,name,scopes,component_ids,expires_at,revoked,created_at,last_used_at FROM api_tokens ORDER BY created_at DESC LIMIT 200",
        )
      ).map((t) => ({
        ...t,
        scopes: json(t.scopes),
        component_ids: json(t.component_ids),
        expires_at: iso(t.expires_at),
        created_at: iso(t.created_at),
        last_used_at: iso(t.last_used_at),
      })),
    }),
  );
  route(
    "POST",
    "/api/v1/admin/tokens",
    "tokens:write",
    {
      tags: ["接入"],
      summary: "签发有期限和权限范围的接入凭据；密钥只返回一次",
      body: {
        type: "object",
        additionalProperties: false,
        required: ["name", "scopes", "expiresDays"],
        properties: {
          name: { type: "string", minLength: 1, maxLength: 100 },
          scopes: {
            type: "array",
            minItems: 1,
            maxItems: 4,
            uniqueItems: true,
            items: {
              type: "string",
              enum: [
                "admin:read",
                "components:write",
                "incidents:write",
                "heartbeat:write",
              ],
            },
          },
          componentIds: { ...idsSchema, minItems: 0 },
          expiresDays: { type: "integer", minimum: 1, maximum: 365 },
        },
      },
    },
    async (req, reply) => {
      const components = req.body.componentIds || [];
      if (req.body.scopes.includes("heartbeat:write") && !components.length)
        throw failure("COMPONENT_REQUIRED", "心跳凭据必须绑定组件");
      await known(components);
      for (const id of components)
        if ((await store.component(id)).kind !== "heartbeat")
          throw failure("INVALID_COMPONENT", "心跳凭据只能绑定心跳组件");
      const id = randomUUID(),
        token = secret(),
        expires = new Date(Date.now() + req.body.expiresDays * 86400000);
      await store.query(
        "INSERT INTO api_tokens (id,hash,name,scopes,component_ids,expires_at,created_at) VALUES (?,?,?,?,?,?,UTC_TIMESTAMP(3))",
        [
          id,
          hash(token),
          req.body.name,
          JSON.stringify(req.body.scopes),
          JSON.stringify(components),
          sqlDate(expires),
        ],
      );
      await store.audit(req.actor, "token.create", id, {
        scopes: req.body.scopes,
        componentIds: components,
      });
      return reply
        .code(201)
        .send({ id, token, expiresAt: expires.toISOString() });
    },
  );
  route(
    "DELETE",
    "/api/v1/admin/tokens/:id",
    "tokens:write",
    {
      tags: ["接入"],
      summary: "撤销接入凭据",
      params: {
        type: "object",
        required: ["id"],
        properties: { id: { type: "string", format: "uuid" } },
      },
    },
    async (req) => {
      await store.query("UPDATE api_tokens SET revoked=TRUE WHERE id=?", [
        req.params.id,
      ]);
      await store.audit(req.actor, "token.revoke", req.params.id);
      return { ok: true };
    },
  );
  route(
    "POST",
    "/api/v1/heartbeats/:id",
    "heartbeat:write",
    {
      tags: ["接入"],
      summary: "以组件专属凭据上报心跳；不接受任意回调地址",
      params: {
        type: "object",
        required: ["id"],
        properties: { id: idSchema },
      },
      body: {
        type: "object",
        additionalProperties: false,
        required: ["status"],
        properties: {
          status: {
            type: "string",
            enum: statuses.filter(
              (s) => !["no_data", "maintenance"].includes(s),
            ),
          },
        },
      },
    },
    async (req, reply) => {
      const component = await store.component(req.params.id);
      if (!component || component.kind !== "heartbeat" || component.archived)
        throw failure("NOT_FOUND", "心跳组件不存在", 404);
      if (req.tokenComponents && !req.tokenComponents.includes(component.id))
        throw failure("FORBIDDEN", "凭据未授权此组件", 403);
      const retry = await store.rate("heartbeat:" + component.id, 6, 60);
      if (retry) {
        reply.header("Retry-After", retry);
        throw failure("RATE_LIMITED", "心跳上报过于频繁", 429);
      }
      await store.query(
        "UPDATE components SET heartbeat_at=UTC_TIMESTAMP(3),heartbeat_status=? WHERE id=?",
        [req.body.status, component.id],
      );
      return { accepted: true };
    },
  );
  route(
    "GET",
    "/api/v1/admin/audit",
    "admin:read",
    { tags: ["管理"], summary: "最近管理操作审计" },
    async () => ({
      events: (
        await store.query("SELECT * FROM audit ORDER BY id DESC LIMIT 100")
      ).map((row) => ({
        ...row,
        created_at: iso(row.created_at),
        detail: json(row.detail),
      })),
    }),
  );
}
