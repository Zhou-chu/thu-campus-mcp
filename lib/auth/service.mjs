/**
 * 邮箱账号服务：注册、登录、会话校验与登出。
 *
 * 存储通过注入的 userStore / sessionStore 访问（生产用 PostgreSQL，测试用内存实现），
 * 本模块只负责规则与状态判断，不碰 SQL，也不碰 HTTP。
 */
import { emailAllowed, normalizeEmail, allowedDomains } from "./email.mjs";
import { hashPassword, passwordProblem, verifyPassword } from "./password.mjs";
import { dummyPasswordHash } from "./dummy.mjs";
import { hashToken, issueToken, SESSION_TTL_MS } from "./token.mjs";

export class AuthError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "AuthError";
    this.code = code;
  }
}

const fail = (code, message) => { throw new AuthError(code, message); };

export function createAuthService({ users, sessions, domains = allowedDomains(), now = () => new Date() } = {}) {
  if (!users || !sessions) throw new TypeError("createAuthService 需要 users 与 sessions 存储");

  async function startSession(user, device = {}) {
    const issued = issueToken(now());
    await sessions.create({
      userId: user.id,
      tokenHash: issued.hash,
      createdAt: issued.createdAt,
      expiresAt: issued.expiresAt,
      device: String(device.label ?? "").slice(0, 120) || null,
      platform: String(device.platform ?? "").slice(0, 40) || null,
    });
    return { token: issued.token, expiresAt: issued.expiresAt, user: publicUser(user) };
  }

  return {
    /** 注册：清华邮箱 + 密码，成功即登录（不发验证邮件）。 */
    async register({ email, password, device } = {}) {
      const normalized = normalizeEmail(email);
      if (!normalized) fail("INVALID_EMAIL", "请输入有效邮箱地址。");
      if (!emailAllowed(normalized, domains)) fail("EMAIL_DOMAIN_NOT_ALLOWED", "只支持清华邮箱注册。");
      const problem = passwordProblem(password);
      if (problem) fail("WEAK_PASSWORD", problem);
      if (await users.findByEmail(normalized)) fail("EMAIL_TAKEN", "该邮箱已注册，请直接登录。");
      const passwordHash = await hashPassword(password);
      const user = await users.create({ email: normalized, passwordHash, createdAt: now().toISOString() });
      return await startSession(user, device);
    },

    /** 登录：邮箱不存在与密码错误返回同一个错误码，避免枚举账号。 */
    async login({ email, password, device } = {}) {
      const normalized = normalizeEmail(email);
      const user = normalized ? await users.findByEmail(normalized) : null;
      // 无论账号是否存在都跑一次 scrypt，保持响应时间大致一致。
      const stored = user?.passwordHash || dummyPasswordHash();
      const ok = await verifyPassword(password, stored);
      if (!user || !ok) fail("INVALID_CREDENTIALS", "邮箱或密码不正确。");
      if (user.disabledAt) fail("ACCOUNT_DISABLED", "该账号已停用。");
      return await startSession(user, device);
    },

    /** 用明文令牌换用户；过期、撤销、用户停用都返回 null。 */
    async authenticate(token) {
      const hash = hashToken(token);
      if (!hash || !token) return null;
      const session = await sessions.findByTokenHash(hash);
      if (!session) return null;
      if (session.revokedAt) return null;
      if (Date.parse(session.expiresAt) <= now().getTime()) return null;
      const user = await users.findById(session.userId);
      if (!user || user.disabledAt) return null;
      await sessions.touch?.(hash, now().toISOString());
      return { user: publicUser(user), session: { expiresAt: session.expiresAt } };
    },

    async logout(token) {
      const hash = hashToken(token);
      if (!hash) return false;
      return Boolean(await sessions.revoke(hash, now().toISOString()));
    },

    /** 设备管理页用：列出当前账号的会话，并可撤销单台。 */
    async listSessions(userId) {
      const rows = await sessions.listByUser(userId);
      return rows.map(row => ({
        id: row.id,
        device: row.device || "",
        platform: row.platform || "",
        createdAt: row.createdAt,
        lastSeenAt: row.lastSeenAt || null,
        expiresAt: row.expiresAt,
        revoked: Boolean(row.revokedAt),
      }));
    },

    async revokeSession(userId, sessionId) {
      return Boolean(await sessions.revokeById(userId, sessionId, now().toISOString()));
    },

    ttlMs: SESSION_TTL_MS,
  };
}

function publicUser(user) {
  return { id: user.id, email: user.email, createdAt: user.createdAt ?? null };
}