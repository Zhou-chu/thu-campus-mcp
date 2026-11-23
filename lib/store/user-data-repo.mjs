/**
 * 用户数据的 PostgreSQL 仓库：设置、会话与消息、定时任务、服务凭据。
 *
 * 所有查询都带 user_id 约束，避免拿到别人的会话 ID 就能读写；
 * JSONB 字段统一在边界上用 JSON.stringify/parse 转换，测试（pg-mem）与真实 PG 行为一致。
 */
import { randomUUID } from "node:crypto";
import { iso } from "./pg.mjs";

function jsonOut(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") {
    try { return JSON.parse(value); } catch { return value; }
  }
  return value;
}

const sessionRow = row => ({
  id: row.id,
  userId: row.user_id,
  title: row.title,
  createdAt: iso(row.created_at),
  updatedAt: iso(row.updated_at),
  archived: Boolean(row.archived),
});

const messageRow = row => ({
  id: row.id,
  sessionId: row.session_id,
  role: row.role,
  content: jsonOut(row.content),
  createdAt: iso(row.created_at),
  seq: Number(row.seq),
});

const scheduleRow = row => ({
  id: row.id,
  userId: row.user_id,
  title: row.title,
  prompt: row.prompt,
  kind: row.kind,
  spec: jsonOut(row.spec) || {},
  enabled: Boolean(row.enabled),
  lastRunAt: iso(row.last_run_at),
  lastStatus: row.last_status || "",
  lastError: row.last_error || "",
  lastSessionId: row.last_session_id || "",
  createdAt: iso(row.created_at),
  updatedAt: iso(row.updated_at),
});

