import { test } from "node:test";
import assert from "node:assert/strict";
import { createApprovals } from "../lib/app/approvals.mjs";

test("允许后 resolve，且同一 callId 只登记一次", async () => {
  const approvals = createApprovals({ timeoutMs: 5000 });
  const first = approvals.register("call_1", { sessionId: "s1", name: "learn_submit_assignment" });
  const second = approvals.register("call_1", { sessionId: "s1", name: "learn_submit_assignment" });
  assert.equal(first.promise, second.promise, "重复登记应复用同一个 promise");
  assert.equal(approvals.decide("call_1", true), true);
  assert.deepEqual(await first.promise, { allow: true });
  assert.equal(approvals.decide("call_1", true), false, "已决定过的不能再决定");
  assert.deepEqual(approvals.list(), []);
});

test("拒绝会给出 denied 原因", async () => {
  const approvals = createApprovals({ timeoutMs: 5000 });
  const pending = approvals.register("call_2", { name: "cloud_upload_file" });
  approvals.decide("call_2", false);
  assert.deepEqual(await pending.promise, { allow: false, reason: "denied" });
});

test("超时自动拒绝，不把回合吊死", async () => {
  const approvals = createApprovals({ timeoutMs: 30 });
  const pending = approvals.register("call_3", { name: "rain_submit_answer" });
  const decision = await pending.promise;
  assert.equal(decision.allow, false);
  assert.equal(decision.reason, "timeout");
});

test("按会话取消只影响该会话的待审批", async () => {
  const approvals = createApprovals({ timeoutMs: 5000 });
  const a = approvals.register("a", { sessionId: "s1" });
  const b = approvals.register("b", { sessionId: "s2" });
  assert.equal(approvals.cancelSession("s1", "aborted"), 1);
  assert.deepEqual(await a.promise, { allow: false, reason: "aborted" });
  assert.equal(approvals.list().length, 1);
  approvals.decide("b", true);
  assert.deepEqual(await b.promise, { allow: true });
});

test("待审批列表只暴露元信息，不含参数正文", () => {
  const approvals = createApprovals({ timeoutMs: 5000 });
  approvals.register("c1", { sessionId: "s1", name: "t", args: { secret: "x" } });
  const listed = approvals.list();
  assert.equal(listed.length, 1);
  assert.equal(listed[0].callId, "c1");
  assert.equal(listed[0].name, "t");
  assert.equal(listed[0].args, undefined, "列表不应泄露工具参数");
  approvals.cancelAll("cleanup");
});