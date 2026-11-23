/** HTTP 小工具：Bearer 解析、Host 归一化、任务查找。
 */
export function bearer(req) {
  const value = req.headers.authorization || "";
  const match = /^Bearer\s+(\S+)$/i.exec(value);
  return match ? match[1] : "";
}
export function hostOf(value) {
  const raw = String(value || "");
  const trimmed = raw.startsWith("[") ? raw : raw.split(":")[0];
  return trimmed.toLowerCase();
}
/**
 * 把各服务自己的状态载荷归一化成 ready / login-required / expired / unknown。
 * 只反映本机已保存的会话是否可用；not_checked 表示配置存在但尚未在线校验。
 */
export function searchJob(node, id, depth = 0) {
  if (!node || typeof node !== "object" || depth > 6) return null;
  if (Array.isArray(node)) {
    for (const item of node) {
      const found = searchJob(item, id, depth + 1);
      if (found) return found;
    }
    return null;
  }
  if (node.id === id || node.jobId === id) return node;
  for (const value of Object.values(node)) {
    const found = searchJob(value, id, depth + 1);
    if (found) return found;
  }
  return null;
}
