/** 服务端 Sentry：用官方 SDK，未配置 DSN 时完全不初始化、不联网。 */
import * as Sentry from "@sentry/node";

export { scrubMessage } from "./scrub.mjs";

let initialized = false;

export function initServerSentry({ dsn = "", release = "", environment = "production", tracesSampleRate = 0.1 } = {}) {
  if (!dsn || initialized) return { enabled: false };
  Sentry.init({
    dsn,
    release: release || undefined,
    environment,
    tracesSampleRate,
    sendDefaultPii: false,
    beforeSend(event) {
      // 请求内容、Cookie、查询串一律不带走；只留“哪个接口出错”。
      if (event.request) {
        delete event.request.data;
        delete event.request.cookies;
        delete event.request.query_string;
        delete event.request.headers;
      }
      const values = (event.exception?.values) || [];
      for (const value of values) {
        if (value.value) value.value = scrubInline(value.value);
      }
      return event;
    },
  });
  initialized = true;
  return { enabled: true };
}

function scrubInline(value) {
  return String(value ?? "")
    .replace(/\?[^\s"')]+/g, "")
    .replace(/(bearer\s+[A-Za-z0-9._~+/=-]{8,}|tc1_[A-Za-z0-9._-]{8,}|glpat-[A-Za-z0-9_-]{8,}|[A-Za-z0-9_-]{32,})/gi, "[redacted]")
    .replace(/\b(19|20)\d{2}\d{6,10}\b/g, "[student-id]")
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "[email]")
    .slice(0, 500);
}

/** 应用侧入口：把环境变量与版本号收在一处。 */
export function createAppSentry({ version = "", host = "", env = process.env } = {}) {
  const enabled = initServerSentry({
    dsn: env.SENTRY_DSN || "",
    release: version,
    environment: env.SENTRY_ENVIRONMENT || (host === "0.0.0.0" ? "production" : "local"),
    tracesSampleRate: Number(env.SENTRY_TRACES_SAMPLE_RATE || (host === "0.0.0.0" ? 0.1 : 1.0)),
  }).enabled;
  return {
    enabled,
    capture(error, context = {}) {
      if (!enabled) return Promise.resolve({ ok: false, code: "SENTRY_DISABLED" });
      try {
        Sentry.captureException(error, { tags: context.tags });
        return Promise.resolve({ ok: true });
      } catch {
        return Promise.resolve({ ok: false, code: "SENTRY_FAILED" });
      }
    },
  };
}