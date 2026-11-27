import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { openBrowserWithRetry } from "../lib/app/browser-open.mjs";
import { acquireLease } from "../lib/browser-lease.mjs";

const temp = async t => {
  const dir = await mkdtemp(path.join(tmpdir(), "open-lease-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
};
const leaseOf = async dir => {
  try { return JSON.parse(await readFile(path.join(dir, "browser-lease.json"), "utf8")); }
  catch { return null; }
};
const fakeBrowser = () => {
  let closed = 0;
  return { context: {}, close: async () => { closed += 1; }, get closed() { return closed; } };
};

test("直接开浏览器的入口也要持有租约，关闭时释放", async t => {
  const dir = await temp(t);
  const browser = await openBrowserWithRetry({ stateDir: dir, open: async () => fakeBrowser(), label: "sports:read" });
  const lease = await leaseOf(dir);
  assert.equal(lease?.label, "sports:read", "打开期间必须有租约");
  await browser.close();
  assert.equal(await leaseOf(dir), null, "关闭后必须释放");
});

test("已有租约时直接拒绝，并报出占用者", async t => {
  const dir = await temp(t);
  await acquireLease(dir, { owner: "worker:abc", label: "open:seat" });
  await assert.rejects(
    () => openBrowserWithRetry({ stateDir: dir, open: async () => fakeBrowser(), label: "sports:booking" }),
    error => error.code === "BROWSER_BUSY" && /open:seat/.test(error.message),
  );
});

test("打开失败不留下租约", async t => {
  const dir = await temp(t);
  await assert.rejects(
    () => openBrowserWithRetry({ stateDir: dir, attempts: 1, open: async () => { throw new Error("boom"); }, label: "seat:session" }),
    /boom/,
  );
  assert.equal(await leaseOf(dir), null);

  const busyDir = await temp(t);
  await assert.rejects(
    () => openBrowserWithRetry({ stateDir: busyDir, attempts: 1, open: async () => { throw Object.assign(new Error("busy"), { code: "BROWSER_BUSY" }); }, label: "seat:session" }),
    error => error.code === "BROWSER_BUSY",
  );
  assert.equal(await leaseOf(busyDir), null);
});
