import assert from "node:assert/strict";
import test from "node:test";
import { newDb } from "pg-mem";
import { createPgStore } from "../lib/store/pg.mjs";
import { createAuthRepositories } from "../lib/store/auth-repo.mjs";
import { createUserDataRepositories } from "../lib/store/user-data-repo.mjs";
import { createChangeLog } from "../lib/store/changes-repo.mjs";
import { createSessionRouter } from "../lib/app/session-router.mjs";

function fileStore() {
  const sessions = new Map();
  return {
    calls: 0,
    async create({ title } = {}) { this.calls += 1; const session = { id: "file-1", title: title || "新对话", createdAt: "x", updatedAt: "x", messages: [] }; sessions.set(session.id, session); return { ...session }; },
    async get(id) { this.calls += 1; return sessions.get(id); },
    async list() { this.calls += 1; return [...sessions.values()]; },
    async append() { this.calls += 1; },
    async rename() { this.calls += 1; },
    async remove() { this.calls += 1; },
  };
}

async function database() {
  const db = newDb({ autoCreateForeignKeyIndices: true });
  const store = createPgStore({ pool: new (db.adapters.createPg().Pool)() });
  await store.migrate();
  const auth = createAuthRepositories(store);
  const repos = { ...auth, ...createUserDataRepositories(store), changes: createChangeLog(store) };
  return { store, repos, users: auth.users };
}

test("没有数据库时退回文件会话存储", async () => {
  const file = fileStore();
  const router = createSessionRouter({ store: null, fileSessions: file });
  await router.create({ title: "文件" });
  assert.equal(file.calls, 1);
});

test("有数据库且有账号时切到 PostgreSQL，并缓存账号查询", async () => {
  const { store, users, repos } = await database();
  const user = await users.create({ email: "router@mails.tsinghua.edu.cn", passwordHash: "hash" });
  const file = fileStore();
  let asks = 0;
  const counting = { repos: { ...repos, users: { async first() { asks += 1; return user; } } } };
  const router = createSessionRouter({ store: counting, fileSessions: file });
  const created = await router.create({ title: "库" });
  assert.ok(created.id);
  assert.equal((await router.list()).length, 1);
  assert.equal(asks, 1, "缓存期内只查一次账号");
  assert.equal(file.calls, 0);
  assert.equal(await router.get(created.id).then(item => item.title), "库");
  assert.ok(store);
});

test("数据库报错时退回文件存储，不阻塞登录前的会话", async () => {
  const file = fileStore();
  const router = createSessionRouter({ store: { repos: { users: { async first() { throw new Error("db down"); } } } }, fileSessions: file });
  const created = await router.create({ title: "兜底" });
  assert.equal(created.id, "file-1");
  assert.equal(file.calls, 1);
});