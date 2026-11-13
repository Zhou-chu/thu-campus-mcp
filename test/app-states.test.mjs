import { test } from "node:test";
import assert from "node:assert/strict";
import { stateOf, serviceEvidence, createServiceProbe } from "../lib/app/states.mjs";
import { readSessionStatus } from "../lib/madmodel/status.mjs";
import { SessionManager } from "../lib/madmodel/auth.mjs";
import { MadModelClient, verifyToken } from "../lib/madmodel/client.mjs";
import { callMadmodelTool, madmodelTools } from "../lib/madmodel/mcp.mjs";
import { createModelServer } from "../lib/madmodel/server.mjs";
import { loadConfig } from "../lib/madmodel/config.mjs";
import { learnStatus } from "../packages/learnx/dist/status.js";
import { rainStatus } from "../packages/hetang/dist/status.js";
import { CookieJar } from "tough-cookie";
import path from "node:path";
import { tmpdir } from "node:os";
import { mkdtemp, rm } from "node:fs/promises";
async function isolatedDir(t) {
  const dir = await mkdtemp(path.join(tmpdir(), "campus-status-"));
  assert.equal(path.isAbsolute(dir), true); assert.match(path.basename(dir), /^campus-status-/);
  t.after(() => rm(dir, { recursive: true, force: true })); return dir;
}

const at = "2026-01-02T03:04:05.000Z";
const verified = { verified: true, source: "protected-api:fixture-auth", checkedAt: at, code: "VERIFIED" };
const fault = code => Object.assign(new Error("fixture-private-message"), { code });
test("配置/本地令牌/浏览器/旧ready不是核验；mock不冒充真实登录", () => {
  for (const payload of [null, undefined, [], "x", {}, { browserOpen: true }]) assert.equal(stateOf(payload), "unknown");
  for (const payload of [{ configured: true }, { authentication: { configured: true } }, { authenticated: true }, { loggedIn: true }, { account: "fixture-private" }, { token: "fixture-private" }, { hasCookie: true }, { hasToken: true }, { sessionValidity: "verified" }, { state: "ready" }, { state: "unverified" }, { verified: false }]) assert.equal(stateOf(payload), "unverified");
  for (const payload of [{ mode: "mock" }, { mock: true }, { state: "mock" }, { authentication: { method: "mock" } }, { authentication: { simulation: true } }]) assert.equal(stateOf({ ...verified, ...payload }), "mock");
  for (const payload of [{ configured: false }, { authentication: { configured: false } }, { disabled: true }, { authenticated: false }, { loggedIn: false }, { state: "login-required" }, { code: "AUTH_REQUIRED" }, { error: { code: "LOGIN_REQUIRED" } }]) assert.equal(stateOf(payload), "login-required");
  for (const payload of [{ expired: true }, { expiresIn: 0 }, { sessionValidity: "expired" }, { sessionValidity: "invalid" }, { state: "expired" }, { code: "AUTH_EXPIRED" }]) assert.equal(stateOf(payload), "expired");
  for (const payload of [{ ...verified, code: "NETWORK_ERROR", expired: true }, { code: "UPSTREAM_PROTOCOL" }, { state: "unknown" }]) assert.equal(stateOf(payload), "unknown");
  for (const change of [{ code: "AUTH_CHANGED" }, { code: "ACCOUNT_API_UNSUPPORTED" }, { code: "UNVERIFIED" }, { state: "unverified" }, { sessionValidity: "unverified" }, { sessionValidity: "not_checked" }]) assert.equal(stateOf({ ...verified, ...change }), "unverified");
  assert.equal(stateOf(verified), "ready");
  for (const change of [{ source: undefined }, { source: "local:fixture" }, { checkedAt: null }, { checkedAt: "invalid" }, { verified: false }]) assert.equal(stateOf({ ...verified, ...change }), "unverified");
});
test("证据仅白名单，非法source/code不携带身份、令牌或原始异常", () => {
  const result = serviceEvidence({ ...verified, account: "fixture-private", token: "fixture-private", cookie: "fixture-private", message: "fixture-private" });
  assert.deepEqual(Object.keys(result).sort(), ["checkedAt", "code", "source", "state", "verified"]); assert.equal(result.state, "ready"); assert.ok(!JSON.stringify(result).includes("fixture-private"));
  assert.deepEqual(serviceEvidence({ token: "fixture-private", code: "fixture-private", source: "https://fixture-private" }, { at }), { state: "unverified", verified: false, checkedAt: at, source: "tool:status", code: "UNVERIFIED" });
  assert.deepEqual(serviceEvidence(null, { source: "bad", at: "bad" }), { state: "unknown", verified: false, checkedAt: null, source: "tool:status", code: "UNKNOWN_STATE" });
});
test("四服务probe显式verify:true，逐服务隔离认证/网络/抛错，保留安全证据", async () => {
  const calls = [];
  const probe = createServiceProbe({ call: async (name, args) => {
    calls.push([name, args]);
    if (name === "learn_status") return { ok: true, data: { ...verified, account: "fixture-private" } };
    if (name === "cloud_status") return { ok: false, error: { code: "AUTH_EXPIRED", message: "fixture-private" } };
    if (name === "rain_status") throw fault("NETWORK_ERROR");
    return { ok: true, data: { configured: true } };
  } }, { now: () => Date.parse(at) });
  const result = await probe();
  assert.deepEqual(calls.map(x => x[0]), ["learn_status", "cloud_status", "rain_status", "madmodel_status"]); assert.ok(calls.every(x => x[1].verify === true));
  assert.equal(result.learnx.state, "ready"); assert.equal(result.cloud.state, "expired"); assert.equal(result.hetang.state, "unknown"); assert.equal(result.madmodel.state, "unverified"); assert.equal(result.cloud.checkedAt, at); assert.equal(result.cloud.source, "tool:cloud_status"); assert.ok(!JSON.stringify(result).includes("fixture-private"));
  for (const response of [undefined, { ok: false }, { ok: false, error: { code: "bad-private" } }]) assert.ok(Object.values(await createServiceProbe({ call: async () => response })()).every(s => s.state === "unknown" && s.code === "PROBE_FAILED"));
  assert.ok(Object.values(await createServiceProbe({ call: async () => { throw new Error("fixture-private"); } })()).every(s => s.state === "unknown"));
});

