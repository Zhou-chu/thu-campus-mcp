import assert from "node:assert/strict";
import test from "node:test";
import { createSeatLogin, createSeatReader, createSeatReadSession, SeatError } from "../lib/app/seat-read.mjs";
import { chooseSeatSegment } from "../lib/app/seat.mjs";

test("seat login: uses verified active snapshot without opening a browser; network failure never resets it", async () => {
  for (const state of ["ready", "unknown"]) {
    const login = createSeatLogin({ probe: async () => ({ state, verified: state === "ready" }), open: () => assert.fail("must not open browser") });
    const result = await login();
    assert.equal(result.ok, state === "ready");
    if (!result.ok) assert.equal(result.code, "PROBE_FAILED");
  }
});

test("seat login: confirmed expiry triggers one reset and requires a protected response before checkpoint", async () => {
  for (const result of [{ ok: true }, { ok: false, code: "CAS_CAPTCHA_REQUIRED" }, { ok: true, failProbe: true }]) {
    const steps = [];
    let checks = 0;
    const login = createSeatLogin({
      probe: async () => ({ state: "login-required" }),
      open: fn => fn({ browser: { checkpoint: async () => { steps.push("checkpoint"); } } }),
      verify: async () => { steps.push("verify"); if (++checks === 1 || result.failProbe) throw new SeatError("SEAT_LOGIN_REQUIRED", "expired"); },
      reset: async () => { steps.push("reset"); },
      authenticate: async () => { steps.push("authenticate"); return result; },
    });
    const [a, b] = await Promise.all([login(), login()]);
    assert.equal(a, b);
    assert.deepEqual(steps, ["verify", "reset", "authenticate", ...(result.ok ? ["verify"] : []), ...(result.ok && !result.failProbe ? ["checkpoint"] : [])]);
    assert.equal(a.ok, result.ok && !result.failProbe);
  }
});

const validPayload = { status: 1, data: { list: [] } };
const seatCookie = { domain: "seat.lib.tsinghua.edu.cn", expires: -1, path: "/", name: "seat", value: "session" };

test("seat read: skips snapshots for the public catalog and scopes authenticated requests", async () => {
  let copies = 0;
  const calls = [];
  const reader = createSeatReader({
    now: () => 1000,
    snapshot: async () => {
      copies += 1;
      return { cookies: [seatCookie,
        { ...seatCookie, domain: "id.tsinghua.edu.cn", name: "cas" },
        { ...seatCookie, expires: 0, name: "expired" },
        { ...seatCookie, path: "/web", name: "other" },
        { ...seatCookie, value: "x; y=z", name: "bad" },
        { ...seatCookie, path: "/api.php", value: "specific" },
      ] };
    },
    fetchImpl: async (url, init) => {
      calls.push([url.pathname, init.headers.cookie, init.redirect]);
      return Response.json(validPayload);
    },
  });
  await (await reader({ authenticated: false }))("/api.php/areas/1/tree/1");
  assert.equal(copies, 0);
  const call = await reader();
  await call("/api.php/v3areas/35");
  await assert.rejects(() => call("https://example.com/api.php/v3areas/35"), { code: "SEAT_INVALID_ROUTE" });
  await assert.rejects(() => call("/f/login"), { code: "SEAT_INVALID_ROUTE" });
  assert.deepEqual(calls, [["/api.php/areas/1/tree/1", undefined, "manual"], ["/api.php/v3areas/35", "seat=specific; seat=session", "manual"]]);
});

test("seat read: concurrent expired requests share one recovery and retry only once", async () => {
  let recoveries = 0;
  let snapshots = 0;
  const run = createSeatReadSession({
    createReader: async () => {
      snapshots += 1;
      const old = recoveries === 0;
      return async () => {
        if (old) throw new SeatError("SEAT_LOGIN_REQUIRED", "expired");
        return validPayload;
      };
    },
    refresh: async () => { recoveries += 1; return { ok: true }; },
  });
  const read = ({ call }) => call("/api.php/v3areas/35");
  assert.deepEqual(await Promise.all([run(read), run(read)]), [validPayload, validPayload]);
  assert.equal(recoveries, 1);
  assert.equal(snapshots, 4);
});

test("seat read: login failures are not success; transient failures don't trigger login", async () => {
  const states = [];
  let refreshes = 0;
  let response = () => Response.json({ status: 0, msg: "没有登录或登录已超时" });
  const run = createSeatReadSession({
    createReader: createSeatReader({ snapshot: async () => ({ cookies: [seatCookie] }), fetchImpl: async () => response() }),
    refresh: async () => { refreshes += 1; return { ok: false, code: "SEAT_CLOSED", message: "未开放" }; },
    onState: state => states.push(state),
  });
  const read = ({ call }) => call("/api.php/v3areas/35");
  await assert.rejects(() => run(read), { code: "SEAT_CLOSED" });
  response = () => new Response("offline", { status: 503 });
  await assert.rejects(() => run(read), { code: "SEAT_BAD_RESPONSE" });
  response = () => { throw new Error("timeout"); };
  await assert.rejects(() => run(read), { code: "SEAT_UNREACHABLE" });
  assert.deepEqual(states, ["expired"]);
  assert.equal(refreshes, 1);
});

