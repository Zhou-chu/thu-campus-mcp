import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ScheduleStore, describeSchedule, nextRunAt, normalizeSchedule, parseOnce } from "../lib/app/schedules.mjs";

const at = text => new Date(text);

test("单次任务只接受未来时间，并给出可读错误", () => {
  const now = at("2026-11-22T10:00:00+09:00");
  assert.equal(parseOnce("2026-11-22 11:00", now)?.getTime(), at("2026-11-22T11:00:00+09:00").getTime());
  assert.equal(parseOnce("2026-11-22T09:00", now), null, "过去的时间拒绝");
  assert.equal(parseOnce("明天早上", now), null);
  const bad = normalizeSchedule({ title: "备份", prompt: "整理作业", kind: "once", at: "2026-11-01 08:00" });
  assert.equal(bad.error.code, "INVALID_ARGUMENTS");
  assert.match(bad.error.message, /未来/);
});

test("每天与每周的下次执行时间按本地时间推进", () => {
  const daily = { kind: "daily", time: "08:30", enabled: true };
  assert.equal(nextRunAt(daily, at("2026-11-22T07:00:00+09:00")), at("2026-11-22T08:30:00+09:00").toISOString());
  assert.equal(nextRunAt(daily, at("2026-11-22T09:00:00+09:00")), at("2026-11-23T08:30:00+09:00").toISOString());
  const weekly = { kind: "weekly", time: "19:00", days: [1, 3], enabled: true }; // 周一、周三
  // 2026-11-22 是周日，下一次是周一 11-23 19:00
  assert.equal(nextRunAt(weekly, at("2026-11-22T20:00:00+09:00")), at("2026-11-23T19:00:00+09:00").toISOString());
  assert.equal(nextRunAt({ ...weekly, enabled: false }, at("2026-11-22T20:00:00+09:00")), null);
});

test("时间与星期校验拒绝含糊输入", () => {
  for (const input of [
    { title: "x", prompt: "y", kind: "daily", time: "8:3" },
    { title: "x", prompt: "y", kind: "weekly", time: "08:00", days: [] },
    { title: "x", prompt: "y", kind: "weekly", time: "08:00", days: [9] },
    { title: "x", prompt: "y", kind: "hourly" },
    { title: "", prompt: "y", kind: "daily", time: "08:00" },
    { title: "x", prompt: "", kind: "daily", time: "08:00" },
  ]) {
    assert.equal(normalizeSchedule(input).error?.code, "INVALID_ARGUMENTS", JSON.stringify(input));
  }
});

test("计划落盘后可读回，更新与删除都持久化", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "schedules-"));
  try {
    const now = () => at("2026-11-22T10:00:00+09:00");
    const store = new ScheduleStore(dir, { now });
    const created = await store.create({ title: "每天整理", prompt: "汇总今天的作业", kind: "daily", time: "08:30" });
    assert.ok(created.id);
    assert.equal(created.nextRunAt, at("2026-11-23T08:30:00+09:00").toISOString());

    const reopened = new ScheduleStore(dir, { now });
    const list = await reopened.list();
    assert.equal(list.length, 1);
    assert.equal(list[0].title, "每天整理");

    await reopened.update(created.id, { enabled: false });
    assert.equal((await new ScheduleStore(dir, { now }).list())[0].enabled, false);
    assert.equal(nextRunAt((await reopened.get(created.id)), now()), null, "停用后没有下次执行");

    assert.equal(await reopened.remove(created.id), true);
    assert.equal(await reopened.remove(created.id), false);
    assert.deepEqual((await new ScheduleStore(dir, { now }).list()), []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("到期任务只取一次，执行后单次任务自动停用", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "schedules-due-"));
  try {
    let nowMs = at("2026-11-22T10:00:00+09:00").getTime();
    const store = new ScheduleStore(dir, { now: () => new Date(nowMs) });
    const once = await store.create({ title: "一次性", prompt: "跑一次", kind: "once", at: "2026-11-22 10:30" });
    const saw = describeSchedule((await store.get(once.id)), new Date(nowMs));
    assert.equal(saw.when, at("2026-11-22T10:30:00+09:00").toISOString());

    assert.deepEqual(await store.due(), [], "未到点不执行");
    nowMs = at("2026-11-22T10:31:00+09:00").getTime();
    const due = await store.due();
    assert.deepEqual(due.map(task => task.id), [once.id]);
    assert.deepEqual(await store.due(), [], "同一次到期不会重复取");

    await store.finish(once.id, { ok: true, sessionId: "s-1" });
    const after = await store.get(once.id);
    assert.equal(after.lastStatus, "succeeded");
    assert.equal(after.lastSessionId, "s-1");
    assert.equal(after.enabled, false, "单次任务执行后停用");
    assert.equal(after.nextRunAt, null);

    const saved = JSON.parse(await readFile(path.join(dir, "schedules.json"), "utf8"));
    assert.equal(saved.tasks[0].lastStatus, "succeeded");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});