import assert from "node:assert/strict";
import test from "node:test";
import { reserveRequest, createSportsReader, createSportsReadRecovery, createSportsSlotReader, normalizeDate, normalizeReservations, normalizeSlots, normalizeSportsMenu, sportsLoginProof, sportsSessionStatus } from "../lib/app/sports.mjs";

test("sports: concurrent expired queries recover once and only replay the original reads", async () => {
  let active = false, logins = 0;
  const calls = [];
  const expired = { status: 200, ok: true, data: { success: false, errorCode: 1130002 } };
  const ready = { status: 200, ok: true, data: { success: true } };
  const read = createSportsReadRecovery({
    read: async (name, body) => { calls.push([name, body]); return active ? ready : expired; },
    login: async () => { logins++; active = true; return { ok: true }; },
  });
  assert.equal(await read("user"), expired);
  assert.equal(logins, 0);
  const query = { sceneUuid: "fixture", reserveDate: "2026-11-23" };
  assert.deepEqual(await Promise.all([read("slots", query), read("menu")]), [ready, ready]);
  assert.equal(logins, 1);
  assert.deepEqual(calls, [["user", undefined], ["slots", query], ["menu", undefined], ["slots", query], ["menu", undefined]]);
});

test("sports: no login on throttling or unknown errors; manual verification is not retried immediately", async () => {
  let now = 0, logins = 0, calls = 0, code = 1610001;
  const read = createSportsReadRecovery({
    now: () => now,
    read: async () => { calls++; return { status: 200, ok: true, data: { success: false, errorCode: code } }; },
    login: async () => { logins++; return { ok: false, code: "CAS_CAPTCHA_REQUIRED", message: "Manual check" }; },
  });
  await read("menu");
  code = 0;
  await read("menu");
  assert.equal(logins, 0);
  code = 1130002;
  for (let i = 0; i < 2; i++) await assert.rejects(() => read("menu"), { code: "CAS_CAPTCHA_REQUIRED" });
  assert.equal(logins, 1);
  assert.equal(calls, 4);
  now += 120001;
  await assert.rejects(() => read("menu"), { code: "CAS_CAPTCHA_REQUIRED" });
  assert.equal(logins, 2);
});

test("sports: a recovery followed by another expiry does not recurse", async () => {
  let logins = 0, calls = 0;
  const read = createSportsReadRecovery({
    read: async () => { calls++; return { status: 401, ok: false }; },
    login: async () => { logins++; return { ok: true }; },
  });
  await assert.rejects(() => read("menu"), { code: "SPORTS_LOGIN_REQUIRED" });
  assert.equal(calls, 2);
  assert.equal(logins, 1);
});

test("sports: direct slots require response evidence for the exact date, with no read for unsupported venues", async () => {
  const day = "2026-11-23";
  const menu = { success: true, data: [{ menuName: "场地预约", childrenVo: [
    { menuName: "羽毛球", childrenVo: [{ menuName: "气膜馆", uuid: "scene-a", sceneUseType: 2 }] },
    { menuName: "冰雪运动", childrenVo: [{ menuName: "冰场", uuid: "scene-b", sceneUseType: 6 }] },
  ] }] };
  const calls = [];
  let payload = { success: true, data: [{ siteName: "场地1", sessionVo: [{ beginDate: "20261123", beginTime: "14:00", endTime: "15:00" }] }] };
  const read = async (name, body) => { calls.push({ name, body }); return { ok: true, status: 200, data: name === "menu" ? menu : payload }; };
  const slots = createSportsSlotReader({ read, today: () => day });
  assert.equal((await slots({ sport: "羽毛球", venue: "气膜馆" })).sessions.length, 1);
  assert.deepEqual(calls[1], { name: "slots", body: { sceneUuid: "scene-a", resvKind: "CURRENT_RESERVE", reserveDate: day, siteType: "ROOM", sceneUseType: "SPORT_GROUP", pageNum: 1, pageSize: 99 } });
  await assert.rejects(() => slots({ sport: "羽毛球", venue: "气膜馆", date: "2026-11-24" }), { code: "SPORTS_DATE_MISMATCH" });
  const count = calls.length;
  await assert.rejects(() => slots({ sport: "冰雪运动", venue: "冰场" }), { code: "SPORTS_SLOTS_UNSUPPORTED" });
  assert.equal(calls.length, count + 1);
  payload = { success: true, data: [{ siteName: "场地1" }] };
  await assert.rejects(() => slots({ sport: "羽毛球", venue: "气膜馆" }), { code: "SLOTS_UNAVAILABLE" });
  payload = { success: false, errorCode: 1610001 };
  await assert.rejects(() => slots({ sport: "羽毛球", venue: "气膜馆" }), { code: "SPORTS_THROTTLED" });
});

