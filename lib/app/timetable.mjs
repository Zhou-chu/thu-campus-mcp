import { bigPeriodTime } from "./school-time.mjs";

const DAYS = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 日: 7, 天: 7 };
export const DAY_LABELS = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"];
// 清华本科课表每天 6 大节；第 N 节指大节编号，不是 45 分钟的小节。
export const PERIODS = 6;

/** `星期一第2节(全周)，六教6A216` / `星期二第3-4节(第1-16周)，五教5104` */
function parseWeeks(spec) {
  const text = String(spec || "").replace(/\s+/g, "");
  if (!text || text.includes("全周")) return null;
  const odd = /单周/.test(text), even = /双周/.test(text);
  const ranges = [];
  const pattern = /(\d{1,2})(?:[-–—~](\d{1,2}))?/g;
  let match;
  while ((match = pattern.exec(text))) {
    const start = Number(match[1]);
    const end = match[2] ? Number(match[2]) : start;
    if (start >= 1 && end <= 30 && end >= start) ranges.push([start, end]);
  }
  if (!ranges.length) return odd || even ? { ranges: [], odd, even } : null;
  return { ranges, odd, even };
}

const HEAD = /^星期([一二三四五六日天])第(\d{1,2})(?:[-–—](\d{1,2}))?节(?:[（(]([^）)]*)[）)])?[，,]?/;

export function parseSchedule(text) {
  // 网络学堂的 timeAndLocation 是字符串数组，每条一段；也容忍单个字符串。
  if (Array.isArray(text)) return text.flatMap(part => parseSchedule(part));
  if (typeof text !== "string") return [];
  // 先去掉无意义空白，后续正则不再需要 \s*，避免回溯放大。
  const cleaned = text.replace(/[；;]/g, "，").replace(/[ \t\u3000]+/g, "").trim();
  if (!cleaned) return [];
  const slots = [];
  for (const part of cleaned.split(/(?=星期[一二三四五六日天])/)) {
    const match = HEAD.exec(part);
    if (!match) continue;
    const from = Number(match[2]);
    const to = match[3] ? Number(match[3]) : from;
    if (!(from >= 1 && from <= PERIODS) || to < from || to > PERIODS) continue;
    let location = part.slice(match[0].length);
    while (location.endsWith("，") || location.endsWith(",")) location = location.slice(0, -1);
    location = location.trim();
    slots.push({ day: DAYS[match[1]], from, to, weeks: parseWeeks(match[4]), ...(location ? { location } : {}) });
  }
  return slots;
}

const scheduleText = value => (Array.isArray(value) ? value.filter(item => typeof item === "string").join(" ") : typeof value === "string" ? value : "");
const nameOf = course => String(course?.name || course?.chineseName || "").trim();
const teacherOf = course => String(course?.teacher || course?.teacherName || "").trim();

/** 只保留真正排进课表的课程；没有时间地点的课程单独计数，不伪造格子。 */
export function buildTimetable(courses, { semester = null } = {}) {
  const scheduled = [];
  let unscheduled = 0;
  for (const course of Array.isArray(courses) ? courses : []) {
    if (!course || typeof course !== "object") continue;
    const slots = parseSchedule(course.timeAndLocation).map(slot => ({ ...slot, time: bigPeriodTime(slot.from, slot.to) }));
    if (!slots.length) { unscheduled += 1; continue; }
    const name = nameOf(course);
    if (!name) { unscheduled += 1; continue; }
    scheduled.push({
      id: String(course.id || name),
      name,
      teacher: teacherOf(course) || undefined,
      slots,
      timeAndLocation: scheduleText(course.timeAndLocation),
    });
  }
  scheduled.sort((a, b) => a.name.localeCompare(b.name, "zh"));
  return { semester, courses: scheduled, unscheduled };
}

/** 把本地自定义课程与隐藏时段叠加到教务课表上；隐藏只影响展示。 */
export function applyLocalOverrides(table, local) {
  const hidden = new Set((local?.hidden || []).map(item => item.courseId + "@" + item.day + "-" + item.from));
  const courses = [];
  for (const course of table.courses || []) {
    const slots = (course.slots || []).filter(slot => !hidden.has(course.id + "@" + slot.day + "-" + slot.from));
    if (slots.length) courses.push({ ...course, slots });
  }
  for (const course of local?.custom || []) courses.push({ ...course });
  courses.sort((a, b) => String(a.name).localeCompare(String(b.name), "zh"));
  return { ...table, courses };
}

export class TimetableService {
  #cache = null;
  #inflight = null;
  constructor(host, { now = () => Date.now(), cacheTtl = 120_000, local = null } = {}) {
    this.host = host;
    this.now = now;
    this.cacheTtl = cacheTtl;
    this.local = local;
  }
  async refresh() {
    this.#cache = null;
    return this.overview({ refresh: true });
  }
  async #call(name, args) {
    try {
      return await this.host.call(name, args);
    } catch {
      return { ok: false, error: { code: "LEARNX_UNAVAILABLE", message: "网络学堂工具未响应，请稍后重试。" } };
    }
  }
  async overview({ refresh = false } = {}) {
    const at = this.now();
    if (!refresh && this.#cache && at - this.#cache.at < this.cacheTtl) return this.#withLocal(this.#cache.data);
    if (!this.#inflight) this.#inflight = this.#load().finally(() => { this.#inflight = null; });
    const data = await this.#inflight;
    return this.#withLocal(data);
  }
  async #withLocal(table) {
    if (!this.local) return table;
    const local = await this.local.snapshot();
    if (table.state !== "ready") {
      // 教务读不到时仍展示本地自定义课程，不把用户的本地数据一起藏起来。
      return { ...table, courses: local.custom, customOnly: local.custom.length > 0 };
    }
    return applyLocalOverrides(table, local);
  }
  async #load() {
    const fetchedAt = new Date(this.now()).toISOString();
    const semesters = await this.#call("learn_list_semesters", {});
    if (!semesters.ok) return this.#remember({ state: "unavailable", fetchedAt, semester: null, courses: [], unscheduled: 0, error: semesters.error });
    const current = semesters.data?.current || {};
    const semesterId = typeof current.id === "string" ? current.id : "";
    const courses = [];
    let offset = 0;
    for (let page = 0; page < 10; page++) {
      const result = await this.#call("learn_list_courses", { ...(semesterId ? { semesterId } : {}), offset, limit: 100 });
      if (!result.ok) return this.#remember({ state: "unavailable", fetchedAt, semester: current, courses: [], unscheduled: 0, error: result.error });
      const items = Array.isArray(result.data?.items) ? result.data.items : [];
      courses.push(...items);
      const next = Number.isFinite(result.data?.nextOffset) ? result.data.nextOffset : null;
      if (next === null || items.length === 0) break;
      offset = next;
    }
    const table = buildTimetable(courses, { semester: { id: semesterId || undefined, name: String(current.name || current.title || "").trim() || undefined, ...(current.startDate ? { startDate: current.startDate } : {}) } });
    return this.#remember({ state: "ready", fetchedAt, ...table });
  }
  #remember(data) {
    this.#cache = { at: this.now(), data };
    return data;
  }
}