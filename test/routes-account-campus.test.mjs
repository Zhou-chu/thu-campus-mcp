import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createAccountRoutes } from "../lib/app/routes/account.mjs";
import { createCampusRoutes } from "../lib/app/routes/campus.mjs";

function response() {
  const state = { status: 0, body: undefined };
  const res = {
    writableEnded: false,
    writeHead(status) { state.status = status; },
    end(payload) { state.body = payload ? JSON.parse(payload) : undefined; res.writableEnded = true; },
  };
  return { res, state };
}

const request = ({ method = "GET", url = "/", remote = "127.0.0.1", encrypted = true, headers = {} } = {}) => ({
  method,
  url,
  encrypted,
  headers: { host: "127.0.0.1:8971", ...headers },
  socket: { remoteAddress: remote },
});

async function call(handler, { method = "GET", pathname, body, req } = {}) {
  const { res, state } = response();
  const url = new URL(pathname, "http://127.0.0.1");
  const incoming = req || request({ method });
  if (body !== undefined) incoming.body = body;
  const handled = await handler(incoming, res, { pathname: url.pathname, method, url });
  return { handled, status: state.status, body: state.body };
}

async function withDir(run) {
  const dir = await mkdtemp(path.join(tmpdir(), "routes-account-"));
  try {
    return await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("账号路由：读写删与明文远程保护", async () => {
  await withDir(async stateDir => {
    const config = { stateDir, host: "0.0.0.0" };
    const bodies = [];
    const handler = createAccountRoutes({
      config,
      loginAll: async () => ({ ok: true, results: [] }),
      readBody: async req => (bodies.shift() || req.body || {}),
    });

    const empty = await call(handler, { pathname: "/api/account" });
    assert.equal(empty.status, 200);
    assert.equal(empty.body.configured, false);

    // 明文远程不许提交密码。
    const blocked = await call(handler, {
      method: "PUT",
      pathname: "/api/account",
      req: request({ method: "PUT", remote: "203.0.113.9", encrypted: false, headers: { host: "203.0.113.9:8971" } }),
    });
    assert.equal(blocked.status, 403);
    assert.equal(blocked.body.error.code, "ACCOUNT_HTTPS_REQUIRED");

    bodies.push({ username: "2023210001", password: "secret" });
    const saved = await call(handler, { method: "PUT", pathname: "/api/account", req: request({ method: "PUT", encrypted: false, remote: "127.0.0.1" }) });
    assert.equal(saved.status, 200);
    assert.equal(saved.body.configured, true);
    assert.match(saved.body.masked, /\*/);

    bodies.push({ username: "", password: "" });
    const invalid = await call(handler, { method: "PUT", pathname: "/api/account" });
    assert.equal(invalid.status, 400);
    assert.equal(typeof invalid.body.error.code, "string");

    const read = await call(handler, { pathname: "/api/account" });
    assert.equal(read.body.configured, true);

    const loginOk = await call(handler, { method: "POST", pathname: "/api/account/login" });
    assert.equal(loginOk.status, 200);
    assert.equal(loginOk.body.ok, true);

    const removed = await call(handler, { method: "DELETE", pathname: "/api/account" });
    assert.equal(removed.status, 200);
    assert.equal(removed.body.configured, false);
  });
});

test("账号路由：批量登录失败与账号未配置走登录契约", async () => {
  await withDir(async stateDir => {
    const config = { stateDir, host: "127.0.0.1" };
    const failing = createAccountRoutes({
      config,
      loginAll: async () => ({ ok: false, results: [] }),
      readBody: async () => ({}),
    });
    const failed = await call(failing, { method: "POST", pathname: "/api/account/login" });
    assert.equal(failed.body.ok, false);
    assert.equal(failed.body.error.code, "LOGIN_FAILED");
    assert.equal(failed.body.error.service, "all");

    const unconfigured = createAccountRoutes({
      config,
      loginAll: async () => { throw Object.assign(new Error("请先配置清华账号"), { code: "ACCOUNT_NOT_CONFIGURED" }); },
      readBody: async () => ({}),
    });
    const rejected = await call(unconfigured, { method: "POST", pathname: "/api/account/login" });
    assert.equal(rejected.body.ok, false);
    assert.match(rejected.body.error.message, /清华账号/);
  });
});

test("GitLab 路由：未配置时如实提示，保存后掩码展示", async () => {
  await withDir(async stateDir => {
    const config = { stateDir, host: "127.0.0.1" };
    const bodies = [];
    const handler = createAccountRoutes({
      config,
      loginAll: async () => ({ ok: true }),
      readBody: async () => bodies.shift() || {},
    });

    const current = await call(handler, { pathname: "/api/gitlab/config" });
    assert.equal(current.status, 200);
    assert.equal(current.body.configured, false);

    const test = await call(handler, { method: "POST", pathname: "/api/gitlab/test" });
    assert.equal(test.status, 409);
    assert.equal(test.body.error.code, "GITLAB_NOT_CONFIGURED");

    bodies.push({ baseUrl: "https://git.tsinghua.edu.cn", token: "glpat-abcdefghijklmnop" });
    const saved = await call(handler, { method: "PUT", pathname: "/api/gitlab/config" });
    assert.equal(saved.status, 200);
    assert.equal(saved.body.configured, true);
    assert.match(saved.body.masked, /\*/);

    bodies.push({ baseUrl: "not-a-url", token: "" });
    const invalid = await call(handler, { method: "PUT", pathname: "/api/gitlab/config" });
    assert.equal(invalid.status, 400);
    assert.equal(typeof invalid.body.error.code, "string");

    assert.equal(await handler(request(), response().res, { pathname: "/api/unknown", method: "GET", url: new URL("http://x/api/unknown") }), false);
  });
});

function campusFixture(overrides = {}) {
  class SeatError extends Error { constructor(code, message) { super(message); this.code = code; } }
  class SportsError extends Error { constructor(code, message) { super(message); this.code = code; } }
  class BookingError extends Error { constructor(code, message) { super(message); this.code = code; } }
  const seatErrors = [];
  const issued = [];
  const consumed = [];
  const base = {
    seat: {
      libraries: async () => ({ libraries: [] }),
      floors: async () => ({ floors: [] }),
      areas: async () => ({ areas: [] }),
      rules: async () => ({ rules: [] }),
      segments: async () => ({ segments: [] }),
      days: async () => ({ days: [] }),
      seats: async () => ({ seats: [] }),
      sections: async () => ({ sections: [] }),
      bookings: async () => ({ bookings: [] }),
      ...overrides.seat,
    },
    sports: {
      list: async () => ({ sports: [] }),
      venues: async () => ({ venues: [] }),
      scenes: async () => ({ scenes: [] }),
      available: async () => ({ slots: [] }),
      slots: async () => ({ slots: [] }),
      reservations: async () => ({ reservations: [] }),
      ...overrides.sports,
    },
    confirmations: {
      issue: (scope, canonical) => { issued.push({ scope, canonical }); return { token: "tok", expiresAt: "2026-11-22T00:00:00.000Z" }; },
      consume: (token, scope, canonical) => { consumed.push({ token, scope, canonical }); return overrides.approve === true; },
    },
    canonicalJson: value => JSON.stringify(value),
    readBody: async req => req?.body ?? overrides.body ?? {},
    loadAccount: async () => overrides.account ?? { username: "u", password: "p" },
    seatLogin: async () => (typeof overrides.seatLogin === "function" ? overrides.seatLogin() : overrides.seatLogin ?? { ok: true, verified: true }),
    sportsLogin: async () => overrides.sportsLogin ?? ({ ok: true }),
    seatReserve: async () => overrides.seatReserve ?? ({ ok: true, message: "已预约" }),
    sportsReserve: async () => (typeof overrides.sportsReserve === "function" ? overrides.sportsReserve() : overrides.sportsReserve ?? { ok: true, message: "已预约" }),
    prepareBooking: async () => {
      if (overrides.bookingError) throw new BookingError(overrides.bookingError.code, overrides.bookingError.message);
      return overrides.booking ?? ({ prepared: true });
    },
    bookingStatus: () => overrides.bookingStatus ?? ({ state: "idle" }),
    closeBooking: async () => overrides.closeBooking ?? ({ closed: true }),
    SeatError,
    SportsError,
    BookingError,
  };
  return { base, issued, consumed, seatErrors };
}

test("体育预约历史：返回列表，未登录映射 401", async () => {
  const ok = campusFixture({ sports: { reservations: async () => ({ reservations: [{ id: "r1", site: "游泳馆" }] }) } });
  const okCall = await call(createCampusRoutes(ok.base), { pathname: "/api/sports/reservations" });
  assert.equal(okCall.status, 200);
  assert.equal(okCall.body.reservations[0].site, "游泳馆");

  const expired = campusFixture({ sports: { reservations: async () => { throw new expired.base.SportsError("SPORTS_LOGIN_REQUIRED", "需要登录"); } } });
  const expiredCall = await call(createCampusRoutes(expired.base), { pathname: "/api/sports/reservations" });
  assert.equal(expiredCall.status, 401);
});

test("座位多时段与取消：segment 透传，取消需要一次性确认", async () => {
  const seen = [];
  const fixture = campusFixture({ seat: { seats: async (...args) => { seen.push(args); return { seats: [], segments: [{ id: 12, start: "13:00", end: "18:00" }] }; }, cancel: async id => ({ id, cancelled: true }) } });
  const handler = createCampusRoutes(fixture.base);
  const query = await call(handler, { pathname: "/api/seat/seats?section=96&date=2026-12-01&segment=12" });
  assert.equal(query.status, 200);
  assert.deepEqual(seen[0], ["96", "2026-12-01", "12"]);

  const missing = await call(handler, { method: "POST", pathname: "/api/seat/bookings/cancel/prepare", body: {} });
  assert.equal(missing.status, 400);
  const prepared = await call(handler, { method: "POST", pathname: "/api/seat/bookings/cancel/prepare", body: { id: 7 } });
  assert.equal(prepared.status, 200);
  const denied = await call(handler, { method: "POST", pathname: "/api/seat/bookings/cancel", body: { id: 7 } });
  assert.equal(denied.status, 428);
  fixture.base.confirmations.consume = () => true;
  const cancel = await call(createCampusRoutes(fixture.base), { method: "POST", pathname: "/api/seat/bookings/cancel", body: { id: 7 } });
  assert.equal(cancel.status, 200);
  assert.equal(cancel.body.cancelled, true);
});

test("座位取消：拒绝、登录失效与结果未知分别映射，未确认不写", async () => {
  const confirmed = () => {
    const fixture = campusFixture();
    fixture.base.confirmations.consume = () => true;
    return fixture.base;
  };

  const refused = confirmed();
  refused.seat.cancel = async () => { throw new refused.SeatError("SEAT_CANCEL_FAILED", "无效的预约"); };
  const refusedCall = await call(createCampusRoutes(refused), { method: "POST", pathname: "/api/seat/bookings/cancel", body: { id: 7 } });
  assert.equal(refusedCall.status, 409);
  assert.equal(refusedCall.body.error.code, "SEAT_CANCEL_FAILED");

  const unknown = confirmed();
  unknown.seat.cancel = async () => { throw new unknown.SeatError("SEAT_CANCEL_UNKNOWN", "结果未知，请核对"); };
  const unknownCall = await call(createCampusRoutes(unknown), { method: "POST", pathname: "/api/seat/bookings/cancel", body: { id: 7 } });
  assert.equal(unknownCall.status, 502);
  assert.equal(unknownCall.body.error.code, "SEAT_CANCEL_UNKNOWN");
  assert.equal(unknownCall.body.ok, false, "结果未知不能报成功");

  const expired = confirmed();
  expired.seat.cancel = async () => { throw new expired.SeatError("SEAT_LOGIN_REQUIRED", "登录已过期"); };
  const expiredCall = await call(createCampusRoutes(expired), { method: "POST", pathname: "/api/seat/bookings/cancel", body: { id: 7 } });
  assert.equal(expiredCall.status, 401);

  let writes = 0;
  const unconfirmed = campusFixture();
  unconfirmed.base.seat.cancel = async () => { writes += 1; return { id: 7, cancelled: true }; };
  const denied = await call(createCampusRoutes(unconfirmed.base), { method: "POST", pathname: "/api/seat/bookings/cancel", body: { id: 7 } });
  assert.equal(denied.status, 428);
  assert.equal(writes, 0, "没有一次性确认就不能调用取消");
});

test("座位预约记录：返回列表，登录失效与浏览器忙分别映射", async () => {
  const ok = campusFixture({ seat: { bookings: async () => ({ bookings: [{ id: 1, title: "北馆 A001", status: 2 }] }) } });
  const okCall = await call(createCampusRoutes(ok.base), { pathname: "/api/seat/bookings" });
  assert.equal(okCall.status, 200);
  assert.equal(okCall.body.bookings[0].title, "北馆 A001");

  const expired = campusFixture();
  expired.base.seat.bookings = async () => { throw new expired.base.SeatError("SEAT_LOGIN_REQUIRED", "登录已过期"); };
  const expiredCall = await call(createCampusRoutes(expired.base), { pathname: "/api/seat/bookings" });
  assert.equal(expiredCall.status, 401);

  const busy = campusFixture();
  busy.base.seat.bookings = async () => { throw new busy.base.SeatError("BROWSER_BUSY", "浏览器忙"); };
  const busyCall = await call(createCampusRoutes(busy.base), { pathname: "/api/seat/bookings" });
  assert.equal(busyCall.status, 409);
});

test("座位与体育：参数校验、二次确认与错误码映射", async () => {
  const { base, issued, consumed } = campusFixture({ body: {} });
  const handler = createCampusRoutes(base);

  const missingSeat = await call(handler, { method: "POST", pathname: "/api/seat/reserve/prepare" });
  assert.equal(missingSeat.status, 400);

  const seatPrepared = await call(handler, { method: "POST", pathname: "/api/seat/reserve/prepare", body: { space: 12, segment: 3 } });
  assert.equal(seatPrepared.status, 200);
  assert.ok(seatPrepared.body.token, "准备接口返回一次性凭证");
  assert.equal(issued.at(-1).scope, "seat-reserve");

  const seatUnconfirmed = await call(handler, { method: "POST", pathname: "/api/seat/reserve" });
  assert.equal(seatUnconfirmed.status, 428);

  const sportsMissing = await call(handler, { method: "POST", pathname: "/api/sports/reserve/prepare" });
  assert.equal(sportsMissing.status, 400);

  const sportsPrepared = await call(handler, {
    method: "POST",
    pathname: "/api/sports/reserve/prepare",
    body: { sceneUuid: "scene-1", siteUuid: "site-1", startTime: "19:00", endTime: "20:00", day: "2026-11-23" },
  });
  assert.equal(sportsPrepared.status, 200);
  assert.equal(issued.at(-1).scope, "sports-reserve");

  const sportsUnconfirmed = await call(handler, { method: "POST", pathname: "/api/sports/reserve" });
  assert.equal(sportsUnconfirmed.status, 428);

  const approved = campusFixture({ approve: true });
  const approvedHandler = createCampusRoutes(approved.base);
  const seatDone = await call(approvedHandler, { method: "POST", pathname: "/api/seat/reserve" });
  assert.equal(seatDone.status, 200);
  assert.equal(approved.consumed.length, 1);
  const sportsDone = await call(approvedHandler, { method: "POST", pathname: "/api/sports/reserve" });
  assert.equal(sportsDone.status, 200);
});

test("座位读取错误按代码映射状态，未知子路径不处理", async () => {
  class SeatError extends Error { constructor(code, message) { super(message); this.code = code; } }
  class SportsError extends Error { constructor(code, message) { super(message); this.code = code; } }
  const { base } = campusFixture();
  base.SeatError = SeatError;
  base.SportsError = SportsError;
  base.seat.libraries = async () => { throw new SeatError("BROWSER_BUSY", "浏览器忙"); };
  base.sports.sports = undefined;
  base.sports.list = async () => { throw new SportsError("SPORTS_THROTTLED", "请求太频繁"); };
  const handler = createCampusRoutes(base);

  const busy = await call(handler, { pathname: "/api/seat/libraries" });
  assert.equal(busy.status, 503);
  assert.equal(busy.body.error.code, "BROWSER_BUSY");

  const throttled = await call(handler, { pathname: "/api/sports/sports" });
  assert.equal(throttled.status, 429);

  const unknownSeat = await handler(request(), response().res, { pathname: "/api/seat/nope", method: "GET", url: new URL("http://x/api/seat/nope") });
  assert.equal(unknownSeat, false);

  const unknownSports = await handler(request(), response().res, { pathname: "/api/sports/nope", method: "GET", url: new URL("http://x/api/sports/nope") });
  assert.equal(unknownSports, false);
});

test("预约写入失败与登录失败如实返回，不冒充成功", async () => {
  class SeatError extends Error { constructor(code, message) { super(message); this.code = code; } }
  class SportsError extends Error { constructor(code, message) { super(message); this.code = code; } }
  const { base } = campusFixture({ approve: true });
  base.SeatError = SeatError;
  base.SportsError = SportsError;
  base.seatReserve = async () => ({ ok: false, code: "SEAT_TAKEN", message: "座位已被占用" });
  base.sportsReserve = async () => { throw new SportsError("SPORTS_LOCK_FAILED", "锁定失败"); };
  base.seatLogin = async () => { throw new SeatError("SEAT_LOGIN_REQUIRED", "需要登录"); };
  base.sportsLogin = async () => { throw new SportsError("SPORTS_LOGIN_FAILED", "登录失败"); };
  base.loadAccount = async () => null;
  const handler = createCampusRoutes(base);

  const seat = await call(handler, { method: "POST", pathname: "/api/seat/reserve" });
  assert.equal(seat.status, 409);
  assert.equal(seat.body.error.code, "SEAT_TAKEN");

  const sports = await call(handler, { method: "POST", pathname: "/api/sports/reserve" });
  assert.equal(sports.status, 409);

  const seatLogin = await call(handler, { method: "POST", pathname: "/api/seat/login" });
  assert.equal(seatLogin.body.ok, false);

  const sportsLogin = await call(handler, { method: "POST", pathname: "/api/sports/login" });
  assert.equal(sportsLogin.body.ok, false);
  assert.match(sportsLogin.body.error.message, /清华账号/);
});

test("预约准备与状态、关闭接口都返回真实数据", async () => {
  const { base } = campusFixture({ booking: { prepared: true, sceneUuid: "s1" }, bookingStatus: { state: "ready" }, closeBooking: { closed: true } });
  const handler = createCampusRoutes(base);
  const prepared = await call(handler, { method: "POST", pathname: "/api/sports/booking/prepare" });
  assert.equal(prepared.status, 200);
  assert.equal(prepared.body.prepared, true);
  assert.deepEqual(prepared.body.status, { state: "ready" });
  const status = await call(handler, { pathname: "/api/sports/booking/status" });
  assert.equal(status.body.state, "ready");
  const closed = await call(handler, { method: "POST", pathname: "/api/sports/booking/close" });
  assert.equal(closed.body.closed, true);

  for (const [code, status] of [["BOOKING_WINDOW_BUSY", 409], ["BOOKING_UNREACHABLE", 503], ["ARGUMENT_REQUIRED", 400]]) {
    const fixture = campusFixture({ bookingError: { code, message: code } });
    const failing = createCampusRoutes(fixture.base);
    const result = await call(failing, { method: "POST", pathname: "/api/sports/booking/prepare" });
    assert.equal(result.status, status, code);
  }
});
test("座位与体育的全部只读端点都能返回真实数据", async () => {
  const { base } = campusFixture();
  const handler = createCampusRoutes(base);
  const seatPaths = ["libraries", "floors", "areas", "rules", "segments", "days", "seats", "sections"];
  for (const name of seatPaths) {
    const result = await call(handler, { pathname: "/api/seat/" + name });
    assert.equal(result.status, 200, name);
    assert.equal(result.body.ok, true, name);
  }
  const sportsPaths = ["sports", "venues", "scenes", "available", "slots"];
  for (const name of sportsPaths) {
    const result = await call(handler, { pathname: "/api/sports/" + name });
    assert.equal(result.status, 200, name);
    assert.equal(result.body.ok, true, name);
  }
});

test("预约准备接受全部可选字段，缺省时给默认运动与场馆", async () => {
  const full = campusFixture();
  const prepared = await call(createCampusRoutes(full.base), {
    method: "POST",
    pathname: "/api/sports/reserve/prepare",
    body: { sceneUuid: "s", siteUuid: "t", startTime: "19:00", endTime: "20:00", siteType: " 泳道 ", members: ["a", "b"], formId: " f1 ", deployUuid: " d1 " },
  });
  assert.equal(prepared.status, 200);
  assert.equal(prepared.body.args.siteType, "泳道");
  assert.deepEqual(prepared.body.args.members, ["a", "b"]);
  assert.equal(prepared.body.args.formId, "f1");
  assert.equal(prepared.body.args.deployUuid, "d1");

  const defaults = campusFixture();
  const fallback = await call(createCampusRoutes(defaults.base), { method: "POST", pathname: "/api/sports/booking/prepare", body: {} });
  assert.equal(fallback.status, 200);
  assert.equal(fallback.body.prepared, true);
});

test("登录成功与未知异常分别返回成功或向上抛出", async () => {
  const ok = campusFixture({ seatLogin: { ok: true, verified: true }, sportsLogin: { ok: true } });
  const handler = createCampusRoutes(ok.base);
  assert.equal((await call(handler, { method: "POST", pathname: "/api/seat/login" })).status, 200);
  assert.equal((await call(handler, { method: "POST", pathname: "/api/sports/login" })).status, 200);

  const seatBoom = campusFixture();
  seatBoom.base.seatLogin = async () => { throw new Error("未预期"); };
  await assert.rejects(() => call(createCampusRoutes(seatBoom.base), { method: "POST", pathname: "/api/seat/login" }), /未预期/);

  const readBoom = campusFixture();
  readBoom.base.seat.libraries = async () => { throw new Error("读取炸了"); };
  await assert.rejects(() => call(createCampusRoutes(readBoom.base), { pathname: "/api/seat/libraries" }), /读取炸了/);

  const sportsBoom = campusFixture();
  sportsBoom.base.sports.list = async () => { throw new Error("体育炸了"); };
  await assert.rejects(() => call(createCampusRoutes(sportsBoom.base), { pathname: "/api/sports/sports" }), /体育炸了/);
});

test("座位预约成功路径返回下单结果", async () => {
  const { base } = campusFixture({ approve: true, seatReserve: { ok: true, message: "已预约 A001" } });
  const result = await call(createCampusRoutes(base), { method: "POST", pathname: "/api/seat/reserve" });
  assert.equal(result.status, 200);
  assert.equal(result.body.message, "已预约 A001");
});

test("体育下单：解锁失败要透传给界面，不能悄悄丢掉", async () => {
  const fixture = campusFixture({
    approve: true,
    body: { sceneUuid: "s1", siteUuid: "site1", day: "2026-12-01", startTime: "19:00", endTime: "20:00", confirmToken: "t" },
    sportsReserve: async () => {
      const error = new fixture.base.SportsError("SPORTS_LOCK_FAILED", "预约窗口没能释放。");
      error.unlock = { ok: false, message: "浏览器仍在占用" };
      throw error;
    },
  });
  const result = await call(createCampusRoutes(fixture.base), { pathname: "/api/sports/reserve", method: "POST", body: fixture.base.body });
  assert.equal(result.status, 409);
  assert.equal(result.body.error.code, "SPORTS_LOCK_FAILED");
  assert.deepEqual(result.body.error.unlock, { ok: false, message: "浏览器仍在占用" }, "解锁结果必须透传");
});

test("体育预约窗口：失败要把原因写进日志，并区分未登录/日期不可用", async () => {
  const fixture = campusFixture({
    body: { sport: "羽毛球", venue: "气膜馆羽毛球", start: "19:00", end: "20:00", date: "2026-12-01" },
    bookingError: { code: "DATE_NOT_AVAILABLE", message: "预约页没有可选日期 2026-12-01，可能尚未开放。" },
  });
  const logged = [];
  fixture.base.logger = (event, detail) => logged.push([event, detail]);
  const result = await call(createCampusRoutes(fixture.base), { pathname: "/api/sports/booking/prepare", method: "POST", body: fixture.base.body });
  assert.equal(result.status, 409);
  assert.equal(result.body.error.code, "DATE_NOT_AVAILABLE");
  assert.match(result.body.error.message, /尚未开放/);
  assert.deepEqual(logged, [["sports-booking-prepare-failed", { code: "DATE_NOT_AVAILABLE" }]]);
});

test("统一登录：POST /api/account/login 把已核验服务作为 skip 传下去", async () => {
  await withDir(async stateDir => {
    const seen = [];
    const handler = createAccountRoutes({
      config: { stateDir, host: "0.0.0.0" },
      loginAll: async options => { seen.push(options); return { ok: true, total: 2, ready: 2, results: {} }; },
      readBody: async () => ({ skip: ["seat", 42, "sports", "learnx"] }),
    });
    const result = await call(handler, { pathname: "/api/account/login", method: "POST" });
    assert.equal(result.status, 200);
    assert.deepEqual(seen[0].skip, ["seat", "sports", "learnx"], "只接受字符串");
  });
});

test("座位登录：浏览器被占用时返回可执行的 BROWSER_BUSY，而不是笼统 500", async () => {
  const fixture = campusFixture({ seatLogin: async () => { throw Object.assign(new Error("浏览器正被占用（正在执行：open:seat）"), { code: "BROWSER_BUSY" }); } });
  const result = await call(createCampusRoutes(fixture.base), { pathname: "/api/seat/login", method: "POST" });
  assert.equal(result.body.ok, false);
  assert.equal(result.body.error.code, "BROWSER_BUSY");
  assert.match(result.body.error.message, /open:seat/);
});

test("账号变更：凭据变了才回收会话，清除总会回收并返回代际", async () => {
  await withDir(async stateDir => {
    const events = [];
    const resets = [];
    const handler = createAccountRoutes({
      config: { stateDir, host: "127.0.0.1" },
      loginAll: async () => ({ ok: true, results: {} }),
      readBody: async () => ({ username: "2024000000", password: "pass-one" }),
      resetSessions: async () => { resets.push(1); },
      onIdentityChanged: payload => events.push(payload.reason),
    });
    const first = await call(handler, { pathname: "/api/account", method: "PUT" });
    assert.equal(first.status, 200);
    assert.equal(first.body.changed, true);
    assert.equal(resets.length, 1, "身份变化时回收旧会话");
    const same = await call(handler, { pathname: "/api/account", method: "PUT" });
    assert.equal(same.body.changed, false);
    assert.equal(resets.length, 1, "同一组凭据不重复回收");

    const cleared = await call(handler, { pathname: "/api/account", method: "DELETE" });
    assert.equal(cleared.status, 200);
    assert.equal(resets.length, 2, "清除账号必须回收");
    assert.equal(cleared.body.generation, 2, "保存一次 + 清除一次");
    assert.deepEqual(events, ["account-changed", "account-cleared"]);
  });
});
