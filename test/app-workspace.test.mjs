import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { tmpdir } from "node:os";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { WorkspaceFiles } from "../lib/app/workspace-files.mjs";
import { WorkspaceHost, WORKSPACE_TOOLS, createWorkspaceHost, workspaceJobUrl } from "../lib/app/workspace.mjs";
import { createApprovals } from "../lib/app/approvals.mjs";
import { runTurn } from "../lib/app/agent.mjs";

const A = "11111111-1111-4111-8111-111111111111", B = "22222222-2222-4222-8222-222222222222", J = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const error = (code, message = "测试错误") => Object.assign(new Error(message), { code });
async function fixture(t, overrides = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), "campus-workspace-host-"));
  assert.equal(path.isAbsolute(dir), true); assert.match(path.basename(dir), /^campus-workspace-host-/);
  t.after(() => rm(dir, { recursive: true, force: true }));
  const files = new WorkspaceFiles({ baseDir: path.join(dir, "workspaces") });
  const records = { campus: [], prepares: [], runs: [], gets: [], stops: [], closed: 0, campusClosed: 0 };
  const issued = new WeakSet();
  const sandbox = {
    status: async () => ({ available: true, runtimes: { node: { available: true } } }),
    prepare: async (sessionId, args) => {
      const code = (await files.readBytes(sessionId, args.scriptPath)).toString("utf8");
      const prepared = Object.freeze({ approvalArgs: Object.freeze({ ...args, code, sha256: "frozen-script-hash", scope: { sessionId, network: "none", workspace: "/workspace" }, isolation: { nonRoot: true, readOnlyRoot: true } }) });
      issued.add(prepared); records.prepares.push({ sessionId, args, prepared }); return prepared;
    },
    run: async (sessionId, args, context) => {
      const prepared = context.prepared;
      if (!issued.has(prepared)) throw error("INVALID_PREPARED");
      if (context.approved !== true) throw error("APPROVAL_REQUIRED");
      records.runs.push({ sessionId, args, prepared, context }); return { jobId: J, sessionId, state: "running", stdout: "", stderr: "" };
    },
    get: async (sessionId, jobId) => { records.gets.push({ sessionId, jobId }); if (sessionId !== A || jobId !== J) throw error("JOB_NOT_FOUND"); return { jobId: J, state: "succeeded", exitCode: 0 }; },
    stop: async (sessionId, jobId) => { records.stops.push({ sessionId, jobId }); if (sessionId !== A || jobId !== J) throw error("JOB_NOT_FOUND"); return { jobId: J, state: "cancelled" }; },
    close: async () => { records.closed++; },
    ...overrides,
  };
  const campus = {
    describe: () => [{ name: "campus_read", readOnly: true }], toolForModel: () => [{ type: "function", function: { name: "campus_read" } }],
    call: async (...args) => { records.campus.push(args); return { ok: true, data: { campus: true } }; }, close: async () => { records.campusClosed++; },
  };
  return { dir, files, records, sandbox, campus, host: new WorkspaceHost({ host: campus, files, sandbox }) };
}
const ctx = (extra = {}) => ({ sessionId: A, ...extra });
async function turn(host, name, args, { decision = "allow", inspectConfirm = () => {}, requireApproval = false } = {}) {
  const messages = [], events = [], approvals = createApprovals(), controller = new AbortController();
  let turns = 0;
  const result = await runTurn({
    host, sessionId: A, text: "测试工作区", model: "fake", requireApproval, approvals, signal: controller.signal,
    store: { get: async () => ({ messages: [] }), append: async (_id, rows) => messages.push(...rows) },
    route: { chat: async (body) => {
      turns++;
      if (turns > 1) assert.equal(body.messages.at(-1).role, "tool");
      return Response.json({ choices: [{ message: turns === 1 ? { content: "", tool_calls: [{ id: "call", type: "function", function: { name, arguments: JSON.stringify(args) } }] } : { content: "根据真实回执回答" } }] });
    } },
    emit: (event, data) => {
      events.push({ event, data });
      if (event !== "confirm") return;
      inspectConfirm(data);
      if (decision === "abort") { controller.abort(); approvals.cancelSession(A, "aborted"); }
      else if (decision === "timeout") approvals.cancel(data.callId, "timeout");
      else approvals.decide(data.callId, decision === "allow", A);
    },
  });
  assert.equal(approvals.list().length, 0);
  return { result, messages, events };
}

