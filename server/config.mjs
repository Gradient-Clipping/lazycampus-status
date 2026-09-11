import { readFile } from "node:fs/promises";
export function settings(env = process.env) {
  const origin = env.STATUS_ORIGIN || "http://127.0.0.1:3100";
  const url = new URL(origin);
  if (!["http:", "https:"].includes(url.protocol) || url.pathname !== "/")
    throw new Error("Invalid STATUS_ORIGIN");
  return {
    origin: url.origin,
    port: Number(env.PORT || 3100),
    revision: env.REVISION || "development",
    configFile: env.STATUS_CONFIG || "",
    kube: env.KUBE_ENABLED === "true",
    kubeURL: env.KUBE_API_URL || "https://kubernetes.default.svc",
    kubeDirectory:
      env.KUBE_TOKEN_DIRECTORY ||
      "/var/run/secrets/kubernetes.io/serviceaccount",
    interval: 30000,
    staleAfter: 100000,
    historyDays: 90,
    adminToken: env.STATUS_ADMIN_TOKEN || "",
    issuer: env.OIDC_ISSUER || "",
    clientId: env.OIDC_CLIENT_ID || "lazycampus-status",
    clientSecret: env.OIDC_CLIENT_SECRET || "",
    adminUsername: env.OIDC_ADMIN_USERNAME || "ystemsrx",
    adminRole: env.OIDC_ADMIN_ROLE || "platform-admin",
    senderKey: env.SENDER_API_KEY || "",
    senderFrom: env.SENDER_FROM_EMAIL || "",
    probeHosts: (
      env.STATUS_PROBE_HOSTS ||
      "lazycampus.com,*.lazycampus.com,*.svc.cluster.local"
    ).split(","),
    trustedProxy: env.TRUST_PROXY_CIDRS
      ? env.TRUST_PROXY_CIDRS.split(",")
      : false,
    db: {
      host: env.MYSQL_HOST || "127.0.0.1",
      port: Number(env.MYSQL_PORT || 3310),
      user: env.MYSQL_USER || "status",
      password: env.MYSQL_PASSWORD || "",
      database: env.MYSQL_DATABASE || "lazycampus_status",
      connectionLimit: 8,
      timezone: "Z",
      dateStrings: true,
      supportBigNumbers: true,
      bigNumberStrings: true,
      enableKeepAlive: true,
    },
  };
}
export async function readCatalog(file) {
  if (!file) return { groups: [], monitors: [] };
  const result = JSON.parse(await readFile(file, "utf8"));
  if (!Array.isArray(result.groups) || !Array.isArray(result.monitors))
    throw new Error("Invalid monitor catalog");
  return result;
}
