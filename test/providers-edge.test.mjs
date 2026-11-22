import assert from "node:assert/strict";
import test from "node:test";
import { createResponsesTranslator, toResponsesInput } from "../lib/app/responses.mjs";
import { createAnthropicTranslator, toAnthropicMessages } from "../lib/app/anthropic.mjs";
import { ProviderStore, fetchProviderModels, maskKey, normalizeProvider } from "../lib/app/providers.mjs";
import { createProviderRoutes } from "../lib/app/routes/providers.mjs";

test("Responses 翻译：纯文本、空内容与未知部分都被安全跳过", () => {
  assert.equal(toResponsesInput([]).instructions, "");
  const { input } = toResponsesInput([
    { role: "user", content: [{ type: "unknown", value: 1 }] },
    { role: "assistant", content: "" },
    { role: "system", content: [{ type: "text", text: "一" }] },
    { role: "system", content: [{ type: "text", text: "二" }] },
    { role: "user", content: null },
  ]);
  assert.deepEqual(input, []);
  assert.equal(toResponsesInput([{ role: "system", content: "a" }, { role: "system", content: "b" }]).instructions, "a\n\nb");
  assert.deepEqual(toResponsesInput([{ role: "user", content: [{ type: "text", text: "x" }] }]).input[0].content, [{ type: "input_text", text: "x" }]);
});

test("Responses 事件：角色只发一次、未知事件忽略、completed 无工具时 stop", () => {
  const frames = [];
  const translator = createResponsesTranslator({ model: "m", onFrame: frame => frames.push(frame) });
  translator.push("response.output_item.added", { item: { id: "fc", type: "function_call", name: "t" }, output_index: 2 });
  translator.push("response.function_call_arguments.delta", { output_index: 2, delta: "{}" });
  translator.push("response.output_text.delta", { delta: "hi" });
  translator.push("response.output_text.delta", { delta: "!" });
  translator.push("response.unknown", {});
  translator.push("response.completed", { response: { output: [{ type: "message" }] } });
  assert.equal(frames.filter(frame => frame.choices?.[0]?.delta?.role).length, 1, "role 只出现一次");
  assert.equal(frames.filter(frame => frame.choices?.[0]?.delta?.content === "hi").length, 1);
  assert.equal(frames.at(-1).choices[0].finish_reason, "stop");
  assert.equal(frames.some(frame => frame.choices?.[0]?.delta?.content === "!"), true);
});

test("Anthropic 翻译：空消息、非数组内容与错误帧", () => {
  assert.deepEqual(toAnthropicMessages([]).messages, []);
  const { messages } = toAnthropicMessages([
    { role: "user", content: "a" },
    { role: "assistant", content: "b" },
    { role: "user", content: "c" },
  ]);
  assert.deepEqual(messages.map(message => message.role), ["user", "assistant", "user"]);
  const frames = [];
  const translator = createAnthropicTranslator({ model: "m", onFrame: frame => frames.push(frame) });
  translator.push("content_block_start", { index: 0, content_block: { type: "text" } });
  translator.push("content_block_delta", { index: 0, delta: { type: "unknown" } });
  translator.push("content_block_delta", { index: 0, delta: { type: "input_json_delta", partial_json: "{}" } });
  translator.push("error", {});
  // content_block_start(text) 发 role、input_json_delta 发参数、error 发错误帧；未知 delta 不发。
  assert.equal(frames.length, 3, "未知 delta 不发帧");
  assert.equal(frames.at(-1).error.code, "MODEL_FAILED");
});

test("提供商存储：加密读写、旧文件缺失与掩码", async () => {
  const dir = await (await import("node:fs/promises")).mkdtemp((await import("node:path")).join((await import("node:os")).tmpdir(), "prov-theme-"));
  try {
    const cipher = (bytes, decrypt) => (decrypt ? Buffer.from(String(bytes), "base64") : Buffer.from(Buffer.from(bytes).toString("base64")));
    const store = new ProviderStore(dir, { encrypt: cipher });
    assert.deepEqual(store.loadSync().list(), []);
    await store.create({ name: "加密", kind: "openai", baseUrl: "https://x/v1", apiKey: "sk-secret-value" });
    const reopened = new ProviderStore(dir, { encrypt: cipher }).loadSync();
    assert.equal(reopened.list()[0].masked, "sk-s****alue");
    assert.deepEqual(normalizeProvider({ name: "x", kind: "openai-responses", baseUrl: "https://x", apiKey: "k" }).model, "gpt-5");
    assert.equal(normalizeProvider({ name: "x", kind: "anthropic", baseUrl: "https://x", apiKey: "k" }).model, "claude-sonnet-4-5");
  } finally {
    await (await import("node:fs/promises")).rm(dir, { recursive: true, force: true });
  }
});

test("模型导入：非 JSON、缺 data 与字符串模型名", async () => {
  const provider = { kind: "openai", baseUrl: "https://x/v1", apiKey: "k" };
  await assert.rejects(
    () => fetchProviderModels(provider, { fetchImpl: async () => new Response("not json") }),
    error => error.code === "PROVIDER_MODELS_EMPTY",
  );
  const fromModels = await fetchProviderModels(provider, { fetchImpl: async () => Response.json({ models: [{ name: "m1" }, { id: "m2" }] }) });
  assert.deepEqual(fromModels, ["m1", "m2"]);
});

