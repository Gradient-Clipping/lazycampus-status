import http from "node:http";
import https from "node:https";
import net from "node:net";
import dns from "node:dns";
import { interpretReport } from "./evidence.mjs";

export function allowedHost(host, allowlist) {
  const normalized = host.toLowerCase().replace(/\.$/, "");
  return allowlist.some((rule) =>
    rule.startsWith("*.")
      ? normalized.endsWith(rule.slice(1)) && normalized !== rule.slice(2)
      : normalized === rule,
  );
}
export function safeAddress(address, internal = false) {
  if (address.startsWith("::ffff:"))
    return safeAddress(address.slice(7), internal);
  if (net.isIPv4(address)) {
    const [a, b] = address.split(".").map(Number);
    if (
      a === 0 ||
      a === 127 ||
      a >= 224 ||
      (a === 169 && b === 254) ||
      address === "100.100.100.200"
    )
      return false;
    return (
      internal ||
      !(
        a === 10 ||
        (a === 172 && b >= 16 && b <= 31) ||
        (a === 192 && b === 168) ||
        (a === 100 && b >= 64 && b <= 127)
      )
    );
  }
  if (net.isIPv6(address)) {
    const lower = address.toLowerCase();
    if (lower === "::1" || lower === "::" || /^(fe[89ab]|ff)/.test(lower))
      return false;
    return internal || !/^f[cd]/.test(lower);
  }
  return false;
}
export function validateTarget(spec, allowlist) {
  if (!["http", "tcp", "heartbeat"].includes(spec.kind))
    throw new Error("仅支持 HTTP、TCP 或心跳监测");
  if (spec.kind === "heartbeat") return;
  const target = new URL(spec.target);
  if (
    target.username ||
    target.password ||
    target.hash ||
    !allowedHost(target.hostname, allowlist)
  )
    throw new Error("目标域名不在 GitOps 探测白名单内");
  if (spec.kind === "http" && !["http:", "https:"].includes(target.protocol))
    throw new Error("HTTP 监测需要 http(s) 地址");
  if (
    spec.kind === "tcp" &&
    (target.protocol !== "tcp:" ||
      !target.port ||
      (target.pathname && target.pathname !== "/") ||
      target.search)
  )
    throw new Error("TCP 监测需要 tcp://主机:端口");
  if (net.isIP(target.hostname) && !safeAddress(target.hostname))
    throw new Error("不允许探测本机或元数据地址");
}
export function checkedLookup(host, options, callback) {
  const internal = host.endsWith(".svc.cluster.local");
  dns.lookup(host, { ...options, all: true }, (error, addresses) => {
    if (error) return callback(error);
    if (
      !addresses.length ||
      addresses.some((item) => !safeAddress(item.address, internal))
    )
      return callback(new Error("Blocked probe address"));
    if (options.all) callback(null, addresses);
    else callback(null, addresses[0].address, addresses[0].family);
  });
}
export function request(
  url,
  { timeout = 5000, limit = 65536, headers = {}, ca, trusted = false } = {},
) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const req = (target.protocol === "https:" ? https : http).request(
      target,
      {
        method: "GET",
        headers,
        ca,
        lookup: trusted ? undefined : checkedLookup,
        signal: AbortSignal.timeout(timeout),
        agent: false,
      },
      (response) => {
        const chunks = [];
        let size = 0;
        response.on("data", (chunk) => {
          size += chunk.length;
          if (size > limit) {
            if (!trusted) {
              chunks.push(
                chunk.subarray(0, Math.max(0, limit - (size - chunk.length))),
              );
              resolve({
                status: response.statusCode,
                body: Buffer.concat(chunks).toString("utf8"),
                headers: response.headers,
                truncated: true,
              });
              response.destroy();
              return;
            }
            req.destroy(new Error("Response exceeds probe limit"));
            return;
          }
          chunks.push(chunk);
        });
        response.on("error", reject);
        response.on("end", () =>
          resolve({
            status: response.statusCode,
            body: Buffer.concat(chunks).toString("utf8"),
            headers: response.headers,
          }),
        );
      },
    );
    req.on("error", reject);
    req.end();
  });
}
export async function probe(
  component,
  allowlist,
  now = new Date(),
  context = {},
) {
  if (component.paused) return { status: "maintenance", reason: "监测已暂停" };
  if (component.kind === "heartbeat") {
    if (!component.heartbeatAt)
      return { status: "no_data", reason: "等待首次心跳" };
    return now - new Date(component.heartbeatAt) >
      (component.heartbeatSeconds || 180) * 1000
      ? { status: "full_outage", reason: "心跳超时" }
      : {
          status: component.heartbeatStatus || "operational",
          reason: "已收到心跳",
        };
  }
  const started = performance.now();
  try {
    validateTarget(component, allowlist);
    let result;
    if (component.kind === "tcp") {
      const target = new URL(component.target);
      await new Promise((resolve, reject) => {
        const socket = net.createConnection({
          host: target.hostname,
          port: Number(target.port),
          lookup: checkedLookup,
        });
        socket.setTimeout((component.timeoutSeconds || 5) * 1000);
        socket.once("connect", () => {
          socket.destroy();
          resolve();
        });
        socket.once("timeout", () =>
          socket.destroy(new Error("Probe timeout")),
        );
        socket.once("error", reject);
      });
      result = { status: "operational", reason: "TCP 连接成功" };
    } else {
      const headers = {};
      if (component.credentialRef) {
        const credential = context.credentials?.[component.credentialRef];
        if (
          !credential?.token ||
          credential.target !== component.target ||
          !new URL(component.target).hostname.endsWith(".svc.cluster.local")
        )
          return { status: "no_data", reason: "内部报告凭据未配置" };
        headers.authorization = `Bearer ${credential.token}`;
      }
      const key = `${component.target}:${component.credentialRef || ""}:${component.assetCheck || false}`;
      let pending = context.cache?.get(key);
      if (!pending) {
        pending = request(component.target, {
          timeout: (component.timeoutSeconds || 5) * 1000,
          limit: component.assetCheck ? 524288 : 65536,
          headers,
        });
        context.cache?.set(key, pending);
      }
      const response = await pending;
      const codeOK = (component.expectedCodes || [200]).includes(
        response.status,
      );
      const contentOK =
        !component.contains || response.body.includes(component.contains);
      result = {
        status: codeOK && contentOK ? "operational" : "full_outage",
        reason: !codeOK
          ? `HTTP ${response.status}`
          : !contentOK
            ? "响应内容不符合预期"
            : `HTTP ${response.status}`,
      };
      if (codeOK && component.reportKey) {
        result = response.truncated
          ? { status: "no_data", reason: "业务报告超出长度限制" }
          : interpretReport(
              response.body,
              component.reportKey,
              now,
              component.reportTTLSeconds || 100,
              component,
            );
      }
      if (
        component.reportKey &&
        !codeOK &&
        [401, 403, 404, 429].includes(response.status)
      ) {
        result = {
          status: "no_data",
          reason: `业务报告不可读取（HTTP ${response.status}）`,
        };
      }
      if (codeOK && component.assetCheck) {
        const target = new URL(component.target);
        const assets = [
          ...response.body.matchAll(
            /<(?:script|link)\b[^>]*(?:src|href)=["']([^"']+\.(?:js|css)(?:\?[^"']*)?)["']/gi,
          ),
        ]
          .map((m) => new URL(m[1].replaceAll("&amp;", "&"), target))
          .filter(
            (url) =>
              url.origin === target.origin && !url.username && !url.password,
          )
          .slice(0, 2);
        if (!assets.length)
          result = {
            status: "no_data",
            reason: "页面未发现可检查的脚本或样式",
          };
        else {
          const results = await Promise.all(
            assets.map((url) => request(url, { timeout: 5000, limit: 1024 })),
          );
          result = results.every(
            (r) =>
              r.status === 200 &&
              r.body.length &&
              !String(r.headers["content-type"]).includes("text/html"),
          )
            ? { status: "operational", reason: "页面资源检查通过" }
            : { status: "full_outage", reason: "页面资源不可用" };
        }
      }
    }
    result.latencyMs = Math.round(performance.now() - started);
    if (
      !component.reportKey &&
      result.status === "operational" &&
      result.latencyMs > (component.degradedAfterMs || 3000)
    )
      result.status = "degraded_performance";
    return result;
  } catch (error) {
    const code = error.code || error.name;
    return {
      status: "full_outage",
      latencyMs: Math.round(performance.now() - started),
      reason: ["ETIMEDOUT", "ABORT_ERR", "TimeoutError", "AbortError"].includes(
        code,
      )
        ? "探测超时"
        : ["ENOTFOUND", "EAI_AGAIN"].includes(code)
          ? "域名解析失败"
          : code === "ECONNREFUSED"
            ? "连接被拒绝"
            : "探测未通过",
    };
  }
}
