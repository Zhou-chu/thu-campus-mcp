const PAGE_LIMIT = 100;
const MAX_PAGES = 20;
const ID = /^[^\s/\\]{1,256}$/;

/** 网络学堂的期限可能是毫秒数、秒数或各种日期字符串；无法确定时返回 null，不猜。 */
export function toMillis(value) {
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value <= 0) return null;
    return value > 1e11 ? Math.round(value) : Math.round(value * 1000);
  }
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) return null;
  if (/^\d{10,13}$/.test(text)) return toMillis(Number(text));
  const iso = /(?:Z|[+-]\d{2}:?\d{2})$/.test(text) ? text : text.replace(" ", "T") + "+08:00";
  const parsed = Date.parse(iso);
  return Number.isFinite(parsed) ? parsed : null;
}
const iso = value => (value === null ? null : new Date(value).toISOString());
const clean = value => (typeof value === "string" ? value.trim() : "");
const graded = grade => !(grade === null || grade === undefined || grade === "" || (typeof grade === "string" && !grade.trim()));

/** 未交：按期限由近到远，期限未知的排最后；已过期整体沉底，最近过期的在上。 */
export function splitPending(items, now) {
  const active = [], expired = [], unknown = [];
  for (const item of items) {
    if (item.deadlineMs === null) unknown.push(item);
    else if (item.deadlineMs < now) expired.push(item);
    else active.push(item);
  }
  active.sort((a, b) => a.deadlineMs - b.deadlineMs || a.title.localeCompare(b.title, "zh"));
  expired.sort((a, b) => b.deadlineMs - a.deadlineMs);
  unknown.sort((a, b) => a.title.localeCompare(b.title, "zh"));
  return [...active, ...unknown, ...expired];
}

/** 已交未批改：最近提交的在前；缺提交时间时退到期限，最后按标题稳定排序。 */
export function sortUngraded(items) {
  const stamp = item => item.submitMs ?? item.deadlineMs ?? 0;
  return [...items].sort((a, b) => stamp(b) - stamp(a) || a.title.localeCompare(b.title, "zh"));
}

export function normalizeItem(raw) {
  if (!raw || typeof raw !== "object") return null;
  const id = clean(raw.id), courseId = clean(raw.courseId);
  if (!id || !courseId) return null;
  const deadlineMs = toMillis(raw.deadline);
  const submitMs = toMillis(raw.submitTime);
  const submitted = raw.submitted === true || raw.submitted === 1 || raw.submitted === "1";
  return {
    id,
    courseId,
    course: clean(raw.course) || courseId,
    title: clean(raw.title) || id,
    deadline: iso(deadlineMs),
    deadlineMs,
    submitTime: iso(submitMs),
    submitMs,
    submitted,
    grade: graded(raw.grade) ? raw.grade : null,
    ungraded: submitted && !graded(raw.grade),
    gradeLevel: clean(raw.gradeLevel) || undefined,
  };
}

