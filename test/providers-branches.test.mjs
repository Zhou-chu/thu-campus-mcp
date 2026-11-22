import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { toAnthropicMessages, toAnthropicRequest, createAnthropicTranslator } from "../lib/app/anthropic.mjs";
import { toResponsesInput, toResponsesRequest, createResponsesTranslator } from "../lib/app/responses.mjs";
import { ProviderStore, fetchProviderModels, normalizeProvider } from "../lib/app/providers.mjs";
import { createProviderRoutes } from "../lib/app/routes/providers.mjs";
import { createAnthropicRoute } from "../lib/app/anthropic-route.mjs";
import { createResponsesRoute } from "../lib/app/responses-route.mjs";

test("Anthropic 翻译边界：数组内非文本、缺 id 的工具调用、无 stop 的 message_delta", () => {
  const { messages } = toAnthropicMessages([
    { role: "user", content: [{ type: "image_url" }] },
    { role: "assistant", content: [{ type: "text", text: "" }], tool_calls: [{ id: "c1", function: { name: "t", arguments: "not-json" } }] },
    { role: "user", content: "ok" },
  ]);
  assert.equal(messages.at(-1).role, "user");
  const frames = [];
  const translator = createAnthropicTranslator({ model: "m", onFrame: frame => frames.push(frame) });
  translator.push("message_start", {});
  translator.push("content_block_start", { index: 0, content_block: { type: "text" } });
  translator.push("message_delta", {});
  translator.push("content_block_delta", { index: 0, delta: { type: "text_delta" } });
  assert.equal(frames.length, 1, "只有 role 帧；空文本与无 stop 不发帧");
  const request = toAnthropicRequest({ messages: [], tools: null }, { model: "m", maxTokens: 100 });
  assert.equal(request.max_tokens, 256, "低于下限时抬到 256");
  assert.equal(request.tools, undefined);
});

test("Responses 翻译边界：非数组 content、空工具、缺 model", () => {
  assert.deepEqual(toResponsesInput([{ role: "user", content: 42 }]).input, []);
  assert.equal(toResponsesRequest({ messages: [] }, {}).model, undefined);
  assert.equal(toResponsesRequest({ messages: [], tools: [] }).tools, undefined);
  const frames = [];
  const translator = createResponsesTranslator({ model: "m", onFrame: frame => frames.push(frame) });
  translator.push("response.output_text.delta", { delta: 42 });
  translator.push("response.function_call_arguments.delta", { delta: 42 });
  translator.push("response.completed", {});
  assert.equal(frames.at(-1).choices[0].finish_reason, "stop");
  assert.equal(frames.length, 1, "非字符串增量被忽略");
});

