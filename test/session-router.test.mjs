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

test("已登录用户走 PostgreSQL，并按用户隔离", async () => {
  const { store, users, repos } = await database();
  const user = await users.create({ email: "router@mails.tsinghua.edu.cn", passwordHash: "hash" });
  const other = await users.create({ email: "router2@mails.tsinghua.edu.cn", passwordHash: "hash" });
  const file = fileStore();
  const router = createSessionRouter({ store: { repos }, fileSessions: file, userId: () => user.id });
  const created = await router.create({ title: "库" });
  assert.ok(created.id);
  assert.equal((await router.list()).length, 1);
  assert.equal(file.calls, 0);
  assert.equal(await router.get(created.id).then(item => item.title), "库");

  const otherRouter = createSessionRouter({ store: { repos }, fileSessions: file, userId: () => other.id });
  assert.equal((await otherRouter.list()).length, 0, "看不到别人的会话");
  assert.ok(store);
});

test("未登录（没有请求用户）时继续用文件存储", async () => {
  const { repos } = await database();
  const file = fileStore();
  const router = createSessionRouter({ store: { repos }, fileSessions: file, userId: () => null });
  const created = await router.create({ title: "兜底" });
  assert.equal(created.id, "file-1");
  assert.equal(file.calls, 1);
});