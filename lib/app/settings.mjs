import path from "node:path";
import { homedir, hostname, networkInterfaces } from "node:os";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("../../", import.meta.url));
export async function packageVersion() {
  try {
    const manifest = JSON.parse(
      await readFile(path.join(root, "package.json"), "utf8"),
    );
    return typeof manifest.version === "string" ? manifest.version : "0.0.0";
  } catch {
    return "0.0.0";
  }
}
function positiveInt(value, fallback, name) {
  if (value === undefined || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 65535)
    throw Object.assign(new Error(`${name} 必须是正整数。`), {
      code: "INVALID_SETTINGS",
    });
  return parsed;
}
const routes = new Set(["madmodel", "openai"]);
export function appConfig(env = process.env) {
  const route = env.THU_CAMPUS_APP_MODEL_ROUTE || "madmodel";
  if (!routes.has(route))
    throw Object.assign(
      new Error("THU_CAMPUS_APP_MODEL_ROUTE 只能是 madmodel 或 openai。"),
      { code: "INVALID_SETTINGS" },
    );
  const host = env.THU_CAMPUS_APP_HOST || "127.0.0.1";
  const token = env.THU_CAMPUS_APP_TOKEN || "";
  const allowRemote = env.THU_CAMPUS_APP_ALLOW_REMOTE === "1";
  if (!isLoopback(host) && !token && !allowRemote)
    throw Object.assign(
      new Error(
        "监听非回环地址需要二选一：设置 THU_CAMPUS_APP_TOKEN（固定令牌、禁用配对），" +
          "或显式设置 THU_CAMPUS_APP_ALLOW_REMOTE=1 只用配对码鉴权。",
      ),
      { code: "INSECURE_LISTEN" },
    );
  const tlsCert = env.THU_CAMPUS_APP_TLS_CERT || "";
  const tlsKey = env.THU_CAMPUS_APP_TLS_KEY || "";
  if (!!tlsCert !== !!tlsKey)
    throw Object.assign(
      new Error("THU_CAMPUS_APP_TLS_CERT 与 THU_CAMPUS_APP_TLS_KEY 必须成对提供。"),
      { code: "INVALID_SETTINGS" },
    );
  return {
    root,
    version: undefined,
    host,
    port: positiveInt(env.THU_CAMPUS_APP_PORT, 8971, "THU_CAMPUS_APP_PORT"),
    stateDir: path.resolve(
      env.THU_CAMPUS_APP_STATE_DIR ||
        path.join(homedir(), ".thu-campus-mcp/app"),
    ),
    token,
    allowRemote,
    tlsCert,
    tlsKey,
    publicUrl: (env.THU_CAMPUS_APP_PUBLIC_URL || "").replace(/\/+$/, ""),
    extraHosts: splitList(env.THU_CAMPUS_APP_ALLOWED_HOSTS),
    extraOrigins: splitList(env.THU_CAMPUS_APP_ALLOWED_ORIGINS),
    modelRoute: route,
    modelBaseUrl: env.THU_CAMPUS_APP_MODEL_BASE_URL || "",
    modelApiKey: env.THU_CAMPUS_APP_MODEL_API_KEY || "",
    modelName: env.THU_CAMPUS_APP_MODEL_NAME || "",
    maxSteps: positiveInt(env.THU_CAMPUS_APP_MAX_STEPS, 12, "THU_CAMPUS_APP_MAX_STEPS"),
    hostname: hostname(),
  };
}
function splitList(value) {
  return String(value || "")
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
}
/** 对外可达地址：托管部署时用 PUBLIC_URL，否则按监听地址拼。 */
export function publicBase(config) {
  if (config.publicUrl) return config.publicUrl;
  const scheme = config.tlsCert ? "https" : "http";
  return `${scheme}://${config.host}:${config.port}`;
}
export function isLoopback(host) {
  return ["127.0.0.1", "::1", "localhost"].includes(host);
}
export function lanUrls(port) {
  const urls = [];
  for (const entries of Object.values(networkInterfaces() || {}))
    for (const entry of entries || [])
      if (
        entry.family === "IPv4" &&
        !entry.internal &&
        !entry.address.startsWith("169.254.")
      )
        urls.push(`http://${entry.address}:${port}`);
  return urls;
}
export function maskAccount(account) {
  const value = String(account || "").trim();
  if (!value) return "";
  if (value.length <= 6) return value[0] + "*".repeat(Math.max(value.length - 2, 1)) + value.slice(-1);
  return value.slice(0, 4) + "*".repeat(value.length - 8) + value.slice(-4);
}