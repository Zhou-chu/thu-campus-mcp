/**
 * 定时任务：保存计划、到期自动开一个新会话并跑一轮对话。
 *
 * 只支持两类计划，避免引入 cron 解析器与夏令时歧义：
 * - once:   指定本地时间的单次任务（ISO 字符串，或 "2026-12-01 08:30"）
 * - daily:  每天固定本地时间（HH:MM）
 * - weekly: 每周指定星期几（1=周一 … 7=周日）+ 本地时间
 *
 * 计划保存在 stateDir/schedules.json；每个任务记录最近执行结果，失败原因直接可读。
 */
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { atomic, directory } from "../../packages/browser/core.mjs";

const TITLE_MAX = 60;
const PROMPT_MAX = 4000;
const MINUTE = 60_000;

export function parseTime(text) {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(String(text || "").trim());
  if (!match) return null;
  return { hour: Number(match[1]), minute: Number(match[2]) };
}

export function parseOnce(text, now = new Date()) {
  const raw = String(text || "").trim().replace(" ", "T");
  if (!raw) return null;
  const at = new Date(raw.length === 16 ? raw + ":00" : raw);
  if (Number.isNaN(at.getTime())) return null;
  return at.getTime() > now.getTime() ? at : null;
}

export function normalizeSchedule(input = {}, now = new Date()) {
  const title = String(input.title || "").trim().slice(0, TITLE_MAX);
  const prompt = String(input.prompt || "").trim().slice(0, PROMPT_MAX);
  if (!title) return { error: { code: "INVALID_ARGUMENTS", message: "请填写任务名称。" } };
  if (!prompt) return { error: { code: "INVALID_ARGUMENTS", message: "请填写要执行的指令。" } };
  const kind = String(input.kind || "");
  if (kind === "once") {
    const at = parseOnce(input.at, now);
    if (!at) return { error: { code: "INVALID_ARGUMENTS", message: "单次任务需要一个未来的时间，例如 2026-12-01 08:30。" } };
    return { value: { title, prompt, kind, at: new Date(at).toISOString(), enabled: input.enabled !== false } };
  }
  const time = parseTime(input.time);
  if (!time) return { error: { code: "INVALID_ARGUMENTS", message: "时间格式应为 24 小时制 HH:MM。" } };
  if (kind === "daily") return { value: { title, prompt, kind, time: input.time.trim(), enabled: input.enabled !== false } };
  if (kind === "weekly") {
    const days = [...new Set((Array.isArray(input.days) ? input.days : []).map(Number).filter(day => Number.isInteger(day) && day >= 1 && day <= 7))].sort((a, b) => a - b);
    if (!days.length) return { error: { code: "INVALID_ARGUMENTS", message: "每周任务需要 1–7 里的星期几，1 表示周一。" } };
    return { value: { title, prompt, kind, time: input.time.trim(), days, enabled: input.enabled !== false } };
  }
  return { error: { code: "INVALID_ARGUMENTS", message: "任务类型只能是 once、daily 或 weekly。" } };
}

/** 计算下一次执行时间；已停用或单次任务已完成时返回 null。 */
export function nextRunAt(task, from = new Date()) {
  if (!task || task.enabled === false) return null;
  const base = Math.max(from.getTime(), task.lastRunAt ? Date.parse(task.lastRunAt) + MINUTE : 0);
  if (task.kind === "once") {
    const at = Date.parse(task.at);
    return Number.isFinite(at) && at > base ? new Date(at).toISOString() : null;
  }
  const time = parseTime(task.time);
  if (!time) return null;
  const start = new Date(base);
  for (let offset = 0; offset <= 8; offset++) {
    const candidate = new Date(start.getFullYear(), start.getMonth(), start.getDate() + offset, time.hour, time.minute, 0, 0);
    if (candidate.getTime() <= base) continue;
    if (task.kind === "weekly") {
      const iso = candidate.getDay() === 0 ? 7 : candidate.getDay();
      if (!task.days.includes(iso)) continue;
    }
    return candidate.toISOString();
  }
  return null;
}

/** 最近一次已经到点的发生时间（用于判断是否该执行），没有则返回 null。 */
export function lastOccurrence(task, now = new Date()) {
  if (!task || task.enabled === false) return null;
  const stamp = now.getTime();
  if (task.kind === "once") {
    const at = Date.parse(task.at);
    return Number.isFinite(at) && at <= stamp ? at : null;
  }
  const time = parseTime(task.time);
  if (!time) return null;
  for (let offset = 0; offset <= 7; offset++) {
    const candidate = new Date(now.getFullYear(), now.getMonth(), now.getDate() - offset, time.hour, time.minute, 0, 0);
    if (candidate.getTime() > stamp) continue;
    if (task.kind === "weekly") {
      const iso = candidate.getDay() === 0 ? 7 : candidate.getDay();
      if (!task.days.includes(iso)) continue;
    }
    return candidate.getTime();
  }
  return null;
}

