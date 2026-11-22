import assert from "node:assert/strict";
import test from "node:test";
import {
  createAnthropicTranslator,
  readSse,
  toAnthropicMessages,
  toAnthropicRequest,
  toAnthropicTools,
} from "../lib/app/anthropic.mjs";

test("OpenAI 消息翻译成 Anthropic：system、工具往返、相邻角色合并", () => {
  const { system, messages } = toAnthropicMessages([
    { role: "system", content: "你是校园助手。" },
    { role: "user", content: "查成绩" },
    { role: "user", content: [{ type: "text", text: "顺便看作业" }] },
    { role: "assistant", content: "", tool_calls: [{ id: "call_1", function: { name: "learn_grades", arguments: "{\"term\":\"2026秋\"}" } }] },
    { role: "tool", tool_call_id: "call_1", content: "{\"ok\":true}" },
    { role: "assistant", content: "你的绩点是 3.9。" },
  ]);
  assert.equal(system, "你是校园助手。");
  assert.equal(messages[0].role, "user");
  assert.equal(messages[0].content.length, 2, "相邻 user 合并");
  assert.equal(messages[1].role, "assistant");
  assert.deepEqual(messages[1].content[0], { type: "tool_use", id: "call_1", name: "learn_grades", input: { term: "2026秋" } });
  assert.equal(messages[2].role, "user");
  assert.deepEqual(messages[2].content[0], { type: "tool_result", tool_use_id: "call_1", content: "{\"ok\":true}" });
});

test("图片 data URL 转 base64 源，助手开头的会话补 user", () => {
  const { messages } = toAnthropicMessages([
    { role: "assistant", content: "先说话" },
    { role: "user", content: [{ type: "text", text: "看图" }, { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } }] },
  ]);
  assert.equal(messages[0].role, "user", "首条必须是 user");
  assert.deepEqual(messages.at(-1).content.at(-1), { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } });
  const external = toAnthropicMessages([{ role: "user", content: [{ type: "image_url", image_url: { url: "https://x/y.png" } }] }]);
  assert.deepEqual(external.messages[0].content[0], { type: "image", source: { type: "url", url: "https://x/y.png" } });
});

test("请求体带上工具、温度与受限的 max_tokens", () => {
  const request = toAnthropicRequest({
    messages: [{ role: "user", content: "hi" }],
    tools: [{ type: "function", function: { name: "learn_status", description: "状态", parameters: { type: "object" } } }],
    temperature: 0.2,
    max_tokens: 999999,
  }, { model: "claude-sonnet-4-5" });
  assert.equal(request.model, "claude-sonnet-4-5");
  assert.equal(request.max_tokens, 64000);
  assert.equal(request.stream, true);
  assert.equal(request.temperature, 0.2);
  assert.deepEqual(request.tools, [{ name: "learn_status", description: "状态", input_schema: { type: "object" } }]);
  assert.deepEqual(toAnthropicTools([{ type: "function", function: {} }]), [], "缺名字的工具被丢弃");
});

test("流式事件翻译成 OpenAI chunks：文本与工具参数增量", () => {
  const frames = [];
  const translator = createAnthropicTranslator({ model: "claude", onFrame: frame => frames.push(frame) });
  translator.push("message_start", {});
  translator.push("content_block_delta", { index: 0, delta: { type: "text_delta", text: "绩点" } });
  translator.push("content_block_start", { index: 1, content_block: { type: "tool_use", id: "tool_1", name: "learn_grades" } });
  translator.push("content_block_delta", { index: 1, delta: { type: "input_json_delta", partial_json: "{\"term\":" } });
  translator.push("content_block_delta", { index: 1, delta: { type: "input_json_delta", partial_json: "\"2026秋\"}" } });
  translator.push("message_delta", { delta: { stop_reason: "tool_use" } });
  translator.push("error", { error: { message: "超时" } });

  assert.equal(frames[0].choices[0].delta.role, "assistant");
  assert.equal(frames[1].choices[0].delta.content, "绩点");
  assert.deepEqual(frames[2].choices[0].delta.tool_calls[0].function, { name: "learn_grades", arguments: "" });
  assert.equal(frames[3].choices[0].delta.tool_calls[0].function.arguments, "{\"term\":");
  assert.equal(frames[5].choices[0].finish_reason, "tool_calls");
  assert.equal(frames[6].error.code, "MODEL_FAILED");
});

test("SSE 解析按空行分帧，忽略坏帧", async () => {
  const text = [
    "event: message_start\ndata: {\"type\":\"message_start\"}\n\n",
    "event: content_block_delta\ndata: {\"delta\":{\"type\":\"text_delta\",\"text\":\"a\"}}\n\n",
    "event: bad\ndata: {oops\n\n",
  ].join("");
  const events = [];
  await readSse(new Response(text), (event, data) => events.push([event, data]));
  assert.deepEqual(events.map(([event]) => event), ["message_start", "content_block_delta"]);
  assert.equal(events[1][1].delta.text, "a");
});