test("sports: personal swimming sessions use official building and equipment scope and exact date", async () => {
  const day = "2026-11-23";
  const origin = "https://www.sports.tsinghua.edu.cn";
  const calls = [];
  let ambiguous = false;
  const read = createSportsReader({
    snapshot: async () => ({ origins: [{ origin, localStorage: [{ name: "token", value: '"fixture-token"' }] }] }),
    fetchImpl: async (url, request) => {
      const route = new URL(url);
      const path = route.pathname;
      calls.push(path);
      assert.equal(route.origin, origin);
      assert.equal(request.headers["x-api-version"], "2.0.0");
      assert.equal(request.redirect, "manual");
      if (path.endsWith("/menu")) return Response.json({ success: true, data: [{ menuName: "场地预约", childrenVo: [
        { menuName: "游泳", childrenVo: [{ menuName: "陈明游泳馆", uuid: "pool-scene", sceneUseType: 4 }] },
      ] }] });
      if (path.endsWith("/chooseByType")) {
        assert.equal(request.method, "GET");
        assert.deepEqual(Object.fromEntries(route.searchParams), { sceneUuid: "pool-scene", siteType: "BUILDING" });
        return Response.json({ success: true, data: [{ uuid: "pool-building" }, ...(ambiguous ? [{ uuid: "other-building" }] : [])] });
      }
      if (path.endsWith("/devKind/list")) {
        assert.deepEqual(Object.fromEntries(route.searchParams), { uuid: "pool-scene" });
        return Response.json({ success: true, data: [{ uuid: "pool-kind" }] });
      }
      assert.equal(path, "/venue/site/api/reserve/current/page");
      assert.equal(request.method, "POST");
      assert.deepEqual(JSON.parse(request.body), {
        sceneUuid: "pool-scene", resvKind: "CURRENT_RESERVE", reserveDate: day, pageNum: 1, pageSize: 999,
        devKindUuid: "pool-kind", siteType: "DEV", searchValue: "", siteKindId: "", classTypeEnum: "BUILDING", classTypeUuid: "pool-building", sceneUseType: "SPORT_PERSON",
      });
      return Response.json({ success: true, data: [{ siteName: "陈明游泳馆", sessionVo: [
        { beginDate: 20261123, beginTime: "12:00", endTime: "13:00", allowUserNum: 30, resvUserNum: 22, reserveStatus: "Y" },
      ] }] });
    },
  });
  const slots = createSportsSlotReader({ read });
  const selected = { sport: "游泳", venue: "陈明游泳馆", date: day };
  const result = await slots(selected);
  assert.equal(result.sessions.length, 1);
  assert.equal(result.sessions[0].date, day);
  assert.equal(result.sessions[0].status, "Y");
  ambiguous = true;
  await assert.rejects(() => slots(selected), { code: "SLOTS_UNAVAILABLE" });
  assert.equal(calls.filter(path => path.endsWith("/current/page")).length, 1);
});

