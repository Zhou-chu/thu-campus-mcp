import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createAppServer } from "../lib/app/server.mjs";
import { PairingCodes, writeInvite, readInvite } from "../lib/app/pairing.mjs";
import { DeviceStore } from "../lib/app/devices.mjs";
import { SessionStore } from "../lib/app/sessions.mjs";
import { readSseEvents } from "../lib/app/sse.mjs";
const TOOLS = [
  {
    name: "learn_status",
    description: "检查网络学堂认证配置",
    inputSchema: { type: "object", properties: {} },
    annotations: { readOnlyHint: true },
  },
  {
    name: "learn_submit_assignment",
    description: "提交作业",
    inputSchema: { type: "object", properties: { preparationId: { type: "string" } } },
    annotations: { readOnlyHint: false, destructiveHint: true },
  },
];
function fakeHost(calls = []) {
  return {
    describe: () =>
      TOOLS.map((tool) => ({
        name: tool.name,
        description: tool.description,
        service: "learnx",
        inputSchema: tool.inputSchema,
        readOnly: tool.annotations?.readOnlyHint === true,
        destructive: tool.annotations?.destructiveHint === true,
      })),
    toolForModel: () =>
      TOOLS.map((tool) => ({
        type: "function",
        function: { name: tool.name, description: tool.description, parameters: tool.inputSchema },
      })),
    async call(name, args) {
      calls.push({ name, args });
      if (name === "learn_status") return { ok: true, data: { configured: true } };
      if (name === "cloud_status") return { ok: true, data: { configured: false } };
      if (name === "rain_status") return { ok: false, error: { code: "AUTH_REQUIRED", message: "需要登录" } };
      if (name === "madmodel_status") return { ok: true, data: { expired: true } };
      if (name === "learn_submit_assignment")
        return { ok: false, error: { code: "INVALID_ARGUMENTS", message: "缺少准备 ID。" } };
      return { ok: true, data: { echo: args } };
    },
    async close() {},
  };
}
function sseResponse(chunks) {
  const encoder = new TextEncoder();
  const body = new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream; charset=utf-8" },
  });
}
function chunk(payload) {
  return `data: ${JSON.stringify(payload)}\n\n`;
}
function scriptedRoute() {
  return {
    route: "madmodel",
    turns: 0,
    async models() {
      return [{ id: "test-model", label: "测试模型" }];
    },
    async status() {
      return { route: "madmodel", available: true, configured: true, masked: "2023****1234" };
    },
    async chat(body) {
      this.turns += 1;
      const hasTool = body.messages.some((m) => m.role === "tool");
      if (!hasTool)
        return sseResponse([
          chunk({
            choices: [
              {
                delta: {
                  tool_calls: [
                    { index: 0, id: "call_1", function: { name: "learn_status", arguments: "{}" } },
                  ],
                },
              },
            ],
          }),
          "data: [DONE]\n\n",
        ]);
      return sseResponse([
        chunk({ choices: [{ delta: { reasoning_content: "思考中" } }] }),
        chunk({ choices: [{ delta: { content: "已检查" } }] }),
        chunk({ choices: [{ delta: { content: "登录状态。" } }] }),
        chunk({ choices: [{ delta: {}, finish_reason: "stop" }], usage: { total_tokens: 12 } }),
        "data: [DONE]\n\n",
      ]);
    },
  };
}
async function boot(t, { token = "", route = scriptedRoute(), host = fakeHost(), config: overrides = {}, keepAlive = null, savedSettings = null } = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), "campus-app-http-"));
  if (savedSettings) await writeFile(path.join(dir, "settings.json"), JSON.stringify(savedSettings));
  const config = {
    root: path.resolve(import.meta.dirname, ".."),
    host: "127.0.0.1",
    port: 0,
    stateDir: dir,
    token,
    modelRoute: "madmodel",
    modelBaseUrl: "",
    modelApiKey: "",
    modelName: "",
    maxSteps: 8,
    hostname: "test-host",
    version: "test",
    ...overrides,
  };
  const devices = new DeviceStore(dir, { encrypt: async (buffer) => buffer });
  const pairing = new PairingCodes();
  const sessions = new SessionStore(dir);
  const app = createAppServer({
    config,
    host,
    route,
    devices,
    pairing,
    sessions,
    version: "1.3.0-test",
    // 默认指向不存在的目录，测试内置占位页；真实 WebUI 由仓库 webui/ 提供。
    webuiDir: path.join(dir, "webui"),
    keepAlive,
  });
  const url = await app.listen();
  t.after(async () => {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  });
  return { app, url, dir, devices, pairing, sessions, route, host };
}
async function pair(url, pairing, overrides = {}) {
  const { code } = pairing.issue();
  const response = await fetch(url + "/api/pair/redeem", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code, deviceName: "测试设备", platform: "webui", ...overrides }),
  });
  return { status: response.status, body: await response.json() };
}
test("健康检查公开，其余接口未配对时返回 401", async (t) => {
  const { url } = await boot(t);
  const health = await fetch(url + "/healthz");
  assert.equal(health.status, 200);
  const body = await health.json();
  assert.equal(body.ok, true);
  assert.equal(body.version, "1.3.0-test");
  const meta = await fetch(url + "/api/meta");
  assert.equal(meta.status, 401);
  assert.equal((await meta.json()).error.code, "AUTH_REQUIRED");
});
test("配对码换到设备令牌，令牌可读 meta 并能被吊销", async (t) => {
  const { url, pairing, devices } = await boot(t);
  const redeemed = await pair(url, pairing);
  assert.equal(redeemed.status, 200);
  assert.equal(redeemed.body.ok, true);
  assert.match(redeemed.body.token, /^tc1_/);
  const headers = { authorization: "Bearer " + redeemed.body.token };
  const meta = await fetch(url + "/api/meta", { headers });
  assert.equal(meta.status, 200);
  const payload = await meta.json();
  assert.equal(payload.account.masked, "2023****1234");
  // fake只提供配置、不提供受保护API核验，不能冒充真实已登录。
  assert.equal(payload.services.learnx.state, "unverified");
  assert.equal(payload.services.learnx.verified, false);
  assert.equal(payload.services.cloud.state, "login-required");
  assert.equal(payload.services.hetang.state, "login-required");
  assert.equal(payload.services.madmodel.state, "expired");
  assert.equal(payload.model.name, "test-model");
  assert.equal(payload.pairing.enabled, true);
  const list = await (await fetch(url + "/api/devices", { headers })).json();
  assert.equal(list.devices.length, 1);
  await devices.revoke(redeemed.body.deviceId);
  const after = await fetch(url + "/api/meta", { headers });
  assert.equal(after.status, 401);
});
test("无效配对码被拒绝且不泄露细节", async (t) => {
  const { url } = await boot(t);
  const response = await fetch(url + "/api/pair/redeem", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code: "000000", deviceName: "x", platform: "webui" }),
  });
  assert.equal(response.status, 403);
  const body = await response.json();
  assert.equal(body.ok, false);
  assert.equal(body.error.code, "PAIRING_EXPIRED");
});
test("拒绝跨站 Origin 与陌生 Host", async (t) => {
  const { url, pairing } = await boot(t);
  const { body } = await pair(url, pairing);
  const headers = { authorization: "Bearer " + body.token };
  const crossSite = await fetch(url + "/api/meta", {
    headers: { ...headers, origin: "https://evil.example.com" },
  });
  assert.equal(crossSite.status, 403);
  assert.equal((await crossSite.json()).error.code, "ORIGIN_REJECTED");
  const sameSite = await fetch(url + "/api/meta", {
    headers: { ...headers, origin: url },
  });
  assert.equal(sameSite.status, 200);
});
test("工具列表区分只读与写入，工具调用失败返回错误码", async (t) => {
  const { url, pairing } = await boot(t);
  const { body } = await pair(url, pairing);
  const headers = { authorization: "Bearer " + body.token, "content-type": "application/json" };
  const tools = await (await fetch(url + "/api/tools", { headers })).json();
  assert.equal(tools.tools.length, 2);
  assert.equal(tools.tools[0].readOnly, true);
  assert.equal(tools.tools[1].readOnly, false);
  assert.equal(tools.tools[1].destructive, true);
  const blocked = await fetch(url + "/api/tools/learn_submit_assignment", {
    method: "POST",
    headers,
    body: JSON.stringify({ preparationId: "" }),
  });
  assert.equal(blocked.status, 428);
  assert.equal((await blocked.json()).error.code, "APPROVAL_REQUIRED");
  const issued = await (await fetch(url + "/api/tool-approvals", {
    method: "POST",
    headers,
    body: JSON.stringify({ name: "learn_submit_assignment", args: { preparationId: "" } }),
  })).json();
  assert.ok(issued.token);
  const failure = await fetch(url + "/api/tools/learn_submit_assignment", {
    method: "POST",
    headers: { ...headers, "x-campus-approval": issued.token },
    body: JSON.stringify({ preparationId: "" }),
  });
  assert.equal(failure.status, 400);
  const payload = await failure.json();
  assert.equal(payload.ok, false);
  assert.equal(payload.error.code, "INVALID_ARGUMENTS");
  const ok = await fetch(url + "/api/tools/learn_status", { method: "POST", headers, body: "{}" });
  assert.equal((await ok.json()).data.configured, true);
});
test("对话流按序派发 ready/tool/message/token/done 并落库", async (t) => {
  const { url, pairing, sessions, route } = await boot(t);
  const { body } = await pair(url, pairing);
  const response = await fetch(url + "/api/chat", {
    method: "POST",
    headers: { authorization: "Bearer " + body.token, "content-type": "application/json" },
    body: JSON.stringify({ text: "看看我的登录状态" }),
  });
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type"), /text\/event-stream/);
  const events = [];
  for await (const event of readSseEvents(response.body))
    events.push({ event: event.event, data: JSON.parse(event.data) });
  const names = events.map((e) => e.event);
  assert.equal(names[0], "ready");
  assert.equal(names.at(-1), "done");
  assert.ok(names.includes("tool"));
  assert.ok(names.includes("token"));
  assert.ok(names.includes("reasoning"));
  const start = events.find((e) => e.event === "tool" && e.data.phase === "start");
  assert.equal(start.data.name, "learn_status");
  const end = events.find((e) => e.event === "tool" && e.data.phase === "end");
  assert.equal(end.data.ok, true);
  const text = events
    .filter((e) => e.event === "token")
    .map((e) => e.data.text)
    .join("");
  assert.equal(text, "已检查登录状态。");
  const done = events.at(-1).data;
  assert.equal(done.steps, 2);
  assert.deepEqual(done.usage, { total_tokens: 12 });
  const stored = await sessions.list();
  assert.equal(stored.length, 1);
  assert.equal(stored[0].title, "看看我的登录状态");
  const session = await sessions.get(stored[0].id);
  const roles = session.messages.map((m) => m.role);
  assert.deepEqual(roles, ["user", "assistant", "tool", "assistant"]);
  assert.equal(session.messages[1].toolCalls[0].name, "learn_status");
  assert.equal(session.messages[2].toolCallId, "call_1");
  assert.equal(route.turns, 2);
});
test("同一会话进行中拒绝并发第二轮，未知会话返回 404", async (t) => {
  const { url, pairing } = await boot(t);
  const { body } = await pair(url, pairing);
  const headers = { authorization: "Bearer " + body.token, "content-type": "application/json" };
  const missing = await fetch(url + "/api/chat", {
    method: "POST",
    headers,
    body: JSON.stringify({ text: "hi", sessionId: "00000000-0000-4000-8000-000000000000" }),
  });
  assert.equal(missing.status, 404);
  const empty = await fetch(url + "/api/chat", {
    method: "POST",
    headers,
    body: JSON.stringify({ text: "   " }),
  });
  assert.equal(empty.status, 400);
  assert.equal((await empty.json()).error.code, "INVALID_ARGUMENTS");
});
test("设置接口只接受白名单字段并持久化", async (t) => {
  const { url, pairing, dir } = await boot(t);
  const { body } = await pair(url, pairing);
  const headers = { authorization: "Bearer " + body.token, "content-type": "application/json" };
  const initial = await (await fetch(url + "/api/settings", { headers })).json();
  assert.equal(Object.hasOwn(initial.settings, "maxSteps"), false);
  const legacy = await fetch(url + "/api/settings", {
    method: "PUT",
    headers,
    body: JSON.stringify({ maxSteps: 99 }),
  });
  assert.equal(legacy.status, 200, "旧字段必须被忽略，不再校验或限制执行");
  const good = await fetch(url + "/api/settings", {
    method: "PUT",
    headers,
    body: JSON.stringify({ maxSteps: 4, modelName: "test-model", ignored: "x" }),
  });
  const saved = await good.json();
  assert.equal(Object.hasOwn(saved.settings, "maxSteps"), false);
  assert.equal(saved.settings.ignored, undefined);
  const raw = JSON.parse(await readFile(path.join(dir, "settings.json"), "utf8"));
  assert.deepEqual(raw, { modelName: "test-model" });
});
test("静态资源不回退到目录外，缺 WebUI 时给出可读占位页", async (t) => {
  const { url } = await boot(t);
  const root = await fetch(url + "/");
  assert.equal(root.status, 200);
  const html = await root.text();
  assert.match(html, /运行时已启动/);
  const traversal = await fetch(url + "/..%2f..%2fpackage.json");
  const text = await traversal.text();
  assert.ok(traversal.status === 400 || !text.includes('"name": "thu-campus-mcp"'));
});
test("托管模式：对外地址与安全信息如实反映配置", async (t) => {
  const { url, pairing } = await boot(t, {
    config: {
      publicUrl: "https://campus.example.com",
      extraOrigins: ["https://campus.example.com"],
      allowRemote: true,
    },
  });
  const redeemed = await pair(url, pairing);
  assert.equal(redeemed.body.baseUrl, "https://campus.example.com");
  const headers = { authorization: "Bearer " + redeemed.body.token };
  const meta = await (await fetch(url + "/api/meta", { headers })).json();
  assert.equal(meta.security.publicUrl, "https://campus.example.com");
  assert.equal(meta.security.hosted, true);
  assert.equal(meta.security.https, false);
  assert.equal(meta.security.allowRemote, true);
});

