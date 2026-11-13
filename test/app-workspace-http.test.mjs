import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { tmpdir } from "node:os";
import { mkdtemp, rm } from "node:fs/promises";
import { createAppServer } from "../lib/app/server.mjs";
import { SessionStore } from "../lib/app/sessions.mjs";
import { DeviceStore } from "../lib/app/devices.mjs";
import { PairingCodes } from "../lib/app/pairing.mjs";
import { WorkspaceFiles } from "../lib/app/workspace-files.mjs";
import { WorkspaceHost, WORKSPACE_TOOLS } from "../lib/app/workspace.mjs";
import { handleWorkspaceRequest } from "../lib/app/workspace-http.mjs";
import { readSseEvents } from "../lib/app/sse.mjs";

const J = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", TOKEN = "workspace-http-fixed-test-token";
const err = (code, message = "测试失败") => Object.assign(new Error(message), { code });
async function fixture(t, { chatTool = null } = {}) {
  const stateDir = await mkdtemp(path.join(tmpdir(), "campus-workspace-http-"));
  assert.equal(path.isAbsolute(stateDir), true); assert.match(path.basename(stateDir), /^campus-workspace-http-/);
  const sessions = new SessionStore(stateDir), a = await sessions.create(), b = await sessions.create();
  const files = new WorkspaceFiles({ baseDir: path.join(stateDir, "workspaces") });
  const records = { get: [], stop: [], stopSession: [], run: [], prepares: [], closed: 0, campus: [] };
  const faults = {}, prepared = new WeakSet();
  const sandbox = {
    status: async () => ({ available: true, runtimes: { node: { available: true } } }),
    prepare: async (sessionId, args) => {
      const code = (await files.readBytes(sessionId, args.scriptPath)).toString("utf8");
      const item = Object.freeze({ mandatoryApproval: true, approvalArgs: Object.freeze({ ...args, code, risk: "只在隔离容器中执行冻结代码", scope: { sessionId, network: "none" } }) });
      prepared.add(item); records.prepares.push(item); return item;
    },
    run: async (sessionId, args, context) => {
      const item = context.prepared;
      assert.equal(prepared.has(item), true); assert.equal(context.approved, true);
      records.run.push({ sessionId, args, prepared: item, context }); return { jobId: J, state: "running", exitCode: null };
    },
    get: async (sessionId, jobId) => {
      records.get.push({ sessionId, jobId });
      if (faults.get) throw faults.get;
      if (sessionId !== a.id || jobId !== J) throw err("JOB_NOT_FOUND");
      return { jobId: J, sessionId, state: "failed", exitCode: 2, stderr: "真实退出失败" };
    },
    stop: async (sessionId, jobId) => {
      records.stop.push({ sessionId, jobId });
      if (faults.stop) throw faults.stop;
      if (sessionId !== a.id || jobId !== J) throw err("JOB_NOT_FOUND");
      return { jobId: J, sessionId, state: "cancelled" };
    },
    stopSession: async (sessionId) => { records.stopSession.push(sessionId); },
    close: async () => { records.closed++; },
  };
  const campus = {
    describe: () => [{ name: "campus_read", readOnly: true }], toolForModel: () => [],
    call: async (name, args) => { records.campus.push({ name, args }); return { ok: true, data: { campus: true } }; }, close: async () => {},
  };
  const host = new WorkspaceHost({ host: campus, files, sandbox });
  let modelCalls = 0;
  const config = { host: "127.0.0.1", port: 0, hostname: "localhost", token: TOKEN, stateDir, modelRoute: "fake", modelName: "fake", requireApproval: false, approvalTimeoutMs: 10000, extraHosts: [], extraOrigins: [] };
  const route = {
    status: async () => ({ available: true }), models: async () => [{ id: "fake" }],
    chat: async () => Response.json({ choices: [{ message: chatTool && ++modelCalls === 1 ? { content: "", tool_calls: [{ id: "http-call", type: "function", function: { name: chatTool.name, arguments: JSON.stringify(chatTool.args) } }] } : { content: "已核对真实回执" } }] }),
  };
  const app = createAppServer({ config, host, route, sessions, devices: new DeviceStore(stateDir), pairing: new PairingCodes(), version: "workspace-test" });
  const base = await app.listen();
  let closed = false;
  const close = async () => { if (!closed) { closed = true; await app.close(); } };
  t.after(async () => { await close(); await rm(stateDir, { recursive: true, force: true }); });
  const request = (target, options = {}) => fetch(base + target, { ...options, headers: { Authorization: `Bearer ${TOKEN}`, ...(options.body ? { "Content-Type": "application/json" } : {}), ...options.headers } });
  const json = async (target, options) => { const response = await request(target, options); return { status: response.status, body: await response.json() }; };
  const fileUrl = (sessionId, name) => `/api/workspaces/${sessionId}/files?${new URLSearchParams({ path: name })}`;
  return { stateDir, files, host, a, b, records, sandbox, faults, app, base, close, request, json, fileUrl, sessions };
}

