import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createAppServer } from "../lib/app/server.mjs";
import { SessionStore } from "../lib/app/sessions.mjs";
import { DeviceStore } from "../lib/app/devices.mjs";
import { PairingCodes } from "../lib/app/pairing.mjs";
import { TimetableService, buildTimetable, parseSchedule } from "../lib/app/timetable.mjs";
import { assignLanes, periodText, todayIndex, weekText, weeklyLayout } from "../webui/timetable-model.js";

test("timetable: parses single, paired and week-limited slots with locations", () => {
  assert.deepEqual(parseSchedule("星期一第2节(全周)，六教6A216"), [{ day: 1, from: 2, to: 2, weeks: null, location: "六教6A216" }]);
  assert.deepEqual(parseSchedule("星期二第3-4节(第1-16周)，五教5104"), [
    { day: 2, from: 3, to: 4, weeks: { ranges: [[1, 16]], odd: false, even: false }, location: "五教5104" },
  ]);
  const multi = parseSchedule("星期二第2节(全周)，五教5104 星期五第3节(全周)，五教5104");
  assert.deepEqual(multi.map(slot => slot.day), [2, 5]);
  assert.deepEqual(multi.map(slot => slot.location), ["五教5104", "五教5104"]);
  assert.equal(parseSchedule("星期一第1-2节(单周)")[0].weeks.odd, true);
  assert.equal(parseSchedule("星期三第5节(双周，第2-18周)")[0].weeks.even, true);
  assert.equal(parseSchedule("")[0], undefined);
  assert.deepEqual(parseSchedule(null), []);
  assert.deepEqual(parseSchedule("未排课"), []);
  assert.deepEqual(parseSchedule("星期一第7节(全周)"), [], "清华每天只有 6 大节，第7节不成立");
  assert.deepEqual(parseSchedule("星期一第13节(全周)"), [], "超出节次上限的条目丢弃");
  assert.deepEqual(parseSchedule("星期一第5-3节(全周)"), [], "倒序节次丢弃");
  assert.equal(parseSchedule("星期一第6节(全周)")[0].from, 6, "第6大节保留");
});

test("timetable: builds a grid-ready table and counts courses without time", () => {
  const table = buildTimetable([
    { id: "b", name: "乙课", teacher: "乙老师", timeAndLocation: "星期一第2节(全周)，一教101" },
    { id: "a", name: "甲课", teacher: "甲老师", timeAndLocation: "星期三第1节(第1-8周)，二教202 星期三第3节(第1-8周)，二教202" },
    { id: "c", name: "没有时间", timeAndLocation: "" },
    { id: "d", timeAndLocation: "星期一第1节(全周)" },
  ], { semester: { id: "2026-2027-1" } });
  assert.deepEqual(table.courses.map(course => course.name), ["甲课", "乙课"], "按名称稳定排序");
  assert.equal(table.courses.find(course => course.id === "a").slots.length, 2);
  assert.equal(table.unscheduled, 2, "没有时间或没有名称的课程单独计数");
  assert.equal(table.semester.id, "2026-2027-1");
  assert.deepEqual(buildTimetable(null).courses, []);
});

test("timetable model: overlapping courses get separate lanes and readable labels", () => {
  const placed = assignLanes([
    { day: 1, from: 1, to: 2 },
    { day: 1, from: 2, to: 3 },
    { day: 1, from: 4, to: 4 },
  ]);
  assert.equal(placed.lanes, 2, "第1-2节与第2-3节重叠，需要两条通道");
  assert.deepEqual(placed.slots.map(slot => slot.lane), [0, 1, 0]);
  const layout = weeklyLayout([
    { name: "甲", slots: [{ day: 1, from: 1, to: 2 }, { day: 3, from: 5, to: 6 }] },
  ]);
  assert.equal(layout.length, 7);
  assert.equal(layout[0][0].course.name, "甲");
  assert.equal(layout[2][0].from, 5);
  assert.deepEqual(layout[1], []);
  assert.equal(weekText(null), "全周");
  assert.equal(weekText({ ranges: [[1, 16]], odd: false, even: false }), "第1-16周");
  assert.equal(weekText({ ranges: [[1, 1], [3, 5]], odd: true, even: false }), "第1、3-5周（单周）");
  assert.equal(periodText(3, 3), "第3节");
  assert.equal(periodText(3, 4), "第3-4节");
  assert.equal(todayIndex(new Date("2026-11-16T08:00:00+08:00")), 1, "周一");
  assert.equal(todayIndex(new Date("2026-11-22T08:00:00+08:00")), 7, "周日归一为7");
});

