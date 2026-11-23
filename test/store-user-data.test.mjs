import assert from "node:assert/strict";
import test from "node:test";
import { newDb } from "pg-mem";
import { createPgStore } from "../lib/store/pg.mjs";
import { createUserDataRepositories } from "../lib/store/user-data-repo.mjs";
import { createAuthRepositories } from "../lib/store/auth-repo.mjs";

async function boot() {
  const db = newDb({ autoCreateForeignKeyIndices: true });
  const store = createPgStore({ pool: new (db.adapters.createPg().Pool)() });
  await store.migrate();
  const authRepos = createAuthRepositories(store);
  const user = await authRepos.users.create({ email: "data@mails.tsinghua.edu.cn", passwordHash: "hash" });
  const other = await authRepos.users.create({ email: "other@mails.tsinghua.edu.cn", passwordHash: "hash" });
  return { store, user, other, repos: createUserDataRepositories(store) };
}

test("用户设置：写入、覆盖、读取与删除", async () => {
  const { repos, user, other } = await boot();
  await repos.settings.set(user.id, "theme", "dark");
  await repos.settings.set(user.id, "model", { name: "qwen", effort: "high" });
  assert.equal(await repos.settings.get(user.id, "theme"), "dark");
  assert.deepEqual(await repos.settings.get(user.id, "model"), { name: "qwen", effort: "high" });
  await repos.settings.set(user.id, "theme", "light");
  assert.equal(await repos.settings.get(user.id, "theme"), "light");
  const list = await repos.settings.list(user.id);
  assert.deepEqual(list.map(item => item.key), ["model", "theme"]);
  assert.equal(await repos.settings.get(other.id, "theme"), undefined);
  assert.equal(await repos.settings.remove(user.id, "theme"), true);
  assert.equal(await repos.settings.get(user.id, "theme"), undefined);
  assert.equal(await repos.settings.remove(user.id, "theme"), false);
});

test("会话与消息：归属校验、seq 递增、改名归档与级联删除", async () => {
  const { repos, user, other } = await boot();
  const first = await repos.chat.createSession({ userId: user.id, title: "第一段" });
  assert.equal(first.title, "第一段");
  assert.equal((await repos.chat.listSessions(user.id)).length, 1);
  assert.equal(await repos.chat.getSession(other.id, first.id), null, "别人的会话读不到");
  assert.equal(await repos.chat.renameSession(other.id, first.id, "劫持"), false);

  const one = await repos.chat.appendMessage({ sessionId: first.id, role: "user", content: { text: "你好" } });
  const two = await repos.chat.appendMessage({ sessionId: first.id, role: "assistant", content: { text: "在" } });
  assert.equal(one.seq, 1);
  assert.equal(two.seq, 2);
  assert.deepEqual(two.content, { text: "在" });
  const tail = await repos.chat.listMessages(first.id, { afterSeq: 1 });
  assert.deepEqual(tail.map(item => item.seq), [2]);

  assert.equal(await repos.chat.renameSession(user.id, first.id, "改名"), true);
  assert.equal((await repos.chat.getSession(user.id, first.id)).title, "改名");
  assert.equal(await repos.chat.archiveSession(user.id, first.id, true), true);
  assert.equal((await repos.chat.listSessions(user.id)).length, 0);
  assert.equal((await repos.chat.listSessions(user.id, { includeArchived: true })).length, 1);

  assert.equal(await repos.chat.deleteSession(user.id, first.id), true);
  assert.equal((await repos.chat.listMessages(first.id)).length, 0, "删会话级联删消息");
  assert.equal(await repos.chat.deleteSession(user.id, first.id), false);
});

test("定时任务：创建、更新、记录执行与删除", async () => {
  const { repos, user, other } = await boot();
  const task = await repos.schedules.create({ userId: user.id, title: "晨报", prompt: "总结", kind: "daily", spec: { time: "08:00" } });
  assert.equal(task.kind, "daily");
  assert.deepEqual(task.spec, { time: "08:00" });
  assert.equal(await repos.schedules.get(other.id, task.id), null);

  const updated = await repos.schedules.update(user.id, task.id, { enabled: false, spec: { time: "09:30" } });
  assert.equal(updated.enabled, false);
  assert.deepEqual(updated.spec, { time: "09:30" });
  assert.equal(await repos.schedules.update(other.id, task.id, { title: "x" }), null);

  assert.equal(await repos.schedules.recordRun(user.id, task.id, { status: "ok" }), true);
  const after = await repos.schedules.get(user.id, task.id);
  assert.equal(after.lastStatus, "ok");
  assert.ok(after.lastRunAt, "记录最近执行时间");
  assert.deepEqual((await repos.schedules.list(user.id)).map(item => item.id), [task.id]);

  assert.equal(await repos.schedules.remove(user.id, task.id), true);
  assert.equal(await repos.schedules.get(user.id, task.id), null);
});

test("服务凭据：只存密文与 nonce，按用户隔离", async () => {
  const { repos, user, other } = await boot();
  await repos.credentials.put({ userId: user.id, service: "learnx", ciphertext: "cipher", nonce: "nonce" });
  assert.deepEqual(await repos.credentials.get(user.id, "learnx"), { ciphertext: "cipher", nonce: "nonce", updatedAt: await repos.credentials.get(user.id, "learnx").then(item => item.updatedAt) });
  await repos.credentials.put({ userId: user.id, service: "learnx", ciphertext: "cipher2", nonce: "nonce2" });
  assert.equal((await repos.credentials.get(user.id, "learnx")).ciphertext, "cipher2");
  assert.equal(await repos.credentials.get(other.id, "learnx"), null);
  assert.deepEqual((await repos.credentials.list(user.id)).map(item => item.service), ["learnx"]);
  assert.equal(await repos.credentials.remove(user.id, "learnx"), true);
  assert.equal(await repos.credentials.get(user.id, "learnx"), null);
});