test("托管模式：白名单来源被接受，未列入的来源仍被拒绝", async (t) => {
  const { url, pairing } = await boot(t, {
    config: { extraOrigins: ["https://campus.example.com"] },
  });
  const { body } = await pair(url, pairing);
  const headers = { authorization: "Bearer " + body.token };
  const allowed = await fetch(url + "/api/meta", {
    headers: { ...headers, origin: "https://campus.example.com" },
  });
  assert.equal(allowed.status, 200);
  const denied = await fetch(url + "/api/meta", {
    headers: { ...headers, origin: "https://evil.example.com" },
  });
  assert.equal(denied.status, 403);
});

test("守护进程场景：命令行预生成的邀请码可兑换且只能用一次", async (t) => {
  const { url, dir } = await boot(t);
  const code = "424242";
  const expiresAt = Date.now() + 60000;
  writeInvite(dir, { code, expiresAt });
  assert.equal(readInvite(dir).code, code);
  const first = await fetch(url + "/api/pair/redeem", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code, deviceName: "命令行设备", platform: "webui" }),
  });
  assert.equal(first.status, 200);
  assert.equal((await first.json()).ok, true);
  assert.equal(readInvite(dir), null, "兑换后必须清除邀请码文件");
  const second = await fetch(url + "/api/pair/redeem", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code, deviceName: "命令行设备", platform: "webui" }),
  });
  assert.equal(second.status, 403);
});

