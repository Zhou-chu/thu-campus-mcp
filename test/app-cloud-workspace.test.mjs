import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile, lstat } from "node:fs/promises";
import { CloudWorkspaceFiles } from "../lib/app/cloud-workspace.mjs";

const ACCOUNT = "0cb746ea74939fc2513685d4316b2e5c";
const OTHER_ACCOUNT = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const REPO = "3b20ae7f-d90d-4fa9-985e-716530d9b46c";
const ROOT = "/Agent工作区";
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const accountDir = (accountId) => createHash("sha256").update(accountId.toLowerCase()).digest("hex").slice(0, 32);

async function exists(target) {
  return lstat(target).then(() => true, (error) => {
    if (error?.code === "ENOENT") return false;
    throw error;
  });
}

/** 假 base ToolHost：只实现契约里的 5 个 cloud_workspace_* 工具。 */
class FakeCloud {
  constructor(dir) {
    this.dir = dir;
    this.pullDir = path.join(dir, "backend-pull");
    this.calls = [];
    this.remote = new Map();
    this.accountId = ACCOUNT;
    this.state = "ready";
    this.privacy = { verified: true, checkedAt: "2026-11-14T00:00:00.000Z", code: "PRIVATE_SCOPE_VERIFIED" };
    this.includePrivacy = true;
    this.includeScope = true;
    this.includeIdentity = true;
    this.statusError = null;
    this.statusReply = null;
    this.listError = null;
    this.listOverride = null;
    this.pushOverride = null;
    this.pullOverride = null;
    this.initReply = null;
    this.reconciledWrite = true;
    this.onPush = null;
    this.hostThrows = false;
    this.nullReply = false;
    this.sequence = 0;
  }
  async call(name, args) {
    this.calls.push({ name, args });
    if (this.hostThrows) throw new Error("bridge down");
    if (this.nullReply) return null;
    switch (name) {
      case "cloud_workspace_status": return this.status();
      case "cloud_workspace_init": return this.init(args);
      case "cloud_workspace_list": return this.list(args);
      case "cloud_workspace_pull": return this.pull(args);
      case "cloud_workspace_push": return this.push(args);
      default: return { ok: false, error: { code: "UNKNOWN_TOOL", message: "没有此工具。" } };
    }
  }
  callsOf(name) {
    return this.calls.filter((item) => item.name === name);
  }
  scope() {
    return { accountId: this.accountId, repoId: REPO, rootPath: ROOT };
  }
  status() {
    if (this.statusReply) return this.statusReply;
    if (this.statusError) return { ok: false, error: this.statusError };
    if (!this.includeIdentity) return { ok: true, data: { storage: { state: this.state, privacy: this.privacy } } };
    if (this.state === "login-required")
      return { ok: true, data: { storage: { state: "login-required", privacy: { verified: false, checkedAt: "2026-11-14T00:00:00.000Z", code: "AUTH_REQUIRED" } } } };
    const storage = { state: this.state, repoId: REPO, rootPath: ROOT };
    if (this.includePrivacy) storage.privacy = this.privacy;
    if (this.includeScope) storage.scope = this.scope();
    return { ok: true, data: { accountId: this.accountId, storage } };
  }
  async init(args) {
    if (this.initReply) return this.initReply;
    this.state = "ready";
    return { ok: true, data: { accountId: args.accountId, storage: { state: "ready", repoId: REPO, rootPath: ROOT, privacy: this.privacy, scope: this.scope() } } };
  }
  async push(args) {
    const existing = this.remote.get(args.path);
    if (this.pushOverride) {
      const override = this.pushOverride;
      this.pushOverride = null;
      const reply = await override(args, existing);
      if (reply) return reply;
    }
    const bytes = await readFile(args.sourcePath);
    if (existing) {
      if (!args.overwrite) return { ok: false, error: { code: "WORKSPACE_CONFLICT", message: "云端已存在该文件。" } };
      if (!args.expectedRemoteId || args.expectedRemoteId !== existing.remoteId)
        return { ok: false, error: { code: "WORKSPACE_CONFLICT", message: "云端版本已变化。" } };
    } else if (args.overwrite) {
      return { ok: false, error: { code: "WORKSPACE_NOT_FOUND", message: "云端没有该文件。" } };
    }
    const remoteId = existing?.remoteId || `rid-${++this.sequence}`;
    this.remote.set(args.path, { bytes, remoteId });
    const reply = {
      ok: true,
      data: { accountId: args.accountId, sessionId: args.sessionId, path: args.path, remoteId, sha256: sha(bytes), bytes: bytes.length, operationId: `op-${++this.sequence}`, verification: "server-metadata", atomicReplace: false },
    };
    if (this.onPush) this.onPush(args, reply);
    return reply;
  }
  async pull(args) {
    if (this.pullOverride) {
      const override = this.pullOverride;
      this.pullOverride = null;
      const reply = await override(args);
      if (reply) return reply;
    }
    const existing = this.remote.get(args.path);
    if (!existing) return { ok: false, error: { code: "WORKSPACE_NOT_FOUND", message: "云端没有该文件。" } };
    await mkdir(this.pullDir, { recursive: true });
    const localPath = path.join(this.pullDir, `${++this.sequence}-content`);
    await writeFile(localPath, existing.bytes);
    return {
      ok: true,
      data: { accountId: args.accountId, sessionId: args.sessionId, path: args.path, localPath, sha256: sha(existing.bytes), remoteId: existing.remoteId, bytes: existing.bytes.length, reconciledWrite: this.reconciledWrite !== false },
    };
  }
  async list(args) {
    if (this.listOverride) {
      const override = this.listOverride;
      this.listOverride = null;
      const reply = await override(args);
      if (reply) return reply;
    }
    if (this.listError) return { ok: false, error: this.listError };
    const base = args.path === "." ? "" : `${args.path.replace(/\/+$/, "")}/`;
    const entries = [];
    for (const [relative, value] of this.remote) {
      if (base && !relative.startsWith(base)) continue;
      if (!args.recursive && relative.slice(base.length).includes("/")) continue;
      entries.push({ path: relative, type: "file", remoteId: value.remoteId, size: value.bytes.length });
    }
    return { ok: true, data: { accountId: args.accountId, sessionId: args.sessionId, path: args.path, entries, complete: true } };
  }
}

async function fixture(options = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "thu-cloud-workspace-"));
  const stateDir = path.join(root, "state");
  await mkdir(stateDir, { recursive: true });
  const cloud = new FakeCloud(path.join(root, "backend"));
  const files = new CloudWorkspaceFiles({ host: cloud, stateDir, limits: options.limits });
  return {
    root,
    stateDir,
    cloud,
    files,
    sid: randomUUID(),
    cacheDir(accountId = cloud.accountId) {
      return path.join(stateDir, "workspaces", "cloud-cache", accountDir(accountId));
    },
    sessionDir(accountId = cloud.accountId, sid = this.sid) {
      return path.join(stateDir, "workspaces", "cloud-cache", accountDir(accountId), sid);
    },
    journalFile: path.join(stateDir, "cloud-workspace", "journal.json"),
    async cleanup() {
      await rm(root, { recursive: true, force: true });
    },
  };
}

async function journalOf(context) {
  return JSON.parse(await readFile(context.journalFile, "utf8"));
}

test("constructor rejects missing host or state directory", async () => {
  assert.throws(() => new CloudWorkspaceFiles({ stateDir: "x" }), (error) => error.code === "INVALID_ARGUMENTS");
  assert.throws(() => new CloudWorkspaceFiles({ host: { call() {} } }), (error) => error.code === "INVALID_ARGUMENTS");
});

test("status maps a verified ready workspace with its exact scope", async (t) => {
  const context = await fixture();
  t.after(() => context.cleanup());
  const storage = await context.files.status();
  assert.deepEqual(storage.scope, { accountId: ACCOUNT, repoId: REPO, rootPath: ROOT });
  assert.equal(storage.mode, "cloud");
  assert.equal(storage.state, "ready");
  assert.deepEqual(storage.privacy, { verified: true, checkedAt: "2026-11-14T00:00:00.000Z", code: "PRIVATE_SCOPE_VERIFIED" });
});

test("status downgrades ready when privacy verification is missing", async (t) => {
  const context = await fixture();
  t.after(() => context.cleanup());
  context.cloud.includePrivacy = false;
  const storage = await context.files.status();
  assert.equal(storage.state, "unverified");
  assert.equal(storage.code, "CLOUD_SCOPE_UNVERIFIED");
});

test("status keeps the preview scope for an uninitialized workspace", async (t) => {
  const context = await fixture();
  t.after(() => context.cleanup());
  context.cloud.state = "uninitialized";
  const storage = await context.files.status();
  assert.equal(storage.state, "uninitialized");
  assert.equal(storage.scope.repoId, REPO);
});

test("status maps bridge failures to login-required or unavailable", async (t) => {
  const context = await fixture();
  t.after(() => context.cleanup());
  context.cloud.statusError = { code: "AUTH_REQUIRED", message: "需要登录。" };
  assert.equal((await context.files.status()).state, "login-required");
  context.cloud.statusError = { code: "WEIRD", message: "未知故障。" };
  const unavailable = await context.files.status();
  assert.equal(unavailable.state, "unavailable");
  assert.equal(unavailable.code, "WEIRD");
  context.cloud.statusError = null;
  context.cloud.hostThrows = true;
  assert.equal((await context.files.status()).state, "unavailable");
  context.cloud.hostThrows = false;
  context.cloud.statusReply = { ok: true, data: { storage: { state: "nonsense" } } };
  assert.equal((await context.files.status()).state, "unavailable");
});