test("seat: 同一天多个时段时可按 segment 选择，默认取第一个", () => {
  const day = "2026-12-01";
  const checked = new Date("2026-11-30T02:00:00.000Z");
  const dayList = [
    { id: 11, day, start: "08:00", end: "12:00" },
    { id: 12, day, start: "13:00", end: "18:00" },
  ];
  assert.equal(chooseSeatSegment(dayList, day, "", checked).match.segment.id, 11);
  assert.equal(chooseSeatSegment(dayList, day, "12", checked).match.segment.id, 12);
  assert.deepEqual(chooseSeatSegment(dayList, day, "", checked).candidates.map(item => item.segment.id), [11, 12]);
  assert.throws(() => chooseSeatSegment(dayList, day, "99", checked), { code: "SEAT_SEGMENT_INVALID" });
  assert.throws(() => chooseSeatSegment([], day, "", checked), { code: "SEAT_EMPTY" });
});

test("座位只读：登录页或跳转识别为会话失效，触发一次性恢复", async () => {
  const { createSeatReader, createSeatReadSession, SeatError } = await import("../lib/app/seat-read.mjs");
  const snapshot = async () => ({ cookies: [{ domain: "seat.lib.tsinghua.edu.cn", path: "/", name: "access_token", value: "t", expires: -1 }] });
  const html = () => new Response("<html>统一身份认证</html>", { status: 200, headers: { "content-type": "text/html" } });
  const reader = createSeatReader({ snapshot, fetchImpl: async () => html() });
  await assert.rejects(async () => (await reader())( "/api.php/v3areas/35"), (error) => error instanceof SeatError && error.code === "SEAT_LOGIN_REQUIRED");

  const redirect = createSeatReader({ snapshot, fetchImpl: async () => new Response("", { status: 302, headers: { location: "https://id.tsinghua.edu.cn/do/off/ui/auth/login" } }) });
  await assert.rejects(async () => (await redirect())( "/api.php/v3areas/35"), (error) => error.code === "SEAT_LOGIN_REQUIRED");

  const elsewhere = createSeatReader({ snapshot, fetchImpl: async () => new Response("", { status: 302, headers: { location: "https://proxy.example/x" } }) });
  await assert.rejects(async () => (await elsewhere())( "/api.php/v3areas/35"), (error) => error.code === "SEAT_BAD_RESPONSE");

  // 恢复只发起一次，并且只重试只读查询。
  let refreshes = 0;
  let calls = 0;
  const session = createSeatReadSession({
    createReader: () => async () => {
      calls += 1;
      if (calls === 1) throw new SeatError("SEAT_LOGIN_REQUIRED", "会话已失效");
      return { data: { ok: true } };
    },
    refresh: async () => { refreshes += 1; return { ok: true }; },
  });
  const result = await session(async ({ call }) => call("/api.php/v3areas/35"));
  assert.deepEqual(result, { data: { ok: true } });
  assert.equal(refreshes, 1, "只恢复一次");
  assert.equal(calls, 2, "恢复后只重试一次");
});

test("座位规则：优先从页面 HTML 解析，不发浏览器；Cookie 过期仍判为需要登录", async () => {
  const { createSeatPageReader, parseSeatBookRule } = await import("../lib/app/seat-read.mjs");
  assert.equal(parseSeatBookRule('<script>window.ska={bookRule:["08:00-22:00 可预约"]}</script>'), "08:00-22:00 可预约");
  assert.equal(parseSeatBookRule('<script>window.ska={bookRule:"单次最长 4 小时"}</script>'), "单次最长 4 小时");
  assert.equal(parseSeatBookRule("<html>没有规则</html>"), "");
  assert.equal(parseSeatBookRule("bookRule: not-json"), "");

  const snapshot = async () => ({ cookies: [{ domain: "seat.lib.tsinghua.edu.cn", path: "/", name: "access_token", value: "t", expires: -1 }] });
  let requested = "";
  const reader = createSeatPageReader({ snapshot, fetchImpl: async url => { requested = String(url); return new Response('<script>window.ska={bookRule:["07:00-23:00"]}</script>', { status: 200 }); } });
  assert.equal(await reader(), "07:00-23:00");
  assert.match(requested, /seat\.lib\.tsinghua\.edu\.cn\/web\/seat3/);

  const expired = createSeatPageReader({ snapshot, fetchImpl: async () => new Response("", { status: 401 }) });
  await assert.rejects(() => expired(), error => error.code === "SEAT_LOGIN_REQUIRED");
  const noCookie = createSeatPageReader({ snapshot: async () => ({ cookies: [] }), fetchImpl: async () => new Response("", { status: 200 }) });
  await assert.rejects(() => noCookie(), error => error.code === "SEAT_LOGIN_REQUIRED");
});