test("sports: catalogue uses the official versioned group tree, without guessed venue categories", async () => {
  const origin = "https://www.sports.tsinghua.edu.cn";
  const snapshot = async () => ({ origins: [{ origin, localStorage: [{ name: "token", value: '"fixture-token"' }] }] });
  const fetchImpl = async (url, request) => {
    assert.equal(url, origin + "/venue/site/api/site/menu");
    assert.equal(request.headers["x-api-version"], "2.0.0");
    assert.equal(request.redirect, "manual");
    return Response.json({ success: true, data: [
      { menuName: "训练课" }, { menuName: "场地预约", childrenVo: [
        { menuName: "羽毛球", childrenVo: [{ menuName: "气膜馆羽毛球", uuid: "scene-one" }, { menuName: "缺少标识" }] },
        { menuName: "空类别", childrenVo: [] }, {},
      ] },
    ] });
  };
  const read = createSportsReader({ snapshot, fetchImpl });
  assert.deepEqual(normalizeSportsMenu((await read("menu")).data), [{ sport: "羽毛球", venues: [{ name: "气膜馆羽毛球", uuid: "scene-one" }] }]);
  await assert.rejects(() => read("https://other.example"), { code: "INVALID_ARGUMENTS" });
  await assert.rejects(() => createSportsReader({ snapshot: async () => ({}) })("menu"), { code: "SPORTS_LOGIN_REQUIRED" });
  assert.deepEqual(normalizeSportsMenu(null), []);
});

test("sports: status checks only the official origin with its saved token and never returns credentials", async () => {
  const origin = "https://www.sports.tsinghua.edu.cn";
  const snapshot = async () => ({ origins: [
    { origin: "https://other.example", localStorage: [{ name: "token", value: JSON.stringify("unrelated") }] },
    { origin, localStorage: [{ name: "token", value: JSON.stringify("fixture-token") }] },
  ] });
  const fetchImpl = async (url, request) => {
    assert.equal(url, origin + "/venue/site/system/login/getLoginUser");
    assert.deepEqual(request.headers, { token: "fixture-token" });
    assert.equal(request.redirect, "manual");
    assert.equal(request.method, "GET");
    return Response.json({ success: true, data: { id: "fixture-id", token: "not-public" } });
  };
  assert.deepEqual(await sportsSessionStatus({ snapshot, fetchImpl, now: () => 0 }), {
    state: "ready", code: "VERIFIED", verified: true, source: "protected-api:sports-current-user", checkedAt: "1970-01-01T00:00:00.000Z",
  });
  assert.equal((await sportsSessionStatus({ snapshot: async () => undefined, fetchImpl })).state, "unverified");
  assert.equal((await sportsSessionStatus({ snapshot, fetchImpl: async () => Response.redirect("https://other.example") })).state, "unknown");
});

test("sports: HTTP 200 does not make an expired session or missing identity verified", () => {
  assert.deepEqual(sportsLoginProof({ ok: true, status: 200, data: { success: false, errorCode: 1130002 } }), { state: "login-required", code: "SPORTS_LOGIN_REQUIRED" });
  assert.equal(sportsLoginProof({ ok: false, status: 401 }).state, "login-required");
  assert.equal(sportsLoginProof(null).state, "unknown");
  assert.equal(sportsLoginProof({ ok: true, status: 200, data: { success: true, data: {} } }).state, "unknown");
  assert.deepEqual(sportsLoginProof({ ok: true, status: 200, data: { success: true, data: { id: "fixture-user" } } }), { state: "ready", code: "VERIFIED" });
});

test("sports: 日期在紧凑数字与标准格式之间归一", () => {
  assert.equal(normalizeDate(20261117), "2026-11-17");
  assert.equal(normalizeDate("20261117"), "2026-11-17");
  assert.equal(normalizeDate("2026-11-17"), "2026-11-17");
  assert.equal(normalizeDate(""), "");
  assert.equal(normalizeDate(undefined), "");
  assert.equal(normalizeDate("明天"), "");
});

