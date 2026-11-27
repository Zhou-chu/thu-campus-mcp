import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DeviceStore } from "../lib/app/devices.mjs";

const dir = async t => {
  const value = await mkdtemp(path.join(tmpdir(), "devices-"));
  t.after(() => rm(value, { recursive: true, force: true }));
  return value;
};
const store = value => new DeviceStore(value, { encrypt: async buffer => buffer });

test("设备身份：同名同平台但不同 deviceKey 各自保留，不互相顶掉", async t => {
  const value = await dir(t);
  const devices = store(value);
  const first = await devices.issue({ name: "Win32", platform: "webui", deviceKey: "machine-a-key" });
  const second = await devices.issue({ name: "Win32", platform: "webui", deviceKey: "machine-b-key" });
  assert.notEqual(first.token, second.token);
  const list = await devices.list();
  assert.equal(list.length, 2, "两台机器都应保留");
  assert.equal(await devices.verify(first.token) !== null, true);
  assert.equal(await devices.verify(second.token) !== null, true);
});

test("设备身份：同一 deviceKey 重新登录只轮换自己的令牌", async t => {
  const value = await dir(t);
  const devices = store(value);
  const first = await devices.issue({ name: "Win32", platform: "webui", deviceKey: "machine-a-key" });
  const other = await devices.issue({ name: "Win32", platform: "webui", deviceKey: "machine-b-key" });
  const rotated = await devices.issue({ name: "Win32", platform: "webui", deviceKey: "machine-a-key" });
  const list = await devices.list();
  assert.equal(list.length, 2, "只替换同一个 key");
  assert.equal(await devices.verify(first.token), null, "旧令牌失效");
  assert.notEqual(await devices.verify(rotated.token), null);
  assert.notEqual(await devices.verify(other.token), null, "另一台不受影响");
});

test("设备身份：旧客户端没有 deviceKey 时仍按名称+平台去重", async t => {
  const value = await dir(t);
  const devices = store(value);
  const first = await devices.issue({ name: "老设备", platform: "webui" });
  const second = await devices.issue({ name: "老设备", platform: "webui" });
  assert.equal((await devices.list()).length, 1, "无 key 保持旧行为");
  assert.equal(await devices.verify(first.token), null);
  assert.notEqual(await devices.verify(second.token), null);
});
