import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { newDb } from "pg-mem";
import { createAppServer } from "../lib/app/server.mjs";
import { PairingCodes } from "../lib/app/pairing.mjs";
import { DeviceStore } from "../lib/app/devices.mjs";
import { SessionStore } from "../lib/app/sessions.mjs";
import { openStore } from "../lib/store/index.mjs";

function fakeHost() {
  return {
    describe: () => [],
    toolForModel: () => [],
    async call() { return { ok: true, data: {} }; },
    async close() {},
  };
}
function fakeRoute() {
  return {
    route: "madmodel",
    async models() { return []; },
    async status() { return { available: false }; },
    async chat() { throw new Error("不需要对话"); },
  };
}

async function boot(t) {
  const dir = await mkdtemp(path.join(tmpdir(), "campus-auth-http-"));
  const db = newDb({ autoCreateForeignKeyIndices: true });
  const adapter = db.adapters.createPg();
  const session = await openStore({ pool: new adapter.Pool() });
  const config = {
    root: path.resolve(import.meta.dirname, ".."),
    host: "127.0.0.1", port: 0, stateDir: dir, token: "",
    modelRoute: "madmodel", modelBaseUrl: "", modelApiKey: "", modelName: "",
    maxSteps: 8, hostname: "test-host", version: "test",
  };
  const app = createAppServer({
    config,
    host: fakeHost(),
    route: fakeRoute(),
    devices: new DeviceStore(dir, { encrypt: async buffer => buffer }),
    pairing: new PairingCodes(),
    sessions: new SessionStore(dir),
    version: "test",
    webuiDir: path.join(dir, "webui"),
    auth: session.auth,
    store: session,
  });
  const url = await app.listen();
  t.after(async () => {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  });
  return { url, session };
}

function cookieOf(response) {
  const raw = response.headers.get("set-cookie") || "";
  return raw.split(";")[0];
}

test("公开配置声明邮箱登录可用，且不泄露账号信息", async t => {
  const { url } = await boot(t);
  const response = await fetch(url + "/api/auth/config");
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(body, { ok: true, emailAuth: true, pairingEnabled: true, authenticated: false, user: null });
});

test("邮箱注册即登录：Cookie 带 HttpOnly，/me 可读，重复注册被拒", async t => {
  const { url } = await boot(t);
  const response = await fetch(url + "/api/auth/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "Student@mails.tsinghua.edu.cn", password: "long-enough-pass" }),
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.user.email, "student@mails.tsinghua.edu.cn");
  assert.equal(body.token, undefined, "令牌只在 Cookie 里");
  const setCookie = response.headers.get("set-cookie");
  assert.match(setCookie, /HttpOnly/);
  assert.match(setCookie, /SameSite=Lax/);
  assert.match(setCookie, /Path=\//);

  const me = await fetch(url + "/api/auth/me", { headers: { cookie: cookieOf(response) } });
  assert.equal(me.status, 200);
  assert.equal((await me.json()).user.email, "student@mails.tsinghua.edu.cn");

  const duplicate = await fetch(url + "/api/auth/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "student@mails.tsinghua.edu.cn", password: "long-enough-pass" }),
  });
  assert.equal(duplicate.status, 409);
  assert.equal((await duplicate.json()).error.code, "EMAIL_TAKEN");
});

test("非清华邮箱、弱密码、错误密码与未登录访问都按预期拒绝", async t => {
  const { url } = await boot(t);
  const foreign = await fetch(url + "/api/auth/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "a@gmail.com", password: "long-enough-pass" }),
  });
  assert.equal(foreign.status, 400);
  assert.equal((await foreign.json()).error.code, "EMAIL_DOMAIN_NOT_ALLOWED");

  const weak = await fetch(url + "/api/auth/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "a@mails.tsinghua.edu.cn", password: "short" }),
  });
  assert.equal(weak.status, 400);
  assert.equal((await weak.json()).error.code, "WEAK_PASSWORD");

  const login = await fetch(url + "/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "a@mails.tsinghua.edu.cn", password: "long-enough-pass" }),
  });
  assert.equal(login.status, 401);
  assert.equal((await login.json()).error.code, "INVALID_CREDENTIALS");

  const me = await fetch(url + "/api/auth/me");
  assert.equal(me.status, 401);
  const api = await fetch(url + "/api/tools");
  assert.equal(api.status, 401);
});

