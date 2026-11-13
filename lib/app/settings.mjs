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
    // 旧 THU_CAMPUS_APP_MAX_STEPS 兼容忽略，不再限制模型与工具迭代次数。
    keepAliveMinutes: minutes(env.THU_CAMPUS_APP_KEEPALIVE_MINUTES, 30),
    keepAliveRestore: env.THU_CAMPUS_APP_KEEPALIVE_RESTORE !== "0",
    requireApproval: env.THU_CAMPUS_APP_REQUIRE_APPROVAL !== "0",
    approvalTimeoutMs:
      positiveInt(env.THU_CAMPUS_APP_APPROVAL_TIMEOUT_SECONDS, 120, "THU_CAMPUS_APP_APPROVAL_TIMEOUT_SECONDS") *
      1000,
    hostname: hostname(),
  };
}
function minutes(value, fallback) {
  if (value === undefined || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 1440)
    throw Object.assign(
      new Error("THU_CAMPUS_APP_KEEPALIVE_MINUTES 必须是 0–1440 的整数（0 表示关闭）。"),
      { code: "INVALID_SETTINGS" },
    );
  return parsed;
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
/**
 * 这台主机能不能弹出一个可见的浏览器窗口。
 * 校园首次登录、验证码与多因素认证都必须在本机窗口里由本人完成；
 * 无图形会话的服务器必须提前知道这件事，而不是在登录时才失败。
 */
export function loginCapability(env = process.env, platform = process.platform) {
  if (platform === "win32" || platform === "darwin")
    return { window: true, reason: "desktop", hint: "" };
  if (env.DISPLAY || env.WAYLAND_DISPLAY)
    return { window: true, reason: "display", hint: "" };
  return {
    window: false,
    reason: "no-display",
    hint: "当前没有图形会话，无法完成首次校园登录；请在带桌面的机器登录，或为该主机提供 Xvfb/VNC 后重试。已有会话仍可无界面续登。",
  };
}
export function isLoopback(host) {
  return ["127.0.0.1", "::1", "localhost"].includes(host);
}
function addressRank(address) {
  const parts = address.split(".").map(Number);
  if (parts[0] === 192 && parts[1] === 168) return 0;
  if (parts[0] === 10) return 1;
  if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return 2;
  // 100.64.0.0/10 是运营商级 NAT（含 Tailscale），手机通常不可直连
  if (parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127) return 4;
  return 3;
}
export function lanUrls(port) {
  const urls = [];
  const seen = new Set();
  for (const entries of Object.values(networkInterfaces() || {}))
    for (const entry of entries || [])
      if (
        entry.family === "IPv4" &&
        !entry.internal &&
        !entry.address.startsWith("169.254.")
      )
        if (!seen.has(entry.address)) {
          seen.add(entry.address);
          urls.push(`http://${entry.address}:${port}`);
        }
  urls.sort((a, b) => {
    const ha = new URL(a).hostname,
      hb = new URL(b).hostname;
    const diff = addressRank(ha) - addressRank(hb);
    return diff !== 0 ? diff : ha.localeCompare(hb, "en", { numeric: true });
  });
  return urls;
}
export function maskAccount(account) {
  const value = String(account || "").trim();
  if (!value) return "";
  if (value.length <= 6) return value[0] + "*".repeat(Math.max(value.length - 2, 1)) + value.slice(-1);
  return value.slice(0, 4) + "*".repeat(value.length - 8) + value.slice(-4);
}