test("timetable service: paginates courses, caches and reports an unavailable site honestly", async () => {
  const pages = [
    { items: [{ id: "c1", name: "甲", timeAndLocation: "星期一第1节(全周)，一教101" }], nextOffset: 1 },
    { items: [{ id: "c2", name: "乙", timeAndLocation: "星期二第2节(全周)，二教202" }], nextOffset: null },
  ];
  let calls = 0;
  const host = {
    call: async name => {
      if (name === "learn_list_semesters") return { ok: true, data: { current: { id: "2026-2027-1", name: "秋季学期" } } };
      if (name === "learn_list_courses") return { ok: true, data: pages[calls++] || { items: [], nextOffset: null } };
      return { ok: false, error: { code: "UNKNOWN", message: "unexpected" } };
    },
  };
  const service = new TimetableService(host, { now: () => Date.parse("2026-11-16T00:00:00Z"), cacheTtl: 10_000 });
  const data = await service.overview();
  assert.equal(data.state, "ready");
  assert.equal(data.courses.length, 2);
  assert.equal(data.semester.name, "秋季学期");
  assert.equal(calls, 2, "分页读到没有 nextOffset 为止");
  await service.overview();
  assert.equal(calls, 2, "缓存命中不重复请求");
  await service.overview({ refresh: true });
  assert.equal(calls >= 3, true);

  const down = await new TimetableService({ call: async () => ({ ok: false, error: { code: "AUTH_REQUIRED", message: "需要登录" } }) }).overview();
  assert.equal(down.state, "unavailable");
  assert.equal(down.error.code, "AUTH_REQUIRED");
  const thrown = await new TimetableService({ call: async () => { throw new Error("crashed"); } }).overview();
  assert.equal(thrown.state, "unavailable");
  assert.equal(thrown.error.code, "LEARNX_UNAVAILABLE");
});

async function appWith(host) {
  const dir = await mkdtemp(path.join(tmpdir(), "campus-timetable-"));
  const server = createAppServer({
    config: { host: "127.0.0.1", hostname: "localhost", port: 0, stateDir: dir, token: "timetable-fixture", modelRoute: "madmodel", modelName: "fixture", requireApproval: true },
    host,
    route: { route: "madmodel", models: async () => [], status: async () => ({ available: false }), chat: async () => Response.json({}) },
    sessions: new SessionStore(dir),
    version: "timetable-test",
    webuiDir: path.join(import.meta.dirname, "..", "webui"),
    devices: new DeviceStore(dir, { encrypt: async value => value }),
    pairing: new PairingCodes(),
  });
  const base = await server.listen();
  return { base, close: async () => { await server.close?.(); await rm(dir, { recursive: true, force: true }); } };
}

test("timetable: accepts the array shape that 网络学堂 actually returns", () => {
  assert.deepEqual(parseSchedule(["星期一第2节(全周)，六教6A216"]).map(slot => slot.day), [1]);
  const pair = parseSchedule(["星期二第2节(全周)，五教5104", "星期五第3节(全周)，五教5104"]);
  assert.deepEqual(pair.map(slot => slot.day), [2, 5]);
  const table = buildTimetable([{ id: "c", name: "甲课", timeAndLocation: ["星期一第2节(全周)，六教6A216", "星期五第3节(全周)，五教5104"] }]);
  assert.equal(table.courses.length, 1);
  assert.equal(table.courses[0].slots.length, 2);
  assert.equal(table.courses[0].timeAndLocation, "星期一第2节(全周)，六教6A216 星期五第3节(全周)，五教5104");
});