export class AssignmentsService {
  #cache = null;
  #inflight = null;
  constructor(host, { now = () => Date.now(), cacheTtl = 60_000 } = {}) {
    this.host = host;
    this.now = now;
    this.cacheTtl = cacheTtl;
  }
  /** 工具进程抛错与返回错误码都要落到明确状态，不能把异常抛给 HTTP 层。 */
  async #call(name, args) {
    try {
      return await this.host.call(name, args);
    } catch {
      return { ok: false, error: { code: "LEARNX_UNAVAILABLE", message: "网络学堂工具未响应，请稍后重试。" } };
    }
  }
  async #all() {
    const items = [], courseErrors = [];
    let offset = 0, pages = 0;
    for (; pages < MAX_PAGES; pages++) {
      const result = await this.#call("learn_list_assignments", { offset, limit: PAGE_LIMIT });
      if (!result.ok) return { ok: false, error: result.error, items, courseErrors, pages };
      const data = result.data || {};
      const page = Array.isArray(data.items) ? data.items : [];
      items.push(...page);
      for (const error of Array.isArray(data.errors) ? data.errors : []) courseErrors.push(error);
      const next = Number.isFinite(data.nextOffset) ? data.nextOffset : null;
      if (next === null || page.length === 0) break;
      offset = next;
    }
    return { ok: true, items, courseErrors, pages: pages + 1 };
  }
  async overview({ refresh = false } = {}) {
    const at = this.now();
    if (!refresh && this.#cache && at - this.#cache.at < this.cacheTtl) return this.#cache.data;
    if (!this.#inflight) {
      this.#inflight = this.#load().finally(() => { this.#inflight = null; });
    }
    return this.#inflight;
  }
  async #load() {
    const fetchedAt = new Date(this.now()).toISOString();
    const result = await this.#all();
    if (!result.ok) {
      const data = {
        state: "unavailable",
        fetchedAt,
        active: [], expired: [], ungraded: [],
        courseErrors: [],
        error: { code: result.error?.code || "LEARNX_UNAVAILABLE", message: result.error?.message || "网络学堂作业列表未能读取。" },
      };
      this.#cache = { at: this.now(), data };
      return data;
    }
    const now = this.now();
    const normalized = result.items.map(normalizeItem).filter(Boolean);
    const pending = splitPending(normalized.filter(item => !item.submitted), now);
    const ungraded = sortUngraded(normalized.filter(item => item.ungraded));
    const data = {
      state: "ready",
      fetchedAt,
      active: pending.filter(item => item.deadlineMs === null || item.deadlineMs >= now),
      expired: pending.filter(item => item.deadlineMs !== null && item.deadlineMs < now),
      ungraded,
      courseErrors: result.courseErrors,
      pages: result.pages,
      total: normalized.length,
    };
    this.#cache = { at: this.now(), data };
    return data;
  }
  async detail(courseId, homeworkId) {
    if (!ID.test(clean(courseId)) || !ID.test(clean(homeworkId)))
      return { ok: false, error: { code: "INVALID_ID", message: "课程或作业 ID 不合法。" } };
    const result = await this.#call("learn_get_content", { courseId, kind: "homework", id: homeworkId, maxChars: 40000 });
    if (!result.ok) return { ok: false, error: result.error };
    const data = result.data || {};
    return {
      ok: true,
      data: {
        id: clean(data.id) || homeworkId,
        courseId,
        title: clean(data.title),
        body: typeof data.body === "string" ? data.body : "",
        truncated: data.truncated === true,
        attachments: Array.isArray(data.attachments) ? data.attachments.map(a => ({ name: clean(a?.name), role: clean(a?.role) })) : [],
        url: clean(data.url) || undefined,
        submitted: data.submitted === true,
        deadline: iso(toMillis(data.deadline)),
        submitTime: iso(toMillis(data.submitTime)),
        grade: graded(data.grade) ? data.grade : null,
      },
    };
  }
  async prepare({ courseId, homeworkId, content, filePath, overwrite }) {
    if (!ID.test(clean(courseId)) || !ID.test(clean(homeworkId)))
      return { ok: false, error: { code: "INVALID_ID", message: "课程或作业 ID 不合法。" } };
    const args = { courseId, homeworkId };
    if (typeof content === "string" && content.trim()) args.content = content;
    if (typeof filePath === "string" && filePath) args.filePath = filePath;
    if (overwrite === true) args.overwrite = true;
    const result = await this.#call("learn_prepare_submission", args);
    return result.ok ? { ok: true, data: result.data } : { ok: false, error: result.error };
  }
  async submit(preparationId) {
    if (typeof preparationId !== "string" || !/^[a-f0-9-]{36}$/.test(preparationId))
      return { ok: false, error: { code: "INVALID_ID", message: "提交准备 ID 不合法。" } };
    const result = await this.#call("learn_submit_assignment", { preparationId });
    return result.ok ? { ok: true, data: result.data } : { ok: false, error: result.error };
  }
}