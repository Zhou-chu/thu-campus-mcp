/** 应用侧的 Sentry 工厂：把环境变量与版本号收在一处，组合根只负责调用。 */
import { createSentry } from "./sentry.mjs";

export function createAppSentry({ version = "", host = "", env = process.env } = {}) {
  return createSentry({
    dsn: env.SENTRY_DSN || "",
    release: version,
    environment: env.SENTRY_ENVIRONMENT || (host === "0.0.0.0" ? "production" : "local"),
  });
}
