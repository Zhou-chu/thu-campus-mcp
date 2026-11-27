/**
 * 纯 HTTP 的统一身份认证（CAS）登录：不再为了拿一组站点 Cookie 去开浏览器。
 *
 * 协议按学校现行实现：
 *  1. 打开目标系统的登录入口，跟随跳转到 `id.tsinghua.edu.cn` 的登录表单；
 *  2. 表单里带 `#sm2publicKey`，密码用 SM2 加密（密文前加 `04`）；
 *  3. POST `/do/off/ui/auth/login/check`，字段 `i_user` / `i_pass` / `fingerPrint` / `i_captcha`；
 *  4. 成功页含「登录成功。正在重定向到」，从 `<a href>` 取出回调地址；
 *  5. 跟随回调把票证换成目标系统自己的 Cookie。
 *
 * 失败要能区分：凭据错误、需要二次认证、需要验证码、网络/结构变化。
 * 这里不做任何“猜成功”的判定：只有落到目标系统并拿到它的 Cookie 才算登录成功。
 */
import { randomBytes } from "node:crypto";

export const CAS_ORIGIN = "https://id.tsinghua.edu.cn";
const LOGIN_CHECK_PATH = "/do/off/ui/auth/login/check";

export class CasHttpError extends Error {
  constructor(code, message, status = 502) {
    super(message);
    this.name = "CasHttpError";
    this.code = code;
    this.status = status;
  }
}

/** 最小 Cookie 罐：按域名/路径匹配，够走完 CAS 与目标站点的跳转。 */
export function createCookieJar() {
  const items = new Map();
  const keyOf = (domain, path, name) => `${domain}\u0000${path}\u0000${name}`;
  const add = (header, requestUrl) => {
    const url = new URL(requestUrl);
    const [pair, ...attrs] = String(header).split(";");
    const index = pair.indexOf("=");
    if (index <= 0) return;
    const name = pair.slice(0, index).trim();
    const value = pair.slice(index + 1).trim();
    let domain = url.hostname;
    let cookiePath = "/";
    for (const attr of attrs) {
      const [rawKey, ...rest] = attr.split("=");
      const key = String(rawKey || "").trim().toLowerCase();
      const attrValue = rest.join("=").trim();
      if (key === "domain" && attrValue) domain = attrValue.replace(/^\./, "").toLowerCase();
      else if (key === "path" && attrValue.startsWith("/")) cookiePath = attrValue;
    }
    items.set(keyOf(domain, cookiePath, name), { domain, path: cookiePath, name, value });
  };
  return {
    add,
    addFrom(response, requestUrl) {
      const list = typeof response.headers.getSetCookie === "function" ? response.headers.getSetCookie() : [];
      for (const header of list) add(header, requestUrl);
    },
    header(requestUrl) {
      const url = new URL(requestUrl);
      const host = url.hostname.toLowerCase();
      const picked = [...items.values()]
        .filter(cookie => (host === cookie.domain || host.endsWith("." + cookie.domain)) && url.pathname.startsWith(cookie.path))
        .sort((a, b) => b.path.length - a.path.length)
        .map(cookie => `${cookie.name}=${cookie.value}`);
      return picked.join("; ");
    },
    cookies(requestUrl) {
      const url = new URL(requestUrl);
      const host = url.hostname.toLowerCase();
      return [...items.values()].filter(cookie => host === cookie.domain || host.endsWith("." + cookie.domain));
    },
    set(requestUrl, name, value) {
      const url = new URL(requestUrl);
      items.set(keyOf(url.hostname.toLowerCase(), "/", name), { domain: url.hostname.toLowerCase(), path: "/", name, value });
    },
  };
}

/** 逐步跟随跳转（每步都带上 Cookie），返回最终响应。 */
async function follow({ url, method = "GET", body, jar, fetchImpl, maxHops = 12, signal }) {
  let current = url;
  let nextMethod = method;
  let nextBody = body;
  for (let hop = 0; hop < maxHops; hop += 1) {
    const response = await fetchImpl(current, {
      method: nextMethod,
      body: nextBody,
      redirect: "manual",
      headers: {
        ...(jar.header(current) ? { cookie: jar.header(current) } : {}),
        ...(nextBody ? { "content-type": "application/x-www-form-urlencoded" } : {}),
      },
      signal,
    });
    jar.addFrom(response, current);
    const location = response.headers.get("location");
    if (!location || ![301, 302, 303, 307, 308].includes(response.status)) return { response, url: current };
    current = new URL(location, current).href;
    // 303 与 POST 后的重定向一律改用 GET，避免把凭据重发到下一个地址。
    if (response.status === 303 || nextMethod === "POST") { nextMethod = "GET"; nextBody = undefined; }
  }
  throw new CasHttpError("CAS_REDIRECT_LOOP", "统一认证跳转次数过多，未完成登录。");
}