export function describeSchedule(task, from = new Date()) {
  const when = task.kind === "once"
    ? task.at
    : task.kind === "daily"
      ? `每天 ${task.time}`
      : `每周 ${task.days.map(day => "一二三四五六日"[day - 1]).join("、")} ${task.time}`;
  return { when, nextRunAt: nextRunAt(task, from) };
}

export class ScheduleStore {
  constructor(stateDir, { now = () => new Date(), clock = null } = {}) {
    this.file = path.join(stateDir, "schedules.json");
    this.stateDir = stateDir;
    this.now = now;
    this.tasks = [];
    this.loaded = false;
    this.timer = clock;
  }

  async load() {
    if (this.loaded) return this;
    try {
      const parsed = JSON.parse(await readFile(this.file, "utf8"));
      this.tasks = Array.isArray(parsed?.tasks) ? parsed.tasks : [];
    } catch {
      this.tasks = [];
    }
    this.loaded = true;
    return this;
  }

  async save() {
    await directory(this.stateDir);
    await atomic(this.file, Buffer.from(JSON.stringify({ tasks: this.tasks, at: this.now().toISOString() })));
  }

  async list() {
    await this.load();
    return this.tasks.map(task => ({ ...task, ...describeSchedule(task, this.now()) }));
  }

  async get(id) {
    await this.load();
    const task = this.tasks.find(item => item.id === id);
    return task ? { ...task, ...describeSchedule(task, this.now()) } : undefined;
  }

  async create(input) {
    const normalized = normalizeSchedule(input, this.now());
    if (normalized.error) throw Object.assign(new Error(normalized.error.message), normalized.error);
    await this.load();
    const task = { id: randomUUID(), ...normalized.value, createdAt: this.now().toISOString(), lastRunAt: null, lastStatus: "", lastSessionId: "", lastError: "" };
    this.tasks.push(task);
    await this.save();
    return { ...task, ...describeSchedule(task, this.now()) };
  }

  async update(id, patch = {}) {
    await this.load();
    const index = this.tasks.findIndex(item => item.id === id);
    if (index < 0) return undefined;
    const merged = { ...this.tasks[index], ...patch };
    if (patch.title !== undefined || patch.prompt !== undefined || patch.kind !== undefined || patch.at !== undefined || patch.time !== undefined || patch.days !== undefined) {
      const normalized = normalizeSchedule({ ...merged, ...patch }, this.now());
      if (normalized.error) throw Object.assign(new Error(normalized.error.message), normalized.error);
      Object.assign(merged, normalized.value);
    }
    if (patch.enabled !== undefined) merged.enabled = patch.enabled !== false;
    this.tasks[index] = merged;
    await this.save();
    return { ...merged, ...describeSchedule(merged, this.now()) };
  }

  async remove(id) {
    await this.load();
    const before = this.tasks.length;
    this.tasks = this.tasks.filter(item => item.id !== id);
    if (this.tasks.length === before) return false;
    await this.save();
    return true;
  }

  /** 到期检查：返回需要执行的任务，并把 lastRunAt/nextRunAt 一并推进。 */
  async due(at = this.now()) {
    await this.load();
    const stamp = at.getTime();
    const ready = this.tasks.filter(task => {
      if (task.enabled === false || task.running) return false;
      const occurrence = lastOccurrence(task, at);
      if (occurrence === null) return false;
      const since = task.lastRunAt ? Date.parse(task.lastRunAt) : Date.parse(task.createdAt || 0);
      return occurrence > since;
    });
    for (const task of ready) {
      task.running = true;
      task.lastRunAt = at.toISOString();
    }
    if (ready.length) await this.save();
    return ready.map(task => ({ ...task }));
  }

  async finish(id, { ok, sessionId = "", error = "" } = {}) {
    await this.load();
    const task = this.tasks.find(item => item.id === id);
    if (!task) return undefined;
    delete task.running;
    task.lastStatus = ok ? "succeeded" : "failed";
    task.lastSessionId = sessionId;
    task.lastError = String(error || "").slice(0, 300);
    // 单次任务执行后自动停用，避免 nextRunAt 永远为空却仍显示为启用。
    if (task.kind === "once") task.enabled = false;
    await this.save();
    return { ...task, ...describeSchedule(task, this.now()) };
  }
}