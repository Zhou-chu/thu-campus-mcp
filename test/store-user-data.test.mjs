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

test("定时任务执行结果：单次任务自动停用，每周任务保持启用", async () => {
  const { repos, user } = await boot();
  const onceTask = await repos.schedules.create({ userId: user.id, title: "一次", prompt: "x", kind: "once", spec: { at: "2026-12-01T00:00:00.000Z" } });
  const finished = await repos.schedules.finish(user.id, onceTask.id, { ok: true, sessionId: "s-1" });
  assert.equal(finished.lastStatus, "succeeded");
  assert.equal(finished.lastSessionId, "s-1");
  assert.equal(finished.enabled, false, "单次任务执行后停用");
  const weekly = await repos.schedules.create({ userId: user.id, title: "每周", prompt: "x", kind: "weekly", spec: { time: "08:00", days: [1] } });
  const kept = await repos.schedules.finish(user.id, weekly.id, { ok: false, error: "失败" });
  assert.equal(kept.lastStatus, "failed");
  assert.equal(kept.lastError, "失败");
  assert.equal(kept.enabled, true, "每周任务继续启用");
  assert.equal(await repos.schedules.finish("other", weekly.id, { ok: true }), null);
});

test("并发追加消息：序号不重复、不丢消息", async () => {
  const { repos, user } = await boot();
  const session = await repos.chat.createSession({ userId: user.id, title: "并发" });
  const results = await Promise.all(Array.from({ length: 5 }, (_, index) => repos.chat.appendMessage({ sessionId: session.id, role: "user", content: { text: "m" + index } })));
  const seqs = results.map(message => message.seq).sort((a, b) => a - b);
  assert.deepEqual(seqs, [1, 2, 3, 4, 5]);
  assert.equal((await repos.chat.listMessages(session.id)).length, 5);
});

test("同一会话的 seq 唯一：重复序号被数据库拒绝", async () => {
  const { store, repos, user } = await boot();
  const session = await repos.chat.createSession({ userId: user.id, title: "seq" });
  await repos.chat.appendMessage({ sessionId: session.id, role: "user", content: { text: "一" } });
  await assert.rejects(() => store.query(
    "insert into chat_messages (id, session_id, role, content, created_at, seq) values ($1, $2, $3, $4, $5, $6)",
    ["manual", session.id, "user", "{}", "2026-11-23T00:00:00.000Z", 1],
  ), (error) => error.code === "CONFLICT");
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