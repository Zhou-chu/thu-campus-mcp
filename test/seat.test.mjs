import assert from "node:assert/strict";
import test from "node:test";
import { normalizeBuckets, normalizeDays, normalizeFloors, normalizeLibraries, normalizeReserve, normalizeSections, normalizeSeats, normalizeSegments, reserveErrorCode, assertBookingWindow, bookingWindowOpen } from "../lib/app/seat.mjs";

test("seat: 场馆树按层级排序并保留有效性", () => {
  const data = {
    list: [
      { id: 3, name: "北馆(李文正馆)", parentId: 0, levels: 0, isValid: 1 },
      { id: 37, name: "二层", parentId: 35, levels: 1, isValid: 0 },
      { id: 35, name: "北馆", parentId: 1, levels: 1, isValid: true },
      { id: null, name: "", parentId: 0, levels: 0, isValid: 1 },
    ],
  };
  assert.deepEqual(normalizeLibraries(data).map(item => item.id), [3, 35, 37]);
  assert.equal(normalizeLibraries(data)[2].valid, false, "isValid=0 视为不可用");
  assert.equal(normalizeLibraries({ list: { id: 9, name: "单馆", levels: 0, isValid: 1 } })[0].name, "单馆", "对象形态也接受");
  assert.deepEqual(normalizeLibraries({}), []);
});

test("seat: 楼层取 childArea 并算出空闲数", () => {
  const data = {
    list: [
      {
        areaInfo: { id: 35 },
        childArea: [
          { id: 38, name: "三层", parentId: 35, isValid: 1, TotalCount: 100, UnavailableSpace: 30 },
          { id: 37, name: "二层", parentId: 35, isValid: 1 },
        ],
      },
    ],
  };
  const floors = normalizeFloors(data);
  assert.deepEqual(floors.map(f => f.id), [37, 38]);
  assert.equal(floors[1].free, 70, "100 - 30");
  assert.equal(floors[0].free, null, "缺少统计时为 null，不编造 0");
  assert.deepEqual(normalizeFloors({ list: [{ areaInfo: { id: 1 } }] }), []);
});

test("seat: 日期兼容 PHP 时间对象", () => {
  const data = {
    list: [
      { day: { date: "2026-11-20 00:00:00", timezone_type: 3, timezone: "PRC" } },
      { day: { date: "2026-11-19 00:00:00", timezone_type: 3, timezone: "PRC" } },
      { day: {} },
    ],
  };
  assert.deepEqual(normalizeDays(data).map(item => item.date), ["2026-11-19", "2026-11-20"]);
  assert.equal(normalizeDays({ list: [{ day: "2026-11-21" }] })[0].date, "2026-11-21", "字符串形态也接受");
  assert.deepEqual(normalizeDays({ list: [{ day: {} }] }), []);
});
test("seat: 时段解析出 segment 与真实时间", () => {
  const data = {
    list: [
      { day: "2026-11-19", id: 1634673, startTime: { date: "2026-11-19 08:00:00", timezone_type: 3 }, endTime: { date: "2026-11-19 22:00:00" }, area: 3 },
      { day: "2026-11-19", id: 1634674, startTime: "2026-11-19 22:00:00", endTime: "2026-11-20 08:00:00", area: 3 },
      { day: "", id: 1 },
    ],
  };
  const items = normalizeSegments(data);
  assert.deepEqual(items.map(item => item.id), [1634673, 1634674]);
  assert.equal(items[0].start, "08:00");
  assert.equal(items[0].end, "22:00");
  assert.equal(items[1].start, "22:00", "字符串时间同样解析");
  assert.deepEqual(normalizeSegments({ list: [{ day: "", id: 2 }] }), []);
});

test("seat: 座位列表按可用性归一，不把缺 status 当成可用", () => {
  const data = {
    list: [
      { id: 3144, name: "M1-3", area: 3, category: "1", status: 1 },
      { id: 3143, name: "M1-2", area: 3, category: "1", status: 0 },
      { id: 3145, name: "M1-4", area: 3, category: "1" },
      { id: null, name: "" },
    ],
  };
  const seats = normalizeSeats(data);
  assert.deepEqual(seats.map(seat => seat.id), [3143, 3144, 3145]);
  assert.equal(seats[1].available, true);
  assert.equal(seats[0].available, false);
  assert.equal(seats[2].available, false, "没有 status 不算可用");
  assert.equal(seats[2].status, null);
});

