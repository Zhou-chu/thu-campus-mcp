import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const DAY_MIN = 1;
const DAY_MAX = 7;
const PERIOD_MIN = 1;
const PERIOD_MAX = 6;

const text = (value, max = 80) => String(value ?? "").trim().slice(0, max);

/** 校验自定义课程；只接受能真正画进课表的字段，不猜默认值。 */
export function normalizeCustomCourse(input, { id = null } = {}) {
  const source = input && typeof input === "object" ? input : {};
  const name = text(source.name, 60);
  if (!name) return { ok: false, error: { code: "INVALID_NAME", message: "课程名称不能为空。" } };
  const day = Number(source.day);
  if (!Number.isInteger(day) || day < DAY_MIN || day > DAY_MAX)
    return { ok: false, error: { code: "INVALID_DAY", message: "星期必须是 1-7。" } };
  const from = Number(source.from);
  const to = Number(source.to ?? source.from);
  if (!Number.isInteger(from) || !Number.isInteger(to) || from < PERIOD_MIN || to > PERIOD_MAX || to < from)
    return { ok: false, error: { code: "INVALID_PERIOD", message: "节次必须是 1-6，且结束不早于开始。" } };
  return {
    ok: true,
    course: {
      id: id || `local-${day}-${from}-${Date.now().toString(36)}`,
      name,
      teacher: text(source.teacher, 40) || undefined,
      location: text(source.location, 60) || undefined,
      custom: true,
      slots: [{ day, from, to }],
      timeAndLocation: "",
    },
  };
}

export const slotKey = slot => `${slot.day}-${slot.from}`;

/** 本地覆盖层：自定义课程 + 被隐藏的官方时段；只存这两类，其余仍以教务数据为准。 */
export function createLocalTimetable(filePath) {
  let cache = null;
  const load = async () => {
    if (cache) return cache;
    try {
      const raw = JSON.parse(await readFile(filePath, "utf8"));
      cache = {
        custom: Array.isArray(raw.custom) ? raw.custom.filter(item => item && item.id && item.name) : [],
        hidden: Array.isArray(raw.hidden) ? raw.hidden.filter(item => item && item.courseId) : [],
      };
    } catch {
      cache = { custom: [], hidden: [] };
    }
    return cache;
  };
  const save = async data => {
    cache = data;
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, JSON.stringify(data, null, 2), "utf8");
    return data;
  };
  return {
    async snapshot() {
      const data = await load();
      return { custom: [...data.custom], hidden: [...data.hidden] };
    },
    async add(input) {
      const normalized = normalizeCustomCourse(input);
      if (!normalized.ok) return normalized;
      const data = await load();
      const next = { ...data, custom: [...data.custom, normalized.course] };
      await save(next);
      return { ok: true, course: normalized.course };
    },
    async remove(id) {
      const data = await load();
      const next = { ...data, custom: data.custom.filter(item => item.id !== id) };
      if (next.custom.length === data.custom.length) return { ok: false, error: { code: "NOT_FOUND", message: "没有找到这门自定义课程。" } };
      await save(next);
      return { ok: true, removed: id };
    },
    async hide({ courseId, day, from }) {
      const entry = { courseId: String(courseId || ""), day: Number(day), from: Number(from) };
      if (!entry.courseId) return { ok: false, error: { code: "INVALID_COURSE", message: "缺少课程 id。" } };
      const data = await load();
      const exists = data.hidden.some(item => item.courseId === entry.courseId && item.day === entry.day && item.from === entry.from);
      if (!exists) await save({ ...data, hidden: [...data.hidden, entry] });
      return { ok: true, hidden: entry };
    },
    async unhide({ courseId, day, from }) {
      const data = await load();
      const next = data.hidden.filter(item => !(item.courseId === courseId && item.day === Number(day) && item.from === Number(from)));
      if (next.length === data.hidden.length) return { ok: true, changed: false };
      await save({ ...data, hidden: next });
      return { ok: true, changed: true };
    },
  };
}