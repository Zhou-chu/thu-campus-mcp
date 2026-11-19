import assert from "node:assert/strict";
import test from "node:test";
import { normalizeDays, normalizeFloors, normalizeLibraries, normalizeSeats, normalizeSegments } from "../lib/app/seat.mjs";

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