test("status is read-only: no cache directory and no journal is created", async (t) => {
  const context = await fixture();
  t.after(() => context.cleanup());
  await context.files.status();
  assert.equal(await exists(path.join(context.stateDir, "workspaces")), false);
  assert.equal(await exists(context.journalFile), false);
});

test("prepareInitialization exposes the exact scope without touching the cloud", async (t) => {
  const context = await fixture();
  t.after(() => context.cleanup());
  context.cloud.state = "uninitialized";
  const prepared = await context.files.prepareInitialization();
  assert.equal(prepared.approvalArgs.accountId, ACCOUNT);
  assert.equal(prepared.approvalArgs.expectedRepoId, REPO);
  assert.equal(prepared.approvalArgs.root, ROOT);
  assert.deepEqual(prepared.approvalArgs.creates, ["/Agent工作区", "私有marker", "sessions"]);
  assert.equal(typeof prepared.risk, "string");
  assert.ok(prepared.risk.length > 10);
  assert.equal(context.cloud.callsOf("cloud_workspace_init").length, 0);
});

test("prepareInitialization refuses ready, offline and scopeless states", async (t) => {
  const context = await fixture();
  t.after(() => context.cleanup());
  await assert.rejects(context.files.prepareInitialization(), (error) => error.code === "CLOUD_ALREADY_INITIALIZED");
  context.cloud.state = "login-required";
  await assert.rejects(context.files.prepareInitialization(), (error) => error.code === "CLOUD_LOGIN_REQUIRED");
  context.cloud.statusError = { code: "AUTH_REQUIRED", message: "需要登录。" };
  await assert.rejects(context.files.prepareInitialization(), (error) => ["CLOUD_LOGIN_REQUIRED", "CLOUD_UNAVAILABLE"].includes(error.code));
  context.cloud.statusError = null;
  context.cloud.state = "uninitialized";
  context.cloud.includeIdentity = false;
  await assert.rejects(context.files.prepareInitialization(), (error) => error.code === "CLOUD_SCOPE_UNVERIFIED");
});

test("initialize requires the original prepared object and one-time approval", async (t) => {
  const context = await fixture();
  t.after(() => context.cleanup());
  context.cloud.state = "uninitialized";
  const prepared = await context.files.prepareInitialization();
  await assert.rejects(context.files.initialize({ prepared: { approvalArgs: prepared.approvalArgs }, approved: true }), (error) => error.code === "CLOUD_APPROVAL_REQUIRED");
  await assert.rejects(context.files.initialize({ prepared, approved: false }), (error) => error.code === "CLOUD_APPROVAL_REQUIRED");
  const done = await context.files.initialize({ prepared, approved: true });
  assert.equal(done.state, "ready");
  const initCall = context.cloud.callsOf("cloud_workspace_init")[0];
  assert.deepEqual(initCall.args, { accountId: ACCOUNT, expectedRepoId: REPO });
  await assert.rejects(context.files.initialize({ prepared, approved: true }), (error) => error.code === "CLOUD_APPROVAL_CONSUMED");
});

test("initialize fails closed when the cloud account changed after preparation", async (t) => {
  const context = await fixture();
  t.after(() => context.cleanup());
  context.cloud.state = "uninitialized";
  const prepared = await context.files.prepareInitialization();
  context.cloud.accountId = OTHER_ACCOUNT;
  await assert.rejects(context.files.initialize({ prepared, approved: true }), (error) => error.code === "CLOUD_ACCOUNT_MISMATCH");
  assert.equal(context.cloud.callsOf("cloud_workspace_init").length, 0);
});

test("initialize reports unverified when the post-check is not ready", async (t) => {
  const context = await fixture();
  t.after(() => context.cleanup());
  context.cloud.state = "uninitialized";
  const prepared = await context.files.prepareInitialization();
  context.cloud.initReply = { ok: true, data: { accountId: ACCOUNT } };
  await assert.rejects(context.files.initialize({ prepared, approved: true }), (error) => error.code === "CLOUD_INIT_UNVERIFIED");
});

test("root requires active readiness and binds the session to the account hash", async (t) => {
  const context = await fixture();
  t.after(() => context.cleanup());
  context.cloud.state = "uninitialized";
  await assert.rejects(context.files.root(context.sid), (error) => error.code === "CLOUD_UNINITIALIZED");
  context.cloud.state = "ready";
  const root = await context.files.root(context.sid);
  assert.equal(root, context.sessionDir());
  assert.equal(await exists(root), true);
  const journal = await journalOf(context);
  assert.equal(journal.sessions[context.sid].accountId, ACCOUNT);
  assert.equal(journal.sessions[context.sid].accountHash, accountDir(ACCOUNT));
});

test("root refuses a second cloud account for an already bound session", async (t) => {
  const context = await fixture();
  t.after(() => context.cleanup());
  await context.files.root(context.sid);
  context.cloud.accountId = OTHER_ACCOUNT;
  await assert.rejects(context.files.root(context.sid), (error) => error.code === "CLOUD_ACCOUNT_MISMATCH");
  assert.equal(await exists(context.sessionDir(OTHER_ACCOUNT)), false);
});

test("resolve rejects escapes and needs an existing local cache", async (t) => {
  const context = await fixture();
  t.after(() => context.cleanup());
  await assert.rejects(context.files.resolve(context.sid, "a.txt"), (error) => error.code === "CLOUD_CACHE_ABSENT");
  await context.files.root(context.sid);
  await assert.rejects(context.files.resolve(context.sid, "../escape.txt"), (error) => error.code === "PATH_ESCAPE");
  await assert.rejects(context.files.resolve(context.sid, "/etc/passwd"), (error) => error.code === "INVALID_PATH");
  await assert.rejects(context.files.resolve(context.sid, "missing.txt"), (error) => error.code === "FILE_NOT_FOUND");
  assert.equal(await context.files.resolve(context.sid, "later.txt", { mustExist: false }), path.join(context.sessionDir(), "later.txt"));
});

test("write stores locally, uploads once and records the journal", async (t) => {
  const context = await fixture();
  t.after(() => context.cleanup());
  const result = await context.files.write(context.sid, { path: "notes/a.txt", text: "hello" });
  assert.equal(await readFile(path.join(context.sessionDir(), "notes/a.txt"), "utf8"), "hello");
  const pushes = context.cloud.callsOf("cloud_workspace_push");
  assert.equal(pushes.length, 1);
  assert.equal(pushes[0].args.path, "notes/a.txt");
  assert.equal(pushes[0].args.sourcePath, path.join(context.sessionDir(), "notes/a.txt"));
  assert.equal(pushes[0].args.overwrite, undefined);
  assert.equal(result.storage.state, "synced");
  assert.equal(result.storage.files.length, 1);
  const journal = await journalOf(context);
  assert.equal(journal.sessions[context.sid].files["notes/a.txt"].sha256, sha(Buffer.from("hello")));
  assert.equal(context.cloud.remote.get("notes/a.txt").remoteId, journal.sessions[context.sid].files["notes/a.txt"].remoteId);
});

test("write keeps the local file and reports unconfirmed when upload fails", async (t) => {
  const context = await fixture();
  t.after(() => context.cleanup());
  context.cloud.pushOverride = async () => ({ ok: false, error: { code: "WORKSPACE_WRITE_FAILED", message: "云盘拒绝写入。" } });
  const result = await context.files.write(context.sid, { path: "a.txt", text: "payload" });
  assert.equal(await readFile(path.join(context.sessionDir(), "a.txt"), "utf8"), "payload");
  assert.equal(result.storage.state, "unconfirmed");
  assert.equal(result.storage.code, "WORKSPACE_WRITE_FAILED");
  assert.match(result.storage.message, /本地已完成写入/);
  const journal = await journalOf(context);
  assert.equal(journal.sessions[context.sid].files["a.txt"], undefined);
});

test("write is blocked offline instead of silently falling back to local", async (t) => {
  const context = await fixture();
  t.after(() => context.cleanup());
  context.cloud.state = "login-required";
  await assert.rejects(context.files.write(context.sid, { path: "a.txt", text: "x" }), (error) => error.code === "CLOUD_LOGIN_REQUIRED");
  assert.equal(await exists(context.sessionDir()), false);
  assert.equal(context.cloud.callsOf("cloud_workspace_push").length, 0);
});

test("write aborts when the cloud account changes during the operation", async (t) => {
  const context = await fixture();
  t.after(() => context.cleanup());
  const boundDir = context.sessionDir();
  context.cloud.onPush = () => {
    context.cloud.accountId = OTHER_ACCOUNT;
  };
  await assert.rejects(context.files.write(context.sid, { path: "a.txt", text: "x" }), (error) => error.code === "CLOUD_ACCOUNT_MISMATCH");
  assert.equal(await readFile(path.join(boundDir, "a.txt"), "utf8"), "x");
});

test("writeBytes honours overwrite rules and never uploads sandbox runtime scripts", async (t) => {
  const context = await fixture();
  t.after(() => context.cleanup());
  await context.files.writeBytes(context.sid, { path: "a.bin", bytes: Buffer.from("one") });
  await assert.rejects(context.files.writeBytes(context.sid, { path: "a.bin", bytes: Buffer.from("two") }), (error) => error.code === "FILE_EXISTS");
  const overwritten = await context.files.writeBytes(context.sid, { path: "a.bin", bytes: Buffer.from("two"), overwrite: true });
  assert.equal(overwritten.storage.state, "synced");
  const update = context.cloud.callsOf("cloud_workspace_push").at(-1).args;
  assert.equal(update.overwrite, true);
  assert.equal(typeof update.expectedRemoteId, "string");
  const runtime = await context.files.writeBytes(context.sid, { path: ".sandbox-script-job.py", bytes: Buffer.from("print(1)") });
  assert.equal(runtime.storage.state, "synced");
  assert.deepEqual(runtime.storage.files, []);
  assert.equal(context.cloud.callsOf("cloud_workspace_push").some((call) => call.args.path.startsWith(".sandbox-script-")), false);
});