export function createUserDataRepositories(store) {
  const settings = {
    async get(userId, key) {
      const { rows } = await store.query("select value from user_settings where user_id = $1 and key = $2", [userId, key]);
      return rows[0] ? jsonOut(rows[0].value) : undefined;
    },
    async set(userId, key, value, at = store.now().toISOString()) {
      await store.query(
        `insert into user_settings (user_id, key, value, updated_at) values ($1, $2, $3, $4)
         on conflict (user_id, key) do update set value = excluded.value, updated_at = excluded.updated_at`,
        [userId, key, JSON.stringify(value), at],
      );
      return value;
    },
    async list(userId) {
      const { rows } = await store.query("select key, value, updated_at from user_settings where user_id = $1 order by key", [userId]);
      return rows.map(row => ({ key: row.key, value: jsonOut(row.value), updatedAt: iso(row.updated_at) }));
    },
    async remove(userId, key) {
      const { rowCount } = await store.query("delete from user_settings where user_id = $1 and key = $2", [userId, key]);
      return rowCount > 0;
    },
  };

  const chat = {
    async createSession({ userId, title = "新对话", id = randomUUID(), at = store.now().toISOString() }) {
      const { rows } = await store.query(
        "insert into chat_sessions (id, user_id, title, created_at, updated_at) values ($1, $2, $3, $4, $4) returning *",
        [id, userId, String(title).slice(0, 80), at],
      );
      return sessionRow(rows[0]);
    },
    async listSessions(userId, { includeArchived = false } = {}) {
      const { rows } = await store.query(
        `select * from chat_sessions where user_id = $1 ${includeArchived ? "" : "and archived = false"} order by updated_at desc`,
        [userId],
      );
      return rows.map(sessionRow);
    },
    async getSession(userId, id) {
      const { rows } = await store.query("select * from chat_sessions where id = $1 and user_id = $2", [id, userId]);
      return rows[0] ? sessionRow(rows[0]) : null;
    },
    async renameSession(userId, id, title, at = store.now().toISOString()) {
      const { rowCount } = await store.query(
        "update chat_sessions set title = $3, updated_at = $4 where id = $1 and user_id = $2",
        [id, userId, String(title).slice(0, 80), at],
      );
      return rowCount > 0;
    },
    async archiveSession(userId, id, archived = true, at = store.now().toISOString()) {
      const { rowCount } = await store.query(
        "update chat_sessions set archived = $3, updated_at = $4 where id = $1 and user_id = $2",
        [id, userId, archived, at],
      );
      return rowCount > 0;
    },
    async deleteSession(userId, id) {
      const { rowCount } = await store.query("delete from chat_sessions where id = $1 and user_id = $2", [id, userId]);
      return rowCount > 0;
    },
    /** 追加消息：事务内取 max(seq)+1；并发撞到唯一索引时重试。 */
    async appendMessage({ sessionId, role, content, createdAt = store.now().toISOString() }) {
      for (let attempt = 0; attempt < 5; attempt += 1) {
        try { return await appendOnce(); } catch (error) { if (error.code !== "CONFLICT") throw error; }
      }
      throw Object.assign(new Error("消息写入冲突次数过多。"), { code: "CONFLICT" });
      async function appendOnce() { return store.transaction(async tx => {
        const { rows } = await tx.query("select coalesce(max(seq), 0) + 1 as next from chat_messages where session_id = $1", [sessionId]);
        const seq = Number(rows[0]?.next || 1);
        const { rows: inserted } = await tx.query(
          "insert into chat_messages (id, session_id, role, content, created_at, seq) values ($1, $2, $3, $4, $5, $6) returning *",
          [randomUUID(), sessionId, role, JSON.stringify(content), createdAt, seq],
        );
        await tx.query("update chat_sessions set updated_at = $2 where id = $1", [sessionId, createdAt]);
        return messageRow(inserted[0]);
      }); }
    },
    async countMessages(sessionId) {
      const { rows } = await store.query("select count(*) as total from chat_messages where session_id = $1", [sessionId]);
      return Number(rows[0]?.total || 0);
    },
    async listMessages(sessionId, { limit = 500, afterSeq = 0 } = {}) {
      const { rows } = await store.query(
        "select * from chat_messages where session_id = $1 and seq > $2 order by seq limit $3",
        [sessionId, afterSeq, Math.min(Math.max(Number(limit) || 500, 1), 2000)],
      );
      return rows.map(messageRow);
    },
  };

  const schedules = {
    async create({ userId, title, prompt, kind, spec, enabled = true, id = randomUUID(), at = store.now().toISOString() }) {
      const { rows } = await store.query(
        `insert into schedules (id, user_id, title, prompt, kind, spec, enabled, created_at, updated_at)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $8) returning *`,
        [id, userId, title, prompt, kind, JSON.stringify(spec || {}), enabled !== false, at],
      );
      return scheduleRow(rows[0]);
    },
    async list(userId) {
      const { rows } = await store.query("select * from schedules where user_id = $1 order by updated_at desc", [userId]);
      return rows.map(scheduleRow);
    },
    async get(userId, id) {
      const { rows } = await store.query("select * from schedules where id = $1 and user_id = $2", [id, userId]);
      return rows[0] ? scheduleRow(rows[0]) : null;
    },
    async update(userId, id, patch = {}, at = store.now().toISOString()) {
      const current = await schedules.get(userId, id);
      if (!current) return null;
      const next = {
        title: patch.title ?? current.title,
        prompt: patch.prompt ?? current.prompt,
        kind: patch.kind ?? current.kind,
        spec: patch.spec ?? current.spec,
        enabled: patch.enabled ?? current.enabled,
      };
      const { rows } = await store.query(
        `update schedules set title = $3, prompt = $4, kind = $5, spec = $6, enabled = $7, updated_at = $8
         where id = $1 and user_id = $2 returning *`,
        [id, userId, next.title, next.prompt, next.kind, JSON.stringify(next.spec), next.enabled !== false, at],
      );
      return rows[0] ? scheduleRow(rows[0]) : null;
    },
    async remove(userId, id) {
      const { rowCount } = await store.query("delete from schedules where id = $1 and user_id = $2", [id, userId]);
      return rowCount > 0;
    },
    async finish(userId, id, { ok = true, sessionId = "", error = "", at = store.now().toISOString() } = {}) {
      const current = await schedules.get(userId, id);
      if (!current) return null;
      const disabled = current.kind === "once" ? false : current.enabled;
      await store.query(
        "update schedules set last_run_at = $3, last_status = $4, last_error = $5, last_session_id = $6, enabled = $7 where id = $1 and user_id = $2",
        [id, userId, at, ok ? "succeeded" : "failed", String(error || "").slice(0, 300), sessionId, disabled],
      );
      return await schedules.get(userId, id);
    },
    async recordRun(userId, id, { at = store.now().toISOString(), status = "", error = "" } = {}) {
      const { rowCount } = await store.query(
        "update schedules set last_run_at = $3, last_status = $4, last_error = $5 where id = $1 and user_id = $2",
        [id, userId, at, status, error],
      );
      return rowCount > 0;
    },
  };

  const config = {
    async get(key) {
      const { rows } = await store.query("select ciphertext, nonce from app_config where key = $1", [key]);
      return rows[0] || null;
    },
    async put(key, { ciphertext, nonce }) {
      await store.query(
        `insert into app_config (key, ciphertext, nonce, updated_at) values ($1, $2, $3, $4)
         on conflict (key) do update set ciphertext = excluded.ciphertext, nonce = excluded.nonce, updated_at = excluded.updated_at`,
        [key, ciphertext, nonce, store.now().toISOString()],
      );
    },
    async remove(key) {
      return (await store.query("delete from app_config where key = $1", [key])).rowCount > 0;
    },
  };

  const credentials = {
    async put({ userId, service, ciphertext, nonce, at = store.now().toISOString() }) {
      await store.query(
        `insert into service_credentials (user_id, service, ciphertext, nonce, updated_at) values ($1, $2, $3, $4, $5)
         on conflict (user_id, service) do update set ciphertext = excluded.ciphertext, nonce = excluded.nonce, updated_at = excluded.updated_at`,
        [userId, service, ciphertext, nonce, at],
      );
    },
    async get(userId, service) {
      const { rows } = await store.query("select ciphertext, nonce, updated_at from service_credentials where user_id = $1 and service = $2", [userId, service]);
      return rows[0] ? { ciphertext: rows[0].ciphertext, nonce: rows[0].nonce, updatedAt: iso(rows[0].updated_at) } : null;
    },
    async list(userId) {
      const { rows } = await store.query("select service, updated_at from service_credentials where user_id = $1 order by service", [userId]);
      return rows.map(row => ({ service: row.service, updatedAt: iso(row.updated_at) }));
    },
    async remove(userId, service) {
      const { rowCount } = await store.query("delete from service_credentials where user_id = $1 and service = $2", [userId, service]);
      return rowCount > 0;
    },
  };

  return { settings, config, chat, schedules, credentials };
}