import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { acquireLease, readLease, releaseLease, renewLease, LEASE_STALE_MS } from "../lib/browser-lease.mjs";
import { configureBrowserLock, withBrowserLock } from "../lib/app/browser-lock.mjs";

const temp = async t => {
  const dir = await mkdtemp(path.join(tmpdir(), "lease-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
};

test("lease: 同一时刻只有一个持有者，别人的租约不可抢占", async t => {
  const dir = await temp(t);
  assert.equal(await readLease(dir), null);
  const first = await acquireLease(dir, { owner: "worker:1", label: "login:seat" });
  assert.equal(first.ok, true);
  const second = await acquireLease(dir, { owner: "app:2", label: "seat_read" });
  assert.equal(second.ok, false);
  assert.equal(second.code, "BROWSER_BUSY");
  assert.equal(second.holder.label, "login:seat");

  // 同一持有者续租成功，别人不能替它续。
  assert.equal(await renewLease(dir, { owner: "worker:1" }), true);
  assert.equal(await renewLease(dir, { owner: "app:2" }), false);

  assert.equal(await releaseLease(dir, { owner: "app:2" }), false, "不能释放别人的租约");
  assert.equal(await releaseLease(dir, { owner: "worker:1" }), true);
  assert.equal(await readLease(dir), null);
});

test("lease: 心跳过期的租约自动失效，崩溃不会留下永久占用", async t => {
  const dir = await temp(t);
  const stale = new Date(Date.now() - LEASE_STALE_MS - 5000).toISOString();
  await writeFile(path.join(dir, "browser-lease.json"), JSON.stringify({ owner: "worker:gone", label: "login:sports", heartbeatAt: stale, since: stale }));
  assert.equal(await readLease(dir), null, "过期租约视为不存在");
  assert.equal((await acquireLease(dir, { owner: "app:9", label: "seat" })).ok, true);
});

test("browser-lock: 看到来自其它进程的租约时直接 BROWSER_BUSY 并报出占用者", async t => {
  const dir = await temp(t);
  configureBrowserLock({ stateDir: dir });
  t.after(() => configureBrowserLock({ stateDir: "" }));
  await acquireLease(dir, { owner: "worker:window", label: "open:seat" });

  let ran = 0;
  await assert.rejects(
    () => withBrowserLock("图书馆座位登录", async () => { ran += 1; }),
    error => error.code === "BROWSER_BUSY" && /open:seat/.test(error.message),
  );
  assert.equal(ran, 0, "占用者在别的进程时不能开跑");

  await releaseLease(dir, { owner: "worker:window" });
  const value = await withBrowserLock("图书馆座位登录", async () => { ran += 1; return "ok"; });
  assert.equal(value, "ok");
  assert.equal(ran, 1);
  assert.equal(await readLease(dir), null, "任务结束应释放租约");
});

test("lease: 租约下执行任务，拿不到就 BROWSER_BUSY，成功/失败都释放", async t => {
  const { withBrowserLease } = await import("../lib/browser-lease.mjs");
  const dir = await temp(t);
  const value = await withBrowserLease(dir, { owner: "madmodel:1", label: "login:madmodel" }, async () => "ok");
  assert.equal(value, "ok");
  assert.equal(await readLease(dir), null, "成功后释放");

  await assert.rejects(
    () => withBrowserLease(dir, { owner: "app:2", label: "seat" }, async () => { throw new Error("boom"); }),
    error => error.message === "boom",
  );
  assert.equal(await readLease(dir), null, "失败也要释放");

  await acquireLease(dir, { owner: "worker:9", label: "open:seat" });
  await assert.rejects(
    () => withBrowserLease(dir, { owner: "madmodel:1", label: "login:madmodel" }, async () => "never"),
    error => error.code === "BROWSER_BUSY" && /open:seat/.test(error.message),
  );
});