test("writeRuntimeBytes only touches the local cache and registers nothing", async (t) => {
  const context = await fixture();
  t.after(() => context.cleanup());
  await context.files.writeRuntimeBytes(context.sid, { path: ".sandbox-script-abc.py", bytes: Buffer.from("print(2)") });
  assert.equal(await readFile(path.join(context.sessionDir(), ".sandbox-script-abc.py"), "utf8"), "print(2)");
  assert.equal(context.cloud.callsOf("cloud_workspace_push").length, 0);
  const journal = await journalOf(context);
  assert.deepEqual(journal.sessions[context.sid].files, {});
  context.cloud.state = "login-required";
  await assert.rejects(context.files.writeRuntimeBytes(context.sid, { path: ".sandbox-script-xyz.py", bytes: Buffer.from("x") }), (error) => error.code === "CLOUD_LOGIN_REQUIRED");
});

test("importFile requires the approved exact source path and syncs the copy", async (t) => {
  const context = await fixture();
  t.after(() => context.cleanup());
  const source = path.join(context.root, "report.txt");
  await writeFile(source, "imported");
  await assert.rejects(context.files.importFile(context.sid, { sourcePath: source, path: "in/report.txt" }), (error) => error.code === "IMPORT_NOT_APPROVED");
  await assert.rejects(
    context.files.importFile(context.sid, { sourcePath: source, path: "in/report.txt" }, { approvedSourcePath: path.join(context.root, "other.txt") }),
    (error) => error.code === "IMPORT_NOT_APPROVED",
  );
  const result = await context.files.importFile(context.sid, { sourcePath: source, path: "in/report.txt" }, { approvedSourcePath: source });
  assert.equal(result.storage.state, "synced");
  assert.equal(await readFile(path.join(context.sessionDir(), "in/report.txt"), "utf8"), "imported");
  assert.equal(context.cloud.callsOf("cloud_workspace_push")[0].args.sourcePath, path.join(context.sessionDir(), "in/report.txt"));
});

test("zip create and extract sync new artifacts while list does not", async (t) => {
  const context = await fixture();
  t.after(() => context.cleanup());
  await context.files.write(context.sid, { path: "a.txt", text: "alpha" });
  await context.files.write(context.sid, { path: "b.txt", text: "beta" });
  const before = context.cloud.callsOf("cloud_workspace_push").length;
  const created = await context.files.zip(context.sid, { action: "create", path: "pack.zip", files: ["a.txt", "b.txt"] });
  assert.equal(created.storage.state, "synced");
  assert.equal(context.cloud.callsOf("cloud_workspace_push").length, before + 1);
  const listed = await context.files.zip(context.sid, { action: "list", path: "pack.zip" });
  assert.ok(Array.isArray(listed.entries));
  assert.equal(context.cloud.callsOf("cloud_workspace_push").length, before + 1);
  const extracted = await context.files.zip(context.sid, { action: "extract", path: "pack.zip", destination: "out" });
  assert.equal(extracted.storage.state, "synced");
  assert.equal(extracted.files.length, 2);
  const pushed = context.cloud.callsOf("cloud_workspace_push").map((call) => call.args.path);
  assert.ok(pushed.includes("out/a.txt") && pushed.includes("out/b.txt"));
});

test("read falls back to the local cache offline and marks provenance", async (t) => {
  const context = await fixture();
  t.after(() => context.cleanup());
  await context.files.write(context.sid, { path: "a.txt", text: "cached" });
  context.cloud.state = "login-required";
  const result = await context.files.read(context.sid, { path: "a.txt" });
  assert.equal(result.text, "cached");
  assert.equal(result.storage.offline, true);
  assert.equal(result.storage.source, "local-cache");
  assert.equal(result.storage.verified, true);
});

test("read pulls a missing file from the cloud and reports the pull source", async (t) => {
  const context = await fixture();
  t.after(() => context.cleanup());
  context.cloud.remote.set("remote/only.txt", { bytes: Buffer.from("from cloud"), remoteId: "rid-cloud" });
  await context.files.root(context.sid);
  const result = await context.files.read(context.sid, { path: "remote/only.txt" });
  assert.equal(result.text, "from cloud");
  assert.equal(result.storage.source, "cloud-pull");
  assert.equal(result.storage.remoteId, "rid-cloud");
  assert.equal(await readFile(path.join(context.sessionDir(), "remote/only.txt"), "utf8"), "from cloud");
});

test("read does not attempt a pull while offline", async (t) => {
  const context = await fixture();
  t.after(() => context.cleanup());
  await context.files.root(context.sid);
  context.cloud.state = "login-required";
  await assert.rejects(context.files.read(context.sid, { path: "ghost.txt" }), (error) => error.code === "FILE_NOT_FOUND");
  assert.equal(context.cloud.callsOf("cloud_workspace_pull").length, 0);
});

test("list restores a missing directory tree from the cloud", async (t) => {
  const context = await fixture();
  t.after(() => context.cleanup());
  context.cloud.remote.set("d/a.txt", { bytes: Buffer.from("a"), remoteId: "rid-a" });
  context.cloud.remote.set("d/b.txt", { bytes: Buffer.from("b"), remoteId: "rid-b" });
  await context.files.root(context.sid);
  const result = await context.files.list(context.sid, { path: "d" });
  assert.deepEqual(result.entries.map((entry) => entry.name), ["a.txt", "b.txt"]);
  assert.equal(result.storage.source, "local-cache");
  assert.equal(result.entries[0].storage.synced, true);
});

test("list on a fresh session is empty and carries cache provenance", async (t) => {
  const context = await fixture();
  t.after(() => context.cleanup());
  const result = await context.files.list(context.sid, {});
  assert.deepEqual(result.entries, []);
  assert.equal(result.storage.verified, false);
  assert.equal(result.storage.offline, false);
  context.cloud.state = "login-required";
  await assert.rejects(context.files.list(randomUUID(), {}), (error) => error.code === "CLOUD_CACHE_ABSENT");
});

test("sync uploads files, skips sandbox scripts and unchanged content", async (t) => {
  const context = await fixture();
  t.after(() => context.cleanup());
  await context.files.write(context.sid, { path: "a.txt", text: "alpha" });
  await context.files.writeRuntimeBytes(context.sid, { path: ".sandbox-script-1.py", bytes: Buffer.from("print(1)") });
  await context.files.write(context.sid, { path: "nested/b.txt", text: "beta" });
  const pushesBefore = context.cloud.callsOf("cloud_workspace_push").length;
  const receipt = await context.files.sync(context.sid);
  assert.equal(receipt.mode, "cloud");
  assert.equal(receipt.state, "synced");
  assert.equal(receipt.files, 2);
  assert.equal(context.cloud.callsOf("cloud_workspace_push").length, pushesBefore);
  assert.ok(receipt.skipped.every((item) => item.reason === "unchanged"));
  const empty = await context.files.sync(randomUUID());
  assert.equal(empty.files, 0);
  assert.equal(empty.state, "synced");
});

test("sync conflicts when the remote revision moved and the local copy is dirty", async (t) => {
  const context = await fixture();
  t.after(() => context.cleanup());
  await context.files.write(context.sid, { path: "a.txt", text: "v1" });
  context.cloud.remote.set("a.txt", { bytes: Buffer.from("remote-v2"), remoteId: "rid-remote" });
  await writeFile(path.join(context.sessionDir(), "a.txt"), "local-v2");
  await assert.rejects(context.files.sync(context.sid), (error) => {
    assert.equal(error.code, "CLOUD_CONFLICT");
    assert.equal(error.conflicts[0].path, "a.txt");
    return true;
  });
  assert.equal(await readFile(path.join(context.sessionDir(), "a.txt"), "utf8"), "local-v2");
});

test("sync reports remote-only changes instead of overwriting them", async (t) => {
  const context = await fixture();
  t.after(() => context.cleanup());
  await context.files.write(context.sid, { path: "a.txt", text: "v1" });
  context.cloud.remote.set("a.txt", { bytes: Buffer.from("remote-v2"), remoteId: "rid-remote" });
  await assert.rejects(context.files.sync(context.sid), (error) => {
    assert.equal(error.code, "CLOUD_REMOTE_CHANGED");
    assert.equal(error.changed[0].path, "a.txt");
    return true;
  });
  assert.equal(context.cloud.remote.get("a.txt").remoteId, "rid-remote");
});

test("sync reconciles an unknown write only when the pull confirms and unlocks", async (t) => {
  const context = await fixture();
  t.after(() => context.cleanup());
  context.cloud.pushOverride = async (args) => {
    const bytes = await readFile(args.sourcePath);
    context.cloud.remote.set(args.path, { bytes, remoteId: "rid-unknown" });
    return { ok: false, error: { code: "WORKSPACE_WRITE_UNKNOWN", message: "结果未知。" } };
  };
  const result = await context.files.write(context.sid, { path: "a.txt", text: "same" });
  assert.equal(result.storage.state, "synced");
  assert.equal(result.storage.files[0].reconciled, true);
  const journal = await journalOf(context);
  assert.equal(journal.sessions[context.sid].files["a.txt"].remoteId, "rid-unknown");
});

