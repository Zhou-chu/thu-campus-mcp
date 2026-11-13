import { test } from "node:test";
import assert from "node:assert/strict";
import { createKeepAlive, KeepAliveError } from "../lib/app/keepalive.mjs";
import { stateOf } from "../lib/app/states.mjs";
function fakeClock(start = 1000) {
  let current = start;
  return { now: () => (current += 10), advance: (ms) => (current += ms) };
}
test("保活错误具有稳定code", () => { const error = new KeepAliveError("PROBE_FAILED", "fixture"); assert.equal(error.code, "PROBE_FAILED"); assert.equal(error.message, "fixture"); });
test("只有 expired 会触发恢复，ready 不动", async () => {
  const restored = [];
  const keepAlive = createKeepAlive({
    probe: async () => ({
      learnx: { state: "ready", verified: true, source: "protected-api:fixture-learn", checkedAt: "2026-01-01T00:00:00.000Z" },
      cloud: { state: "expired" },
      hetang: { state: "login-required" },
      madmodel: { state: "ready", verified: true, source: "protected-api:fixture-madmodel", checkedAt: "2026-01-01T00:00:00.000Z" },
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
  resolveProbe({ learnx: { state: "ready", verified: true, source: "protected-api:fixture-learn", checkedAt: "2026-01-01T00:00:00.000Z" } });
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
  assert.equal(entry.ok, false);
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
  assert.equal(stateOf({ authentication: { configured: true }, sessionValidity: "not_checked" }), "unverified");
  assert.equal(stateOf({ authentication: { configured: false } }), "login-required");
  assert.equal(stateOf({ authentication: { configured: true }, sessionValidity: "expired" }), "expired");
  assert.equal(stateOf({ configured: true, expired: true }), "expired");
  assert.equal(stateOf({ disabled: true }), "login-required");
  assert.equal(stateOf(null), "unknown");
  assert.equal(stateOf({}), "unknown");
});
test("未核验/网络未知/mock/旧ready均不当已登录，不触发恢复，历史仅白名单", async () => {
  let restores = 0;
  const keepAlive = createKeepAlive({ intervalMs: 0, probe: async () => ({ learnx: { state: "unverified", token: "fixture-private" }, cloud: { state: "unknown", code: "NETWORK_ERROR" }, hetang: { state: "mock" }, madmodel: { state: "ready" }, absent: null }), restore: async () => { restores++; } });
  const entry = await keepAlive.runOnce();
  assert.equal(restores, 0); assert.equal(entry.ok, false); assert.equal(entry.services.madmodel, "unverified"); assert.equal(entry.services.absent, "unknown"); assert.equal(entry.serviceEvidence.cloud.code, "NETWORK_ERROR"); assert.equal(entry.serviceEvidence.madmodel.verified, false); assert.ok(!JSON.stringify(entry).includes("fixture-private"));
});
test("只有带本次受保护证据的ready才健康，空probe不是健康", async () => {
  const info = { state: "ready", verified: true, source: "protected-api:fixture-check", checkedAt: "2026-01-01T00:00:00.000Z", code: "VERIFIED" };
  const keepAlive = createKeepAlive({ intervalMs: 0, probe: async () => ({ learnx: info }), restore: async () => { throw new Error("must-not-restore"); } });
  const entry = await keepAlive.runOnce(); assert.equal(entry.ok, true); assert.deepEqual(entry.serviceEvidence.learnx, info);
  assert.equal((await createKeepAlive({ intervalMs: 0, probe: async () => undefined }).runOnce()).ok, false);
});
test("恢复异常/空回执不冒成功，成功恢复也没有伪造已核验", async () => {
  for (const restore of [async () => { throw Object.assign(new Error("fixture-private"), { code: "BROWSER_BUSY" }); }, async () => undefined, async () => ({ ok: true })]) {
    const logs = [], keepAlive = createKeepAlive({ intervalMs: 0, probe: async () => ({ learnx: { state: "expired" } }), restore, logger: (...args) => logs.push(args) });
    const entry = await keepAlive.runOnce(); assert.equal(entry.ok, false); assert.equal(entry.services.learnx, "expired"); assert.equal(entry.serviceEvidence.learnx.verified, false); assert.equal(logs.length, 1); assert.ok(!JSON.stringify(entry).includes("fixture-private"));
  }
});
test("保活定时器启停/配置和历史上限使用相同证据门槛", async t => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  let probes = 0;
  const keepAlive = createKeepAlive({ intervalMs: 0, historyLimit: 2, probe: async () => { probes++; return { learnx: { state: "unknown" } }; }, restore: async () => { throw new Error("must-not-restore"); } });
  t.after(() => keepAlive.stop());
  assert.equal(keepAlive.start(), false); assert.equal(keepAlive.status().lastRunAt, null);
  assert.deepEqual(keepAlive.configure({ intervalMs: 5, restoreExpired: false }), { intervalMs: 5, restoreExpired: false }); assert.equal(keepAlive.start(), false);
  t.mock.timers.tick(5); await new Promise(resolve => setImmediate(resolve)); assert.equal(probes, 1);
  assert.deepEqual(keepAlive.configure({ intervalMs: -1, restoreExpired: "bad" }), { intervalMs: 5, restoreExpired: false });
  keepAlive.configure(); keepAlive.stop(); keepAlive.stop(); assert.equal(keepAlive.start(), true); keepAlive.stop();
  for (let i = 0; i < 4; i++) await keepAlive.runOnce();
  assert.equal(keepAlive.status().history.length, 2); assert.deepEqual(keepAlive.status().expiredServices, []);
  keepAlive.configure({ intervalMs: 0, restoreExpired: true });
});