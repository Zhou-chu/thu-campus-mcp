import assert from "node:assert/strict";
import test from "node:test";
import { createSessionSignals } from "../lib/app/session-signals.mjs";

const states = () => ({
  learnx: { state: "ready", verified: true, code: "VERIFIED", source: "tool:learn_status" },
  cloud: { state: "ready", verified: true, code: "VERIFIED" },
});

test("session-signals: 信号在有效期内生效，过期后自动失效", () => {
  let now = 1000;
  const signals = createSessionSignals({ now: () => now });
  assert.equal(signals.current(), null);
  signals.report(1000);
  assert.deepEqual(signals.current(), { at: 1000 });
  now = 1000 + 10 * 60 * 1000 + 1;
  assert.equal(signals.current(), null, "超过 10 分钟不再生效");
  signals.report();
  assert.deepEqual(signals.current(), { at: now }, "缺省使用当前时间");
  signals.clear();
  assert.equal(signals.current(), null);
});

test("session-signals: 每个实例各自持有信号，不再有模块级共享状态", () => {
  const first = createSessionSignals({ now: () => 5000 });
  const second = createSessionSignals({ now: () => 5000 });
  first.report(5000);
  assert.deepEqual(first.current(), { at: 5000 });
  assert.equal(second.current(), null, "另一个实例不受影响");
});

test("session-signals: 命中信号时 learnx 统一显示登录已过期", () => {
  const signals = createSessionSignals({ now: () => 2_000 });
  signals.report(1_700_000_000_000);
  const applied = signals.apply(states());
  assert.equal(applied.learnx.state, "expired");
  assert.equal(applied.learnx.verified, false);
  assert.equal(applied.learnx.code, "AUTH_REQUIRED");
  assert.equal(applied.learnx.sessionValidity, "expired");
  assert.equal(applied.learnx.signalAt, new Date(1_700_000_000_000).toISOString());
  assert.deepEqual(applied.cloud, states().cloud, "其它服务不受影响");
  const clean = createSessionSignals({ now: () => 2000 });
  assert.deepEqual(clean.apply(states()), states(), "没有信号时原样返回");
  assert.deepEqual(clean.apply({ cloud: states().cloud }), { cloud: states().cloud }, "缺少 learnx 时不崩也不编造");
});

test("session-signals: 非法时间戳回落到注入时钟，不产生永久信号", () => {
  const signals = createSessionSignals({ now: () => 42 });
  signals.report("not-a-number");
  assert.deepEqual(signals.current(), { at: 42 });
});