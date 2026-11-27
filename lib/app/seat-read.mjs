import { readSnapshot } from "@thu-campus/browser";

export const SEAT_ORIGIN = "https://seat.lib.tsinghua.edu.cn";
export const SEAT_SESSION_PROBE = "/api.php/v3areas/35";
export const SEAT_HOME = "/web/seat3?area=3";

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

export function seatApiPayload(payload, status, location = "") {
  if (status === 401 || /没有登录|未登录|登录.{0,4}(?:超时|失效)|请(?:先)?登录/.test(String(payload?.msg ?? ""))) {
    throw new SeatError("SEAT_LOGIN_REQUIRED", "图书馆座位系统需要先登录。");
  }
  // 会话过期时座位接口会跳去统一认证；只把这种跳转当“需要登录”，其它 3xx 仍是坏响应。
  if ([301, 302, 303, 307, 308].includes(Number(status)) && /id\.tsinghua\.edu\.cn|\/login/i.test(String(location || "")))
    throw new SeatError("SEAT_LOGIN_REQUIRED", "图书馆座位系统的登录已过期。");
  // 2xx 却不是 JSON：通常是登录页/网关页，说明会话已经不可用，应当触发一次恢复而不是报“坏响应”。
  if (payload === null && Number(status) >= 200 && Number(status) < 300)
    throw new SeatError("SEAT_LOGIN_REQUIRED", "图书馆座位系统的会话已失效。");
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
      return seatApiPayload(await res.json().catch(() => null), res.status, res.headers?.get?.("location") || "");
    };
  };
}

/** 从座位页 HTML 里取 ska.bookRule。
 * 线上把规则写成 JS 表达式（`bookRule: "zh"=="en"?[...]:[...]`），不是 JSON，
 * 所以按字符串扫描出数组字面量再逐个 JSON.parse，取中文那一支。
 */
