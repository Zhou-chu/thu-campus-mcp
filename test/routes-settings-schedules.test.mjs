import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createSettingsRoutes } from "../lib/app/routes/settings.mjs";
import { createScheduleRoutes } from "../lib/app/routes/schedules.mjs";
import { ScheduleStore } from "../lib/app/schedules.mjs";

function response() {
  const state = { status: 0, body: undefined };
  const res = {
    writableEnded: false,
    writeHead(status) { state.status = status; },
    end(payload) { try { state.body = payload ? JSON.parse(payload) : undefined; } catch { state.body = String(payload); } res.writableEnded = true; },
  };
  return { res, state };
}

const request = (body, { method = "POST" } = {}) => ({
  method,
  body,
  async *[Symbol.asyncIterator]() {},
  on() {},
});

async function call(handler, { method = "GET", pathname, req }) {
  const { res, state } = response();
  const handled = await handler(req || { method }, res, { pathname, method, url: new URL(pathname, "http://127.0.0.1") });
  return { handled, status: state.status, body: state.body };
}

test("设置路由：三种频率与保活缺省、非法参数都走统一错误", async () => {
  const keepAliveCalls = [];
  const keepAlive = {
    status: () => ({ enabled: true, intervalMs: 30 * 60000, restoreExpired: false, lastRunAt: null, expiredServices: [], history: [] }),
    configure: patch => keepAliveCalls.push(patch),
    runOnce: async () => ({ checked: 4 }),
  };
  const overrides = { modelName: "qwen3.8-27b" };
  const bodies = [];
  const handler = createSettingsRoutes({
    config: { stateDir: ".", modelRoute: "madmodel" },
    overrides,
    setEffort: value => { if (value) overrides.reasoningEffort = value; else delete overrides.reasoningEffort; },
    efforts: new Set(["low", "medium", "high"]),
    keepAlive,
    settingsFile: path.join(await mkdtemp(path.join(tmpdir(), "settings-")), "settings.json"),
    readBody: async () => bodies.shift() || {},
  });

  const read = await call(handler, { pathname: "/api/settings" });
  assert.equal(read.body.settings.keepAliveMinutes, 30);
  assert.equal(read.body.settings.keepAliveRestore, false);

  const status = await call(handler, { pathname: "/api/keepalive" });
  assert.equal(status.body.enabled, true);
  const run = await call(handler, { method: "POST", pathname: "/api/keepalive/run" });
  assert.equal(run.body.result.checked, 4);

  bodies.push({ reasoningEffort: "bogus" });
  const bogus = await call(handler, { method: "PUT", pathname: "/api/settings" });
  assert.equal(bogus.status, 400);
  assert.equal(bogus.body.error.code, "INVALID_ARGUMENTS");

  bodies.push({ keepAliveMinutes: 1441 });
  const minutes = await call(handler, { method: "PUT", pathname: "/api/settings" });
  assert.equal(minutes.status, 400);

  bodies.push({ modelName: "m2", reasoningEffort: "high", keepAliveMinutes: 10, keepAliveRestore: true, compactTools: true });
  const saved = await call(handler, { method: "PUT", pathname: "/api/settings" });
  assert.equal(saved.status, 200);
  assert.equal(overrides.modelName, "m2");
  assert.equal(overrides.reasoningEffort, "high");
  assert.equal(overrides.compactTools, true);
  assert.deepEqual(keepAliveCalls.at(-1), { restoreExpired: true });

  bodies.push({ compactTools: "yes" });
  const badType = await call(handler, { method: "PUT", pathname: "/api/settings" });
  assert.equal(badType.status, 400);

  const service = await call(handler, { pathname: "/api/service" });
  assert.equal(service.status, 200);
  assert.equal(typeof service.body.mode, "string");

  const other = await handler({ method: "GET" }, response().res, { pathname: "/api/other", method: "GET", url: new URL("http://x/api/other") });
  assert.equal(other, false);
});

test("保活关闭时不伪造历史，直接说明未启用", async () => {
  const handler = createSettingsRoutes({
    config: { stateDir: ".", modelRoute: "madmodel" }, overrides: {}, setEffort: () => {}, efforts: new Set(), keepAlive: null,
    settingsFile: "settings.json", readBody: async () => ({}),
  });
  const read = await call(handler, { pathname: "/api/keepalive" });
  assert.deepEqual(read.body, { ok: true, enabled: false, history: [] });
  const settings = await call(handler, { pathname: "/api/settings" });
  assert.equal(settings.body.settings.keepAliveMinutes, 0);
});

