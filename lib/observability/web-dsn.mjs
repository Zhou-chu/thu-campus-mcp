/** 解析前端 Sentry 配置：只把 DSN、ingest 源与环境注入页面，未配置时返回 null。 */
export function resolveWebDsn({ env = process.env, host = "" } = {}) {
  const dsn = String(env.SENTRY_WEB_DSN || "").trim();
  if (!dsn) return null;
  try {
    const url = new URL(dsn);
    return {
      dsn,
      origin: url.origin,
      environment: env.SENTRY_ENVIRONMENT || (host === "0.0.0.0" ? "production" : "local"),
    };
  } catch {
    return null;
  }
}
