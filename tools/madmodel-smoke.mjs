// Explicit live smoke test: sends two small generation requests to the local service.
import assert from "node:assert/strict";
const base = process.env.MADMODEL_SMOKE_BASE_URL || "http://127.0.0.1:8765";
const headers = { "Content-Type": "application/json" };
if (process.env.MADMODEL_API_KEY)
  headers.Authorization = "Bearer " + process.env.MADMODEL_API_KEY;
const get = async (path) => {
  const response = await fetch(base + path, {
    headers,
    signal: AbortSignal.timeout(15000),
  });
  assert.equal(response.status, 200);
  return response.json();
};
const health = await get("/health");
assert.equal(health.status, "ok");
const models = await get("/v1/models");
assert(models.data.length);
const model = process.env.MADMODEL_SMOKE_MODEL || models.data[0].id;
const send = async (stream, expected) => {
  const response = await fetch(base + "/v1/chat/completions", {
    method: "POST",
    headers,
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content: "Reply with exactly: " + expected }],
      max_tokens: 48,
      chat_template_kwargs: { thinking: false },
      stream,
    }),
    signal: AbortSignal.timeout(180000),
  });
  assert.equal(response.status, 200);
  if (!stream) {
    const result = await response.json();
    assert.equal(result.object, "chat.completion");
    assert.equal(result.choices[0].message.content.trim(), expected);
    return { stream: false, content: expected };
  }
  assert.match(response.headers.get("content-type"), /text\/event-stream/);
  const text = await response.text();
  assert.match(text, /data: \[DONE\]/);
  const content = text
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:") && !line.includes("[DONE]"))
    .map((line) => JSON.parse(line.slice(5).trim()))
    .map((chunk) => chunk.choices?.[0]?.delta?.content || "")
    .join("");
  assert.equal(content.trim(), expected);
  return { stream: true, content: expected, done: true };
};
console.log(
  JSON.stringify({
    health: "ok",
    models: models.data.map((m) => m.id),
    results: [
      await send(false, "MADMODEL_JSON_OK"),
      await send(true, "MADMODEL_STREAM_OK"),
    ],
  }),
);
