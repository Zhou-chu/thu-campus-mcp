/**
 * 登录入口的共享契约：五个入口（seat / sports / learnx / 批量 / 作业式浏览器登录）
 * 都使用同一套状态码与响应体，前端不需要为每个入口单独写判断。
 *
 * 语义：
 *  - 400 输入不合法（缺参数、服务名错误）
 *  - 409 需要本人处理或当前状态不允许（未配置账号、验证码、账号已变化、场馆/座位未开放）
 *  - 429 上游限流
 *  - 503 本机资源忙（浏览器资料目录被占用）
 *  - 502 其它上游失败或未能确认
 */

const ARGUMENT = new Set(["ARGUMENT_REQUIRED", "INVALID_ARGUMENTS", "SERVICE_REQUIRED", "SPORT_REQUIRED"]);
const USER_ACTION = new Set([
  "ACCOUNT_NOT_CONFIGURED",
  "ACCOUNT_INCOMPLETE",
  "ACCOUNT_STORAGE",
  "ACCOUNT_LEGACY_CLEANUP",
  "CAS_CAPTCHA_REQUIRED",
  "AUTH_CHANGED",
  "BROWSER_ACCOUNT_MISMATCH",
  "SPORTS_MANUAL_VERIFICATION",
  "SPORTS_LOGIN_REQUIRED",
  "SPORTS_LOGIN_BUTTON_MISSING",
  "SPORTS_LOGIN_UNCONFIRMED",
  "SPORTS_SLOTS_UNSUPPORTED",
  "SEAT_LOGIN_REQUIRED",
  "SEAT_CLOSED",
]);
const THROTTLED = new Set(["SPORTS_THROTTLED"]);
const BUSY = new Set(["BROWSER_BUSY", "SPORTS_MAINTENANCE"]);

const SAFE_CODE = /^[A-Z][A-Z0-9_]{1,63}$/;
const MESSAGE_LIMIT = 300;

export function loginStatusOf(code) {
  if (ARGUMENT.has(code)) return 400;
  if (BUSY.has(code)) return 503;
  if (THROTTLED.has(code)) return 429;
  if (USER_ACTION.has(code)) return 409;
  return 502;
}

/** 把任意失败投影成统一响应；未知代码不泄漏原始消息里的敏感内容长度。 */
export function loginFailure(service, failure = {}) {
  const code = SAFE_CODE.test(String(failure.code || "")) ? failure.code : "LOGIN_FAILED";
  const message = typeof failure.message === "string" && failure.message.trim()
    ? failure.message.trim().slice(0, MESSAGE_LIMIT)
    : "登录未完成，请稍后重试。";
  return { status: loginStatusOf(code), body: { ok: false, error: { code, message, service } } };
}

export function loginSuccess(service, result = {}) {
  return { status: 200, body: { ok: true, service, ...result } };
}

/** 服务自己返回 {ok:false,...} 时也走同一张表，而不是各自约定 409/502。 */
export function settleLogin(service, result) {
  return result?.ok === false ? loginFailure(service, result) : loginSuccess(service, result ?? {});
}

export function sendLogin(res, json, outcome) {
  return json(res, outcome.status, outcome.body);
}