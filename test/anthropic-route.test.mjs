import assert from "node:assert/strict";
import test from "node:test";
import { createAnthropicRoute, toOpenAiStream } from "../lib/app/anthropic-route.mjs";

const provider = { kind: "anthropic", baseUrl: "https://api.anthropic.test/v1/", apiKey: "sk-ant", model: "claude-sonnet-4-5" };

function sse(...events) {
  return events.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join("");
}

test("Anthropic 路由：模型列表、错误映射与请求翻译", async () => {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url, options });
    if (url.endsWith("/models?limit=100")) return Response.json({ data: [{ id: "claude-sonnet-4-5", display_name: "Sonnet 4.5" }] });
    if (url.endsWith("/messages")) {
      return new Response(sse(
        ["message_start", { type: "message_start" }],
        ["content_block_delta", { index: 0, delta: { type: "text_delta", text: "你好" } }],
        ["message_delta", { delta: { stop_reason: "end_turn" } }],
      ), { headers: { "content-type": "text/event-stream" } });
    }
    if (url.endsWith("/bad")) return new Response("no", { status: 401 });
    return new Response("x", { status: 500 });
  };
  try {
    const route = createAnthropicRoute(provider);
    assert.equal(route.route, "anthropic");
    assert.deepEqual(await route.models({ strict: true }), [{ id: "claude-sonnet-4-5", label: "Sonnet 4.5" }]);
    const request = calls.at(-1);
    assert.equal(request.url, "https://api.anthropic.test/v1/models?limit=100");
    assert.equal(request.options.headers["x-api-key"], "sk-ant");

    const response = await route.chat({ messages: [{ role: "user", content: "hi" }], tools: [] });
    assert.equal(response.headers.get("content-type").includes("text/event-stream"), true);
    const text = await response.text();
    assert.match(text, /你好/);
    assert.match(text, /\[DONE\]/);
    const sent = JSON.parse(calls.at(-1).options.body);
    assert.equal(sent.model, "claude-sonnet-4-5", "用提供商配置的模型");
    assert.equal(sent.stream, true);

    assert.deepEqual(await route.status(), { route: "anthropic", available: true, configured: true, expired: false, disabled: false, masked: "", expiresAt: null });
  } finally {
    globalThis.fetch = original;
  }
});

test("Anthropic 路由把鉴权失败与网络失败区分为可读错误", async () => {
  const original = globalThis.fetch;
  try {
    globalThis.fetch = async () => new Response(JSON.stringify({ error: { message: "invalid x-api-key" } }), { status: 401 });
    const route = createAnthropicRoute(provider);
    await assert.rejects(() => route.chat({ messages: [{ role: "user", content: "x" }] }), error => error.code === "MODEL_AUTH_FAILED");

    globalThis.fetch = async () => { throw new TypeError("fetch failed"); };
    await assert.rejects(() => route.chat({ messages: [{ role: "user", content: "x" }] }), error => error.code === "MODEL_UNREACHABLE");

    globalThis.fetch = async () => new Response("boom", { status: 529 });
    await assert.rejects(() => route.chat({ messages: [{ role: "user", content: "x" }] }), error => error.code === "MODEL_FAILED" && /529/.test(error.message));

    globalThis.fetch = async () => new Response("boom", { status: 500 });
    const route2 = createAnthropicRoute(provider);
    assert.deepEqual(await route2.models(), [], "非严格模式返回空列表");
    await assert.rejects(() => route2.models({ strict: true }), error => error.code === "MODEL_DISCOVERY_FAILED");

    globalThis.fetch = async () => { throw new TypeError("fetch failed"); };
    assert.deepEqual(await route2.models(), []);
  } finally {
    globalThis.fetch = original;
  }
});

test("事件流中断时补一个错误帧并结束，不挂起请求", async () => {
  const frame = new TextEncoder().encode(`event: content_block_delta\ndata: ${JSON.stringify({ index: 0, delta: { type: "text_delta", text: "半句" } })}\n\n`);
  let reads = 0;
  const broken = {
    headers: new Headers({ "content-type": "text/event-stream" }),
    body: {
      getReader: () => ({
        async read() {
          reads += 1;
          if (reads === 1) return { value: frame, done: false };
          throw new Error("socket reset");
        },
      }),
      cancel: async () => {},
    },
  };
  const text = await toOpenAiStream(broken, "claude").text();
  assert.match(text, /半句/);
  assert.match(text, /"code":"MODEL_FAILED"/);
  assert.match(text, /\[DONE\]/);
});