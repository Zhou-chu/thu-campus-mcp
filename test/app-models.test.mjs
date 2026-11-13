import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createAppServer } from "../lib/app/server.mjs";
import { SessionStore } from "../lib/app/sessions.mjs";
import { MadModelClient } from "../lib/madmodel/client.mjs";
import { createModelRoute } from "../lib/app/model.mjs";

async function fixture(t, route) {
  const dir = await mkdtemp(path.join(tmpdir(), "campus-models-"));
  const sessions = new SessionStore(dir);
  const app = createAppServer({
    config: { host: "127.0.0.1", port: 0, hostname: "localhost", stateDir: dir, token: "test", modelRoute: "madmodel", modelName: "", maxSteps: 2 },
    host: { describe: () => [], toolForModel: () => [], call: async () => ({ ok: true, data: {} }) },
    route, sessions, version: "test",
  });
  const url = await app.listen();
  t.after(async () => { await app.close(); await rm(dir, { recursive: true, force: true }); });
  const request = (p, body, authenticated = true) => fetch(url + p, {
    method: body ? (p === "/api/settings" ? "PUT" : "POST") : "GET",
    headers: { ...(authenticated ? { authorization: "Bearer test" } : {}), "content-type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { app, request, sessions, dir };
}
const reply = () => new Response('data: {"choices":[{"delta":{"content":"收到"}}]}\n\ndata: [DONE]\n\n', { headers: { "content-type": "text/event-stream" } });

test("模型目录鉴权、完整列表与强制刷新参数", async (t) => {
  const options = [];
  const models = Array.from({ length: 20 }, (_, i) => ({ id: `model-${i}`, label: `模型${i}` }));
  const { request } = await fixture(t, { models: async (args) => { options.push(args); return models; } });
  assert.equal((await request("/api/models", null, false)).status, 401);
  const initial = await (await request("/api/models")).json();
  assert.deepEqual(initial.models, models);
  assert.equal(initial.current, "model-0");
  assert.deepEqual(options[0], { refresh: false, strict: true });
  await request("/api/models?refresh=1");
  assert.deepEqual(options[1], { refresh: true, strict: true });
});

test("模型目录失败明确返回502，不泄露上游详情", async (t) => {
  let fail = false;
  const { request } = await fixture(t, { models: async () => {
    if (fail) throw new Error("secret upstream detail");
    return [];
  } });
  for (const mode of [false, true]) {
    fail = mode;
    const response = await request("/api/models?refresh=1");
    assert.equal(response.status, 502);
    const data = await response.json();
    assert.equal(data.error.code, "MODEL_DISCOVERY_FAILED");
    assert.ok(!JSON.stringify(data).includes("secret"));
  }
});

test("保存的模型持久化且用于对话，单次请求可覆盖", async (t) => {
  const seen = [];
  const { request, dir } = await fixture(t, {
    models: async () => [{ id: "first", label: "首选" }, { id: "second", label: "第二个" }],
    chat: async (body) => { seen.push(body.model); return reply(); },
  });
  const save = await request("/api/settings", { modelName: "second" });
  assert.equal(save.status, 200);
  assert.equal(JSON.parse(await readFile(path.join(dir, "settings.json"), "utf8")).modelName, "second");
  assert.equal((await (await request("/api/models")).json()).current, "second");
  await (await request("/api/chat", { text: "测试默认模型" })).text();
  await (await request("/api/chat", { text: "测试指定模型", model: "first" })).text();
  assert.deepEqual(seen, ["second", "first"]);
  assert.equal((await (await request("/api/settings")).json()).settings.modelName, "second");
});

test("空目录不锁住会话，目录恢复后可重试", async (t) => {
  let recovered = false;
  const { request, sessions } = await fixture(t, {
    models: async () => recovered ? [{ id: "recovered" }] : [], chat: reply,
  });
  const session = await sessions.create({});
  assert.equal((await request("/api/chat", { sessionId: session.id, text: "第一次" })).status, 503);
  recovered = true;
  const retry = await request("/api/chat", { sessionId: session.id, text: "恢复后" });
  assert.equal(retry.status, 200);
  assert.match(await retry.text(), /收到/);
});

test("MadModel目录缓存可被显式刷新，刷新失败保留旧目录", async () => {
  let fetches = 0;
  let version = "A";
  const client = new MadModelClient({ manager: {}, config: {}, fetcher: async (url) => {
    fetches++;
    return new Response(url.endsWith("/")
      ? '<script src="/assets/index.js"></script>'
      : version === "broken" ? "bad catalog" : `const X={modelList:[{value:"${version}"}]}`);
  } });
  assert.equal((await client.models()).data[0].id, "A");
  version = "B";
  assert.equal((await client.models()).data[0].id, "A");
  assert.equal(fetches, 2);
  assert.equal((await client.models({ refresh: true })).data[0].id, "B");
  assert.equal(fetches, 4);
  version = "broken";
  await assert.rejects(client.models({ refresh: true }));
  assert.equal((await client.models()).data[0].id, "B");
});

test("MadModel completion保留stream:true并原样返回未消费Response", async () => {
  const controller = new AbortController();
  let streamController;
  const response = new Response(new ReadableStream({ start(c) { streamController = c; } }), { headers: { "content-type": "text/event-stream" } });
  const body = { model: "stub", messages: [{ role: "user", content: "测试" }], stream: true };
  const client = new MadModelClient({
    config: { timeoutMs: 5000 },
    manager: { ensure: async ({ signal }) => { assert.equal(signal.aborted, false); return { token: "mock-only" }; } },
    fetcher: async (_url, options) => {
      assert.deepEqual(JSON.parse(options.body), body);
      assert.equal(options.signal.aborted, false);
      return response;
    },
  });
  const returned = await client.completion(body, { signal: controller.signal });
  assert.equal(returned, response);
  assert.equal(returned.bodyUsed, false, "客户端不得预读或缓冲流");
  streamController.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
  streamController.close();
  assert.equal(await returned.text(), "data: [DONE]\n\n");
});

for (const modelRoute of ["madmodel", "openai"]) {
  test(`应用${modelRoute}路由原样透传Response、stream与signal`, async (t) => {
    const response = reply();
    const body = { model: "stub", messages: [{ role: "user", content: "测试" }], stream: true };
    const controller = new AbortController();
    if (modelRoute === "madmodel") {
      t.mock.method(MadModelClient.prototype, "completion", async (passed, options) => {
        assert.deepEqual(passed, body);
        assert.equal(options.signal, controller.signal);
        return response;
      });
    } else {
      t.mock.method(globalThis, "fetch", async (url, options) => {
        assert.equal(url, "https://mock.invalid/v1/chat/completions");
        assert.deepEqual(JSON.parse(options.body), body);
        assert.equal(options.signal, controller.signal);
        return response;
      });
    }
    const route = createModelRoute({ modelRoute, modelBaseUrl: "https://mock.invalid/v1" });
    const returned = await route.chat(body, { signal: controller.signal });
    assert.equal(returned, response);
    assert.equal(returned.bodyUsed, false);
    await returned.body.cancel();
  });
}
