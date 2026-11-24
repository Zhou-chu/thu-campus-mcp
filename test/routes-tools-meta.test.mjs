import assert from "node:assert/strict";
import test from "node:test";
import { createToolRoutes } from "../lib/app/routes/tools.mjs";
import { createMetaRoutes } from "../lib/app/routes/meta.mjs";

function response() {
  const state = { status: 0, body: undefined };
  const res = { writableEnded: false, writeHead(status) { state.status = status; }, end(payload) { state.body = payload ? JSON.parse(payload) : undefined; } };
  return { res, state };
}
const request = body => ({ method: "POST", body, headers: {} });
async function call(handler, { method = "GET", pathname, body, headers = {} }) {
  const { res, state } = response();
  const req = { method, body, headers, encrypted: true, socket: { remoteAddress: "127.0.0.1" }, url: pathname };
  const handled = await handler(req, res, { pathname, method, url: new URL(pathname, "http://127.0.0.1") });
  return { handled, status: state.status, body: state.body };
}

const baseHost = {
  describe: () => [
    { name: "learn_status", description: "状态", inputSchema: { type: "object" }, readOnly: true, service: "learnx" },
    { name: "learn_submit", description: "提交", inputSchema: { type: "object" }, destructive: true, service: "learnx" },
  ],
  async call(name) { return { ok: true, data: { name } }; },
};

test("工具路由：审批凭证、调用失败与未知工具", async () => {
  const confirmations = {
    consumed: [],
    consume(token, scope, canonical) { this.consumed.push({ token, scope, canonical }); return token === "ok"; },
    issue(scope, canonical) { return { token: "issued-" + scope + "-" + canonical, expiresAt: "2026-11-23T00:00:00.000Z" }; },
  };
  const handler = createToolRoutes({
    config: { stateDir: ".", requireApproval: true },
    host: baseHost,
    jobs: new Map(),
    serviceStates: async () => ({}),
    route: { status: async () => ({ available: true }) },
    learnx: { login: async () => ({ ok: true, verified: true }), clearSignal: () => {} },
    readBody: async req => req.body ?? {},
    searchJob: () => null,
    confirmations,
    canonicalJson: value => JSON.stringify(value),
  });

  const list = await call(handler, { pathname: "/api/tools" });
  assert.equal(list.body.tools.length, 2);

  const blocked = await call(handler, { method: "POST", pathname: "/api/tools/learn_submit", body: { id: 1 } });
  assert.equal(blocked.status, 428);
  assert.equal(blocked.body.requiresApproval, true);

  const approved = await call(handler, { method: "POST", pathname: "/api/tools/learn_submit", body: { id: 1 }, headers: { "x-campus-approval": "ok" } });
  assert.equal(approved.status, 200);
  assert.equal(approved.body.data.name, "learn_submit");

  const unknownApproval = await call(handler, { method: "POST", pathname: "/api/tool-approvals", body: { name: "missing" } });
  assert.equal(unknownApproval.status, 404);
  const notRequired = await call(handler, { method: "POST", pathname: "/api/tool-approvals", body: { name: "learn_status" } });
  assert.equal(notRequired.status, 400);
  const issued = await call(handler, { method: "POST", pathname: "/api/tool-approvals", body: { name: "learn_submit", args: { id: 1 } } });
  assert.equal(issued.status, 200);
  assert.match(issued.body.token, /^issued-tool:learn_submit/);

  const workspaceBlocked = await call(handler, { method: "POST", pathname: "/api/tools/workspace_run", body: {} });
  assert.equal(workspaceBlocked.status, 403);

  const status = await call(handler, { pathname: "/api/auth/status" });
  assert.equal(status.body.ok, true);
  const job = await call(handler, { pathname: "/api/jobs/job-1" });
  assert.equal(job.body.kind, "unknown");
  assert.equal(job.body.found, false);
});

