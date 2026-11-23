/**
 * 用 PostgreSQL 仓库实现聊天会话存储（与 lib/app/sessions.mjs 的接口一致）。
 *
 * 单实例运行时对应“本机账号”；多设备共享时各实例指向同一个库，
 * 因此同一账号在两台设备上看到的是同一份会话。每次写入同时追加变更日志，
 * 供 #96 的增量拉取使用。
 */
import { randomUUID } from "node:crypto";


const summaryOf = (session, messageCount) => ({
  id: session.id,
  title: session.title,
  createdAt: session.createdAt,
  updatedAt: session.updatedAt,
  messageCount,
});

function messageContent(message) {
  const { role, createdAt, ...content } = message;
  return content;
}

export function createPgSessionStore({ repos, userId, maxMessages = 200, now = () => new Date() }) {
  if (!repos || !userId) throw new TypeError("createPgSessionStore 需要 repos 与 userId");

  async function load(id) {
    const session = await repos.chat.getSession(userId, id);
    if (!session) return undefined;
    const rows = await repos.chat.listMessages(id, { limit: maxMessages });
    return {
      id: session.id,
      title: session.title,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      messages: rows.map(row => ({ role: row.role, ...row.content })),
    };
  }

  async function record(entity, entityId, op, payload = null) {
    try {
      await repos.changes.append({ userId, entity, entityId, op, payload });
    } catch {
      // 变更日志失败不能回滚已经完成的用户可见写入；同步方会按最新快照对齐。
    }
  }

  return {
    async create({ title } = {}) {
      const at = now().toISOString();
      const session = await repos.chat.createSession({ userId, id: randomUUID(), title: String(title || "新对话").slice(0, 80), at });
      await record("chat_session", session.id, "create", { title: session.title });
      return summaryOf(session, 0);
    },
    async get(id) {
      return await load(id);
    },
    async list() {
      const sessions = await repos.chat.listSessions(userId);
      const out = [];
      for (const session of sessions) out.push(summaryOf(session, await repos.chat.countMessages(session.id)));
      return out;
    },
    async append(id, messages, { title } = {}) {
      const session = await load(id);
      if (!session) throw Object.assign(new Error("会话不存在。"), { code: "SESSION_NOT_FOUND" });
      for (const message of messages) {
        if (!message || typeof message.role !== "string") continue;
        await repos.chat.appendMessage({
          sessionId: id,
          role: message.role,
          content: messageContent(message),
          createdAt: typeof message.createdAt === "string" ? message.createdAt : now().toISOString(),
        });
        await record("chat_message", id, "append", { role: message.role });
      }
      if (title && session.title === "新对话") {
        await repos.chat.renameSession(userId, id, String(title).slice(0, 80));
      }
      return await load(id);
    },
    async rename(id, title) {
      const name = String(title || "").trim();
      if (!name) throw Object.assign(new Error("标题不能为空。"), { code: "INVALID_ARGUMENTS" });
      if (name.length > 80) throw Object.assign(new Error("标题最多 80 个字符。"), { code: INVALID_ARGUMENTS });
      const changed = await repos.chat.renameSession(userId, id, name);
      if (!changed) return undefined;
      await record("chat_session", id, "rename", { title: name });
      const session = await repos.chat.getSession(userId, id);
      return summaryOf(session, await repos.chat.countMessages(id));
    },
    async remove(id) {
      const removed = await repos.chat.deleteSession(userId, id);
      if (removed) await record("chat_session", id, "remove");
      return removed;
    },
  };
}