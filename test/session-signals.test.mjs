import assert from "node:assert/strict";
import test from "node:test";
import { applyLearnxSignal, clearLearnxSignal, learnxExpiredSignal, reportLearnxExpired } from "../lib/app/session-signals.mjs";

test("session-signals: 信号在有效期内生效，过期后自动失效", async () => {
  clearLearnxSignal();
  assert.equal(learnxExpiredSignal({ now: 1000 }), null);
  reportLearnxExpired(1000);
  assert.deepEqual(learnxExpiredSignal({ now: 2000 }), { at: 1000 });
  assert.equal(learnxExpiredSignal({ now: 1000 + 11 * 60 * 1000 }), null, "超过 10 分钟不再生效");
  clearLearnxSignal();
  assert.equal(learnxExpiredSignal({ now: 1000 }), null);
});

test("session-signals: 命中信号时 learnx 统一显示登录已过期", async () => {
  const states = {
    learnx: { state: "unknown", verified: false, code: "UPSTREAM_PROTOCOL", checkedAt: "2026-11-22T00:00:00.000Z" },
    cloud: { state: "ready", verified: true, code: "VERIFIED" },
  };
  const applied = applyLearnxSignal(states, { at: 1_700_000_000_000 });
  assert.equal(applied.learnx.state, "expired");
  assert.equal(applied.learnx.verified, false);
  assert.equal(applied.learnx.code, "AUTH_REQUIRED");
  assert.equal(applied.learnx.sessionValidity, "expired");
  assert.equal(typeof applied.learnx.signalAt, "string");
  assert.deepEqual(applied.cloud, states.cloud, "其它服务不受影响");
  assert.equal(applyLearnxSignal(states, null), states, "没有信号时原样返回");
  assert.deepEqual(applyLearnxSignal({ cloud: states.cloud }, { at: 1 }), { cloud: states.cloud }, "缺少 learnx 时不崩也不编造");
});