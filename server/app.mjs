import Fastify, { LogController } from "fastify";
import cookie from "@fastify/cookie";
import staticFiles from "@fastify/static";
import swagger from "@fastify/swagger";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { installAuth } from "./auth.mjs";
import { installAPI } from "./api.mjs";
import { installSubscriptions } from "./subscriptions.mjs";
import { SnapshotService } from "./snapshot.mjs";
import { Monitor } from "./monitor.mjs";
import { schemas, publicResponses } from "./schemas.mjs";
export async function createApp({ store, config, logging = true, sendEmail }) {
  const app = Fastify({
    bodyLimit: 32768,
    requestTimeout: 20000,
    connectionTimeout: 10000,
    trustProxy: config.trustedProxy,
    genReqId: () => randomUUID(),
    logController: new LogController({ disableRequestLogging: true }),
    routerOptions: { maxParamLength: 200 },
    logger: logging
      ? {
          level: "info",
          redact: [
            "req.headers.authorization",
            "req.headers.cookie",
            "res.headers.set-cookie",
            "req.body",
            "err",
          ],
        }
      : false,
    ajv: { customOptions: { removeAdditional: false } },
  });
  const snapshots = new SnapshotService(store, config),
    monitor = new Monitor(store, config, snapshots, app.log);
  app.decorate("snapshots", snapshots);
  app.decorate("monitor", monitor);
  await app.register(cookie);
  for (const [name, schema] of Object.entries(schemas))
    app.addSchema({ $id: name, ...schema });
  await app.register(swagger, {
    openapi: {
      openapi: "3.0.3",
      info: {
        title: "Lazy Campus Status API",
        version: "1.0.0",
        description:
          "公开服务状态、故障历史与订阅；可选的组件注册、探测和心跳接入。所有时间戳使用 RFC 3339 UTC。",
      },
      servers: [{ url: config.origin }],
      components: {
        securitySchemes: {
          AdminBearer: { type: "http", scheme: "bearer" },
          AdminSession: {
            type: "apiKey",
            in: "cookie",
            name: "__Host-status_session",
          },
        },
      },
    },
  });
  const requests = new Map();
  app.addHook("onRequest", async (req, reply) => {
    reply
      .header("X-Request-Id", req.id)
      .header("Cache-Control", "no-store")
      .header("X-Content-Type-Options", "nosniff")
      .header("Referrer-Policy", "no-referrer");
    reply.header(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    );
    if (
      ["GET", "HEAD"].includes(req.method) &&
      (publicResponses[req.routeOptions.url] ||
        req.routeOptions.url === "/openapi.json")
    ) {
      reply
        .header("Access-Control-Allow-Origin", "*")
        .header("Access-Control-Expose-Headers", "X-Request-Id, Retry-After");
    }
    if (["GET", "HEAD"].includes(req.method) && req.url.startsWith("/api/")) {
      const at = Date.now();
      let rate = requests.get(req.ip);
      if (!rate || rate.until < at) {
        rate = { count: 0, until: at + 60000 };
        requests.set(req.ip, rate);
      }
      rate.count++;
      if (requests.size > 50000)
        for (const [key, value] of requests)
          if (value.until < at) requests.delete(key);
      if (rate.count > 120)
        return reply
          .header("Retry-After", Math.ceil((rate.until - at) / 1000))
          .code(429)
          .send({
            error: {
              code: "RATE_LIMITED",
              message: "请求过于频繁，请稍后再试",
              requestId: req.id,
            },
          });
    }
  });
  app.setErrorHandler((error, req, reply) => {
    const status = error.validation
      ? 400
      : error.statusCode >= 400 && error.statusCode < 600
        ? error.statusCode
        : 500;
    const code = error.validation
      ? "INVALID_REQUEST"
      : status === 500
        ? "INTERNAL_ERROR"
        : error.code || "REQUEST_FAILED";
    if (status >= 500)
      app.log.error(
        { event: "request_failed", code, path: req.routeOptions.url },
        "Request could not complete",
      );
    const message = error.validation
      ? "请求参数无效，请检查字段和取值"
      : status === 500
        ? "服务暂时不可用，请稍后重试"
        : error.message;
    return reply
      .code(status)
      .send({ error: { code, message, requestId: req.id } });
  });
  app.get("/healthz", { schema: { hide: true } }, async () => ({
    status: "ok",
    revision: config.revision,
  }));
  app.get("/readyz", { schema: { hide: true } }, async (_req, reply) =>
    reply.code(snapshots.data ? 200 : 503).send({
      status: snapshots.data ? "ready" : "starting",
      revision: config.revision,
      storage: snapshots.lastError ? "unavailable" : "available",
      snapshotAt: snapshots.data?.at.toISOString() || null,
    }),
  );
  await installAuth(app, store, config);
  await installAPI(app, store, config, snapshots, monitor);
  await installSubscriptions(app, store, config, snapshots, sendEmail);
  app.get("/openapi.json", { schema: { hide: true } }, async () =>
    app.swagger(),
  );
  app.get(
    "/api/v1/admin/metrics",
    {
      preHandler: app.authorize("admin:read"),
      schema: { tags: ["管理"], summary: "Prometheus 格式的监测器指标" },
    },
    async (_req, reply) =>
      reply
        .type("text/plain; version=0.0.4")
        .send(
          [
            "# HELP status_monitor_last_run_seconds Last completed monitor cycle.",
            "# TYPE status_monitor_last_run_seconds gauge",
            `status_monitor_last_run_seconds ${monitor.lastRun ? Date.parse(monitor.lastRun) / 1000 : 0}`,
            "# TYPE status_component_count gauge",
            `status_component_count ${snapshots.data?.components.length || 0}`,
            "# TYPE status_storage_available gauge",
            `status_storage_available ${snapshots.lastError ? 0 : 1}`,
            "# TYPE status_monitor_cycle_duration_seconds gauge",
            `status_monitor_cycle_duration_seconds ${(monitor.cycleDurationMs || 0) / 1000}`,
            "# TYPE status_mail_worker_last_run_seconds gauge",
            `status_mail_worker_last_run_seconds ${monitor.lastMailRun ? Date.parse(monitor.lastMailRun) / 1000 : 0}`,
            "# TYPE status_mail_worker_error gauge",
            `status_mail_worker_error ${monitor.lastMailError ? 1 : 0}`,
            "# TYPE status_process_resident_memory_bytes gauge",
            `status_process_resident_memory_bytes ${process.memoryUsage().rss}`,
            "",
          ].join("\n"),
        ),
  );
  const dist = fileURLToPath(new URL("../dist/", import.meta.url));
  if (existsSync(dist)) {
    await app.register(staticFiles, {
      root: dist,
      prefix: "/",
      cacheControl: false,
      index: false,
      redirect: false,
    });
    // The static handler rejects directory requests when index lookup is disabled.
    app.get("/", { schema: { hide: true } }, async (_req, reply) =>
      reply.type("text/html").sendFile("index.html"),
    );
  }
  app.setNotFoundHandler(async (req, reply) => {
    if (
      req.method === "GET" &&
      /^\/(?:history\/?|admin\/?|api-docs\/?|unsubscribe\/?|incidents\/[0-9a-f-]{36})?$/.test(
        req.url.split("?")[0],
      ) &&
      existsSync(dist + "/index.html")
    )
      return reply.type("text/html").sendFile("index.html");
    return reply.code(404).send({
      error: {
        code: "NOT_FOUND",
        message: "页面或接口不存在",
        requestId: req.id,
      },
    });
  });
  app.addHook("onClose", async () => monitor.stop());
  return app;
}
