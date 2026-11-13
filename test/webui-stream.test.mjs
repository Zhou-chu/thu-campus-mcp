import { test } from "node:test";
import assert from "node:assert/strict";
import { readChatEvents } from "../webui/chat-stream.js";
const encode = text => new TextEncoder().encode(text);
const collect = async body => { const result = []; for await (const event of readChatEvents(body)) result.push(event); return result; };
const body = text => new Response(text).body;

test("正文首帧在响应未结束前到达", async () => {
  let control, cancelled = false;
  const stream = new ReadableStream({ start(c) { control = c; }, cancel() { cancelled = true; } });
  const events = readChatEvents(stream);
  control.enqueue(encode('event: token\ndata: {"text":"首段"}\n\n'));
  assert.deepEqual((await events.next()).value, { event: "token", payload: { text: "首段" } });
  control.enqueue(encode('event: done\ndata: {}\n\n'));
  control.close();
  assert.deepEqual((await events.next()).value, { event: "done", payload: {} });
  assert.equal((await events.next()).done, true);
  assert.equal(cancelled, false);
});

test("逐字节UTF8、CRLF、多行data与无空行EOF保持完整", async () => {
  const bytes = encode(': keepalive\r\nevent: reasoning\r\ndata: {"text":\r\ndata: "清华𠮷"}\r\n\r\nevent: done\r\ndata: {}');
  const stream = new ReadableStream({ start(c) { for (const byte of bytes) c.enqueue(new Uint8Array([byte])); c.close(); } });
  assert.deepEqual(await collect(stream), [
    { event: "reasoning", payload: { text: "清华𠮷" } }, { event: "done", payload: {} },
  ]);
});

test("忽略注释、坏JSON和非对象payload，默认事件仍保留", async () => {
  assert.deepEqual(await collect(body(': heartbeat\n\nevent: unused\n\ndata\n\ndata: bad\n\ndata: null\n\ndata: 1\n\ndata: []\n\nretry: 100\nid: ignored\ndata: {"text":"保留"}\n\n')),
    [{ event: "message", payload: { text: "保留" } }]);
  assert.deepEqual(await collect(null), []);
});

test("消费者提前退出取消底层读取", async () => {
  let cancelled = false;
  const stream = new ReadableStream({ start(c) { c.enqueue(encode('data: {}\n\n')); }, cancel() { cancelled = true; } });
  for await (const _event of readChatEvents(stream)) break;
  assert.equal(cancelled, true);
  assert.equal(stream.locked, false);
});

test("读取错误向调用者传播且释放reader", async () => {
  const stream = new ReadableStream({ start(c) { c.error(new Error("stream disconnected")); } });
  await assert.rejects(collect(stream), /stream disconnected/);
  assert.equal(stream.locked, false);
});
