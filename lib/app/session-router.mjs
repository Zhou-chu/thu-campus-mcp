/**
 * 会话存储选择器：有数据库且已有本机账号时走 PostgreSQL，否则退回文件存储。
 *
 * 登录前没有用户，文件存储仍可用；登录后后续会话进库，多设备指向同一库即可共享。
 * 每次切换会短暂缓存，避免每个请求都查一次 users 表。
 */
import { createPgSessionStore } from "./pg-sessions.mjs";

export function createSessionRouter({ store = null, fileSessions, cacheMs = 2000, now = () => Date.now() }) {
  if (!fileSessions) throw new TypeError("createSessionRouter 需要文件会话存储");
  let cachedAt = -Infinity;
  let cached = null;

  async function backend() {
    if (!store) return fileSessions;
    if (now() - cachedAt < cacheMs) return cached || fileSessions;
    let user = null;
    try {
      user = await store.repos.users.first();
    } catch {
      user = null;
    }
    cached = user ? createPgSessionStore({ repos: store.repos, userId: user.id }) : null;
    cachedAt = now();
    return cached || fileSessions;
  }

  return {
    async create(options) { return (await backend()).create(options); },
    async get(id) { return (await backend()).get(id); },
    async list() { return (await backend()).list(); },
    async append(id, messages, options) { return (await backend()).append(id, messages, options); },
    async rename(id, title) { return (await backend()).rename(id, title); },
    async remove(id) { return (await backend()).remove(id); },
  };
}