/**
 * 请求入口的认证闸门：邮箱路由、Cookie 会话、设备令牌与 CSRF 检查集中在这里，
 * 通过后返回设备/用户身份，供上层写入请求级用户上下文。
 */
import { enterUser } from "./request-context.mjs";

export function createAuthGate({ authRoutes, authorize, pairingEnabled = true }) {
  return async function authGate(req, res, { pathname, method, readBody, json, fail }) {
    if (authRoutes && (await authRoutes.handle(req, res, { pathname, method, readBody, json, fail }))) return { handled: true };
    if (!authRoutes && pathname === "/api/auth/config") {
      json(res, 200, { ok: true, emailAuth: false, pairingEnabled, authenticated: false, user: null });
      return { handled: true };
    }
    const device = await authorize(req);
    if (!device) {
      fail(res, 401, "AUTH_REQUIRED", "需要设备令牌或登录。");
      return { handled: true };
    }
    if (device.viaCookie && !["GET", "HEAD"].includes(method) && req.headers["x-thu-csrf"] !== "1") {
      fail(res, 403, "CSRF_REQUIRED", "缺少防跨站标记，请从应用内操作。");
      return { handled: true };
    }
    enterUser(device.userId || null);
    return { handled: false, device };
  };
}