test("seat: 预约结果不擅自判定成功", () => {
  assert.deepEqual(normalizeReserve({ status: 1, msg: "预约成功" }), { ok: true, code: null, status: 1, message: "预约成功", data: null });
  assert.equal(normalizeReserve({ status: 0, msg: "座位已被预约" }).ok, false);
  assert.equal(normalizeReserve({ status: 0, msg: "座位已被预约" }).message, "座位已被预约");
  assert.equal(normalizeReserve({}).ok, false, "缺 status 视为未成功");
  assert.equal(normalizeReserve({}).message, "预约未成功");
  assert.equal(normalizeReserve({ status: "1" }).ok, true);
});

test("seat: 场次桶统一两类分区，并去掉重复与空名", () => {
  const data = {
    list: [
      { spaceId: 3143, spaceName: "M1-2", area: 3, bookTimeId: 1634673, beginTime: { date: "2026-11-19 08:00:00" }, endTime: "22:00", status: 1, day: "2026-11-19" },
      { spaceId: 3143, spaceName: "M1-2", area: 3, bookTimeId: 1634673, beginTime: "08:00", endTime: "22:00", status: 1 },
      { spaceId: 3144, spaceName: "M1-3", area: 3, bookTimeId: 1634673, beginTime: "08:00", endTime: "22:00", status: 0 },
      { spaceId: 0, spaceName: "", bookTimeId: 1 },
    ],
  };
  const buckets = normalizeBuckets(data);
  assert.equal(buckets.length, 2, "同座位同时段只保留一条");
  assert.equal(buckets[0].name, "M1-2");
  assert.equal(buckets[0].begin, "08:00");
  assert.equal(buckets[0].available, true);
  assert.equal(buckets[1].available, false);
  assert.equal(buckets[0].bookTimeId, 1634673);
});

test("seat: 边界输入不产生假数据", () => {
  assert.deepEqual(normalizeSections({ list: [{ seatinfo: null }] }), []);
  assert.deepEqual(normalizeSections({ list: [{ seatinfo: [{ id: 1, name: "", TotalCount: 5 }] }] }), [], "无名字的区域丢弃");
  assert.deepEqual(normalizeSections({ list: [{ seatinfo: [{ id: 2, name: "待定", TotalCount: 0 }] }] }), [], "容量为 0 的区域丢弃");
  assert.equal(normalizeSections({ list: [{ seatinfo: [{ id: 3, name: "三层", TotalCount: 10, UnavailableSpace: 10 }] }] })[0].free, 0);
  assert.deepEqual(normalizeBuckets({ list: [{ spaceId: null, spaceName: "x" }] }), []);
  assert.deepEqual(normalizeBuckets({ list: [{ spaceId: 1, spaceName: "A", bookTimeId: null }] }), [], "缺 bookTimeId 丢弃");
  const missingStatus = normalizeBuckets({ list: [{ spaceId: 1, spaceName: "A", bookTimeId: 9 }] })[0];
  assert.equal(missingStatus.status, null);
  assert.equal(missingStatus.available, false, "缺 status 不算可用");
  assert.equal(normalizeBuckets({ list: [{ spaceId: 1, spaceName: "A", bookTimeId: 9, day: "not-a-day" }] })[0].day, null);
});

test("seat: 预约失败原因归类为稳定错误码", () => {
  assert.equal(reserveErrorCode("当前用户在该时段已存在预约，不可重复预约。"), "SEAT_ALREADY_BOOKED");
  assert.equal(reserveErrorCode("预约失败，系统结束预约时间为：23:00"), "SEAT_WINDOW_CLOSED");
  assert.equal(reserveErrorCode("该座位已被预约"), "SEAT_TAKEN");
  assert.equal(reserveErrorCode("预约时间段不存在！"), "SEAT_SEGMENT_INVALID");
  assert.equal(reserveErrorCode("没有登录或登录已超时"), "SEAT_LOGIN_REQUIRED");
  assert.equal(reserveErrorCode("别的原因"), null);
  assert.equal(normalizeReserve({ status: 0, msg: "预约失败，系统结束预约时间为：23:00" }).code, "SEAT_WINDOW_CLOSED");
  assert.equal(normalizeReserve({ status: 1, msg: "预约成功" }).code, null);
});

test("seat: 官网时间窗 06:00-23:00 才允许预约", () => {
  const at = (iso) => new Date(iso);
  assert.equal(bookingWindowOpen(at("2026-11-20T05:59:00+08:00")), false);
  assert.equal(bookingWindowOpen(at("2026-11-20T06:00:00+08:00")), true);
  assert.equal(bookingWindowOpen(at("2026-11-20T22:59:00+08:00")), true);
  assert.equal(bookingWindowOpen(at("2026-11-20T23:00:00+08:00")), false);
  assert.throws(() => assertBookingWindow(at("2026-11-20T23:30:00+08:00")), /SEAT_WINDOW_CLOSED|06:00-23:00/);
});
