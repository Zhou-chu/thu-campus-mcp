import assert from "node:assert/strict";
import test from "node:test";
import { newDb } from "pg-mem";
import { createPgStore } from "../lib/store/pg.mjs";
import { createAuthRepositories } from "../lib/store/auth-repo.mjs";
import { createUserDataRepositories } from "../lib/store/user-data-repo.mjs";
import { createChangeLog } from "../lib/store/changes-repo.mjs";
import { createPgScheduleStore } from "../lib/app/pg-schedules.mjs";
import { createScheduleRouter } from "../lib/app/schedule-router.mjs";
import { createScheduleRunner } from "../lib/app/schedule-runner.mjs";

async function boot() {
  const db = newDb({ autoCreateForeignKeyIndices: true });
  const store = createPgStore({ pool: new (db.adapters.createPg().Pool)() });
  await store.migrate();
  const auth = createAuthRepositories(store);
  const user = await auth.users.create({ email: "sched@mails.tsinghua.edu.cn", passwordHash: "hash" });
  const other = await auth.users.create({ email: "sched2@mails.tsinghua.edu.cn", passwordHash: "hash" });
  const repos = { ...auth, ...createUserDataRepositories(store), changes: createChangeLog(store) };
  return { store, repos, user, other };
}

const at = "2026-12-01T00:00:00.000Z";
const now = () => new Date("2026-11-23T00:00:00.000Z");

test("定时任务适配器：创建、改名、执行完成与删除，用户隔离", async () => {
  const { repos, user, other } = await boot();
  const mine = createPgScheduleStore({ repos, userId: user.id, now });
  const theirs = createPgScheduleStore({ repos, userId: other.id, now });

  const once = await mine.create({ title: "一次性", prompt: "x", kind: "once", at });
  assert.equal(once.kind, "once");
  assert.equal(once.enabled, true);
  assert.ok(once.nextRunAt, "给出下一次执行时间");
  assert.equal((await theirs.list()).length, 0);
  assert.equal(await theirs.get(once.id), undefined);

  const weekly = await mine.create({ title: "每周", prompt: "y", kind: "weekly", time: "08:00", days: [1, 3] });
  assert.deepEqual(weekly.days, [1, 3]);
  const updated = await mine.update(weekly.id, { time: "09:30" });
  assert.equal(updated.time, "09:30");
  assert.equal(await theirs.update(weekly.id, { time: "10:00" }), undefined, "别人的任务改不了");

  const finished = await mine.finish(once.id, { ok: true, sessionId: "s-1" });
  assert.equal(finished.lastStatus, "succeeded");
  assert.equal(finished.lastSessionId, "s-1");
  assert.equal(finished.enabled, false, "单次任务执行后停用");
  const failed = await mine.finish(weekly.id, { ok: false, error: "网络失败" });
  assert.equal(failed.lastStatus, "failed");
  assert.equal(failed.lastError, "网络失败");
  assert.equal(failed.enabled, true);

  assert.equal(await mine.remove(weekly.id), true);
  assert.equal((await mine.list()).length, 1, "停用的单次任务仍保留");
  assert.equal(await mine.remove(once.id), true);
  assert.equal((await mine.list()).length, 0);
  await assert.rejects(() => mine.create({ title: "", prompt: "x", kind: "daily", time: "08:00" }), (error) => error.code === "INVALID_ARGUMENTS");
});

test("抢占同一周期：第二个执行器拿不到任务", async () => {
  const { repos, user } = await boot();
  const due = await repos.schedules.create({ userId: user.id, title: "一次", prompt: "x", kind: "daily", spec: { time: "08:00" }, at: "2026-11-20T00:00:00.000Z" });
  assert.equal(await repos.schedules.claim(user.id, due.id, "2026-11-23T08:00:00.000Z"), true);
  assert.equal(await repos.schedules.claim(user.id, due.id, "2026-11-23T08:00:00.000Z"), false, "同一周期只能被一个执行器抢到");
});

test("不同字段的并发更新都保留，同字段按最后写入", async () => {
  const { repos, user } = await boot();
  const task = await repos.schedules.create({ userId: user.id, title: "old", prompt: "old prompt", kind: "daily", spec: { time: "08:00" } });
  await repos.schedules.update(user.id, task.id, { title: "new title" });
  const afterPrompt = await repos.schedules.update(user.id, task.id, { prompt: "new prompt" });
  assert.equal(afterPrompt.title, "new title");
  assert.equal(afterPrompt.prompt, "new prompt");
  const afterTitle = await repos.schedules.update(user.id, task.id, { title: "final title" });
  assert.equal(afterTitle.title, "final title");
  assert.equal(afterTitle.prompt, "new prompt");
});

test("两个执行器同时检查到期：同一周期只运行一次", async () => {
  const { repos, user } = await boot();
  const late = () => new Date("2026-11-23T09:00:00.000Z");
  await repos.schedules.create({ userId: user.id, title: "到期", prompt: "x", kind: "daily", spec: { time: "08:00" }, at: "2026-11-20T00:00:00.000Z" });
  let calls = 0;
  const make = () => createScheduleRunner({
    store: createScheduleRouter({ store: { repos }, fileStore: { due: async () => [] }, userId: () => null, now: late }),
    sessions: { create: async () => ({ id: "s-" + (++calls) }) },
    runTurn: async () => { await new Promise(resolve => setTimeout(resolve, 10)); return { aborted: false }; },
  });
  await Promise.all([make().tick(), make().tick()]);
  assert.equal(calls, 1, "并发执行器只应启动一次");
});

test("选择器：未登录走文件存储，登录后按用户走数据库", async () => {
  const { repos, user } = await boot();
  const fileTasks = { list: async () => [{ id: "file-1", title: "文件" }], due: async () => [] };
  let uid = null;
  const router = createScheduleRouter({ store: { repos }, fileStore: fileTasks, userId: () => uid, now });
  assert.deepEqual((await router.list()).map(item => item.id), ["file-1"]);
  uid = user.id;
  const created = await router.create({ title: "库", prompt: "x", kind: "daily", time: "08:00" });
  assert.equal((await router.list()).length, 1);
  assert.equal((await router.list())[0].id, created.id);
});

test("执行器视图：跨账号返回到期任务，并能按属主写回执行结果", async () => {
  const { repos, user, other } = await boot();
  const late = () => new Date("2026-11-23T09:00:00.000Z");
  const router = createScheduleRouter({ store: { repos }, fileStore: { due: async () => [] }, userId: () => null, now: late });
  const a = createPgScheduleStore({ repos, userId: user.id, now: late });
  const b = createPgScheduleStore({ repos, userId: other.id, now: late });
  const dueTask = await repos.schedules.create({ userId: user.id, title: "到期", prompt: "x", kind: "daily", spec: { time: "08:00" }, at: "2026-11-20T00:00:00.000Z" });
  const future = await b.create({ title: "未来", prompt: "y", kind: "once", at: "2026-12-01T00:00:00.000Z" });

  const due = await router.dueForRunner();
  assert.ok(due.some(task => task.id === dueTask.id && task.userId === user.id));
  assert.ok(!due.some(task => task.id === future.id), "未到期任务不执行");

  await router.finish(dueTask.id, { ok: true, sessionId: "s-2" });
  const after = await a.get(dueTask.id);
  assert.equal(after.lastSessionId, "s-2");
});