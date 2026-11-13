import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { appConfig, maskAccount, lanUrls, publicBase, loginCapability } from "../lib/app/settings.mjs";
import { DeviceStore, newToken } from "../lib/app/devices.mjs";
import { PairingCodes, PairingError } from "../lib/app/pairing.mjs";
import { SessionStore } from "../lib/app/sessions.mjs";
import { readSseEvents } from "../lib/app/sse.mjs";
async function temp(t) {
  const dir = await mkdtemp(path.join(tmpdir(), "campus-app-unit-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}
test("配置默认只监听回环，非回环无固定令牌时拒绝启动", () => {
  const base = appConfig({});
  assert.equal(base.host, "127.0.0.1");
  assert.equal(base.port, 8971);
  assert.equal(base.modelRoute, "madmodel");
  assert.equal(Object.hasOwn(base, "maxSteps"), false);
  assert.match(base.stateDir, /\.thu-campus-mcp[\\/]app$/);
  assert.throws(
    () => appConfig({ THU_CAMPUS_APP_HOST: "0.0.0.0" }),
    (e) => e.code === "INSECURE_LISTEN",
  );
  const open = appConfig({ THU_CAMPUS_APP_HOST: "0.0.0.0", THU_CAMPUS_APP_TOKEN: "x" });
  assert.equal(open.host, "0.0.0.0");
  assert.throws(
    () => appConfig({ THU_CAMPUS_APP_PORT: "70000" }),
    (e) => e.code === "INVALID_SETTINGS",
  );
  assert.throws(
    () => appConfig({ THU_CAMPUS_APP_MODEL_ROUTE: "bedrock" }),
    (e) => e.code === "INVALID_SETTINGS",
  );
  for (const legacy of ["12", "24", "0", "invalid"]) {
    const config = appConfig({ THU_CAMPUS_APP_MAX_STEPS: legacy });
    assert.equal(Object.hasOwn(config, "maxSteps"), false, `旧环境变量 ${legacy} 必须被忽略`);
  }
  assert.deepEqual(lanUrls(8971), lanUrls(8971));
});
test("账号脱敏保留首尾并隐藏中间", () => {
  assert.equal(maskAccount("2023012345"), "2023**2345");
  assert.equal(maskAccount("12345"), "1***5");
  assert.equal(maskAccount(""), "");
  assert.equal(maskAccount(undefined), "");
});
test("配对码一次性、可过期、失败过多时锁定", () => {
  let now = 1000;
  const pairing = new PairingCodes({ now: () => now });
  const issued = pairing.issue();
  assert.match(issued.code, /^\d{6}$/);
  assert.equal(issued.ttlSeconds, 300);
  assert.equal(pairing.consume(issued.code), true);
  assert.throws(
    () => pairing.consume(issued.code),
    (e) => e instanceof PairingError && e.code === "PAIRING_EXPIRED",
  );
  const shortLived = pairing.issue();
  now += 300001;
  assert.throws(
    () => pairing.consume(shortLived.code),
    (e) => e.code === "PAIRING_EXPIRED",
  );
  assert.throws(
    () => pairing.consume("abc"),
    (e) => e.code === "PAIRING_INVALID",
  );
  // 每次错误尝试都会记一次失败并抛错；超过上限后连正确码也拒绝。
  let locked = false;
  for (let i = 0; i < 40 && !locked; i += 1) {
    try {
      pairing.consume("000000");
    } catch (e) {
      if (e.code === "PAIRING_LOCKED") locked = true;
      else assert.equal(e.code, "PAIRING_EXPIRED");
    }
  }
  assert.equal(locked, true, "连续失败后必须锁定配对");
  assert.throws(
    () => pairing.consume(pairing.issue().code),
    (e) => e.code === "PAIRING_LOCKED",
  );
});
test("设备令牌只存摘要，撤销后立即失效", async (t) => {
  const dir = await temp(t);
  const identity = async (buffer) => buffer;
  const store = new DeviceStore(dir, { encrypt: identity });
  const issued = await store.issue({ name: "测试机", platform: "android" });
  assert.match(issued.token, /^tc1_[A-Za-z0-9_-]{40,}$/);
  assert.equal((await store.verify(issued.token)).name, "测试机");
  assert.equal(await store.verify(newToken()), null);
  assert.equal(await store.verify(""), null);
  const raw = await readFile(path.join(dir, "devices.dpapi"), "utf8");
  assert.ok(!raw.includes(issued.token), "磁盘不能出现明文令牌");
  assert.equal(await store.revoke(issued.id), true);
  assert.equal(await store.verify(issued.token), null);
  assert.equal(await store.revoke(issued.id), false);
  assert.deepEqual(await store.list(), []);
});
test("同名同平台再次配对替换旧记录而不是无限堆积", async (t) => {
  const dir = await temp(t);
  const store = new DeviceStore(dir, { encrypt: async (b) => b });
  const first = await store.issue({ name: "我的手机", platform: "android" });
  const second = await store.issue({ name: "我的手机", platform: "android" });
  assert.equal((await store.list()).length, 1);
  assert.equal(await store.verify(first.token), null);
  assert.ok(await store.verify(second.token));
});
test("会话落盘支持追加、摘要、删除并拒绝非法 ID", async (t) => {
  const dir = await temp(t);
  const store = new SessionStore(dir);
  const created = await store.create({});
  assert.equal(created.messageCount, 0);
  assert.equal(created.title, "新对话");
  await store.append(created.id, [{ role: "user", content: "你好", at: "t" }], {
    title: "你好",
  });
  const loaded = await store.get(created.id);
  assert.equal(loaded.messages.length, 1);
  assert.equal(loaded.title, "你好");
  const listed = await store.list();
  assert.equal(listed.length, 1);
  assert.equal(listed[0].messageCount, 1);
  await assert.rejects(() => store.get("../../etc/passwd"), (e) => e.code === "INVALID_SESSION");
  assert.equal(await store.remove(created.id), true);
  assert.equal(await store.remove(created.id), false);
  assert.deepEqual(await store.list(), []);
});
function streamOf(chunks) {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}
test("SSE 解析处理跨 chunk 半行、CRLF 与多行 data", async () => {
  const events = [];
  for await (const event of readSseEvents(
    streamOf(["event: token\nda", "ta: {\"a\":1}\n\n", "data: 第一行\r\ndata: 第二行\r\n\r\n", "data: [DONE]\n\n"]),
  ))
    events.push(event);
  assert.deepEqual(events, [
    { event: "token", data: "{\"a\":1}" },
    { event: "message", data: "第一行\n第二行" },
    { event: "message", data: "[DONE]" },
  ]);
});
test("SSE 解析忽略注释行并容忍结尾没有空行", async () => {
  const events = [];
  for await (const event of readSseEvents(streamOf([": keep-alive\n\n", "data: 末尾"])))
    events.push(event);
  assert.deepEqual(events, [{ event: "message", data: "末尾" }]);
});
test("托管模式配置：显式放开远程，TLS 证书必须成对", () => {
  assert.throws(
    () => appConfig({ THU_CAMPUS_APP_HOST: "0.0.0.0" }),
    (e) => e.code === "INSECURE_LISTEN",
  );
  const remote = appConfig({ THU_CAMPUS_APP_HOST: "0.0.0.0", THU_CAMPUS_APP_ALLOW_REMOTE: "1" });
  assert.equal(remote.allowRemote, true);
  assert.equal(remote.token, "");
  assert.throws(
    () => appConfig({ THU_CAMPUS_APP_TLS_CERT: "a.pem" }),
    (e) => e.code === "INVALID_SETTINGS",
  );
  const hosted = appConfig({
    THU_CAMPUS_APP_HOST: "0.0.0.0",
    THU_CAMPUS_APP_ALLOW_REMOTE: "1",
    THU_CAMPUS_APP_TLS_CERT: "C:\\\\certs\\\\c.pem",
    THU_CAMPUS_APP_TLS_KEY: "C:\\\\certs\\\\k.pem",
    THU_CAMPUS_APP_PUBLIC_URL: "https://campus.example.com/",
    THU_CAMPUS_APP_ALLOWED_HOSTS: "Campus.Example.com, extra.example.com",
    THU_CAMPUS_APP_ALLOWED_ORIGINS: "https://campus.example.com",
  });
  assert.equal(hosted.publicUrl, "https://campus.example.com");
  assert.deepEqual(hosted.extraHosts, ["campus.example.com", "extra.example.com"]);
  assert.deepEqual(hosted.extraOrigins, ["https://campus.example.com"]);
});

test("对外地址优先 PUBLIC_URL，其次按是否启用 TLS 拼协议", () => {
  assert.equal(
    publicBase({ publicUrl: "https://campus.example.com", host: "127.0.0.1", port: 8971 }),
    "https://campus.example.com",
  );
  assert.equal(publicBase({ publicUrl: "", tlsCert: "x.pem", host: "0.0.0.0", port: 443 }), "https://0.0.0.0:443");
  assert.equal(publicBase({ publicUrl: "", tlsCert: "", host: "127.0.0.1", port: 8971 }), "http://127.0.0.1:8971");
});

test("登录窗口能力按平台与图形会话判断", () => {
  assert.equal(loginCapability({}, "win32").window, true);
  assert.equal(loginCapability({}, "win32").reason, "desktop");
  assert.equal(loginCapability({}, "darwin").window, true);
  assert.equal(loginCapability({ DISPLAY: ":99" }, "linux").window, true);
  assert.equal(loginCapability({ DISPLAY: ":99" }, "linux").reason, "display");
  assert.equal(loginCapability({ WAYLAND_DISPLAY: "wayland-0" }, "linux").window, true);
  const headless = loginCapability({}, "linux");
  assert.equal(headless.window, false);
  assert.equal(headless.reason, "no-display");
  assert.match(headless.hint, /Xvfb/);
  assert.match(headless.hint, /无界面续登/);
});