test("过期的邀请码文件不会被接受", async (t) => {
  const { url, dir } = await boot(t);
  writeInvite(dir, { code: "111111", expiresAt: Date.now() - 1000 });
  assert.equal(readInvite(dir), null);
  const response = await fetch(url + "/api/pair/redeem", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code: "111111", deviceName: "过期设备", platform: "webui" }),
  });
  assert.equal(response.status, 403);
});

function fakeKeepAlive() {
  const history = [];
  let calls = 0;
  return {
    calls: () => calls,
    status: () => ({
      enabled: true,
      intervalMs: 60000,
      restoreExpired: true,
      running: false,
      lastRunAt: null,
      nextRunAt: null,
      expiredServices: [],
      lastResult: history[0] || null,
      history: history.slice(0, 10),
    }),
    runOnce: async (trigger) => {
      calls += 1;
      const entry = { at: new Date().toISOString(), trigger, services: {}, actions: [], ok: true };
      history.unshift(entry);
      return entry;
    },
    configure: () => ({ intervalMs: 60000, restoreExpired: true }),
    stop: () => {},
  };
}

test("保活自检可查询、可立即执行，参数越界被拒绝", async (t) => {
  const keepAlive = fakeKeepAlive();
  const { url, pairing } = await boot(t, { keepAlive });
  const { body } = await pair(url, pairing);
  const headers = { authorization: "Bearer " + body.token, "content-type": "application/json" };
  const view = await (await fetch(url + "/api/keepalive", { headers })).json();
  assert.equal(view.ok, true);
  assert.equal(view.enabled, true);
  assert.equal(view.intervalMs, 60000);
  const run = await fetch(url + "/api/keepalive/run", { method: "POST", headers, body: "{}" });
  const ran = await run.json();
  assert.equal(ran.result.trigger, "api");
  assert.equal(keepAlive.calls(), 1);
  assert.equal(ran.history.length, 1);
  const meta = await (await fetch(url + "/api/meta", { headers })).json();
  assert.equal(meta.keepAlive.enabled, true);
  const settings = await (await fetch(url + "/api/settings", { headers })).json();
  assert.equal(settings.settings.keepAliveMinutes, 1);
  const bad = await fetch(url + "/api/settings", {
    method: "PUT",
    headers,
    body: JSON.stringify({ keepAliveMinutes: 5000 }),
  });
  assert.equal(bad.status, 400);
  const good = await fetch(url + "/api/settings", {
    method: "PUT",
    headers,
    body: JSON.stringify({ keepAliveMinutes: 15, keepAliveRestore: false }),
  });
  assert.equal(good.status, 200);
});

test("没有保活组件时接口仍给出明确空状态", async (t) => {
  const { url, pairing } = await boot(t);
  const { body } = await pair(url, pairing);
  const headers = { authorization: "Bearer " + body.token };
  const view = await (await fetch(url + "/api/keepalive", { headers })).json();
  assert.equal(view.ok, true);
  assert.equal(view.enabled, false);
  assert.deepEqual(view.history, []);
});

/* ---------------- 写入审批 ---------------- */
function approvalRoute() {
  return {
    route: "madmodel",
    async models() {
      return [{ id: "m", label: "M" }];
    },
    async status() {
      return { route: "madmodel", available: true, configured: true, masked: "" };
    },
    async chat(body) {
      const hasTool = body.messages.some((m) => m.role === "tool");
      if (!hasTool)
        return sseResponse([
          chunk({
            choices: [
              {
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: "call_destructive",
                      function: {
                        name: "learn_submit_assignment",
                        arguments: JSON.stringify({ preparationId: "prep-1" }),
                      },
                    },
                  ],
                },
              },
            ],
          }),
          "data: [DONE]\n\n",
        ]);
      return sseResponse([
        chunk({ choices: [{ delta: { content: "好的" } }] }),
        "data: [DONE]\n\n",
      ]);
    },
  };
}