test("登录路由：成功、失败、未知错误与任务 ID 回落", async () => {
  const jobs = new Map();
  const calls = [];
  const host = {
    describe: () => [],
    async call(name, args) {
      calls.push({ name, args });
      if (args.service === "cloud") return { ok: true, data: { jobId: "job-cloud" } };
      if (args.service === "hetang") return { ok: true, data: { id: "job-hetang" } };
      return { ok: false, error: { code: "LOGIN_FAILED", message: "登录失败" } };
    },
  };
  let account = { username: "2023210001" };
  const handler = createToolRoutes({
    config: { stateDir: "." },
    host,
    jobs,
    serviceStates: async () => ({}),
    route: { status: async () => ({ available: true }) },
    learnx: { login: async () => ({ ok: true, verified: true }), clearSignal: () => {} },
    readBody: async req => req.body ?? {},
    searchJob: () => null,
    confirmations: { consume: () => true, issue: () => ({ token: "t" }) },
    canonicalJson: value => JSON.stringify(value),
  });

  const badService = await call(handler, { method: "POST", pathname: "/api/services/login", body: { service: "nope" } });
  assert.equal(badService.status, 400);

  const cloud = await call(handler, { method: "POST", pathname: "/api/services/login", body: { service: "cloud" } });
  assert.equal(cloud.body.ok, true);
  assert.equal(jobs.get("job-cloud").service, "cloud");

  const hetang = await call(handler, { method: "POST", pathname: "/api/services/login", body: { service: "hetang" } });
  assert.equal(hetang.body.ok, true);
  assert.equal(jobs.get("job-hetang").kind, "login");

  const learnx = await call(handler, { method: "POST", pathname: "/api/services/login", body: { service: "learnx" } });
  assert.equal(learnx.body.ok, false, "learnx 分支走 learnx.login 前的 host.call 失败");

  const explicitAccount = await call(handler, { method: "POST", pathname: "/api/services/login", body: { service: "madmodel", account: " 2023210002 " } });
  assert.equal(calls.at(-1).args.account, "2023210002");
  assert.equal(explicitAccount.body.ok, false);

  // 网络异常被包装成可读错误，而不是抛出。
  const flaky = createToolRoutes({
    config: { stateDir: "." }, host: { describe: () => [], async call() { throw Object.assign(new Error("浏览器忙"), { code: "BROWSER_BUSY" }); } },
    jobs, serviceStates: async () => ({}), route: { status: async () => ({}) },
    learnx: { login: async () => ({}), clearSignal: () => {} }, readBody: async req => req.body ?? {},
    searchJob: () => null, confirmations: { consume: () => true, issue: () => ({ token: "t" }) },
    canonicalJson: value => JSON.stringify(value),
  });
  const busy = await call(flaky, { method: "POST", pathname: "/api/services/login", body: { service: "cloud" } });
  assert.equal(busy.body.ok, false);
  assert.equal(busy.body.error.code, "BROWSER_BUSY");
});

test("元信息路由：启动地址、配对邀请关闭、会话码与轮换边界", async () => {
  const devices = { count: async () => 0, list: async () => [], revoke: async () => false };
  const make = overrides => createMetaRoutes({
    config: { host: "127.0.0.1", port: 8971, modelRoute: "madmodel", token: "", ...overrides.config },
    route: { status: async () => ({ available: true, route: "madmodel" }), models: async () => [{ id: "m" }] },
    overrides: {}, serviceStates: async () => ({}), devices,
    pairing: { issue: () => ({ code: "123456", expiresAt: "x", ttlSeconds: 300 }) },
    keepAlive: null, version: "1.0.0", needsLoaded: async () => {},
    exchange: { issue: () => null },
    tokenOf: () => "",
    ...overrides,
  });

  const loopback = await call(make({}), { pathname: "/api/meta" });
  assert.equal(loopback.body.pairing.enabled, true);
  assert.equal(Array.isArray(loopback.body.lanUrls), true);

  const refusedExchange = await call(make({}), { method: "POST", pathname: "/api/session/exchange" });
  assert.equal(refusedExchange.status, 401);

  const rotateSupported = make({ devices: { ...devices, rotate: async () => ({ token: "new", id: "d", revoked: 1 }) } });
  const rotated = await call(rotateSupported, { method: "POST", pathname: "/api/session/rotate" });
  assert.equal(rotated.body.ok, true);

  const rotateUnsupported = await call(make({ devices: { ...devices } }), { method: "POST", pathname: "/api/session/rotate" });
  assert.equal(rotateUnsupported.status, 501);

  const fixed = make({ config: { token: "fixed" } });
  const fixedRotate = await call(fixed, { method: "POST", pathname: "/api/session/rotate" });
  assert.equal(fixedRotate.status, 409);
  const invite = await call(fixed, { method: "POST", pathname: "/api/pair/invite" });
  assert.equal(invite.status, 403);

  const revokeMissing = await call(make({}), { method: "DELETE", pathname: "/api/devices/abc-123" });
  assert.equal(revokeMissing.status, 404);

  const modelsFail = make({ route: { status: async () => ({}), models: async () => [] } });
  const noModels = await call(modelsFail, { pathname: "/api/models" });
  assert.equal(noModels.status, 502);

  const modelsThrown = make({ route: { status: async () => ({}), models: async () => { throw new Error("挂了"); } } });
  const failed = await call(modelsThrown, { pathname: "/api/models" });
  assert.equal(failed.status, 502);
  assert.equal(failed.body.error.code, "MODEL_DISCOVERY_FAILED");

  const other = await call(make({}), { pathname: "/api/nope" });
  assert.equal(other.handled, false);
});