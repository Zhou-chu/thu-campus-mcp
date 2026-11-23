/**
 * 课表本地覆盖层（自定义课程 + 隐藏时段）的存储选择器。
 *
 * 登录用户写入 user_settings（key: timetable.custom / timetable.hidden），
 * 多设备共享；未登录继续用本机 JSON。
 */
import { currentUserId } from "./request-context.mjs";
import { normalizeCustomCourse } from "./timetable-local.mjs";

const CUSTOM = "timetable.custom";
const HIDDEN = "timetable.hidden";

export function createTimetableRouter({ store = null, fileStore, userId = currentUserId } = {}) {
  if (!fileStore) throw new TypeError("createTimetableRouter 需要文件课表存储");

  function uid() {
    try { return typeof userId === "function" ? userId() : userId; } catch { return null; }
  }

  async function loadDb(id) {
    const [custom, hidden] = await Promise.all([
      store.repos.settings.get(id, CUSTOM),
      store.repos.settings.get(id, HIDDEN),
    ]);
    return {
      custom: Array.isArray(custom) ? custom.filter(item => item && item.id && item.name) : [],
      hidden: Array.isArray(hidden) ? hidden.filter(item => item && item.courseId) : [],
    };
  }

  async function saveDb(id, data) {
    await store.repos.settings.set(id, CUSTOM, data.custom);
    await store.repos.settings.set(id, HIDDEN, data.hidden);
    try {
      await store.repos.changes.append({ userId: id, entity: "timetable", entityId: id, op: "update", payload: { custom: data.custom.length, hidden: data.hidden.length } });
    } catch {
      // 同步日志失败不回滚课表覆盖层。
    }
  }

  function backend() {
    const id = uid();
    return store && id ? { id, db: true } : { id: null, db: false };
  }

  return {
    async snapshot() {
      const { id, db } = backend();
      return db ? await loadDb(id) : await fileStore.snapshot();
    },
    async add(input) {
      const { id, db } = backend();
      if (!db) return fileStore.add(input);
      const normalized = normalizeCustomCourse(input);
      if (!normalized.ok) return normalized;
      const data = await loadDb(id);
      data.custom.push(normalized.course);
      await saveDb(id, data);
      return { ok: true, course: normalized.course };
    },
    async remove(courseId) {
      const { id, db } = backend();
      if (!db) return fileStore.remove(courseId);
      const data = await loadDb(id);
      const next = data.custom.filter(item => item.id !== courseId);
      if (next.length === data.custom.length) return { ok: false, error: { code: "NOT_FOUND", message: "没有找到这门自定义课程。" } };
      await saveDb(id, { ...data, custom: next });
      return { ok: true, removed: courseId };
    },
    async hide({ courseId, day, from } = {}) {
      const { id, db } = backend();
      if (!db) return fileStore.hide({ courseId, day, from });
      const entry = { courseId: String(courseId || ""), day: Number(day), from: Number(from) };
      if (!entry.courseId) return { ok: false, error: { code: "INVALID_COURSE", message: "缺少课程 id。" } };
      const data = await loadDb(id);
      if (!data.hidden.some(item => item.courseId === entry.courseId && item.day === entry.day && item.from === entry.from)) {
        data.hidden.push(entry);
        await saveDb(id, data);
      }
      return { ok: true, hidden: entry };
    },
    async unhide({ courseId, day, from } = {}) {
      const { id, db } = backend();
      if (!db) return fileStore.unhide({ courseId, day, from });
      const data = await loadDb(id);
      const next = data.hidden.filter(item => !(item.courseId === courseId && item.day === Number(day) && item.from === Number(from)));
      if (next.length === data.hidden.length) return { ok: true, changed: false };
      await saveDb(id, { ...data, hidden: next });
      return { ok: true, changed: true };
    },
  };
}