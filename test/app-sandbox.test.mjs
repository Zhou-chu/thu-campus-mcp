import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { tmpdir } from "node:os";
import { EventEmitter } from "node:events";
import { mkdtemp, mkdir, readFile, writeFile, readdir, rm, chmod } from "node:fs/promises";
import { createHash } from "node:crypto";
import { SandboxRunner, SandboxError, createDockerCommand } from "../lib/app/sandbox.mjs";
import { WorkspaceFiles } from "../lib/app/workspace-files.mjs";

const A = "11111111-1111-4111-8111-111111111111", B = "22222222-2222-4222-8222-222222222222";
const IMAGE = `sha256:${"a".repeat(64)}`, OTHER_IMAGE = `sha256:${"b".repeat(64)}`;
const LABEL = "work.thu-campus.sandbox";
const input = { runtime: "python", scriptPath: "script.py" };
const result = (stdout = "", code = 0, stderr = "") => ({ code, stdout, stderr });
const rejects = (fn, code) => assert.rejects(fn, (error) => error.code === code);
const tick = () => new Promise((resolve) => setImmediate(resolve));
async function until(check) { for (let i = 0; i < 1000; i++) { if (await check()) return; await new Promise((resolve) => setTimeout(resolve, 2)); } assert.fail("mock lifecycle did not settle"); }

class DockerMock {
  calls = []; containers = new Map(); waits = new Map(); sequence = 0; image = IMAGE; os = "linux";
  imageFailure = false; imageMalformed = false; infoFailure = false; runFailure = false; waitFailure = false; inspectFailure = false; removeFailure = false; logsFailure = false; runGate = null;
  command = async (args, options = {}) => {
    this.calls.push(args);
    if (args[0] === "info") { if (this.infoFailure) throw new Error("docker missing"); return result(this.os); }
    if (args[0] === "image") {
      if (this.imageFailure) return result("", 1, "No such image");
      if (this.imageMalformed) return result("invalid json");
      return result(JSON.stringify({ Id: this.image, Os: this.os }));
    }
    if (args[0] === "create") {
      if (this.runGate) await this.runGate;
      if (this.runFailure) return result("", 125, "cannot create");
      const id = (++this.sequence).toString(16).padStart(64, "0"), name = args[args.indexOf("--name") + 1];
      const labels = Object.fromEntries(args.flatMap((arg, index) => arg === "--label" ? [args[index + 1].split(/=(.*)/s).slice(0, 2)] : []));
      const image = args[args.indexOf("--entrypoint") + 2];
      this.containers.set(name, { Id: id, Name: `/${name}`, Config: { Image: image, Labels: labels }, State: { Running: true, ExitCode: 0 }, stdout: "", stderr: "" });
      return result(id);
    }
    if (args[0] === "start") {
      this.lastInput = options.input;
      if (this.waitFailure) return { ...result("", 1, "client disconnected"), expired: true };
      const id = args.at(-1);
      if (this.startupFailure) {
        const item = [...this.containers.values()].find((item) => item.Id === id);
        item.State = { Status: "created", Running: false, ExitCode: this.startupFailure.exitCode, Error: "OCI logging driver: compression cannot be enabled when max file count is 1" };
        return result("", this.startupFailure.clientCode, "Docker start detail: logging initialization failed");
      }
      return new Promise((resolve) => {
        this.waits.set(id, resolve);
        options.onChild?.({ kill: () => { this.waits.delete(id); resolve(result("", 1, "start client reaped")); } });
      });
    }
    if (args[0] === "container") {
      if (this.inspectFailure) return result("", 1, "daemon unavailable");
      const item = this.containers.get(args[2]);
      return item ? result(JSON.stringify([item])) : result("", 1, "Error: No such container");
    }
    const item = [...this.containers.values()].find((item) => item.Id === args.at(-1));
    if (args[0] === "logs") return this.logsFailure ? result("", 1, "log unavailable") : result(item.stdout, 0, item.stderr);
    if (args[0] === "rm") {
      if (this.removeFailure) return result("", 1, "remove refused");
      this.containers.delete(item.Name.slice(1)); this.waits.get(item.Id)?.(result("137")); this.waits.delete(item.Id);
      return result(item.Id);
    }
    assert.fail(`Unexpected docker command ${JSON.stringify(args)}`);
  };
  finish(job, code = 0, stdout = "completed", stderr = "") {
    const item = this.containers.get(`thu-campus-sandbox-${job.jobId}`);
    item.State = { Running: false, ExitCode: code }; item.stdout = stdout; item.stderr = stderr;
    this.waits.get(item.Id)?.({ ...result(String(code)), ...(this.inputError ? { inputError: "EPIPE" } : {}) }); this.waits.delete(item.Id);
  }
}
async function fixture(t, options = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), "campus-sandbox-test-"));
  assert.match(path.basename(directory), /^campus-sandbox-test-/);
  const files = new WorkspaceFiles({ baseDir: path.join(directory, "workspaces") }), docker = new DockerMock();
  const stateDir = path.join(directory, "sandbox-jobs");
  const runner = new SandboxRunner({ files, stateDir, command: docker.command, ...options });
  t.after(async () => { docker.inspectFailure = false; docker.removeFailure = false; await runner.close(); await rm(directory, { recursive: true, force: true }); });
  await files.writeBytes(A, { path: "script.py", bytes: Buffer.from("print('approved')\n") });
  return { directory, files, docker, stateDir, runner };
}
async function start(context, args = input, sessionId = A) {
  const prepared = await context.runner.prepare(sessionId, args);
  const job = await context.runner.run(sessionId, args, { prepared, approved: true });
  await until(() => context.docker.waits.size > 0 || context.docker.waitFailure || context.docker.runFailure);
  return { prepared, job };
}
async function terminal(context, job) {
  await until(async () => (await context.runner.get(A, job.jobId)).state !== "running");
  return context.runner.get(A, job.jobId);
}