test("sports: 场次解析出时段、余量、状态原因与价格", () => {
  const payload = {
    data: [
      {
        siteName: "羽01",
        sessionVo: [
          {
            uuid: "u1",
            sessionId: "10000018",
            beginTime: "07:00",
            endTime: "08:00",
            beginDate: 20261117,
            allowUserNum: 1,
            resvUserNum: 1,
            reserveStatus: { reserveStatus: "N", reserveStatusReason: "当前场次预约人数已满" },
            userFeeDetails: { chargingMode: "TIME", chargingUnitPrice: 0, payType: "ONLINE" },
          },
          {
            uuid: "u2",
            sessionId: "10000019",
            beginTime: "08:00",
            endTime: "09:00",
            beginDate: 20261117,
            allowUserNum: 4,
            resvUserNum: 1,
            reserveStatus: { reserveStatus: "Y" },
            ruleFeeDetails: [{ fee: 15 }],
          },
          { beginTime: "", endTime: "10:00" },
        ],
      },
    ],
  };
  const { sessions } = normalizeSlots(payload, { venue: "气膜馆羽毛球", date: "2026-11-17" });
  assert.equal(sessions.length, 2, "缺时间的条目被丢弃");
  assert.deepEqual(sessions.map(item => item.begin), ["07:00", "08:00"]);
  assert.equal(sessions[0].site, "羽01");
  assert.equal(sessions[0].status, "N");
  assert.equal(sessions[0].statusReason, "当前场次预约人数已满");
  assert.equal(sessions[0].price, 0, "零元场次保留为 0 而不是 null");
  assert.equal(sessions[0].date, "2026-11-17");
  assert.equal(sessions[1].price, 0.15, "规则费用兜底（分转元）");
  assert.equal(sessions[1].status, "Y");
});

test("sports: 空载荷与缺失字段不抛错", () => {
  assert.deepEqual(normalizeSlots(null, { venue: "x" }).sessions, []);
  assert.deepEqual(normalizeSlots({ data: [{}] }, {}).sessions, []);
  const single = normalizeSlots(
    { data: [{ siteName: "", sessionVo: [{ beginTime: "09:00", endTime: "10:00", reserveStatus: "Y" }] }] },
    { venue: "西体羽毛球(前馆)" },
  );
  assert.equal(single.sessions[0].site, "西体羽毛球(前馆)", "场馆名兜底");
  assert.equal(single.sessions[0].status, "Y", "字符串状态原样保留");
  assert.equal(single.sessions[0].price, null);
});
test("sports: 场景与可约场地归一，缺字段不编造", async () => {
  const { normalizeScenes, normalizeAvailable, buildReservePayload } = await import("../lib/app/sports.mjs");
  const scenes = normalizeScenes({ data: [
    { uuid: "s1", sceneName: "陈明游泳馆", siteType: "ROOM", formRuleVo: { formUuid: "f1" }, beforeReserveDays: ["0", "7"] },
    { uuid: "s2", sceneName: "", sceneEnName: "Gym" },
    { sceneName: "没有 uuid" },
    null,
  ] });
  assert.equal(scenes.length, 2, "缺 uuid 或中英文名都没有的条目不进入结果");
  assert.deepEqual(scenes[0], { uuid: "s1", name: "陈明游泳馆", siteType: "ROOM", formId: "f1", beforeReserveDays: [0, 7] });
  assert.equal(scenes[1].name, "Gym", "没有中文名时回退英文名");

  const loaded = normalizeAvailable({ data: { records: [
    { uuid: "site1", siteName: "1号泳道", siteType: "ROOM", reserveTime: [{ startTime: "2026-11-21 19:00:00", endTime: "2026-11-21 20:00:00" }] },
    { siteName: "没有 uuid" },
    null,
  ] } }, { sceneUuid: "s1", date: "2026-11-21" });
  assert.equal(loaded.sites.length, 1);
  assert.equal(loaded.sites[0].slots[0].available, true);
  assert.equal(loaded.sceneUuid, "s1");

  const payload = buildReservePayload({
    sceneUuid: "s1", siteUuid: "site1", siteType: "ROOM", members: ["u1"],
    startTime: "2026-11-21 19:00:00", endTime: "2026-11-21 20:00:00", formId: "f1",
  });
  assert.deepEqual(payload.reserveTime, [{ startTime: "2026-11-21 19:00:00", endTime: "2026-11-21 20:00:00" }]);
  assert.equal(payload.resvKind, "CURRENT_RESERVE");
  assert.deepEqual(payload.resvMember, ["u1"]);
  assert.equal(payload.formParam.formId, "f1");
  assert.equal("deployUuid" in payload.formParam, false, "没有 deployUuid 时不塞空字段");
});