test("11个workspace工具模型schema、campus透传与每会话SID绑定", async (t) => {
  const f = await fixture(t);
  assert.equal(WORKSPACE_TOOLS.length, 11); assert.equal(new Set(WORKSPACE_TOOLS.map((tool) => tool.name)).size, 11);
  assert.equal(f.host.describe().length, 12); assert.equal(f.host.toolForModel().length, 12);
  assert.ok(WORKSPACE_TOOLS.every((tool) => tool.inputSchema.additionalProperties === false));
  assert.equal(WORKSPACE_TOOLS.find((tool) => tool.name === "workspace_run").mandatoryApproval, true);
  assert.deepEqual(await f.host.call("campus_read", { value: 1 }, ctx()), { ok: true, data: { campus: true } });
  assert.deepEqual(f.records.campus, [["campus_read", { value: 1 }]]); assert.equal(await f.host.prepareCall("campus_read", {}), undefined);
  const status = await f.host.call("workspace_status", {}, ctx());
  assert.equal(status.ok, true); assert.match(status.data.policy, /只有隔离容器/); assert.equal(path.isAbsolute(status.data.directory), true); assert.equal(status.data.sandbox.available, true);
  for (const context of [{}, { sessionId: "bad" }]) assert.equal((await f.host.call("workspace_status", {}, context)).error.code, "INVALID_SESSION");
  for (const args of [null, [], "x"]) assert.equal((await f.host.call("workspace_status", args, ctx())).error.code, "INVALID_ARGUMENTS");
  assert.equal((await f.host.call("workspace_unknown", {}, ctx())).error.code, "UNKNOWN_TOOL");
  await assert.rejects(f.host.prepareCall("workspace_run", { runtime: "node", scriptPath: "x.js" }, {}), (e) => e.code === "INVALID_SESSION");
  await assert.rejects(f.host.prepareCall("workspace_import", { sourcePath: "relative", path: "out" }, ctx()), (e) => e.code === "INVALID_ARGUMENTS");
  assert.equal(await f.host.prepareCall("workspace_read", { path: "x" }, ctx()), undefined);
  for (const name of [null, "../../run", "BAD"]) assert.equal((await f.host.call(name, {})).error.code, "INVALID_TOOL");
  assert.equal(await f.host.prepareCall(null), undefined);
  assert.deepEqual(await f.host.call("workspace_status", {}, ctx({ prepared: { error: { code: "PRECHECK", message: "拒绝" } } })), { ok: false, error: { code: "PRECHECK", message: "拒绝" } });
});

test("全部9工具拒绝模型自批/额外字段，缺必填参数不触发sandbox", async (t) => {
  const f = await fixture(t);
  const args = {
    workspace_status: {}, workspace_list: {}, workspace_read: { path: "x" },
    workspace_import: { sourcePath: path.join(f.dir, "external"), path: "x" },
    workspace_write: { path: "x", text: "x" }, workspace_zip: { action: "list", path: "x.zip" },
    workspace_run: { runtime: "node", scriptPath: "x.js" }, workspace_job: { jobId: J }, workspace_stop: { jobId: J },
  };
  for (const tool of WORKSPACE_TOOLS) {
    assert.equal((await f.host.call(tool.name, { ...args[tool.name], approved: true }, ctx({ approved: true }))).error.code, "INVALID_ARGUMENTS");
    await assert.rejects(f.host.prepareCall(tool.name, { ...args[tool.name], arbitrary: true }, ctx()), (e) => e.code === "INVALID_ARGUMENTS");
    if (tool.inputSchema.required.length) assert.equal((await f.host.call(tool.name, {}, ctx())).error.code, "INVALID_ARGUMENTS");
  }
  assert.equal((await f.host.call("workspace_zip", { action: "extract", path: "x.zip", overwrite: true }, ctx({ approved: true }))).error.code, "INVALID_ARGUMENTS");
  assert.equal(f.records.prepares.length, 0); assert.equal(f.records.runs.length, 0);
  assert.equal(WORKSPACE_TOOLS.find((tool) => tool.name === "workspace_run").inputSchema.properties.timeoutSeconds.maximum, 3600);
});