test("Docker stdin is frozen bytes, pipe errors are handled", async () => {
  let sent, stdio;
  const command = createDockerCommand({ spawnProcess: (_file, _args, options) => {
    stdio = options.stdio; const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.stdin = new EventEmitter();
    child.stdin.end = (bytes) => { sent = bytes; queueMicrotask(() => { child.stdin.emit("error", { code: "EPIPE" }); child.emit("close", 1); }); };
    return child;
  } });
  const frozen = Buffer.from("print('approved')"), response = await command(["start", "--attach", "id"], { input: frozen });
  assert.equal(sent, frozen); assert.deepEqual(stdio, ["pipe", "pipe", "pipe"]); assert.equal(response.inputError, "EPIPE");
});
test("Node mjs uses native ESM stdin and approved bytes, not a mutable file", async (t) => {
  const c = await fixture(t), source = "import fs from 'node:fs'; console.log(fs.existsSync('/workspace'))";
  await c.files.writeBytes(A, { path: "test.mjs", bytes: Buffer.from(source) });
  const { job } = await start(c, { runtime: "node", scriptPath: "test.mjs" });
  assert.equal(c.docker.calls.find((args) => args[0] === "create").includes("--input-type=module"), true);
  assert.equal(c.docker.lastInput.toString(), source);
  c.docker.finish(job); assert.equal((await terminal(c, job)).state, "succeeded");
});

test("stdin EPIPE cannot turn container exit zero into success", async (t) => {
  const c = await fixture(t), { job } = await start(c); c.docker.inputError = true;
  c.docker.finish(job, 0); const finished = await terminal(c, job);
  assert.equal(finished.state, "failed"); assert.equal(finished.exitCode, 0);
});

