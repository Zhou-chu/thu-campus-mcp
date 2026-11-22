import assert from "node:assert/strict";
import { test } from "node:test";
import { createSeatApi } from "../lib/app/seat.mjs";

const SEAT = "https://seat.lib.tsinghua.edu.cn";
const CAS = "https://id.tsinghua.edu.cn";

/** 假页面：按 evaluate 的源码分派，不启动浏览器也能走完登录与预约状态机。 */
function fakePage(state) {
  const clicks = [];
  const locator = () => {
    const chain = {
      filter: () => chain,
      first: () => chain,
      waitFor: async () => { state.waited = true; },
      click: async () => { clicks.push("click"); state.url = state.afterClickUrl || state.url; },
    };
    return chain;
  };
  return {
    _state: state,
    clicks,
    url: () => state.url,
    async goto(url) { state.url = url; state.goto = url; },
    async evaluate(fn, arg) {
      const src = String(fn);
      if (arg && typeof arg === "object" && "url" in arg) return state.bookResponse ? state.bookResponse(arg) : { status: 200, json: { status: 1 } };
      if (arg && typeof arg === "object" && "target" in arg) return state.cancelResponse ? state.cancelResponse(arg) : { status: 1 };
      if (src.includes("document.cookie")) return state.credentials || { token: "page-token", userid: "page-user" };
      if (src.includes("bookRule")) return state.rules;
      if (src.includes("innerText")) return state.text;
      if (src.includes("location.origin") && src.includes("access_token")) return Boolean(state.token);
      if (src.includes("/book`")) return state.bookResponse(arg);
      if (src.includes("/books/")) return state.cancelResponse(arg);
      return state.defaultEvaluation ?? null;
    },
    locator,
    async waitForFunction() { if (state.redirect) state.url = state.redirect; },
    context: () => ({ cookies: async () => state.cookies || [] }),
  };
}

function fakeBrowser(page, { openError, verifyStatus = 200, verifyPayload = { data: {} }, failVerify } = {}) {
  const pageState = page._state;
  return {
    page,
    closed: 0,
    checkpointed: 0,
    async checkpoint() { this.checkpointed += 1; },
    async close() { this.closed += 1; },
    context: {
      async newPage() { if (pageState.newPageError) throw pageState.newPageError; return page; },
      async clearCookies() { pageState.cookiesCleared = true; },
      request: {
        async get() {
          if (failVerify && failVerify(pageState)) {
            const error = new Error("需要登录");
            error.code = "SEAT_LOGIN_REQUIRED";
            throw error;
          }
          return { status: () => verifyStatus, json: async () => verifyPayload };
        },
      },
    },
  };
}

function apiWith({ probe = async () => ({ verified: false, state: "login-required" }), credentials = { username: "u", password: "p" }, browser, casFill, read, now = () => new Date("2026-11-24T02:00:00.000Z") } = {}) {
  const calls = [];
  const api = createSeatApi({
    probe,
    readCredentials: async () => credentials,
    withLock: async (_name, fn) => fn(),
    openBrowser: async () => {
      if (!browser) throw Object.assign(new Error("busy"), { code: "BROWSER_BUSY" });
      return browser;
    },
    casFill: casFill || (async () => ({ ok: true })),
    now,
    createReadSession: () => async (action, options) => action({ call: async path => { calls.push({ path, options }); return read ? read(path) : { data: { list: [] } }; } }),
  });
  return { api, calls };
}

test("座位会话：成功返回动作结果并关闭浏览器，异常也关闭", async () => {
  const state = { url: SEAT + "/web/seat3?area=3", token: true };
  const browser = fakeBrowser(fakePage(state));
  const { api } = apiWith({ browser, probe: async () => ({ verified: true }) });
  const value = await api.withSeatSession(async ({ page, browser: opened }) => {
    assert.equal(opened, browser);
    return page.url();
  });
  assert.match(value, /seat3/);
  assert.equal(browser.closed, 1);
  await assert.rejects(() => api.withSeatSession(async () => { throw new Error("动作失败"); }), /动作失败/);
  assert.equal(browser.closed, 2);
});

