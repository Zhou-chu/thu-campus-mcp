import assert from "node:assert/strict";
import test from "node:test";
import { createSeatReader, createSeatReadSession, SeatError } from "../lib/app/seat-read.mjs";

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