test("sports: 工具层拒绝缺失参数与未知工具", async () => {
  const { callSportsTool } = await import("../lib/sports/mcp.mjs");
  await assert.rejects(() => callSportsTool("sports_available", {}), error => error.code === "ARGUMENT_REQUIRED");
  await assert.rejects(() => callSportsTool("sports_unknown", {}), error => error.code === "UNKNOWN_TOOL");
});

test("sports: 可约场地兼容数组返回且缺字段时保持诚实", async () => {
  const { normalizeAvailable, normalizeScenes } = await import("../lib/app/sports.mjs");
  const arrayShaped = normalizeAvailable({ data: [
    { uuid: "site9", siteName: "9号场", reserveTime: [{ startTime: "2026-11-21 08:00:00", endTime: "2026-11-21 09:00:00", available: false }] },
  ] }, { sceneUuid: "s9", date: "2026-11-21" });
  assert.equal(arrayShaped.sites.length, 1);
  assert.equal(arrayShaped.sites[0].slots[0].available, false, "不可约时段如实标记");

  const noDays = normalizeScenes({ data: [{ uuid: "s3", sceneName: "健身中心" }] });
  assert.deepEqual(noDays[0].beforeReserveDays, [], "缺 beforeReserveDays 时给空数组");
  assert.equal(noDays[0].formId, undefined, "缺表单 id 时不编造");
});

test("sports: 归一函数的边界分支（缺字段/异形返回/状态为 0）", async () => {
  const { normalizeScenes, normalizeAvailable, buildReservePayload } = await import("../lib/app/sports.mjs");
  // 场景：非对象、双名缺失、beforeReserveDays 非数组
  const scenes = normalizeScenes({ data: [
    5,
    { uuid: "s4" },
    { uuid: "s5", sceneName: "场馆", beforeReserveDays: "not-array" },
  ] });
  assert.equal(scenes.length, 1);
  assert.deepEqual(scenes[0].beforeReserveDays, [], "非数组按空处理");

  // 场地：data 非数组、记录非对象、缺 uuid、reserveTime 非数组、缺 endTime、status=0
  const empty = normalizeAvailable({ data: "bad" }, { sceneUuid: "s", date: "2026-11-21" });
  assert.deepEqual(empty.sites, [], "异形返回不产出场地");

  const mixed = normalizeAvailable({ data: { records: [
    7,
    { siteName: "缺 uuid" },
    { uuid: "site2", reserveTime: "bad" },
    { uuid: "site3", reserveTime: [{ startTime: "2026-11-21 08:00:00" }, { startTime: "2026-11-21 09:00:00", endTime: "2026-11-21 10:00:00", status: 0 }] },
  ] } }, { sceneUuid: "s", date: "2026-11-21" });
  assert.deepEqual(mixed.sites.map(site => site.uuid), ["site2", "site3"]);
  assert.deepEqual(mixed.sites[0].slots, [], "缺 endTime 的时段丢弃");
  assert.equal(mixed.sites[1].slots.length, 1);
  assert.equal(mixed.sites[1].slots[0].available, false, "status=0 视为不可约");

  const withDeploy = buildReservePayload({ sceneUuid: "s", siteUuid: "x", siteType: "ROOM", startTime: "a", endTime: "b", formId: "f", deployUuid: "d1" });
  assert.equal(withDeploy.formParam.deployUuid, "d1", "有 deployUuid 时写入");
});

