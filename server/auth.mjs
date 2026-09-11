import * as oidc from "openid-client";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { timingSafeEqual } from "node:crypto";
import { hash, secret, json, sqlDate } from "./store.mjs";
export function failure(code, message, statusCode = 400) {
  return Object.assign(new Error(message), { code, statusCode });
}
export function equal(a, b) {
  return (
    typeof a === "string" &&
    typeof b === "string" &&
    a.length === b.length &&
    timingSafeEqual(Buffer.from(a), Buffer.from(b))
  );
}
export function authorizedIdentity(claims, config) {
  if (
    !claims?.sub ||
    claims.preferred_username !== config.adminUsername ||
    !claims.realm_access?.roles?.includes(config.adminRole)
  )
    throw failure("FORBIDDEN", "当前统一身份没有管理权限", 403);
  return {
    username: claims.preferred_username,
    subject: claims.sub,
    sid: claims.sid || "",
    expires: Math.min(claims.exp * 1000, Date.now() + 30 * 60 * 1000),
  };
}
export async function installAuth(app, store, config) {
  const secure = config.origin.startsWith("https:");
  const cookieName = secure ? "__Host-status_session" : "status_session";
  const flowName = secure ? "__Host-status_oidc" : "status_oidc";
  const cookieOptions = { path: "/", secure, httpOnly: true, sameSite: "lax" };
  let discovery;
  async function provider() {
    if (!config.issuer)
      throw failure("SSO_UNAVAILABLE", "统一登录暂时不可用", 503);
    if (!discovery)
      discovery = oidc
        .discovery(new URL(config.issuer), config.clientId, config.clientSecret)
        .catch((error) => {
          discovery = null;
          throw error;
        });
    return discovery;
  }
  app.decorate("authorize", (scope) => async (req, _reply) => {
    const bearer = req.headers.authorization?.match(
      /^Bearer ([A-Za-z0-9_-]{20,200})$/,
    )?.[1];
    if (bearer) {
      if (config.adminToken && equal(bearer, config.adminToken)) {
        req.actor = "bootstrap";
        req.tokenComponents = null;
        return;
      }
      const [token] = await store.query(
        "SELECT * FROM api_tokens WHERE hash=? AND revoked=FALSE AND expires_at>UTC_TIMESTAMP(3)",
        [hash(bearer)],
      );
      if (!token || !json(token.scopes).includes(scope))
        throw failure("FORBIDDEN", "凭据无权执行此操作", 403);
      req.actor = "token:" + token.id;
      req.tokenComponents = json(token.component_ids);
      await store.query(
        "UPDATE api_tokens SET last_used_at=UTC_TIMESTAMP(3) WHERE id=?",
        [token.id],
      );
      return;
    }
    const session = req.cookies[cookieName];
    if (!session) throw failure("UNAUTHENTICATED", "请通过统一身份登录", 401);
    const [row] = await store.query(
      "SELECT payload FROM sessions WHERE hash=? AND expires_at>UTC_TIMESTAMP(3)",
      [hash(session)],
    );
    if (!row) throw failure("UNAUTHENTICATED", "登录已过期，请重新登录", 401);
    const payload = json(row.payload);
    if (payload.kind !== "admin")
      throw failure("UNAUTHENTICATED", "无效的会话", 401);
    if (
      !["GET", "HEAD"].includes(req.method) &&
      req.headers.origin !== config.origin
    )
      throw failure("CSRF_REJECTED", "请求来源无效", 403);
    req.actor = payload.username;
    req.identity = payload;
    req.tokenComponents = null;
  });
  app.get("/auth/login", async (req, reply) => {
    const retry = await store.rate("login:" + req.ip, 10, 60);
    if (retry) throw failure("RATE_LIMITED", "登录请求过于频繁", 429);
    const client = await provider(),
      state = secret(),
      browser = secret(),
      verifier = oidc.randomPKCECodeVerifier(),
      nonce = oidc.randomNonce();
    await store.query(
      "INSERT INTO sessions (hash,payload,expires_at) VALUES (?,?,DATE_ADD(UTC_TIMESTAMP(3),INTERVAL 5 MINUTE))",
      [
        hash(state),
        JSON.stringify({
          kind: "flow",
          browser: hash(browser),
          verifier,
          nonce,
        }),
      ],
    );
    const parameters = {
      redirect_uri: config.origin + "/auth/callback",
      scope: "openid profile roles",
      state,
      nonce,
      code_challenge: await oidc.calculatePKCECodeChallenge(verifier),
      code_challenge_method: "S256",
    };
    reply.setCookie(flowName, browser, { ...cookieOptions, maxAge: 300 });
    return reply.redirect(oidc.buildAuthorizationUrl(client, parameters).href);
  });
  app.get("/auth/callback", async (req, reply) => {
    const url = new URL(req.raw.url, config.origin),
      state = url.searchParams.get("state") || "";
    if (!/^[A-Za-z0-9_-]{40,64}$/.test(state))
      throw failure("INVALID_STATE", "登录请求已失效");
    const payload = await store.transaction(async (db) => {
      const [row] = await store.query(
        "SELECT payload FROM sessions WHERE hash=? AND expires_at>UTC_TIMESTAMP(3) FOR UPDATE",
        [hash(state)],
        db,
      );
      if (!row) return null;
      await store.query("DELETE FROM sessions WHERE hash=?", [hash(state)], db);
      return json(row.payload);
    });
    reply.clearCookie(flowName, cookieOptions);
    if (
      payload?.kind !== "flow" ||
      !equal(payload.browser, hash(req.cookies[flowName] || ""))
    )
      throw failure("INVALID_STATE", "登录请求已失效");
    const tokens = await oidc.authorizationCodeGrant(await provider(), url, {
      pkceCodeVerifier: payload.verifier,
      expectedState: state,
      expectedNonce: payload.nonce,
      idTokenExpected: true,
    });
    const identity = authorizedIdentity(tokens.claims(), config),
      session = secret();
    await store.query(
      "INSERT INTO sessions (hash,payload,expires_at) VALUES (?,?,?)",
      [
        hash(session),
        JSON.stringify({ ...identity, kind: "admin" }),
        sqlDate(identity.expires),
      ],
    );
    await store.audit(identity.username, "session.login", identity.subject);
    reply.setCookie(cookieName, session, {
      ...cookieOptions,
      maxAge: Math.max(1, Math.floor((identity.expires - Date.now()) / 1000)),
    });
    return reply.redirect("/admin");
  });
  app.get(
    "/api/v1/admin/me",
    { preHandler: app.authorize("admin:read") },
    async (req) => ({ username: req.actor }),
  );
  app.post(
    "/auth/logout",
    { preHandler: app.authorize("admin:read") },
    async (req, reply) => {
      if (req.cookies[cookieName])
        await store.query("DELETE FROM sessions WHERE hash=?", [
          hash(req.cookies[cookieName]),
        ]);
      reply.clearCookie(cookieName, cookieOptions);
      return { ok: true };
    },
  );
  app.addContentTypeParser(
    "application/x-www-form-urlencoded",
    { parseAs: "string" },
    (_req, body, done) =>
      done(null, Object.fromEntries(new URLSearchParams(body))),
  );
  app.post("/auth/backchannel-logout", async (req, reply) => {
    const token = req.body?.logout_token;
    if (typeof token !== "string" || token.length > 16000)
      throw failure("INVALID_LOGOUT", "无效的注销请求");
    const client = await provider(),
      metadata = client.serverMetadata();
    const { payload } = await jwtVerify(
      token,
      createRemoteJWKSet(new URL(metadata.jwks_uri)),
      {
        issuer: config.issuer,
        audience: config.clientId,
        algorithms: ["RS256"],
        maxTokenAge: "5m",
        clockTolerance: 10,
      },
    );
    if (
      !payload.events?.["http://schemas.openid.net/event/backchannel-logout"] ||
      payload.nonce ||
      (!payload.sid && !payload.sub)
    )
      throw failure("INVALID_LOGOUT", "无效的注销请求");
    if (payload.sid)
      await store.query(
        "DELETE FROM sessions WHERE JSON_UNQUOTE(JSON_EXTRACT(payload,'$.sid'))=?",
        [payload.sid],
      );
    else
      await store.query(
        "DELETE FROM sessions WHERE JSON_UNQUOTE(JSON_EXTRACT(payload,'$.subject'))=?",
        [payload.sub],
      );
    return reply.code(200).send({ ok: true });
  });
}
