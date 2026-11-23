/**
 * 账号相关的 PostgreSQL 仓库：users / sessions / devices。
 *
 * 只做字段映射与 SQL；密码哈希、令牌哈希的生成在 lib/auth 里，
 * 这里拿到的已经是哈希，不会出现明文。
 */
import { randomUUID } from "node:crypto";
import { iso } from "./pg.mjs";

const userRow = row => ({
  id: row.id,
  email: row.email,
  passwordHash: row.password_hash,
  emailVerified: row.email_verified,
  createdAt: iso(row.created_at),
  disabledAt: iso(row.disabled_at),
});

const sessionRow = row => ({
  id: row.id,
  userId: row.user_id,
  tokenHash: row.token_hash,
  createdAt: iso(row.created_at),
  expiresAt: iso(row.expires_at),
  lastSeenAt: iso(row.last_seen_at),
  revokedAt: iso(row.revoked_at),
  device: row.device_label,
  platform: row.platform,
});

const deviceRow = row => ({
  id: row.id,
  userId: row.user_id,
  name: row.name,
  platform: row.platform,
  createdAt: iso(row.created_at),
  lastSeenAt: iso(row.last_seen_at),
  revokedAt: iso(row.revoked_at),
});

export function createAuthRepositories(store) {
  const users = {
    async findByEmail(email) {
      const { rows } = await store.query("select * from users where email = $1", [String(email).toLowerCase()]);
      return rows[0] ? userRow(rows[0]) : null;
    },
    async findById(id) {
      const { rows } = await store.query("select * from users where id = $1", [id]);
      return rows[0] ? userRow(rows[0]) : null;
    },
    /** 单实例运行时取“本机账号”：第一个注册用户。 */
    async first() {
      const { rows } = await store.query("select * from users order by created_at limit 1");
      return rows[0] ? userRow(rows[0]) : null;
    },
    async create({ email, passwordHash, createdAt = store.now().toISOString() }) {
      const { rows } = await store.query(
        "insert into users (id, email, password_hash, created_at) values ($1, $2, $3, $4) returning *",
        [randomUUID(), String(email).toLowerCase(), passwordHash, createdAt],
      );
      return userRow(rows[0]);
    },
    async setDisabled(id, at = store.now().toISOString()) {
      const { rowCount } = await store.query("update users set disabled_at = $2 where id = $1", [id, at]);
      return rowCount > 0;
    },
  };

  const sessions = {
    async create({ userId, tokenHash, createdAt, expiresAt, device = null, platform = null }) {
      const { rows } = await store.query(
        `insert into sessions (id, user_id, token_hash, created_at, expires_at, device_label, platform)
         values ($1, $2, $3, $4, $5, $6, $7) returning *`,
        [randomUUID(), userId, tokenHash, createdAt, expiresAt, device, platform],
      );
      return sessionRow(rows[0]);
    },
    async findByTokenHash(tokenHash) {
      const { rows } = await store.query("select * from sessions where token_hash = $1", [tokenHash]);
      return rows[0] ? sessionRow(rows[0]) : null;
    },
    async listByUser(userId) {
      const { rows } = await store.query("select * from sessions where user_id = $1 order by created_at desc", [userId]);
      return rows.map(sessionRow);
    },
    async touch(tokenHash, at = store.now().toISOString()) {
      const { rowCount } = await store.query("update sessions set last_seen_at = $2 where token_hash = $1", [tokenHash, at]);
      return rowCount > 0;
    },
    async revoke(tokenHash, at = store.now().toISOString()) {
      const { rowCount } = await store.query(
        "update sessions set revoked_at = $2 where token_hash = $1 and revoked_at is null",
        [tokenHash, at],
      );
      return rowCount > 0;
    },
    async revokeById(userId, id, at = store.now().toISOString()) {
      const { rowCount } = await store.query(
        "update sessions set revoked_at = $3 where id = $2 and user_id = $1 and revoked_at is null",
        [userId, id, at],
      );
      return rowCount > 0;
    },
    async deleteExpired(before = store.now().toISOString()) {
      const { rowCount } = await store.query("delete from sessions where expires_at < $1", [before]);
      return rowCount;
    },
  };

  const devices = {
    async register({ userId, name, platform = null, createdAt = store.now().toISOString() }) {
      const { rows } = await store.query(
        `insert into devices (id, user_id, name, platform, created_at, last_seen_at)
         values ($1, $2, $3, $4, $5, $5) returning *`,
        [randomUUID(), userId, name, platform, createdAt],
      );
      return deviceRow(rows[0]);
    },
    async listByUser(userId) {
      const { rows } = await store.query("select * from devices where user_id = $1 order by created_at desc", [userId]);
      return rows.map(deviceRow);
    },
    async touch(id, at = store.now().toISOString()) {
      const { rowCount } = await store.query("update devices set last_seen_at = $2 where id = $1", [id, at]);
      return rowCount > 0;
    },
    async revoke(userId, id, at = store.now().toISOString()) {
      const { rowCount } = await store.query(
        "update devices set revoked_at = $3 where id = $2 and user_id = $1 and revoked_at is null",
        [userId, id, at],
      );
      return rowCount > 0;
    },
  };

  return { users, sessions, devices };
}