test("OCI startup errors survive empty Docker logs and cannot report success", async (t) => {
  const c = await fixture(t);
  for (const failure of [{ exitCode: 128, clientCode: 1 }, { exitCode: 0, clientCode: 0 }]) {
    c.docker.startupFailure = failure;
    const prepared = await c.runner.prepare(A, input);
    const job = await c.runner.run(A, input, { prepared, approved: true });
    const failed = await terminal(c, job);
    assert.equal(failed.state, "failed"); assert.equal(failed.exitCode, failure.exitCode);
    assert.match(failed.stderr, /OCI logging driver/);
    if (failure.clientCode) assert.match(failed.stderr, /Docker start detail/);
    assert.equal(c.docker.containers.size, 0);
    const ledger = JSON.parse(await readFile(path.join(c.stateDir, A, `${job.jobId}.json`), "utf8"));
    assert.equal(ledger.job.stderr, failed.stderr);
  }
  const create = c.docker.calls.find((args) => args[0] === "create");
  assert.equal(create.some((arg, i) => arg === "--log-opt" && create[i + 1] === "compress=false"), true);
});

// Only a fake child is used below. No host Python/Node or real Docker workload is run.
test("Docker transport fixes executable/shell/env and bounds streams", async () => {
  let observed, child;
  const command = createDockerCommand({ maxOutputBytes: 8, spawnProcess: (file, args, options) => {
    observed = { file, args, options }; child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
    queueMicrotask(() => { child.stdout.emit("data", Buffer.from("123456789")); child.stdout.emit("data", "tail"); child.stderr.emit("data", "error"); child.emit("close", 0); });
    return child;
  } });
  let notified;
  const output = await command(["image", "inspect", "x; cmd"], { onChild: (value) => { notified = value; } });
  assert.equal(notified, child); assert.equal(observed.file, "docker"); assert.equal(observed.options.shell, false);
  assert.deepEqual(observed.options.stdio, ["ignore", "pipe", "pipe"]);
  assert.equal(observed.options.env.OPENAI_API_KEY, undefined); assert.equal(output.stdout, "12345678"); assert.equal(output.stderr, "error"); assert.equal(output.truncated, true);
});
test("Docker transport reports spawn throws, errors and client timeout without pretending container cancellation", async () => {
  await assert.rejects(createDockerCommand({ spawnProcess: () => { throw new Error("spawn denied"); } })([]), /spawn denied/);
  await assert.rejects(createDockerCommand({ spawnProcess: () => {
    const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); queueMicrotask(() => child.emit("error", new Error("missing docker"))); return child;
  } })([]), /missing docker/);
  const command = createDockerCommand({ controlTimeoutMs: 1, spawnProcess: () => {
    const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.kill = () => child.emit("close", null); return child;
  } });
  assert.equal((await command([])).expired, true);
});