test("write/read/list/zip工具使用真实文件，产物downloadUrl和absolutePath指向真实文件", async (t) => {
  const f = await fixture(t);
  const written = await f.host.call("workspace_write", { path: "out/报告.txt", text: "真实内容" }, ctx());
  assert.equal(written.ok, true); assert.equal(written.data.bytes, Buffer.byteLength("真实内容")); assert.equal(written.data.absolutePath, await f.files.resolve(A, "out/报告.txt"));
  const download = new URL(written.data.downloadUrl, "http://local"); assert.equal(download.pathname, `/api/workspaces/${A}/files`); assert.equal(download.searchParams.get("path"), "out/报告.txt");
  assert.equal((await f.host.call("workspace_read", { path: "out/报告.txt", maxChars: 2 }, ctx())).data.text, "真实");
  assert.equal((await f.host.call("workspace_list", { path: "out" }, ctx())).data.entries[0].downloadUrl, written.data.downloadUrl);
  const root = await f.host.call("workspace_list", {}, ctx()); assert.equal(root.data.entries[0].type, "directory"); assert.equal(root.data.entries[0].downloadUrl, undefined);
  assert.equal((await f.host.call("workspace_read", { path: "out/报告.txt" }, { sessionId: B })).error.code, "FILE_NOT_FOUND");
  const zipped = await f.host.call("workspace_zip", { action: "create", path: "bundle.zip", files: ["out"] }, ctx()); assert.equal(zipped.ok, true); assert.ok(zipped.data.downloadUrl.includes("bundle.zip"));
  assert.equal((await f.host.call("workspace_zip", { action: "list", path: "bundle.zip" }, ctx())).data.entries.length, 2);
  assert.equal((await f.host.call("workspace_zip", { action: "extract", path: "bundle.zip", destination: "restored" }, ctx())).ok, true);
  assert.equal((await f.files.read(A, { path: "restored/out/报告.txt" })).text, "真实内容");
  assert.deepEqual(await f.host.artifact(A, { other: "not-a-file" }), { other: "not-a-file" }); assert.equal(await f.host.artifact(A, null), null);
});

test("import精确审批绑定、自批字段拒绝和overwrite确认后目标/内容不可改变", async (t) => {
  const f = await fixture(t), source = path.join(f.dir, "input.txt"); await writeFile(source, "附件内容");
  const args = { sourcePath: source, path: "input.txt" };
  for (const extra of [{ approved: true }, { approvedSourcePath: source }, { overwrite: true }]) {
    assert.equal((await f.host.call("workspace_import", { ...args, ...extra }, ctx({ approved: true }))).error.code, "INVALID_ARGUMENTS");
    await assert.rejects(f.host.prepareCall("workspace_import", { ...args, ...extra }, ctx()), (e) => e.code === "INVALID_ARGUMENTS");
  }
  assert.equal((await f.host.call("workspace_import", args, ctx())).error.code, "APPROVAL_REQUIRED");
  const prepared = await f.host.prepareCall("workspace_import", args, ctx());
  assert.equal(prepared.mandatoryApproval, true); assert.equal(prepared.sourcePath, source); assert.equal(prepared.approvalArgs.sourcePath, source); assert.match(prepared.risk, /一个本机附件/);
  assert.equal((await f.host.call("workspace_import", args, ctx({ approved: true }))).error.code, "APPROVAL_REQUIRED");
  for (const change of [{ sourcePath: path.join(f.dir, "other") }, { path: "different.txt" }]) assert.equal((await f.host.call("workspace_import", { ...args, ...change }, ctx({ approved: true, prepared }))).error.code, "APPROVAL_REQUIRED");
  assert.deepEqual((await f.files.list(A)).entries, []);
  assert.equal((await f.host.call("workspace_import", args, ctx({ approved: true, prepared }))).ok, true); assert.equal((await f.files.read(A, { path: "input.txt" })).text, "附件内容");
  assert.equal(await f.host.prepareCall("workspace_write", { path: "new", text: "x" }, ctx()), undefined);
  const overwrite = { path: "input.txt", text: "覆盖", overwrite: true }, overwritePrepared = await f.host.prepareCall("workspace_write", { path: "input.txt", text: "覆盖", overwrite: true }, ctx());
  assert.equal(overwritePrepared.mandatoryApproval, true);
  assert.equal((await f.host.call("workspace_write", { ...overwrite, approved: true }, ctx())).error.code, "INVALID_ARGUMENTS");
  assert.equal((await f.host.call("workspace_write", overwrite, ctx())).error.code, "APPROVAL_REQUIRED");
  assert.equal((await f.host.call("workspace_write", overwrite, ctx({ approved: true }))).error.code, "APPROVAL_REQUIRED");
  for (const change of [{ path: "different.txt" }, { text: "未确认的新内容" }]) assert.equal((await f.host.call("workspace_write", { ...overwrite, ...change }, ctx({ approved: true, prepared: overwritePrepared }))).error.code, "APPROVAL_REQUIRED");
  assert.equal((await f.files.read(A, { path: "input.txt" })).text, "附件内容");
  assert.equal((await f.host.call("workspace_write", overwrite, ctx({ approved: true, prepared: overwritePrepared }))).ok, true);
});

