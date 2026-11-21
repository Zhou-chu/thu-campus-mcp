import assert from "node:assert/strict";
import test from "node:test";
import { withBrowserLock, BrowserBusyError, browserQueueDepth } from "../lib/app/browser-lock.mjs";

test("browser-lock: 串行执行，后到任务不会与前者重叠", async () => {
  const order = [];
  let running = 0;
  let peak = 0;
  const task = (name, delay) => async () => {
    running += 1;
    peak = Math.max(peak, running);
    order.push(`${name}:start`);
    await new Promise(resolve => setTimeout(resolve, delay));
    order.push(`${name}:end`);
    running -= 1;
    return name;
  };
  const [first, second] = await Promise.all([
    withBrowserLock("座位", task("seat", 30)),
    withBrowserLock("体育", task("sports", 10)),
  ]);
  assert.equal(first, "seat");
  assert.equal(second, "sports");
  assert.equal(peak, 1, "同一时刻只允许一个浏览器任务");
  assert.deepEqual(order, ["seat:start", "seat:end", "sports:start", "sports:end"]);
});

test("browser-lock: 队列满时直接 BROWSER_BUSY，不无限等待", async () => {
  const slow = withBrowserLock("慢任务", async () => {
    await new Promise(resolve => setTimeout(resolve, 40));
    return "slow";
  }, { maxQueue: 1 });
  const rejected = withBrowserLock("第二个", async () => "second", { maxQueue: 1 });
  await assert.rejects(() => rejected, error => error instanceof BrowserBusyError && error.code === "BROWSER_BUSY");
  assert.equal(await slow, "slow");
});

test("browser-lock: 任务抛错后队列仍可继续，深度归零", async () => {
  await assert.rejects(() => withBrowserLock("失败任务", async () => { throw new Error("boom"); }), /boom/);
  assert.equal(browserQueueDepth(), 0);
  const value = await withBrowserLock("后续", async () => "ok");
  assert.equal(value, "ok");
});

test("browser-lock: 超时返回 BROWSER_BUSY", async () => {
  await assert.rejects(
    () => withBrowserLock("超时任务", () => new Promise(() => {}), { timeoutMs: 20 }),
    error => error.code === "BROWSER_BUSY",
  );
});