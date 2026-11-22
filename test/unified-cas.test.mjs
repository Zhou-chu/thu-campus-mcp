import test from "node:test";
import assert from "node:assert/strict";
import { CAS_ORIGIN, fillCasForm } from "../lib/app/cas.mjs";
import { createLearnxAccountLogin } from "../lib/app/learnx-login.mjs";

function form({ origin = CAS_ORIGIN, challenge = false } = {}) {
  const field = (hidden = false) => ({ value: "", getClientRects: () => hidden ? [] : [{}], focus() {}, dispatchEvent() {} });
  const user = field(), pass = field(), hidden = field(true);
  let clicks = 0;
  const button = { ...field(), textContent: "登 录", click() { clicks += 1; } };
  const document = { body: { innerText: challenge ? "请输入验证码" : "" }, querySelectorAll: selector => {
    if (selector.startsWith("input#i_user")) return [hidden, user];
    if (selector.startsWith("input#i_pass")) return [hidden, pass];
    if (selector.startsWith("button,")) return [button];
    return [];
  } };
  const page = { evaluate: async (fn, arg) => Function("location", "document", "getComputedStyle", "arg", `return (${fn})(arg)`)(
    { origin }, document, () => ({ visibility: "visible" }), arg,
  ) };
  return { page, user, pass, hidden, clicks: () => clicks };
}

test("unified CAS selects visible official fields and submits only once", async () => {
  const fixture = form();
  assert.deepEqual(await fillCasForm(fixture.page, { username: "test-user", password: "test-only" }), { ok: true });
  assert.equal(fixture.user.value, "test-user");
  assert.equal(fixture.pass.value, "test-only");
  assert.equal(fixture.hidden.value, "");
  assert.equal(fixture.clicks(), 1);
});

test("unified CAS never fills credentials at a different origin or submits a challenge", async () => {
  for (const [options, code] of [[{ origin: "https://id.tsinghua.edu.cn.example.org" }, "CAS_WRONG_ORIGIN"], [{ challenge: true }, "CAS_CAPTCHA_REQUIRED"]]) {
    const fixture = form(options);
    assert.equal((await fillCasForm(fixture.page, { username: "test-user", password: "test-only" })).code, code);
    assert.equal(fixture.pass.value, "");
    assert.equal(fixture.clicks(), 0);
  }
});

function learnFixture({ verified = true, afterSubmit, accounts, fillResult = { ok: true }, prior = { version: "old", data: { account: "test-user" } } } = {}) {
  const saves = [];
  const account = { username: "test-user", password: "test-only" };
  let closed = 0, read = 0, origins;
  const page = {
    goto: async () => {}, locator: () => ({ click: async () => {}, first: () => ({ waitFor: async () => {} }) }),
    waitForURL: async (predicate, { timeout }) => {
      if (timeout === 12000) assert.equal(predicate(new URL(CAS_ORIGIN)), true);
      else if (afterSubmit) throw new Error("No return");
      else assert.equal(predicate(new URL("https://learn.tsinghua.edu.cn/f/wlxt/index/course/student/")), true);
    }, content: async () => "test-page", evaluate: async () => afterSubmit === "challenge",
  };
  const context = { newPage: async () => page, cookies: async input => { origins = input; return []; } };
  class AuthStore {
    async generation() { return "epoch"; }
    async version() { return "old"; }
    async loadVersioned() { return prior; }
    async saveBrowserIfCurrent(...args) { saves.push(args); }
  }
  const login = createLearnxAccountLogin({
    launch: async () => ({ newContext: async () => context, close: async () => { closed += 1; } }),
    accountStore: async () => accounts ? accounts[read++] : account,
    learnx: async () => ({ AuthStore, loadConfig: () => ({ stateDir: "test" }),
      browserSessionData: async username => ({ account: username, csrfToken: "test" }), verifyBrowserSession: async () => verified }),
    fill: async () => fillResult,
  });
  return { login, saves, closed: () => closed, origins: () => origins };
}

test("LearnX writes the verified session with a version guard and only captures LearnX cookies", async () => {
  const fixture = learnFixture();
  assert.deepEqual(await fixture.login({ sameAccountOnly: true }), { ok: true });
  assert.deepEqual(fixture.saves, [[{ account: "test-user", csrfToken: "test" }, "epoch", "old"]]);
  assert.deepEqual(fixture.origins(), ["https://learn.tsinghua.edu.cn"]);
  assert.equal(fixture.closed(), 1);
});

test("LearnX automatic recovery never launches a browser for a different account or changed version", async () => {
  for (const [prior, code] of [
    [{ version: "old", data: { account: "different-user" } }, "BROWSER_ACCOUNT_MISMATCH"],
    [{ version: "different", data: { account: "test-user" } }, "AUTH_CHANGED"],
  ]) {
    const fixture = learnFixture({ prior });
    await assert.rejects(() => fixture.login({ sameAccountOnly: true }), { code });
    assert.deepEqual(fixture.saves, []);
    assert.equal(fixture.closed(), 0);
  }
  const fixture = learnFixture();
  await assert.rejects(() => fixture.login({ sameAccountOnly: true, expectedAccount: { username: "test-user", password: "changed" } }), { code: "AUTH_CHANGED" });
  assert.equal(fixture.closed(), 0);
});

test("LearnX never persists on challenge, failed verification or changed account", async () => {
  for (const [options, code] of [[{ afterSubmit: "challenge" }, "CAS_CAPTCHA_REQUIRED"], [{ verified: false }, "LEARNX_LOGIN_UNCONFIRMED"], [{ accounts: [{ username: "old", password: "test" }, null] }, "AUTH_CHANGED"]]) {
    const fixture = learnFixture(options);
    await assert.rejects(() => fixture.login(), { code });
    assert.deepEqual(fixture.saves, []);
    assert.equal(fixture.closed(), 1);
  }
});
