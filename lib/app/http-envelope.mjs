/**
 * HTTP 响应契约：前端、桌面端、移动端与测试都只依赖这里的形状。
 *
 * 成功：  { ok: true, ...payload }
 * 失败：  { ok: false, error: { code, message, service? } }
 * 流式：  200 + `text/event-stream`，每帧 `event: <name>` / `data: <json>`；
 *         结束帧是 `done`，失败帧是 `error`。
 *
 * 错误码是稳定的机器可读标识（大写下划线），message 只给人看，不参与判断。
 */

const CODE = /^[A-Z][A-Z0-9_]{1,63}$/;
const MAX_MESSAGE = 400;

export function errorEnvelope(code, message, extra = {}) {
  const safe = CODE.test(String(code || "")) ? code : "APP_ERROR";
  const text = typeof message === "string" && message.trim()
    ? message.trim().slice(0, MAX_MESSAGE)
    : "请求处理失败。";
  return { ok: false, error: { code: safe, message: text, ...extra } };
}

export function successEnvelope(payload = {}) {
  return { ok: true, ...payload };
}

/** 判定一个响应体是否满足契约；测试与灰度联调都用它，而不是各处自己约定。 */
export function envelopeProblems(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return ["not-an-object"];
  const problems = [];
  if (typeof body.ok !== "boolean") problems.push("missing-ok");
  if (body.ok === false) {
    const error = body.error;
    if (!error || typeof error !== "object" || Array.isArray(error)) problems.push("missing-error");
    else {
      if (!CODE.test(String(error.code || ""))) problems.push("bad-error-code");
      if (typeof error.message !== "string" || !error.message) problems.push("missing-error-message");
      if (error.service !== undefined && (typeof error.service !== "string" || !error.service)) problems.push("bad-error-service");
    }
  }
  if (body.ok === true && body.error !== undefined) problems.push("success-with-error");
  return problems;
}

export function sendJson(res, status, data) {
  if (res.writableEnded) return;
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  res.end(JSON.stringify(data));
}

export function sendError(res, status, code, message) {
  sendJson(res, status, errorEnvelope(code, message));
}