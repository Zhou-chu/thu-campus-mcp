import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ProviderError, ProviderStore, fetchProviderModels, maskKey, normalizeProvider } from "../lib/app/providers.mjs";

test("提供商配置校验与密钥掩码", () => {
  assert.equal(maskKey("sk-abcdefghijklmn"), "sk-a****klmn");
  assert.equal(maskKey("short"), "****");
  assert.equal(maskKey(""), "");
  const openai = normalizeProvider({ name: "深度求索", kind: "openai", baseUrl: "https://api.deepseek.com/v1/", apiKey: "sk-x" });
  assert.equal(openai.baseUrl, "https://api.deepseek.com/v1");
  assert.equal(openai.model, "gpt-4.1-mini", "没给模型时用协议默认值");
  for (const bad of [
    { name: "", kind: "openai", baseUrl: "https://x", apiKey: "k" },
    { name: "x", kind: "gemini", baseUrl: "https://x", apiKey: "k" },
    { name: "x", kind: "openai", baseUrl: "ftp://x", apiKey: "k" },
    { name: "x", kind: "openai", baseUrl: "https://x", apiKey: "" },
  ]) {
    assert.throws(() => normalizeProvider(bad), (error) => error instanceof ProviderError && error.code === "INVALID_ARGUMENTS", JSON.stringify(bad));
  }
});

test("提供商持久化：增改删、启用切换与模型写回", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "providers-"));
  try {
    const store = new ProviderStore(dir);
    const created = await store.create({ name: "本地 vLLM", kind: "openai", baseUrl: "http://127.0.0.1:8000/v1", apiKey: "k-12345678", models: ["qwen3", "qwen3"] });
    assert.equal(created.hasKey, true);
    assert.equal(created.apiKey, undefined, "接口不返回明文密钥");
    assert.deepEqual(created.models, ["qwen3"]);
    assert.equal(store.active().id, created.id, "第一个提供商自动启用");

    const second = await store.create({ name: "Claude", kind: "anthropic", baseUrl: "https://api.anthropic.com/v1", apiKey: "sk-ant-123456" });
    assert.equal(store.active().id, created.id, "新增不抢占启用状态");
    await store.setActive(second.id);
    assert.equal(store.active().name, "Claude");
    await store.setActive("");
    assert.equal(store.active(), null);

    const updated = await store.update(created.id, { name: "本地 vLLM 2" });
    assert.equal(updated.name, "本地 vLLM 2");
    assert.equal((await store.update(created.id, { apiKey: "" })).masked !== "", true, "留空沿用旧密钥");

    await store.setModels(created.id, ["qwen3", "qwen2.5"]);
    const reopened = await new ProviderStore(dir).load();
    assert.deepEqual(reopened.get(created.id).models, ["qwen3", "qwen2.5"]);

    const saved = JSON.parse(await readFile(path.join(dir, "model-providers.json"), "utf8"));
    assert.equal(saved.activeId, "");
    assert.equal(saved.providers.length, 2);

    await assert.rejects(() => store.create({ name: "本地 vLLM 2", kind: "openai", baseUrl: "https://x", apiKey: "k" }), /同名/);
    assert.equal(await store.remove("missing"), false);
    assert.equal(await store.remove(second.id), true);
    await assert.rejects(() => store.setActive("missing"), /不存在/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("导入模型列表：两类协议都按真实响应解析，错误带代码", async () => {
  const openai = { kind: "openai", baseUrl: "https://api.example.com/v1", apiKey: "k" };
  const models = await fetchProviderModels(openai, {
    fetchImpl: async (url, options) => {
      assert.equal(url, "https://api.example.com/v1/models");
      assert.equal(options.headers.authorization, "Bearer k");
      return Response.json({ data: [{ id: "gpt-4.1" }, { id: "o4-mini" }] });
    },
  });
  assert.deepEqual(models, ["gpt-4.1", "o4-mini"]);

  const anthropic = { kind: "anthropic", baseUrl: "https://api.anthropic.com/v1", apiKey: "sk-ant" };
  const claude = await fetchProviderModels(anthropic, {
    fetchImpl: async (url, options) => {
      assert.match(url, /\/v1\/models\?limit=100$/);
      assert.equal(options.headers["x-api-key"], "sk-ant");
      assert.equal(options.headers["anthropic-version"], "2023-06-01");
      return Response.json({ data: [{ id: "claude-sonnet-4-5" }] });
    },
  });
  assert.deepEqual(claude, ["claude-sonnet-4-5"]);

  for (const [fn, code] of [
    [async () => { throw new TypeError("network"); }, "PROVIDER_UNREACHABLE"],
    [async () => new Response("no", { status: 401 }), "PROVIDER_AUTH_FAILED"],
    [async () => new Response("boom", { status: 500 }), "PROVIDER_MODELS_FAILED"],
    [async () => Response.json({ data: [] }), "PROVIDER_MODELS_EMPTY"],
  ]) {
    await assert.rejects(() => fetchProviderModels({ ...openai }, { fetchImpl: fn }), error => error.code === code, code);
  }
});