test("座位会话：浏览器被占用与无法启动分别给出错误码", async () => {
  const { api } = apiWith({ browser: null });
  await assert.rejects(() => api.withSeatSession(async () => 1), (error) => error.code === "BROWSER_BUSY");
  const failing = createSeatApi({
    withLock: async (_n, fn) => fn(),
    openBrowser: async () => { throw Object.assign(new Error("boom"), { code: "SPAWN_FAILED" }); },
  });
  await assert.rejects(() => failing.withSeatSession(async () => 1), (error) => error.code === "SEAT_UNREACHABLE");
});

test("登录：已带令牌、休息时段与未配置账号三种直接结论", async () => {
  const base = { url: SEAT + "/web/seat3", token: true };
  const verified = await apiWith({ browser: fakeBrowser(fakePage(base)), probe: async () => ({ verified: false, state: "login-required" }) }).api.login();
  assert.deepEqual(verified, { ok: true, alreadyLoggedIn: true });

  const closedState = { url: SEAT + "/web/seat3", token: false, text: "系统开放预约时间 06:00-23:00，当前不在开放时段" };
  const closed = await apiWith({ browser: fakeBrowser(fakePage(closedState), { failVerify: () => true }) }).api.login();
  assert.equal(closed.code, "SEAT_CLOSED");

  const noAccount = await apiWith({ browser: fakeBrowser(fakePage({ url: SEAT + "/web/seat3", token: false, text: "请登录" }), { failVerify: () => true }), credentials: null }).api.login();
  assert.equal(noAccount.code, "ACCOUNT_NOT_CONFIGURED");
});

test("登录：CAS 表单成功后确认登录，失败或验证码如实返回", async () => {
  const state = { url: SEAT + "/web/seat3", token: false, text: "请登录", redirect: CAS + "/login" };
  state.afterClickUrl = CAS + "/login";
  const browser = fakeBrowser(fakePage(state), { failVerify: () => !state.token });
  const api = apiWith({
    browser,
    casFill: async () => { state.token = true; state.url = SEAT + "/web/seat3"; return { ok: true }; },
  }).api;
  const ok = await api.login();
  assert.equal(ok.ok, true);
  assert.equal(ok.alreadyLoggedIn, false);
  assert.equal(browser.checkpointed, 1, "成功后保存会话快照");

  const bad = apiWith({ browser: fakeBrowser(fakePage({ url: SEAT + "/web/seat3", token: false, text: "请登录", redirect: CAS + "/login" }), { failVerify: () => true }), casFill: async () => ({ ok: false, code: "CAS_BAD_CREDENTIALS", message: "密码错误" }) }).api;
  const failed = await bad.login();
  assert.equal(failed.code, "CAS_BAD_CREDENTIALS");
  assert.equal(failed.needsManual, true);

  const captcha = apiWith({ browser: fakeBrowser(fakePage({ url: SEAT + "/web/seat3", token: false, text: "请登录", redirect: CAS + "/login" }), { failVerify: () => true }), casFill: async () => ({ ok: false, code: "CAS_SUBMIT_INTERRUPTED" }) }).api;
  assert.equal((await captcha.login()).code, "SEAT_LOGIN_UNCONFIRMED");
});

test("登录：需要人工验证码时明确要求手动完成", async () => {
  const state = { url: SEAT + "/web/seat3", token: false, text: "请登录", redirect: CAS + "/login" };
  const browser = fakeBrowser(fakePage(state), { failVerify: () => !state.token });
  const api = apiWith({ browser, casFill: async () => { state.text = "验证码"; return { ok: true }; } }).api;
  const result = await api.login();
  assert.equal(result.code, "CAS_CAPTCHA_REQUIRED");
  assert.equal(result.needsManual, true);
});

test("登录：核验通过时无需再进 CAS", async () => {
  const api = apiWith({ probe: async () => ({ verified: false, state: "login-required" }), browser: fakeBrowser(fakePage({ url: SEAT + "/web/seat3", token: false, text: "请登录" }), { failVerify: () => true }) }).api;
  const result = await api.login();
  assert.equal(result.code, "SEAT_LOGIN_UNCONFIRMED");
});