test("run保留冻结prepared对象身份和approved上下文，不接受伪造或未批准调用", async (t) => {
  const f = await fixture(t); await f.files.write(A, { path: "script.js", text: "console.log('原始脚本');\n" });
  const args = { runtime: "node", scriptPath: "script.js", args: ["a"] }, prepared = await f.host.prepareCall("workspace_run", args, ctx()); assert.equal(Object.isFrozen(prepared.runtimePrepared), true);
  await f.files.write(A, { path: "script.js", text: "changed", overwrite: true });
  assert.equal((await f.host.call("workspace_run", args, ctx({ prepared }))).error.code, "APPROVAL_REQUIRED");
  assert.equal((await f.host.call("workspace_run", args, ctx({ approved: true, prepared: { ...prepared, runtimePrepared: { ...prepared.runtimePrepared } } }))).error.code, "INVALID_PREPARED");
  const result = await f.host.call("workspace_run", args, ctx({ approved: true, prepared })); assert.equal(result.ok, true); assert.equal(result.data.state, "running"); assert.equal(result.data.statusUrl, workspaceJobUrl(A, J));
  assert.equal(f.records.runs[0].prepared, prepared.runtimePrepared); assert.equal(f.records.runs[0].context.approved, true); assert.match(prepared.approvalArgs.code, /原始脚本/);
});

test("job长轮询/stop保留真实状态与错误，等待可被signal取消", async (t) => {
  const f = await fixture(t); let polls = 0;
  f.sandbox.get = async () => (++polls === 1 ? { jobId: J, state: "running" } : { jobId: J, state: "failed", exitCode: 2, stderr: "真实错误" });
  const waited = await f.host.call("workspace_job", { jobId: J, waitSeconds: 1 }, ctx()); assert.equal(polls, 2); assert.equal(waited.data.state, "failed"); assert.equal(waited.data.exitCode, 2); assert.equal(waited.data.stderr, "真实错误");
  assert.equal((await f.host.call("workspace_stop", { jobId: J }, ctx())).data.state, "cancelled"); assert.equal((await f.host.call("workspace_stop", { jobId: J }, { sessionId: B })).error.code, "JOB_NOT_FOUND");
  f.sandbox.get = async () => ({ jobId: J, state: "running" });
  assert.equal((await f.host.call("workspace_job", { jobId: J, waitSeconds: 0 }, ctx())).data.state, "running"); assert.equal((await f.host.call("workspace_job", { jobId: J, waitSeconds: "bad" }, ctx())).error.code, "INVALID_ARGUMENTS");
  const controller = new AbortController(); controller.abort(); assert.equal((await f.host.call("workspace_job", { jobId: J, waitSeconds: 1 }, ctx({ signal: controller.signal }))).ok, false);
  f.sandbox.status = async () => { throw Object.assign(new Error(""), { code: "not-safe" }); }; assert.deepEqual((await f.host.call("workspace_status", {}, ctx())).error, { code: "WORKSPACE_FAILED", message: "工作区操作失败。" });
});

