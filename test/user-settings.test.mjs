import assert from "node:assert/strict";
import test from "node:test";
import { createUserSettings, mergeSettings } from "../lib/app/user-settings.mjs";
import { runWithUser } from "../lib/app/request-context.mjs";

function fakeStore() {
  const rows = new Map();
  return {
    rows,
    repos: {
      settings: {
        async list(userId) {
          return [...rows.entries()].filter(([key]) => key.startsWith(userId + ":")).map(([key, value]) => ({ key: key.slice(key.indexOf(":") + 1), value }));
        },
        async set(userId, key, value) { rows.set(userId + ":" + key, value); },
      },
    },
  };
}

test("设置合并只接受已知键，未登录读取默认值", async () => {
  assert.deepEqual(mergeSettings({ modelName: "a" }, [{ key: "modelName", value: "b" }, { key: "theme", value: "dark" }]), { modelName: "b" });
  assert.deepEqual(mergeSettings({ compactTools: true }, [{ key: "compactTools", value: false }]), { compactTools: false });
  const store = fakeStore();
  const settings = createUserSettings({ store, base: { modelName: "默认" } });
  assert.deepEqual(await settings.load(), { modelName: "默认" });
  assert.equal(await settings.save({ modelName: "x" }), false);
});

test("登录后按用户保存与读取设置，用户之间互不影响", async () => {
  const store = fakeStore();
  const settings = createUserSettings({ store, base: { modelName: "默认", compactTools: false } });
  await runWithUser("u1", async () => {
    assert.equal(await settings.save({ modelName: "我的模型", compactTools: true, reasoningEffort: "high" }), true);
    assert.deepEqual(await settings.load(), { modelName: "我的模型", compactTools: true, reasoningEffort: "high" });
  });
  await runWithUser("u2", async () => {
    assert.deepEqual(await settings.load(), { modelName: "默认", compactTools: false });
    assert.equal(await settings.save({ modelName: "别人的" }), true);
  });
  await runWithUser("u1", async () => {
    assert.equal((await settings.load()).modelName, "我的模型");
  });
  assert.equal(store.rows.size, 4);
});

test("未知键不会写入数据库", async () => {
  const store = fakeStore();
  const settings = createUserSettings({ store, base: {} });
  await runWithUser("u3", async () => {
    assert.equal(await settings.save({ theme: "dark", unrelated: 1 }), false);
    assert.equal(store.rows.size, 0);
  });
});