test("只读接口：各端点用真实返回归一，空数据给出错误", async () => {
  const payloads = {
    "/api.php/areas/1/tree/1": { data: { list: [{ id: 35, name: "北馆", levels: 1, isValid: 1 }] } },
    "/api.php/v3areas/35": { data: { list: { childArea: [{ id: 37, name: "二层", isValid: 1, TotalCount: 40, UnavailableSpace: 10 }] } } },
    "/api.php/v3areadays/96": { data: { list: [{ id: 1, day: { date: "2026-11-24" }, startTime: "08:00", endTime: "22:00" }] } },
    "/api.php/areadays/96": { data: { list: [{ id: 1, day: "2026-11-24", startTime: "08:00", endTime: "22:00" }] } },
    "/api.php/spaces_old": { data: { list: [{ id: 5122, name: "A001", status: 1 }] } },
    "/api.php/profile/books/": { data: { list: [{ id: 9, title: "座位预约", status: 2 }] } },
  };
  const { api } = apiWith({ read: path => payloads[path] || (path.startsWith("/api.php/spaces_old") ? payloads["/api.php/spaces_old"] : { data: { list: [] } }) });
  assert.equal((await api.libraries()).libraries[0].name, "北馆");
  assert.equal((await api.floors(35)).floors[0].name, "二层");
  assert.equal((await api.areas(35)).areas[0].name, "二层");
  assert.equal((await api.days(96)).days[0].date, "2026-11-24");
  assert.equal((await api.segments(96)).segments.length, 1);
  const seats = await api.seats(96, "2026-11-24");
  assert.equal(seats.seats.length, 1);
  assert.equal((await api.bookings()).bookings[0].id, 9);

  const empty = apiWith({ read: () => ({ data: { list: [] } }) }).api;
  await assert.rejects(() => empty.libraries(), (error) => error.code === "SEAT_EMPTY");
  await assert.rejects(() => empty.floors(35), (error) => error.code === "SEAT_EMPTY");
  await assert.rejects(() => empty.segments(96), (error) => error.code === "SEAT_EMPTY");
  await assert.rejects(() => empty.seats(96), (error) => error.code === "SEAT_EMPTY");
  await assert.rejects(() => empty.areas(0), (error) => error.code === "ARGUMENT_REQUIRED");
  await assert.rejects(() => empty.days(0), (error) => error.code === "ARGUMENT_REQUIRED");
});

test("预约规则：数组与空文本", async () => {
  const { api } = apiWith({ browser: fakeBrowser(fakePage({ url: SEAT + "/web/seat3", token: true, rules: ["每日 06:00-23:00 可约", "当日或次日"] })) });
  const rules = await api.rules();
  assert.deepEqual(rules.window, { open: "06:00", close: "23:00" });
  assert.equal(rules.sameDayOrNext, true);
  const empty = apiWith({ browser: fakeBrowser(fakePage({ url: SEAT + "/web/seat3", token: true, rules: "" })) }).api;
  await assert.rejects(() => empty.rules(), (error) => error.code === "SEAT_EMPTY");
});
const seatState = extra => ({ url: SEAT + "/web/seat3", token: true, ...extra });

test("预约提交：页面令牌优先于 cookie，表单字段与站点一致", async () => {
  const submitted = [];
  const page = fakePage(seatState({
    cookies: [{ name: "access_token", value: "jar-token" }, { name: "userid", value: "jar-user" }],
    credentials: { token: "page-token", userid: "page-user" },
    bookResponse: arg => { submitted.push(arg); return { status: 200, json: { status: 1, msg: "预约成功" } }; },
  }));
  const { api } = apiWith({ browser: fakeBrowser(page), probe: async () => ({ verified: true }) });
  const result = await api.reserve({ space: 5122, segment: 7, day: "2026-11-24" });
  assert.equal(result.ok, true);
  assert.equal(result.space, 5122);
  const form = new URLSearchParams(submitted[0].form);
  assert.equal(form.get("access_token"), "page-token");
  assert.equal(form.get("userid"), "page-user");
  assert.equal(form.get("segment"), "7");
  assert.equal(form.get("type"), "1");
  assert.equal(form.get("operateChannel"), "2");
});

test("预约提交：页面没有令牌时退回 cookie，缺两者则要求重新登录", async () => {
  const page = fakePage(seatState({
    credentials: {},
    cookies: [{ name: "access_token", value: "jar-token" }, { name: "userid", value: "jar-user" }],
    bookResponse: () => ({ status: 200, json: { status: 1 } }),
  }));
  const { api } = apiWith({ browser: fakeBrowser(page), probe: async () => ({ verified: true }) });
  assert.equal((await api.reserve({ space: 1, segment: 2 })).ok, true);

  const missing = apiWith({ browser: fakeBrowser(fakePage(seatState({ credentials: {}, cookies: [] })), ), probe: async () => ({ verified: true }) }).api;
  await assert.rejects(() => missing.reserve({ space: 1, segment: 2 }), (error) => error.code === "SEAT_LOGIN_REQUIRED");
  await assert.rejects(() => missing.reserve({ space: 0, segment: 2 }), (error) => error.code === "ARGUMENT_REQUIRED");
  await assert.rejects(() => missing.reserve({ space: 1, segment: 0 }), (error) => error.code === "ARGUMENT_REQUIRED");
});

