import { test } from "node:test";
import assert from "node:assert/strict";
import { createTurnQueue } from "../webui/turn-queue.js";

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

const tick = () => Promise.resolve();

test("FIFO、trim、唯一ID及同步running状态", async () => {
  const calls = [];
  const changes = [];
  const queue = createTurnQueue({ run: item => { calls.push(item); return { ok: true }; }, onChange: state => changes.push(state) });
  const ids = [queue.enqueue("  first  "), queue.enqueue("second")];
  assert.notEqual(ids[0], ids[1]);
  assert.deepEqual(queue.snapshot(), { pending: [{ id: ids[0], text: "first" }, { id: ids[1], text: "second" }], running: false, paused: "" });
  const work = queue.drain();
  assert.equal(queue.snapshot().running, true);
  assert.equal(calls.length, 0);
  await work;
  assert.deepEqual(calls.map(item => item.text), ["first", "second"]);
  assert.deepEqual(queue.snapshot(), { pending: [], running: false, paused: "" });
  assert.deepEqual(changes.map(state => [state.pending.length, state.running]), [[1, false], [2, false], [2, true], [1, true], [0, true], [0, false]]);
});

test("deferred期间enqueue及重入drain不并发，真正执行时读取最新模型", async () => {
  const gate = deferred();
  let model = "model-a";
  let concurrent = 0;
  let maximum = 0;
  const calls = [];
  const queue = createTurnQueue({ run: async item => {
    concurrent += 1;
    maximum = Math.max(maximum, concurrent);
    calls.push([item.text, model]);
    if (calls.length === 1) await gate.promise;
    concurrent -= 1;
    return { ok: true };
  } });
  queue.enqueue("one");
  const work = queue.drain();
  assert.equal(queue.drain(), work);
  await tick();
  model = "model-b";
  queue.enqueue("two");
  assert.equal(queue.drain(), work);
  assert.deepEqual(calls, [["one", "model-a"]]);
  gate.resolve();
  await work;
  assert.equal(maximum, 1);
  assert.deepEqual(calls, [["one", "model-a"], ["two", "model-b"]]);
  const next = queue.drain();
  assert.notEqual(next, work);
  await next;
});

test("暂停中enqueue不恢复，resume只清暂停且必须显式drain", async () => {
  const calls = [];
  const queue = createTurnQueue({ run: item => { calls.push(item.text); return { ok: true }; } });
  queue.pause();
  queue.pause();
  queue.enqueue("one");
  await queue.drain();
  assert.equal(queue.snapshot().paused, "队列已暂停");
  assert.deepEqual(calls, []);
  queue.clear();
  assert.equal(queue.snapshot().paused, "队列已暂停");
  queue.enqueue("two");
  queue.resume();
  queue.resume();
  await tick();
  assert.deepEqual(calls, []);
  assert.equal(queue.snapshot().paused, "");
  await queue.drain();
  assert.deepEqual(calls, ["two"]);
});

test("运行中pause保留待发项且不终止活动项", async () => {
  const gate = deferred();
  const calls = [];
  const queue = createTurnQueue({ run: async item => { calls.push(item.text); await gate.promise; return { ok: true }; } });
  queue.enqueue("active");
  const remaining = queue.enqueue("pending");
  const work = queue.drain();
  await tick();
  queue.pause("手动暂停");
  gate.resolve();
  await work;
  assert.deepEqual(calls, ["active"]);
  assert.deepEqual(queue.snapshot(), { pending: [{ id: remaining, text: "pending" }], running: false, paused: "手动暂停" });
  queue.resume();
  await queue.drain();
  assert.deepEqual(calls, ["active", "pending"]);
});