test("sync keeps the unknown write locked when reconciliation is not confirmed", async (t) => {
  const context = await fixture();
  t.after(() => context.cleanup());
  context.cloud.reconciledWrite = false;
  context.cloud.pushOverride = async (args) => {
    const bytes = await readFile(args.sourcePath);
    context.cloud.remote.set(args.path, { bytes, remoteId: "rid-unknown" });
    return { ok: false, error: { code: "WORKSPACE_WRITE_UNKNOWN", message: "结果未知。" } };
  };
  const result = await context.files.write(context.sid, { path: "a.txt", text: "same" });
  assert.equal(result.storage.state, "unconfirmed");
  assert.equal(result.storage.code, "CLOUD_WRITE_UNKNOWN");
  const journal = await journalOf(context);
  assert.equal(journal.sessions[context.sid].files["a.txt"], undefined);
});

test("sync treats a reconciled content mismatch as a conflict", async (t) => {
  const context = await fixture();
  t.after(() => context.cleanup());
  context.cloud.pushOverride = async (args) => {
    context.cloud.remote.set(args.path, { bytes: Buffer.from("other"), remoteId: "rid-other" });
    return { ok: false, error: { code: "WORKSPACE_WRITE_UNKNOWN", message: "结果未知。" } };
  };
  const result = await context.files.write(context.sid, { path: "a.txt", text: "mine" });
  assert.equal(result.storage.state, "unconfirmed");
  assert.equal(result.storage.code, "CLOUD_CONFLICT");
  assert.equal(await readFile(path.join(context.sessionDir(), "a.txt"), "utf8"), "mine");
});

test("sync fails closed when the cloud listing is unavailable", async (t) => {
  const context = await fixture();
  t.after(() => context.cleanup());
  await context.files.write(context.sid, { path: "a.txt", text: "alpha" });
  context.cloud.listError = { code: "CLOUD_LIST_DENIED", message: "列表被拒绝。" };
  await assert.rejects(context.files.sync(context.sid), (error) => error.code === "CLOUD_LIST_DENIED");
});

test("sync enforces file count, per-file and total size limits", async (t) => {
  const count = await fixture({ limits: { maxFiles: 1 } });
  t.after(() => count.cleanup());
  await count.files.write(count.sid, { path: "a.txt", text: "a" });
  await count.files.write(count.sid, { path: "b.txt", text: "b" });
  await assert.rejects(count.files.sync(count.sid), (error) => error.code === "CLOUD_SYNC_LIMIT");

  const perFile = await fixture({ limits: { maxFileBytes: 4 } });
  t.after(() => perFile.cleanup());
  await perFile.files.write(perFile.sid, { path: "big.txt", text: "too-large" });
  await assert.rejects(perFile.files.sync(perFile.sid), (error) => error.code === "CLOUD_SYNC_LIMIT");

  const total = await fixture({ limits: { maxTotalBytes: 8, maxFileBytes: 6 } });
  t.after(() => total.cleanup());
  await total.files.write(total.sid, { path: "a.txt", text: "12345" });
  await total.files.write(total.sid, { path: "b.txt", text: "67890" });
  await assert.rejects(total.files.sync(total.sid), (error) => error.code === "CLOUD_SYNC_LIMIT");
});

test("prepareRuntime hydrates missing and revised files but keeps dirty local copies", async (t) => {
  const context = await fixture();
  t.after(() => context.cleanup());
  await context.files.write(context.sid, { path: "revised.txt", text: "v1" });
  await writeFile(path.join(context.sessionDir(), "dirty.txt"), "local-only");
  context.cloud.remote.set("dirty.txt", { bytes: Buffer.from("cloud-dirty"), remoteId: "rid-dirty" });
  context.cloud.remote.set("missing.txt", { bytes: Buffer.from("from cloud"), remoteId: "rid-missing" });
  context.cloud.remote.set("revised.txt", { bytes: Buffer.from("cloud-v2"), remoteId: "rid-v2" });
  const receipt = await context.files.prepareRuntime(context.sid);
  assert.equal(receipt.mode, "cloud");
  assert.equal(receipt.state, "unconfirmed");
  assert.equal(receipt.code, "CLOUD_LOCAL_DIRTY");
  assert.equal(await readFile(path.join(context.sessionDir(), "missing.txt"), "utf8"), "from cloud");
  assert.equal(await readFile(path.join(context.sessionDir(), "revised.txt"), "utf8"), "cloud-v2");
  assert.equal(await readFile(path.join(context.sessionDir(), "dirty.txt"), "utf8"), "local-only");
  assert.deepEqual(receipt.keptDirty.map((item) => item.path), ["dirty.txt"]);
});

test("prepareRuntime succeeds without dirty files and skips sandbox scripts", async (t) => {
  const context = await fixture();
  t.after(() => context.cleanup());
  context.cloud.remote.set(".sandbox-script-old.py", { bytes: Buffer.from("print(1)"), remoteId: "rid-script" });
  context.cloud.remote.set("data.csv", { bytes: Buffer.from("a,b"), remoteId: "rid-data" });
  const receipt = await context.files.prepareRuntime(context.sid);
  assert.equal(receipt.state, "ready");
  assert.deepEqual(receipt.pulled.map((item) => item.path), ["data.csv"]);
  assert.equal(await exists(path.join(context.sessionDir(), ".sandbox-script-old.py")), false);
  assert.equal(await readFile(path.join(context.sessionDir(), "data.csv"), "utf8"), "a,b");
});

test("prepareRuntime enforces limits and requires an active account", async (t) => {
  const limited = await fixture({ limits: { maxFiles: 1 } });
  t.after(() => limited.cleanup());
  limited.cloud.remote.set("a.txt", { bytes: Buffer.from("a"), remoteId: "r1" });
  limited.cloud.remote.set("b.txt", { bytes: Buffer.from("b"), remoteId: "r2" });
  await assert.rejects(limited.files.prepareRuntime(limited.sid), (error) => error.code === "CLOUD_SYNC_LIMIT");

  const offline = await fixture();
  t.after(() => offline.cleanup());
  offline.cloud.state = "login-required";
  await assert.rejects(offline.files.prepareRuntime(offline.sid), (error) => error.code === "CLOUD_LOGIN_REQUIRED");
});

test("cleanupRoot awaits the journal and returns legacy plus bound cache directories", async (t) => {
  const context = await fixture();
  t.after(() => context.cleanup());
  await context.files.write(context.sid, { path: "a.txt", text: "alpha" });
  const restarted = new CloudWorkspaceFiles({ host: context.cloud, stateDir: context.stateDir });
  const roots = await restarted.cleanupRoot(context.sid);
  assert.deepEqual(roots, [
    path.join(context.stateDir, "workspaces", context.sid),
    path.join(context.cacheDir(), context.sid),
  ]);
  const unknownSid = randomUUID();
  const unknown = await restarted.cleanupRoot(unknownSid);
  assert.deepEqual(unknown, [path.join(context.stateDir, "workspaces", unknownSid)]);
});

test("cleanupRoot falls back to legacy when the journal is corrupt", async (t) => {
  const context = await fixture();
  t.after(() => context.cleanup());
  await mkdir(path.dirname(context.journalFile), { recursive: true });
  await writeFile(context.journalFile, "{not json");
  const fresh = new CloudWorkspaceFiles({ host: context.cloud, stateDir: context.stateDir });
  const roots = await fresh.cleanupRoot(context.sid);
  assert.deepEqual(roots, [path.join(context.stateDir, "workspaces", context.sid)]);
});

test("a corrupt journal fails closed for file operations", async (t) => {
  const context = await fixture();
  t.after(() => context.cleanup());
  await mkdir(path.dirname(context.journalFile), { recursive: true });
  await writeFile(context.journalFile, JSON.stringify({ version: 9, sessions: {} }));
  const fresh = new CloudWorkspaceFiles({ host: context.cloud, stateDir: context.stateDir });
  await assert.rejects(fresh.write(context.sid, { path: "a.txt", text: "x" }), (error) => error.code === "CLOUD_JOURNAL_CORRUPT");
  assert.equal(await exists(path.join(context.sessionDir(), "a.txt")), false);
});

test("pull receipts are validated before anything enters the cache", async (t) => {
  const context = await fixture();
  t.after(() => context.cleanup());
  context.cloud.remote.set("a.txt", { bytes: Buffer.from("cloud"), remoteId: "rid" });
  await context.files.root(context.sid);
  const backendFile = path.join(context.root, "backend-file.txt");
  await writeFile(backendFile, "cloud");
  context.cloud.pullOverride = async () => ({ ok: true, data: { localPath: backendFile, sha256: "0".repeat(64), remoteId: "rid", bytes: 5 } });
  await assert.rejects(context.files.read(context.sid, { path: "a.txt" }), (error) => error.code === "CLOUD_HASH_MISMATCH");
  context.cloud.pullOverride = async () => ({ ok: true, data: { localPath: "relative/path", sha256: sha(Buffer.from("cloud")), remoteId: "rid" } });
  await assert.rejects(context.files.read(context.sid, { path: "a.txt" }), (error) => error.code === "CLOUD_BAD_RECEIPT");
  assert.equal(await exists(path.join(context.sessionDir(), "a.txt")), false);
});

test("read maps a missing remote file to a clear pull failure", async (t) => {
  const context = await fixture();
  t.after(() => context.cleanup());
  await context.files.root(context.sid);
  await assert.rejects(context.files.read(context.sid, { path: "ghost.txt" }), (error) => error.code === "WORKSPACE_NOT_FOUND");
  assert.equal(context.cloud.callsOf("cloud_workspace_pull").length, 1);
});

