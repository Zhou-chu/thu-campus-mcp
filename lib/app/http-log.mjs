/** 请求结束时的两路记录：本地调试日志（完整路径）与 Sentry 结构化日志（去查询串）。 */
export function logRequestFinished({ req, res, startedAt, debugLog, sentry = null }) {
  const durationMs = Date.now() - startedAt;
  debugLog.log({
    module: "http",
    event: "request",
    durationMs,
    data: { method: req.method || "GET", path: req.url || "/", status: res.statusCode },
  });
  sentry?.logRequest({ route: String(req.url || "/").split("?")[0], status: res.statusCode, durationMs });
}
