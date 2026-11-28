/** 请求入口的守卫：主机头、跨站来源与 CORS 预检。返回 true 表示已经结束响应。 */
import { hostOf } from "./http-helpers.mjs";
import { applyCors } from "./cors.mjs";

export function guardRequest(req, res, { allowedHosts, extraOrigins = [], method, fail }) {
  const hostHeader = hostOf(req.headers.host);
  if (hostHeader && !allowedHosts.has(hostHeader)) {
    fail(res, 403, "HOST_REJECTED", "请求来源主机不被允许。");
    return true;
  }
  const origin = req.headers.origin;
  if (!origin) return false;
  let originHost = "";
  try {
    originHost = hostOf(new URL(origin).host);
  } catch {
    originHost = "";
  }
  const listed = extraOrigins.includes(origin.toLowerCase());
  if (!listed && (!originHost || !allowedHosts.has(originHost))) {
    fail(res, 403, "ORIGIN_REJECTED", "拒绝跨站请求。");
    return true;
  }
  // 允许在别的域名（例如部署在 Vercel 的静态前端）用设备令牌直连本实例。
  return applyCors(req, res, { origin, listed, method });
}
