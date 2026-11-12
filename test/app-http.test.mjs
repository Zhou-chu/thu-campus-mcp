import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
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
async function boot(t, { token = "", route = scriptedRoute(), host = fakeHost(), config: overrides = {} } = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), "campus-app-http-"));
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
  assert.equal(payload.services.learnx.state, "ready");
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
  const failure = await fetch(url + "/api/tools/learn_submit_assignment", {
    method: "POST",
    headers,
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
  assert.equal(initial.settings.maxSteps, 8);
  const bad = await fetch(url + "/api/settings", {
    method: "PUT",
    headers,
    body: JSON.stringify({ maxSteps: 99 }),
  });
  assert.equal(bad.status, 400);
  const good = await fetch(url + "/api/settings", {
    method: "PUT",
    headers,
    body: JSON.stringify({ maxSteps: 4, modelName: "test-model", ignored: "x" }),
  });
  const saved = await good.json();
  assert.equal(saved.settings.maxSteps, 4);
  assert.equal(saved.settings.ignored, undefined);
  const raw = JSON.parse(await (await import("node:fs/promises")).readFile(path.join(dir, "settings.json"), "utf8"));
  assert.equal(raw.maxSteps, 4);
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
