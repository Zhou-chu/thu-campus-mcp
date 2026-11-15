import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { EventEmitter, once } from "node:events";
import { PassThrough } from "node:stream";
import { randomUUID } from "node:crypto";
import lockfile from "proper-lockfile";
import { runtimeInfo } from "../../packages/browser/runtime.mjs";
import { ensureConfig, waitForHealth, redact, buildLaunchArgs } from "../launcher.mjs";

const launcher = fileURLToPath(new URL("../launcher.mjs", import.meta.url));
async function until(fn) {
  const deadline = performance.now() + 3000;
  while (performance.now() < deadline) { if (await fn()) return; await new Promise(resolve => setTimeout(resolve, 5)); }
  assert.fail("owned desktop fixture did not settle");
}
async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "desktop-edges-owned-")), undos = [];
  assert.ok(path.isAbsolute(root)); assert.match(path.basename(root), /^desktop-edges-owned-/);
  const f = { root, calls: [], exits: [], logs: [], children: [], keepRuntime: false, releases: [] };
  f.path = relative => { const target = path.resolve(root, relative); assert.ok(target.startsWith(root + path.sep)); return target; };
  f.put = async (relative, value) => { const file = f.path(relative); await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, typeof value === "string" ? value : JSON.stringify(value)); return file; };
  f.patch = (object, key, value) => { const before = Object.getOwnPropertyDescriptor(object, key); Object.defineProperty(object, key, { value, writable: true, configurable: true, enumerable: before?.enumerable ?? true }); syncBuiltinESMExports(); undos.push(() => { if (before) Object.defineProperty(object, key, before); else delete object[key]; syncBuiltinESMExports(); }); };
  f.env = (key, value) => { const before = process.env[key]; process.env[key] = value; undos.push(() => { if (before === undefined) delete process.env[key]; else process.env[key] = before; }); };
  const beforeExitCode = process.exitCode, beforeSignals = new Map(["SIGINT", "SIGTERM"].map(signal => [signal, new Set(process.listeners(signal))]));
  f.handlers = signal => process.listeners(signal).filter(listener => !beforeSignals.get(signal).has(listener));
  t.after(async () => {
    for (const listener of f.handlers("SIGTERM")) listener();
    if (f.handlers("SIGTERM").length) await until(() => f.exits.length > 0);
    for (const release of f.releases) await release().catch(() => {});
    for (const stream of f.logs) { if (!stream.closed) { await new Promise(resolve => stream.end(resolve)); if (!stream.closed) await once(stream, "close"); } }
    for (const [signal, previous] of beforeSignals) for (const listener of process.listeners(signal)) if (!previous.has(listener)) process.removeListener(signal, listener);
    process.exitCode = beforeExitCode; for (const undo of undos.reverse()) undo();
    assert.match(path.basename(root), /^desktop-edges-owned-/); await rm(root, { recursive: true, force: true });
  });
  f.env("THU_BROWSER_RUNTIME_DIR", f.path("runtime")); f.env("THU_BROWSER_STATE_DIR", f.path("browser"));
  f.patch(os, "homedir", () => f.path("home")); f.patch(process, "exit", code => { f.exits.push(code); });
  const nativeStream = fs.createWriteStream;
  f.patch(fs, "createWriteStream", (file, options) => { assert.ok(file.startsWith(root + path.sep)); const stream = nativeStream(file, options); f.logs.push(stream); return stream; });
  f.patch(globalThis, "fetch", async (...args) => f.fetch ? f.fetch(...args) : ({ ok: true, json: async () => ({ ok: true }) }));
  f.patch(childProcess, "spawn", (executable, args, options) => {
    assert.ok(path.isAbsolute(executable)); const index = f.calls.length; f.calls.push({ executable, args, options });
    if (f.spawnFailure) throw new Error("fixture process failure");
    const c = new EventEmitter(); c.stdout = new PassThrough(); c.stderr = new PassThrough(); c.exitCode = null; c.kills = [];
    c.kill = signal => { c.kills.push(signal); if (index === 0 && f.keepRuntime && signal !== "SIGKILL") return true; c.exitCode = 0; queueMicrotask(() => c.emit("exit", 0)); return true; };
    f.children.push(c); return c;
  });
  f.stateDir = f.path("home/.thu-campus-mcp/app");
  f.start = async () => {
    const previous = process.argv[1]; process.argv[1] = launcher; process.exitCode = undefined;
    try { const module = await import(pathToFileURL(launcher).href + "?owned-test=" + randomUUID()); assert.equal(module.stateDir, f.stateDir); return module; }
    finally { process.argv[1] = previous; }
  };
  f.installed = async () => {
    const info = await runtimeInfo({ runtimeDir: f.path("runtime"), stateDir: f.path("browser") });
    f.executable = await f.put("runtime/bin/browser.exe", "dummy executable; never launched");
    await f.put("runtime/browser.json", { revision: info.revision, relativeExecutable: "bin/browser.exe" });
  };
  f.fastClock = () => { let now = Date.now(); f.patch(Date, "now", () => (now += 15001)); const timeout = globalThis.setTimeout; f.patch(globalThis, "setTimeout", (fn, ms, ...args) => timeout(fn, [100, 250].includes(ms) ? 0 : ms, ...args)); };
  return f;
}