test("timetable: tolerates missing fields, odd spec text and non-object entries", () => {
  assert.deepEqual(parseSchedule(undefined), []);
  assert.deepEqual(parseSchedule("星期一第3节(第5周)")[0].weeks, { ranges: [[5, 5]], odd: false, even: false });
  assert.deepEqual(parseSchedule("星期一第1节(实验课)")[0].weeks, null, "没有周次数字时按全周处理");
  const table = buildTimetable([null, 5, "x", { id: "n1", chineseName: "中文名", timeAndLocation: "星期一第1节(全周)" }]);
  assert.deepEqual(table.courses.map(course => course.name), ["中文名"], "缺少 name 时回退到中文名");
  assert.equal(table.unscheduled, 0, "非对象条目不是课程，也不计入未排课");
});

test("timetable service: a semester payload without current still reads courses", async () => {
  const seen = [];
  const host = {
    call: async (name, args) => {
      seen.push([name, args]);
      if (name === "learn_list_semesters") return { ok: true, data: null };
      return { ok: true, data: null };
    },
  };
  const data = await new TimetableService(host, { cacheTtl: 0 }).overview();
  assert.equal(data.state, "ready");
  assert.deepEqual(data.courses, []);
  assert.equal(seen.some(([name, args]) => name === "learn_list_courses" && args.semesterId === undefined), true);
});

test("timetable http: exposes the real table and supports forced refresh", async t => {
  const host = {
    call: async name => name === "learn_list_semesters"
      ? { ok: true, data: { current: { id: "2026-2027-1", name: "秋季学期" } } }
      : { ok: true, data: { items: [{ id: "c1", name: "甲课", teacher: "甲老师", timeAndLocation: "星期四第6节(全周)，三教3101" }], nextOffset: null } },
  };
  const app = await appWith(host);
  t.after(app.close);
  const headers = { authorization: "Bearer timetable-fixture" };
  const data = await (await fetch(app.base + "/api/timetable", { headers })).json();
  assert.equal(data.ok, true);
  assert.equal(data.state, "ready");
  assert.equal(data.courses.length, 1);
  assert.equal(data.courses[0].slots[0].day, 4);
  assert.equal(data.courses[0].slots[0].location, "三教3101");
  const refreshed = await (await fetch(app.base + "/api/timetable?refresh=1", { headers })).json();
  assert.equal(refreshed.courses.length, 1);
  assert.equal((await fetch(app.base + "/api/timetable")).status, 401, "未授权不能读课表");
});
test("timetable: 自定义课程校验与本地增删隐藏", async () => {
  const { normalizeCustomCourse, createLocalTimetable } = await import("../lib/app/timetable-local.mjs");
  assert.equal(normalizeCustomCourse({}).ok, false);
  assert.equal(normalizeCustomCourse({ name: "x", day: 9, from: 1 }).ok, false);
  assert.equal(normalizeCustomCourse({ name: "x", day: 1, from: 5, to: 2 }).ok, false);
  const ok = normalizeCustomCourse({ name: " 自习 ", day: 3, from: 1, to: 2, location: "图书馆" });
  assert.equal(ok.ok, true);
  assert.equal(ok.course.name, "自习");
  assert.deepEqual(ok.course.slots, [{ day: 3, from: 1, to: 2 }]);

  const file = path.join(await mkdtemp(path.join(tmpdir(), "timetable-")), "local.json");
  const local = createLocalTimetable(file);
  const added = await local.add({ name: "线下课", day: 2, from: 3, to: 4 });
  assert.equal(added.ok, true);
  let snapshot = await local.snapshot();
  assert.equal(snapshot.custom.length, 1);
  await local.hide({ courseId: "c1", day: 2, from: 1 });
  snapshot = await local.snapshot();
  assert.equal(snapshot.hidden.length, 1);
  await local.unhide({ courseId: "c1", day: 2, from: 1 });
  snapshot = await local.snapshot();
  assert.equal(snapshot.hidden.length, 0);
  await local.remove(added.course.id);
  snapshot = await local.snapshot();
  assert.equal(snapshot.custom.length, 0);
});