export function parseSm2PublicKey(html) {
  const match = /id=["']sm2publicKey["'][^>]*>([0-9a-fA-F]{64,})</.exec(String(html || ""));
  return match ? match[1] : "";
}

export function parseLoginOutcome(html, base = CAS_ORIGIN) {
  const text = String(html || "");
  // 官方的失败页在模板里也带“验证码”字样，所以先看明确提示，再判“真的要求验证码”。
  const note = /id=["']msg_note["'][^>]*>([^<]*)</.exec(text)?.[1]?.trim() || "";
  if (note) return { ok: false, code: "CAS_CREDENTIALS_INVALID", message: note };
  if (/二次认证|双重认证|two.?factor/i.test(text)) return { ok: false, code: "CAS_TWO_FACTOR_REQUIRED", message: "统一身份认证要求二次认证，需要本人完成。" };
  if (/请(?:输入|完成)(?:图形)?验证码|滑动(?:完成)?验证|请完成验证/i.test(text))
    return { ok: false, code: "CAS_CAPTCHA_REQUIRED", message: "统一身份认证要求验证码，需要本人完成。" };
  if (!/登录成功。正在重定向到|正在重定向/.test(text)) {
    return { ok: false, code: "CAS_CREDENTIALS_INVALID", message: "统一身份认证未通过，请检查账号与密码。" };
  }
  const href = /<a[^>]+href=["']([^"']+)["']/i.exec(text)?.[1];
  if (!href) return { ok: false, code: "CAS_BAD_RESPONSE", message: "登录成功页没有给出回调地址。" };
  return { ok: true, callback: new URL(href, base).href };
}

/**
 * 用账号密码换目标系统的 Cookie。
 * @returns {Promise<{ok: true, jar, finalUrl: string}>}
 */
export async function casLoginHttp({
  entryUrl,
  username,
  password,
  jar = createCookieJar(),
  fetchImpl = fetch,
  signal,
  deviceName = "thu-campus-mcp",
  sm2 = null,
  casOrigin = CAS_ORIGIN,
} = {}) {
  const name = String(username || "").trim();
  const secret = typeof password === "string" ? password : "";
  if (!name) throw new CasHttpError("CAS_ACCOUNT_REQUIRED", "请填写学号或用户名。", 400);
  if (!secret) throw new CasHttpError("CAS_PASSWORD_REQUIRED", "请填写统一身份认证密码。", 400);

  const entry = await follow({ url: entryUrl, jar, fetchImpl, signal });
  const entryHtml = await entry.response.text();
  if (entry.response.status === 401) throw new CasHttpError("CAS_REJECTED", "统一认证入口拒绝访问。", 401);

  const publicKey = parseSm2PublicKey(entryHtml);
  if (!publicKey) {
    // 已经带着有效会话（表单直接给出跳转），或者页面结构变了；两者都不该在这里猜。
    const outcome = parseLoginOutcome(entryHtml, entry.url);
    if (outcome.ok) return { ok: true, jar, finalUrl: entry.url };
    throw new CasHttpError("CAS_FORM_NOT_FOUND", "没有找到统一认证登录表单，可能已登录或页面结构已变化。", 409);
  }

  let implementation = sm2;
  if (!implementation) {
    const module = await import("sm-crypto");
    implementation = (module.default ?? module).sm2;
  }
  const encrypted = "04" + implementation.doEncrypt(secret, publicKey);
  const body = new URLSearchParams({
    i_user: name,
    i_pass: encrypted,
    fingerPrint: randomBytes(16).toString("hex"),
    fingerGenPrint: "",
    i_captcha: "",
    singleLogin: "on",
    deviceName: String(deviceName).slice(0, 40),
  }).toString();

  const submitted = await follow({ url: new URL(LOGIN_CHECK_PATH, casOrigin).href, method: "POST", body, jar, fetchImpl, signal });
  const outcome = parseLoginOutcome(await submitted.response.text(), submitted.url);
  if (!outcome.ok) throw new CasHttpError(outcome.code, outcome.message, outcome.code === "CAS_CREDENTIALS_INVALID" ? 401 : 409);

  const callback = await follow({ url: outcome.callback, jar, fetchImpl, signal });
  if (!callback.response.ok) throw new CasHttpError("CAS_CALLBACK_FAILED", `回调目标系统失败（HTTP ${callback.response.status}）。`);
  return { ok: true, jar, finalUrl: callback.url };
}

/** 把同一份 Cookie 转成快照里的 cookie 数组形状（供只读 HTTP 查询复用）。 */
export function jarToSnapshotCookies(jar, origin) {
  return jar.cookies(origin).map(cookie => ({
    name: cookie.name,
    value: cookie.value,
    domain: cookie.domain,
    path: cookie.path,
    expires: -1,
  }));
}