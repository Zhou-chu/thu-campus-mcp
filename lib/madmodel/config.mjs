import path from "node:path";
import { homedir } from "node:os";
import { error } from "./protocol.mjs";
export function loadConfig(env = process.env) {
  const number = (name, fallback, min, max) => {
    const value = env[name] === undefined ? fallback : Number(env[name]);
    if (!Number.isInteger(value) || value < min || value > max)
      throw error("INVALID_REQUEST", name + " 配置无效。", 400);
    return value;
  };
  const cfg = {
    stateDir: path.resolve(
      env.MADMODEL_STATE_DIR ||
        path.join(homedir(), ".thu-campus-mcp", "madmodel"),
    ),
    host: env.MADMODEL_HOST || "127.0.0.1",
    port: number("MADMODEL_PORT", 8765, 0, 65535),
    apiKey: env.MADMODEL_API_KEY || "",
    checkIntervalMs: number(
      "MADMODEL_CHECK_INTERVAL_MS",
      300000,
      1000,
      86400000,
    ),
    refreshAheadMs: number("MADMODEL_REFRESH_AHEAD_MS", 900000, 1000, 14400000),
    timeoutMs: number("MADMODEL_TIMEOUT_MS", 300000, 1000, 3600000),
    loginTimeoutMs: number("MADMODEL_LOGIN_TIMEOUT_MS", 60000, 1000, 600000),
    maxBodyBytes: number(
      "MADMODEL_MAX_BODY_BYTES",
      20 * 1024 * 1024,
      1024,
      100 * 1024 * 1024,
    ),
  };
  if (!["127.0.0.1", "::1", "localhost"].includes(cfg.host) && !cfg.apiKey)
    throw error(
      "INVALID_REQUEST",
      "监听非回环地址必须设置 MADMODEL_API_KEY。",
      400,
    );
  return cfg;
}
