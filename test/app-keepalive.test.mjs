import { test } from "node:test";
import assert from "node:assert/strict";
import { createKeepAlive } from "../lib/app/keepalive.mjs";
import { stateOf } from "../lib/app/states.mjs";
function fakeClock(start = 1000) {
  let current = start;
  return { now: () => (current += 10), advance: (ms) => (current += ms) };
}
test("只有 expired 会触发恢复，ready 不动", async () => {
  const restored = [];
  const keepAlive = createKeepAlive({
    probe: async () => ({
      learnx: { state: "ready" },
      cloud: { state: "expired" },
      hetang: { state: "login-required" },
      madmodel: { state: "ready" },
    }),
    restore: async (service) => {
      restored.push(service);
      return { ok: true };
    },
    intervalMs: 0,
    now: fakeClock().now,
  });
  const entry = await keepAlive.runOnce("test");
  assert.deepEqual(restored, ["cloud"]);
  assert.equal(entry.actions.length, 1);
  assert.equal(entry.actions[0].service, "cloud");
  assert.equal(entry.actions[0].action, "restore");
  assert.equal(entry.actions[0].ok, true);
  assert.deepEqual(entry.services, {
    learnx: "ready",
    cloud: "expired",
    hetang: "login-required",
    madmodel: "ready",
  });
  assert.equal(keepAlive.status().lastResult.trigger, "test");
});
test("关闭自动恢复时只记录不动作", async () => {
  let called = false;
  const keepAlive = createKeepAlive({
    probe: async () => ({ cloud: { state: "expired" } }),
    restore: async () => {
      called = true;
      return { ok: true };
    },
    restoreExpired: false,
    intervalMs: 0,
    now: fakeClock().now,
  });
  const entry = await keepAlive.runOnce();
  assert.equal(called, false);
  assert.equal(entry.actions[0].action, "skipped");
});
test("恢复失败被如实记录，不抛给调用方", async () => {
  const keepAlive = createKeepAlive({
    probe: async () => ({ learnx: { state: "expired" } }),
    restore: async () => ({ ok: false, code: "BROWSER_BUSY" }),
    intervalMs: 0,
    now: fakeClock().now,
  });
  const entry = await keepAlive.runOnce();
  assert.equal(entry.actions[0].ok, false);
  assert.equal(entry.actions[0].code, "BROWSER_BUSY");
  assert.equal(entry.ok, false);
});
test("并发触发只执行一次", async () => {
  let resolveProbe;
  const gate = new Promise((resolve) => (resolveProbe = resolve));
  const keepAlive = createKeepAlive({
    probe: () => gate,
    restore: async () => ({ ok: true }),
    intervalMs: 0,
    now: fakeClock().now,
  });
  const first = keepAlive.runOnce("a");
  const second = await keepAlive.runOnce("b");
  assert.equal(second.skipped, true);
  assert.equal(second.reason, "already-running");
  resolveProbe({ learnx: { state: "ready" } });
  const done = await first;
  assert.equal(done.trigger, "a");
});
test("探测异常不会让自检崩溃，也不会伪造服务状态", async () => {
  const keepAlive = createKeepAlive({
    probe: async () => {
      throw Object.assign(new Error("boom"), { code: "PROBE_FAILED" });
    },
    restore: async () => ({ ok: true }),
    intervalMs: 0,
    now: fakeClock().now,
  });
  const entry = await keepAlive.runOnce();
  assert.deepEqual(entry.services, {});
  assert.deepEqual(entry.actions, []);
  assert.equal(entry.ok, true);
});
test("状态里给出下一次执行时间与历史", async () => {
  const clock = fakeClock();
  const keepAlive = createKeepAlive({
    probe: async () => ({ cloud: { state: "expired" } }),
    restore: async () => ({ ok: true }),
    intervalMs: 60000,
    now: clock.now,
  });
  assert.equal(keepAlive.status().enabled, true);
  await keepAlive.runOnce("t1");
  const status = keepAlive.status();
  assert.equal(status.history.length, 1);
  assert.ok(status.nextRunAt);
  assert.deepEqual(status.expiredServices, ["cloud"]);
  const reconfigured = keepAlive.configure({ intervalMs: 0 });
  assert.equal(reconfigured.intervalMs, 0);
  assert.equal(keepAlive.status().enabled, false);
});
test("状态归一化：配置存在不等于会话有效", () => {
  assert.equal(stateOf({ authentication: { configured: true }, sessionValidity: "not_checked" }), "ready");
  assert.equal(stateOf({ authentication: { configured: false } }), "login-required");
  assert.equal(stateOf({ authentication: { configured: true }, sessionValidity: "expired" }), "expired");
  assert.equal(stateOf({ configured: true, expired: true }), "expired");
  assert.equal(stateOf({ disabled: true }), "login-required");
  assert.equal(stateOf(null), "unknown");
  assert.equal(stateOf({}), "unknown");
});