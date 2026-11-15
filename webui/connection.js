import { sanitizeBaseUrl, sanitizeToken } from "./guards.js";

/**
 * 设备连接（服务器 base + 令牌）只以一条原子记录持久化。
 * 关键是“令牌绑定完整 base（含路径）”：换目标地址时旧令牌绝不能被沿用。
 */

export const CONNECTION_KEY = "campus.app.connection";
export const LEGACY_TOKEN_KEY = "campus.app.token";
export const LEGACY_BASE_KEY = "campus.app.base";
export const CONNECTION_VERSION = 1;

/** 完整 base 的规范形式：保留路径、去掉尾斜杠、统一 host 大小写与默认端口。 */
export function normalizeApiBase(value) {
  return sanitizeBaseUrl(value);
}

/** 只有 http(s) 页面才有可用来绑定令牌的 origin。 */
export function pageApiBase(href) {
  let url;
  try {
    url = new URL(String(href));
  } catch {
    return "";
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return "";
  return normalizeApiBase(url.origin);
}

/** 解析新的单对象记录；损坏/缺字段一律当作没有记录，交给 legacy 回落。 */
export function parseConnection(raw) {
  if (typeof raw !== "string" || !raw) return null;
  let value;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const base = normalizeApiBase(value.base);
  const token = sanitizeToken(value.token);
  if (!base && !token) return null;
  return { base, token };
}

/**
 * 决定本次启动实际使用的 base/token。
 * 返回 { base, token, persist, cleared, reason }；cleared=true 表示旧凭据被丢弃、需要重新配对。
 */
export function resolveStartupConnection({
  storedRaw = "",
  legacyTokenRaw = "",
  legacyBaseRaw = "",
  href = "",
  urlBaseRaw = "",
  urlTokenRaw = "",
} = {}) {
  const stored = parseConnection(storedRaw);
  const legacyToken = sanitizeToken(legacyTokenRaw);
  const legacyBase = normalizeApiBase(legacyBaseRaw);
  const urlToken = sanitizeToken(urlTokenRaw);
  const urlBase = normalizeApiBase(urlBaseRaw);
  const pageBase = pageApiBase(href);
  // 新记录整体优先；字段级 fallback 会把新地址与残留的旧令牌拼成跨目标凭据。
  const base = stored ? stored.base : legacyBase;
  const token = stored ? stored.token : legacyToken;

  if (urlToken) {
    // 新令牌只绑定本次目标；http(s) 页面没有显式目标时绑定当前 origin。
    // file:// 没有可用 origin，只能用已保存的明确 base，不能从链接推断新目标。
    const target = urlBase || pageBase || base;
    if (!target) return { base: "", token: "", persist: true, cleared: Boolean(token), reason: "URL_TOKEN_WITHOUT_TARGET" };
    return { base: target, token: urlToken, persist: true, cleared: false, reason: "URL_TOKEN" };
  }
  if (urlBase) {
    if (base && base === urlBase && token) return { base, token, persist: false, cleared: false, reason: "SAME_TARGET" };
    // 链接换了 base 却没有新令牌：旧令牌绝不跟随，必须重新配对。
    return { base: urlBase, token: "", persist: true, cleared: Boolean(token), reason: "TARGET_CHANGED" };
  }
  if (token && !base) {
    // legacy 令牌没有 base：只能绑定当前 http(s) 页面 origin。
    if (!pageBase) return { base: "", token: "", persist: true, cleared: true, reason: "TOKEN_WITHOUT_TARGET" };
    return { base: pageBase, token, persist: true, cleared: false, reason: "LEGACY_BOUND_TO_PAGE" };
  }
  const legacyPresent = Boolean(legacyTokenRaw || legacyBaseRaw);
  if (stored) return { base, token, persist: legacyPresent, cleared: false, reason: "STORED" };
  return { base, token, persist: legacyPresent, cleared: false, reason: legacyPresent ? "LEGACY" : "EMPTY" };
}

/** 单次 setItem 原子写入，并在成功后清掉 legacy 键。 */
export function writeConnection(storage, connection = {}) {
  const base = normalizeApiBase(connection.base);
  const token = sanitizeToken(connection.token);
  if (!base && !token) {
    clearConnection(storage);
    return { base: "", token: "" };
  }
  try {
    storage.setItem(CONNECTION_KEY, JSON.stringify({ version: CONNECTION_VERSION, base, token }));
    storage.removeItem(LEGACY_TOKEN_KEY);
    storage.removeItem(LEGACY_BASE_KEY);
  } catch {
    // 私密模式/配额不足时不阻断页面；内存态仍按校验后的值使用。
  }
  return { base, token };
}

export function readConnection(storage) {
  try {
    return parseConnection(storage.getItem(CONNECTION_KEY));
  } catch {
    return null;
  }
}

export function clearConnection(storage) {
  try {
    storage.removeItem(CONNECTION_KEY);
    storage.removeItem(LEGACY_TOKEN_KEY);
    storage.removeItem(LEGACY_BASE_KEY);
  } catch {}
}