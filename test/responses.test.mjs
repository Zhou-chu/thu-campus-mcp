import assert from "node:assert/strict";
import test from "node:test";
import { createResponsesTranslator, toResponsesInput, toResponsesRequest, toResponsesTools } from "../lib/app/responses.mjs";
import { createResponsesRoute } from "../lib/app/responses-route.mjs";

test("Chat 消息翻译成 Responses input，system 进 instructions", () => {
  const { instructions, input } = toResponsesInput([
    { role: "system", content: "你是校园助手。" },
    { role: "user", content: "查成绩" },
    { role: "assistant", content: "", tool_calls: [{ id: "call_1", function: { name: "learn_grades", arguments: "{\"term\":\"2026秋\"}" } }] },
    { role: "tool", tool_call_id: "call_1", content: "{\"ok\":true}" },
    { role: "assistant", content: "绩点 3.9" },
  ]);
  assert.equal(instructions, "你是校园助手。");
  assert.deepEqual(input[0], { type: "message", role: "user", content: [{ type: "input_text", text: "查成绩" }] });
  assert.deepEqual(input[1], { type: "function_call", call_id: "call_1", name: "learn_grades", arguments: "{\"term\":\"2026秋\"}" });
  assert.deepEqual(input[2], { type: "function_call_output", call_id: "call_1", output: "{\"ok\":true}" });
  assert.deepEqual(input[3], { type: "message", role: "assistant", content: [{ type: "output_text", text: "绩点 3.9" }] });
});

test("图片转 input_image，工具转扁平结构，缺名字丢弃", () => {
  const { input } = toResponsesInput([
    { role: "user", content: [{ type: "text", text: "看图" }, { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } }] },
  ]);
  assert.deepEqual(input[0].content.at(-1), { type: "input_image", image_url: "data:image/png;base64,AAAA", detail: "auto" });
  assert.deepEqual(toResponsesTools([
    { type: "function", function: { name: "a", description: "d", parameters: { type: "object" } } },
    { type: "function", function: { description: "无名" } },
  ]), [{ type: "function", name: "a", description: "d", parameters: { type: "object" }, strict: false }]);
});

test("请求体带上模型、流式与温度", () => {
  const request = toResponsesRequest({ messages: [{ role: "user", content: "hi" }], temperature: 0.1 }, { model: "gpt-5" });
  assert.equal(request.model, "gpt-5");
  assert.equal(request.stream, true);
  assert.equal(request.store, false);
  assert.equal(request.temperature, 0.1);
});

test("Responses 事件翻译成 chat chunks：文本、工具参数与结束原因", () => {
  const frames = [];
  const translator = createResponsesTranslator({ model: "gpt-5", onFrame: frame => frames.push(frame) });
  translator.push("response.output_text.delta", { delta: "绩点" });
  translator.push("response.output_item.added", { item: { id: "fc_1", type: "function_call", call_id: "call_1", name: "learn_grades" }, output_index: 0 });
  translator.push("response.function_call_arguments.delta", { item_id: "fc_1", delta: "{\"term\":" });
  translator.push("response.completed", { response: { output: [{ type: "function_call" }] } });
  translator.push("response.failed", { response: { error: { message: "超时" } } });

  assert.equal(frames[0].choices[0].delta.role, "assistant");
  assert.equal(frames[1].choices[0].delta.content, "绩点");
  assert.deepEqual(frames[2].choices[0].delta.tool_calls[0].function, { name: "learn_grades", arguments: "" });
  assert.equal(frames[3].choices[0].delta.tool_calls[0].function.arguments, "{\"term\":");
  assert.equal(frames[4].choices[0].finish_reason, "tool_calls");
  assert.equal(frames[5].error.code, "MODEL_FAILED");
});

function sse(...events) {
  return events.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join("");
}

test("Responses 路由：请求打到 /responses，流式结果转成 OpenAI SSE", async () => {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    if (String(url).endsWith("/models")) return Response.json({ data: [{ id: "gpt-5" }] });
    return new Response(sse(
      ["response.output_text.delta", { delta: "你好" }],
      ["response.completed", { response: { output: [] } }],
    ), { headers: { "content-type": "text/event-stream" } });
  };
  try {
    const route = createResponsesRoute({ kind: "openai-responses", baseUrl: "https://api.example.com/v1/", apiKey: "sk-1", model: "gpt-5" });
    assert.deepEqual(await route.models({ strict: true }), [{ id: "gpt-5", label: "gpt-5" }]);
    assert.equal(calls.at(-1).url, "https://api.example.com/v1/models");
    const text = await (await route.chat({ messages: [{ role: "user", content: "hi" }] })).text();
    assert.match(text, /你好/);
    assert.match(text, /\[DONE\]/);
    assert.equal(calls.at(-1).url, "https://api.example.com/v1/responses");
    assert.equal(JSON.parse(calls.at(-1).options.body).model, "gpt-5");
    assert.deepEqual(await route.status(), { route: "openai-responses", available: true, configured: true, expired: false, disabled: false, masked: "", expiresAt: null });
  } finally {
    globalThis.fetch = original;
  }
});

test("Responses 路由区分鉴权失败、网络失败与非严格模型列表", async () => {
  const original = globalThis.fetch;
  try {
    const route = createResponsesRoute({ baseUrl: "https://x/v1", apiKey: "k", model: "m" });
    globalThis.fetch = async () => new Response(JSON.stringify({ error: { message: "bad key" } }), { status: 401 });
    await assert.rejects(() => route.chat({ messages: [{ role: "user", content: "x" }] }), error => error.code === "MODEL_AUTH_FAILED");
    assert.deepEqual(await route.models(), []);
    await assert.rejects(() => route.models({ strict: true }), error => error.code === "MODEL_DISCOVERY_FAILED");

    globalThis.fetch = async () => { throw new TypeError("fetch failed"); };
    await assert.rejects(() => route.chat({ messages: [{ role: "user", content: "x" }] }), error => error.code === "MODEL_UNREACHABLE");

    globalThis.fetch = async () => new Response("boom", { status: 500 });
    await assert.rejects(() => route.chat({ messages: [{ role: "user", content: "x" }] }), error => error.code === "MODEL_FAILED" && /500/.test(error.message));
  } finally {
    globalThis.fetch = original;
  }
});