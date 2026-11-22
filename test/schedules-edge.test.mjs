import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ScheduleStore, describeSchedule, lastOccurrence, nextRunAt } from "../lib/app/schedules.mjs";
import { createScheduleRunner } from "../lib/app/schedule-runner.mjs";
import { createScheduleTools } from "../lib/app/schedule-tools.mjs";

async function withStore(run) {
  const dir = await mkdtemp(path.join(tmpdir(), "sched-edge-"));
  try {
    let nowMs = new Date(2026, 10, 22, 10, 0, 0, 0).getTime();
    const store = new ScheduleStore(dir, { now: () => new Date(nowMs) });
    return await run({ store, advance: ms => { nowMs += ms; }, dir });
  } finally {
    // Windows 上执行器可能仍在写文件；短暂重试，避免 ENOTEMPTY 假失败。
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try { await rm(dir, { recursive: true, force: true }); break; }
      catch (error) { if (attempt === 4 || error?.code !== "ENOTEMPTY") throw error; await new Promise(resolve => setTimeout(resolve, 50)); }
    }
  }
}

test("周任务的描述与最近一次发生时间", () => {
  const weekly = { kind: "weekly", time: "19:00", days: [5], enabled: true };
  assert.equal(describeSchedule(weekly, new Date(2026, 10, 22, 10, 0)).when, "每周 五 19:00");
  // 2026-11-20 是周五 19:00，最近一次已经发生。
  assert.equal(lastOccurrence(weekly, new Date(2026, 10, 22, 10, 0)), new Date(2026, 10, 20, 19, 0).getTime());
  assert.equal(lastOccurrence({ ...weekly, enabled: false }, new Date(2026, 10, 22, 10, 0)), null);
  assert.equal(lastOccurrence({ kind: "once", at: "2026-12-01T08:00:00+09:00", enabled: true }, new Date(2026, 10, 22, 10, 0)), null, "未来单次任务不该被判定为已到点");
  assert.equal(lastOccurrence({ kind: "daily", time: "bad", enabled: true }, new Date()), null);
});

test("更新计划时保留未提供的字段，并拒绝非法补丁", async () => {
  await withStore(async ({ store }) => {
    const task = await store.create({ title: "初始", prompt: "p", kind: "daily", time: "08:00" });
    const renamed = await store.update(task.id, { title: "改名" });
    assert.equal(renamed.title, "改名");
    assert.equal(renamed.prompt, "p");
    assert.equal(renamed.time, "08:00");

    await assert.rejects(() => store.update(task.id, { time: "25:00" }), /时间格式/);
    await assert.rejects(() => store.update(task.id, { kind: "hourly" }), /任务类型/);
    assert.equal(await store.update("00000000-0000-4000-8000-000000000000", { title: "x" }), undefined);
    assert.equal(await store.finish("00000000-0000-4000-8000-000000000000"), undefined);
  });
});

test("执行器启动、停止与重复 tick 防重入", async () => {
  await withStore(async ({ store, advance }) => {
    await store.create({ title: "启动", prompt: "x", kind: "once", at: "2026-11-22 10:05" });
    let resolveTurn;
    const runner = createScheduleRunner({
      store,
      sessions: { async create() { return { id: "s" }; } },
      runTurn: () => new Promise(resolve => { resolveTurn = resolve; }),
      intervalMs: 5,
    });
    assert.equal(runner.status().running, false);
    advance(10 * 60_000);
    const first = runner.tick();
    const second = runner.tick();
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(typeof resolveTurn, "function", "第一轮已进入模型调用");
    assert.equal(runner.status().ticks, 1, "重入时第二次 tick 直接返回");
    resolveTurn();
    await Promise.all([first, second]);
    assert.equal((await store.list())[0].lastStatus, "failed", "没有助手内容时记为失败");
    runner.start();
    assert.equal(runner.status().running, true);
    runner.stop();
    assert.equal(runner.status().running, false);
    runner.stop();
  });
});

test("执行器记录检查异常并继续服务", async () => {
  await withStore(async ({ store }) => {
    const runner = createScheduleRunner({
      store: { async due() { throw new Error("磁盘只读"); } },
      sessions: { async create() { return { id: "s" }; } },
      runTurn: async () => {},
    });
    await runner.tick();
    assert.match(runner.status().lastError, /磁盘只读/);
    assert.equal(runner.status().running, false);
  });
});

test("定时工具拒绝未知工具与空 ID", async () => {
  await withStore(async ({ store }) => {
    const tools = createScheduleTools({ store });
    assert.equal((await tools.call("schedule_unknown", {})).error.code, "UNKNOWN_TOOL");
    assert.equal((await tools.call("schedule_update", {})).error.code, "INVALID_ARGUMENTS");
    assert.equal((await tools.call("schedule_delete", { id: "" })).error.code, "INVALID_ARGUMENTS");
    assert.equal((await tools.call("schedule_update", { id: "missing", title: "x" })).error.code, "SCHEDULE_NOT_FOUND");
    assert.equal((await tools.call("schedule_create", { title: "t", prompt: "p", kind: "weekly", time: "08:00", days: [] })).error.code, "INVALID_ARGUMENTS");
  });
});
test("执行器 start 会立即检查一次，并在 stop 后不再触发", async () => {
  await withStore(async ({ store }) => {
    let dueCalls = 0;
    const runner = createScheduleRunner({
      store: { async due() { dueCalls += 1; return []; } },
      sessions: { async create() { return { id: "s" }; } },
      runTurn: async () => {},
      intervalMs: 100000,
    });
    runner.start();
    await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(dueCalls, 1, "start 时立即检查一次");
    runner.stop();
    await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(dueCalls, 1, "停止后不再检查");
    assert.notEqual(runner.status().startedAt, null);
  });
});

test("describeSchedule 覆盖三种频率，坏数据不抛错", async () => {
  await withStore(async ({ store }) => {
    const daily = await store.create({ title: "每天", prompt: "p", kind: "daily", time: "07:15" });
    assert.match(describeSchedule(daily, new Date()).when, /每天 07:15/);
    const once = await store.create({ title: "一次", prompt: "p", kind: "once", at: new Date(Date.now() + 86400000).toISOString() });
    assert.equal(describeSchedule(once, new Date()).when, once.at, "单次任务的 when 就是定点时间");
    assert.equal(nextRunAt({ kind: "daily", time: "bad", enabled: true }), null);
    assert.equal(lastOccurrence({ kind: "once", at: "not-a-date", enabled: true }), null);
  });
});

test("损坏的计划文件按空计划处理，不阻塞应用", async () => {
  await withStore(async ({ dir }) => {
    const { writeFile } = await import("node:fs/promises");
    await writeFile(path.join(dir, "schedules.json"), "{broken", "utf8");
    const store = new ScheduleStore(dir);
    assert.deepEqual(await store.list(), []);
  });
});