test("status maps unsupported cloud backends to unverified", async (t) => {
  const context = await fixture();
  t.after(() => context.cleanup());
  context.cloud.statusError = { code: "CLOUD_WORKSPACE_UNSUPPORTED", message: "库不支持私有校验。" };
  const storage = await context.files.status();
  assert.equal(storage.state, "unverified");
  assert.equal(storage.code, "CLOUD_WORKSPACE_UNSUPPORTED");
  assert.match(storage.message, /私有/);
});

test("an unreadable journal fails closed with a distinct code", async (t) => {
  const context = await fixture();
  t.after(() => context.cleanup());
  await mkdir(context.journalFile, { recursive: true });
  const fresh = new CloudWorkspaceFiles({ host: context.cloud, stateDir: context.stateDir });
  await assert.rejects(fresh.write(context.sid, { path: "a.txt", text: "x" }), (error) => error.code === "CLOUD_JOURNAL_UNAVAILABLE");
});

test("read marks an untracked local file as local-only", async (t) => {
  const context = await fixture();
  t.after(() => context.cleanup());
  await context.files.root(context.sid);
  await mkdir(path.join(context.sessionDir(), "manual"), { recursive: true });
  await writeFile(path.join(context.sessionDir(), "manual/note.txt"), "hand made");
  const result = await context.files.read(context.sid, { path: "manual/note.txt" });
  assert.equal(result.storage.state, "local-only");
  assert.equal(result.storage.verified, false);
});

test("unknown writes fail as CLOUD_WRITE_UNKNOWN when the reconcile pull fails", async (t) => {
  const context = await fixture();
  t.after(() => context.cleanup());
  context.cloud.pushOverride = async () => ({ ok: false, error: { code: "WORKSPACE_WRITE_UNKNOWN", message: "结果未知。" } });
  context.cloud.pullOverride = async () => ({ ok: false, error: { code: "WORKSPACE_NOT_FOUND", message: "远端读不到。" } });
  const result = await context.files.write(context.sid, { path: "a.txt", text: "mine" });
  assert.equal(result.storage.state, "unconfirmed");
  assert.equal(result.storage.code, "CLOUD_WRITE_UNKNOWN");
  assert.equal(await readFile(path.join(context.sessionDir(), "a.txt"), "utf8"), "mine");
});

test("a write still succeeds when the closing identity check cannot reach the cloud", async (t) => {
  const context = await fixture();
  t.after(() => context.cleanup());
  context.cloud.onPush = () => {
    context.cloud.statusError = { code: "AUTH_REQUIRED", message: "临时不可用。" };
  };
  const result = await context.files.write(context.sid, { path: "a.txt", text: "ok" });
  assert.equal(result.storage.state, "synced");
});

test("prepareRuntime rejects invalid remote paths and directory collisions", async (t) => {
  const invalid = await fixture();
  t.after(() => invalid.cleanup());
  invalid.cloud.remote.set("../escape.txt", { bytes: Buffer.from("x"), remoteId: "rid-escape" });
  await assert.rejects(invalid.files.prepareRuntime(invalid.sid), (error) => error.code === "CLOUD_INVALID_REMOTE");

  const collision = await fixture();
  t.after(() => collision.cleanup());
  collision.cloud.remote.set("clash.txt", { bytes: Buffer.from("x"), remoteId: "rid-clash" });
  await collision.files.root(collision.sid);
  await mkdir(path.join(collision.sessionDir(), "clash.txt"));
  await assert.rejects(collision.files.prepareRuntime(collision.sid), (error) => error.code === "NOT_FILE");
});

test("sync reports a failed upload as a conflict instead of claiming synced", async (t) => {
  const context = await fixture();
  t.after(() => context.cleanup());
  await context.files.write(context.sid, { path: "a.txt", text: "v1" });
  await writeFile(path.join(context.sessionDir(), "a.txt"), "v2-local");
  context.cloud.pushOverride = async () => ({ ok: false, error: { code: "CLOUD_PUSH_FAILED", message: "拒绝写入。" } });
  await assert.rejects(context.files.sync(context.sid), (error) => {
    assert.equal(error.code, "CLOUD_CONFLICT");
    assert.equal(error.conflicts[0].path, "a.txt");
    assert.equal(error.conflicts[0].code, "CLOUD_PUSH_FAILED");
    return true;
  });
});

test("status surfaces server-side code and message verbatim", async (t) => {
  const context = await fixture();
  t.after(() => context.cleanup());
  context.cloud.statusReply = {
    ok: true,
    data: {
      accountId: ACCOUNT,
      storage: {
        state: "unverified",
        repoId: REPO,
        rootPath: ROOT,
        privacy: { verified: false },
        code: "PRIVATE_CHECK_INCOMPLETE",
        message: "未能确认共享成员。",
      },
    },
  };
  const storage = await context.files.status();
  assert.equal(storage.state, "unverified");
  assert.equal(storage.code, "PRIVATE_CHECK_INCOMPLETE");
  assert.equal(storage.message, "未能确认共享成员。");
  assert.deepEqual(storage.privacy, { verified: false, checkedAt: null, code: null });
});

test("status ignores non-object privacy and incomplete scopes", async (t) => {
  const context = await fixture();
  t.after(() => context.cleanup());
  context.cloud.privacy = "verified";
  const storage = await context.files.status();
  assert.equal(storage.privacy, undefined);
  assert.equal(storage.state, "unverified");
  context.cloud.includeScope = false;
  context.cloud.includePrivacy = true;
  context.cloud.privacy = { verified: true, checkedAt: "2026-11-14T00:00:00.000Z", code: "PRIVATE_SCOPE_VERIFIED" };
  const fallback = await context.files.status();
  assert.equal(fallback.state, "ready");
  assert.deepEqual(fallback.scope, { accountId: ACCOUNT, repoId: REPO, rootPath: ROOT });
});

test("status uses fallback codes when the bridge reply is malformed", async (t) => {
  const context = await fixture();
  t.after(() => context.cleanup());
  context.cloud.statusError = { message: "没有任何错误码。" };
  const storage = await context.files.status();
  assert.equal(storage.code, "CLOUD_STATUS_FAILED");
  assert.equal(storage.state, "unavailable");
  assert.equal(storage.message, "没有任何错误码。");
  context.cloud.statusError = { code: 42 };
  const noMessage = await context.files.status();
  assert.equal(noMessage.code, "CLOUD_STATUS_FAILED");
  assert.match(noMessage.message, /未能核验/);
});

test("offline writes prefer the server message when one exists", async (t) => {
  const context = await fixture();
  t.after(() => context.cleanup());
  context.cloud.statusError = { code: "AUTH_EXPIRED", message: "登录态已过期，请重新扫码。" };
  await assert.rejects(context.files.write(context.sid, { path: "a.txt", text: "x" }), (error) => {
    assert.equal(error.code, "CLOUD_LOGIN_REQUIRED");
    assert.equal(error.message, "登录态已过期，请重新扫码。");
    return true;
  });
});

test("pull receipts must carry real absolute paths and hex digests", async (t) => {
  const context = await fixture();
  t.after(() => context.cleanup());
  context.cloud.remote.set("a.txt", { bytes: Buffer.from("cloud"), remoteId: "rid" });
  await context.files.root(context.sid);
  const backendFile = path.join(context.root, "backend-file.txt");
  await writeFile(backendFile, "cloud");
  context.cloud.pullOverride = async () => ({ ok: true, data: { localPath: backendFile, sha256: "not-a-digest", remoteId: "rid" } });
  await assert.rejects(context.files.read(context.sid, { path: "a.txt" }), (error) => error.code === "CLOUD_BAD_RECEIPT");
  context.cloud.pullOverride = async () => ({ ok: true, data: { localPath: backendFile, sha256: sha(Buffer.from("cloud")) } });
  await assert.rejects(context.files.read(context.sid, { path: "a.txt" }), (error) => error.code === "CLOUD_BAD_RECEIPT");
});

test("push receipts are validated and hash mismatches are refused", async (t) => {
  const context = await fixture();
  t.after(() => context.cleanup());
  context.cloud.pushOverride = async () => ({ ok: true, data: { path: "a.txt", sha256: sha(Buffer.from("x")) } });
  const missingId = await context.files.write(context.sid, { path: "a.txt", text: "x" });
  assert.equal(missingId.storage.state, "unconfirmed");
  assert.equal(missingId.storage.code, "CLOUD_BAD_RECEIPT");
  context.cloud.pushOverride = async () => ({ ok: true, data: { remoteId: "rid", sha256: "zzz" } });
  const badDigest = await context.files.write(context.sid, { path: "b.txt", text: "x" });
  assert.equal(badDigest.storage.code, "CLOUD_BAD_RECEIPT");
  context.cloud.pushOverride = async () => ({ ok: true, data: { remoteId: "rid", sha256: sha(Buffer.from("other")) } });
  const mismatch = await context.files.write(context.sid, { path: "c.txt", text: "x" });
  assert.equal(mismatch.storage.code, "CLOUD_HASH_MISMATCH");
});