test("sports: 场地记录使用 siteUuid 别名且缺开始时间的时段丢弃", async () => {
  const { normalizeAvailable } = await import("../lib/app/sports.mjs");
  const result = normalizeAvailable({ data: { records: [
    { siteUuid: "alias-1", siteName: "别名场", reserveTime: [{ endTime: "2026-11-21 10:00:00" }] },
  ] } }, { sceneUuid: "s", date: "2026-11-21" });
  assert.equal(result.sites.length, 1);
  assert.equal(result.sites[0].uuid, "alias-1", "uuid 缺省时回退 siteUuid");
  assert.deepEqual(result.sites[0].slots, [], "缺开始时间的时段丢弃");
});

test("sports: 场次归一覆盖状态对象、费用形态与排序", async () => {
  const { normalizeSlots } = await import("../lib/app/sports.mjs");
  const payload = { data: [
    {
      siteName: "二号场",
      sessionVo: [
        { beginTime: "20:00:00", endTime: "21:00:00", reserveStatus: { reserveStatus: "N", reserveStatusReason: "维护中" }, userFeeDetails: { chargingUnitPrice: 30 }, allowUserNum: 4, resvUserNum: 4 },
        { beginTime: "19:00:00", endTime: "20:00:00", reserveStatus: { code: "Y" }, userFeeDetails: [{ price: 15 }] },
        { beginTime: "19:00:00", endTime: "20:00:00", reserveStatus: "", ruleFeeDetails: [{ amount: 8 }] },
        { beginTime: "18:00:00", endTime: "19:00:00", reserveStatus: { reserveStatus: "" }, userFeeDetails: 12 },
        { beginTime: "", endTime: "20:00:00" },
      ],
    },
    { sceneName: "一号场", sessionVo: [{ beginTime: "19:00:00", endTime: "20:00:00", reserveStatus: "Y" }] },
  ] };
  const normalized = normalizeSlots(payload, { venue: "综合馆", date: "2026-11-21" });
  assert.equal(normalized.sessions.length, 5, "缺开始时间的场次被丢弃");
  assert.deepEqual(normalized.sessions.map(item => item.begin), ["18:00", "19:00", "19:00", "19:00", "20:00"], "按开始时间排序");
  const [first, , , , last] = normalized.sessions;
  assert.equal(first.price, 0.12, "费用为数字时按分转元");
  assert.equal(first.status, undefined, "空状态不编造");
  assert.equal(last.status, "N");
  assert.equal(last.statusReason, "维护中");
  assert.equal(last.price, 30 / 100);
  assert.equal(last.capacity, 4);
  assert.equal(last.reserved, 4);
  assert.equal(normalized.sessions.filter(item => item.site === "一号场").length, 1, "缺 siteName 时用 sceneName");
});

test("sports: 工具层未知工具与缺场景参数直接报错", async () => {
  const { callSportsTool } = await import("../lib/sports/mcp.mjs");
  await assert.rejects(() => callSportsTool("sports_bogus", {}), error => error.code === "UNKNOWN_TOOL");
  await assert.rejects(() => callSportsTool("sports_available", { scene: 42 }), error => error.code === "ARGUMENT_REQUIRED");
});

test("sports: 下单结果只在有明确依据时算成功", async () => {
  const { reserveOutcome } = await import("../lib/app/sports.mjs");
  assert.deepEqual(reserveOutcome({ code: 0, message: "预约成功" }), { ok: true, message: "预约成功" });
  assert.equal(reserveOutcome({ code: 500, message: "场地已满" }).code, "SPORTS_RESERVE_FAILED");
  // 官网要滑块时通常同时带非 0 错误码，不能因此被归成普通失败。
  const captchaWithCode = reserveOutcome({ code: 500, message: "请完成安全验证：向右滑动完成验证" });
  assert.equal(captchaWithCode.code, "SPORTS_MANUAL_VERIFICATION");
  const captchaMsg = reserveOutcome({ code: "E_SLIDE_CHECK", message: "请完成滑动验证" });
  assert.equal(captchaMsg.code, "SPORTS_MANUAL_VERIFICATION");
  const captcha = reserveOutcome({ code: 0, message: "请完成安全验证：向右滑动完成验证" });
  assert.equal(captcha.ok, false);
  assert.equal(captcha.code, "SPORTS_MANUAL_VERIFICATION");
  assert.match(captcha.message, /人工/);
  const empty = reserveOutcome({});
  assert.equal(empty.ok, false, "回执缺失不能报成功");
  assert.equal(empty.code, "SPORTS_RESERVE_UNKNOWN");
  assert.match(empty.message, /核对/);
  assert.equal(reserveOutcome({ message: "预约成功" }).ok, true, "只有成功文案也算明确依据");
});