test("desktop config replaces corrupt/incomplete files but retains a valid configuration", async t => {
  const f = await fixture(t), dir = f.path("config"); await f.put("config/desktop.json", "not JSON");
  const first = await ensureConfig({ dir, port: 8991 }); assert.equal(first.created, true); assert.equal(first.port, 8991); assert.match(first.token, /^[A-Za-z0-9_-]{40,}$/);
  await f.put("config/desktop.json", { token: "synthetic", port: "8992" }); const second = await ensureConfig({ dir, port: 8993 }); assert.equal(second.created, true); assert.equal(second.port, 8993);
  const third = await ensureConfig({ dir, port: 8994 }); assert.equal(third.created, false); assert.equal(third.token, second.token);
  assert.equal(redact(null), ""); assert.equal(redact("same synthetic synthetic", "synthetic"), "same [令牌已隐藏] [令牌已隐藏]");
  const args = buildLaunchArgs({ port: 8995, token: "fixture/& token", profileDir: f.path("profile") }); assert.ok(args[0].endsWith("#token=fixture%2F%26%20token")); assert.ok(!args[0].includes("?token="));
});
test("health retry handles HTTP, malformed JSON, false body, timeout and recovery without network", async () => {
  let count = 0;
  const result = await waitForHealth({ url: "http://fixture.invalid/healthz", intervalMs: 0, timeoutMs: 1000, fetchImpl: async (_url, options) => {
    assert.ok(options.signal instanceof AbortSignal); count++;
    if (count === 1) return { ok: false, status: 503 };
    if (count === 2) return { ok: true, json: async () => { throw new Error("fixture JSON"); } };
    if (count === 3) return { ok: true, json: async () => ({ ok: false }) };
    if (count === 4) throw Object.assign(new Error("fixture timeout"), { name: "TimeoutError" });
    if (count === 5) throw new Error("fixture not ready");
    return { ok: true, json: async () => ({ ok: true, fixture: true }) };
  } }); assert.equal(result.fixture, true); assert.equal(count, 6);
  await assert.rejects(waitForHealth({ timeoutMs: 0, fetchImpl: async () => assert.fail("zero deadline must not fetch") }), { code: "APP_NOT_READY" });
});
test("launcher refuses duplicate ownership without spawning or touching a real home", async t => {
  const f = await fixture(t); await f.put("home/.thu-campus-mcp/app/desktop.json", { token: "fixture-only", port: 8991 });
  const release = await lockfile.lock(f.stateDir, { lockfilePath: path.join(f.stateDir, "desktop.lock") }); f.releases.push(release);
  const acquire = lockfile.lock; let refused = false;
  f.patch(lockfile, "lock", async (...args) => { try { return await acquire(...args); } catch (error) { refused = true; throw error; } });
  await f.start(); await until(() => refused); assert.equal(f.calls.length, 0); assert.equal(f.handlers("SIGINT").length, 0);
});
test("launcher missing runtime exits with install hint but never invokes an installer", async t => {
  const f = await fixture(t); await f.start(); await until(() => process.exitCode === 3); assert.equal(f.calls.length, 0);
});
test("launcher creates owned runtime/window, redacts both streams and handles window close", async t => {
  const f = await fixture(t); await f.installed(); await f.start(); await until(() => f.children.length === 2);
  assert.equal(f.calls[0].executable, process.execPath); assert.ok(f.calls[0].args.includes("serve")); assert.equal(f.calls[1].executable, f.executable); assert.equal(f.calls[1].options.stdio, "ignore");
  const config = JSON.parse(await readFile(path.join(f.stateDir, "desktop.json"), "utf8")); assert.equal(f.calls[0].options.env.THU_CAMPUS_APP_TOKEN, config.token); assert.ok(f.calls[1].args.includes("--user-data-dir=" + path.join(f.stateDir, "desktop-profile")));
  f.children[0].stdout.write("stdout " + config.token); f.children[0].stderr.write("stderr " + config.token);
  await until(async () => (await readFile(path.join(f.stateDir, "desktop.log"), "utf8")).includes("stderr [令牌已隐藏]")); const log = await readFile(path.join(f.stateDir, "desktop.log"), "utf8"); assert.ok(!log.includes(config.token));
  f.children[1].exitCode = 0; f.children[1].emit("exit", 0); await until(() => f.exits.includes(0)); assert.ok(f.children[0].kills.includes("SIGTERM"));
});
test("launcher signal cleanup escalates an unresponsive fake runtime and stays idempotent", async t => {
  const f = await fixture(t); await f.installed(); f.keepRuntime = true; await f.start(); await until(() => f.children.length === 2); f.fastClock();
  const [interrupt] = f.handlers("SIGINT"); interrupt(); await until(() => f.exits.includes(0)); assert.deepEqual(f.children[0].kills, ["SIGTERM", "SIGKILL"]); assert.equal(f.children[1].kills.length, 1);
  interrupt(); await until(() => f.exits.length > 1); assert.equal(f.children[1].kills.length, 1);
});
test("launcher runtime exit propagates failure code and cleans the fake window", async t => {
  for (const code of [7, null]) await t.test(String(code), async ct => {
    const f = await fixture(ct); await f.installed(); await f.start(); await until(() => f.children.length === 2);
    f.children[0].exitCode = code; f.children[0].emit("exit", code); await until(() => process.exitCode === (code ?? 1)); assert.ok(f.children[1].kills.length > 0);
  });
});
test("launcher health deadline maps to exit two and releases its lease", async t => {
  const f = await fixture(t); await f.installed(); f.fastClock(); f.fetch = async () => { throw new Error("fixture unavailable"); };
  await f.start(); await until(() => process.exitCode === 2); assert.equal(f.calls.length, 1); assert.ok(f.children[0].kills.includes("SIGTERM"));
});
test("launcher reports spawn failure and top-level configuration failure without real processes", async t => {
  const f = await fixture(t); await f.installed(); f.spawnFailure = true; await f.start(); await until(() => process.exitCode === 1); assert.equal(f.calls.length, 1);
});
test("launcher top-level catch handles an owned path that is not a directory", async t => {
  const f = await fixture(t); await f.put("home/.thu-campus-mcp/app", "owned file blocks configuration directory"); await f.start(); await until(() => process.exitCode === 1); assert.equal(f.calls.length, 0);
});
