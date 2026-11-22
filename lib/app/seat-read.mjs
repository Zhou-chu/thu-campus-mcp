import { readSnapshot } from "@thu-campus/browser";

export const SEAT_ORIGIN = "https://seat.lib.tsinghua.edu.cn";
export const SEAT_SESSION_PROBE = "/api.php/v3areas/35";

export async function probeSeatSession({ reader = createSeatReader(), now = Date.now } = {}) {
  let state, code;
  try {
    await (await reader())(SEAT_SESSION_PROBE);
    state = "ready";
    code = "VERIFIED";
  } catch (error) {
    const requiresLogin = error?.code === "SEAT_LOGIN_REQUIRED";
    state = requiresLogin ? "login-required" : "unknown";
    code = requiresLogin ? error.code : "PROBE_FAILED";
  }
  return { source: "protected-api:seat-web", state, verified: state === "ready", code, checkedAt: new Date(now()).toISOString() };
}

export class SeatError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "SeatError";
    this.code = code;
  }
}

const matchesPath = (path, requestPath) => requestPath === path || requestPath.startsWith(path.endsWith("/") ? path : path + "/");

function seatCookieHeader(cookies, url, now) {
  return (cookies ?? []).filter(cookie =>
    cookie.domain?.replace(/^\./, "") === url.hostname &&
    (cookie.expires === -1 || cookie.expires * 1000 > now) &&
    matchesPath(cookie.path || "/", url.pathname) &&
    /^[!#$%&'*+.^_`|~\w-]+$/.test(cookie.name) && /^[\x21-\x3a\x3c-\x7e]*$/.test(cookie.value),
  ).sort((a, b) => (b.path || "/").length - (a.path || "/").length).map(cookie => `${cookie.name}=${cookie.value}`).join("; ");
}

export function seatApiPayload(payload, status) {
  if (status === 401 || /没有登录|未登录|登录.{0,4}(?:超时|失效)|请(?:先)?登录/.test(String(payload?.msg ?? ""))) {
    throw new SeatError("SEAT_LOGIN_REQUIRED", "图书馆座位系统需要先登录。");
  }
  if (!payload || !Number.isInteger(status) || status < 200 || status >= 300) {
    throw new SeatError("SEAT_BAD_RESPONSE", "座位系统没有返回可用数据。");
  }
  if (payload.data == null) throw new SeatError("SEAT_API_ERROR", "座位系统没有返回查询结果。");
  return payload;
}

/** 仅对自有的图书馆只读 API 发 GET。禁止跟随跳转转发 Cookie。 */
export function createSeatReader({ snapshot = readSnapshot, fetchImpl = fetch, now = Date.now } = {}) {
  return async ({ authenticated = true } = {}) => {
    const cookies = authenticated ? (await snapshot())?.cookies : [];
    return async (path) => {
      const url = new URL(path, SEAT_ORIGIN);
      if (url.origin !== SEAT_ORIGIN || !url.pathname.startsWith("/api.php/")) {
        throw new SeatError("SEAT_INVALID_ROUTE", "座位查询地址不合法。");
      }
      const cookie = seatCookieHeader(cookies, url, now());
      if (authenticated && !cookie) throw new SeatError("SEAT_LOGIN_REQUIRED", "图书馆座位系统需要先登录。");
      let res;
      try {
        res = await fetchImpl(url, { method: "GET", headers: cookie ? { cookie } : {}, redirect: "manual", signal: AbortSignal.timeout(10000) });
      } catch {
        throw new SeatError("SEAT_UNREACHABLE", "暂时无法访问座位系统，请稍后重试。");
      }
      return seatApiPayload(await res.json().catch(() => null), res.status);
    };
  };
}

/** 同一批并发查询共享一次会话恢复，只重试只读查询。 */
export function createSeatReadSession({ createReader = createSeatReader(), refresh, onState = () => {} }) {
  let refreshing;
  return async (action, { authenticated = true } = {}) => {
    const run = async () => {
      const read = await createReader({ authenticated });
      const call = authenticated ? async path => {
        const result = await read(path);
        onState("ready", "VERIFIED");
        return result;
      } : read;
      return action({ call });
    };
    try {
      return await run();
    } catch (error) {
      if (!authenticated || error?.code !== "SEAT_LOGIN_REQUIRED") throw error;
    }
    onState("expired", "SEAT_LOGIN_REQUIRED");
    if (!refreshing) refreshing = Promise.resolve().then(refresh).finally(() => { refreshing = undefined; });
    const result = await refreshing;
    if (!result.ok) throw new SeatError(result.code, result.message);
    try {
      return await run();
    } catch (error) {
      if (error?.code === "SEAT_LOGIN_REQUIRED") onState("expired", error.code);
      throw error;
    }
  };
}