test("timetable: 本地覆盖层隐藏时段并叠加自定义课程", async () => {
  const { applyLocalOverrides } = await import("../lib/app/timetable.mjs");
  const table = { courses: [{ id: "c1", name: "物理", slots: [{ day: 2, from: 1, to: 2 }, { day: 4, from: 3, to: 3 }] }] };
  const merged = applyLocalOverrides(table, {
    hidden: [{ courseId: "c1", day: 2, from: 1 }],
    custom: [{ id: "local-1", name: "自习", custom: true, slots: [{ day: 6, from: 1, to: 2 }] }],
  });
  assert.equal(merged.courses.length, 2);
  assert.deepEqual(merged.courses.find(item => item.id === "c1").slots, [{ day: 4, from: 3, to: 3 }]);
  assert.equal(merged.courses.find(item => item.id === "local-1").custom, true);
});

test("timetable: HTTP 自定义课程增删隐藏与错误分支", async t => {
  const host = {
    call: async (name) => {
      if (name === "learn_list_semesters") return { ok: true, data: { current: { id: "s1", name: "秋季学期" } } };
      if (name === "learn_list_courses")
        return { ok: true, data: { items: [{ id: "c1", name: "甲课", teacher: "甲老师", timeAndLocation: "星期四第6节(全周)，三教3101" }], nextOffset: null } };
      return { ok: true, data: {} };
    },
  };
  const app = await appWith(host);
  t.after(app.close);
  const headers = { authorization: "Bearer timetable-fixture", "content-type": "application/json" };
  const post = (path, body) => fetch(app.base + path, { method: "POST", headers, body: JSON.stringify(body) });

  const bad = await post("/api/timetable/custom", { name: "", day: 1, from: 1 });
  assert.equal(bad.status, 400);
  assert.equal((await bad.json()).error.code, "INVALID_NAME");

  const added = await post("/api/timetable/custom", { name: "自习", day: 6, from: 1, to: 2 });
  assert.equal(added.status, 200);
  const addedBody = await added.json();
  assert.equal(addedBody.course.name, "自习");
  assert.ok(addedBody.courses.some(course => course.custom));

  const hidden = await post("/api/timetable/hide", { courseId: "c1", day: 4, from: 6 });
  assert.equal(hidden.status, 200);
  const hiddenBody = await hidden.json();
  assert.equal(hiddenBody.courses.some(course => course.id === "c1"), false, "被隐藏的官方时段不再绘制");

  const unhidden = await post("/api/timetable/unhide", { courseId: "c1", day: 4, from: 6 });
  assert.equal((await unhidden.json()).courses.some(course => course.id === "c1"), true);

  const missingId = await post("/api/timetable/hide", {});
  assert.equal(missingId.status, 400);

  const removed = await fetch(app.base + "/api/timetable/custom/" + encodeURIComponent(addedBody.course.id), { method: "DELETE", headers });
  assert.equal(removed.status, 200);
  assert.equal((await removed.json()).courses.some(course => course.custom), false);

  const missing = await fetch(app.base + "/api/timetable/custom/nope", { method: "DELETE", headers });
  assert.equal(missing.status, 404);

  const broken = await fetch(app.base + "/api/timetable/custom", { method: "POST", headers, body: "not json" });
  assert.equal(broken.status, 400, "非法 JSON 不写入，按校验失败返回");
  assert.equal((await broken.json()).error.code, "INVALID_NAME");
});