async function readChatWithApproval(response, onConfirm) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const events = [];
  let buffer = "";
  let decided = false;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let index;
    while ((index = buffer.indexOf("\n\n")) >= 0) {
      const raw = buffer.slice(0, index);
      buffer = buffer.slice(index + 2);
      let name = "message";
      const data = [];
      for (const line of raw.split("\n")) {
        if (line.startsWith("event:")) name = line.slice(6).trim();
        else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
      }
      if (!data.length) continue;
      const payload = JSON.parse(data.join("\n"));
      events.push({ event: name, data: payload });
      if (name === "confirm" && !decided) {
        decided = true;
        await onConfirm(payload);
      }
    }
  }
  return events;
}

test("写入类工具在用户允许前不会执行，拒绝后回灌明确失败", async (t) => {
  const calls = [];
  const { url, pairing } = await boot(t, { route: approvalRoute(), host: fakeHost(calls) });
  const { body } = await pair(url, pairing);
  const headers = { authorization: "Bearer " + body.token, "content-type": "application/json" };
  const response = await fetch(url + "/api/chat", {
    method: "POST",
    headers,
    body: JSON.stringify({ text: "帮我提交作业" }),
  });
  const events = await readChatWithApproval(response, async (payload) => {
    assert.equal(payload.name, "learn_submit_assignment");
    assert.ok(payload.sessionId, "confirm 事件必须带 sessionId");
    assert.equal(payload.args.preparationId, "prep-1");
    const decided = await fetch(url + `/api/chat/${payload.sessionId}/confirm`, {
      method: "POST",
      headers,
      body: JSON.stringify({ callId: payload.callId, allow: false }),
    });
    assert.equal(decided.ok, true);
  });
  assert.ok(!calls.some((c) => c.name === "learn_submit_assignment"), "拒绝后不能真的调用工具");
  assert.ok(!events.some((e) => e.event === "tool" && e.data.phase === "start"), "拒绝后不应出现工具开始事件");
  const ended = events.find((e) => e.event === "tool" && e.data.phase === "end");
  assert.equal(ended.data.ok, false);
  assert.equal(ended.data.error.code, "USER_DENIED");
});

test("允许后工具才真正执行", async (t) => {
  const calls = [];
  const { url, pairing } = await boot(t, { route: approvalRoute(), host: fakeHost(calls) });
  const { body } = await pair(url, pairing);
  const headers = { authorization: "Bearer " + body.token, "content-type": "application/json" };
  const response = await fetch(url + "/api/chat", {
    method: "POST",
    headers,
    body: JSON.stringify({ text: "提交作业" }),
  });
  const events = await readChatWithApproval(response, async (payload) => {
    await fetch(url + `/api/chat/${payload.sessionId}/confirm`, {
      method: "POST",
      headers,
      body: JSON.stringify({ callId: payload.callId, allow: true }),
    });
  });
  assert.ok(
    calls.some((c) => c.name === "learn_submit_assignment"),
    "允许后应真正调用工具",
  );
  assert.ok(events.some((e) => e.event === "tool" && e.data.phase === "start"));
});


test("静态 HTML 的版本号来自 version 参数，而不是 config", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "campus-app-ver-"));
  const { writeFile, mkdir } = await import("node:fs/promises");
  await mkdir(path.join(dir, "webui"), { recursive: true });
  await writeFile(
    path.join(dir, "webui", "index.html"),
    '<!doctype html><link rel="stylesheet" href="/styles.css?v=__ASSET_VERSION__" />',
  );
  await writeFile(path.join(dir, "webui", "styles.css"), "body{color:#111}");
  await mkdir(path.join(dir, "webui", "icons"), { recursive: true });
  await writeFile(path.join(dir, "webui", "icons", "icon.svg"), '<svg xmlns="http://www.w3.org/2000/svg"/>');
  const config = {
    root: process.cwd(),
    host: "127.0.0.1",
    port: 0,
    stateDir: dir,
    token: "ver-token",
    modelRoute: "madmodel",
    maxSteps: 8,
    hostname: "ver-host",
  };
  const app = createAppServer({
    config,
    host: fakeHost(),
    route: scriptedRoute(),
    devices: new DeviceStore(dir, { encrypt: async (b) => b }),
    pairing: new PairingCodes(),
    sessions: new SessionStore(dir),
    version: "7.7.7",
    webuiDir: path.join(dir, "webui"),
  });
  const url = await app.listen();
  t.after(async () => {
    await app.close?.();
    await rm(dir, { recursive: true, force: true });
  });
  const page = await fetch(url + "/");
  const html = await page.text();
  assert.equal(page.status, 200);
  assert.match(html, /\?v=7\.7\.7/, "应替换成 version 参数");
  assert.ok(!html.includes("__ASSET_VERSION__"), "不应残留占位符");
  assert.equal(page.headers.get("x-frame-options"), "DENY");
  const icon = await fetch(url + "/favicon.ico");
  assert.equal(icon.status, 200, "favicon 不应 404");
});


test("会话可重命名，空标题与不存在的会话被拒", async (t) => {
  const { url, pairing } = await boot(t, {});
  const { body } = await pair(url, pairing);
  const headers = { authorization: "Bearer " + body.token, "content-type": "application/json" };
  const id = "11111111-1111-4111-8111-111111111111";
  const created = await fetch(url + `/api/sessions/${id}`, {
    method: "PATCH",
    headers,
    body: JSON.stringify({ title: "改过的标题" }),
  });
  assert.equal(created.status, 404, "会话不存在时应 404");
  const empty = await fetch(url + `/api/sessions/${id}`, {
    method: "PATCH",
    headers,
    body: JSON.stringify({ title: "   " }),
  });
  assert.equal(empty.status, 400, "空标题先于存在性校验被拒");
  const long = await fetch(url + `/api/sessions/${id}`, {
    method: "PATCH",
    headers,
    body: JSON.stringify({ title: "x".repeat(200) }),
  });
  assert.equal(long.status, 400, "超长标题先于存在性校验被拒");
});