test("提供商校验边界：名称超长截断、模型列表上限、更新不存在", async () => {
  const provider = normalizeProvider({ name: "n".repeat(80), kind: "openai", baseUrl: "https://x/v1", apiKey: "k", models: Array.from({ length: 250 }, (_, i) => "m" + i) });
  assert.equal(provider.name.length, 40);
  assert.equal(provider.models.length, 200);

  const dir = await mkdtemp(path.join(tmpdir(), "prov-limits-"));
  try {
    const store = await new ProviderStore(dir).load();
    assert.equal(await store.update("00000000-0000-4000-8000-000000000000", { name: "x" }), null);
    assert.equal(await store.setModels("00000000-0000-4000-8000-000000000000", ["a"]), null);
    const created = await store.create({ name: "上限", kind: "openai", baseUrl: "https://x/v1", apiKey: "k" });
    await store.setModels(created.id, Array.from({ length: 250 }, (_, i) => "m" + i));
    assert.equal(store.get(created.id).models.length, 200);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("模型导入边界：anthropic 缺 data、非 JSON 的 200 响应", async () => {
  const anthropic = { kind: "anthropic", baseUrl: "https://a/v1", apiKey: "k" };
  const list = await fetchProviderModels(anthropic, { fetchImpl: async () => Response.json({ data: [{ id: "c1" }, { name: "" }] }) });
  assert.deepEqual(list, ["c1"]);
  await assert.rejects(
    () => fetchProviderModels(anthropic, { fetchImpl: async () => new Response("not-json") }),
    error => error.code === "PROVIDER_MODELS_EMPTY",
  );
});

test("路由层边界：查询串路径不被当作动作、PATCH 非对象体、active 空对象", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "prov-route-edge-"));
  try {
    const store = await new ProviderStore(dir).load();
    const created = await store.create({ name: "A", kind: "openai", baseUrl: "https://x/v1", apiKey: "k-1" });
    const bodies = [];
    const handler = createProviderRoutes({ store, readBody: async () => bodies.shift() ?? {} });
    const run = async (pathname, method) => {
      let status = 0;
      const res = { writableEnded: false, writeHead(code) { status = code; }, end() {} };
      const handled = await handler({ method }, res, { pathname, method, url: new URL("http://x" + pathname) });
      return { status, handled };
    };
    bodies.push("not-an-object");
    assert.equal((await run("/api/providers", "POST")).status, 400);
    bodies.push({ id: "" });
    assert.equal((await run("/api/providers/active", "PUT")).status, 200, "空 id 表示停用");
    assert.equal((await run("/api/providers/" + created.id + "/models?x=1", "POST")).handled, false);
    assert.equal((await run("/api/providers/not-a-uuid", "PATCH")).handled, false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("两个原生路由的边界：缺 body、非 JSON 错误体、取消读取", async () => {
  const original = globalThis.fetch;
  try {
    const anthropic = createAnthropicRoute({ baseUrl: "https://a/v1", apiKey: "k", model: "m" });
    globalThis.fetch = async () => new Response("plain", { status: 400 });
    await assert.rejects(() => anthropic.chat({ messages: [] }), error => error.code === "MODEL_FAILED");

    const responses = createResponsesRoute({ baseUrl: "https://r/v1", apiKey: "k", model: "m" });
    globalThis.fetch = async () => new Response("plain", { status: 403 });
    await assert.rejects(() => responses.chat({ messages: [] }), error => error.code === "MODEL_AUTH_FAILED");

    globalThis.fetch = async () => new Response("plain", { status: 500 });
    await assert.rejects(() => responses.chat({ messages: [] }), error => /500/.test(error.message));
  } finally {
    globalThis.fetch = original;
  }
});
test("未预期错误映射为 502，流取消会转发到上游", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "prov-500-"));
  try {
    const store = await new ProviderStore(dir).load();
    store.create = async () => { throw new Error("磁盘写满"); };
    const handler = createProviderRoutes({ store, readBody: async () => ({ name: "x", kind: "openai", baseUrl: "https://x", apiKey: "k" }) });
    let status = 0, payload;
    const res = { writableEnded: false, writeHead(code) { status = code; }, end(raw) { payload = JSON.parse(raw); } };
    await handler({ method: "POST" }, res, { pathname: "/api/providers", method: "POST", url: new URL("http://x/api/providers") });
    assert.equal(status, 502);
    assert.equal(payload.error.code, "PROVIDER_ERROR");
    assert.match(payload.error.message, /磁盘写满/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }

  // 流被取消时把取消传给上游 reader，避免挂着连接。
  let cancelled = 0;
  const body = {
    getReader: () => ({ async read() { await new Promise(() => {}); return { done: true }; } }),
    cancel: async () => { cancelled += 1; },
  };
  const original = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, body, headers: new Headers({ "content-type": "text/event-stream" }) });
  try {
    const route = createAnthropicRoute({ baseUrl: "https://a/v1", apiKey: "k", model: "m" });
    const response = await route.chat({ messages: [] });
    await response.body.cancel();
    assert.equal(cancelled, 1);
    const responses = createResponsesRoute({ baseUrl: "https://r/v1", apiKey: "k", model: "m" });
    const second = await responses.chat({ messages: [] });
    await second.body.cancel();
    assert.equal(cancelled, 2);
  } finally {
    globalThis.fetch = original;
  }
});