test("预约提交：非 JSON、登录过期与占用文案都如实映射", async () => {
  const nonJson = apiWith({ browser: fakeBrowser(fakePage(seatState({ bookResponse: () => ({ status: 500, json: null }) }))), probe: async () => ({ verified: true }) }).api;
  await assert.rejects(() => nonJson.reserve({ space: 1, segment: 2 }), (error) => error.code === "SEAT_BAD_RESPONSE");

  const expired = apiWith({ browser: fakeBrowser(fakePage(seatState({ bookResponse: () => ({ status: 200, json: { status: 0, msg: "没有登录" } }) }))), probe: async () => ({ verified: true }) }).api;
  await assert.rejects(() => expired.reserve({ space: 1, segment: 2 }), (error) => error.code === "SEAT_LOGIN_REQUIRED");

  const taken = apiWith({ browser: fakeBrowser(fakePage(seatState({ bookResponse: () => ({ status: 200, json: { status: 0, msg: "座位已被预约" } }) }))), probe: async () => ({ verified: true }) }).api;
  const takenResult = await taken.reserve({ space: 1, segment: 2 });
  assert.equal(takenResult.ok, false);
  assert.equal(takenResult.code, "SEAT_TAKEN");
});

test("预约重试：登录后若已有记录则对账，不重复下单", async () => {
  let attempt = 0;
  const page = fakePage(seatState({
    bookResponse: () => { attempt += 1; return attempt === 1 ? { status: 200, json: { status: 0, msg: "没有登录" } } : { status: 200, json: { status: 1 } }; },
  }));
  const read = path => path === "/api.php/profile/books/" ? { data: { list: [{ id: 88, status: 2, endTime: { date: "2026-11-24T22:00" } }] } } : { data: { list: [] } };
  const { api } = apiWith({ browser: fakeBrowser(page), read, probe: async () => ({ verified: true }) });
  const result = await api.reserve({ space: 1, segment: 2, day: "2026-11-24" });
  assert.equal(result.reconciled, true);
  assert.equal(result.bookingId, 88);
  assert.equal(attempt, 1, "对账后不再第二次下单");

  let retryAttempt = 0;
  const retryPage = fakePage(seatState({ bookResponse: () => { retryAttempt += 1; return retryAttempt === 1 ? { status: 200, json: { status: 0, msg: "没有登录" } } : { status: 200, json: { status: 1, msg: "预约成功" } }; } }));
  const retry = apiWith({ browser: fakeBrowser(retryPage), read: () => ({ data: { list: [] } }), probe: async () => ({ verified: true }) }).api;
  const retried = await retry.reserve({ space: 1, segment: 2 });
  assert.equal(retried.ok, true);
  assert.equal(retryAttempt, 2, "没有既有记录时重新提交一次");
});

test("取消预约：成功、登录过期后重试与参数校验", async () => {
  const ok = apiWith({ browser: fakeBrowser(fakePage(seatState({ cancelResponse: () => ({ status: 1, msg: "已取消" }) }))), probe: async () => ({ verified: true }) }).api;
  const result = await ok.cancel(66);
  assert.equal(result.id, 66);
  assert.equal(result.ok, true);

  let calls = 0;
  const retryPage = fakePage(seatState({ cancelResponse: () => { calls += 1; return calls === 1 ? { status: 0, msg: "登录已超时" } : { status: 1, msg: "已取消" }; } }));
  const retry = apiWith({ browser: fakeBrowser(retryPage), probe: async () => ({ verified: true }) }).api;
  assert.equal((await retry.cancel(66)).ok, true);
  assert.equal(calls, 2);

  const invalid = apiWith({ browser: fakeBrowser(fakePage(seatState({}))), probe: async () => ({ verified: true }) }).api;
  await assert.rejects(() => invalid.cancel(0), (error) => error.code === "ARGUMENT_REQUIRED");
  await assert.rejects(() => invalid.cancel("abc"), (error) => error.code === "ARGUMENT_REQUIRED");
});
