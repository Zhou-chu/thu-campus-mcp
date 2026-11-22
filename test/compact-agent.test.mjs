import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

function fakeHost() {
  return {
    describe: () => [
      { name: "learn_status", service: "learnx", description: "网络学堂状态", inputSchema: { type: "object" }, readOnly: true },
      { name: "seat_libraries", service: "seat", description: "图书馆分馆", inputSchema: { type: "object" }, readOnly: true },
    ],
    toolForModel: () => [
      { type: "function", function: { name: "learn_status", description: "网络学堂状态", parameters: { type: "object" } } },
      { type: "function", function: { name: "seat_libraries", description: "图书馆分馆", parameters: { type: "object" } } },
    ],
    async call(name) { return { ok: true, data: { name } }; },
  };
}

test("runTurn 在精简宿主下只发送两个入口，且检索结果可继续调用", async () => {
  const { createCompactToolset } = await import("../lib/app/compact-tools.mjs");
  const compact = createCompactToolset({ host: fakeHost() });
  const wire = [];
  const completion = (toolCalls = [], content = "") => Response.json({
    choices: [{ message: { content, tool_calls: toolCalls }, finish_reason: "stop" }],
    usage: { total_tokens: 7 },
  });
  const route = {
    async chat(body) {
      wire.push(body);
      const names = (body.tools || []).map(t => t.function.name).sort();
      assert.deepEqual(names, ["campus_tool_call", "campus_tool_search"]);
      if (wire.length === 1)
        return completion([{ id: "call_1", type: "function", function: { name: "campus_tool_search", arguments: JSON.stringify({ query: "图书馆" }) } }]);
      return completion([], "图书馆分馆有三个。");
    },
  };
  const events = [];
  const { runTurn } = await import("../lib/app/agent.mjs");
  const store = {
    async get() { return { id: "s1", messages: [] }; },
    async append() {},
    async rename() {},
  };
  const result = await runTurn({
    host: compact, route, store, sessionId: "s1", text: "图书馆分馆", model: "test", reasoningEffort: "",
    emit: (event, data) => events.push({ event, data }), signal: new AbortController().signal,
    approvals: null, requireApproval: true,
  });
  assert.equal(result.steps, 2);
  const toolEnd = events.find(e => e.event === "tool" && e.data.phase === "end");
  assert.equal(toolEnd.data.name, "campus_tool_search");
  assert.equal(toolEnd.data.result.tools[0].name, "seat_libraries");
  const toolMessage = wire[1].messages.find(m => m.role === "tool");
  assert.match(String(toolMessage.content), /seat_libraries/);
  assert.ok(JSON.stringify(wire[0].tools).length < 1500, "首轮工具 Schema 应远小于完整清单");
});

test("README 记录精简模式的取舍", async () => {
  const text = await readFile("README.md", "utf8");
  assert.match(text, /精简工具模式/, "README 需要说明精简模式");
  assert.match(text, /只读/, "README 要说明精简模式只提供只读工具");
});