import path from "node:path";
import { randomUUID } from "node:crypto";
import { readdir, readFile, rm } from "node:fs/promises";
import { atomic, directory } from "../../packages/browser/core.mjs";
const ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MAX_MESSAGES = 400;
export function validSessionId(id) {
  return typeof id === "string" && ID_PATTERN.test(id);
}
function summarize(session) {
  return {
    id: session.id,
    title: session.title,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    messageCount: session.messages.length,
  };
}
/** 会话落盘：一条会话一个 JSON 文件，目录受 stateDir 约束。 */
export class SessionStore {
  constructor(stateDir, { maxMessages = MAX_MESSAGES } = {}) {
    this.dir = path.join(stateDir, "sessions");
    this.maxMessages = maxMessages;
    this.cache = new Map();
  }
  file(id) {
    if (!validSessionId(id)) throw Object.assign(new Error("会话 ID 不合法。"), { code: "INVALID_SESSION" });
    return path.join(this.dir, id + ".json");
  }
  async load(id) {
    if (this.cache.has(id)) return this.cache.get(id);
    let raw;
    try {
      raw = await readFile(this.file(id), "utf8");
    } catch (e) {
      if (e.code === "ENOENT") return undefined;
      throw e;
    }
    const session = JSON.parse(raw);
    session.messages = Array.isArray(session.messages) ? session.messages : [];
    this.cache.set(id, session);
    return session;
  }
  async save(session) {
    session.updatedAt = new Date().toISOString();
    if (session.messages.length > this.maxMessages)
      session.messages = session.messages.slice(-this.maxMessages);
    await atomic(this.file(session.id), Buffer.from(JSON.stringify(session)));
    this.cache.set(session.id, session);
    return session;
  }
  async create({ title } = {}) {
    await directory(this.dir);
    const at = new Date().toISOString();
    return this.save({
      id: randomUUID(),
      title: String(title || "新对话").slice(0, 80),
      createdAt: at,
      updatedAt: at,
      messages: [],
    }).then(summarize);
  }
  async get(id) {
    const session = await this.load(id);
    return session ? { ...session, messages: [...session.messages] } : undefined;
  }
  async list() {
    await directory(this.dir);
    const files = (await readdir(this.dir)).filter((f) => f.endsWith(".json"));
    const sessions = [];
    for (const file of files) {
      const id = file.slice(0, -5);
      if (!validSessionId(id)) continue;
      const session = await this.load(id).catch(() => undefined);
      if (session) sessions.push(summarize(session));
    }
    return sessions.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  }
  async append(id, messages, { title } = {}) {
    const session = await this.load(id);
    if (!session) throw Object.assign(new Error("会话不存在。"), { code: "SESSION_NOT_FOUND" });
    session.messages.push(...messages);
    if (title && session.title === "新对话") session.title = String(title).slice(0, 80);
    await this.save(session);
    return session;
  }
  async remove(id) {
    await directory(this.dir);
    this.cache.delete(id);
    try {
      await rm(this.file(id));
      return true;
    } catch (e) {
      if (e.code === "ENOENT") return false;
      throw e;
    }
  }
}