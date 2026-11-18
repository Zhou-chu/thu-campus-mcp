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