test("对话请求始终带上具体模型名，不回落到空值", async (t) => {
  let seenModel = "";
  const base = scriptedRoute();
  const route = {
    ...base,
    async models() {
      return [{ id: "first-model", label: "首选模型" }];
    },
    async chat(body) {
      seenModel = body.model;
      return sseResponse([
        chunk({ choices: [{ delta: { content: "收到" } }] }),
        "data: [DONE]\n\n",
      ]);
    },
  };
  const { url, pairing } = await boot(t, { route });
  const { body } = await pair(url, pairing);
  const headers = { authorization: "Bearer " + body.token, "content-type": "application/json" };
  const response = await fetch(url + "/api/chat", {
    method: "POST",
    headers,
    body: JSON.stringify({ text: "你好" }),
  });
  await response.text();
  assert.equal(seenModel, "first-model", "未指定模型时应取模型列表第一项");
});

for (const maxSteps of [12, 24]) {
  test(`旧持久设置maxSteps=${maxSteps}与旧HTTP字段不截断30轮工具执行`, async (t) => {
    const calls = [];
    let turns = 0;
    const route = {
      ...scriptedRoute(),
      async chat() {
        turns++;
        return sseResponse([
          chunk({ choices: [{ delta: turns <= 30 ? { tool_calls: [{ index: 0, id: `c-${turns}`, function: { name: "learn_status", arguments: "{}" } }] } : { content: "30轮后真正完成" } }] }),
          "data: [DONE]\n\n",
        ]);
      },
    };
    const { url, dir, app } = await boot(t, {
      token: "test", route, host: fakeHost(calls), config: { maxSteps }, savedSettings: { modelName: "saved-model", maxSteps },
    });
    const headers = { authorization: "Bearer test", "content-type": "application/json" };
    const initial = await (await fetch(url + "/api/settings", { headers })).json();
    assert.equal(initial.settings.modelName, "saved-model");
    assert.equal(Object.hasOwn(initial.settings, "maxSteps"), false);
    const save = await fetch(url + "/api/settings", { method: "PUT", headers, body: JSON.stringify({ maxSteps }) });
    assert.equal(save.status, 200);
    assert.equal(Object.hasOwn((await save.json()).settings, "maxSteps"), false);
    assert.deepEqual(app.overrides, { modelName: "saved-model" });
    assert.deepEqual(JSON.parse(await readFile(path.join(dir, "settings.json"), "utf8")), { modelName: "saved-model" });
    const response = await fetch(url + "/api/chat", { method: "POST", headers, body: JSON.stringify({ text: "长任务", maxSteps: 1 }) });
    const events = [];
    for await (const event of readSseEvents(response.body)) events.push({ event: event.event, data: JSON.parse(event.data) });
    assert.equal(turns, 31);
    assert.equal(calls.length, 30);
    assert.equal(events.at(-1).event, "done");
    assert.equal(events.at(-1).data.steps, 31);
    assert.ok(events.some((e) => e.data.text === "30轮后真正完成"));
    assert.ok(!events.some((e) => e.event === "notice" || e.event === "error"));
  });
}

test("等待写入确认时HTTP停止立即退出，不误报拒绝也不调用工具", async (t) => {
  const calls = [];
  const { url } = await boot(t, { token: "test", route: approvalRoute(), host: fakeHost(calls) });
  const headers = { authorization: "Bearer test", "content-type": "application/json" };
  const response = await fetch(url + "/api/chat", { method: "POST", headers, body: JSON.stringify({ text: "提交前停止" }) });
  const events = await readChatWithApproval(response, async (payload) => {
    const stop = await fetch(url + `/api/chat/${payload.sessionId}/abort`, { method: "POST", headers, body: "{}" });
    assert.equal((await stop.json()).aborted, true);
  });
  assert.equal(calls.length, 0);
  assert.equal(events.at(-1).event, "done");
  assert.equal(events.at(-1).data.aborted, true);
  assert.ok(!events.some((e) => e.event === "error" || e.data.error));
});

test("实际工具错误结束HTTP轮次并释放会话锁，不自动重试", async (t) => {
  let attempts = 0;
  const host = fakeHost();
  host.call = async () => { attempts++; throw new Error("真实工具异常"); };
  const { url, sessions } = await boot(t, { token: "test", host });
  const session = await sessions.create({});
  const headers = { authorization: "Bearer test", "content-type": "application/json" };
  for (let i = 0; i < 2; i++) {
    const response = await fetch(url + "/api/chat", { method: "POST", headers, body: JSON.stringify({ text: "工具异常", sessionId: session.id }) });
    assert.equal(response.status, 200);
    const text = await response.text();
    assert.match(text, /TURN_FAILED/);
    assert.match(text, /event: done/);
  }
  assert.equal(attempts, 2, "只有用户显式开始下一轮才再次调用");
});

test("HTTP非法对话请求返回明确错误，不进入模型循环", async (t) => {
  const { url } = await boot(t, { token: "test", route: { models: () => assert.fail("不应进入模型") } });
  const headers = { authorization: "Bearer test", "content-type": "application/json" };
  for (const [body, status, code] of [
    ["{", 400, "INVALID_JSON"],
    [JSON.stringify({ text: "x", sessionId: "bad" }), 400, "INVALID_SESSION"],
    [JSON.stringify({ text: "x".repeat(20001) }), 400, "INVALID_ARGUMENTS"],
    [JSON.stringify({ text: "x".repeat(70000) }), 413, "PAYLOAD_TOO_LARGE"],
  ]) {
    const response = await fetch(url + "/api/chat", { method: "POST", headers, body });
    assert.equal(response.status, status);
    assert.equal((await response.json()).error.code, code);
  }
});

