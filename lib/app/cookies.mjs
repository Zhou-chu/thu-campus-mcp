/**
 * Cookie 解析与序列化：只支持本应用用到的单个会话 Cookie。
 * 值里不允许出现分号/空白，避免把额外属性注入进来。
 */
export function parseCookies(header) {
  const out = Object.create(null);
  for (const part of String(header || "").split(";")) {
    const at = part.indexOf("=");
    if (at < 0) continue;
    const name = part.slice(0, at).trim();
    const value = part.slice(at + 1).trim();
    if (!name || !value) continue;
    if (name in out) continue;
    out[name] = value;
  }
  return out;
}

export function serializeCookie(name, value, { maxAge = 0, secure = false, sameSite = "Lax", path = "/" } = {}) {
  const parts = [`${name}=${value}`, `Path=${path}`, "HttpOnly", `SameSite=${sameSite}`];
  if (maxAge > 0) parts.push(`Max-Age=${Math.floor(maxAge)}`);
  if (maxAge === 0) parts.push("Max-Age=0");
  if (secure) parts.push("Secure");
  return parts.join("; ");
}

/** 会话 Cookie 名统一在这里定义，服务端与测试都引用同一个常量。 */
export const SESSION_COOKIE = "thu_session";