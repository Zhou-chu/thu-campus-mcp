/**
 * 用 PostgreSQL 仓库实现定时任务存储（与 ScheduleStore 接口一致）。
 *
 * 任务按用户隔离；执行器按 userId 逐个账号运行。每次写入同时追加 change_log，
 * 供多设备增量同步。
 */
import { describeSchedule, normalizeSchedule } from "./schedules.mjs";

function specOf(task) {
  const spec = {};
  if (task.kind === "once" && task.at) spec.at = task.at;
  if (task.time) spec.time = task.time;
  if (Array.isArray(task.days) && task.days.length) spec.days = task.days;
  return spec;
}

function flatten(row, now) {
  const spec = row.spec || {};
  const task = {
    id: row.id,
    title: row.title,
    prompt: row.prompt,
    kind: row.kind,
    at: spec.at,
    time: spec.time,
    days: spec.days,
    enabled: row.enabled,
    createdAt: row.createdAt,
    lastRunAt: row.lastRunAt,
    lastStatus: row.lastStatus,
    lastSessionId: row.lastSessionId,
    lastError: row.lastError,
  };
  return { ...task, ...describeSchedule(task, now()) };
}

export function createPgScheduleStore({ repos, userId, now = () => new Date() }) {
  if (!repos || !userId) throw new TypeError("createPgScheduleStore 需要 repos 与 userId");

  async function record(entityId, op, payload = null) {
    try {
      await repos.changes.append({ userId, entity: "schedule", entityId, op, payload });
    } catch {
      // 同步日志失败不回滚用户可见的写入。
    }
  }

  return {
    async list() {
      const rows = await repos.schedules.list(userId);
      return rows.map(row => flatten(row, now));
    },
    async get(id) {
      const row = await repos.schedules.get(userId, id);
      return row ? flatten(row, now) : undefined;
    },
    async create(input) {
      const normalized = normalizeSchedule(input, now());
      if (normalized.error) throw Object.assign(new Error(normalized.error.message), normalized.error);
      const value = normalized.value;
      const row = await repos.schedules.create({
        userId,
        title: value.title,
        prompt: value.prompt,
        kind: value.kind,
        spec: specOf(value),
        enabled: value.enabled !== false,
      });
      await record(row.id, "create", { title: row.title });
      return flatten(row, now);
    },
    async update(id, patch = {}) {
      const current = await repos.schedules.get(userId, id);
      if (!current) return undefined;
      const flat = flatten(current, now);
      const merged = { ...flat, ...patch };
      const normalized = normalizeSchedule(merged, now());
      if (normalized.error) throw Object.assign(new Error(normalized.error.message), normalized.error);
      const value = normalized.value;
      const row = await repos.schedules.update(userId, id, {
        title: value.title,
        prompt: value.prompt,
        kind: value.kind,
        spec: specOf(value),
        enabled: patch.enabled !== undefined ? patch.enabled !== false : flat.enabled,
      });
      if (!row) return undefined;
      await record(id, "update", { title: row.title });
      return flatten(row, now);
    },
    async remove(id) {
      const removed = await repos.schedules.remove(userId, id);
      if (removed) await record(id, "remove");
      return removed;
    },
    async finish(id, { ok, sessionId = "", error = "" } = {}) {
      const row = await repos.schedules.finish(userId, id, { ok, sessionId, error });
      if (!row) return undefined;
      await record(id, "finish", { status: row.lastStatus });
      return flatten(row, now);
    },
  };
}