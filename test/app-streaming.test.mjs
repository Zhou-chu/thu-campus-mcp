import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { runTurn } from "../lib/app/agent.mjs";
import { readSseEvents } from "../lib/app/sse.mjs";
import { createAppServer } from "../lib/app/server.mjs";
import { SessionStore } from "../lib/app/sessions.mjs";

function deferred() {
  let resolve;
  const promise = new Promise((settle) => { resolve = settle; });
  return { promise, resolve };
}
function controlled() {
  let controller;
  let ended = false;
  const cancelled = deferred();
  const body = new ReadableStream({
    start(c) { controller = c; },
    cancel(reason) { ended = true; cancelled.resolve(reason); },
  });
  return {
    body, cancelled,
    response: new Response(body, { headers: { "content-type": "text/event-stream" } }),
    write(data) { controller.enqueue(typeof data === "string" ? new TextEncoder().encode(data) : data); },
    close() { if (!ended) { ended = true; controller.close(); } },
    error() { if (!ended) { ended = true; controller.error(new Error("upstream disconnected")); } },
  };
}
const event = (delta, extra = {}) => `data: ${JSON.stringify({ choices: [{ delta, ...extra }] })}\n\n`;
const finalResponse = () => new Response(event({ content: "继续完成" }) + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });

async function httpFixture(t, route) {
  const dir = await mkdtemp(path.join(tmpdir(), "campus-streaming-"));
  const sessions = new SessionStore(dir);
  const saved = deferred();
  const append = sessions.append.bind(sessions);
  sessions.append = async (id, rows, ...rest) => {
    const result = await append(id, rows, ...rest);
    const interrupted = rows.find((row) => row.interrupted);
    if (interrupted) saved.resolve(interrupted);
    return result;
  };
  const calls = [];
  const app = createAppServer({
    config: { host: "127.0.0.1", port: 0, hostname: "localhost", stateDir: dir, token: "test", modelRoute: "madmodel", modelName: "stub" },
    host: { describe: () => [], toolForModel: () => [], call: async (...args) => { calls.push(args); return { ok: true, data: {} }; } },
    route, sessions, version: "test",
  });
  const url = await app.listen();
  t.after(async () => { await app.close(); await rm(dir, { recursive: true, force: true }); });
  const request = (pathname, body, signal) => fetch(url + pathname, {
    method: "POST", headers: { authorization: "Bearer test", "content-type": "application/json" },
    body: JSON.stringify(body), signal,
  });
  return { request, sessions, calls, saved };
}
function collect(response, events, onEvent = () => {}) {
  return (async () => {
    for await (const frame of readSseEvents(response.body)) {
      const item = { event: frame.event, data: JSON.parse(frame.data) };
      events.push(item);
      onEvent(item);
    }
  })();
}

test("HTTP增量在模型完成之前抵达，reasoning与最终文本无缓冲无丢尾", { timeout: 5000 }, async (t) => {
  const feed = controlled();
  const f = await httpFixture(t, { chat: async (body) => { assert.equal(body.stream, true); return feed.response; } });
  t.after(() => feed.close());
  const session = await f.sessions.create({});
  const response = await f.request("/api/chat", { text: "流式测试", sessionId: session.id });
  const reasoningSeen = deferred();
  const tokenSeen = deferred();
  const events = [];
  const reading = collect(response, events, (item) => {
    if (item.event === "reasoning") reasoningSeen.resolve();
    if (item.event === "token") tokenSeen.resolve();
  });
  feed.write(event({ reasoning_content: "公开推理首段" }));
  await reasoningSeen.promise;
  assert.deepEqual(events.map((e) => e.event), ["ready", "reasoning"]);
  assert.deepEqual((await f.sessions.get(session.id)).messages.map((m) => m.role), ["user"]);
  feed.write(event({ reasoning: "与别名尾段", content: "第一段正文" }));
  await tokenSeen.promise;
  assert.ok(!events.some((e) => e.event === "message" || e.event === "done"));
  // 用finish_reason结束，兼容不发送[DONE]但已明确完成的上游。
  feed.write(event({ content: "最后一帧中文。" }, { finish_reason: "stop" }));
  feed.close();
  await reading;
  assert.equal(events.filter((e) => e.event === "token").map((e) => e.data.text).join(""), "第一段正文最后一帧中文。");
  assert.equal(events.filter((e) => e.event === "reasoning").map((e) => e.data.text).join(""), "公开推理首段与别名尾段");
  assert.equal(events.at(-1).event, "done");
  const stored = (await f.sessions.get(session.id)).messages.at(-1);
  assert.equal(stored.content, "第一段正文最后一帧中文。");
  assert.equal(stored.reasoning, "公开推理首段与别名尾段");
  assert.equal(stored.interrupted, undefined);
  assert.deepEqual(events.find((e) => e.event === "message").data, stored);
});