test("超过12轮后HTTP停止仍生效，模型取消不误报失败且释放会话", async (t) => {
  let turns = 0;
  let reached;
  const waiting = new Promise((resolve) => { reached = resolve; });
  const route = {
    ...scriptedRoute(),
    async chat(_body, { signal }) {
      turns++;
      if (turns > 15) {
        reached();
        return new Promise((_resolve, reject) => {
          const stop = () => reject(new DOMException("用户停止", "AbortError"));
          if (signal.aborted) stop();
          else signal.addEventListener("abort", stop, { once: true });
        });
      }
      return sseResponse([
        chunk({ choices: [{ delta: { tool_calls: [{ index: 0, id: `stop-${turns}`, function: { name: "learn_status", arguments: "{}" } }] } }] }),
        "data: [DONE]\n\n",
      ]);
    },
  };
  const { url, sessions } = await boot(t, { token: "test", route, config: { maxSteps: 12 } });
  const session = await sessions.create({});
  const headers = { authorization: "Bearer test", "content-type": "application/json" };
  const response = await fetch(url + "/api/chat", { method: "POST", headers, body: JSON.stringify({ text: "运行直到停止", sessionId: session.id }) });
  await waiting;
  const duplicate = await fetch(url + "/api/chat", { method: "POST", headers, body: JSON.stringify({ text: "不能并发", sessionId: session.id }) });
  assert.equal(duplicate.status, 409);
  assert.equal((await duplicate.json()).error.code, "TURN_RUNNING");
  const stop = await fetch(url + `/api/chat/${session.id}/abort`, { method: "POST", headers, body: "{}" });
  assert.equal((await stop.json()).aborted, true);
  const events = [];
  for await (const event of readSseEvents(response.body)) events.push({ event: event.event, data: JSON.parse(event.data) });
  assert.equal(turns, 16);
  assert.equal(events.at(-1).data.aborted, true);
  assert.equal(events.at(-1).data.steps, 16);
  assert.ok(!events.some((e) => e.event === "error"));
  const stopped = await fetch(url + `/api/chat/${session.id}/abort`, { method: "POST", headers, body: "{}" });
  assert.equal((await stopped.json()).aborted, false);
});

test("座位接口对缺参与未确认分别返回 400/428，未知子路径保持 404", async t => {
  const { url, pairing } = await boot(t);
  const paired = await pair(url, pairing);
  const headers = { authorization: "Bearer " + paired.body.token };
  const json = { "content-type": "application/json" };

  const floors = await fetch(url + "/api/seat/floors", { headers });
  assert.equal(floors.status, 400);
  assert.equal((await floors.json()).error.code, "ARGUMENT_REQUIRED");

  const segments = await fetch(url + "/api/seat/segments", { headers });
  assert.equal(segments.status, 400);

  const prepare = await fetch(url + "/api/seat/reserve/prepare", { method: "POST", headers: { ...headers, ...json }, body: "{}" });
  assert.equal(prepare.status, 400);
  assert.equal((await prepare.json()).error.code, "ARGUMENT_REQUIRED");

  const reserve = await fetch(url + "/api/seat/reserve", { method: "POST", headers: { ...headers, ...json }, body: "{}" });
  assert.equal(reserve.status, 428);
  assert.equal((await reserve.json()).error.code, "APPROVAL_REQUIRED");

  const unknown = await fetch(url + "/api/seat/unknown", { headers });
  assert.equal(unknown.status, 404);
});

test("app: method and not-found branches report honest HTTP errors", async (t) => {
  const { url } = await boot(t, { token: "t" });
  const headers = { authorization: "Bearer t", "content-type": "application/json" };
  const post = (path, body) => fetch(url + path, { method: "POST", headers, body: JSON.stringify(body || {}) });
  const unknownRoute = await post("/api/timetable", {});
  assert.equal(unknownRoute.status, 404);
  assert.equal((await unknownRoute.json()).error.code, "NOT_FOUND");
  const missingRename = await fetch(url + "/api/sessions/nope", { method: "PATCH", headers, body: JSON.stringify({ title: "x" }) });
  assert.ok([404, 405].includes(missingRename.status), "不存在的会话不能改名为成功");
  const missingDelete = await fetch(url + "/api/sessions/nope", { method: "DELETE", headers });
  assert.equal(missingDelete.status, 404);
  const service = await (await fetch(url + "/api/service", { headers })).json();
  assert.equal(service.ok, true);
  assert.equal(typeof service.installed, "boolean");
});

test("app: submission confirm and seat prepare reject invalid input with codes", async (t) => {
  const { url } = await boot(t, { token: "t" });
  const headers = { authorization: "Bearer t", "content-type": "application/json" };
  const confirm = await fetch(url + "/api/sidebar/submissions/confirm", {
    method: "POST", headers, body: JSON.stringify({ preparationId: "11111111-1111-4111-8111-111111111111" }),
  });
  assert.equal(confirm.status, 409);
  assert.equal((await confirm.json()).error.code, "CONFIRMATION_REQUIRED");

  const prepare = await fetch(url + "/api/seat/reserve/prepare", { method: "POST", headers, body: "{}" });
  assert.equal(prepare.status, 400);
  assert.equal((await prepare.json()).error.code, "ARGUMENT_REQUIRED");
});

test("app: sessions, devices, models and settings routes answer honestly", async (t) => {
  const { url } = await boot(t, { token: "t" });
  const headers = { authorization: "Bearer t", "content-type": "application/json" };

  const sessions = await (await fetch(url + "/api/sessions", { headers })).json();
  assert.equal(sessions.ok, true);
  assert.ok(Array.isArray(sessions.sessions));

  const devices = await (await fetch(url + "/api/devices", { headers })).json();
  assert.equal(devices.ok, true);
  const missingDevice = await fetch(url + "/api/devices/no-such-device", { method: "DELETE", headers });
  assert.equal(missingDevice.status, 404, "不存在的设备不能假装撤销成功");
  assert.equal((await missingDevice.json()).error.code, "DEVICE_NOT_FOUND");

  const models = await (await fetch(url + "/api/models", { headers })).json();
  assert.equal(models.ok, true);
  assert.equal(models.current, "test-model");

  const settings = await (await fetch(url + "/api/settings", { headers })).json();
  assert.equal(settings.ok, true);
  assert.equal(typeof settings.settings.keepAliveMinutes, "number");
  const updated = await fetch(url + "/api/settings", {
    method: "PUT", headers, body: JSON.stringify({ modelName: "fixture-model", keepAliveMinutes: 30 }),
  });
  const updatedBody = await updated.json();
  assert.equal(updated.status, 200);
  assert.equal(updatedBody.settings.modelName, "fixture-model");

  const withKeepAlive = await boot(t, { token: "t2", keepAlive: fakeKeepAlive() });
  const headers2 = { authorization: "Bearer t2", "content-type": "application/json" };
  const invalidKeepAlive = await fetch(withKeepAlive.url + "/api/settings", {
    method: "PUT", headers: headers2, body: JSON.stringify({ keepAliveMinutes: 99999 }),
  });
  assert.equal(invalidKeepAlive.status, 400, "越界的保活间隔要拒绝");
  const okKeepAlive = await fetch(withKeepAlive.url + "/api/settings", {
    method: "PUT", headers: headers2, body: JSON.stringify({ keepAliveMinutes: 30, keepAliveRestore: true }),
  });
  assert.equal(okKeepAlive.status, 200, "合法保活配置应保存成功");
});

