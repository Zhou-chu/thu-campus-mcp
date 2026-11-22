import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { accountPath, loadAccount, saveAccount } from "../lib/app/account.mjs";
import { createLearnxRecovery } from "../lib/app/learnx-recovery.mjs";
import { createSeatLogin, createSeatReader, createSeatReadSession, probeSeatSession, SeatError } from "../lib/app/seat-read.mjs";
import { createSportsReader, createSportsReadRecovery, createSportsSlotReader, normalizeSlots, sportsLoginProof, sportsSessionStatus } from "../lib/app/sports.mjs";

const expire = () => new SeatError("SEAT_LOGIN_REQUIRED", "expired");
const seatPath = "/api.php/v3areas/35";
const readSeat = ({ call }) => call(seatPath);

test("seat proof distinguishes missing cookies, upstream outages, missing data and success", async () => {
  for (const [response, state, code] of [
    [Response.json({ data: [] }), "ready", "VERIFIED"],
    [Response.json({ status: 0, data: null }), "unknown", "PROBE_FAILED"],
    [Response.json({ msg: "请先登录" }, { status: 401 }), "login-required", "SEAT_LOGIN_REQUIRED"],
    [new Response("down", { status: 503 }), "unknown", "PROBE_FAILED"],
  ]) {
    const reader = createSeatReader({ now: () => 1, snapshot: async () => ({ cookies: [
      { name: "live", value: "secure", domain: ".seat.lib.tsinghua.edu.cn", expires: 3000 },
      { name: "later", value: "xyz", domain: "seat.lib.tsinghua.edu.cn", expires: -1 },
    ] }), fetchImpl: async (_url, req) => {
      assert.equal(req.headers.cookie, "live=secure; later=xyz");
      return response;
    } });
    assert.deepEqual(await probeSeatSession({ reader, now: () => 0 }), {
      source: "protected-api:seat-web", state, code, verified: state === "ready", checkedAt: "1970-01-01T00:00:00.000Z",
    });
  }
  const reader = createSeatReader({ snapshot: async () => undefined, fetchImpl: () => assert.fail("no authenticated request without cookies") });
  await assert.rejects((await reader()).bind(null, seatPath), { code: "SEAT_LOGIN_REQUIRED" });
});

test("seat login rechecks the browser and never resets on unknown upstream failures", async () => {
  for (const [browserCode, resultCode] of [[null, null], ["SEAT_UNREACHABLE", "PROBE_FAILED"], ["SEAT_LOGIN_REQUIRED", "SEAT_CLOSED"]]) {
    const events = [];
    const login = createSeatLogin({
      probe: async () => ({ state: "login-required" }),
      open: fn => fn({ browser: { checkpoint: async () => { events.push("checkpoint"); } } }),
      verify: async () => { if (browserCode) throw new SeatError(browserCode, "test"); },
      reset: async () => { events.push("reset"); },
      authenticate: async () => ({ ok: false, code: "SEAT_CLOSED" }),
      onState: state => events.push(state),
    });
    const result = await login();
    assert.equal(result.code ?? null, resultCode);
    assert.deepEqual(events, browserCode === "SEAT_LOGIN_REQUIRED" ? ["reset", "unavailable"] : browserCode ? [] : ["checkpoint", "ready"]);
  }
});

test("seat read does not recover public reads or retry a second expiry", async () => {
  const states = [];
  let attempts = 0;
  const run = createSeatReadSession({ createReader: async () => async () => { throw expire(); },
    refresh: async () => { attempts++; return { ok: true }; }, onState: state => states.push(state) });
  await assert.rejects(() => run(readSeat, { authenticated: false }), { code: "SEAT_LOGIN_REQUIRED" });
  assert.equal(attempts, 0);
  await assert.rejects(() => run(readSeat), { code: "SEAT_LOGIN_REQUIRED" });
  assert.equal(attempts, 1);
  assert.deepEqual(states, ["expired", "expired"]);
});

test("sports reader rejects corrupt credentials and does not recover transport failures", async () => {
  const origin = "https://www.sports.tsinghua.edu.cn";
  for (const raw of ["uncoded", '"invalid whitespace"', "123"]) {
    const snapshot = async () => ({ origins: [{ origin, localStorage: [{ name: "token", value: raw }] }] });
    await assert.rejects(() => createSportsReader({ snapshot, fetchImpl: () => assert.fail("invalid token must not leave host") })("menu"), { code: "SPORTS_SESSION_INVALID" });
    assert.equal((await sportsSessionStatus({ snapshot })).state, "unknown");
  }
  const snapshot = async () => ({ origins: [{ origin, localStorage: [{ name: "token", value: '"safe"' }] }] });
  const reader = createSportsReader({ snapshot, fetchImpl: async () => { throw new Error("socket failure"); } });
  const read = createSportsReadRecovery({ read: reader, login: () => assert.fail("network failure is not expiry") });
  await assert.rejects(() => read("menu"), { code: "SPORTS_UNREACHABLE" });
  const expired = createSportsReadRecovery({ read: async () => ({ status: 401 }), login: async () => undefined });
  await assert.rejects(() => expired("menu"), error => error.code === "SPORTS_LOGIN_REQUIRED" && /需要先登录/.test(error.message));
  assert.equal(sportsLoginProof({ ok: true, data: { success: true, data: { id: 42 } } }).state, "ready");
});

