/**
 * 跨域白名单：让部署在别的域名（例如 Vercel 上的静态前端）用设备令牌直连本机实例。
 *
 * 只对配置里明确列出的来源回显 CORS 头，不使用通配符，也不在响应里带 Cookie 凭据；
 * 预检请求（OPTIONS）在这里直接以 204 结束，避免继续走鉴权分支。
 */
const ALLOW_HEADERS = "authorization, content-type, x-thu-csrf";

export function applyCors(req, res, { origin, listed, method }) {
  if (!origin || !listed) return false;
  res.setHeader("access-control-allow-origin", origin.toLowerCase());
  res.setHeader("vary", "Origin");
  res.setHeader("access-control-allow-methods", "GET, POST, PUT, DELETE, OPTIONS");
  res.setHeader("access-control-allow-headers", ALLOW_HEADERS);
  res.setHeader("access-control-max-age", "600");
  if (method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return true;
  }
  return false;
}