test("an overwrite conflict from the cloud is reported without a blind retry", async (t) => {
  const context = await fixture();
  t.after(() => context.cleanup());
  await context.files.write(context.sid, { path: "a.txt", text: "v1" });
  await writeFile(path.join(context.sessionDir(), "a.txt"), "v2");
  context.cloud.pushOverride = async () => ({ ok: false, error: { code: "WORKSPACE_CONFLICT", message: "版本不匹配。" } });
  const result = await context.files.write(context.sid, { path: "a.txt", text: "v2", overwrite: true });
  assert.equal(result.storage.state, "unconfirmed");
  assert.equal(result.storage.code, "WORKSPACE_CONFLICT");
  assert.equal(context.cloud.callsOf("cloud_workspace_push").filter((call) => call.args.overwrite === true).length, 1);
});

test("malformed remote entries are ignored or rejected instead of trusted", async (t) => {
  const context = await fixture();
  t.after(() => context.cleanup());
  await context.files.write(context.sid, { path: "a.txt", text: "alpha" });
  context.cloud.remote.set("other.txt", { bytes: Buffer.from("remote"), remoteId: "rid-other" });
  const listReply = {
    ok: true,
    data: {
      entries: [
        { type: "file" },
        { path: ".", type: "dir" },
        { path: "folder", type: "directory" },
        { path: "weird.txt", type: "symlink" },
        { path: "no-id.txt", type: "file" },
        // 真实条目仍要保留，否则按新语义会被判定为“云端已被删除”。
        { path: "a.txt", type: "file", remoteId: context.cloud.remote.get("a.txt").remoteId, size: 5 },
      ],
      complete: true,
    },
  };
  context.cloud.listOverride = async () => listReply;
  const receipt = await context.files.sync(context.sid);
  assert.equal(receipt.state, "synced");
  // 只有一个合法条目（缺 remoteId 仍算远端文件），其余畸形条目全部被忽略。
  assert.equal(receipt.remoteOnly, 1);
  assert.deepEqual([...context.cloud.remote.keys()].sort(), ["a.txt", "other.txt"]);
});

test("sync counts remote-only files without treating them as deletions", async (t) => {
  const context = await fixture();
  t.after(() => context.cleanup());
  await context.files.write(context.sid, { path: "a.txt", text: "alpha" });
  context.cloud.remote.set("cloud-only.txt", { bytes: Buffer.from("x"), remoteId: "rid-only" });
  const receipt = await context.files.sync(context.sid);
  assert.equal(receipt.remoteOnly, 1);
  assert.ok(context.cloud.remote.has("cloud-only.txt"));
});

test("prepareRuntime tolerates remote entries without a size", async (t) => {
  const context = await fixture();
  t.after(() => context.cleanup());
  context.cloud.listOverride = async () => ({
    ok: true,
    data: { entries: [{ path: "sizeless.txt", type: "file", remoteId: "rid-size" }], complete: true },
  });
  context.cloud.remote.set("sizeless.txt", { bytes: Buffer.from("data"), remoteId: "rid-size" });
  const receipt = await context.files.prepareRuntime(context.sid);
  assert.equal(receipt.state, "ready");
  assert.equal(await readFile(path.join(context.sessionDir(), "sizeless.txt"), "utf8"), "data");
});

test("cleanupRoot ignores malformed journal hashes", async (t) => {
  const context = await fixture();
  t.after(() => context.cleanup());
  await mkdir(path.dirname(context.journalFile), { recursive: true });
  await writeFile(context.journalFile, JSON.stringify({
    version: 1,
    sessions: {
      [context.sid]: { accountHash: "not-hex", accounts: "also-not-an-array", files: {} },
    },
  }));
  const fresh = new CloudWorkspaceFiles({ host: context.cloud, stateDir: context.stateDir });
  const roots = await fresh.cleanupRoot(context.sid);
  assert.deepEqual(roots, [path.join(context.stateDir, "workspaces", context.sid)]);
});

test("sync skips sandbox scripts nested in subdirectories", async (t) => {
  const context = await fixture();
  t.after(() => context.cleanup());
  await context.files.write(context.sid, { path: "run/main.py", text: "print(1)" });
  await context.files.writeRuntimeBytes(context.sid, { path: "run/.sandbox-script-nested.py", bytes: Buffer.from("print(2)") });
  const receipt = await context.files.sync(context.sid);
  assert.equal(receipt.files, 1);
  assert.deepEqual(receipt.skipped.map((item) => item.path), ["run/main.py"]);
  assert.equal(context.cloud.remote.has("run/.sandbox-script-nested.py"), false);
});

// ---------------------------------------------------------------- 边界与账本修复

async function writeJournal(context, data) {
  await mkdir(path.dirname(context.journalFile), { recursive: true });
  await writeFile(context.journalFile, JSON.stringify(data));
}

test("invalid journal shapes fail closed", async (t) => {
  const shapes = [
    { version: 1, sessions: [] },
    { version: 1, sessions: { x: null } },
    { version: 1, sessions: { x: { files: [] } } },
  ];
  for (const shape of shapes) {
    const context = await fixture();
    t.after(() => context.cleanup());
    await writeJournal(context, shape);
    await assert.rejects(context.files.write(context.sid, { path: "a.txt", text: "x" }), (error) => error.code === "CLOUD_JOURNAL_CORRUPT");
  }
});

test("session entries are repaired on first use", async (t) => {
  const context = await fixture();
  t.after(() => context.cleanup());
  await writeJournal(context, { version: 1, sessions: { [context.sid]: { files: {} } } });
  await context.files.write(context.sid, { path: "a.txt", text: "alpha" });
  const repaired = await journalOf(context);
  assert.equal(repaired.sessions[context.sid].accountId, ACCOUNT);
  assert.deepEqual(repaired.sessions[context.sid].accounts, [accountDir(ACCOUNT)]);
  assert.equal(repaired.sessions[context.sid].files["a.txt"].remoteId.length > 0, true);

  const legacy = await fixture();
  t.after(() => legacy.cleanup());
  await writeJournal(legacy, { version: 1, sessions: { [legacy.sid]: { accountId: ACCOUNT, accountHash: accountDir(ACCOUNT) } } });
  await legacy.files.root(legacy.sid);
  const normalized = await journalOf(legacy);
  assert.deepEqual(normalized.sessions[legacy.sid].files, {});
  assert.deepEqual(normalized.sessions[legacy.sid].accounts, [accountDir(ACCOUNT)]);
});

test("file operations reject malformed session ids", async (t) => {
  const context = await fixture();
  t.after(() => context.cleanup());
  await assert.rejects(context.files.write("not-a-session", { path: "a.txt", text: "x" }), (error) => error.code === "INVALID_SESSION");
  await assert.rejects(context.files.resolve("not-a-session", "a.txt"), (error) => error.code === "INVALID_SESSION");
  await assert.rejects(context.files.read("not-a-session", { path: "a.txt" }), (error) => error.code === "INVALID_SESSION");
});

test("reads refuse a cache bound to another cloud account", async (t) => {
  const context = await fixture();
  t.after(() => context.cleanup());
  await context.files.write(context.sid, { path: "a.txt", text: "alpha" });
  context.cloud.accountId = OTHER_ACCOUNT;
  await assert.rejects(context.files.read(context.sid, { path: "a.txt" }), (error) => error.code === "CLOUD_ACCOUNT_MISMATCH");
  await assert.rejects(context.files.list(context.sid, {}), (error) => error.code === "CLOUD_ACCOUNT_MISMATCH");
});

test("a non-object bridge reply is reported as a bad reply", async (t) => {
  const context = await fixture();
  t.after(() => context.cleanup());
  context.cloud.nullReply = true;
  const storage = await context.files.status();
  assert.equal(storage.code, "CLOUD_BAD_REPLY");
  assert.equal(storage.state, "unavailable");
});

test("init failures keep the fallback code and message", async (t) => {
  const context = await fixture();
  t.after(() => context.cleanup());
  context.cloud.state = "uninitialized";
  const prepared = await context.files.prepareInitialization();
  context.cloud.initReply = { ok: false, error: {} };
  await assert.rejects(context.files.initialize({ prepared, approved: true }), (error) => {
    assert.equal(error.code, "CLOUD_INIT_FAILED");
    assert.match(error.message, /初始化未完成/);
    return true;
  });
});

test("prepareInitialization maps unavailable storage to CLOUD_UNAVAILABLE", async (t) => {
  const context = await fixture();
  t.after(() => context.cleanup());
  context.cloud.statusError = { code: "WEIRD", message: "云盘暂时不可用。" };
  await assert.rejects(context.files.prepareInitialization(), (error) => {
    assert.equal(error.code, "CLOUD_UNAVAILABLE");
    assert.equal(error.message, "云盘暂时不可用。");
    return true;
  });
});

test("initialize rejects non-object prepared values", async (t) => {
  const context = await fixture();
  t.after(() => context.cleanup());
  context.cloud.state = "uninitialized";
  await assert.rejects(context.files.initialize({ prepared: "forged", approved: true }), (error) => error.code === "CLOUD_APPROVAL_REQUIRED");
});

test("status without storage is unavailable", async (t) => {
  const context = await fixture();
  t.after(() => context.cleanup());
  context.cloud.statusReply = { ok: true, data: {} };
  const storage = await context.files.status();
  assert.equal(storage.state, "unavailable");
});

test("provenance reports unverified when the journal lacks revision details", async (t) => {
  const context = await fixture();
  t.after(() => context.cleanup());
  await context.files.root(context.sid);
  await writeFile(path.join(context.sessionDir(), "a.txt"), "content");
  await writeJournal(context, {
    version: 1,
    sessions: { [context.sid]: { accountId: ACCOUNT, accountHash: accountDir(ACCOUNT), accounts: [accountDir(ACCOUNT)], files: { "a.txt": { sha256: sha(Buffer.from("other")) } } } },
  });
  const restarted = new CloudWorkspaceFiles({ host: context.cloud, stateDir: context.stateDir });
  const result = await restarted.read(context.sid, { path: "a.txt" });
  assert.equal(result.storage.verified, false);
  assert.equal(result.storage.remoteId, undefined);
  assert.equal(result.storage.syncedAt, undefined);
  assert.match(result.storage.note, /不一致/);
});