test("定时任务路由：GET 附带执行器状态，PATCH 保留主键并拒绝坏体", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "routes-schedules-"));
  try {
    const store = new ScheduleStore(dir, { now: () => new Date(2026, 10, 22, 10, 0) });
    const created = await store.create({ title: "任务", prompt: "p", kind: "daily", time: "08:00" });
    const handler = createScheduleRoutes({ store, runner: { status: () => ({ running: true, ticks: 2 }) } });

    const list = await call(handler, { pathname: "/api/schedules" });
    assert.equal(list.status, 200);
    assert.equal(list.body.tasks.length, 1);
    assert.deepEqual(list.body.runner, { running: true, ticks: 2 });

    const patched = await call(handler, {
      method: "PATCH",
      pathname: "/api/schedules/" + created.id,
      req: (() => {
        const body = JSON.stringify({ enabled: false, id: "other", createdAt: "x", when: "y" });
        return { method: "PATCH", [Symbol.asyncIterator]: async function* () { yield Buffer.from(body); } };
      })(),
    });
    assert.equal(patched.status, 200);
    assert.equal(patched.body.task.id, created.id);
    assert.equal(patched.body.task.enabled, false);

    const arrayBody = { method: "PATCH", [Symbol.asyncIterator]: async function* () { yield Buffer.from("[]"); } };
    const rejected = await call(handler, { method: "PATCH", pathname: "/api/schedules/" + created.id, req: arrayBody });
    assert.equal(rejected.status, 400);

    const broken = { method: "POST", [Symbol.asyncIterator]: async function* () { yield Buffer.from("{oops"); } };
    const brokenResult = await call(handler, { method: "POST", pathname: "/api/schedules", req: broken });
    assert.equal(brokenResult.status, 400);

    const oversized = { method: "POST", [Symbol.asyncIterator]: async function* () { yield Buffer.alloc(70000, 97); } };
    const tooLarge = await call(handler, { method: "POST", pathname: "/api/schedules", req: oversized });
    assert.equal(tooLarge.status, 400);

    const missing = await call(handler, { method: "DELETE", pathname: "/api/schedules/00000000-0000-4000-8000-000000000000" });
    assert.equal(missing.status, 404);

    const other = await handler({ method: "GET" }, response().res, { pathname: "/api/schedules/x", method: "GET", url: new URL("http://x/api/schedules/x") });
    assert.equal(other, false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("定时任务路由：没有执行器时 runner 为 null", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "routes-schedules-null-"));
  try {
    const handler = createScheduleRoutes({ store: new ScheduleStore(dir), runner: null });
    const list = await call(handler, { pathname: "/api/schedules" });
    assert.equal(list.body.runner, null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test("调试日志路由：读取、切换、导出与清空；未注入时明确不可用", async () => {
  let enabled = false;
  const debugLog = {
    status: async () => ({ enabled, dir: "logs", files: [], totalBytes: enabled ? 12 : 0 }),
    setEnabled: async value => { enabled = value; return enabled; },
    readRecent: async () => '{"event":"x"}\n',
    clear: async () => { enabled = false; },
  };
  const bodies = [];
  const handler = createSettingsRoutes({
    config: { stateDir: ".", modelRoute: "madmodel" }, overrides: {}, setEffort: () => {}, efforts: new Set(),
    settingsFile: path.join(await mkdtemp(path.join(tmpdir(), "settings-debug-")), "settings.json"),
    debugLog, readBody: async () => bodies.shift() || {},
  });
  assert.equal((await call(handler, { pathname: "/api/debug-log" })).body.enabled, false);
  assert.equal((await call(handler, { method: "PUT", pathname: "/api/debug-log", req: request({}) })).body.enabled, false);
  bodies.push({ enabled: true });
  const enabledCall = await call(handler, { method: "PUT", pathname: "/api/debug-log", req: request({}) });
  assert.equal(enabledCall.body.enabled, true);
  const download = await call(handler, { pathname: "/api/debug-log/download" });
  assert.equal(download.body.event, "x");
  bodies.push({});
  assert.equal((await call(handler, { method: "POST", pathname: "/api/debug-log/clear", req: request({}) })).body.enabled, false);

  const unavailable = createSettingsRoutes({ config: { stateDir: "." }, overrides: {}, setEffort: () => {}, efforts: new Set(), settingsFile: "x", readBody: async () => ({}) });
  assert.equal((await call(unavailable, { pathname: "/api/debug-log" })).body.enabled, false);
  assert.equal((await call(unavailable, { method: "PUT", pathname: "/api/debug-log", req: request({}) })).status, 503);
  assert.equal((await call(unavailable, { pathname: "/api/debug-log/download" })).status, 503);
  assert.equal((await call(unavailable, { method: "POST", pathname: "/api/debug-log/clear", req: request({}) })).status, 503);
});