const learnConfig = { mock: false, stateDir: "fixture-unused", requestTimeoutMs: 1000 };
async function learnFixture({ auth = "cookie", fetcher = async () => new Response('<a class="user-log">fixture-private-name</a><meta name="_csrf" content="fixture-private-csrf">'), ...options } = {}) {
  const jar = new CookieJar(); if (auth === "cookie") await jar.setCookie("session=fixture-private-cookie; Secure; Path=/", "https://learn.tsinghua.edu.cn");
  let requests = 0, loads = 0;
  const data = auth === "absent" ? undefined : { account: "fixture-private-account", password: "fixture-private-password", ...(auth === "credentials" ? {} : { cookieJar: jar.toJSON() }) };
  const result = await learnStatus(learnConfig, { store: { load: async () => { loads++; return data; } }, fetcher: async (url, init) => { requests++; assert.equal(url, "https://learn.tsinghua.edu.cn/f/wlxt/index/course/student/"); assert.equal(init.method, "GET"); assert.equal(init.redirect, "manual"); return fetcher(url, init); }, ...options });
  assert.ok(!JSON.stringify(result).includes("fixture-private")); return { result, requests, loads };
}
test("learn状态只复用已保存Cookie；无会话/credentials/空jar/verifyfalse/mock不登录不联网", async t => {
  const dir = await isolatedDir(t);
  for (const auth of ["absent", "credentials", "empty"]) { const { result, requests } = await learnFixture({ auth }); assert.equal(requests, 0); assert.equal(stateOf(result), auth === "absent" ? "login-required" : "unverified"); }
  assert.equal((await learnFixture({ verify: false })).requests, 0);
  const result = await learnStatus({ ...learnConfig, mock: true }, { store: { load: async () => { throw new Error("must-not-load"); } }, fetcher: async () => { throw new Error("must-not-fetch"); } }); assert.equal(stateOf(result), "mock");
  // 默认真实store只访问不存在的测试路径，不读取任何用户凭据。
  assert.equal(stateOf(await learnStatus({ ...learnConfig, stateDir: dir })), "login-required");
});
test("learn受保护用户区+CSRF才ready，明确认证拒绝/登录页过期，网络/异常协议unknown", async () => {
  const ok = await learnFixture(); assert.equal(ok.requests, 1); assert.equal(stateOf(ok.result), "ready");
  for (const html of ['<a class="user-log">fixture-private</a><input name="_csrf" value="x">', '<a class="user-log">fixture-private</a><a href="x?_csrf=x">course</a>']) assert.equal(stateOf((await learnFixture({ fetcher: async () => new Response(html) })).result), "ready");
  for (const [response, state] of [[new Response(null, { status: 401 }), "expired"], [new Response(null, { status: 403 }), "expired"], [new Response(null, { status: 302, headers: { location: "https://id.tsinghua.edu.cn/login" } }), "expired"], [new Response('<input type="password">'), "expired"], [new Response(null, { status: 302, headers: { location: "/maintenance" } }), "unknown"], [new Response(null, { status: 302 }), "unknown"], [new Response(null, { status: 503 }), "unknown"], [new Response("<html>maintenance</html>"), "unknown"], [new Response('<a class="user-log">fixture-private</a>'), "unknown"]]) assert.equal(stateOf((await learnFixture({ fetcher: async () => response })).result), state);
  assert.equal(stateOf((await learnFixture({ fetcher: async () => { throw new TypeError("fixture-private-network"); } })).result), "unknown");
  for (const code of ["AUTH_STORAGE", "AUTH_PLATFORM", undefined]) assert.equal(stateOf((await learnFixture({ store: { load: async () => { throw fault(code); } } })).result), "unknown");
  let version = 0; const jar = new CookieJar(); await jar.setCookie("session=fixture-private; Secure", "https://learn.tsinghua.edu.cn");
  const changed = await learnFixture({ store: { load: async () => ({ account: "fixture-private", cookieJar: jar.toJSON() }), version: async () => String(++version) } }); assert.equal(changed.result.code, "AUTH_CHANGED"); assert.equal(stateOf(changed.result), "unverified");
});