test("app: non-GET healthz is rejected and sidebar detail/submission routes answer", async (t) => {
  const { url } = await boot(t, { token: "t" });
  const headers = { authorization: "Bearer t", "content-type": "application/json" };

  const wrongMethod = await fetch(url + "/healthz", { method: "POST" });
  assert.equal(wrongMethod.status, 405);
  assert.equal((await wrongMethod.json()).error.code, "METHOD_NOT_ALLOWED");

  const auth = await (await fetch(url + "/api/auth/status", { headers })).json();
  assert.equal(auth.ok, true);
  assert.equal(typeof auth.services, "object");

  const detail = await fetch(url + "/api/sidebar/assignments/c1/h1", { headers });
  assert.ok([200, 404, 502].includes(detail.status), "作业详情不会返回 2xx 之外的成功语义");

  const prepared = await fetch(url + "/api/sidebar/submissions/prepare", {
    method: "POST", headers, body: JSON.stringify({ courseId: "c1", homeworkId: "h1", content: "正文" }),
  });
  assert.ok([200, 400, 502].includes(prepared.status));
  if (prepared.status === 200) {
    const body = await prepared.json();
    assert.equal(typeof body.confirmToken, "string", "准备成功必须签发确认令牌");
  }
});

test("app: seat reserve approvals and tool dispatch reject the wrong caller", async (t) => {
  const { url } = await boot(t, { token: "t" });
  const headers = { authorization: "Bearer t", "content-type": "application/json" };

  const prepare = await fetch(url + "/api/seat/reserve/prepare", { method: "POST", headers, body: "{}" });
  assert.equal(prepare.status, 400, "缺座位与时段直接拒绝");
  assert.equal((await prepare.json()).error.code, "ARGUMENT_REQUIRED");

  const noToken = await fetch(url + "/api/seat/reserve", {
    method: "POST", headers, body: JSON.stringify({ space: 1, segment: 2, day: "2026-11-21" }),
  });
  assert.equal(noToken.status, 428, "没有确认令牌不能预约座位");

  const unknownTool = await fetch(url + "/api/tools/no_such_tool", { method: "POST", headers, body: "{}" });
  assert.ok([200, 400, 404].includes(unknownTool.status), "未知工具由 host 决定成败，不在这里伪装成功语义");

  const destructive = await fetch(url + "/api/tools/learn_submit_assignment", { method: "POST", headers, body: "{}" });
  assert.equal(destructive.status, 428, "写入类工具没有审批令牌时拒绝执行");
  assert.equal((await destructive.json()).error.code, "APPROVAL_REQUIRED");

  const workspaceTool = await fetch(url + "/api/tools/workspace_list", { method: "POST", headers, body: "{}" });
  assert.equal(workspaceTool.status, 403, "工作区工具不能从通用入口绕过");
});

test("app: attachment upload validates name and emptiness", async (t) => {
  const { url } = await boot(t, { token: "t" });
  const headers = { authorization: "Bearer t", "content-type": "application/octet-stream" };

  const noName = await fetch(url + "/api/sidebar/attachments", { method: "POST", headers, body: "abc" });
  assert.equal(noName.status, 400);
  assert.equal((await noName.json()).error.code, "INVALID_FILE_NAME");

  const empty = await fetch(url + "/api/sidebar/attachments?name=a.txt", { method: "POST", headers, body: "" });
  assert.equal(empty.status, 400, "空文件不保存");
  assert.equal((await empty.json()).error.code, "EMPTY_FILE");

  const ok = await fetch(url + "/api/sidebar/attachments?name=a.txt", { method: "POST", headers, body: "hello" });
  const body = await ok.json();
  assert.equal(ok.status, 200);
  assert.equal(body.file.size, 5);
  assert.equal(typeof body.file.sha256, "string");
});

test("app: session rename and delete use session ids honestly", async (t) => {
  const { url, sessions } = await boot(t, { token: "t" });
  const headers = { authorization: "Bearer t", "content-type": "application/json" };
  const session = await sessions.create({ title: "旧标题" });
  const sessionId = session.id;
  await sessions.append(sessionId, [{ role: "user", content: "你好", at: new Date().toISOString() }], { title: "旧标题" });
  assert.ok(sessionId, "测试需要一条真实会话记录");

  const renamed = await fetch(url + "/api/sessions/" + sessionId, { method: "PATCH", headers, body: JSON.stringify({ title: "新标题" }) });
  const renamedBody = await renamed.json();
  assert.equal(renamed.status, 200);
  assert.equal(renamedBody.session.title, "新标题");

  const missing = await fetch(url + "/api/sessions/9a1c2d3e-4a5b-4c6d-8e9f-0a1b2c3d4e5f", { method: "PATCH", headers, body: JSON.stringify({ title: "x" }) });
  assert.equal(missing.status, 404);

  const removed = await fetch(url + "/api/sessions/" + sessionId, { method: "DELETE", headers });
  assert.equal(removed.status, 200);
  assert.equal((await removed.json()).removed, sessionId);
  const again = await fetch(url + "/api/sessions/" + sessionId, { method: "DELETE", headers });
  assert.equal(again.status, 404, "重复删除如实返回不存在");
});

test("app: auth login validates service and reports job ids", async (t) => {
  const baseHost = fakeHost();
  const host = { ...baseHost, async call(name, args) { if (name === "campus_browser_login") return { ok: true, data: { id: "job-1" } }; return baseHost.call(name, args); } };
  const { url } = await boot(t, { token: "t", host });
  const headers = { authorization: "Bearer t", "content-type": "application/json" };
  const bad = await fetch(url + "/api/auth/login", { method: "POST", headers, body: JSON.stringify({ service: "nope" }) });
  assert.equal(bad.status, 400);
  assert.equal((await bad.json()).error.code, "INVALID_ARGUMENTS");

  const ok = await fetch(url + "/api/auth/login", { method: "POST", headers, body: JSON.stringify({ service: "learnx", account: "2023000000" }) });
  const okBody = await ok.json();
  assert.equal(ok.status, 200);
  assert.equal(typeof okBody.jobId, "string");

  const job = await (await fetch(url + "/api/jobs/" + okBody.jobId, { headers })).json();
  assert.equal(job.ok, true);
  assert.equal(job.id, okBody.jobId);

  const abortUnknown = await fetch(url + "/api/chat/8f1c2d3e-4a5b-4c6d-8e9f-0a1b2c3d4e5f/abort", { method: "POST", headers });
  assert.equal(abortUnknown.status, 200);
  assert.equal((await abortUnknown.json()).aborted, false, "没有进行中的对话时如实返回未中止");

  const confirmMissing = await fetch(url + "/api/chat/8f1c2d3e-4a5b-4c6d-8e9f-0a1b2c3d4e5f/confirm", { method: "POST", headers, body: "{}" });
  assert.equal(confirmMissing.status, 400, "缺少 callId 不冒充确认成功");
});

