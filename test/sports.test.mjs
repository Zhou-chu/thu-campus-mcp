import assert from "node:assert/strict";
import test from "node:test";
import { normalizeDate, normalizeSlots, sportsLoginProof } from "../lib/app/sports.mjs";

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

test("sports: 下单结果区分成功、失败与需要人工验证", async () => {
  const { reserveOutcome } = await import("../lib/app/sports.mjs");
  assert.deepEqual(reserveOutcome({ code: 0, message: "预约成功" }), { ok: true, message: "预约成功" });
  assert.equal(reserveOutcome({ code: 500, message: "场地已满" }).code, "SPORTS_RESERVE_FAILED");
  const captcha = reserveOutcome({ code: 0, message: "请完成安全验证：向右滑动完成验证" });
  assert.equal(captcha.ok, false);
  assert.equal(captcha.code, "SPORTS_MANUAL_VERIFICATION");
  assert.match(captcha.message, /人工/);
  assert.equal(reserveOutcome({}).ok, true, "没有错误码时按成功处理");
});


test("seat: 未开放时段可被识别，不再误报为需要人工登录", async () => {
  const { seatPageState } = await import("../lib/app/seat.mjs");
  assert.equal(seatPageState("系统开放预约时间 06:00~23:00 请在开放时间段进行预约。 返回首页 预约规则"), "closed");
  assert.equal(seatPageState("登录 座位预约 图书馆"), "login");
  assert.equal(seatPageState("座位预约 已登录"), "ready");
  assert.equal(seatPageState(""), "ready");
});