test("rain只读basic-info验证，mock/无认证/verifyfalse不调用用户API，不返回身份", async t => {
  const config = { mock: false, stateDir: await isolatedDir(t) }; let users = 0;
  const client = { user: async () => { users++; return { id: "fixture-private-id", name: "fixture-private-name" }; } };
  const store = { status: async () => ({ configured: true, accountId: "fixture-private" }) };
  const result = await rainStatus(config, client, { store }); assert.equal(users, 1); assert.equal(stateOf(result), "ready"); assert.ok(!JSON.stringify(result).includes("fixture-private"));
  assert.equal(stateOf(await rainStatus(config, client, { store, verify: false })), "unverified");
  assert.equal(stateOf(await rainStatus(config, client, { store: { status: async () => ({ configured: false }) } })), "login-required");
  assert.equal(stateOf(await rainStatus({ ...config, mock: true }, client)), "mock"); assert.equal(stateOf(await rainStatus(config, client)), "login-required"); assert.equal(users, 1);
  for (const [code, state] of [["AUTH_REQUIRED", "expired"], ["AUTH_CHANGED", "unverified"], ["AUTH_STORAGE", "unknown"], ["AUTH_PLATFORM", "unknown"], [undefined, "unknown"]]) assert.equal(stateOf(await rainStatus(config, { user: async () => { throw fault(code); } }, { store })), state);
  assert.equal(stateOf(await rainStatus(config, client, { store: { status: async () => { throw fault("AUTH_REQUIRED"); } } })), "login-required");
});

