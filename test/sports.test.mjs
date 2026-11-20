import assert from "node:assert/strict";
import test from "node:test";
import { normalizeDate, normalizeSlots } from "../lib/app/sports.mjs";

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
  assert.equal(sessions[1].price, 15, "规则费用兜底");
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