test("status probes Linux daemon and local image IDs, never auto-pulls", async (t) => {
  const c = await fixture(t); const status = await c.runner.status();
  assert.equal(status.available, true); assert.equal(status.runtimes.python.imageId, IMAGE); assert.equal(status.runtimes.node.imageId, IMAGE);
  assert.equal(status.isolation.hostFallback, false); assert.equal(status.isolation.network, "none");
  assert.equal(c.docker.calls.some((args) => args.includes("pull") || args.includes("build")), false);
  c.docker.imageFailure = true;
  await rejects(() => c.runner.prepare(A, input), "SANDBOX_UNAVAILABLE");
  c.docker.imageFailure = false; c.docker.imageMalformed = true;
  assert.equal((await c.runner.status()).available, false);
  c.docker.imageMalformed = false; c.docker.os = "windows";
  assert.equal((await c.runner.status()).available, false);
  c.docker.infoFailure = true;
  assert.match((await c.runner.status()).runtimes.python.error, /Docker不可用/);
});
test("constructor and normalized argument validation fail closed", async (t) => {
  assert.throws(() => new SandboxRunner(), SandboxError);
  const c = await fixture(t);
  assert.throws(() => new SandboxRunner({ files: c.files, maxOutputBytes: 10 }), /大小/);
  for (const args of [null, [], { ...input, runtime: "bash" }, { ...input, extra: true }, { ...input, args: [1] }, { ...input, args: ["\0"] }, { ...input, args: Array(65).fill("x") }, { ...input, args: ["x".repeat(4097)] }, { ...input, timeoutSeconds: 0 }, { ...input, timeoutSeconds: 3601 }]) await rejects(() => c.runner.prepare(A, args), "INVALID_ARGUMENTS");
  await rejects(() => c.runner.prepare("wrong", input), "INVALID_SESSION");
  await rejects(() => c.runner.prepare(A, { ...input, scriptPath: "../escape.py" }), "PATH_ESCAPE");
  await c.files.writeBytes(A, { path: "bad.py", bytes: Buffer.from([255, 254]) });
  await rejects(() => c.runner.prepare(A, { ...input, scriptPath: "bad.py" }), "INVALID_SCRIPT");
  await c.files.writeBytes(A, { path: "bad.py", bytes: Buffer.from("\0"), overwrite: true });
  await rejects(() => c.runner.prepare(A, { ...input, scriptPath: "bad.py" }), "INVALID_SCRIPT");
});
test("prepare binds full frozen code/hash/image/scope and one-shot approval identity", async (t) => {
  const c = await fixture(t), prepared = await c.runner.prepare(A, input);
  assert.equal(prepared.code, "print('approved')\n"); assert.equal(prepared.approvalArgs.code, prepared.code);
  assert.equal(prepared.sha256, createHash("sha256").update(prepared.code).digest("hex"));
  assert.deepEqual(prepared.approvalArgs.scope, { sessionId: A, workspace: "/workspace", access: "read-write", network: "none" });
  assert.equal(Object.isFrozen(prepared), true); assert.equal(Object.isFrozen(prepared.approvalArgs.args), true);
  await rejects(() => c.runner.run(A, input), "SANDBOX_NOT_APPROVED");
  await rejects(() => c.runner.run(A, input, { prepared, approved: false }), "SANDBOX_NOT_APPROVED");
  await rejects(() => c.runner.run(A, input, { prepared: structuredClone(prepared), approved: true }), "SANDBOX_NOT_APPROVED");
  await rejects(() => c.runner.run(B, input, { prepared, approved: true }), "SANDBOX_NOT_APPROVED");
  await rejects(() => c.runner.run(A, { ...input, args: ["changed"] }, { prepared, approved: true }), "SANDBOX_NOT_APPROVED");
  await c.files.writeBytes(A, { path: "script.py", bytes: Buffer.from("print('mutated')"), overwrite: true }); c.docker.image = OTHER_IMAGE;
  const job = await c.runner.run(A, input, { prepared, approved: true });
  await until(() => c.docker.waits.size === 1);
  const command = c.docker.calls.find((args) => args[0] === "create"), root = await c.files.root(A);
  const frozenPath = (await readdir(root)).find((name) => name.startsWith(".sandbox-script-"));
  assert.equal(await readFile(path.join(root, frozenPath), "utf8"), prepared.code);
  assert.equal(command.includes(IMAGE), true); assert.equal(command.includes(OTHER_IMAGE), false);
  assert.equal(command.includes("script.py"), false); assert.equal(c.docker.lastInput.toString(), prepared.code);
  await rejects(() => c.runner.run(A, input, { prepared, approved: true }), "SANDBOX_NOT_APPROVED");
  assert.equal((await c.runner.stop(A, job.jobId)).state, "cancelled");
});
test("run is immediate background, restricted fixed Docker args and immutable approval payload", async (t) => {
  const c = await fixture(t), args = { ...input, args: ["--privileged", "a;whoami", "--mount=/"] };
  const { job } = await start(c, args); assert.equal(job.state, "running");
  const cmd = c.docker.calls.find((args) => args[0] === "create");
  for (const [flag, value] of [["--network", "none"], ["--cap-drop", "ALL"], ["--security-opt", "no-new-privileges:true"], ["--user", "65532:65532"], ["--entrypoint", "/opt/venv/bin/python"], ["--pull", "never"], ["--memory", "1024m"], ["--cpus", "1"], ["--pids-limit", "128"]]) assert.equal(cmd[cmd.indexOf(flag) + 1], value);
  assert.equal(cmd.includes("--read-only"), true); assert.equal(cmd.filter((value) => value === "--mount").length, 1);
  assert.equal(cmd[cmd.indexOf("--mount") + 1], `type=bind,source=${await c.files.root(A)},target=/workspace,bind-propagation=rprivate`);
  assert.match(cmd[cmd.indexOf("--tmpfs") + 1], /size=64m/); assert.deepEqual(cmd.slice(-3), args.args);
  assert.equal(cmd.slice(0, cmd.indexOf(IMAGE)).includes("--privileged"), false);
  assert.equal(cmd.some((value) => value.includes("docker.sock") || value.includes(c.stateDir)), false);
  job.state = "succeeded"; assert.equal((await c.runner.get(A, job.jobId)).state, "running");
  c.docker.finish(job, 0, "stdout", "stderr"); const finished = await terminal(c, job);
  assert.equal(finished.state, "succeeded"); assert.equal(finished.exitCode, 0); assert.equal(finished.stdout, "stdout"); assert.equal(finished.stderr, "stderr"); assert.ok(finished.endedAt);
  assert.equal(c.docker.containers.size, 0); assert.equal((await c.runner.stop(A, job.jobId)).state, "succeeded");
  const persisted = JSON.parse(await readFile(path.join(c.stateDir, A, `${job.jobId}.json`), "utf8"));
  assert.equal(persisted.cleanupPending, false); assert.equal(persisted.job.state, "succeeded");
});
test("Node uses fixed Node entry and frozen verified CommonJS script; nonzero exit is failed", async (t) => {
  const c = await fixture(t); await c.files.writeBytes(A, { path: "test.cjs", bytes: Buffer.from("console.log('ok')") });
  const { job } = await start(c, { runtime: "node", scriptPath: "test.cjs", timeoutSeconds: 3, args: ["--inspect"] });
  const command = c.docker.calls.find((args) => args[0] === "create");
  assert.equal(command[command.indexOf("--entrypoint") + 1], "/usr/local/bin/node"); assert.equal(command.includes("--input-type=commonjs"), true);
  assert.equal(c.docker.lastInput.toString(), "console.log('ok')");
  c.docker.finish(job, 7); const finished = await terminal(c, job); assert.equal(finished.state, "failed"); assert.equal(finished.exitCode, 7);
});
test("live logs bounded and cross-session get/stop are rejected", async (t) => {
  const c = await fixture(t, { maxOutputBytes: 128 }), { job } = await start(c);
  const container = c.docker.containers.get(`thu-campus-sandbox-${job.jobId}`); container.stdout = "x".repeat(300); container.stderr = "y".repeat(200);
  const live = await c.runner.get(A, job.jobId); assert.equal(Buffer.byteLength(live.stdout), 128); assert.equal(live.stderr.length, 128); assert.equal(live.truncated, true);
  await rejects(() => c.runner.get(B, job.jobId), "SANDBOX_JOB_NOT_FOUND"); await rejects(() => c.runner.stop(A, "invalid"), "SANDBOX_JOB_NOT_FOUND");
  c.docker.logsFailure = true;
  const missingLogs = await c.runner.get(A, job.jobId);
  assert.equal(missingLogs.stdout.length, 128); assert.equal(missingLogs.stderr, "y".repeat(128));
  assert.equal((await c.runner.stop(A, job.jobId)).state, "cancelled");
});
test("stop waits for launch and removes exact owned ID, not just wait client", async (t) => {
  const c = await fixture(t); let release; c.docker.runGate = new Promise((resolve) => { release = resolve; });
  const prepared = await c.runner.prepare(A, input); const job = await c.runner.run(A, input, { prepared, approved: true });
  const stopping = c.runner.stop(A, job.jobId); await tick(); assert.equal(c.docker.calls.some((args) => args[0] === "rm"), false);
  release(); const cancelled = await stopping; assert.equal(cancelled.state, "cancelled");
  const removed = c.docker.calls.find((args) => args[0] === "rm"); assert.match(removed[2], /^[0-9a-f]{64}$/); assert.equal(c.docker.containers.size, 0);
});
test("timeout kills actual container and closes lifecycle", async (t) => {
  let timeout; const c = await fixture(t, { setTimer: (fn) => { timeout = fn; return {}; }, clearTimer: () => {} });
  const { job } = await start(c); timeout(); const timed = await terminal(c, job);
  assert.equal(timed.state, "timed_out"); assert.equal(c.docker.containers.size, 0); assert.equal(c.docker.calls.some((args) => args[0] === "rm"), true);
});
test("CLI startup/wait failures never imply success and remove live container", async (t) => {
  const c = await fixture(t); c.docker.runFailure = true;
  const { job: first } = await start(c); assert.equal((await terminal(c, first)).state, "interrupted");
  c.docker.runFailure = false; c.docker.waitFailure = true;
  const { job: second } = await start(c); assert.equal((await terminal(c, second)).state, "interrupted"); assert.equal(c.docker.containers.size, 0);
});
test("close and stopSession affect only matching jobs and close is idempotent", async (t) => {
  const c = await fixture(t); await c.files.writeBytes(B, { path: "script.py", bytes: Buffer.from("pass") });
  const { job: a } = await start(c); const { job: b } = await start(c, input, B);
  const stopped = await c.runner.stopSession(A); assert.equal(stopped.length, 1); assert.equal(stopped[0].jobId, a.jobId); assert.equal(stopped[0].state, "cancelled");
  assert.equal((await c.runner.get(B, b.jobId)).state, "running"); await c.runner.close(); await c.runner.close();
  assert.equal(c.docker.containers.size, 0); await rejects(() => c.runner.status(), "SANDBOX_CLOSED");
  const record = JSON.parse(await readFile(path.join(c.stateDir, B, `${b.jobId}.json`), "utf8")); assert.equal(record.job.state, "interrupted");
});
test("identity mismatch refuses to touch other containers, retains interruption and supports cleanup retry", async (t) => {
  const c = await fixture(t), { job } = await start(c);
  const container = c.docker.containers.get(`thu-campus-sandbox-${job.jobId}`), owner = container.Config.Labels[`${LABEL}.owner`];
  container.Config.Labels[`${LABEL}.owner`] = B;
  const stopped = await c.runner.stop(A, job.jobId); assert.equal(stopped.state, "interrupted"); assert.match(stopped.stderr, /回收待确认/);
  assert.equal(c.docker.calls.some((args) => args[0] === "rm"), false); assert.equal(c.docker.containers.size, 1);
  container.Config.Labels[`${LABEL}.owner`] = owner; c.docker.removeFailure = true;
  assert.equal((await c.runner.stop(A, job.jobId)).state, "interrupted");
  c.docker.removeFailure = false; await c.runner.stop(A, job.jobId); assert.equal(c.docker.containers.size, 0);
});
test("daemon disconnect leaves cleanupPending; retry does not falsely report stopped", async (t) => {
  const c = await fixture(t), { job } = await start(c); c.docker.inspectFailure = true;
  const interrupted = await c.runner.stop(A, job.jobId); assert.equal(interrupted.state, "interrupted");
  const record = JSON.parse(await readFile(path.join(c.stateDir, A, `${job.jobId}.json`), "utf8")); assert.equal(record.cleanupPending, true);
  c.docker.inspectFailure = false; await c.runner.stop(A, job.jobId); assert.equal(c.docker.containers.size, 0);
});
test("restart recovers exact persisted running job as interrupted, not succeeded", async (t) => {
  const c = await fixture(t), { job } = await start(c); await c.runner.stop(A, job.jobId);
  const filename = path.join(c.stateDir, A, `${job.jobId}.json`), record = JSON.parse(await readFile(filename, "utf8"));
  record.job.state = "running"; record.cleanupPending = true; await writeFile(filename, JSON.stringify(record));
  // Simulate a daemon container that outlived its previous runner process.
  c.docker.containers.set(record.containerName, { Id: record.containerId, Name: `/${record.containerName}`, Config: { Image: record.imageId, Labels: { [LABEL]: "1", [`${LABEL}.scope`]: record.scope, [`${LABEL}.owner`]: record.owner, [`${LABEL}.session`]: A, [`${LABEL}.job`]: job.jobId } }, State: { Running: true, ExitCode: 0 }, stdout: "before restart", stderr: "" });
  await mkdir(path.join(c.stateDir, "ignored")); await writeFile(path.join(c.stateDir, A, "ignore.tmp"), "ignored");
  const runner = new SandboxRunner({ files: c.files, stateDir: c.stateDir, command: c.docker.command });
  const notifications = []; runner.onComplete(event => notifications.push(event));
  const recovered = await runner.get(A, job.jobId); assert.equal(recovered.state, "interrupted"); assert.equal(recovered.stdout, "before restart"); assert.equal(c.docker.containers.size, 0); await tick(); assert.deepEqual(notifications, []);
  await runner.close();
});
test("terminal persistence is read without Docker mutations and corrupt ledgers fail closed", async (t) => {
  const c = await fixture(t), { job } = await start(c); c.docker.finish(job); await terminal(c, job);
  const before = c.docker.calls.length, restored = new SandboxRunner({ files: c.files, stateDir: c.stateDir, command: c.docker.command });
  assert.equal((await restored.get(A, job.jobId)).state, "succeeded"); assert.equal(c.docker.calls.length, before); await restored.close();
  const filename = path.join(c.stateDir, A, `${job.jobId}.json`), record = JSON.parse(await readFile(filename, "utf8")); record.owner = "invalid";
  await writeFile(filename, JSON.stringify(record));
  const invalid = new SandboxRunner({ files: c.files, stateDir: c.stateDir, command: c.docker.command }); await rejects(() => invalid.status(), "SANDBOX_STATE");
  await writeFile(filename, "x".repeat(220000));
  const oversized = new SandboxRunner({ files: c.files, stateDir: c.stateDir, command: c.docker.command }); await rejects(() => oversized.status(), "SANDBOX_STATE");
});
test("state directory inside mounted session and unsafe roots are rejected", async (t) => {
  const c = await fixture(t), root = await c.files.root(A);
  const invalid = new SandboxRunner({ files: c.files, stateDir: path.join(root, "state"), command: c.docker.command });
  await rejects(() => invalid.prepare(A, input), "INVALID_WORKSPACE");
  const fakeFiles = { root: async () => path.parse(root).root, resolve() {}, readBytes() {}, writeBytes() {} };
  const badRoot = new SandboxRunner({ files: fakeFiles, command: c.docker.command }); await rejects(() => badRoot.prepare(A, input), "INVALID_WORKSPACE");
  const noBase = { root: c.files.root.bind(c.files), resolve: c.files.resolve.bind(c.files), readBytes: c.files.readBytes.bind(c.files), writeBytes: c.files.writeBytes.bind(c.files) };
  const derived = new SandboxRunner({ files: noBase, command: c.docker.command }); assert.equal((await derived.prepare(A, input)).imageId, IMAGE); await derived.close();
  const withDefault = new SandboxRunner({ files: c.files, command: c.docker.command }); assert.equal((await withDefault.status()).available, true); await withDefault.close();
});