test("真实PDF下载保持字节和安全响应头，downloadUrl指向本会话实际文件", async (t) => {
  const f = await fixture(t), name = "报告'().PDF";
  const bytes = Buffer.from([37, 80, 68, 70, 45, 49, 46, 55, 10, 0, 255, 10, 37, 37, 69, 79, 70]);
  await f.files.writeBytes(f.a.id, { path: `out/${name}`, bytes });
  const listing = await f.host.call("workspace_list", { path: "out" }, { sessionId: f.a.id });
  assert.equal(listing.ok, true);
  const artifact = listing.data.entries[0];
  assert.equal(artifact.absolutePath, await f.files.resolve(f.a.id, `out/${name}`));
  assert.equal(new URL(artifact.downloadUrl, f.base).searchParams.get("path"), `out/${name}`);
  const response = await f.request(artifact.downloadUrl);
  assert.equal(response.status, 200); assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes);
  assert.equal(response.headers.get("Content-Type"), "application/pdf"); assert.equal(response.headers.get("Content-Length"), String(bytes.length));
  assert.equal(response.headers.get("Cache-Control"), "no-store"); assert.equal(response.headers.get("X-Content-Type-Options"), "nosniff");
  assert.equal(response.headers.get("Content-Security-Policy"), "default-src 'none'; sandbox");
  assert.equal(response.headers.get("Content-Disposition"), "attachment; filename*=UTF-8''" + encodeURIComponent(name).replaceAll("'", "%27").replaceAll("(", "%28").replaceAll(")", "%29"));
  await f.files.write(f.a.id, { path: "source.js", text: "console.log(1)" });
  const plain = await f.request(f.fileUrl(f.a.id, "source.js"));
  assert.equal(plain.headers.get("Content-Type"), "application/octet-stream"); assert.equal(await plain.text(), "console.log(1)");
});

test("下载认证和Origin先于文件访问，坏SID/缺文件/父级/绝对/跨SID路径都拒绝", async (t) => {
  const f = await fixture(t);
  await f.files.write(f.a.id, { path: "private.txt", text: "只有A存在" });
  const target = f.fileUrl(f.a.id, "private.txt");
  const unauth = await fetch(f.base + target); assert.equal(unauth.status, 401); assert.equal((await unauth.json()).error.code, "AUTH_REQUIRED");
  const wrong = await f.json(target, { headers: { Authorization: "Bearer wrong" } }); assert.equal(wrong.status, 401);
  for (const Origin of ["https://evil.invalid", "not-an-origin"]) {
    const result = await f.json(target, { headers: { Origin } }); assert.equal(result.status, 403); assert.equal(result.body.error.code, "ORIGIN_REJECTED");
  }
  const allowed = await f.request(target, { headers: { Origin: f.base } }); assert.equal(allowed.status, 200); await allowed.arrayBuffer();
  const cases = [
    [f.fileUrl(f.a.id, "../other"), 400, "PATH_ESCAPE"],
    [f.fileUrl(f.a.id, `../${f.b.id}/private.txt`), 400, "PATH_ESCAPE"],
    [f.fileUrl(f.a.id, await f.files.resolve(f.a.id, "private.txt")), 400, "INVALID_PATH"],
    [f.fileUrl(f.b.id, "private.txt"), 404, "FILE_NOT_FOUND"],
    [f.fileUrl(f.a.id, "missing.pdf"), 404, "FILE_NOT_FOUND"],
    [`/api/workspaces/${"-".repeat(36)}/files?path=private.txt`, 404, "SESSION_NOT_FOUND"],
    [`/api/workspaces/${f.a.id}/files`, 400, "INVALID_ARGUMENTS"],
  ];
  for (const [url, status, code] of cases) {
    const result = await f.json(url); assert.equal(result.status, status, url); assert.equal(result.body.ok, false); assert.equal(result.body.error.code, code);
  }
  const malformed = await f.json("/api/workspaces/not-a-session/files?path=x"); assert.equal(malformed.status, 404);
  for (const method of ["POST", "PUT", "DELETE", "HEAD"]) {
    const response = await f.request(target, { method }); assert.equal(response.status, 405); await response.arrayBuffer();
  }
});

