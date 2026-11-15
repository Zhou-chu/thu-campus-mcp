import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { mkdtemp, mkdir, writeFile, readFile, rm, readdir, symlink, realpath } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { chromium } from "playwright-core";
import * as runtime from "../packages/browser/runtime.mjs";
import * as profile from "../packages/browser/profile.mjs";
import * as jobs from "../lib/browser.mjs";
import { browserLogin as madLogin } from "../lib/madmodel/browser.mjs";
import { ORIGIN, LOGIN_URL, parseToken } from "../lib/madmodel/protocol.mjs";
import { SessionManager } from "../lib/madmodel/auth.mjs";

const json = value => JSON.stringify(value);
const cookie = (name, domain, value = "fixture-value", expires = -1) => ({ name, domain, value, path: "/", expires, secure: true, httpOnly: true, sameSite: "Lax" });
const baseCookies = () => [cookie("learn", "learn.tsinghua.edu.cn"), cookie("sso", ".id.tsinghua.edu.cn"), cookie("seahub_auth", "cloud.tsinghua.edu.cn", "fixture@fixture_cloud_token_1234567890"), cookie("sessionid", "pro.yuketang.cn"), cookie("shared", ".yuketang.cn"), cookie("ignored", "example.invalid")];
async function until(fn) {
  const deadline = performance.now() + 3000;
  while (performance.now() < deadline) { if (await fn()) return; await new Promise(resolve => setTimeout(resolve, 5)); }
  assert.fail("owned fixture did not settle");
}
function child() {
  const c = new EventEmitter(); c.stdout = new PassThrough(); c.stderr = new PassThrough(); c.stdin = new PassThrough(); c.pid = 1234567; c.unref = () => {};
  c.finish = (code = 0, output = "") => { if (output) c.stdout.write(output); c.stdout.end(); c.stderr.end(); c.emit("exit", code); c.emit("close", code); };
  return c;
}
async function fixture(t) {
  const qa = path.resolve(import.meta.dirname, "../.local/qa-temp");
  await mkdir(qa, { recursive: true });
  // Hosted-runner TEMP can be an alias; compare the same canonical paths as systemExecutable.
  const parent = await realpath(qa);
  const root = await mkdtemp(path.join(parent, "browser-runtime-owned-")), undos = [], cleanups = [];
  assert.equal(path.dirname(root), parent); assert.match(path.basename(root), /^browser-runtime-owned-/);
  const f = { root, contexts: [], calls: [], intervals: [], cookies: baseCookies(), cryptoFail: false, launches: [], gotoCalls: [] };
  f.path = relative => { const target = path.resolve(root, relative); assert.ok(target.startsWith(root + path.sep)); return target; };
  f.put = async (relative, data) => { const file = f.path(relative); await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, typeof data === "string" ? data : json(data)); return file; };
  f.remove = async relative => { const target = f.path(relative); await rm(target, { recursive: true, force: true }); };
  f.patch = (object, key, value) => { const before = Object.getOwnPropertyDescriptor(object, key); Object.defineProperty(object, key, { value, writable: true, configurable: true, enumerable: before?.enumerable ?? true }); syncBuiltinESMExports(); undos.push(() => { if (before) Object.defineProperty(object, key, before); else delete object[key]; syncBuiltinESMExports(); }); };
  f.env = (key, value) => { const before = process.env[key]; process.env[key] = value; undos.push(() => { if (before === undefined) delete process.env[key]; else process.env[key] = before; }); };
  t.after(async () => {
    for (const close of cleanups.reverse()) await close().catch(() => {});
    for (const context of f.contexts) await context.close().catch(() => {});
    for (const undo of undos.reverse()) undo();
    assert.match(path.basename(root), /^browser-runtime-owned-/); await rm(root, { recursive: true, force: true });
  });
  f.cleanup = fn => cleanups.push(fn);
  f.cfg = { stateDir: f.path("state"), runtimeDir: f.path("runtime") };
  for (const [key, relative] of Object.entries({ THU_BROWSER_STATE_DIR: "state", THU_BROWSER_RUNTIME_DIR: "runtime", LEARNX_STATE_DIR: "learnx", LEARNX_OUTPUT_DIR: "learnx-output", THU_CLOUD_STATE_DIR: "cloud", THU_CLOUD_OUTPUT_DIR: "cloud-output", HETANG_STATE_DIR: "hetang", HETANG_OUTPUT_DIR: "hetang-output", MADMODEL_STATE_DIR: "madmodel", SystemRoot: "fake-windows" })) f.env(key, f.path(relative));
  for (const key of ["THU_CAMPUS_MOCK", "LEARNX_MOCK", "THU_CLOUD_MOCK", "HETANG_MOCK", "THU_CAMPUS_AUTOFILL_LOGIN"]) f.env(key, "0");
  f.patch(process, "platform", "win32");
  f.powershell = await realpath(await f.put("fake-windows/System32/WindowsPowerShell/v1.0/powershell.exe", "never executed: fixture only"));
  f.patch(childProcess, "spawn", (executable, args, options) => {
    f.calls.push({ executable, args, options });
    if (executable === f.powershell) {
      const c = child(); let input = ""; c.stdin.on("data", data => { input += data; });
      c.stdin.on("end", () => queueMicrotask(() => c.finish(f.cryptoFail ? 1 : 0, input))); return c;
    }
    if (f.spawn) return f.spawn(executable, args, options);
    assert.fail(`unexpected process in owned browser fixture: ${path.basename(executable)}`);
  });
  f.patch(globalThis, "fetch", (...args) => { if (f.fetch) return f.fetch(...args); assert.fail("unexpected network request in browser fixture"); });
  const timeout = globalThis.setTimeout;
  f.patch(globalThis, "setTimeout", (fn, ms, ...args) => timeout(fn, [500, 1000, 1500, 2000].includes(ms) ? 0 : ms, ...args));
  f.patch(globalThis, "setInterval", (fn, ms) => { const timer = { unref() {}, fn, ms }; f.intervals.push(timer); return timer; });
  f.patch(chromium, "launch", async options => ({ options, close: async () => {} }));
  f.patch(chromium, "launchPersistentContext", async (directory, options) => {
    assert.ok(directory.startsWith(f.cfg.stateDir + path.sep)); f.launches.push({ directory, options });
    if (f.launchError) throw f.launchError;
    const context = new EventEmitter(); context._closed = false; context._cookies = structuredClone(f.cookies); context._pages = [];
    context.cookies = async () => structuredClone(context._cookies);
    context.addCookies = async values => { context._cookies.push(...structuredClone(values)); };
    context.setStorageState = async value => { context.restored = value; context._cookies = structuredClone(value.cookies); };
    context.storageState = async () => { if (f.onStorage) await f.onStorage(context); return { cookies: structuredClone(context._cookies), origins: [] }; };
    context.pages = () => context._pages;
    context.newPage = async () => {
      const page = { urlText: ORIGIN + "/", setDefaultTimeout(value) { assert.equal(value, 1000); }, isClosed: () => Boolean(f.pageClosed), url: () => f.urls?.length ? f.urls.shift() : page.urlText,
        goto: async url => { f.gotoCalls.push(url); page.urlText = url; if (f.onGoto) await f.onGoto(page, url, context); },
        content: async () => '<meta name="_csrf" content="fixture-csrf">',
        evaluate: async (fn, arg) => fn(arg),
        locator: selector => { const loc = { first: () => loc, count: async () => selector === "#c_code" && f.challenge ? 1 : 0, isVisible: async () => true, getAttribute: async () => null }; return loc; },
      }; context._pages.push(page); return page;
    };
    context.request = { get: async url => {
      if (url.includes("learn.tsinghua.edu.cn/")) return { ok: () => true, json: async () => ({ message: "success", result: { id: "fixture-semester" } }) };
      assert.ok(url.startsWith("https://pro.yuketang.cn/"));
      return { ok: () => true, text: async () => json({ code: 0, data: { userInfo: { userId: "1000001" } } }), headers: () => ({}) };
    } };
    context.close = async () => { if (!context._closed) { context._closed = true; if (f.onClose) await f.onClose(context); context.emit("close"); } };
    if (f.initialPage !== false) await context.newPage(); f.contexts.push(context); return context;
  });
  f.revision = (await runtime.runtimeInfo(f.cfg)).revision;
  f.installed = async () => { f.executable = await f.put("runtime/bin/browser.exe", "dummy executable; not launched"); await f.put("runtime/browser.json", { revision: f.revision, relativeExecutable: "bin/browser.exe" }); return runtime.runtimeInfo(f.cfg); };
  f.snapshot = async state => { await profile.saveSnapshot(f.cfg, state || { cookies: f.cookies, origins: [] }); await f.put("state/snapshot-meta.json", { clean: true }); };
  f.installSpawn = (failure = "") => {
    let stage = 0;
    f.spawn = (executable, args, options) => {
      assert.equal(executable, process.execPath); const c = child(); stage++;
      assert.equal(options.env.PLAYWRIGHT_BROWSERS_PATH, f.cfg.runtimeDir);
      queueMicrotask(() => { void (async () => {
        if (failure === `error${stage}`) { c.emit("error", new Error("fixture spawn failure")); return; }
        if (failure === `exit${stage}`) { c.finish(1); return; }
        if (stage === 1) { assert.ok(args.includes("install")); assert.ok(args.includes("--no-shell")); f.executable = await f.put("runtime/bin/browser.exe", "fixture"); c.finish(); }
        else { assert.ok(args.includes("--input-type=module")); c.finish(0, failure === "outside" ? f.path("outside.exe") : f.executable); }
      })().catch(error => c.emit("error", error)); }); return c;
    };
  };
  f.cloudFetch = () => { f.fetch = async url => { assert.equal(url, "https://cloud.tsinghua.edu.cn/api2/account/info/"); return { ok: true, json: async () => ({ email: "coverage@example.invalid" }) }; }; };
  f.token = account => `fixture.${Buffer.from(json({ zjh: account, exp: Math.floor(Date.now() / 1000) + 3600 })).toString("base64url")}.signature`;
  f.localToken = token => f.patch(globalThis, "localStorage", { getItem: () => f.localValue ?? json({ token }) });
  f.clock = (step = 600) => { let now = Date.now(); f.patch(Date, "now", () => (now += step)); };
  return f;
}