test("completion listeners observe confirmed cleanup once and cannot change compute success", async (t) => {
  const c = await fixture(t), events = [];
  assert.throws(() => c.runner.onComplete(null), e => e.code === "INVALID_ARGUMENTS");
  c.runner.onComplete(() => { throw new Error("observer failed"); });
  c.runner.onComplete(async () => { throw new Error("async observer failed"); });
  const remove = c.runner.onComplete(value => events.push(value));
  const { job } = await start(c); c.docker.finish(job); await terminal(c, job); await until(() => events.length === 1);
  assert.equal(events[0].sessionId, A); assert.equal(events[0].job.state, "succeeded"); assert.equal(events[0].job.cleanupPending, false);
  assert.equal(c.runner.hasActiveJobs(A), false); await c.runner.get(A, job.jobId); assert.equal(events.length, 1);
  remove(); const { job: next } = await start(c); await c.runner.stop(A, next.jobId); await tick(); assert.equal(events.length, 1);
});
test("cleanup pending is observable and does not trigger upload until exact stop succeeds", async (t) => {
  const c = await fixture(t), events = []; c.runner.onComplete(value => events.push(value));
  const { job } = await start(c); c.docker.removeFailure = true;
  const pending = await c.runner.stop(A, job.jobId);
  assert.equal(pending.state, "interrupted"); assert.equal(pending.cleanupPending, true); assert.equal(events.length, 0); assert.equal(c.runner.hasActiveJobs(A), true);
  c.docker.removeFailure = false; const stopped = await c.runner.stop(A, job.jobId);
  assert.equal(stopped.cleanupPending, false); assert.equal(events.length, 1); assert.equal(c.runner.hasActiveJobs(A), false);
});
test("cloud offline does not block local-ledger GET, stop or restart recovery", async (t) => {
  const c = await fixture(t), { job } = await start(c);
  c.files.cleanupRoot = async sid => [path.join(c.files.baseDir, sid)];
  c.files.root = async () => { throw Object.assign(new Error("cloud offline"), { code: "CLOUD_UNAVAILABLE" }); };
  assert.equal((await c.runner.get(A, job.jobId)).state, "running");
  assert.equal((await c.runner.stop(A, job.jobId)).state, "cancelled");
  const restored = new SandboxRunner({ files: c.files, stateDir: c.stateDir, command: c.docker.command });
  await restored.initialize(); assert.equal((await restored.get(A, job.jobId)).state, "cancelled"); await restored.close();
  await rejects(() => c.runner.get("invalid", job.jobId), "INVALID_SESSION");
  c.files.cleanupRoot = async () => []; await rejects(() => c.runner.get(A, job.jobId), "SANDBOX_STATE");
});
test("runtime preparation restores cloud inputs and writes frozen source only to local cache", async (t) => {
  const c = await fixture(t), calls = [];
  c.files.prepareRuntime = async sid => { assert.equal(sid, A); calls.push("hydrate"); return { mode: "cloud", state: "unconfirmed", keptDirty: ["input.csv"] }; };
  c.files.writeRuntimeBytes = async (sid, args) => { assert.match(args.path, /^\.sandbox-script-/); calls.push("runtime-local"); return c.files.writeBytes(sid, args); };
  const { prepared, job } = await start(c); assert.deepEqual(calls, ["hydrate", "runtime-local"]);
  assert.equal(prepared.approvalArgs.inputStorage.state, "unconfirmed"); assert.deepEqual(prepared.approvalArgs.inputStorage.keptDirty, ["input.csv"]); assert.equal(Object.isFrozen(prepared.approvalArgs.inputStorage), true);
  await c.runner.stop(A, job.jobId);
});