test("HTTP作业get/stop只看指定会话，失败不会冒充成功，方法与ID受校验", async (t) => {
  const f = await fixture(t), target = `/api/workspaces/${f.a.id}/jobs/${J}`;
  const job = await f.json(target); assert.equal(job.status, 200); assert.equal(job.body.job.state, "failed"); assert.equal(job.body.job.exitCode, 2); assert.equal(job.body.job.stderr, "真实退出失败"); assert.equal(job.body.job.statusUrl, target);
  const stopped = await f.json(target + "/stop", { method: "POST" }); assert.equal(stopped.body.job.state, "cancelled"); assert.equal(stopped.body.job.statusUrl, target);
  const cross = await f.json(`/api/workspaces/${f.b.id}/jobs/${J}`); assert.equal(cross.status, 404); assert.equal(cross.body.ok, false); assert.equal(cross.body.error.code, "JOB_NOT_FOUND");
  assert.deepEqual(f.records.get[1], { sessionId: f.b.id, jobId: J });
  f.faults.get = err("READ_FAILED", "无法读取作业");
  const getFail = await f.json(target); assert.equal(getFail.status, 400); assert.equal(getFail.body.ok, false); assert.equal(getFail.body.error.code, "READ_FAILED");
  f.faults.stop = err("STOP_FAILED", "未停止");
  const stopFail = await f.json(target + "/stop", { method: "POST" }); assert.equal(stopFail.status, 400); assert.equal(stopFail.body.ok, false); assert.equal(stopFail.body.error.code, "STOP_FAILED");
  for (const [url, method] of [[target, "POST"], [target + "/stop", "GET"], [target, "DELETE"]]) assert.equal((await f.json(url, { method })).status, 405);
  const invalidJob = await f.json(`/api/workspaces/${f.a.id}/jobs/${"-".repeat(36)}`); assert.equal(invalidJob.status, 400); assert.equal(invalidJob.body.error.code, "INVALID_ARGUMENTS");
});

test("手动POST全部workspace工具403，不能用args自批绕过；campus保持原调用", async (t) => {
  const f = await fixture(t);
  for (const tool of WORKSPACE_TOOLS) {
    const result = await f.json(`/api/tools/${tool.name}`, { method: "POST", body: JSON.stringify({ sessionId: f.a.id, approved: true, scriptPath: "evil.js", sourcePath: f.stateDir }) });
    assert.equal(result.status, 403); assert.equal(result.body.error.code, "WORKSPACE_CHAT_REQUIRED");
  }
  assert.equal(f.records.prepares.length, 0); assert.equal(f.records.run.length, 0); assert.equal(f.records.campus.length, 0);
  const campus = await f.json("/api/tools/campus_read", { method: "POST", body: "{}" }); assert.equal(campus.status, 200); assert.deepEqual(campus.body.data, { campus: true });
});