test("mandatory run审批在requireApproval=false仍展示完整脚本/风险，批准后才执行", async (t) => {
  const f = await fixture(t), code = "// 完整冻结脚本\nconsole.log('结果');\n"; await f.files.write(A, { path: "code.js", text: code });
  const result = await turn(f.host, "workspace_run", { runtime: "node", scriptPath: "code.js" }, { inspectConfirm: (card) => { assert.equal(f.records.runs.length, 0); assert.equal(card.args.code, code); assert.match(card.risk, /真正隔离/); assert.equal(card.args.scope.network, "none"); } });
  assert.equal(result.result.aborted, false); assert.equal(f.records.runs.length, 1); assert.equal(f.records.runs[0].prepared, f.records.prepares[0].prepared); assert.ok(result.events.some((e) => e.event === "tool" && e.data.result?.state === "running"));
});
for (const decision of ["deny", "timeout", "abort"]) {
  test(`mandatory审批${decision}不执行，拒绝/超时回灌真实错误`, async (t) => {
    const f = await fixture(t); await f.files.write(A, { path: "code.js", text: "1" });
    const result = await turn(f.host, "workspace_run", { runtime: "node", scriptPath: "code.js" }, { decision }); assert.equal(f.records.runs.length, 0);
    if (decision === "abort") assert.equal(result.result.aborted, true);
    else { const code = decision === "timeout" ? "APPROVAL_TIMEOUT" : "USER_DENIED"; assert.ok(result.events.some((e) => e.data.error?.code === code)); assert.ok(result.messages.some((m) => m.role === "tool" && JSON.parse(m.content).error.code === code)); }
  });
}
for (const code of ["SANDBOX_UNAVAILABLE", "PREPARATION_FAILED"]) {
  test(`准备失败${code}不确认不执行并回灌模型`, async (t) => {
    const f = await fixture(t, { prepare: async () => { throw error(code); } }), result = await turn(f.host, "workspace_run", { runtime: "node", scriptPath: "not-run.js" });
    assert.equal(f.records.runs.length, 0); assert.ok(!result.events.some((e) => e.event === "confirm")); assert.ok(result.messages.some((m) => m.role === "tool" && JSON.parse(m.content).error.code === code));
  });
}

test("overwrite与import动态mandatory审批在全局审批关闭时仍强制", async (t) => {
  const f = await fixture(t); await f.files.write(A, { path: "keep.txt", text: "原文件" });
  const denied = await turn(f.host, "workspace_write", { path: "keep.txt", text: "新内容", overwrite: true }, { decision: "deny", inspectConfirm: (card) => assert.equal(card.args.overwrite, true) }); assert.ok(denied.events.some((e) => e.event === "confirm")); assert.equal((await f.files.read(A, { path: "keep.txt" })).text, "原文件");
  const source = path.join(f.dir, "import.txt"); await writeFile(source, "导入");
  const imported = await turn(f.host, "workspace_import", { sourcePath: source, path: "import.txt" }, { inspectConfirm: (card) => assert.equal(card.args.sourcePath, source) }); assert.ok(imported.events.some((e) => e.event === "confirm")); assert.equal((await f.files.read(A, { path: "import.txt" })).text, "导入");
});

test("Host关闭幂等且sandbox关闭失败也关闭campus；工厂只构造不调用真实Docker", async (t) => {
  const f = await fixture(t); await f.host.close(); await f.host.close(); assert.equal(f.records.closed, 1); assert.equal(f.records.campusClosed, 1);
  const broken = await fixture(t, { close: async () => { throw error("CLOSE_FAILED"); } }); await assert.rejects(broken.host.close(), (e) => e.code === "CLOSE_FAILED"); assert.equal(broken.records.campusClosed, 1);
  const built = createWorkspaceHost({ host: f.campus, stateDir: path.join(f.dir, "factory"), pythonImage: "test-python", nodeImage: "test-node", storageMode: "local" }); assert.ok(built instanceof WorkspaceHost); assert.equal(built.workspaceFiles.baseDir, path.join(f.dir, "factory", "workspaces"));
});