function reservationFixture(overrides = {}) {
  return {
    sceneUuid: "scene-1", siteUuid: "site-1", date: "2026-11-25", startTime: "19:00", endTime: "20:00",
    payload: { sceneUuid: "scene-1", siteUuid: "site-1", lockKey: "", ignoreError: 0 },
    ...overrides,
  };
}

function recordingApi(handlers) {
  const calls = [];
  const api = async (page, url, options = {}) => {
    const step = url.split("/").pop();
    calls.push({ step, body: options.body, page });
    const handler = handlers[step];
    if (!handler) throw new Error("unexpected call " + step);
    return handler(options);
  };
  return { api, calls };
}

test("sports: 下单被拒后用同一锁键解锁一次并保留原错误", async () => {
  const { reserveWith } = await import("../lib/app/sports.mjs");
  const page = { id: "page-1" };
  const { api, calls } = recordingApi({
    lockSite: () => ({ ok: true, data: { code: 0, data: { lockKey: "lock-1" } } }),
    addReserve: () => ({ ok: true, data: { code: 500, message: "场地已满" } }),
    unLockSite: () => ({ ok: true, data: { code: 0 } }),
  });
  await assert.rejects(() => reserveWith(api, reservationFixture(), page), error => {
    assert.equal(error.code, "SPORTS_RESERVE_FAILED");
    assert.equal(error.message, "场地已满", "原始拒绝原因不能被补偿结果覆盖");
    assert.deepEqual(error.unlock, { ok: true, message: "" });
    return true;
  });
  assert.deepEqual(calls.map(c => c.step), ["lockSite", "addReserve", "unLockSite"]);
  assert.equal(calls[2].body.lockKey, "lock-1", "解锁必须用同一把锁");
  assert.equal(calls.every(c => c.page === page), true, "整段流程复用同一个页面，不能引用未定义的会话");
});

test("sports: 锁场失败或没拿到锁键时不解锁", async () => {
  const { reserveWith } = await import("../lib/app/sports.mjs");
  const rejected = recordingApi({ lockSite: () => ({ ok: false, data: { message: "场地已被占用" } }) });
  await assert.rejects(() => reserveWith(rejected.api, reservationFixture(), {}), error => error.code === "SPORTS_LOCK_FAILED");
  assert.deepEqual(rejected.calls.map(c => c.step), ["lockSite"]);

  const emptyKey = recordingApi({ lockSite: () => ({ ok: true, data: { code: 0 } }) });
  await assert.rejects(() => reserveWith(emptyKey.api, reservationFixture(), {}), error => error.code === "SPORTS_LOCK_FAILED");
  assert.deepEqual(emptyKey.calls.map(c => c.step), ["lockSite"]);
});

test("sports: 回执未知时解锁并报未知，不假装成功", async () => {
  const { reserveWith } = await import("../lib/app/sports.mjs");
  const { api, calls } = recordingApi({
    lockSite: () => ({ ok: true, data: { data: { lockKey: "lock-2" } } }),
    addReserve: () => ({ ok: true, data: {} }),
    unLockSite: () => ({ ok: true, data: { code: 0 } }),
  });
  await assert.rejects(() => reserveWith(api, reservationFixture(), {}), error => {
    assert.equal(error.code, "SPORTS_RESERVE_UNKNOWN");
    assert.match(error.message, /核对/);
    return true;
  });
  assert.deepEqual(calls.map(c => c.step), ["lockSite", "addReserve", "unLockSite"]);
});

