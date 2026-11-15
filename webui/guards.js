/**
 * 浏览器与脚本共用的输入校验纯函数。
 * 这里的规则只做“可核验的收窄”，不改变正常配对/接口路径/令牌的实际取值。
 */

/** 去掉结尾斜杠：线性扫描实现，避免带尾锚点的重复量词正则触发回溯告警。 */
export function trimTrailingSlashes(value) {
  if (typeof value !== "string") return "";
  let end = value.length;
  while (end > 0 && value.charCodeAt(end - 1) === 47 /* / */) end -= 1;
  return value.slice(0, end);
}

/** 设备令牌：可打印 ASCII、无空白/控制字符；兼容 tc1_ 前缀与固定令牌。 */
const TOKEN_PATTERN = /^[\x21-\x7e]{1,4096}$/;
export function sanitizeToken(value) {
  return typeof value === "string" && TOKEN_PATTERN.test(value) ? value : "";
}

/** 服务器地址：只接受 http(s)、无凭据、无查询/片段、无控制字符。 */
export function sanitizeBaseUrl(value) {
  if (typeof value !== "string") return "";
  const text = value.trim();
  if (!text || text.length > 2048 || /[\u0000-\u0020\\]/.test(text)) return "";
  let url;
  try {
    url = new URL(text);
  } catch {
    return "";
  }
  if (!/^https?:$/.test(url.protocol) || url.username || url.password || !url.hostname) return "";
  if (url.search || url.hash) return "";
  return trimTrailingSlashes(url.origin + url.pathname);
}

/** 接口路径：必须是本站单斜杠开头的相对路径，拒绝协议、反斜杠、上级目录与编码绕过。 */
const API_PATH_PATTERN = /^\/[A-Za-z0-9._~!$&'()*+,;=:@%/?-]*$/;
export function sanitizeApiPath(value) {
  if (typeof value !== "string" || value.length > 2048 || value.length === 0) return "";
  if (!API_PATH_PATTERN.test(value) || value.startsWith("//") || value.includes("\\")) return "";
  const lower = value.toLowerCase();
  if (lower.includes("%2e") || value.includes("..")) return "";
  return value;
}

/** 组合 base 与接口路径；路径非法时直接拒绝，绝不把未校验字符串送进 fetch。 */
export function buildApiUrl(base, path) {
  const safePath = sanitizeApiPath(path);
  if (!safePath) throw new Error("接口路径不合法，已拒绝请求。");
  return sanitizeBaseUrl(base) + safePath;
}

/** 配对码固定 6 位数字，避免把任意字符串拼进深链或请求体。 */
export function sanitizePairCode(value) {
  const text = typeof value === "string" ? value.trim() : "";
  return /^\d{6}$/.test(text) ? text : "";
}