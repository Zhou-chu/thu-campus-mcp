import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createDebugLog } from "../lib/app/debug-log.mjs";

const temp = async t => { const dir = await mkdtemp(path.join(tmpdir(), "debug-log-")); t.after(() => rm(dir, { recursive: true, force: true })); return dir; };

test("debug log: 默认关闭不创建文件，开启后记录并脱敏", async t => {
  const dir = await temp(t);
  const log = createDebugLog({ stateDir: dir, env: {}, now: () => new Date("2026-11-25T00:00:00.000Z") });
  log.log({ module: "http", event: "request", data: { path: "/api/x" } });
  await log.flush();
  const off = await log.status();
  assert.equal(off.enabled, false);
  assert.equal(off.files.length, 0);

  await log.setEnabled(true);
  log.log({ module: "http", event: "request", durationMs: 12, data: { password: "secret", token: "abc", cookie: "c=1", path: "/api/x", body: "x".repeat(5000) } });
  await log.flush();
  const text = await log.readRecent();
  assert.match(text, /"password":"\[REDACTED\]"/);
  assert.match(text, /"token":"\[REDACTED\]"/);
  assert.match(text, /"cookie":"\[REDACTED\]"/);
  assert.match(text, /chars\]/);
  const on = await log.status();
  assert.equal(on.enabled, true);
  assert.ok(on.totalBytes > 0);
});

test("debug log: 环境变量强制开启，关闭后停止写入，清空可用", async t => {
  const dir = await temp(t);
  const log = createDebugLog({ stateDir: dir, env: { THU_CAMPUS_APP_DEBUG_LOG: "1" } });
  await log.setEnabled(false);
  log.log({ event: "should-not-write" });
  await log.flush();
  assert.equal((await log.status()).files.length, 0);
  const forced = createDebugLog({ stateDir: dir, env: { THU_CAMPUS_APP_DEBUG_LOG: "1" } });
  await forced.load();
  assert.equal(forced.enabled, true, "环境变量优先于持久化开关");
  forced.log({ event: "written" });
  await forced.flush();
  assert.ok((await forced.status()).totalBytes > 0);
  await forced.clear();
  assert.equal((await forced.status()).totalBytes, 0);
});

test("debug log: 超过上限轮转并保留有限文件", async t => {
  const dir = await temp(t);
  const log = createDebugLog({ stateDir: dir, env: {}, maxBytes: 200, keep: 3 });
  await log.setEnabled(true);
  for (let index = 0; index < 20; index += 1) log.log({ event: "entry", data: { index, text: "x".repeat(50) } });
  await log.flush();
  const files = (await log.status()).files.map(file => file.name).sort();
  assert.ok(files.length <= 3, "最多保留 keep 个文件");
  const current = await readFile(path.join(dir, "logs", "debug.jsonl"), "utf8");
  assert.match(current, /entry/);
});

test("debug log: 复杂字段脱敏、空日志读取与损坏配置不抛错", async t => {
  const dir = await temp(t);
  const log = createDebugLog({ stateDir: dir, env: {} });
  await log.setEnabled(true);
  const deep = { a: { b: { c: { d: { e: { f: "too deep" } } } } } };
  log.log({ module: "tool", event: "call", data: { list: Array.from({ length: 60 }, (_, index) => index), deep, apiKey: "k", count: 3, ok: true }, error: Object.assign(new Error("boom"), { code: "E_TEST" }) });
  await log.flush();
  const text = await log.readRecent(200);
  assert.match(text, /E_TEST|boom/);
  await log.clear();
  assert.equal(await log.readRecent(), "");
  assert.equal((await log.status()).totalBytes, 0);
  const brokenDir = await temp(t);
  await writeFile(path.join(brokenDir, "debug-log.json"), "{bad json", "utf8");
  const broken = createDebugLog({ stateDir: brokenDir, env: {} });
  await broken.load();
  assert.equal(broken.enabled, false);
});

test("debug log: 缺省目录、写入失败与空目录都不影响业务", async t => {
  const noDir = createDebugLog({ env: {} });
  const status = await noDir.status();
  assert.equal(status.enabled, false);
  assert.equal(Array.isArray(status.files), true);
  assert.equal(await noDir.readRecent(), "");

  const dir = await temp(t);
  const blocker = path.join(dir, "blocked");
  await writeFile(blocker, "not a directory", "utf8");
  const broken = createDebugLog({ stateDir: blocker, env: {} });
  await broken.setEnabled(true);
  broken.log({});
  broken.log({ event: "", data: undefined, error: undefined });
  await broken.flush();
  assert.equal((await broken.status()).enabled, true);
  await writeFile(path.join(dir, "other.txt"), "x", "utf8");
});
