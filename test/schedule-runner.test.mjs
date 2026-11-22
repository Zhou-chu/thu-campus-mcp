import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ScheduleStore } from "../lib/app/schedules.mjs";
import { createScheduleRunner } from "../lib/app/schedule-runner.mjs";
import { createScheduleTools, withScheduleTools } from "../lib/app/schedule-tools.mjs";

async function withStore(run) {
  const dir = await mkdtemp(path.join(tmpdir(), "runner-"));
  try {
    let nowMs = new Date(2026, 10, 22, 10, 0, 0, 0).getTime();
    const store = new ScheduleStore(dir, { now: () => new Date(nowMs) });
    return await run({ store, advance: ms => { nowMs += ms; } });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("到点任务会新建会话并跑一轮，成功后记录会话与状态", async () => {
  await withStore(async ({ store, advance }) => {
    const created = await store.create({ title: "早报", prompt: "汇总今天的作业", kind: "once", at: "2026-11-22 10:30" });
    const sessions = { created: [], async create({ title }) { const item = { id: "sess-" + (this.created.length + 1), title }; this.created.push(item); return item; } };
    const turns = [];
    const runner = createScheduleRunner({
      store, sessions,
      runTurn: async options => {
        turns.push(options);
        // 真实 agent 通过 message 事件交付正文；执行器据此判定本轮是否真的有回复。
        options.emit("message", { role: "assistant", content: "今天的作业有 2 项。" });
      },
      emit: () => {},
    });
    advance(31 * 60_000);
    await runner.tick();
    assert.equal(sessions.created.length, 1);
    assert.match(sessions.created[0].title, /定时：早报/);
    assert.equal(turns.length, 1);
    assert.equal(turns[0].text, "汇总今天的作业");
    assert.equal(turns[0].approvals, null, "定时执行不弹交互审批");
    const task = await store.get(created.id);
    assert.equal(task.lastStatus, "succeeded");
    assert.equal(task.lastSessionId, "sess-1");
    assert.equal(task.enabled, false);

    await runner.tick();
    assert.equal(sessions.created.length, 1, "同一任务不会重复执行");
  });
});

test("执行失败记录原因，且不阻塞后续任务", async () => {
  await withStore(async ({ store, advance }) => {
    await store.create({ title: "会失败", prompt: "x", kind: "once", at: "2026-11-22 10:10" });
    await store.create({ title: "会成功", prompt: "y", kind: "once", at: "2026-11-22 10:20" });
    let calls = 0;
    const runner = createScheduleRunner({
      store,
      sessions: { async create() { return { id: "s-" + (++calls) }; } },
      runTurn: async ({ text, emit }) => {
        if (text === "x") throw new Error("模型不可用");
        emit("message", { role: "assistant", content: "完成" });
      },
    });
    advance(30 * 60_000);
    await runner.tick();
    const tasks = await store.list();
    const failed = tasks.find(task => task.title === "会失败");
    const ok = tasks.find(task => task.title === "会成功");
    assert.equal(failed.lastStatus, "failed");
    assert.match(failed.lastError, /模型不可用/);
    assert.equal(ok.lastStatus, "succeeded");
  });
});

test("模型报错但没有抛出时，任务必须记为失败", async () => {
  await withStore(async ({ store, advance }) => {
    const created = await store.create({ title: "静默失败", prompt: "x", kind: "once", at: "2026-11-22 10:05" });
    const runner = createScheduleRunner({
      store,
      sessions: { async create() { return { id: "s-silent" }; } },
      runTurn: async ({ emit }) => {
        emit("error", { code: "MODEL_PROTOCOL", message: "模型响应中断，本轮未完成，请重试。" });
      },
    });
    advance(10 * 60_000);
    await runner.tick();
    const task = await store.get(created.id);
    assert.equal(task.lastStatus, "failed");
    assert.match(task.lastError, /模型响应中断/);
  });
});

test("定时执行不覆盖服务端解析出的模型", async () => {
  await withStore(async ({ store, advance }) => {
    await store.create({ title: "模型传递", prompt: "x", kind: "once", at: "2026-11-22 10:05" });
    const seen = [];
    const runner = createScheduleRunner({
      store,
      sessions: { async create() { return { id: "s-model" }; } },
      runTurn: async options => {
        seen.push(options);
        // 服务端包装层会在 options 之后填入 model；这里确保没有空串再覆盖它。
        assert.equal(options.model, undefined, "执行器不能把 model 设成空串");
        options.emit("message", { role: "assistant", content: "ok" });
      },
    });
    advance(10 * 60_000);
    await runner.tick();
    assert.equal(seen.length, 1);
  });
});

test("模型侧工具与 HTTP 共用同一份计划", async () => {
  await withStore(async ({ store }) => {
    const tools = createScheduleTools({ store });
    const described = tools.describe().map(tool => tool.name).sort();
    assert.deepEqual(described, ["schedule_create", "schedule_delete", "schedule_list", "schedule_update"]);
    assert.equal(tools.describe().every(tool => tool.service === "schedule"), true);

    const created = await tools.call("schedule_create", { title: "周报", prompt: "整理周报", kind: "weekly", time: "19:00", days: [5] });
    assert.equal(created.ok, true);
    assert.ok(created.data.task.id);

    const listed = await tools.call("schedule_list", {});
    assert.equal(listed.data.tasks.length, 1);
    assert.equal(listed.data.tasks[0].title, "周报");
    assert.equal(listed.data.tasks[0].nextRunAt !== null, true);

    const updated = await tools.call("schedule_update", { id: created.data.task.id, enabled: false });
    assert.equal(updated.data.task.enabled, false);
    assert.equal(updated.data.task.nextRunAt, null);

    const bad = await tools.call("schedule_create", { title: "", prompt: "x", kind: "daily", time: "08:00" });
    assert.equal(bad.error.code, "INVALID_ARGUMENTS");
    const missing = await tools.call("schedule_delete", { id: "nope" });
    assert.equal(missing.error.code, "SCHEDULE_NOT_FOUND");

    const removed = await tools.call("schedule_delete", { id: created.data.task.id });
    assert.equal(removed.ok, true);
    assert.deepEqual((await tools.call("schedule_list", {})).data.tasks, []);
  });
});

test("组合宿主把定时工具并入模型清单，并转发到正确的实现", async () => {
  await withStore(async ({ store }) => {
    const host = {
      describe: () => [{ name: "learn_status", description: "状态", inputSchema: { type: "object" }, readOnly: true }],
      toolForModel: () => [{ type: "function", function: { name: "learn_status", description: "状态", parameters: { type: "object" } } }],
      async call() { return { ok: true, data: { from: "host" } }; },
      async prepareCall() { return { prepared: true }; },
    };
    const combined = withScheduleTools(host, createScheduleTools({ store }));
    assert.deepEqual(combined.describe().map(item => item.name).sort(), ["learn_status", "schedule_create", "schedule_delete", "schedule_list", "schedule_update"]);
    assert.equal(combined.toolForModel().length, 5);
    assert.deepEqual(await combined.call("learn_status", {}), { ok: true, data: { from: "host" } });
    const created = await combined.call("schedule_create", { title: "t", prompt: "p", kind: "daily", time: "08:00" });
    assert.equal(created.ok, true);
    assert.deepEqual(await combined.prepareCall("schedule_create", {}), {});
    assert.deepEqual(await combined.prepareCall("learn_status", {}), { prepared: true });
  });
});