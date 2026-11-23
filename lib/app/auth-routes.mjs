/**
 * 邮箱账号的 HTTP 路由（#95）。
 *
 * 浏览器用 HttpOnly Cookie 保存会话；接口只回 email 与过期时间，令牌不落响应体。
 * 登录/注册按 IP 限流；Cookie 鉴权的写操作要求显式 `x-thu-csrf: 1`。
 */
import { SESSION_COOKIE, parseCookies, serializeCookie } from "./cookies.mjs";

const LOGIN_WINDOW_MS = 15 * 60_000;
const LOGIN_MAX = 10;
const REGISTER_WINDOW_MS = 60 * 60_000;
const REGISTER_MAX = 5;

function rateLimiter({ windowMs, max }) {
  const hits = new Map();
  return {
    take(key, now = Date.now()) {
      const bucket = hits.get(key);
      if (!bucket || now - bucket.start >= windowMs) {
        hits.set(key, { start: now, count: 1 });
        return true;
      }
      bucket.count += 1;
      if (hits.size > 5000) {
        for (const [item, value] of hits) if (now - value.start >= windowMs) hits.delete(item);
      }
      return bucket.count <= max;
    },
  };
}

function clientKey(req) {
  return String(req.socket?.remoteAddress || req.headers["x-forwarded-for"] || "unknown");
}

function bodyUser(user) {
  return { id: user.id, email: user.email, createdAt: user.createdAt ?? null };
}

export function createAuthRoutes({ auth, secureCookies = false, pairingEnabled = true, onLogin = null, now = () => new Date() }) {
  const loginLimit = rateLimiter({ windowMs: LOGIN_WINDOW_MS, max: LOGIN_MAX });
  const registerLimit = rateLimiter({ windowMs: REGISTER_WINDOW_MS, max: REGISTER_MAX });
  const cookieOptions = () => ({ maxAge: auth.ttlMs / 1000, secure: secureCookies });

  function readSessionToken(req) {
    return parseCookies(req.headers.cookie)[SESSION_COOKIE] || "";
  }

  async function identityOf(req) {
    const token = readSessionToken(req);
    if (!token) return null;
    return await auth.authenticate(token);
  }

  function setSession(res, token) {
    res.setHeader("Set-Cookie", serializeCookie(SESSION_COOKIE, token, cookieOptions()));
  }

  function clearSession(res) {
    res.setHeader("Set-Cookie", serializeCookie(SESSION_COOKIE, "", { maxAge: 0, secure: secureCookies }));
  }

  return {
    identityOf,
    /** 处理 /api/auth/*；不是本模块的路径返回 false。 */
    async handle(req, res, { pathname, method, readBody, json, fail }) {
      if (!pathname.startsWith("/api/auth/")) return false;
      if (pathname === "/api/auth/config") {
        if (method !== "GET") return fail(res, 405, "METHOD_NOT_ALLOWED", "不支持的请求方法。");
        const current = await identityOf(req);
        return json(res, 200, { ok: true, emailAuth: true, pairingEnabled, authenticated: Boolean(current), user: current ? { email: current.user.email } : null });
      }

      if (pathname === "/api/auth/register" || pathname === "/api/auth/login") {
        if (method !== "POST") return fail(res, 405, "METHOD_NOT_ALLOWED", "不支持的请求方法。");
        const limiter = pathname.endsWith("register") ? registerLimit : loginLimit;
        if (!limiter.take(clientKey(req), now().getTime())) {
          return fail(res, 429, "RATE_LIMITED", "尝试过于频繁，请稍后再试。");
        }
        const body = await readBody(req, 16 * 1024);
        const email = typeof body?.email === "string" ? body.email : "";
        const password = typeof body?.password === "string" ? body.password : "";
        try {
          const result = pathname.endsWith("register")
            ? await auth.register({ email, password, device: { label: String(req.headers["user-agent"] || "").slice(0, 120), platform: "webui" } })
            : await auth.login({ email, password, device: { label: String(req.headers["user-agent"] || "").slice(0, 120), platform: "webui" } });
          setSession(res, result.token);
          if (onLogin) await Promise.resolve(onLogin(result.user)).catch(() => {});
          return json(res, 200, { ok: true, user: bodyUser(result.user), expiresAt: result.expiresAt });
        } catch (error) {
          const status = error.code === "INVALID_CREDENTIALS" ? 401 : error.code === "EMAIL_TAKEN" ? 409 : 400;
          return fail(res, status, error.code || "AUTH_FAILED", error.message);
        }
      }

      const identity = await identityOf(req);
      if (!identity) return fail(res, 401, "AUTH_REQUIRED", "请先登录。");

      const mutating = method !== "GET" && method !== "HEAD";
      if (mutating && req.headers["x-thu-csrf"] !== "1") {
        return fail(res, 403, "CSRF_REQUIRED", "缺少防跨站标记，请从应用内操作。");
      }

      if (pathname === "/api/auth/me" && method === "GET") {
        return json(res, 200, { ok: true, user: bodyUser(identity.user), expiresAt: identity.session.expiresAt });
      }
      if (pathname === "/api/auth/logout" && method === "POST") {
        await auth.logout(readSessionToken(req));
        clearSession(res);
        return json(res, 200, { ok: true });
      }
      if (pathname === "/api/auth/sessions" && method === "GET") {
        return json(res, 200, { ok: true, sessions: await auth.listSessions(identity.user.id) });
      }
      const match = /^\/api\/auth\/sessions\/([A-Za-z0-9-]{1,64})$/.exec(pathname);
      if (match && method === "DELETE") {
        const revoked = await auth.revokeSession(identity.user.id, match[1]);
        if (!revoked) return fail(res, 404, "SESSION_NOT_FOUND", "会话不存在或已失效。");
        return json(res, 200, { ok: true });
      }
      return fail(res, 404, "NOT_FOUND", "接口不存在。");
    },
  };
}