test("sports slots reject unscoped data and distinguish invalid routes and failed discovery", async () => {
  const venue = { sport: "游泳", venue: "馆", date: "2026-12-01" };
  const menu = { ok: true, data: { success: true, data: [{ menuName: "场地预约", childrenVo: [
    { menuName: "游泳", childrenVo: [{ menuName: "馆", uuid: "pool", sceneUseType: 4 }] },
  ] }] } };
  const supportedScope = { ok: true, data: { success: true, data: [{ uuid: "scope" }] } };
  let failed = { status: 500, ok: false };
  const slots = createSportsSlotReader({ read: async name => name === "menu" ? menu : name === "buildings" ? supportedScope : name === "devKinds" ? failed : assert.fail("scope missing") });
  await assert.rejects(() => slots(), { code: "ARGUMENT_REQUIRED" });
  await assert.rejects(() => slots({ ...venue, date: "tomorrow" }), { code: "INVALID_ARGUMENTS" });
  await assert.rejects(() => slots({ ...venue, venue: "其它馆" }), { code: "VENUE_NOT_FOUND" });
  await assert.rejects(() => slots(venue), { code: "SPORTS_API_FAILED" });
  failed = { status: 429, ok: false };
  await assert.rejects(() => slots(venue), { code: "SPORTS_THROTTLED" });
  failed = { ok: true, data: { success: true, data: [{ uuid: " " }] } };
  await assert.rejects(() => slots(venue), { code: "SLOTS_UNAVAILABLE" });
  assert.deepEqual(normalizeSlots({ data: [{ sessionVo: [{ beginDate: 20261201, beginTime: null }] }] }).sessions, []);
  const record = { sessionVo: [{ beginTime: "14:00", endTime: "15:00", reserveStatus: { code: "", reserveStatusReason: "未开放" }, userFeeDetails: [{ amount: 1200 }] }] };
  const data = normalizeSlots({ data: [record] }, { venue: "馆", date: "2026-12-01" }).sessions[0];
  assert.equal(data.site, "馆");
  assert.equal(data.date, undefined);
  assert.equal(data.status, undefined);
  assert.equal(data.statusReason, "未开放");
  assert.equal(data.price, 12);
  assert.equal(data.uuid, "");
  const noDate = createSportsSlotReader({ today: () => "2026-12-01", read: async name => name === "menu" ? menu : name === "slots" ? { ok: true, data: { success: true, data: [record] } } : supportedScope });
  await assert.rejects(() => noDate({ sport: "游泳", venue: "馆" }), { code: "SPORTS_DATE_MISMATCH" });
});

test("learnx no account never submits credentials, and unverified recovery is briefly cached", async () => {
  const seen = [];
  const noAccount = createLearnxRecovery({ restoreSnapshot: async expected => { seen.push(expected); return false; }, login: () => assert.fail("not configured") });
  assert.equal(await noAccount(), false);
  assert.deepEqual(seen, [undefined]);
  let now = 0, calls = 0;
  const verify = createLearnxRecovery({ stateDir: "fixture", now: () => now, readAccount: async () => ({ username: "fixture" }),
    restoreSnapshot: async () => false, login: async () => { calls++; return calls > 1 ? { ok: true } : undefined; } });
  assert.equal(await verify(), false);
  now += 29000;
  assert.equal(await verify(), false);
  assert.equal(calls, 1);
  now += 1001;
  assert.deepEqual(await verify(), { ok: true });
});

test("account ignores malformed legacy records and retains unreadable entries with an actionable error", async t => {
  const dir = await mkdtemp(path.join(tmpdir(), "campus-auth-negative-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const old = path.join(dir, "account.json");
  await writeFile(old, "not-json");
  await writeFile(path.join(dir, "seat-credentials.json"), JSON.stringify({ username: "fixture" }));
  assert.equal(await loadAccount(dir), null);
  assert.equal(await readFile(old, "utf8"), "not-json");
  await mkdir(accountPath(dir));
  await assert.rejects(() => loadAccount(dir), { code: "EISDIR" });
  await assert.rejects(() => saveAccount({ username: "fixture", password: "fixture" }, dir), { code: "ACCOUNT_STORAGE" });
  assert.equal(await readFile(old, "utf8"), "not-json");
});

test("account saves the protected replacement but reports legacy cleanup errors", { skip: process.platform !== "win32" }, async t => {
  const dir = await mkdtemp(path.join(tmpdir(), "campus-auth-cleanup-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const old = path.join(dir, "account.json");
  await mkdir(old);
  await assert.rejects(() => saveAccount({ username: "fixture", password: "fixture" }, dir), { code: "ACCOUNT_LEGACY_CLEANUP" });
  assert.ok((await readFile(accountPath(dir))).length > 0);
  await assert.rejects(() => loadAccount(dir), { code: "ACCOUNT_LEGACY_CLEANUP" });
});
