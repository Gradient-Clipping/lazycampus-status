import { createHmac, randomInt, randomUUID } from "node:crypto";
import { equal, failure } from "./auth.mjs";
import { hash, json, sqlDate } from "./store.mjs";
const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
function unsubscribeToken(id, config) {
  return createHmac("sha256", config.adminToken)
    .update("unsubscribe:" + id)
    .digest("base64url");
}
export async function sendEmail(config, email, subject, text) {
  if (!config.senderKey || !config.senderFrom)
    return { ok: false, retry: false, code: "NOT_CONFIGURED" };
  try {
    const response = await fetch("https://api.sender.net/v2/message/send", {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(15000),
      headers: {
        Authorization: "Bearer " + config.senderKey,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        from: { email: config.senderFrom, name: "Lazy Campus Status" },
        to: { email },
        subject,
        text,
      }),
    });
    if (!response.ok) {
      await response.body?.cancel();
      return {
        ok: false,
        retry: response.status === 429 || response.status >= 500,
        code: "HTTP_" + response.status,
        retryAfter: Math.min(
          86400,
          Math.max(0, Number(response.headers.get("Retry-After")) || 0),
        ),
      };
    }
    const chunks = [];
    let size = 0;
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > 32768)
        return { ok: false, retry: false, code: "DELIVERY_UNCERTAIN" };
      chunks.push(chunk);
    }
    const result = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    return {
      ok: result.success === true,
      retry: false,
      code: result.success === true ? "ACCEPTED" : "REJECTED",
    };
  } catch {
    return { ok: false, retry: false, code: "DELIVERY_UNCERTAIN" };
  }
}
export async function deliverEmails(store, config, send = sendEmail) {
  if (!config.senderKey || !config.senderFrom) return;
  // An interrupted request has an unknown delivery outcome; never blindly resend it.
  await store.query(
    "UPDATE deliveries SET status='uncertain',error_code='WORKER_INTERRUPTED',updated_at=UTC_TIMESTAMP(3) WHERE status='sending' AND updated_at<DATE_SUB(UTC_TIMESTAMP(3),INTERVAL 2 MINUTE)",
  );
  const rows = await store.query(
    "SELECT d.*,s.email,s.active FROM deliveries d JOIN subscriptions s ON s.id=d.subscription_id WHERE d.status='pending' AND d.next_at<=UTC_TIMESTAMP(3) ORDER BY d.next_at LIMIT 5",
  );
  for (const row of rows) {
    if (!row.active) {
      await store.query(
        "UPDATE deliveries SET status='cancelled',updated_at=UTC_TIMESTAMP(3) WHERE id=?",
        [row.id],
      );
      continue;
    }
    if (await store.rate("email-events-global", 500, 86400)) break;
    await store.query(
      "UPDATE deliveries SET status='sending',attempts=attempts+1,updated_at=UTC_TIMESTAMP(3) WHERE id=?",
      [row.id],
    );
    const payload = json(row.payload),
      link = config.origin + "/incidents/" + payload.incidentId;
    const unsubscribe =
      config.origin +
      "/unsubscribe#" +
      row.subscription_id +
      "." +
      unsubscribeToken(row.subscription_id, config);
    const result = await send(
      config,
      row.email,
      payload.title,
      `${payload.message}\n\n查看进展：${link}\n退订通知：${unsubscribe}`,
    );
    const nextStatus = result.ok
      ? "sent"
      : result.retry && row.attempts < 4
        ? "pending"
        : result.code === "DELIVERY_UNCERTAIN"
          ? "uncertain"
          : "failed";
    await store.query(
      "UPDATE deliveries SET status=?,error_code=?,next_at=DATE_ADD(UTC_TIMESTAMP(3),INTERVAL ? SECOND),updated_at=UTC_TIMESTAMP(3) WHERE id=?",
      [
        nextStatus,
        result.ok ? null : result.code,
        Math.max(
          result.retryAfter || 0,
          Math.min(3600, 60 * 2 ** row.attempts),
        ),
        row.id,
      ],
    );
  }
}
export async function installSubscriptions(
  app,
  store,
  config,
  snapshots,
  send = sendEmail,
) {
  const body = {
    type: "object",
    additionalProperties: false,
    required: ["email"],
    properties: {
      email: { type: "string", minLength: 3, maxLength: 254 },
      componentIds: {
        type: "array",
        maxItems: 50,
        uniqueItems: true,
        items: { type: "string", maxLength: 160 },
      },
    },
  };
  app.post(
    "/api/v1/subscriptions",
    {
      schema: {
        tags: ["订阅"],
        summary: "请求订阅验证码；验证后才会启用",
        body,
      },
    },
    async (req, reply) => {
      if (!config.senderKey || !config.senderFrom)
        throw failure(
          "EMAIL_UNAVAILABLE",
          "邮件订阅暂不可用，可使用 RSS 订阅",
          503,
        );
      const email = req.body.email.trim().toLowerCase();
      if (!emailPattern.test(email))
        throw failure("INVALID_EMAIL", "请输入有效邮箱");
      const selected = req.body.componentIds || [],
        available = new Set(
          snapshots
            .snapshot()
            .groups.flatMap((g) => g.components.map((c) => c.id)),
        );
      if (selected.some((id) => !available.has(id)))
        throw failure("INVALID_COMPONENT", "所选项目不存在");
      for (const [key, max, seconds] of [
        ["subscription-ip:" + req.ip, 3, 3600],
        ["subscription-email:" + email, 1, 60],
        ["subscription-email-day:" + email, 6, 86400],
        ["subscription-global", 100, 86400],
      ]) {
        const retry = await store.rate(key, max, seconds);
        if (retry) {
          reply.header("Retry-After", retry);
          throw failure("RATE_LIMITED", "请求过于频繁，请稍后再试", 429);
        }
      }
      const code = String(randomInt(100000, 1000000)),
        id = randomUUID();
      const codeHash = hash(config.adminToken + ":" + email + ":" + code);
      await store.query(
        `INSERT INTO subscriptions (id,email,component_ids,pending_component_ids,verify_hash,verify_expires,unsubscribe_hash,created_at,updated_at)
      VALUES (?,?,'[]',?,?,DATE_ADD(UTC_TIMESTAMP(3),INTERVAL 10 MINUTE),'',UTC_TIMESTAMP(3),UTC_TIMESTAMP(3))
      ON DUPLICATE KEY UPDATE pending_component_ids=VALUES(pending_component_ids),verify_hash=VALUES(verify_hash),verify_expires=VALUES(verify_expires),updated_at=UTC_TIMESTAMP(3)`,
        [id, email, JSON.stringify(selected), codeHash],
      );
      const result = await send(
        config,
        email,
        "Lazy Campus Status 订阅验证码",
        `你的验证码为 ${code}，10 分钟内有效。\n验证后将收到所选服务的故障和维护通知。若非本人操作，请忽略。`,
      );
      if (!result.ok)
        throw failure(
          "EMAIL_UNAVAILABLE",
          "邮件暂未能确认提交，请稍后再试",
          503,
        );
      return reply
        .code(202)
        .send({ message: "验证码邮件已提交，请查收邮箱。" });
    },
  );
  app.post(
    "/api/v1/subscriptions/confirm",
    {
      schema: {
        tags: ["订阅"],
        summary: "验证邮箱并启用订阅",
        body: {
          type: "object",
          additionalProperties: false,
          required: ["email", "code"],
          properties: {
            email: { type: "string", maxLength: 254 },
            code: { type: "string", pattern: "^[0-9]{6}$" },
          },
        },
      },
    },
    async (req, reply) => {
      const email = req.body.email.trim().toLowerCase();
      for (const key of ["verify-ip:" + req.ip, "verify-email:" + email]) {
        const retry = await store.rate(key, 5, 600);
        if (retry) {
          reply.header("Retry-After", retry);
          throw failure("RATE_LIMITED", "验证次数过多，请稍后再试", 429);
        }
      }
      const result = await store.query(
        "UPDATE subscriptions SET active=TRUE,component_ids=pending_component_ids,verify_hash=NULL,verify_expires=NULL,updated_at=UTC_TIMESTAMP(3) WHERE email=? AND verify_hash=? AND verify_expires>UTC_TIMESTAMP(3)",
        [email, hash(config.adminToken + ":" + email + ":" + req.body.code)],
      );
      if (!result.affectedRows)
        throw failure("INVALID_CODE", "验证码无效或已过期");
      return { message: "订阅已启用。" };
    },
  );
  app.post(
    "/api/v1/subscriptions/unsubscribe",
    {
      schema: {
        tags: ["订阅"],
        summary: "通过邮件中的退订凭据停用订阅",
        body: {
          type: "object",
          additionalProperties: false,
          required: ["id", "token"],
          properties: {
            id: { type: "string", format: "uuid" },
            token: { type: "string", maxLength: 100 },
          },
        },
      },
    },
    async (req) => {
      if (!equal(req.body.token, unsubscribeToken(req.body.id, config)))
        throw failure("INVALID_TOKEN", "退订链接无效");
      await store.query(
        "UPDATE subscriptions SET active=FALSE,verify_hash=NULL,updated_at=? WHERE id=?",
        [sqlDate(new Date()), req.body.id],
      );
      return { message: "已退订服务通知。" };
    },
  );
}