export function parseSeatBookRule(html) {
  const source = String(html || "");
  const at = source.indexOf("bookRule");
  if (at < 0) return "";
  const rest = source.slice(at, at + 40000);
  const arrays = [];
  for (let index = 0; index < rest.length && arrays.length < 4; index += 1) {
    if (rest[index] !== "[") continue;
    let depth = 0, inString = false, escape = false, endIndex = -1;
    for (let cursor = index; cursor < rest.length; cursor += 1) {
      const char = rest[cursor];
      if (escape) { escape = false; continue; }
      if (char === "\\") { escape = true; continue; }
      if (char === '"') { inString = !inString; continue; }
      if (inString) continue;
      if (char === "[") depth += 1;
      else if (char === "]") {
        depth -= 1;
        if (depth === 0) { endIndex = cursor; break; }
      }
    }
    if (endIndex < 0) break;
    try {
      const parsed = JSON.parse(rest.slice(index, endIndex + 1));
      if (Array.isArray(parsed) && parsed.length) arrays.push(parsed);
    } catch { /* 不是合法数组就继续找下一个 */ }
    index = endIndex;
  }
  if (!arrays.length) {
    // 少数部署把规则写成单个字符串。
    const scalar = /bookRule['"]?\s*[:=]\s*("(?:[^"\\]|\\.)*")/.exec(rest);
    if (scalar) {
      try { return String(JSON.parse(scalar[1]) ?? ""); } catch { return ""; }
    }
    return "";
  }
  const textOf = list => list.filter(item => typeof item === "string").join(" ").trim();
  // 英文分支里也可能夹着馆名等中文字符，按中文数量取最多的那一支，而不是“第一个含中文的”。
  const score = list => (textOf(list).match(/[\u4e00-\u9fff]/g) || []).length;
  const best = arrays.reduce((picked, list) => (score(list) > score(picked ?? []) ? list : picked), null);
  return textOf(best || arrays[0] || []);
}

/** 用已保存的 Cookie 读取座位首页；失败返回空串，由调用方选择是否退回浏览器。 */
export function createSeatPageReader({ snapshot = readSnapshot, fetchImpl = fetch, now = Date.now, home = SEAT_HOME } = {}) {
  return async () => {
    const url = new URL(home, SEAT_ORIGIN);
    const cookies = (await snapshot())?.cookies ?? [];
    const cookie = seatCookieHeader(cookies, url, now());
    if (!cookie) throw new SeatError("SEAT_LOGIN_REQUIRED", "图书馆座位系统需要先登录。");
    let response;
    try {
      response = await fetchImpl(url, { method: "GET", headers: { cookie }, redirect: "manual", signal: AbortSignal.timeout(10000) });
    } catch {
      throw new SeatError("SEAT_UNREACHABLE", "暂时无法访问座位系统，请稍后重试。");
    }
    if (response.status === 401) throw new SeatError("SEAT_LOGIN_REQUIRED", "图书馆座位系统的登录已过期。");
    if (!response.ok) throw new SeatError("SEAT_BAD_RESPONSE", "座位系统没有返回可用数据。");
    return parseSeatBookRule(await response.text());
  };
}

/**
 * 纯 HTTP 登录：用统一认证换座位站 Cookie，再拿受保护接口验证。
 * 成功返回可写入快照的 Cookie；失败抛 SeatError，凭据类错误不退回浏览器。
 */
export async function loginSeatHttp({ credentials, fetchImpl = fetch, casOrigin, now = Date.now } = {}) {
  const username = String(credentials?.username || "").trim();
  const password = typeof credentials?.password === "string" ? credentials.password : "";
  if (!username || !password) throw new SeatError("ACCOUNT_NOT_CONFIGURED", "请先在“清华账号”配置学号与密码。");
  const { casLoginHttp, jarToSnapshotCookies } = await import("./cas-http.mjs");
  let result;
  try {
    result = await casLoginHttp({ entryUrl: new URL(SEAT_HOME, SEAT_ORIGIN).href, username, password, fetchImpl, casOrigin });
  } catch (error) {
    if (error?.code === "CAS_CREDENTIALS_INVALID") throw new SeatError("SEAT_CREDENTIALS_INVALID", error.message);
    if (error?.code === "CAS_TWO_FACTOR_REQUIRED" || error?.code === "CAS_CAPTCHA_REQUIRED")
      throw new SeatError("CAS_CAPTCHA_REQUIRED", error.message);
    if (error?.code === "CAS_FORM_NOT_FOUND") {
      // 座位站在非开放时段会跳到 /web/notopen，这种情况是“没开”，不是登录失败。
      const page = await fetchImpl(new URL(SEAT_HOME, SEAT_ORIGIN), { redirect: "manual", signal: AbortSignal.timeout(8000) }).catch(() => null);
      const text = page ? await page.text().catch(() => "") : "";
      if (/notopen|未开放|开放时间/i.test(text) || page?.status === 302)
        throw new SeatError("SEAT_CLOSED", "座位系统当前不在开放时段（06:00–23:00）。");
    }
    // 网络/结构变化类错误交给调用方决定是否退回浏览器。
    throw Object.assign(new SeatError("SEAT_HTTP_LOGIN_FAILED", error?.message || "纯 HTTP 登录未完成。"), { cause: error });
  }
  const url = new URL(SEAT_SESSION_PROBE, SEAT_ORIGIN);
  const cookie = result.jar.header(url.href);
  let response;
  try {
    response = await fetchImpl(url, { method: "GET", headers: cookie ? { cookie } : {}, redirect: "manual", signal: AbortSignal.timeout(10000) });
  } catch {
    throw new SeatError("SEAT_UNREACHABLE", "暂时无法访问座位系统，请稍后重试。");
  }
  seatApiPayload(await response.json().catch(() => null), response.status, response.headers?.get?.("location") || "");
  return { ok: true, cookies: jarToSnapshotCookies(result.jar, SEAT_ORIGIN), at: new Date(now()).toISOString() };
}

/** Login and read recovery share this check; a stale page token is not evidence. */
export function createSeatLogin({ probe = probeSeatSession, open, authenticate, reset, verify, onState = () => {} }) {
  let inFlight;
  async function run() {
    const proof = await probe();
    if (proof.verified) {
      onState("ready", "VERIFIED");
      return { ok: true, alreadyLoggedIn: true };
    }
    const failure = error => error?.code === "SEAT_LOGIN_REQUIRED"
      ? { ok: false, code: error.code, message: error.message }
      : { ok: false, code: "PROBE_FAILED", message: "暂时无法核验图书馆座位登录。" };
    if (proof.state !== "login-required") return failure();
    return open(async session => {
      try { await verify(session); }
      catch (error) {
        if (error?.code !== "SEAT_LOGIN_REQUIRED") return failure(error);
        await reset(session);
        const result = await authenticate(session);
        if (!result.ok) {
          onState(result.code === "SEAT_CLOSED" ? "unavailable" : "login-required", result.code);
          return result;
        }
        try { await verify(session); }
        catch (retryError) { return failure(retryError); }
        await (session.checkpoint ?? (() => session.browser.checkpoint()))();
        onState("ready", "VERIFIED");
        return result;
      }
      await (session.checkpoint ?? (() => session.browser.checkpoint()))();
      onState("ready", "VERIFIED");
      return { ok: true, alreadyLoggedIn: true };
    });
  }
  return () => {
    inFlight ??= run().finally(() => { inFlight = undefined; });
    return inFlight;
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
