/**
 * 浏览器侧 Sentry：只在页面注入了 DSN 时初始化，未配置就什么都不做。
 *
 * - 只上报错误（`window.onerror` / `unhandledrejection` 由 SDK 自动接管）；
 * - `beforeSend` 统一脱敏：去掉查询串、令牌、学号、邮箱与本地路径；
 * - 采样率按环境区分：本机开发全采，生产默认 10%。
 */
(function () {
  "use strict";
  var meta = document.querySelector('meta[name="sentry-dsn"]');
  var dsn = meta && meta.getAttribute("content") ? meta.getAttribute("content").trim() : "";
  if (!dsn || !window.Sentry) return;
  var environment = (document.querySelector('meta[name="sentry-environment"]') || {}).content || "production";
  var release = (document.querySelector('meta[name="sentry-release"]') || {}).content || "";
  var TOKEN_LIKE = /(bearer\s+[A-Za-z0-9._~+/=-]{8,}|tc1_[A-Za-z0-9._-]{8,}|glpat-[A-Za-z0-9_-]{8,}|[A-Za-z0-9_-]{32,})/gi;
  var STUDENT_ID = /\b(19|20)\d{2}\d{6,10}\b/g;
  var EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
  function scrub(value) {
    return String(value == null ? "" : value)
      .replace(/\?[^\s"')]+/g, "")
      .replace(TOKEN_LIKE, "[redacted]")
      .replace(STUDENT_ID, "[student-id]")
      .replace(EMAIL, "[email]")
      .replace(/[A-Za-z]:\\[^\s"')]+/g, "[path]")
      .slice(0, 500);
  }
  window.Sentry.init({
    dsn: dsn,
    release: release || undefined,
    environment: environment,
    // 页面加载与接口调用的耗时；生产只采 10%，本机全采便于验证。
    tracesSampleRate: environment === "local" ? 1.0 : 0.1,
    integrations: [window.Sentry.browserTracingIntegration()],
    enableLogs: true,
    sendDefaultPii: false,
    beforeSend: function (event) {
      // 请求体、Cookie、查询串一律不带走。
      if (event.request) {
        delete event.request.data;
        delete event.request.cookies;
        delete event.request.query_string;
        if (event.request.url) event.request.url = scrub(event.request.url);
      }
      var values = (event.exception && event.exception.values) || [];
      for (var i = 0; i < values.length; i += 1) {
        if (values[i].value) values[i].value = scrub(values[i].value);
      }
      return event;
    },
  });
  // 一条高信号日志：记清是哪一版页面启动的，不含用户信息。
  try {
    window.Sentry.logger.info("web.app.booted", { route: location.pathname, release: release || "unknown" });
  } catch (error) {
    /* 日志失败不影响页面 */
  }
})();