const time = Date.parse(at), data = { token: "fixture-private-token", accountId: "fixture-private-id", account: "fixture-private-account", expiresAt: time + 100000 };
const sessionStore = value => ({ load: async () => ({ data: value, revision: "one" }) });
test("MadModel免费认证GET真值，不以本地token或旧核验时间当ready，不输出PII", async () => {
  let verifies = 0; const options = { store: sessionStore(data), now: () => time, verify: async () => { verifies++; return true; }, verifiedAt: time - 1000, retryAt: time + 1000, lastError: { code: "OLD_ERROR", message: "fixture-private" } };
  const ok = await readSessionStatus(options); assert.equal(stateOf(ok), "ready"); assert.equal(ok.lastError, null); assert.equal(ok.nextRetryAt, new Date(time + 1000).toISOString()); assert.ok(!JSON.stringify(ok).includes("fixture-private"));
  assert.equal(stateOf(await readSessionStatus({ ...options, verifySession: false })), "unverified");
  assert.equal(stateOf(await readSessionStatus({ ...options, verify: undefined, lastError: { code: "fixture-private" } })), "unverified"); assert.equal(verifies, 1);
  for (const value of [undefined, { disabled: true, ...data }, { ...data, expiresAt: undefined }, { ...data, expiresAt: time - 1 }]) { const result = await readSessionStatus({ ...options, store: sessionStore(value), verifySession: false }); assert.notEqual(stateOf(result), "ready"); }
  assert.equal((await readSessionStatus({ ...options, store: { load: async () => { throw fault("private"); } } })).code, "AUTH_STORAGE");
  for (const [valid, state] of [[false, "expired"], [undefined, "unknown"]]) assert.equal(stateOf(await readSessionStatus({ ...options, verify: async () => valid })), state);
  for (const [code, state] of [["AUTH_REQUIRED", "login-required"], ["AUTH_EXPIRED", "expired"], ["UPSTREAM_PROTOCOL", "unknown"], [undefined, "unknown"]]) assert.equal(stateOf(await readSessionStatus({ ...options, verify: async () => { throw fault(code); } })), state);
  const signal = AbortSignal.abort(); assert.equal((await readSessionStatus({ ...options, signal })).code, "NETWORK_ERROR");
  let reads = 0; const changed = await readSessionStatus({ ...options, store: { load: async () => ({ revision: String(++reads), data }) } }); assert.equal(changed.code, "AUTH_CHANGED"); assert.equal(stateOf(changed), "unverified");
  let swaps = 0; assert.equal((await readSessionStatus({ ...options, store: { load: async () => ({ revision: "one", data: ++swaps === 1 ? data : undefined }) } })).code, "AUTH_CHANGED");
});
test("SessionManager.status与madmodel_status只传verify，不触发ensure/login/paidchat", async () => {
  let verifies = 0, logins = 0;
  const manager = new SessionManager({ store: sessionStore({ ...data, expiresAt: Date.now() + 100000 }), login: async () => { logins++; throw new Error("must-not-login"); }, verify: async () => { verifies++; return true; } });
  assert.equal(stateOf(await manager.status()), "ready"); assert.equal(stateOf(await manager.status({ verify: false })), "unverified"); assert.equal(logins, 0); assert.equal(verifies, 1);
  const calls = [], client = { manager: { status: async args => { calls.push(args); return { fixture: true }; } }, models: async () => ({ fixture: "models" }) };
  assert.equal(madmodelTools[0].inputSchema.properties.verify.default, true);
  await callMadmodelTool("madmodel_status", {}, { client }); await callMadmodelTool("madmodel_status", { verify: false }, { client }); assert.deepEqual(calls, [{ verify: true }, { verify: false }]);
  assert.deepEqual(await callMadmodelTool("madmodel_models", {}, { client }), { fixture: "models" });
  for (const args of [null, [], "x", { token: "x" }, { verify: "true" }]) await assert.rejects(callMadmodelTool("madmodel_status", args, { client }), e => e.code === "INVALID_ARGUMENTS");
  await assert.rejects(callMadmodelTool("madmodel_models", { verify: true }, { client }), e => e.code === "INVALID_ARGUMENTS"); await assert.rejects(callMadmodelTool("unknown", {}, { client }), e => e.code === "UNKNOWN_TOOL");
});
test("verifyToken只GET认证端点，明确拒绝false，异常协议不能假过期", async () => {
  const fetcher = async (url, init) => { assert.equal(url, "https://madmodel.cs.tsinghua.edu.cn/model-api/auth-login"); assert.equal(init.method, undefined); assert.equal(init.redirect, "manual"); return Response.json({ data: true }); };
  assert.equal(await verifyToken("fixture-token", undefined, fetcher), true);
  for (const status of [401, 403]) assert.equal(await verifyToken("fixture-token", undefined, async () => new Response(null, { status })), false);
  assert.equal(await verifyToken("fixture-token", undefined, async () => Response.json({ data: false })), false);
  for (const response of [Response.json({}), new Response("login"), Response.json({ data: true }, { status: 500 })]) await assert.rejects(verifyToken("fixture-token", undefined, async () => response), e => e.code === "UPSTREAM_PROTOCOL");
});
test("MadModel真实HTTP健康端点没有verified证据即降级，认证状态只读", async t => {
  let payload = { configured: true, expired: false }, statusCalls = 0;
  const server = createModelServer({ config: { ...loadConfig({}), port: 0 }, client: { manager: { status: async () => { statusCalls++; if (payload instanceof Error) throw payload; return payload; } } } });
  await new Promise(r => server.listen(0, "127.0.0.1", r)); t.after(async () => { server.closeAllConnections(); await new Promise(r => server.close(r)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  assert.equal((await fetch(base + "/health")).status, 503);
  payload = { ...payload, ...verified }; assert.equal((await fetch(base + "/health")).status, 200);
  assert.equal((await (await fetch(base + "/auth/status")).json()).verified, true); assert.equal(statusCalls, 3);
  payload = Object.assign(fault("AUTH_STORAGE"), { status: 503 }); const failed = await fetch(base + "/auth/status"); assert.equal(failed.status, 503); assert.ok(!(await failed.text()).includes("fixture-private"));
  for (const change of [{ source: "local:fixture" }, { checkedAt: "invalid" }, { expired: true }]) { payload = { ...verified, ...change }; assert.equal((await fetch(base + "/health")).status, 503); }
});
test("模型目录只读fake样本的缓存/刷新/异常与默认认证GET，不使用真实网络或浏览器", async t => {
  const stateDir = await isolatedDir(t), config = loadConfig({ MADMODEL_STATE_DIR: stateDir });
  let requests = 0;
  const fetcher = async (url) => {
    requests++;
    if (url.endsWith("/model-api/auth-login")) return Response.json({ data: true });
    if (url.endsWith("/assets/catalog.js")) return new Response('const X={modelList:[{value:"fixture-model",supportImage:!0,effortOptions:["low","high"]}]}');
    assert.equal(url, "https://madmodel.cs.tsinghua.edu.cn/");
    return new Response('<script src="https://foreign.invalid/other.js"></script><script src="/assets/catalog.js"></script>');
  };
  const client = new MadModelClient({ config, fetcher });
  assert.equal((await client.models()).data[0].id, "fixture-model"); assert.equal(requests, 2);
  await client.models(); assert.equal(requests, 2);
  await client.models({ refresh: true, signal: new AbortController().signal }); assert.equal(requests, 4);
  assert.equal(await client.manager.verify("fixture-token", new AbortController().signal), true); assert.equal(requests, 5);
  assert.equal((await client.manager.status({ verify: false })).code, "AUTH_REQUIRED");
  client.fetcher = async () => new Response(null, { status: 503 }); await assert.rejects(client.models({ refresh: true }), e => e.code === "MODEL_DISCOVERY_FAILED");
  client.fetcher = async () => new Response("<html>no script</html>"); await assert.rejects(client.models({ refresh: true }), e => e.code === "MODEL_DISCOVERY_FAILED");
});