for (const mode of ["error", "eof", "abort", "disconnect"]) {
  test(`HTTP流${mode}保留部分正文/公开推理，不存或执行半截工具调用`, { timeout: 5000 }, async (t) => {
    const feed = controlled();
    let turns = 0;
    let resumedMessages;
    const f = await httpFixture(t, { chat: async (body) => {
      if (++turns === 1) return feed.response;
      resumedMessages = body.messages;
      return finalResponse();
    } });
    t.after(() => feed.close());
    const session = await f.sessions.create({});
    const client = new AbortController();
    const response = await f.request("/api/chat", { text: "中断测试", sessionId: session.id }, client.signal);
    const seen = deferred();
    const events = [];
    const reading = collect(response, events, (item) => { if (item.event === "reasoning") seen.resolve(); });
    // 先装好拒绝处理器，客户端主动断开不能成为未处理的Promise拒绝。
    const finished = reading.catch((e) => { assert.equal(mode, "disconnect"); assert.equal(e.name, "AbortError"); });
    feed.write(event({ content: "已收到正文", reasoning_content: "已收到公开推理", tool_calls: [{ index: 0, id: "half", function: { name: "learn_status", arguments: "{\"unfinished\":" } }] }));
    await seen.promise;
    assert.ok(!events.some((e) => e.event === "message" || e.event === "done"));
    if (mode === "error") feed.error();
    else if (mode === "eof") feed.close();
    else if (mode === "abort") {
      const stopped = await f.request(`/api/chat/${session.id}/abort`, {});
      assert.equal((await stopped.json()).aborted, true);
    } else client.abort();
    const partial = await f.saved.promise;
    await finished;
    assert.equal(partial.content, "已收到正文");
    assert.equal(partial.reasoning, "已收到公开推理");
    assert.equal(partial.interrupted, true);
    assert.equal(partial.aborted, mode === "abort" || mode === "disconnect" ? true : undefined);
    assert.equal(Object.hasOwn(partial, "toolCalls"), false);
    assert.equal(f.calls.length, 0);
    if (mode !== "disconnect") {
      assert.deepEqual(events.find((e) => e.event === "message").data, partial);
      assert.equal(events.at(-1).event, "done");
      assert.equal(events.some((e) => e.event === "error"), mode === "error" || mode === "eof");
      if (mode === "abort") assert.equal(events.at(-1).data.aborted, true);
    }
    assert.deepEqual((await new SessionStore(path.dirname(f.sessions.dir)).get(session.id)).messages.at(-1), partial, "从磁盘重载也必须保留部分响应");
    const resumed = await f.request("/api/chat", { text: "继续", sessionId: session.id });
    assert.equal(resumed.status, 200, "结束后必须释放会话锁");
    await resumed.text();
    const history = resumedMessages.find((m) => m.role === "assistant");
    assert.equal(history.content, "已收到正文");
    assert.equal(Object.hasOwn(history, "tool_calls"), false);
  });
}

for (const fields of [
  { reasoning_content: "公开字段" },
  { reasoning: "公开别名" },
  { reasoning_content: "优先字段", reasoning: "不能重复" },
  { reasoning: { hidden: "对象不是公开文本" } },
]) {
  test(`JSON公开推理归一且仅接受文本：${JSON.stringify(fields)}`, async () => {
    const messages = [];
    const events = [];
    await runTurn({
      host: { describe: () => [], toolForModel: () => [] },
      store: { get: async () => ({ messages: [] }), append: async (_id, rows) => messages.push(...rows) },
      sessionId: "s", text: "测试", model: "stub", emit: (event, data) => events.push({ event, data }),
      route: { chat: async () => Response.json({ choices: [{ message: { content: "最终正文", ...fields } }] }) },
    });
    const expected = fields.reasoning_content || (typeof fields.reasoning === "string" ? fields.reasoning : undefined);
    assert.equal(messages.at(-1).reasoning, expected);
    assert.equal(events.find((e) => e.event === "message").data.reasoning, expected);
  });
}

test("停止时只有公开推理也保存，标准字段优先且不合并重复别名", async () => {
  const feed = controlled();
  const controller = new AbortController();
  const seen = deferred();
  const messages = [];
  const events = [];
  const running = runTurn({
    host: { describe: () => [], toolForModel: () => [] },
    store: { get: async () => ({ messages: [] }), append: async (_id, rows) => messages.push(...rows) },
    sessionId: "s", text: "测试", model: "stub", signal: controller.signal,
    emit: (event, data) => { events.push({ event, data }); if (event === "reasoning") seen.resolve(); },
    route: { chat: async () => feed.response },
  });
  feed.write(event({ reasoning_content: "只有公开推理", reasoning: "不应重复" }));
  await seen.promise;
  controller.abort();
  assert.equal((await running).aborted, true);
  assert.equal(messages.at(-1).content, "");
  assert.equal(messages.at(-1).reasoning, "只有公开推理");
  assert.equal(messages.at(-1).interrupted, true);
  assert.equal(messages.at(-1).aborted, true);
  assert.ok(!events.some((e) => e.event === "token" || e.event === "error"));
});

test("SSE解析兼容逐字节UTF8、CRLF、多行data与EOF末帧", async () => {
  const feed = controlled();
  const frames = [];
  const reading = (async () => { for await (const frame of readSseEvents(feed.body)) frames.push(frame); })();
  const bytes = new TextEncoder().encode(':注释\r\nevent: reasoning\r\ndata: {"text":\r\ndata: "中文"}\r\n\r\ndata: 最后一帧');
  for (const byte of bytes) feed.write(new Uint8Array([byte]));
  feed.close();
  await reading;
  assert.deepEqual(frames, [{ event: "reasoning", data: '{"text":\n"中文"}' }, { event: "message", data: "最后一帧" }]);
});

for (const alreadyAborted of [false, true]) {
  test(`SSE无下一块数据时signal可停止pending read，预先停止=${alreadyAborted}`, async () => {
    const feed = controlled();
    const controller = new AbortController();
    if (alreadyAborted) controller.abort();
    const iterator = readSseEvents(feed.body, { signal: controller.signal });
    const next = iterator.next();
    controller.abort();
    assert.equal((await next).done, true);
    await feed.cancelled.promise;
    assert.equal(feed.body.locked, false);
  });
}