test("remove只删除待发项，clear不误删或终止活动项", async () => {
  const gate = deferred();
  const calls = [];
  const queue = createTurnQueue({ run: async item => { calls.push(item.text); await gate.promise; return { ok: true }; } });
  const activeId = queue.enqueue("active");
  const removable = queue.enqueue("remove");
  queue.enqueue("clear");
  const work = queue.drain();
  await tick();
  assert.equal(queue.remove(activeId), null);
  assert.equal(queue.remove("missing"), null);
  assert.deepEqual(queue.remove(removable), { id: removable, text: "remove" });
  queue.clear();
  queue.clear();
  assert.equal(queue.snapshot().running, true);
  assert.deepEqual(queue.snapshot().pending, []);
  gate.resolve();
  await work;
  assert.deepEqual(calls, ["active"]);
});

for (const [name, execute, reason] of [
  ["失败", () => ({ ok: false, reason: "拒绝请求" }), "拒绝请求"],
  ["异常", () => { throw new Error("请求异常"); }, "请求异常"],
  ["缺失结果", () => undefined, "发送失败，队列已暂停"],
  ["非布尔成功", () => ({ ok: 1 }), "发送失败，队列已暂停"],
  ["无消息异常", () => { throw null; }, "发送异常，队列已暂停"],
]) {
  test(`${name}暂停并保留其余项，不自动重试已消费项`, async () => {
    const calls = [];
    const queue = createTurnQueue({ run: item => { calls.push(item.text); return calls.length === 1 ? execute() : { ok: true }; } });
    queue.enqueue("consumed");
    const id = queue.enqueue("remaining");
    await queue.drain();
    assert.deepEqual(queue.snapshot(), { pending: [{ id, text: "remaining" }], running: false, paused: reason });
    await queue.drain();
    assert.deepEqual(calls, ["consumed"]);
    queue.resume();
    await queue.drain();
    assert.deepEqual(calls, ["consumed", "remaining"]);
  });
}

test("canRun在微任务启动时与每次取项前检查，保存中不dispatch", async () => {
  let saving = false;
  const gate = deferred();
  const calls = [];
  const queue = createTurnQueue({ canRun: () => !saving, run: async item => { calls.push(item.text); await gate.promise; return { ok: true }; } });
  queue.enqueue("one");
  queue.enqueue("two");
  const blocked = queue.drain();
  saving = true;
  await blocked;
  assert.deepEqual(calls, []);
  assert.equal(queue.snapshot().pending.length, 2);
  assert.equal(queue.snapshot().paused, "");
  saving = false;
  const work = queue.drain();
  await tick();
  saving = true;
  gate.resolve();
  await work;
  assert.deepEqual(calls, ["one"]);
  assert.equal(queue.snapshot().pending.length, 1);
  saving = false;
  await queue.drain();
  assert.deepEqual(calls, ["one", "two"]);
});

test("invalid输入不产生状态变更且ID跨队列唯一", () => {
  let changes = 0;
  const queue = createTurnQueue({ run: () => ({ ok: true }), onChange: () => { changes += 1; } });
  for (const text of [undefined, null, 0, false, {}, [], "", " \n\t "]) assert.equal(queue.enqueue(text), null);
  queue.clear();
  queue.resume();
  assert.equal(queue.remove("unknown"), null);
  assert.equal(changes, 0);
  const other = createTurnQueue({ run: () => ({ ok: true }) });
  assert.notEqual(queue.enqueue("valid"), other.enqueue("valid"));
});

test("snapshot和onChange快照不暴露内部可变引用", async () => {
  const calls = [];
  const queue = createTurnQueue({ run: item => { calls.push(item.text); return { ok: true }; }, onChange: state => {
    state.pending.forEach(item => { item.text = "observer mutation"; });
    state.pending.length = 0;
    state.paused = "observer pause";
  } });
  const id = queue.enqueue("original");
  const state = queue.snapshot();
  state.pending[0].id = "changed";
  state.pending[0].text = "changed";
  state.pending.push({ id: "injected", text: "injected" });
  state.running = true;
  state.paused = "external pause";
  assert.deepEqual(queue.snapshot(), { pending: [{ id, text: "original" }], running: false, paused: "" });
  await queue.drain();
  assert.deepEqual(calls, ["original"]);
});