test("runtimeInfo verifies pinned manifest, containment, missing executable and symlink escape", async t => {
  const f = await fixture(t); assert.equal((await runtime.runtimeInfo(f.cfg)).installed, false);
  await f.installed(); assert.equal((await runtime.runtimeInfo(f.cfg)).executablePath, f.executable);
  for (const manifest of [{ revision: "stale", relativeExecutable: "bin/browser.exe" }, { revision: f.revision, relativeExecutable: "../escape.exe" }, { revision: f.revision }]) {
    await f.put("runtime/browser.json", manifest); await assert.rejects(runtime.runtimeInfo(f.cfg), { code: "BROWSER_RUNTIME_INVALID" });
  }
  await f.put("runtime/browser.json", { revision: f.revision, relativeExecutable: "absent.exe" }); assert.equal((await runtime.runtimeInfo(f.cfg)).installed, false);
  await f.remove("runtime/bin"); await f.put("outside/browser.exe", "keep"); await symlink(f.path("outside"), f.path("runtime/bin"), "junction");
  await f.put("runtime/browser.json", { revision: f.revision, relativeExecutable: "bin/browser.exe" }); await assert.rejects(runtime.runtimeInfo(f.cfg), { code: "BROWSER_RUNTIME_INVALID" });
});
test("installRuntime repairs stale metadata with fake installer and never executes/downloads a browser", async t => {
  const f = await fixture(t); await f.put("runtime/browser.json", { revision: "stale" }); f.installSpawn();
  const result = await runtime.installRuntime(f.cfg); assert.equal(result.installed, true); assert.equal(f.calls.length, 2);
  assert.equal((await runtime.installRuntime(f.cfg)).installed, true); assert.equal(f.calls.length, 2);
  const manifest = JSON.parse(await readFile(f.path("runtime/browser.json"), "utf8")); assert.equal(manifest.relativeExecutable, path.join("bin", "browser.exe")); assert.equal(path.isAbsolute(manifest.relativeExecutable), false);
});
test("fake installer failures release the runtime lease and do not escape owned paths", async t => {
  for (const failure of ["error1", "exit1", "error2", "exit2", "outside"]) await t.test(failure, async ct => {
    const f = await fixture(ct); f.installSpawn(failure);
    await assert.rejects(runtime.installRuntime(f.cfg), error => failure === "error2" ? error.message === "fixture spawn failure" : error.code === (failure === "outside" ? "BROWSER_RUNTIME_INVALID" : "BROWSER_INSTALL_FAILED"));
    f.installSpawn(); assert.equal((await runtime.installRuntime(f.cfg)).installed, true);
  });
});
test("ephemeral/channel launches and full snapshot restoration use only fake Chromium", async t => {
  const f = await fixture(t); await assert.rejects(profile.launchEphemeral(f.cfg), { code: "BROWSER_NOT_INSTALLED" });
  await f.installed(); const ephemeral = await profile.launchEphemeral({ ...f.cfg, headless: false }); assert.equal(ephemeral.options.headless, false); assert.equal(ephemeral.options.executablePath, f.executable);
  await f.snapshot(); const b = await profile.openBrowser({ ...f.cfg, headless: true }); f.cleanup(b.close);
  assert.deepEqual(b.context.restored.cookies, f.cookies); assert.equal((await profile.browserStatus(f.cfg)).busy, true); await b.close(); await b.close(); assert.equal((await profile.browserStatus(f.cfg)).snapshotSafeToRestore, true);
  const channel = await profile.openBrowser({ ...f.cfg, channel: "msedge", headless: false }); f.cleanup(channel.close); assert.equal(f.launches.at(-1).options.channel, "msedge"); assert.equal(f.launches.at(-1).options.viewport, null); await channel.close();
});
test("existing native profile restores missing session cookies only; checkpoints deduplicate snapshots", async t => {
  const f = await fixture(t); await f.installed(); await f.put("state/workspace.json", { owner: "thu-campus-browser" }); await f.put("state/profile/fixture", "owned");
  const saved = [cookie("present", ".example.invalid"), cookie("missing", "example.invalid"), cookie("persistent", "example.invalid", "persisted", 4000000000)];
  await f.snapshot({ cookies: saved, origins: [] }); f.cookies = [cookie("present", ".example.invalid", "native")];
  const b = await profile.openBrowser({ ...f.cfg, initialCookies: [cookie("present", "example.invalid"), cookie("initial", "example.invalid")] }); f.cleanup(b.close);
  const cookies = await b.context.cookies(); assert.equal(cookies.find(c => c.name === "present").value, "native"); assert.ok(cookies.some(c => c.name === "missing")); assert.ok(cookies.some(c => c.name === "initial")); assert.ok(!cookies.some(c => c.name === "persistent"));
  await b.checkpoint(); const before = f.calls.length; await b.checkpoint(); assert.equal(f.calls.length, before);
  f.intervals.find(timer => timer.ms === 5000).fn(); await b.checkpoint(); await b.close(); await b.checkpoint();
});
test("profile abort, launch failure, failed checkpoint and page-less close all release ownership", async t => {
  const f = await fixture(t); await f.installed(); const controller = new AbortController(); controller.abort();
  await assert.rejects(profile.openBrowser({ ...f.cfg, signal: controller.signal }), { code: "BROWSER_CANCELLED" });
  f.launchError = new Error("fixture launch"); await assert.rejects(profile.openBrowser(f.cfg), /fixture launch/); f.launchError = undefined;
  const b = await profile.openBrowser(f.cfg); f.cleanup(b.close); f.cryptoFail = true; await assert.rejects(b.close(), { code: "BROWSER_SAVE_FAILED" }); assert.equal((await profile.browserStatus(f.cfg)).busy, false);
  f.initialPage = false; const empty = await profile.openBrowser(f.cfg); f.cleanup(empty.close); await empty.close(); assert.equal((await profile.browserStatus(f.cfg)).snapshotSafeToRestore, false);
  f.cryptoFail = false; const active = new AbortController(); const next = await profile.openBrowser({ ...f.cfg, signal: active.signal }); f.cleanup(next.close); active.abort(); await next.closed; await next.close();
});
test("resetBrowser refuses foreign/symlink profiles, then clears only owned state", async t => {
  const f = await fixture(t); await f.put("state/workspace.json", { owner: "foreign" }); await assert.rejects(profile.profileLease(f.cfg), { code: "BROWSER_UNOWNED_PROFILE" });
  await f.put("state/workspace.json", { owner: "thu-campus-browser" }); await f.put("outside/keep", "keep"); await symlink(f.path("outside"), f.path("state/profile"), "junction");
  await assert.rejects(profile.resetBrowser(f.cfg), { code: "BROWSER_UNSAFE_PATH" }); assert.equal(await readFile(f.path("outside/keep"), "utf8"), "keep"); await f.remove("state/profile");
  for (const name of ["profile/a", "profile-msedge/b", "profile-chrome/c", "session.dpapi", "bindings.json", "snapshot-meta.json"]) await f.put("state/" + name, "owned fixture");
  assert.deepEqual(await profile.resetBrowser(f.cfg), { reset: true, serviceAuthStoresRetained: true }); assert.deepEqual(await readdir(f.cfg.stateDir), ["workspace.json"]);
});
test("browser jobs validate ids/actions, report interrupted workers, sort and cap history", async t => {
  const f = await fixture(t); assert.deepEqual(await jobs.browserJobs(), []); await assert.rejects(jobs.runBrowserJob("../private"), { code: "INVALID_ID" }); await assert.rejects(jobs.startBrowserJob("delete"), { code: "BROWSER_USAGE" }); await assert.rejects(jobs.startBrowserJob("open", "unknown"), { code: "UNKNOWN_SERVICE" });
  await jobs.runBrowserJob(randomUUID()); f.patch(process, "kill", (pid, signal) => { assert.equal(signal, 0); if (pid === 1234567) throw new Error("fixture missing process"); return true; });
  for (let i = 0; i < 23; i++) await f.put(`state/jobs/${randomUUID()}.json`, { id: String(i), status: i === 22 ? "running" : "complete", pid: 1234567, updatedAt: String(i).padStart(4, "0") });
  await f.put("state/jobs/empty.json", null); await f.put("state/jobs/ignored.txt", "not JSON"); const list = await jobs.browserJobs(); assert.equal(list.length, 20); assert.equal(list[0].status, "interrupted");
  assert.equal((await jobs.browserOverview()).jobs.length, 20);
});
test("job catalog reuses only the same target, records spawn errors, and persists stop requests", async t => {
  const f = await fixture(t); f.spawn = (executable, args, options) => { assert.equal(executable, process.execPath); assert.ok(args.includes("worker")); assert.equal(options.detached, true); return child(); };
  const first = await jobs.startBrowserJob("login", "learnx", "fixture-account"); assert.equal((await jobs.startBrowserJob("login", "learnx", "fixture-account")).reused, true); assert.equal((await jobs.startBrowserJob("open", "cloud")).status, "busy");
  assert.equal((await jobs.closeBrowserJobs()).stopRequested, 1); const file = `state/jobs/${first.id}.json`; assert.equal(JSON.parse(await readFile(f.path(file), "utf8")).stop, true);
  await f.put(file, { id: first.id, status: "complete", updatedAt: "0" }); f.spawn = () => { const c = child(); queueMicrotask(() => c.emit("error", new Error("must not be disclosed"))); return c; };
  const failed = await jobs.startBrowserJob("open", "madmodel"); await until(async () => JSON.parse(await readFile(f.path(`state/jobs/${failed.id}.json`), "utf8")).status === "failed"); assert.equal((await jobs.browserJobs())[0].error, "WORKER_START");
});
test("worker simulation, stopped download and four-site open execute real orchestration with fakes", async t => {
  const f = await fixture(t); const save = async (extra = {}) => { const job = { id: randomUUID(), status: "queued", action: "open", service: "all", updatedAt: "0", ...extra }; await f.put(`state/jobs/${job.id}.json`, job); return job; };
  f.env("THU_CAMPUS_MOCK", "1"); let job = await save(); await jobs.runBrowserJob(job.id); assert.equal(JSON.parse(await readFile(f.path(`state/jobs/${job.id}.json`), "utf8")).simulation, true);
  f.env("THU_CAMPUS_MOCK", "0"); f.installSpawn(); job = await save({ stop: true }); await jobs.runBrowserJob(job.id); assert.equal(JSON.parse(await readFile(f.path(`state/jobs/${job.id}.json`), "utf8")).status, "stopped");
  job = await save(); f.onGoto = async (_page, _url, context) => { if (f.gotoCalls.length === 4) context.emit("close"); }; await jobs.runBrowserJob(job.id); assert.equal(f.gotoCalls.length, 4); assert.equal(JSON.parse(await readFile(f.path(`state/jobs/${job.id}.json`), "utf8")).status, "complete");
});
test("worker login routes all real SDK adapters and honors a stop between services", async t => {
  const f = await fixture(t); await f.installed(); f.cloudFetch();
  f.patch(SessionManager.prototype, "ensure", async () => ({})); f.patch(SessionManager.prototype, "status", async () => ({ configured: true }));
  for (const [service, stop] of [["all", false], ["all", true], ["cloud", false]]) {
    const id = randomUUID(), file = `state/jobs/${id}.json`;
    await f.put(file, { id, status: "queued", action: "login", service, account: "fixture-student", updatedAt: "0" });
    f.onClose = stop ? async () => { const raw = JSON.parse(await readFile(f.path(file), "utf8")); await f.put(file, { ...raw, stop: true }); f.intervals.findLast(timer => timer.ms === 500).fn(); } : undefined;
    await jobs.runBrowserJob(id); assert.equal(JSON.parse(await readFile(f.path(file), "utf8")).status, stop ? "stopped" : "complete");
  }
});
test("worker errors store only allowlisted codes and scrub navigation messages", async t => {
  const f = await fixture(t); await f.installed();
  for (const [message, code, detail] of [["timeout secret-token", "SAFE_CODE", "timed out"], ["ERR_ABORTED private-ticket", "unsafe-token", "interrupted"], ["page closed secret", undefined, "closed"], ["unknown user data", undefined, "failed"]]) {
    const id = randomUUID(); await f.put(`state/jobs/${id}.json`, { id, status: "queued", action: "open", service: "cloud", updatedAt: "0" }); f.launchError = Object.assign(new Error(message), code ? { code } : {}); await jobs.runBrowserJob(id);
    const result = JSON.parse(await readFile(f.path(`state/jobs/${id}.json`), "utf8")); assert.equal(result.status, "failed"); assert.equal(result.error, code === "SAFE_CODE" ? code : "BROWSER_FAILED"); assert.ok(result.detail.includes(detail)); assert.ok(!result.detail.includes("secret")); assert.ok(!result.detail.includes("private"));
  }
});
test("real service login adapters save synthetic bindings and stable-cookie recovery", async t => {
  const f = await fixture(t); await f.installed(); f.cloudFetch();
  await assert.rejects(jobs.loginService("learnx", { headless: true }), { code: "BROWSER_ACCOUNT_REQUIRED" });
  // First enrollment uses the interactive API path; headless recovery below requires an existing matching identity.
  const accountIds = {};
  for (const [name, directory, prefix] of [["learnx", "learnx", "LEARNX"], ["cloud", "thu-cloud", "THU_CLOUD"], ["hetang", "hetang", "HETANG"]]) {
    const result = await jobs.loginService(name, { headless: false, account: "fixture-student" }); assert.equal(result.configured, true);
    const { AuthStore: Store } = await import(`../packages/${directory}/dist/auth.js`);
    accountIds[name] = (await new Store(process.env[prefix + "_STATE_DIR"]).status()).accountId;
    assert.equal(result.accountId, accountIds[name]);
  }
  const bindings = JSON.parse(await readFile(f.path("state/bindings.json"), "utf8")); assert.deepEqual(Object.keys(bindings).sort(), ["cloud", "hetang", "learnx"]); assert.equal(bindings.learnx.cookieDigest.length, 64);
  for (const name of Object.keys(accountIds)) assert.equal(bindings[name].accountId, accountIds[name]);
  const snapshot = await profile.readSnapshot(f.cfg); snapshot.cookies.find(c => c.name === "learn").value = "rotated-fixture"; await profile.saveSnapshot(f.cfg, snapshot); assert.equal(await jobs.restoreService("learnx"), true);
  bindings.learnx.accountId = "different-fixture-account"; await f.put("state/bindings.json", bindings); assert.equal(await jobs.restoreService("learnx"), false); assert.equal(await jobs.restoreService("unknown"), false);
  const { AuthStore } = await import("../packages/learnx/dist/auth.js"); const store = new AuthStore(process.env.LEARNX_STATE_DIR); await assert.rejects(jobs.loginService("learnx", { headless: true, guard: { accountId: "other" } }), { code: "AUTH_CHANGED" }); await store.clear(); assert.equal(await jobs.restoreService("learnx"), false);
});
test("login binding rejects auth changed after browser save; MadModel wrapper uses existing manager seam", async t => {
  const f = await fixture(t); await f.installed(); let changed = false;
  f.onStorage = async () => { if (!changed) { changed = true; const { AuthStore } = await import("../packages/learnx/dist/auth.js"); await new AuthStore(process.env.LEARNX_STATE_DIR).clear(); } };
  await assert.rejects(jobs.loginService("learnx", { headless: true, account: "fixture-student" }), { code: "AUTH_CHANGED" });
  let configured = false, ensures = 0; f.patch(SessionManager.prototype, "status", async () => ({ configured })); f.patch(SessionManager.prototype, "ensure", async options => { ensures++; assert.equal(options.force, true); return {}; });
  assert.equal(await jobs.restoreService("madmodel"), false); configured = true; assert.equal(await jobs.restoreService("madmodel"), true); assert.deepEqual(await jobs.loginService("madmodel", { headless: true }), { configured: true }); assert.equal(ensures, 2);
});
test("MadModel refuses unsafe snapshot, verifies synthetic token, new page and account mismatch", async t => {
  const f = await fixture(t); await f.installed(); const token = f.token("fixture-account"); f.localToken(token);
  await assert.rejects(madLogin({ headless: true, verify: async () => true }), { code: "BROWSER_LOGIN_REQUIRED" }); await f.snapshot();
  f.initialPage = false; const session = await madLogin({ previous: { account: "fixture-account" }, verify: async value => value === token, timeoutMs: 1000 }); assert.equal(session.accountId, parseToken(token).accountId);
  await assert.rejects(madLogin({ previous: { accountId: "different" }, verify: async () => true, timeoutMs: 1000 }), { code: "BROWSER_ACCOUNT_MISMATCH" });
  await assert.rejects(madLogin({ previous: { account: "different" }, verify: async () => true, timeoutMs: 1000 }), { code: "BROWSER_ACCOUNT_MISMATCH" });
});
test("MadModel forced fast callback, interrupted navigation and automatic SSO fallback", async t => {
  const f = await fixture(t); await f.installed(); await f.snapshot(); const token = f.token("fixture-account"); f.localToken(token);
  f.onGoto = async (page, url) => { page.urlText = ORIGIN + "/"; if (url === LOGIN_URL) throw new Error("ERR_ABORTED fixture redirect"); };
  assert.equal((await madLogin({ force: true, previous: { token: "old-fixture", account: "fixture-account" }, verify: async () => true, timeoutMs: 1000 })).token, token);
  f.gotoCalls.length = 0; f.clock(); f.onGoto = async (page, url) => { if (url === LOGIN_URL) { f.urls = [ORIGIN + "/authLogin", ORIGIN + "/"]; page.urlText = ORIGIN + "/"; } };
  assert.equal((await madLogin({ verify: async () => f.gotoCalls.includes(LOGIN_URL), timeoutMs: 10000 })).token, token); assert.ok(f.gotoCalls.includes(LOGIN_URL));
});
test("MadModel rejects closed window, fatal navigation, challenge, abort and malformed/expired token timeouts", async t => {
  const f = await fixture(t); await f.installed(); await f.snapshot(); f.localToken(f.token("fixture"));
  f.pageClosed = true; await assert.rejects(madLogin({ verify: async () => true }), /登录窗口已关闭/); f.pageClosed = false;
  f.onGoto = async () => { throw new Error("fixture navigation failure"); }; await assert.rejects(madLogin({ verify: async () => true }), /fixture navigation failure/); f.onGoto = undefined;
  f.env("THU_CAMPUS_AUTOFILL_LOGIN", "1"); f.challenge = true; await assert.rejects(madLogin({ force: true, verify: async () => false, timeoutMs: 1000 }), { code: "VERIFICATION_REQUIRED" }); f.env("THU_CAMPUS_AUTOFILL_LOGIN", "0");
  const abort = new AbortController(); f.onGoto = async () => abort.abort(); await assert.rejects(madLogin({ signal: abort.signal, verify: async () => true }), { name: "AbortError" }); f.onGoto = undefined;
  f.clock(10); f.onGoto = async page => { page.urlText = ORIGIN + "/"; };
  for (const [value, interactive] of [["malformed JSON", false], [json({ token: "not-jwt" }), false], [json({ token: "fixture." + Buffer.from(json({ zjh: "fixture", exp: 1 })).toString("base64url") + ".signature" }), true]]) {
    f.localValue = value; await assert.rejects(madLogin({ force: true, timeoutMs: 50, interactive, verify: async () => false }), { code: "BROWSER_LOGIN_REQUIRED" });
  }
});