test("list and read accept null arguments", async (t) => {
  const context = await fixture();
  t.after(() => context.cleanup());
  await context.files.write(context.sid, { path: "a.txt", text: "alpha" });
  const listed = await context.files.list(context.sid, null);
  assert.equal(listed.entries.length, 1);
  const read = await context.files.read(context.sid, { path: "a.txt" });
  assert.equal(read.text, "alpha");
});

test("listing a regular file surfaces the real filesystem error", async (t) => {
  const context = await fixture();
  t.after(() => context.cleanup());
  await context.files.write(context.sid, { path: "a.txt", text: "alpha" });
  await assert.rejects(context.files.list(context.sid, { path: "a.txt" }), (error) => error.code === "NOT_DIRECTORY");
});

test("pull receipts without data or byte counts are rejected or defaulted", async (t) => {
  const context = await fixture();
  t.after(() => context.cleanup());
  context.cloud.remote.set("a.txt", { bytes: Buffer.from("cloud"), remoteId: "rid" });
  await context.files.root(context.sid);
  context.cloud.pullOverride = async () => ({ ok: true });
  await assert.rejects(context.files.read(context.sid, { path: "a.txt" }), (error) => error.code === "CLOUD_BAD_RECEIPT");
  const backendFile = path.join(context.root, "backend-bytes.txt");
  await writeFile(backendFile, "cloud");
  context.cloud.pullOverride = async () => ({ ok: true, data: { localPath: backendFile, sha256: sha(Buffer.from("cloud")), remoteId: "rid" } });
  const result = await context.files.read(context.sid, { path: "a.txt" });
  assert.equal(result.text, "cloud");
});

test("a pull whose backend file vanished reports CLOUD_PULL_MISSING", async (t) => {
  const context = await fixture();
  t.after(() => context.cleanup());
  context.cloud.remote.set("a.txt", { bytes: Buffer.from("cloud"), remoteId: "rid" });
  await context.files.root(context.sid);
  context.cloud.pullOverride = async () => ({ ok: true, data: { localPath: path.join(context.root, "nope.txt"), sha256: sha(Buffer.from("cloud")), remoteId: "rid" } });
  await assert.rejects(context.files.read(context.sid, { path: "a.txt" }), (error) => error.code === "CLOUD_PULL_MISSING");
});

test("an oversized download is rejected by the per-file limit", async (t) => {
  const context = await fixture({ limits: { maxFileBytes: 2 } });
  t.after(() => context.cleanup());
  context.cloud.remote.set("a.txt", { bytes: Buffer.from("too-big"), remoteId: "rid" });
  await context.files.root(context.sid);
  await assert.rejects(context.files.read(context.sid, { path: "a.txt" }), (error) => error.code === "FILE_TOO_LARGE");
});

test("directory recovery reports list failures, empty replies and pull limits", async (t) => {
  const failing = await fixture();
  t.after(() => failing.cleanup());
  await failing.files.root(failing.sid);
  failing.cloud.listError = { code: "CLOUD_LIST_DENIED", message: "列表被拒绝。" };
  await assert.rejects(failing.files.list(failing.sid, { path: "d" }), (error) => error.code === "CLOUD_LIST_DENIED");

  const empty = await fixture();
  t.after(() => empty.cleanup());
  await empty.files.root(empty.sid);
  empty.cloud.listOverride = async () => ({ ok: true, data: {} });
  await assert.rejects(empty.files.list(empty.sid, { path: "d" }), (error) => error.code === "CLOUD_LIST_INCOMPLETE");

  const limited = await fixture({ limits: { maxPulledFiles: 1 } });
  t.after(() => limited.cleanup());
  limited.cloud.remote.set("d/a.txt", { bytes: Buffer.from("a"), remoteId: "r1" });
  limited.cloud.remote.set("d/b.txt", { bytes: Buffer.from("b"), remoteId: "r2" });
  await limited.files.root(limited.sid);
  await assert.rejects(limited.files.list(limited.sid, { path: "d" }), (error) => error.code === "CLOUD_PULL_LIMIT");
});

test("rewriting identical content skips the upload", async (t) => {
  const context = await fixture();
  t.after(() => context.cleanup());
  await context.files.write(context.sid, { path: "a.txt", text: "same" });
  const pushesBefore = context.cloud.callsOf("cloud_workspace_push").length;
  const result = await context.files.write(context.sid, { path: "a.txt", text: "same", overwrite: true });
  assert.equal(result.storage.state, "synced");
  assert.equal(result.storage.files[0].skipped, true);
  assert.equal(context.cloud.callsOf("cloud_workspace_push").length, pushesBefore);
});

test("a new file that already exists remotely is reconciled instead of overwritten", async (t) => {
  const context = await fixture();
  t.after(() => context.cleanup());
  context.cloud.remote.set("a.txt", { bytes: Buffer.from("same"), remoteId: "rid-existing" });
  const result = await context.files.write(context.sid, { path: "a.txt", text: "same" });
  assert.equal(result.storage.state, "synced");
  assert.equal(result.storage.files[0].reconciled, true);
  assert.equal(context.cloud.remote.get("a.txt").remoteId, "rid-existing");
});

test("push replies without a data object are rejected", async (t) => {
  const context = await fixture();
  t.after(() => context.cleanup());
  context.cloud.pushOverride = async () => ({ ok: true });
  const result = await context.files.write(context.sid, { path: "a.txt", text: "x" });
  assert.equal(result.storage.code, "CLOUD_BAD_RECEIPT");
});

test("prepareRuntime reports list failures and accepts empty replies", async (t) => {
  const failing = await fixture();
  t.after(() => failing.cleanup());
  failing.cloud.listError = { code: "CLOUD_LIST_DENIED", message: "列表被拒绝。" };
  await assert.rejects(failing.files.prepareRuntime(failing.sid), (error) => error.code === "CLOUD_LIST_DENIED");

  const malformed = await fixture();
  t.after(() => malformed.cleanup());
  malformed.cloud.listOverride = async () => ({ ok: true, data: {} });
  await assert.rejects(malformed.files.prepareRuntime(malformed.sid), (error) => error.code === "CLOUD_LIST_INCOMPLETE");

  const empty = await fixture();
  t.after(() => empty.cleanup());
  empty.cloud.listOverride = async () => ({ ok: true, data: { entries: [], complete: true } });
  const receipt = await empty.files.prepareRuntime(empty.sid);
  assert.equal(receipt.state, "ready");
  assert.deepEqual(receipt.pulled, []);
});

test("prepareRuntime enforces per-file and total size limits", async (t) => {
  const perFile = await fixture({ limits: { maxFileBytes: 2 } });
  t.after(() => perFile.cleanup());
  perFile.cloud.remote.set("big.txt", { bytes: Buffer.from("too-big"), remoteId: "rid" });
  await assert.rejects(perFile.files.prepareRuntime(perFile.sid), (error) => error.code === "CLOUD_SYNC_LIMIT");

  const total = await fixture({ limits: { maxTotalBytes: 3, maxFileBytes: 10 } });
  t.after(() => total.cleanup());
  total.cloud.remote.set("a.txt", { bytes: Buffer.from("aa"), remoteId: "r1" });
  total.cloud.remote.set("b.txt", { bytes: Buffer.from("bb"), remoteId: "r2" });
  await assert.rejects(total.files.prepareRuntime(total.sid), (error) => error.code === "CLOUD_SYNC_LIMIT");
});

test("prepareRuntime leaves already current files untouched", async (t) => {
  const context = await fixture();
  t.after(() => context.cleanup());
  await context.files.write(context.sid, { path: "current.txt", text: "v1" });
  const receipt = await context.files.prepareRuntime(context.sid);
  assert.equal(receipt.state, "ready");
  assert.deepEqual(receipt.pulled, []);
  assert.equal(receipt.files, 1);
});

test("zip artifacts use the 64MiB archive limit while other files stay at the file limit", async (t) => {
  // 用缩小后的自定义限额验证同一套判定：普通文件 4 字节上限、ZIP 16 字节上限。
  const archive = await fixture({ limits: { maxFileBytes: 4, maxArchiveBytes: 16 } });
  t.after(() => archive.cleanup());
  const packed = await archive.files.writeBytes(archive.sid, { path: "BUNDLE.ZIP", bytes: Buffer.alloc(8) });
  assert.equal(packed.storage.state, "synced");
  assert.equal(archive.cloud.remote.has("BUNDLE.ZIP"), true);

  const plain = await fixture({ limits: { maxFileBytes: 4, maxArchiveBytes: 16 } });
  t.after(() => plain.cleanup());
  const text = await plain.files.writeBytes(plain.sid, { path: "notes.txt", bytes: Buffer.alloc(8) });
  assert.equal(text.storage.state, "unconfirmed");
  assert.equal(text.storage.code, "FILE_TOO_LARGE");
  await assert.rejects(plain.files.sync(plain.sid), (error) => error.code === "CLOUD_SYNC_LIMIT");
  assert.equal(plain.cloud.remote.has("notes.txt"), false);
});

