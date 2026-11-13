import path from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile, rename, readdir, lstat, chmod } from "node:fs/promises";
import { inspectAbsolute, relativePath } from "./workspace-paths.mjs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const IMAGE_ID = /^sha256:[0-9a-f]{64}$/;
const CONTAINER_ID = /^[0-9a-f]{64}$/;
const STATES = new Set(["running", "succeeded", "failed", "cancelled", "timed_out", "interrupted"]);
const LABEL = "work.thu-campus.sandbox";
const LIMITS = Object.freeze({ memoryMb: 1024, cpus: 1, pids: 128, tmpMb: 64, maxTimeoutSeconds: 3600, maxScriptBytes: 1024 * 1024 });
const hash = (value) => createHash("sha256").update(value).digest("hex");
const json = (value) => JSON.stringify(value);
const copy = (value) => JSON.parse(json(value));
const fail = (code, message) => { throw new SandboxError(code, message); };
const contained = (parent, child) => { const rel = path.relative(parent, child); return !rel || (!path.isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${path.sep}`)); };
function bounded(value, limit) { const bytes = Buffer.from(value); return { text: bytes.subarray(0, limit).toString("utf8"), truncated: bytes.length > limit }; }
function freeze(value) { for (const child of Object.values(value)) if (child && typeof child === "object") freeze(child); return Object.freeze(value); }

export class SandboxError extends Error {
  constructor(code, message) { super(message); this.name = "SandboxError"; this.code = code; }
}

/** Docker CLI transport only. Never invokes a host Python/Node interpreter. */
export function createDockerCommand({ spawnProcess = spawn, maxOutputBytes = 65536, controlTimeoutMs = 30000 } = {}) {
  // These variables configure the Docker *client*. None is forwarded with docker --env.
  const env = Object.fromEntries(["PATH", "Path", "SystemRoot", "WINDIR", "HOME", "USERPROFILE", "DOCKER_HOST", "DOCKER_CONTEXT", "DOCKER_CONFIG", "DOCKER_TLS_VERIFY", "DOCKER_CERT_PATH"].filter((key) => process.env[key] !== undefined).map((key) => [key, process.env[key]]));
  return (args, { timeoutMs = controlTimeoutMs, onChild, input } = {}) => new Promise((resolve, reject) => {
    let child;
    try { child = spawnProcess("docker", args, { shell: false, windowsHide: true, env, stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"] }); }
    catch (error) { reject(error); return; }
    let stdout = Buffer.alloc(0), stderr = Buffer.alloc(0), truncated = false, expired = false, inputError;
    const append = (previous, chunk) => { const bytes = Buffer.from(chunk); if (previous.length + bytes.length > maxOutputBytes) truncated = true; return Buffer.concat([previous, bytes.subarray(0, Math.max(0, maxOutputBytes - previous.length))]); };
    child.stdout.on("data", (chunk) => { stdout = append(stdout, chunk); });
    child.stderr.on("data", (chunk) => { stderr = append(stderr, chunk); });
    const timer = setTimeout(() => { expired = true; child.kill(); }, timeoutMs);
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("close", (code) => { clearTimeout(timer); resolve({ code, stdout: stdout.toString("utf8"), stderr: stderr.toString("utf8"), truncated, expired, ...(inputError ? { inputError } : {}) }); });
    onChild?.(child);
    if (input !== undefined) {
      child.stdin.on("error", (error) => { inputError = error.code || "STDIN_ERROR"; });
      child.stdin.end(input);
    }
  });
}

function normalize(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some((key) => !["runtime", "scriptPath", "args", "timeoutSeconds"].includes(key))) fail("INVALID_ARGUMENTS", "代码作业参数不合法。");
  const { runtime, scriptPath, args = [], timeoutSeconds = 120 } = value;
  if (!["python", "node"].includes(runtime)) fail("INVALID_ARGUMENTS", "运行时仅支持python或node。");
  const script = relativePath(scriptPath, { allowRoot: false });
  if (!Array.isArray(args) || args.length > 64 || args.some((arg) => typeof arg !== "string" || arg.length > 4096 || arg.includes("\0"))) fail("INVALID_ARGUMENTS", "脚本参数必须是有界字符串数组。");
  if (!Number.isSafeInteger(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > LIMITS.maxTimeoutSeconds) fail("INVALID_ARGUMENTS", "执行时限必须为1至3600秒。");
  return { runtime, scriptPath: script, args: [...args], timeoutSeconds };
}

/** One runner per stateDir. The trusted job ledger is NEVER bind-mounted. */
export class SandboxRunner {
  #files; #command; #images; #stateDir; #scope; #owner = randomUUID(); #prepared = new WeakMap(); #jobs = new Map(); #ready; #closed = false; #user; #outputLimit; #now; #setTimer; #clearTimer;
  constructor({ files, pythonImage = "thu-campus-sandbox-python:1.4.0", nodeImage = "node:24-bookworm-slim", stateDir, command, spawnProcess, maxOutputBytes = 65536, now = () => Date.now(), setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
    if (!files || ["root", "resolve", "readBytes", "writeBytes"].some((key) => typeof files[key] !== "function")) fail("INVALID_ARGUMENTS", "沙盒需要有效的WorkspaceFiles接口。");
    if (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes < 128 || maxOutputBytes > 1024 * 1024) fail("INVALID_ARGUMENTS", "输出保留大小不合法。");
    this.#files = files; this.#command = command || createDockerCommand({ spawnProcess, maxOutputBytes });
    this.#images = { python: pythonImage, node: nodeImage }; this.#outputLimit = maxOutputBytes; this.#now = now; this.#setTimer = setTimer; this.#clearTimer = clearTimer;
    const uid = process.getuid?.();
    this.#user = uid === undefined ? "65532:65532" : uid > 0 ? `${uid}:${process.getgid()}` : null;
    if (stateDir || files.baseDir) this.#configureState(stateDir || path.join(path.dirname(files.baseDir), "sandbox-jobs"));
  }
  #configureState(directory) {
    this.#stateDir = path.resolve(directory); this.#scope = hash(this.#stateDir);
    // Defer until an operation is awaited, so constructor never emits unhandled rejections.
  }
  async #init() {
    if (!this.#ready) this.#ready = this.#recover();
    return this.#ready;
  }
  async #root(sessionId) {
    if (!UUID.test(sessionId)) fail("INVALID_SESSION", "会话ID必须是有效UUID。");
    const root = path.resolve(await this.#files.root(sessionId));
    if (path.basename(root).toLowerCase() !== sessionId.toLowerCase() || root === path.parse(root).root || /[,\r\n]/.test(root)) fail("INVALID_WORKSPACE", "会话挂载目录不安全。");
    if (!this.#stateDir) this.#configureState(path.join(path.dirname(path.dirname(root)), "sandbox-jobs"));
    if (contained(root, this.#stateDir) || contained(this.#stateDir, root)) fail("INVALID_WORKSPACE", "作业状态目录必须与会话挂载目录隔离。");
    await this.#init();
    return root;
  }
  #open() { if (this.#closed) fail("SANDBOX_CLOSED", "沙盒运行器已关闭。"); }
  async status() {
    this.#open();
    if (this.#stateDir) await this.#init();
    let daemonError;
    try {
      const info = await this.#command(["info", "--format", "{{.OSType}}"]);
      if (info.code !== 0 || info.stdout.trim() !== "linux") daemonError = "需要可用的Linux Docker daemon。";
      if (!this.#user) daemonError = "Linux宿主root不能安全读取工作区私有文件；请以非root用户运行应用。";
    } catch { daemonError = "Docker不可用；不会回退到宿主运行。"; }
    const runtimes = {};
    for (const [runtime, image] of Object.entries(this.#images)) {
      let imageId, error = daemonError;
      if (!error) {
        try {
          const result = await this.#command(["image", "inspect", image, "--format", "{{json .}}"]);
          const info = result.code === 0 ? JSON.parse(result.stdout) : null;
          if (!info || info.Os !== "linux" || !IMAGE_ID.test(info.Id)) error = "本地Linux运行时镜像未准备好；不会自动拉取。";
          else imageId = info.Id;
        } catch { error = "无法检查本地镜像；不会自动拉取。"; }
      }
      runtimes[runtime] = { available: !error, image, ...(imageId ? { imageId } : {}), ...(error ? { error } : {}) };
    }
    return { available: Object.values(runtimes).some((runtime) => runtime.available), runtimes, isolation: { backend: "docker", hostFallback: false, network: "none", nonRoot: true, readOnlyRoot: true, limits: LIMITS } };
  }
  async prepare(sessionId, args) {
    this.#open();
    const input = normalize(args), root = await this.#root(sessionId);
    const runtime = (await this.status()).runtimes[input.runtime];
    if (!runtime.available) fail("SANDBOX_UNAVAILABLE", runtime.error);
    await this.#files.resolve(sessionId, input.scriptPath);
    const bytes = await this.#files.readBytes(sessionId, input.scriptPath, { maxBytes: LIMITS.maxScriptBytes });
    let code;
    try { code = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
    catch { fail("INVALID_SCRIPT", "脚本必须是完整有效的UTF-8文本。"); }
    if (code.includes("\0")) fail("INVALID_SCRIPT", "脚本不能包含空字符。");
    const sha256 = hash(Buffer.from(code));
    const prepared = freeze({ sessionId, ...input, code, sha256, imageId: runtime.imageId,
      approvalArgs: { ...input, code, sha256, image: runtime.image, imageId: runtime.imageId, scope: { sessionId, workspace: "/workspace", access: "read-write", network: "none" }, isolation: { nonRoot: true, readOnlyRoot: true, capabilities: "none", noNewPrivileges: true, limits: LIMITS } } });
    this.#prepared.set(prepared, { sessionId, input, root, code, sha256, imageId: runtime.imageId });
    return prepared;
  }
  async run(sessionId, args, { prepared, approved } = {}) {
    this.#open();
    const input = normalize(args), frozen = prepared && this.#prepared.get(prepared);
    if (approved !== true || !frozen || frozen.sessionId !== sessionId || json(input) !== json(frozen.input)) fail("SANDBOX_NOT_APPROVED", "执行需要当前实例中已批准且参数、会话完全匹配的冻结脚本。");
    const root = await this.#root(sessionId);
    if (root !== frozen.root) fail("SANDBOX_NOT_APPROVED", "批准后的工作区位置发生变化。");
    this.#prepared.delete(prepared); // One-shot approval, including failed launches.
    const jobId = randomUUID(), frozenPath = `.sandbox-script-${jobId}${input.runtime === "python" ? ".py" : ".cjs"}`;
    await this.#files.writeBytes(sessionId, { path: frozenPath, bytes: Buffer.from(frozen.code), overwrite: false });
    const absolute = await this.#files.resolve(sessionId, frozenPath);
    await chmod(absolute, 0o400);
    const entry = { sessionId, owner: this.#owner, scope: this.#scope, root, imageId: frozen.imageId, containerName: `thu-campus-sandbox-${jobId}`, frozenPath, cleanupPending: true,
      job: { jobId, state: "running", runtime: input.runtime, scriptPath: input.scriptPath, startedAt: new Date(this.#now()).toISOString(), stdout: "", stderr: "" } };
    await this.#save(entry); this.#jobs.set(jobId, entry);
    entry.task = this.#execute(entry, input, frozen.code).catch((error) => {
      this.#clearTimer(entry.timer); entry.cleanupPending = true; entry.job.state = "interrupted";
      this.#message(entry, `作业账本写入失败，回收状态待确认：${error.message}`);
    });
    return copy(entry.job);
  }
  #dockerArgs(entry, input) {
    return ["create", "--interactive", "--pull", "never", "--name", entry.containerName,
      "--label", `${LABEL}=1`, "--label", `${LABEL}.scope=${this.#scope}`, "--label", `${LABEL}.owner=${entry.owner}`, "--label", `${LABEL}.session=${entry.sessionId}`, "--label", `${LABEL}.job=${entry.job.jobId}`,
      "--user", this.#user, "--network", "none", "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges:true",
      "--memory", `${LIMITS.memoryMb}m`, "--memory-swap", `${LIMITS.memoryMb}m`, "--cpus", String(LIMITS.cpus), "--pids-limit", String(LIMITS.pids),
      "--tmpfs", `/tmp:rw,noexec,nosuid,nodev,size=${LIMITS.tmpMb}m,mode=1777`, "--ulimit", "nofile=256:256", "--ipc", "none",
      "--log-driver", "local", "--log-opt", "max-size=1m", "--log-opt", "max-file=1", "--log-opt", "compress=false", "--workdir", "/workspace",
      "--mount", `type=bind,source=${entry.root},target=/workspace,bind-propagation=rprivate`,
      "--env", "HOME=/tmp", "--env", "XDG_CACHE_HOME=/tmp/cache", "--env", "MPLCONFIGDIR=/tmp/matplotlib", "--env", "MPLBACKEND=Agg", "--env", "PYTHONDONTWRITEBYTECODE=1", "--env", "PYTHONUNBUFFERED=1", "--env", "OMP_NUM_THREADS=2", "--env", "OPENBLAS_NUM_THREADS=2", "--env", "MKL_NUM_THREADS=2", "--env", "NUMEXPR_NUM_THREADS=2",
      "--entrypoint", input.runtime === "python" ? "/opt/venv/bin/python" : "/usr/local/bin/node", entry.imageId,
      ...(input.runtime === "python" ? ["-u", "-"] : [input.scriptPath.endsWith(".mjs") ? "--input-type=module" : "--input-type=commonjs", "-"]), ...input.args];
  }
  async #execute(entry, input, code) {
    entry.timer = this.#setTimer(() => { void this.#cancel(entry, "timed_out"); }, input.timeoutSeconds * 1000);
    entry.timer?.unref?.();
    try {
      entry.launch = this.#command(this.#dockerArgs(entry, input));
      const launch = await entry.launch;
      if (launch.code !== 0 || !CONTAINER_ID.test(launch.stdout.trim())) {
        if (launch.stderr) this.#message(entry, `Docker创建错误：${launch.stderr}`);
        throw new Error("Docker创建未确认。");
      }
      entry.containerId = launch.stdout.trim(); await this.#save(entry);
      if (entry.requested) { await this.#cancel(entry, entry.requested); return; }
      // create finishes before start: cancellation never waits for a training script.
      const result = await this.#command(["start", "--attach", "--interactive", entry.containerId], { input: Buffer.from(code), timeoutMs: (input.timeoutSeconds + 35) * 1000, onChild: (child) => { entry.waitChild = child; } });
      if (entry.requested) { await entry.stopping; return; }
      if (result.code !== 0 && result.stderr) this.#message(entry, `Docker启动/附加错误：${result.stderr}`);
      if (result.inputError) this.#message(entry, `冻结代码stdin传输失败：${result.inputError}`);
      const container = await this.#container(entry);
      if (result.expired || !container || container.State.Running || !Number.isInteger(container.State.ExitCode)) throw new Error("容器最终状态无法确认。");
      await this.#logs(entry, container.Id);
      await this.#remove(entry, container);
      await this.#finish(entry, container.State.ExitCode === 0 && !container.State.Error && result.code === 0 && !result.inputError ? "succeeded" : "failed", container.State.ExitCode);
    } catch (error) {
      if (!entry.requested) this.#message(entry, `作业中断：${error.message}`);
      await this.#cancel(entry, entry.requested || "interrupted");
    } finally { this.#clearTimer(entry.timer); }
  }
  async #container(entry) {
    const result = await this.#command(["container", "inspect", entry.containerName]);
    if (result.code !== 0) {
      if (/no such (?:object|container)/i.test(result.stderr)) return null;
      fail("SANDBOX_UNAVAILABLE", "无法确认容器状态，保留作业记录等待恢复。");
    }
    const container = JSON.parse(result.stdout)[0], labels = container?.Config?.Labels;
    if (!container || !CONTAINER_ID.test(container.Id) || container.Name !== `/${entry.containerName}` || (entry.containerId && container.Id !== entry.containerId) || container.Config.Image !== entry.imageId || labels?.[LABEL] !== "1" || labels[`${LABEL}.scope`] !== this.#scope || labels[`${LABEL}.owner`] !== entry.owner || labels[`${LABEL}.session`] !== entry.sessionId || labels[`${LABEL}.job`] !== entry.job.jobId) fail("SANDBOX_OWNERSHIP", "容器身份不匹配，拒绝操作其他容器。");
    if (container.State?.Error) this.#message(entry, `容器错误：${container.State.Error}`);
    return container;
  }
  async #logs(entry, id) {
    const result = await this.#command(["logs", id]);
    // A concurrent owned cleanup can remove the container between inspect and logs.
    // Keep prior output/diagnostics; log-fetch errors are not program stderr.
    if (result.code !== 0) return;
    const out = bounded(result.stdout, this.#outputLimit), err = bounded(result.stderr, this.#outputLimit);
    entry.job.stdout = out.text; entry.logStderr = err.text; this.#stderr(entry);
    if (result.truncated || out.truncated || err.truncated) entry.job.truncated = true;
  }
  async #remove(entry, container) {
    const result = await this.#command(["rm", "--force", container.Id]);
    if (result.code !== 0 || await this.#container(entry)) fail("SANDBOX_CLEANUP", "容器回收未确认，不能报告作业已安全结束。");
    entry.cleanupPending = false;
  }
  #stderr(entry) {
    const result = bounded([entry.diagnostics, entry.logStderr].filter(Boolean).join("\n"), this.#outputLimit);
    entry.job.stderr = result.text; if (result.truncated) entry.job.truncated = true;
  }
  #message(entry, message) {
    const previous = entry.diagnostics || "";
    if (!previous.includes(message)) {
      const result = bounded(`${previous}\n${message}`.trim(), this.#outputLimit);
      entry.diagnostics = result.text; if (result.truncated) entry.job.truncated = true;
    }
    this.#stderr(entry);
  }
  async #finish(entry, state, exitCode) {
    this.#clearTimer(entry.timer);
    entry.job.state = state; entry.job.endedAt = new Date(this.#now()).toISOString();
    if (Number.isInteger(exitCode)) entry.job.exitCode = exitCode;
    entry.waitChild?.kill(); // The exact container was already removed; reap only its wait client.
    await this.#save(entry);
  }
  #cancel(entry, state) {
    entry.requested ||= state;
    if (entry.stopping) return entry.stopping;
    entry.stopping = (async () => {
      // Docker CLI exit/kill alone never counts as stopping the actual container.
      try {
        await entry.launch?.catch(() => {});
        const container = await this.#container(entry);
        if (container) { await this.#logs(entry, container.Id); await this.#remove(entry, container); }
        else entry.cleanupPending = false;
        await this.#finish(entry, entry.requested);
      } catch (error) {
        entry.cleanupPending = true; this.#message(entry, `容器回收待确认：${error.message}`);
        await this.#finish(entry, "interrupted");
      }
      return copy(entry.job);
    })();
    return entry.stopping;
  }
  async get(sessionId, jobId) {
    this.#open(); await this.#root(sessionId);
    const entry = this.#entry(sessionId, jobId);
    if (entry.job.state === "running" && entry.containerId) {
      const container = await this.#container(entry);
      if (container) { await this.#logs(entry, container.Id); await this.#save(entry); }
    }
    await entry.saving;
    return copy(entry.job);
  }
  async stop(sessionId, jobId) {
    this.#open(); await this.#root(sessionId);
    const entry = this.#entry(sessionId, jobId);
    if (entry.job.state !== "running" && !entry.cleanupPending) return copy(entry.job);
    if (entry.stopping && entry.cleanupPending) entry.stopping = null;
    return this.#cancel(entry, "cancelled");
  }
  async stopSession(sessionId) {
    this.#open(); await this.#root(sessionId);
    return Promise.all([...this.#jobs.values()].filter((entry) => entry.sessionId === sessionId && (entry.job.state === "running" || entry.cleanupPending)).map((entry) => this.#cancel(entry, "cancelled")));
  }
  #entry(sessionId, jobId) { const entry = UUID.test(jobId) && this.#jobs.get(jobId); if (!entry || entry.sessionId !== sessionId) fail("SANDBOX_JOB_NOT_FOUND", "作业不存在或不属于当前会话。"); return entry; }
  async close() {
    if (this.#closed) return;
    this.#closed = true;
    if (this.#stateDir) await this.#init();
    await Promise.all([...this.#jobs.values()].filter((entry) => entry.job.state === "running" || entry.cleanupPending).map((entry) => this.#cancel(entry, "interrupted")));
    await Promise.all([...this.#jobs.values()].map((entry) => entry.task));
  }
  async #save(entry) {
    const snapshot = json({ sessionId: entry.sessionId, owner: entry.owner, scope: entry.scope, root: entry.root, imageId: entry.imageId, containerName: entry.containerName, containerId: entry.containerId, frozenPath: entry.frozenPath, cleanupPending: entry.cleanupPending, job: entry.job });
    entry.saving = (entry.saving || Promise.resolve()).then(async () => {
      const directory = path.join(this.#stateDir, entry.sessionId);
      await inspectAbsolute(directory, { createDirectories: true });
      const destination = path.join(directory, `${entry.job.jobId}.json`), temp = path.join(directory, `${entry.job.jobId}.${randomUUID()}.tmp`);
      await inspectAbsolute(destination, { mustExist: false });
      await writeFile(temp, snapshot, { mode: 0o600, flag: "wx" }); await rename(temp, destination);
    });
    await entry.saving;
  }
  async #recover() {
    await inspectAbsolute(this.#stateDir, { createDirectories: true });
    await chmod(this.#stateDir, 0o700);
    for (const sessionId of await readdir(this.#stateDir)) {
      if (!UUID.test(sessionId)) continue;
      const directory = path.join(this.#stateDir, sessionId);
      await inspectAbsolute(directory);
      for (const filename of await readdir(directory)) {
        const jobId = filename.slice(0, -5);
        if (!filename.endsWith(".json") || !UUID.test(jobId)) continue;
        const filenameAbsolute = path.join(directory, filename);
        await inspectAbsolute(filenameAbsolute);
        if ((await lstat(filenameAbsolute)).size > 3 * this.#outputLimit + 16384) fail("SANDBOX_STATE", "作业记录大小不合法。");
        const entry = JSON.parse(await readFile(filenameAbsolute, "utf8"));
        const root = path.resolve(await this.#files.root(sessionId));
        if (entry.sessionId !== sessionId || entry.job?.jobId !== jobId || !STATES.has(entry.job.state) || !UUID.test(entry.owner) || entry.scope !== this.#scope || entry.root !== root || contained(root, this.#stateDir) || !IMAGE_ID.test(entry.imageId) || entry.containerName !== `thu-campus-sandbox-${jobId}` || (entry.containerId && !CONTAINER_ID.test(entry.containerId))) fail("SANDBOX_STATE", "作业记录身份不合法，拒绝恢复。");
        entry.diagnostics = entry.job.stderr;
        this.#jobs.set(jobId, entry);
        if (entry.job.state === "running" || entry.cleanupPending) await this.#cancel(entry, "interrupted");
      }
    }
  }
}