test("app: sports reserve requires a scene, a slot and a confirmation token", async (t) => {
  const { url } = await boot(t, { token: "t" });
  const headers = { authorization: "Bearer t", "content-type": "application/json" };
  const empty = await fetch(url + "/api/sports/reserve/prepare", { method: "POST", headers, body: "{}" });
  assert.equal(empty.status, 400, "缺少场地与时段时直接拒绝");
  assert.equal((await empty.json()).error.code, "ARGUMENT_REQUIRED");

  const prepared = await fetch(url + "/api/sports/reserve/prepare", {
    method: "POST",
    headers,
    body: JSON.stringify({ sceneUuid: "s1", siteUuid: "site1", day: "2026-11-21", startTime: "19:00", endTime: "20:00" }),
  });
  const preparedBody = await prepared.json();
  assert.equal(prepared.status, 200);
  assert.equal(typeof preparedBody.token, "string");

  const noToken = await fetch(url + "/api/sports/reserve", {
    method: "POST",
    headers,
    body: JSON.stringify({ sceneUuid: "s1", siteUuid: "site1", day: "2026-11-21", startTime: "19:00", endTime: "20:00" }),
  });
  assert.equal(noToken.status, 428, "没有确认令牌不能下单");
  assert.equal((await noToken.json()).error.code, "APPROVAL_REQUIRED");
});

test("app: sports reserve requires a scene, a slot and a confirmation token", async (t) => {
  const { url } = await boot(t, { token: "t" });
  const headers = { authorization: "Bearer t", "content-type": "application/json" };
  const empty = await fetch(url + "/api/sports/reserve/prepare", { method: "POST", headers, body: "{}" });
  assert.equal(empty.status, 400, "缺少场地与时段时直接拒绝");
  assert.equal((await empty.json()).error.code, "ARGUMENT_REQUIRED");

  const prepared = await fetch(url + "/api/sports/reserve/prepare", {
    method: "POST",
    headers,
    body: JSON.stringify({ sceneUuid: "s1", siteUuid: "site1", day: "2026-11-21", startTime: "19:00", endTime: "20:00" }),
  });
  const preparedBody = await prepared.json();
  assert.equal(prepared.status, 200);
  assert.equal(typeof preparedBody.token, "string");

  const noToken = await fetch(url + "/api/sports/reserve", {
    method: "POST",
    headers,
    body: JSON.stringify({ sceneUuid: "s1", siteUuid: "site1", day: "2026-11-21", startTime: "19:00", endTime: "20:00" }),
  });
  assert.equal(noToken.status, 428, "没有确认令牌不能下单");
  assert.equal((await noToken.json()).error.code, "APPROVAL_REQUIRED");
});

test("app: sports routes surface argument errors without opening a browser", async (t) => {
  const { url } = await boot(t, { token: "t" });
  const headers = { authorization: "Bearer t" };
  const available = await fetch(url + "/api/sports/available?scene=", { headers });
  assert.equal(available.status, 400, "缺场景时直接 400");
  const availableBody = await available.json();
  assert.equal(availableBody.ok, false);
  assert.equal(availableBody.error.code, "ARGUMENT_REQUIRED");

  const venues = await fetch(url + "/api/sports/venues", { headers });
  assert.equal(venues.status, 400, "缺运动项目时直接 400");
  assert.equal((await venues.json()).error.code, "SPORT_REQUIRED");
});

test("app: gitlab config route masks the token and reports when it is missing", async (t) => {
  const { url } = await boot(t, { token: "t" });
  const headers = { authorization: "Bearer t", "content-type": "application/json" };

  const fresh = await (await fetch(url + "/api/gitlab/config", { headers })).json();
  assert.equal(fresh.ok, true);
  assert.equal(fresh.configured, false, "默认没有令牌");
  assert.equal(fresh.baseUrl, "https://git.tsinghua.edu.cn");
  assert.equal(fresh.masked, "");

  const saved = await (await fetch(url + "/api/gitlab/config", {
    method: "PUT", headers, body: JSON.stringify({ baseUrl: "https://git.tsinghua.edu.cn", token: "abcd1234efgh" }),
  })).json();
  assert.equal(saved.ok, true);
  assert.equal(saved.configured, true);
  assert.equal(saved.masked, "abcd****efgh", "只回显末四位");
  assert.ok(!JSON.stringify(saved).includes("abcd1234efgh"), "接口不回显明文令牌");

  const invalid = await fetch(url + "/api/gitlab/config", { method: "PUT", headers, body: JSON.stringify({ baseUrl: "ftp://bad" }) });
  assert.equal(invalid.status, 400);
  assert.equal((await invalid.json()).error.code, "INVALID_BASE_URL");
});

test("app: gitlab test route asks for configuration instead of failing as network error", async (t) => {
  const { url } = await boot(t, { token: "t" });
  const headers = { authorization: "Bearer t" };
  const response = await fetch(url + "/api/gitlab/test", { method: "POST", headers });
  assert.equal(response.status, 409);
  assert.equal((await response.json()).error.code, "GITLAB_NOT_CONFIGURED");
});


test("app: gitlab config keeps the saved token when only the url changes", async (t) => {
  const { url } = await boot(t, { token: "t" });
  const headers = { authorization: "Bearer t", "content-type": "application/json" };
  await fetch(url + "/api/gitlab/config", { method: "PUT", headers, body: JSON.stringify({ token: "abcd1234efgh" }) });
  const afterUrlOnly = await (await fetch(url + "/api/gitlab/config", { method: "PUT", headers, body: JSON.stringify({ baseUrl: "https://git.tsinghua.edu.cn" }) })).json();
  assert.equal(afterUrlOnly.configured, true, "只改地址不清空令牌");
  assert.equal(afterUrlOnly.masked, "abcd****efgh");
  const current = await (await fetch(url + "/api/gitlab/config", { headers })).json();
  assert.equal(current.baseUrl, "https://git.tsinghua.edu.cn");
  assert.equal(current.configured, true);
  assert.ok(!JSON.stringify(current).includes("abcd1234efgh"));
});
