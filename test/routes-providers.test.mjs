import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ProviderStore } from "../lib/app/providers.mjs";
import { createProviderRoutes } from "../lib/app/routes/providers.mjs";
import { createModelRoute } from "../lib/app/model.mjs";

function response() {
  const state = { status: 0, body: undefined };
  const res = {
    writableEnded: false,
    writeHead(status) { state.status = status; },
    end(payload) { state.body = payload ? JSON.parse(payload) : undefined; res.writableEnded = true; },
  };
  return { res, state };
}

const request = body => ({ method: "POST", body });

async function call(handler, { method = "GET", pathname, body }) {
  const { res, state } = response();
  const handled = await handler(request(body), res, { pathname, method, url: new URL(pathname, "http://127.0.0.1") });
  return { handled, status: state.status, body: state.body };
}

async function withStore(run) {
  const dir = await mkdtemp(path.join(tmpdir(), "providers-routes-"));
  try {
    const store = await new ProviderStore(dir).load();
    const bodies = [];
    const handler = createProviderRoutes({ store, readBody: async () => bodies.shift() || {} });
    return await run({ store, handler, dir, bodies });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("提供商路由：创建、列表、启用、更新与删除", async () => {
  await withStore(async ({ handler, bodies, store }) => {
    const empty = await call(handler, { pathname: "/api/providers" });
    assert.deepEqual(empty.body.providers, []);
    assert.equal(empty.body.activeId, "");

    bodies.push({ name: "深度求索", kind: "openai", baseUrl: "https://api.deepseek.com/v1", apiKey: "sk-deepseek-1234" });
    const created = await call(handler, { method: "POST", pathname: "/api/providers" });
    assert.equal(created.status, 200);
    const id = created.body.provider.id;
    assert.equal(created.body.provider.masked, "sk-d****1234");
    assert.equal(store.state.activeId, id);

    bodies.push({ name: "" });
    const invalid = await call(handler, { method: "POST", pathname: "/api/providers" });
    assert.equal(invalid.status, 400);
    assert.equal(invalid.body.error.code, "INVALID_ARGUMENTS");

    bodies.push({ id });
    const active = await call(handler, { method: "PUT", pathname: "/api/providers/active" });
    assert.equal(active.body.activeId, id);

    bodies.push({ id: "00000000-0000-4000-8000-000000000000" });
    const missingActive = await call(handler, { method: "PUT", pathname: "/api/providers/active" });
    assert.equal(missingActive.status, 404);

    bodies.push({ name: "改名后" });
    const patched = await call(handler, { method: "PATCH", pathname: "/api/providers/" + id });
    assert.equal(patched.body.provider.name, "改名后");

    const notFound = await call(handler, { method: "PATCH", pathname: "/api/providers/00000000-0000-4000-8000-000000000000" });
    assert.equal(notFound.status, 404);

    const removed = await call(handler, { method: "DELETE", pathname: "/api/providers/" + id });
    assert.equal(removed.body.removed, id);
    assert.equal(removed.body.activeId, "");

    const other = await handler(request({}), response().res, { pathname: "/api/providers/x", method: "GET", url: new URL("http://x/api/providers/x") });
    assert.equal(other, false);
  });
});

test("提供商路由：连接测试与模型导入都走真实上游", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async url => {
    assert.match(String(url), /\/models$/);
    return Response.json({ data: [{ id: "qwen3" }, { id: "qwen2.5" }] });
  };
  try {
    await withStore(async ({ handler, bodies, store }) => {
      bodies.push({ name: "本地", kind: "openai", baseUrl: "https://api.example.com/v1", apiKey: "k-12345678" });
      const created = (await call(handler, { method: "POST", pathname: "/api/providers" })).body.provider;

      const tested = await call(handler, { method: "POST", pathname: `/api/providers/${created.id}/test` });
      assert.equal(tested.body.count, 2);
      assert.deepEqual(tested.body.models, ["qwen3", "qwen2.5"]);

      const imported = await call(handler, { method: "POST", pathname: `/api/providers/${created.id}/models` });
      assert.deepEqual(imported.body.models, ["qwen3", "qwen2.5"]);
      assert.deepEqual(store.get(created.id).models, ["qwen3", "qwen2.5"]);

      globalThis.fetch = async () => new Response("no", { status: 401 });
      const denied = await call(handler, { method: "POST", pathname: `/api/providers/${created.id}/test` });
      assert.equal(denied.status, 400);
      assert.equal(denied.body.error.code, "PROVIDER_AUTH_FAILED");
    });
  } finally {
    globalThis.fetch = original;
  }
});

test("模型路由按启用的提供商切换协议，停用后回到默认路由", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "providers-route-"));
  try {
    const store = await new ProviderStore(dir).load();
    const route = createModelRoute({ modelRoute: "madmodel" }, { providerStore: store });
    assert.equal(route.route, "madmodel");
    assert.equal((await route.status()).provider, undefined);

    const openai = await store.create({ name: "O", kind: "openai", baseUrl: "https://o.example/v1", apiKey: "k1", models: ["m1"], model: "m1" });
    assert.equal(route.route, "openai");
    assert.equal((await route.status()).providerId, openai.id);

    const anthropic = await store.create({ name: "A", kind: "anthropic", baseUrl: "https://a.example/v1", apiKey: "k2", model: "claude-x" });
    await store.setActive(anthropic.id);
    assert.equal(route.route, "anthropic");
    const status = await route.status();
    assert.equal(status.provider, "A");
    assert.equal(status.model, "claude-x");

    await store.setActive("");
    assert.equal(route.route, "madmodel");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("提供商路由切换后，chat 会把提供商默认模型补进请求", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "providers-chat-"));
  const original = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (url, options = {}) => {
    seen.push({ url: String(url), body: options.body ? JSON.parse(options.body) : null, headers: options.headers });
    return new Response(`event: message_start\ndata: {}\n\nevent: content_block_delta\ndata: ${JSON.stringify({ index: 0, delta: { type: "text_delta", text: "ok" } })}\n\nevent: message_delta\ndata: ${JSON.stringify({ delta: { stop_reason: "end_turn" } })}\n\n`);
  };
  try {
    const store = await new ProviderStore(dir).load();
    const route = createModelRoute({ modelRoute: "madmodel" }, { providerStore: store });
    await store.create({ name: "Claude", kind: "anthropic", baseUrl: "https://a.example/v1", apiKey: "k2", model: "claude-x" });
    const response = await route.chat({ messages: [{ role: "user", content: "hi" }] });
    const text = await response.text();
    assert.match(text, /ok/);
    assert.equal(seen[0].url, "https://a.example/v1/messages");
    assert.equal(seen[0].body.model, "claude-x");
    assert.equal(seen[0].headers["x-api-key"], "k2");
  } finally {
    globalThis.fetch = original;
    await rm(dir, { recursive: true, force: true });
  }
});