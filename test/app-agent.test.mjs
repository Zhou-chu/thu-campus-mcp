import { test } from "node:test";
import assert from "node:assert/strict";
import { runTurn, SYSTEM_PROMPT } from "../lib/app/agent.mjs";
import { createApprovals } from "../lib/app/approvals.mjs";

const toolCall = (id, name = "learn_status", args = "{}") => ({ id, type: "function", function: { name, arguments: args } });
const completion = (tool_calls = [], content = "", extra = {}) => Response.json({ choices: [{ message: { content, tool_calls, ...extra }, finish_reason: "stop" }], usage: { total_tokens: 7 } });
const stream = (events) => new Response(events.map((data) => `data: ${typeof data === "string" ? data : JSON.stringify(data)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
function fixture(overrides = {}) {
  const messages = [];
  const events = [];
  const calls = [];
  const store = { get: async () => ({ messages: [] }), append: async (_id, rows) => messages.push(...rows) };
  const host = {
    toolForModel: () => [],
    describe: () => [{ name: "write", destructive: true }],
    call: async (name, args) => { calls.push({ name, args }); return { ok: true, data: { ready: true } }; },
  };
  const options = { host, store, sessionId: "s", text: "检查", model: "fake", emit: (event, data) => events.push({ event, data }), ...overrides };
  return { options, events, messages, calls };
}

for (const legacy of [undefined, 12, 24, 1]) {
  test(`至少30轮工具迭代后由模型正常完成，旧maxSteps=${legacy}不截断`, async () => {
    let turns = 0;
    const f = fixture({ maxSteps: legacy, route: { chat: async (body) => {
      turns++;
      assert.equal(body.messages.filter((m) => m.role === "tool").length, Math.min(turns - 1, 30));
      return turns <= 30 ? completion([toolCall(`call-${turns}`)]) : completion([], "真正完成");
    } } });
    const result = await runTurn(f.options);
    assert.equal(turns, 31);
    assert.equal(f.calls.length, 30);
    assert.equal(result.steps, 31);
    assert.equal(result.aborted, false);
    assert.deepEqual(result.usage, { total_tokens: 7 });
    assert.equal(f.messages.at(-1).content, "真正完成");
    assert.ok(!f.events.some((e) => e.event === "notice" || e.event === "error"));
  });
}

test("超过12轮后停止，当前批次的后续工具和下一次模型均不执行", async () => {
  const controller = new AbortController();
  let turns = 0;
  const f = fixture({ signal: controller.signal, route: { chat: async () => completion([toolCall(`a-${++turns}`), toolCall(`b-${turns}`)]) } });
  f.options.host.call = async (name, args) => {
    f.calls.push({ name, args });
    if (turns === 15) controller.abort();
    return { ok: true, data: {} };
  };
  const result = await runTurn(f.options);
  assert.equal(result.aborted, true);
  assert.equal(result.steps, 15);
  assert.equal(f.calls.length, 29);
  assert.ok(!f.events.some((e) => e.event === "error"));
});

test("已停止的轮次不请求模型", async () => {
  const controller = new AbortController();
  controller.abort();
  const f = fixture({ signal: controller.signal, route: { chat: () => assert.fail("不应请求") } });
  assert.deepEqual(await runTurn(f.options), { sessionId: "s", steps: 0, usage: undefined, aborted: true });
});

for (const code of [undefined, "MODEL_UNAVAILABLE"]) {
  test(`真实模型调用错误退出且不重试：${code}`, async () => {
    let turns = 0;
    const f = fixture({ route: { chat: async () => { turns++; throw Object.assign(new Error("模型失败"), { code }); } } });
    assert.equal((await runTurn(f.options)).aborted, false);
    assert.equal(turns, 1);
    assert.equal(f.events[0].data.code, code || "MODEL_FAILED");
    assert.equal(f.messages.length, 1);
  });
}

test("模型请求被signal终止不误报模型失败", async () => {
  const controller = new AbortController();
  const f = fixture({ signal: controller.signal, route: { chat: async (_body, opts) => {
    assert.equal(opts.signal, controller.signal);
    controller.abort();
    throw new DOMException("stopped", "AbortError");
  } } });
  assert.equal((await runTurn(f.options)).aborted, true);
  assert.equal(f.events.length, 0);
});

for (const cancelled of [false, true]) {
  test(`流读取错误退出，signal取消=${cancelled}`, async () => {
    const controller = new AbortController();
    const f = fixture({ signal: controller.signal, route: { chat: async () => new Response(new ReadableStream({ pull(c) {
      if (cancelled) controller.abort();
      c.error(new Error("stream broken"));
    } }), { headers: { "content-type": "text/event-stream" } }) } });
    const result = await runTurn(f.options);
    assert.equal(result.aborted, cancelled);
    assert.equal(f.events.filter((e) => e.event === "error").length, cancelled ? 0 : 1);
    if (!cancelled) assert.equal(f.events[0].data.code, "MODEL_PROTOCOL");
    assert.equal(f.messages.length, 1);
  });
}

test("非预期响应与无效JSON是实际协议错误，不继续调用", async () => {
  for (const response of [new Response("html", { headers: { "content-type": "text/html" } }), new Response("{", { headers: { "content-type": "application/json" } })]) {
    const f = fixture({ route: { chat: async () => response } });
    assert.equal((await runTurn(f.options)).steps, 1);
    assert.equal(f.events[0].data.code, "MODEL_PROTOCOL");
  }
});

test("流式增量工具参数装配，历史消息转换，工具严格串行并回灌失败", async () => {
  let active = 0;
  let turns = 0;
  const f = fixture({ route: { chat: async (body) => {
    turns++;
    if (turns > 1) {
      assert.equal(body.messages.at(-1).role, "tool");
      return completion([], "完成");
    }
    assert.equal(body.messages[1].role, "tool");
    assert.equal(body.messages[2].tool_calls[0].function.arguments, "{}");
    return stream([
      ": ignored", "not-json", { usage: { total_tokens: 2 } },
      { choices: [{ delta: { content: "检查", reasoning_content: "推理", tool_calls: [{ index: 0, id: "x", function: { name: "learn_", arguments: "{\"v\":" } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { name: "status", arguments: "1}" } }, { index: 1, function: { name: "learn_status" } }] }, finish_reason: "tool_calls" }] },
      "[DONE]",
    ]);
  } } });
  f.options.store.get = async () => ({ messages: [{ role: "tool", toolCallId: "old", content: "{}" }, { role: "assistant", toolCalls: [{ id: "old", name: "learn_status" }] }, { role: "user", content: "过去" }] });
  f.options.host.call = async (name, args) => {
    assert.equal(active++, 0);
    await Promise.resolve();
    active--;
    f.calls.push({ name, args });
    return { ok: false, error: { code: "AUTH_REQUIRED", message: "登录" } };
  };
  await runTurn(f.options);
  assert.deepEqual(f.calls, [{ name: "learn_status", args: { v: 1 } }, { name: "learn_status", args: {} }]);
  assert.equal(f.messages[1].reasoning, "推理");
  assert.ok(f.events.some((e) => e.event === "reasoning"));
  assert.ok(f.events.some((e) => e.event === "token"));
  assert.ok(f.events.some((e) => e.event === "tool" && e.data.error?.code === "AUTH_REQUIRED"));
});

test("非法工具JSON回灌错误，非对象JSON仍归一为空参数", async () => {
  let turns = 0;
  const f = fixture({ route: { chat: async () => ++turns === 1 ? completion([toolCall("bad", "learn_status", "{"), toolCall("array", "learn_status", "[]"), toolCall("empty", "learn_status", "")]) : completion() } });
  await runTurn(f.options);
  assert.equal(f.calls.length, 2);
  assert.ok(f.events.some((e) => e.data.error?.code === "INVALID_ARGUMENTS"));
});

for (const decision of ["allow", "denied", "timeout", "aborted"]) {
  test(`写入审批继续保留：${decision}`, async () => {
    const approvals = createApprovals();
    const controller = new AbortController();
    let turns = 0;
    const f = fixture({ approvals, signal: controller.signal, route: { chat: async () => ++turns === 1 ? completion([toolCall("w", "write")]) : completion() } });
    f.options.emit = (event, data) => {
      f.events.push({ event, data });
      if (event !== "confirm") return;
      assert.equal(f.calls.length, 0);
      if (decision === "aborted") controller.abort();
      if (decision === "allow" || decision === "denied") approvals.decide(data.callId, decision === "allow");
      else approvals.cancel(data.callId, decision);
    };
    const result = await runTurn(f.options);
    assert.equal(f.calls.length, decision === "allow" ? 1 : 0);
    assert.equal(result.aborted, decision === "aborted");
    assert.equal(approvals.list().length, 0);
    if (decision === "denied" || decision === "timeout") assert.ok(f.events.some((e) => e.data.error?.code === (decision === "timeout" ? "APPROVAL_TIMEOUT" : "USER_DENIED")));
    if (decision === "aborted") assert.ok(!f.events.some((e) => e.data.error));
  });
}

test("缺失会话和真实工具异常退出，不吞错或重试", async () => {
  const missing = fixture({ store: { get: async () => null } });
  await assert.rejects(runTurn(missing.options), (e) => e.code === "SESSION_NOT_FOUND");
  const f = fixture({ route: { chat: async () => completion([toolCall("x")]) } });
  f.options.host.call = async () => { throw new Error("actual failure"); };
  await assert.rejects(runTurn(f.options), /actual failure/);
});

test("模型响应完成时已停止，不保存助手或执行工具", async () => {
  const controller = new AbortController();
  const f = fixture({ signal: controller.signal, route: { chat: async () => {
    const response = completion([toolCall("never")]);
    controller.abort();
    return response;
  } } });
  assert.equal((await runTurn(f.options)).aborted, true);
  assert.equal(f.calls.length, 0);
  assert.equal(f.messages.length, 1);
});

test("无法序列化的真实工具结果回灌明确占位，不导致循环异常", async () => {
  let turns = 0;
  const f = fixture({ route: { chat: async () => ++turns === 1 ? completion([toolCall("circular")]) : completion() } });
  const circular = {};
  circular.self = circular;
  f.options.host.call = async () => ({ ok: true, data: circular });
  assert.equal((await runTurn(f.options)).steps, 2);
  assert.match(f.messages.find((m) => m.role === "tool").content, /结果无法序列化/);
});

test("提示合理查询同步任务，不把状态轮询次数变成执行cap", () => {
  assert.match(SYSTEM_PROMPT, /learn_sync_status/);
  assert.match(SYSTEM_PROMPT, /不编造进度或结果/);
});
