import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { decryptCredential, encryptCredential, loadCredentialKey } from "../lib/app/credential-cipher.mjs";
import { createAccountSync } from "../lib/app/account-sync.mjs";

test("凭据加密：AES-GCM 往返、篡改被拒、密钥文件自动生成", async t => {
  const dir = await mkdtemp(path.join(tmpdir(), "campus-cred-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const key = await loadCredentialKey(dir);
  assert.equal(key.length, 32);
  const file = await readFile(path.join(dir, "credential.key"), "utf8");
  assert.equal(Buffer.from(file.trim(), "base64").length, 32, "密钥落盘为 base64");
  const sealed = encryptCredential(key, { username: "2024****19", password: "secret" });
  assert.equal(sealed.ciphertext.includes("secret"), false);
  assert.deepEqual(decryptCredential(key, sealed), { username: "2024****19", password: "secret" });
  const tampered = { ...sealed, ciphertext: Buffer.from("broken").toString("base64") };
  assert.throws(() => decryptCredential(key, tampered));
  const wrongKey = Buffer.alloc(32, 1);
  assert.throws(() => decryptCredential(wrongKey, sealed));
});

function fakeStore() {
  const rows = new Map();
  return {
    rows,
    repos: {
      users: { async listAll() { return [{ id: "u1" }]; } },
      credentials: {
        async get(userId, service) { return rows.get(userId + ":" + service) || null; },
        async put({ userId, service, ciphertext, nonce }) { rows.set(userId + ":" + service, { ciphertext, nonce }); },
        async remove(userId, service) { return rows.delete(userId + ":" + service); },
      },
    },
  };
}

function fakeLocal(initial = null) {
  let account = initial;
  return {
    load: async () => account,
    save: async value => { account = value; },
    clear: async () => { account = null; },
    current: () => account,
  };
}

test("账号同步：库里有账号时登录回写本机，本机有账号时首次登录收进库", async t => {
  const dir = await mkdtemp(path.join(tmpdir(), "campus-account-sync-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = fakeStore();
  const local = fakeLocal({ username: "2024****19", password: "old" });
  const sync = createAccountSync({ store, stateDir: dir, load: local.load, save: local.save, clear: local.clear });
  const secret = { username: "2024****19", password: "old" };

  assert.deepEqual(await sync.syncOnLogin("u1"), { action: "imported" }, "首次登录导入本机账号");
  assert.equal(store.rows.size, 1);
  assert.deepEqual(await sync.loadForUser("u1"), secret);

  local.save({ username: "changed", password: "x" });
  assert.deepEqual(await sync.syncOnLogin("u1"), { action: "restored" }, "之后登录以库为准回写");
  assert.deepEqual(local.current(), secret);

  assert.equal(await sync.clearForUser("u1"), true);
  assert.equal(await sync.loadForUser("u1"), null);
  assert.deepEqual(await sync.syncOnLogin("u2"), { action: "none" }, "两边都没有账号时什么也不做");
});

test("没有数据库或没有用户时不写库，账号接口保持本机行为", async t => {
  const dir = await mkdtemp(path.join(tmpdir(), "campus-account-sync2-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const local = fakeLocal({ username: "a", password: "b" });
  const sync = createAccountSync({ store: null, stateDir: dir, load: local.load, save: local.save, clear: local.clear });
  assert.equal(await sync.saveForUser("u1", { username: "a", password: "b" }), false);
  assert.deepEqual(await sync.syncOnLogin("u1"), { action: "skipped" });
});