test("Cookie 会话可访问 API；写操作缺 CSRF 标记被拒；登出后失效", async t => {
  const { url } = await boot(t);
  const registered = await fetch(url + "/api/auth/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "campus@mails.tsinghua.edu.cn", password: "long-enough-pass" }),
  });
  const cookie = cookieOf(registered);

  const tools = await fetch(url + "/api/tools", { headers: { cookie } });
  assert.equal(tools.status, 200, "Cookie 会话能访问受保护接口");

  const logoutNoCsrf = await fetch(url + "/api/auth/logout", { method: "POST", headers: { cookie } });
  assert.equal(logoutNoCsrf.status, 403);
  assert.equal((await logoutNoCsrf.json()).error.code, "CSRF_REQUIRED");

  const sessions = await fetch(url + "/api/auth/sessions", { headers: { cookie } });
  const list = (await sessions.json()).sessions;
  assert.equal(list.length, 1);
  assert.equal(typeof list[0].device, "string", "会话记录了设备标签字段");

  const logout = await fetch(url + "/api/auth/logout", { method: "POST", headers: { cookie, "x-thu-csrf": "1" } });
  assert.equal(logout.status, 200);
  assert.match(logout.headers.get("set-cookie"), /Max-Age=0/);
  const after = await fetch(url + "/api/auth/me", { headers: { cookie } });
  assert.equal(after.status, 401);
});

test("设置按用户保存：A 改模型后只有 A 看到", async t => {
  const { url } = await boot(t);
  const register = async email => {
    const response = await fetch(url + "/api/auth/register", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, password: "long-enough-pass" }) });
    return cookieOf(response);
  };
  const cookieA = await register("prefs-a@mails.tsinghua.edu.cn");
  const cookieB = await register("prefs-b@mails.tsinghua.edu.cn");

  const before = await (await fetch(url + "/api/settings", { headers: { cookie: cookieA } })).json();
  assert.equal(before.settings.modelName, "");
  const saved = await fetch(url + "/api/settings", { method: "PUT", headers: { cookie: cookieA, "content-type": "application/json", "x-thu-csrf": "1" }, body: JSON.stringify({ modelName: "A-模型", compactTools: true }) });
  assert.equal(saved.status, 200);
  assert.equal((await saved.json()).settings.modelName, "A-模型");

  const readA = await (await fetch(url + "/api/settings", { headers: { cookie: cookieA } })).json();
  assert.equal(readA.settings.modelName, "A-模型");
  assert.equal(readA.settings.compactTools, true);
  const readB = await (await fetch(url + "/api/settings", { headers: { cookie: cookieB } })).json();
  assert.equal(readB.settings.modelName, "", "B 不受 A 的设置影响");
  const metaB = await (await fetch(url + "/api/meta", { headers: { cookie: cookieB } })).json();
  assert.equal(metaB.model.name, "", "meta 也按用户返回模型名");
});

test("同步接口：增量拉取变更，未配置/未登录都明确拒绝", async t => {
  const { url, session } = await boot(t);
  const anonymous = await fetch(url + "/api/sync/changes");
  assert.equal(anonymous.status, 401);
  const registered = await fetch(url + "/api/auth/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "sync@mails.tsinghua.edu.cn", password: "long-enough-pass" }),
  });
  const cookie = cookieOf(registered);
  const user = await session.repos.users.findByEmail("sync@mails.tsinghua.edu.cn");
  await session.repos.changes.append({ userId: user.id, entity: "chat_session", entityId: "s-1", op: "create", payload: { title: "同步" } });

  const all = await fetch(url + "/api/sync/changes?since=0", { headers: { cookie } });
  assert.equal(all.status, 200);
  const body = await all.json();
  assert.equal(body.latest, 1);
  assert.equal(body.changes.length, 1);
  assert.equal(body.changes[0].entity, "chat_session");
  const tail = await (await fetch(url + "/api/sync/changes?since=1", { headers: { cookie } })).json();
  assert.equal(tail.changes.length, 0);
  const wrongMethod = await fetch(url + "/api/sync/changes", { method: "POST", headers: { cookie, "x-thu-csrf": "1" } });
  assert.equal(wrongMethod.status, 405);
});

test("设备会话列表可撤销其它设备，登录限流生效", async t => {
  const { url } = await boot(t);
  const registered = await fetch(url + "/api/auth/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "devices@mails.tsinghua.edu.cn", password: "long-enough-pass" }),
  });
  const cookie = cookieOf(registered);
  const second = await fetch(url + "/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "devices@mails.tsinghua.edu.cn", password: "long-enough-pass" }),
  });
  const secondCookie = cookieOf(second);
  const list = (await (await fetch(url + "/api/auth/sessions", { headers: { cookie } })).json()).sessions;
  assert.equal(list.length, 2);

  const revoked = await fetch(url + "/api/auth/sessions/" + list[0].id, {
    method: "DELETE",
    headers: { cookie, "x-thu-csrf": "1" },
  });
  assert.equal(revoked.status, 200);
  assert.equal((await fetch(url + "/api/auth/me", { headers: { cookie: secondCookie } })).status, 401);
  const missing = await fetch(url + "/api/auth/sessions/missing", { method: "DELETE", headers: { cookie, "x-thu-csrf": "1" } });
  assert.equal(missing.status, 404);

  let limited = false;
  for (let i = 0; i < 12; i += 1) {
    const attempt = await fetch(url + "/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "devices@mails.tsinghua.edu.cn", password: "wrong-password" }),
    });
    if (attempt.status === 429) { limited = true; break; }
  }
  assert.equal(limited, true, "15 分钟内第 11 次失败应被限流");
});