test("提供商路由：更新失败、删除未知 ID 与 unknown 子路径", async () => {
  const dir = await (await import("node:fs/promises")).mkdtemp((await import("node:path")).join((await import("node:os")).tmpdir(), "prov-routes2-"));
  try {
    const store = await new ProviderStore(dir).load();
    const created = await store.create({ name: "A", kind: "openai", baseUrl: "https://x/v1", apiKey: "k-12345678" });
    const bodies = [];
    const handler = createProviderRoutes({ store, readBody: async () => bodies.shift() || {} });
    const res = () => ({ writableEnded: false, writeHead() {}, end() {} });

    bodies.push({ name: "" });
    const badPatch = await (async () => {
      let status = 0;
      const res2 = { writableEnded: false, writeHead(code) { status = code; }, end() {} };
      await handler({}, res2, { pathname: "/api/providers/" + created.id, method: "PATCH", url: new URL("http://x/api/providers/" + created.id) });
      return status;
    })();
    assert.equal(badPatch, 400);

    assert.equal(await handler({}, res(), { pathname: "/api/providers/" + created.id + "/unknown", method: "POST", url: new URL("http://x/api/providers/x/unknown") }), false);
  } finally {
    await (await import("node:fs/promises")).rm(dir, { recursive: true, force: true });
  }
});
test("Responses 事件：工具项缺字段与错误帧都安全", () => {
  const frames = [];
  const translator = createResponsesTranslator({ model: "m", onFrame: frame => frames.push(frame) });
  translator.push("response.output_item.added", { item: { type: "function_call" } });
  translator.push("response.function_call_arguments.delta", { item_id: "unknown", delta: "{}" });
  translator.push("response.failed", {});
  translator.push("error", { error: { message: "boom" } });
  assert.equal(frames[0].choices[0].delta.role, "assistant", "先发 role 帧");
  assert.equal(frames[1].choices[0].delta.tool_calls[0].function.name, "");
  assert.equal(frames[1].choices[0].delta.tool_calls[0].id, undefined);
  assert.equal(frames[2].choices[0].delta.tool_calls[0].index, 0);
  assert.match(frames[3].error.message, /上游返回错误/);
  assert.equal(frames[4].error.message, "boom");
});

test("Responses 输入：content 为非数组字符串与 assistant 纯文本", () => {
  const { input } = toResponsesInput([
    { role: "user", content: "" },
    { role: "assistant", content: "答" },
  ]);
  assert.equal(input.length, 1);
  assert.deepEqual(input[0], { type: "message", role: "assistant", content: [{ type: "output_text", text: "答" }] });
});

test("提供商校验：模型数组清洗、默认模型与已有密钥沿用", () => {
  const provider = normalizeProvider({ name: "x", kind: "openai", baseUrl: "https://x/v1/", apiKey: "k", models: [" m1 ", "m1", "", 3] });
  assert.deepEqual(provider.models, ["m1", "3"], "数字与空白都被规范化");
  assert.equal(provider.model, "m1", "没有显式模型时用列表第一个");
  const kept = normalizeProvider({ name: "x" }, { kind: "anthropic", name: "old", baseUrl: "https://a/v1", apiKey: "sk-old", models: [], model: "c" });
  assert.equal(kept.apiKey, "sk-old", "留空沿用旧密钥");
  assert.equal(kept.baseUrl, "https://a/v1");
  assert.equal(maskKey("12345678"), "****");
  assert.equal(maskKey("123456789"), "1234****6789");
});

test("提供商路由：重复名称、列表读取与未知动作", async () => {
  const dir = await (await import("node:fs/promises")).mkdtemp((await import("node:path")).join((await import("node:os")).tmpdir(), "prov-routes3-"));
  try {
    const store = await new ProviderStore(dir).load();
    await store.create({ name: "重名", kind: "openai", baseUrl: "https://x/v1", apiKey: "k-12345678" });
    const bodies = [];
    const handler = createProviderRoutes({ store, readBody: async () => bodies.shift() || {} });
    const run = async (pathname, method, body) => {
      bodies.push(body || {});
      let status = 0, payload;
      const res = { writableEnded: false, writeHead(code) { status = code; }, end(raw) { payload = raw ? JSON.parse(raw) : undefined; } };
      const handled = await handler({ method }, res, { pathname, method, url: new URL("http://x" + pathname) });
      return { status, payload, handled };
    };

    const duplicate = await run("/api/providers", "POST", { name: "重名", kind: "openai", baseUrl: "https://x/v1", apiKey: "k-2" });
    assert.equal(duplicate.status, 400);
    assert.match(duplicate.payload.error.message, /同名/);

    const listed = await run("/api/providers", "GET");
    assert.equal(listed.payload.providers.length, 1);
    assert.equal(listed.payload.activeId.length > 0, true);

    const unknown = await run("/api/providers/00000000-0000-4000-8000-000000000000/test", "POST");
    assert.equal(unknown.status, 404);

    const modelsMissing = await run("/api/providers/00000000-0000-4000-8000-000000000000/models", "POST");
    assert.equal(modelsMissing.status, 404);

    const notHandled = await run("/api/providers", "DELETE");
    assert.equal(notHandled.handled, false);
  } finally {
    await (await import("node:fs/promises")).rm(dir, { recursive: true, force: true });
  }
});
