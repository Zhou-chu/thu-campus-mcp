/** 四服务登录真值：配置、Cookie存在或打开浏览器都不是在线核验。 */
const STATES = new Set(["ready", "login-required", "expired", "unverified", "unknown", "mock"]);
const AUTH_REQUIRED = new Set(["AUTH_REQUIRED", "LOGIN_REQUIRED", "NOT_LOGGED_IN"]);
const AUTH_EXPIRED = new Set(["AUTH_EXPIRED", "SESSION_EXPIRED", "TOKEN_EXPIRED"]);
const DEFAULT_CODES = { ready: "VERIFIED", "login-required": "AUTH_REQUIRED", expired: "AUTH_EXPIRED", unverified: "UNVERIFIED", unknown: "UNKNOWN_STATE", mock: "MOCK_MODE" };
const codeOf = value => typeof value === "string" && /^[A-Z][A-Z_]{0,63}$/.test(value) ? value : null;
function checkedAt(value) {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) return null;
  return new Date(value).toISOString();
}
function sourceOf(value) {
  return typeof value === "string" && /^(protected-api|local|tool|mock):[a-z0-9_-]{1,80}$/.test(value) ? value : null;
}
export function stateOf(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return "unknown";
  const auth = payload.authentication && typeof payload.authentication === "object" ? payload.authentication : {};
  if (payload.mode === "mock" || payload.mock === true || payload.state === "mock" || auth.method === "mock" || auth.simulation === true) return "mock";
  const code = codeOf(payload.code || payload.error?.code);
  if (AUTH_REQUIRED.has(code)) return "login-required";
  if (AUTH_EXPIRED.has(code)) return "expired";
  if (["UNVERIFIED", "AUTH_CHANGED", "ACCOUNT_API_UNSUPPORTED"].includes(code)) return "unverified";
  // 无法访问/解析受保护接口不等于会话过期，也不能复用旧的成功标记。
  if (code && code !== "VERIFIED") return "unknown";
  if (payload.disabled === true || auth.configured === false || payload.configured === false || payload.authenticated === false || payload.loggedIn === false) return "login-required";
  if (payload.expired === true || payload.expiresIn === 0 || ["expired", "invalid"].includes(payload.sessionValidity) || payload.state === "expired") return "expired";
  if (payload.state === "login-required") return "login-required";
  if (payload.state === "unknown") return "unknown";
  if (payload.state === "unverified" || ["unverified", "not_checked"].includes(payload.sessionValidity) || code === "UNVERIFIED") return "unverified";
  if (payload.verified === true && sourceOf(payload.source)?.startsWith("protected-api:") && checkedAt(payload.checkedAt)) return "ready";
  if (payload.state === "unverified" || payload.state === "ready" || payload.verified !== undefined || payload.sessionValidity || payload.configured === true || auth.configured === true || payload.authenticated === true || payload.loggedIn === true || payload.account || payload.token != null || payload.hasCookie || payload.hasToken) return "unverified";
  return "unknown";
}
/** 只转发核验白名单；丢弃账号、token、Cookie、原始错误消息等。 */
export function serviceEvidence(payload, { source = "tool:status", at = null } = {}) {
  const value = payload && typeof payload === "object" ? payload : {};
  const state = stateOf(value);
  return {
    state: STATES.has(state) ? state : "unknown",
    verified: state === "ready",
    checkedAt: checkedAt(value.checkedAt) || checkedAt(at),
    source: sourceOf(value.source) || sourceOf(source) || "tool:status",
    code: codeOf(value.code || value.error?.code) || DEFAULT_CODES[state],
  };
}
const PROBES = [["learnx", "learn_status"], ["cloud", "cloud_status"], ["hetang", "rain_status"], ["madmodel", "madmodel_status"]];
/** verify只允许受保护只读GET，不允许登录、扫码、恢复、课堂操作或计费chat。 */
export function createServiceProbe(host, { now = () => Date.now() } = {}) {
  return async function probe() {
    const entries = await Promise.all(PROBES.map(async ([service, tool]) => {
      const at = new Date(now()).toISOString();
      let payload;
      try {
        const result = await host.call(tool, { verify: true });
        payload = result?.ok ? result.data : { code: codeOf(result?.error?.code) || "PROBE_FAILED" };
      } catch (error) { payload = { code: codeOf(error?.code) || "PROBE_FAILED" }; }
      return [service, serviceEvidence(payload, { source: `tool:${tool}`, at })];
    }));
    return Object.fromEntries(entries);
  };
}