test("sports: 解锁失败不覆盖原始错误，并如实记录补偿结果", async () => {
  const { reserveWith } = await import("../lib/app/sports.mjs");
  const { api, calls } = recordingApi({
    lockSite: () => ({ ok: true, data: { data: { lockKey: "lock-3" } } }),
    addReserve: () => ({ ok: false, data: { message: "预约失败" } }),
    unLockSite: () => { throw new Error("network reset"); },
  });
  await assert.rejects(() => reserveWith(api, reservationFixture(), {}), error => {
    assert.equal(error.code, "SPORTS_RESERVE_FAILED");
    assert.equal(error.message, "预约失败");
    assert.deepEqual(error.unlock, { ok: false, message: "network reset" });
    return true;
  });
  assert.deepEqual(calls.map(c => c.step), ["lockSite", "addReserve", "unLockSite"]);
});

test("sports: 正常下单不触发解锁", async () => {
  const { reserveWith } = await import("../lib/app/sports.mjs");
  const { api, calls } = recordingApi({
    lockSite: () => ({ ok: true, data: { data: { lockKey: "lock-4" } } }),
    addReserve: () => ({ ok: true, data: { code: 0, message: "预约成功" } }),
  });
  const result = await reserveWith(api, reservationFixture(), {});
  assert.equal(result.ok, true);
  assert.equal(result.lockKey, "lock-4");
  assert.deepEqual(calls.map(c => c.step), ["lockSite", "addReserve"]);
});


test("seat: 未开放时段可被识别，不再误报为需要人工登录", async () => {
  const { seatPageState } = await import("../lib/app/seat.mjs");
  assert.equal(seatPageState("系统开放预约时间 06:00~23:00 请在开放时间段进行预约。 返回首页 预约规则"), "closed");
  assert.equal(seatPageState("登录 座位预约 图书馆"), "login");
  assert.equal(seatPageState("座位预约 已登录"), "ready");
  assert.equal(seatPageState(""), "ready");
});

test("reserveRequest 校验参数并生成官方表单时间", () => {
  const request = reserveRequest({ sceneUuid: "s", siteUuid: "t", siteType: "游泳", day: "2026-11-24", startTime: "19:00:30", endTime: "20:00", members: ["a"], formId: "f1", deployUuid: "d1" });
  assert.equal(request.date, "2026-11-24");
  assert.deepEqual(request.payload.reserveTime, [{ startTime: "2026-11-24 19:00:00", endTime: "2026-11-24 20:00:00" }]);
  assert.deepEqual(request.payload.resvMember, ["a"]);
  assert.deepEqual(request.payload.formParam, { formId: "f1", deployUuid: "d1" });
  for (const broken of [{}, { sceneUuid: "s" }, { sceneUuid: "s", siteUuid: "t" }, { sceneUuid: "s", siteUuid: "t", startTime: "19:00" }]) {
    assert.throws(() => reserveRequest(broken), (error) => error.code === "ARGUMENT_REQUIRED");
  }
});

test("sports: 预约记录归一保留场馆、时间与状态", () => {
  const items = normalizeReservations({ data: [
    { resvUuid: "r1", resvStatus: "RESV_APPROVE_PASS", resvCheckStatus: "PASS", resvTime: { startTime: "2026-11-20 19:30:00", endTime: "2026-11-20 21:00:00" }, siteVoList: [{ siteName: "游泳馆 3 号道", location: "陈明游泳馆" }] },
    { resvUuid: "r2", resvStatus: "RESV_END", resvTime: { startTime: "2026-11-10 17:00:00", endTime: "2026-11-10 18:00:00" }, siteVoList: [] },
    { bad: true },
  ] });
  assert.equal(items.length, 2);
  assert.equal(items[0].site, "游泳馆 3 号道");
  assert.equal(items[0].location, "陈明游泳馆");
  assert.equal(items[0].start, "2026-11-20 19:30:00");
  assert.equal(items[0].status, "RESV_APPROVE_PASS");
  assert.equal(items[1].site, "");
  assert.equal(normalizeReservations(null).length, 0);
});
