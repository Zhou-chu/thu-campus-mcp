import assert from "node:assert/strict";
import { test } from "node:test";
import { classifyLoginOutcome, loginAll } from "../lib/app/login-all.mjs";

const credentials = { username: "u", password: "p" };

test("统一登录编排：按状态归档失败原因", () => {
  assert.equal(classifyLoginOutcome({ code: "CAS_CAPTCHA_REQUIRED" }).state, "needs-manual");
  assert.equal(classifyLoginOutcome({ code: "SEAT_LOGIN_UNCONFIRMED" }).state, "needs-manual");
  assert.equal(classifyLoginOutcome({ code: "BROWSER_BUSY" }).state, "busy");
  assert.equal(classifyLoginOutcome({ code: "SPORTS_UNREACHABLE" }).state, "unavailable");
  assert.equal(classifyLoginOutcome({ code: "ACCOUNT_NOT_CONFIGURED" }).state, "not-configured");
  assert.equal(classifyLoginOutcome({ code: "WHATEVER" }).state, "failed");
  assert.equal(classifyLoginOutcome(new Error("boom")).code, "LOGIN_FAILED");
});

test("统一登录编排：每个服务独立成败，人工验证会被标出来", async () => {
  const order = [];
  const result = await loginAll({
    account: credentials,
    adapters: {
      learnx: async () => { order.push("learnx"); return { ok: true }; },
      seat: async () => { order.push("seat"); throw Object.assign(new Error("需要验证码"), { code: "CAS_CAPTCHA_REQUIRED" }); },
      sports: async () => { order.push("sports"); throw Object.assign(new Error("占用"), { code: "BROWSER_BUSY" }); },
    },
  });
  assert.deepEqual(order, ["learnx", "seat", "sports"], "按声明顺序逐个准备");
  assert.equal(result.total, 3);
  assert.equal(result.ready, 1);
  assert.deepEqual(result.needsManual, ["CAS_CAPTCHA_REQUIRED"]);
  assert.equal(result.busy, 1);
  assert.deepEqual(result.results.learnx, { ok: true, state: "ready", code: "VERIFIED", message: "" });
  assert.equal(result.results.seat.state, "needs-manual");
  assert.equal(result.results.sports.state, "busy");
  assert.equal(result.ok, true, "至少有一个成功就算本次编排成功");
});

test("统一登录编排：已核验的服务跳过，没账号时直接报错", async () => {
  const called = [];
  const result = await loginAll({
    account: credentials,
    skip: ["seat"],
    adapters: { seat: async () => { called.push("seat"); return { ok: true }; }, sports: async () => ({ ok: true, alreadyLoggedIn: true }) },
  });
  assert.deepEqual(called, [], "跳过的服务不调用适配器");
  assert.equal(result.results.seat.code, "SKIPPED");
  assert.equal(result.results.sports.alreadyLoggedIn, true);
  assert.equal(result.ready, 2);

  await assert.rejects(() => loginAll({ account: { username: "", password: "" } }), { code: "ACCOUNT_NOT_CONFIGURED" });
});

test("统一登录编排：全部失败时 ok=false，但仍逐项给出状态", async () => {
  const result = await loginAll({
    account: credentials,
    adapters: {
      seat: async () => ({ ok: false, code: "SEAT_LOGIN_UNCONFIRMED", message: "未确认" }),
      sports: async () => { throw Object.assign(new Error("超时"), { code: "LOGIN_TIMEOUT" }); },
    },
  });
  assert.equal(result.ok, false);
  assert.equal(result.ready, 0);
  assert.equal(result.results.seat.code, "SEAT_LOGIN_UNCONFIRMED");
  assert.equal(result.results.sports.state, "failed");
});

test("统一登录编排：worker 服务只提交任务并返回 jobId，不冒充成功", async () => {
  const result = await loginAll({
    account: { username: "u", password: "p" },
    adapters: {
      cloud: async () => ({ ok: false, code: "LOGIN_QUEUED", message: "已提交", jobId: "job-cloud" }),
      hetang: async () => { throw Object.assign(new Error("浏览器正忙"), { code: "BROWSER_BUSY" }); },
      seat: async () => ({ ok: true }),
    },
  });
  assert.equal(result.results.cloud.state, "queued");
  assert.equal(result.results.cloud.jobId, "job-cloud");
  assert.equal(result.results.hetang.state, "busy");
  assert.equal(result.results.seat.state, "ready");
});

test("统一登录编排：services 只跑指定范围", async () => {
  const ran = [];
  const result = await loginAll({
    account: { username: "u", password: "p" },
    services: ["seat"],
    adapters: { seat: async () => { ran.push("seat"); return { ok: true }; }, sports: async () => { ran.push("sports"); return { ok: true }; } },
  });
  assert.deepEqual(ran, ["seat"]);
  assert.equal(result.total, 1);
});