test("prepareRuntime hydrates zips under the archive limit", async (t) => {
  const context = await fixture({ limits: { maxFileBytes: 4, maxArchiveBytes: 16 } });
  t.after(() => context.cleanup());
  context.cloud.remote.set("bundle.zip", { bytes: Buffer.alloc(8), remoteId: "rid-zip" });
  const receipt = await context.files.prepareRuntime(context.sid);
  assert.equal(receipt.state, "ready");
  assert.deepEqual(receipt.pulled.map((item) => item.path), ["bundle.zip"]);
  assert.equal(await exists(path.join(context.sessionDir(), "bundle.zip")), true);
});

test("an oversized zip fails loudly instead of being silently skipped as synced", async (t) => {
  const context = await fixture({ limits: { maxFileBytes: 4, maxArchiveBytes: 6 } });
  t.after(() => context.cleanup());
  const written = await context.files.writeBytes(context.sid, { path: "huge.zip", bytes: Buffer.alloc(8) });
  assert.equal(written.storage.state, "unconfirmed");
  assert.equal(written.storage.code, "FILE_TOO_LARGE");
  await assert.rejects(context.files.sync(context.sid), (error) => error.code === "CLOUD_SYNC_LIMIT");
  assert.equal(context.cloud.remote.has("huge.zip"), false);
});

test("the total sync budget still bounds archives", async (t) => {
  const context = await fixture({ limits: { maxFileBytes: 4, maxArchiveBytes: 16, maxTotalBytes: 10 } });
  t.after(() => context.cleanup());
  // 直接放进缓存，绕开写入时的单文件上传，专门验证全量同步的总量预算。
  await context.files.root(context.sid);
  await writeFile(path.join(context.sessionDir(), "bundle.zip"), Buffer.alloc(12));
  await assert.rejects(context.files.sync(context.sid), (error) => error.code === "CLOUD_SYNC_LIMIT");
  assert.equal(context.cloud.remote.has("bundle.zip"), false);
});

// ---------------------------------------------------------------- 跨账号读取边界

test("a different verified account is a mismatch even before the workspace is ready", async (t) => {
  const context = await fixture();
  t.after(() => context.cleanup());
  await context.files.write(context.sid, { path: "a.txt", text: "bound-to-A" });
  // 线上身份已换成 B，但工作区尚未就绪：这仍然是“明确的另一个账号”，不能当作离线缓存。
  context.cloud.accountId = OTHER_ACCOUNT;
  context.cloud.state = "unverified";
  context.cloud.privacy = { verified: false, checkedAt: "2026-11-14T00:00:00.000Z", code: "PRIVATE_CHECK_INCOMPLETE" };
  await assert.rejects(context.files.read(context.sid, { path: "a.txt" }), (error) => error.code === "CLOUD_ACCOUNT_MISMATCH");
  await assert.rejects(context.files.list(context.sid, {}), (error) => error.code === "CLOUD_ACCOUNT_MISMATCH");
  assert.equal(context.cloud.callsOf("cloud_workspace_pull").length, 0);
});

test("the bound account may still read its cache while the workspace is uninitialized", async (t) => {
  const context = await fixture();
  t.after(() => context.cleanup());
  await context.files.write(context.sid, { path: "a.txt", text: "cached-before-init" });
  // 同一账号 A，但工作区尚未初始化：允许只读缓存，且不触发任何云端下载。
  context.cloud.state = "uninitialized";
  const result = await context.files.read(context.sid, { path: "a.txt" });
  assert.equal(result.text, "cached-before-init");
  assert.equal(result.storage.offline, true);
  assert.equal(context.cloud.callsOf("cloud_workspace_pull").length, 0);
  const listed = await context.files.list(context.sid, {});
  assert.equal(listed.entries.length, 1);
  assert.equal(listed.storage.offline, true);
});

test("an existing but empty cache discovers files that only exist in the cloud", async (t) => {
  const context = await fixture();
  t.after(() => context.cleanup());
  await context.files.root(context.sid); // 缓存目录已存在且为空，旧逻辑会永远认为工作区是空的
  context.cloud.remote.set("remote.txt", { bytes: Buffer.from("hello"), remoteId: "rid-remote" });
  const result = await context.files.list(context.sid, {});
  assert.deepEqual(result.entries.map((entry) => entry.name), ["remote.txt"]);
  assert.equal(result.storage.remoteChecked, true);
  assert.equal(await readFile(path.join(context.sessionDir(), "remote.txt"), "utf8"), "hello");
  assert.equal(result.entries[0].storage.remoteId, "rid-remote");
});

test("online listing never overwrites an existing dirty local file", async (t) => {
  const context = await fixture();
  t.after(() => context.cleanup());
  await context.files.write(context.sid, { path: "a.txt", text: "v1" });
  await writeFile(path.join(context.sessionDir(), "a.txt"), "local-dirty");
  context.cloud.remote.set("a.txt", { bytes: Buffer.from("cloud-new"), remoteId: "rid-new" });
  const listed = await context.files.list(context.sid, {});
  assert.equal(listed.entries.length, 1);
  assert.equal(await readFile(path.join(context.sessionDir(), "a.txt"), "utf8"), "local-dirty");
  assert.equal(context.cloud.remote.get("a.txt").remoteId, "rid-new");
});

test("online listing keeps local cache and says so when the remote listing fails", async (t) => {
  const context = await fixture();
  t.after(() => context.cleanup());
  await context.files.write(context.sid, { path: "kept.txt", text: "local" });
  context.cloud.listError = { code: "CLOUD_LIST_DENIED", message: "列表被拒绝。" };
  const listed = await context.files.list(context.sid, {});
  assert.deepEqual(listed.entries.map((entry) => entry.name), ["kept.txt"]);
  assert.equal(listed.storage.remoteChecked, false);
  assert.equal(listed.storage.code, "CLOUD_LIST_DENIED");
  assert.match(listed.storage.message, /不能据此认为云端为空/);
});

test("listing rejects invalid remote paths instead of pulling them", async (t) => {
  const context = await fixture();
  t.after(() => context.cleanup());
  await context.files.root(context.sid);
  context.cloud.listOverride = async () => ({ ok: true, data: { entries: [{ path: "../escape.txt", type: "file", size: 1 }], complete: true } });
  await assert.rejects(context.files.list(context.sid, {}), (error) => error.code === "CLOUD_INVALID_REMOTE");
});

test("remote subdirectories appear in the online listing", async (t) => {
  const context = await fixture();
  t.after(() => context.cleanup());
  await context.files.root(context.sid);
  context.cloud.listOverride = async () => ({ ok: true, data: { entries: [{ path: "subdir", type: "directory" }], complete: true } });
  const listed = await context.files.list(context.sid, {});
  const dir = listed.entries.find((entry) => entry.path === "subdir");
  assert.ok(dir);
  assert.equal(dir.type, "directory");
  assert.equal(await exists(path.join(context.sessionDir(), "subdir")), true);
});

test("sync treats an externally deleted cloud file as a remote change, not a save", async (t) => {
  const context = await fixture();
  t.after(() => context.cleanup());
  await context.files.write(context.sid, { path: "a.txt", text: "v1" });
  context.cloud.remote.delete("a.txt"); // 云端被其它设备/后台删除
  await assert.rejects(context.files.sync(context.sid), (error) => {
    assert.equal(error.code, "CLOUD_REMOTE_CHANGED");
    assert.equal(error.changed[0].path, "a.txt");
    assert.equal(error.changed[0].reason, "remote-missing");
    return true;
  });
  assert.equal(await readFile(path.join(context.sessionDir(), "a.txt"), "utf8"), "v1");
});

test("sync refuses an incomplete list receipt even when there is nothing local to upload", async (t) => {
  const context = await fixture();
  t.after(() => context.cleanup());
  await context.files.root(context.sid); // 本地 0 文件，最容易误报“已核对”
  context.cloud.listOverride = async () => ({ ok: true, data: { entries: [] } }); // 缺 complete:true
  await assert.rejects(context.files.sync(context.sid), (error) => error.code === "CLOUD_LIST_INCOMPLETE");
});

test("sync still reports remote-only files when the local session is empty", async (t) => {
  const context = await fixture();
  t.after(() => context.cleanup());
  await context.files.root(context.sid);
  context.cloud.remote.set("cloud-only.txt", { bytes: Buffer.from("x"), remoteId: "rid-only" });
  const receipt = await context.files.sync(context.sid);
  assert.equal(receipt.mode, "cloud");
  assert.equal(receipt.state, "synced");
  assert.equal(receipt.files, 0);
  assert.equal(receipt.remoteOnly, 1);
  assert.deepEqual(receipt.uploaded, []);
});

test("zip entry points refuse another account's archive", async (t) => {
  const context = await fixture();
  t.after(() => context.cleanup());
  await context.files.write(context.sid, { path: "a.txt", text: "alpha" });
  await context.files.zip(context.sid, { action: "create", path: "pack.zip", files: ["a.txt"] });

  // 已知的另一个账号（ready）：requireReady + bind 必须在读取归档前拒绝。
  context.cloud.accountId = OTHER_ACCOUNT;
  await assert.rejects(context.files.zip(context.sid, { action: "list", path: "pack.zip" }), (error) => error.code === "CLOUD_ACCOUNT_MISMATCH");
  await assert.rejects(context.files.zip(context.sid, { action: "extract", path: "pack.zip", destination: "out" }), (error) => error.code === "CLOUD_ACCOUNT_MISMATCH");

  // 另一个账号但工作区尚未初始化：同样不得回退去读 A 的归档。
  context.cloud.state = "uninitialized";
  await assert.rejects(context.files.zip(context.sid, { action: "list", path: "pack.zip" }), (error) => error.code === "CLOUD_UNINITIALIZED");
});