test("跨会话confirm API不能确认他人callId，全局审批关闭仍展示脚本并等待本SID批准", async (t) => {
  const args = { runtime: "node", scriptPath: "frozen.js" };
  const f = await fixture(t, { chatTool: { name: "workspace_run", args } });
  const code = "// 完整脚本\nconsole.log('冻结');\n"; await f.files.write(f.a.id, { path: args.scriptPath, text: code });
  const response = await f.request("/api/chat", { method: "POST", body: JSON.stringify({ sessionId: f.a.id, text: "运行现有脚本" }) });
  assert.equal(response.status, 200);
  let confirms = 0, done = false;
  const events = [];
  for await (const frame of readSseEvents(response.body)) {
    const data = JSON.parse(frame.data); events.push({ event: frame.event, data });
    if (frame.event === "confirm") {
      confirms++; assert.equal(data.args.code, code); assert.match(data.risk, /隔离的容器/); assert.equal(f.records.run.length, 0);
      const cross = await f.json(`/api/chat/${f.b.id}/confirm`, { method: "POST", body: JSON.stringify({ callId: data.callId, allow: true }) });
      assert.equal(cross.body.decided, false); assert.equal(f.records.run.length, 0);
      const right = await f.json(`/api/chat/${f.a.id}/confirm`, { method: "POST", body: JSON.stringify({ callId: data.callId, allow: true }) }); assert.equal(right.body.decided, true);
    }
    if (frame.event === "done") done = true;
  }
  assert.equal(confirms, 1); assert.equal(done, true); assert.equal(f.records.run.length, 1); assert.equal(f.records.run[0].prepared, f.records.prepares[0]);
  assert.ok(events.some((e) => e.event === "tool" && e.data.result?.state === "running"));
  const session = await f.sessions.get(f.a.id); assert.ok(session.messages.some((m) => m.role === "tool" && JSON.parse(m.content).data.state === "running"));
});

test("删除会话停止该会话作业，关闭HTTP服务调用sandbox.close", async (t) => {
  const f = await fixture(t);
  const deleted = await f.json(`/api/sessions/${f.a.id}`, { method: "DELETE" });
  assert.equal(deleted.status, 200); assert.equal(deleted.body.removed, f.a.id); assert.deepEqual(f.records.stopSession, [f.a.id]);
  assert.equal(await f.sessions.get(f.a.id), undefined); assert.ok(await f.sessions.get(f.b.id));
  await f.close(); assert.equal(f.records.closed, 1);
});

async function direct(target, { method = "GET", host, sessions } = {}) {
  const result = { headers: {}, body: null };
  const res = { writeHead: (status, headers) => { result.status = status; result.headers = headers; }, end: (body) => { result.body = body; } };
  const json = (_res, status, body) => { result.status = status; result.body = body; };
  const fail = (_res, status, code, message) => { result.status = status; result.body = { ok: false, error: { code, message } }; };
  result.matched = await handleWorkspaceRequest({ method, url: new URL(target, "http://local"), res, host: host || {}, sessions: sessions || { get: async () => ({ id: "found" }) }, json, fail });
  return result;
}

test("窄范围HTTP路由缺能力/缺会话/未匹配与底层异常使用真实失败响应", async () => {
  const A = "11111111-1111-4111-8111-111111111111", target = `/api/workspaces/${A}/files?path=data`;
  assert.equal((await direct("/api/other")).matched, false);
  const unavailable = await direct(target); assert.equal(unavailable.status, 404); assert.equal(unavailable.body.error.code, "WORKSPACE_UNAVAILABLE");
  const absent = await direct(target, { sessions: { get: async () => undefined } }); assert.equal(absent.status, 404); assert.equal(absent.body.error.code, "SESSION_NOT_FOUND");
  for (const failure of [err("NOT_FOUND", "missing"), err("bad-code", "unexpected"), {}]) {
    const result = await direct(target, { host: { workspaceFiles: { readBytes: async () => { throw failure; } }, sandbox: {} } });
    assert.equal(result.body.ok, false);
    assert.equal(result.status, failure.code === "NOT_FOUND" ? 404 : 400);
    assert.equal(result.body.error.code, failure.code === "NOT_FOUND" ? "NOT_FOUND" : "WORKSPACE_FAILED");
    assert.equal(result.body.error.message, failure.message || "工作区操作失败。");
  }
});
