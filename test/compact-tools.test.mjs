import assert from "node:assert/strict";
import test from "node:test";
import { CALL_TOOL, SEARCH_TOOL, createCompactToolset } from "../lib/app/compact-tools.mjs";

const tools = [
  { name: "learn_status", service: "learnx", description: "查看网络学堂登录状态", inputSchema: { type: "object" }, readOnly: true },
  { name: "learn_grades", service: "learnx", description: "查询课程成绩与绩点", inputSchema: { type: "object" }, readOnly: true },
  { name: "seat_libraries", service: "seat", description: "列出图书馆分馆与开放状态", inputSchema: { type: "object" }, readOnly: true },
  { name: "sports_slots", service: "sports", description: "查询体育场馆可预约时段", inputSchema: { type: "object" }, readOnly: true },
  { name: "seat_reserve", service: "seat", description: "预约图书馆座位，会写入校园系统", inputSchema: { type: "object" }, readOnly: false },
];

function hostFixture(calls = []) {
  return {
    describe: () => tools,
    toolForModel: () => { throw new Error("精简模式不应要求完整工具清单"); },
    async call(name, args) { calls.push({ name, args }); return { ok: true, data: { name, args } }; },
  };
}

test("模型只拿到两个入口，完整清单不会注入上下文", () => {
  const toolset = createCompactToolset({ host: hostFixture() });
  const modelTools = toolset.toolForModel();
  assert.deepEqual(modelTools.map(item => item.function.name).sort(), [CALL_TOOL.name, SEARCH_TOOL.name].sort());
  assert.equal(JSON.stringify(modelTools).length < 1200, true, "两个入口的 Schema 应很小");
  assert.deepEqual(toolset.describe().map(item => item.name).sort(), [CALL_TOOL.name, SEARCH_TOOL.name].sort());
});

test("检索按关键词命中只读工具，写工具永远不出现", async () => {
  const toolset = createCompactToolset({ host: hostFixture() });
  const grades = await toolset.call(SEARCH_TOOL.name, { query: "成绩" });
  assert.equal(grades.ok, true);
  assert.deepEqual(grades.data.tools.map(item => item.name), ["learn_grades"]);
  assert.equal(grades.data.tools[0].inputSchema.type, "object", "结果要带可调用的 Schema");

  const seat = await toolset.call(SEARCH_TOOL.name, { query: "座位 分馆", limit: 5 });
  assert.deepEqual(seat.data.tools.map(item => item.name), ["seat_libraries"], "预约类写工具不能出现在检索里");
  assert.equal(seat.data.total, 4, "总数只统计只读工具");

  const none = await toolset.call(SEARCH_TOOL.name, { query: "不存在的关键词" });
  assert.equal(none.ok, true);
  assert.equal(none.data.matched, 0);
  assert.match(none.data.hint, /工具页/);

  const empty = await toolset.call(SEARCH_TOOL.name, { query: "  " });
  assert.equal(empty.ok, false);
  assert.equal(empty.error.code, "INVALID_ARGUMENTS");
});

test("调用转发到真实 host，并拒绝写工具与未知工具", async () => {
  const calls = [];
  const toolset = createCompactToolset({ host: hostFixture(calls) });
  const ok = await toolset.call(CALL_TOOL.name, { name: "seat_libraries", arguments: {} });
  assert.equal(ok.ok, true);
  assert.deepEqual(calls, [{ name: "seat_libraries", args: {} }]);

  const write = await toolset.call(CALL_TOOL.name, { name: "seat_reserve", arguments: {} });
  assert.equal(write.ok, false);
  assert.equal(write.error.code, "WRITE_TOOL_REQUIRES_FULL_MODE");
  assert.match(write.error.message, /完整模式/);

  const unknown = await toolset.call(CALL_TOOL.name, { name: "no_such_tool" });
  assert.equal(unknown.error.code, "UNKNOWN_TOOL");

  const missing = await toolset.call(CALL_TOOL.name, {});
  assert.equal(missing.error.code, "INVALID_ARGUMENTS");

  const direct = await toolset.call("seat_libraries", {});
  assert.equal(direct.error.code, "UNKNOWN_TOOL", "只能经两个入口调用");
  assert.equal(calls.length, 1, "被拒绝的调用不应打到 host");
});

test("参数不是对象时按空对象处理，不会把字符串透传下去", async () => {
  const calls = [];
  const toolset = createCompactToolset({ host: hostFixture(calls) });
  await toolset.call(CALL_TOOL.name, { name: "learn_status", arguments: "not-an-object" });
  assert.deepEqual(calls, [{ name: "learn_status", args: {} }]);
});