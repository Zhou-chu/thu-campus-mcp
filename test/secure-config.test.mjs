import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createSecureConfig } from "../lib/app/secure-config.mjs";
import { ProviderStore } from "../lib/app/providers.mjs";
import { loadGitlabConfig, saveGitlabConfig } from "../lib/gitlab/client.mjs";

function fakeStore(rows = new Map()) {
  return {
    rows,
    repos: {
      config: {
        async get(key) { return rows.get(key) || null; },
        async put(key, value) { rows.set(key, value); },
        async remove(key) { return rows.delete(key); },
      },
    },
  };
}

test("加密配置：写入后只有密文，能按名称读回", async t => {
  const dir = await mkdtemp(path.join(tmpdir(), "campus-secure-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = fakeStore();
  const secure = createSecureConfig({ store, stateDir: dir });
  assert.equal(await secure.put("demo", { token: "secret-token" }), true);
  const row = store.rows.get("demo");
  assert.ok(row.ciphertext && row.nonce);
  assert.equal(row.ciphertext.includes("secret-token"), false);
  assert.deepEqual(await secure.get("demo"), { token: "secret-token" });
  assert.equal(await secure.get("missing"), null);
  assert.equal(await secure.remove("demo"), true);
  assert.equal(await secure.get("demo"), null);
});

test("加密配置：没有数据库时明确返回未写入", async () => {
  const secure = createSecureConfig({ store: null, stateDir: tmpdir() });
  assert.equal(await secure.put("demo", { a: 1 }), false);
  assert.equal(await secure.get("demo"), null);
});

test("模型提供商保存后镜像到加密配置", async t => {
  const dir = await mkdtemp(path.join(tmpdir(), "campus-provider-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  let saved = null;
  const store = new ProviderStore(dir, { persist: async state => { saved = state; } });
  await store.create({ kind: "openai", name: "镜像", baseUrl: "https://api.example.com/v1", apiKey: "sk-mirror" });
  assert.equal(saved.providers.length, 1);
  assert.equal(saved.providers[0].apiKey, "sk-mirror", "镜像保留完整密钥供其他设备读取");
  assert.equal(store.list()[0].masked.includes("sk-mirror"), false, "接口列表仍是掩码");
});

test("GitLab 配置走加密存储，读回不再依赖文件", async () => {
  const store = fakeStore();
  const secure = createSecureConfig({ store, stateDir: tmpdir() });
  const saved = await saveGitlabConfig({ baseUrl: "https://git.tsinghua.edu.cn", token: "glpat-secret" }, { secure });
  assert.equal(saved.configured, true);
  assert.equal(saved.source, "db");
  assert.equal(store.rows.get("gitlab").ciphertext.includes("glpat-secret"), false);
  const loaded = await loadGitlabConfig({ secure });
  assert.equal(loaded.token, "glpat-secret");
  assert.equal(loaded.baseUrl, "https://git.tsinghua.edu.cn");
  assert.equal(loaded.source, "db");
});