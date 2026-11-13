import { test } from "node:test";
import assert from "node:assert/strict";
import { WorkspaceHost, createWorkspaceHost } from "../lib/app/workspace.mjs";
import { CloudWorkspaceFiles } from "../lib/app/cloud-workspace.mjs";
import { appConfig } from "../lib/app/settings.mjs";
const A = "11111111-1111-4111-8111-111111111111", J = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", K = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const error = (code) => Object.assign(new Error(code), { code });
const tick = () => new Promise(resolve => setImmediate(resolve));
function fixture() {
  let listener, sync = async () => ({ mode: "cloud", state: "synced", files: 2 });
  const calls = [], scope = { accountId: "a".repeat(32), repoId: J, rootPath: "/Agent工作区" };
  const plan = { approvalArgs: { ...scope, expectedRepoId: J, creates: ["/Agent工作区", "private marker", "sessions"] }, risk: "精确全私有范围" };
  const files = {
    status: async () => ({ mode: "cloud", state: "uninitialized", scope, privacy: { verified: true } }),
    prepareInitialization: async () => plan,
    initialize: async ({ prepared, approved }) => { assert.equal(prepared, plan); assert.equal(approved, true); calls.push("initialize"); return { mode: "cloud", state: "ready" }; },
    sync: async sid => { assert.equal(sid, A); calls.push("sync"); return sync(); },
    root: async () => { calls.push("root"); return "/cache"; },
  };
  const sandbox = {
    onComplete: fn => { listener = fn; return () => { listener = undefined; calls.push("unsubscribe"); }; },
    status: async () => ({ available: true }), run: async () => ({ jobId: J, state: "running" }),
    get: async () => ({ jobId: J, state: "succeeded", exitCode: 0 }),
    close: async () => { calls.push("sandbox-close"); },
  };
  const base = {
    describe: () => [{ name: "campus_read" }, { name: "cloud_workspace_push" }],
    toolForModel: () => ["campus_read", "cloud_workspace_push"].map(name => ({ type: "function", function: { name } })),
    close: async () => { calls.push("host-close"); },
  };
  const host = new WorkspaceHost({ host: base, files, sandbox });
  return { host, files, sandbox, calls, plan, scope, complete: (job) => listener({ sessionId: A, job }), setSync: value => { sync = value; } };
}
const ctx = extra => ({ sessionId: A, ...extra });
test("default cloud and explicit local mode; invalid mode rejected before start", () => {
  assert.equal(appConfig({}).workspaceStorage, "cloud");
  assert.equal(appConfig({ THU_CAMPUS_APP_WORKSPACE_STORAGE: "local" }).workspaceStorage, "local");
  assert.throws(() => appConfig({ THU_CAMPUS_APP_WORKSPACE_STORAGE: "host" }), e => e.code === "INVALID_SETTINGS");
  const base = { describe: () => [], toolForModel: () => [], call: async () => assert.fail("factory must not perform network requests") };
  const built = createWorkspaceHost({ host: base, stateDir: ".local/factory-no-io" });
  assert.ok(built.workspaceFiles instanceof CloudWorkspaceFiles);
  assert.throws(() => createWorkspaceHost({ host: base, stateDir: ".local/no-io", storageMode: "fallback" }), e => e.code === "INVALID_SETTINGS");
});
test("internal cloud capabilities are hidden and direct calls cannot self-approve", async () => {
  const f = fixture();
  assert.ok(!f.host.describe().some(t => t.name.startsWith("cloud_workspace_")));
  assert.ok(!f.host.toolForModel().some(t => t.function.name.startsWith("cloud_workspace_")));
  assert.equal((await f.host.call("cloud_workspace_push", { approved: true }, ctx({ approved: true }))).error.code, "WORKSPACE_INTERNAL_ONLY");
  const status = await f.host.call("workspace_status", {}, ctx());
  assert.equal(status.data.storage.state, "uninitialized"); assert.equal(status.data.directory, undefined);
  assert.deepEqual(f.calls, []); // Neither status nor uninitialized scope creates a remote/local workspace.
  f.files.status = async () => ({ mode: "cloud", state: "ready" });
  assert.equal((await f.host.call("workspace_status", {}, ctx())).data.directory, "/cache");
});
test("initialize binds original private preview and cannot be self-approved", async () => {
  const f = fixture();
  assert.equal((await f.host.call("workspace_initialize", {}, ctx())).error.code, "APPROVAL_REQUIRED");
  assert.equal((await f.host.call("workspace_initialize", { accountId: "invented" }, ctx({ approved: true }))).error.code, "INVALID_ARGUMENTS");
  const prepared = await f.host.prepareCall("workspace_initialize", {}, ctx());
  assert.equal(prepared.mandatoryApproval, true); assert.equal(prepared.storagePrepared, f.plan); assert.equal(prepared.approvalArgs.rootPath, "/Agent工作区");
  assert.equal((await f.host.call("workspace_initialize", {}, ctx({ prepared, approved: true }))).data.state, "ready");
  assert.deepEqual(f.calls, ["initialize"]);
  f.host.cloud = false;
  await assert.rejects(f.host.prepareCall("workspace_initialize", {}, ctx()), e => e.code === "CLOUD_NOT_ENABLED");
  await assert.rejects(f.host.syncSession(A), e => e.code === "CLOUD_NOT_ENABLED");
});
test("terminal compute result and cloud sync failure remain independent; GET decorates only", async () => {
  const f = fixture(); f.setSync(async () => { throw error("NETWORK_ERROR"); });
  const raw = { jobId: J, state: "succeeded", exitCode: 0 };
  await f.complete(raw);
  const data = f.host.job(A, raw);
  assert.equal(data.state, "succeeded"); assert.equal(data.exitCode, 0); assert.equal(data.storage.state, "failed"); assert.equal(data.storage.code, "NETWORK_ERROR");
  const before = f.calls.length;
  f.host.job(A, raw); f.host.job(A, raw); assert.equal(f.calls.length, before);
  f.setSync(async () => ({ mode: "cloud", state: "synced", files: 2 }));
  assert.equal((await f.host.call("workspace_sync", {}, ctx())).data.state, "synced");
  assert.equal(f.host.job(A, raw).storage.state, "synced");
});
test("fake or incomplete sync receipts are never promoted to synced", async () => {
  const f = fixture(); f.setSync(async () => ({ saved: true }));
  await f.complete({ jobId: J, state: "failed", exitCode: 1 });
  assert.equal(f.host.job(A, { jobId: J, state: "failed" }).storage.code, "CLOUD_SYNC_UNVERIFIED");
  assert.equal(f.host.job(A, { jobId: J, state: "failed" }).state, "failed");
  f.setSync(async () => { throw {}; });
  await f.complete({ jobId: J, state: "cancelled" });
  assert.equal(f.host.job(A, { jobId: J, state: "cancelled" }).storage.code, "CLOUD_SYNC_FAILED");
});
test("running jobs delay upload and manual sync; last terminal job starts it", async () => {
  const f = fixture();
  f.host.jobs.set(`${A}:${J}`, { sessionId: A, jobId: J, state: "running" });
  f.host.jobs.set(`${A}:${K}`, { sessionId: A, jobId: K, state: "running" }); f.host.changed(A);
  assert.equal((await f.host.call("workspace_sync", {}, ctx())).error.code, "WORKSPACE_BUSY");
  await f.complete({ jobId: J, state: "failed" }); assert.equal(f.calls.length, 0);
  await f.complete({ jobId: K, state: "succeeded" }); assert.equal(f.calls.filter(x => x === "sync").length, 1);
});
test("overlapping terminal notifications are coalesced then rescanned, not falsely complete", async () => {
  const f = fixture(); let release, count = 0;
  f.setSync(async () => { count++; if (count === 1) await new Promise(resolve => { release = resolve; }); return { mode: "cloud", state: "synced" }; });
  const first = f.complete({ jobId: J, state: "succeeded" });
  await tick(); const second = f.complete({ jobId: K, state: "succeeded" }); release();
  await Promise.all([first, second]); assert.equal(count, 2); assert.equal(f.host.job(A, { jobId: K, state: "succeeded" }).storage.state, "synced");
});
test("a new running job during upload keeps pending until its terminal notification", async () => {
  const f = fixture(); let release;
  f.setSync(async () => { await new Promise(resolve => { release = resolve; }); return { mode: "cloud", state: "synced" }; });
  const first = f.complete({ jobId: J, state: "succeeded" }); await tick();
  f.host.jobs.set(`${A}:${K}`, { sessionId: A, jobId: K, state: "running" }); f.host.changed(A); release(); await first;
  assert.equal(f.host.job(A, { jobId: K, state: "running" }).storage.state, "pending");
  f.setSync(async () => ({ mode: "cloud", state: "synced" })); await f.complete({ jobId: K, state: "cancelled" });
  assert.equal(f.host.job(A, { jobId: K, state: "cancelled" }).storage.state, "synced");
});
test("restart without verified sync history remains unverified; close drains owned sync", async () => {
  const f = fixture();
  assert.equal(f.host.job(A, { jobId: J, state: "succeeded" }).storage.code, "SYNC_UNVERIFIED");
  assert.equal(f.host.job(A, { jobId: J, state: "running" }).storage.state, "pending");
  let release; f.setSync(async () => { await new Promise(resolve => { release = resolve; }); return { mode: "cloud", state: "synced" }; });
  const pending = f.complete({ jobId: J, state: "succeeded" }); await tick(); const closing = f.host.close();
  await tick(); assert.ok(!f.calls.includes("host-close")); release(); await Promise.all([pending, closing]); await f.host.close();
  assert.equal(f.calls.filter(x => x === "host-close").length, 1); assert.ok(f.calls.indexOf("unsubscribe") < f.calls.indexOf("host-close"));
});
test("unconfirmed recovered container blocks cloud sync and job offers cleanup recovery", async () => {
  const f = fixture(); f.sandbox.initialize = async () => { f.sandbox.hasActiveJobs = () => true; };
  const result = await f.host.call("workspace_sync", {}, ctx());
  assert.equal(result.error.code, "WORKSPACE_BUSY"); assert.deepEqual(f.calls, []);
  const job = f.host.job(A, { jobId: J, state: "interrupted", cleanupPending: true });
  assert.equal(job.storage.code, "SANDBOX_CLEANUP_PENDING"); assert.equal(job.cleanupPending, true);
});
