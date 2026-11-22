/**
 * 暴露给模型的定时任务工具。与 HTTP 接口共用同一个 ScheduleStore，
 * 因此界面上创建的任务与对话里创建的任务完全等价。
 */
import { normalizeSchedule } from "./schedules.mjs";

const idArg = { type: "string", description: "任务 ID；可先用 schedule_list 查询。" };

export const SCHEDULE_TOOLS = [
  {
    name: "schedule_list",
    description: "列出本机定时任务：名称、频率、下次执行时间、最近状态。",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    readOnly: true,
  },
  {
    name: "schedule_create",
    description: "创建定时任务；到点会自动新建一个会话并执行指令。支持 once（单次）、daily（每天）、weekly（每周）。",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "任务名称，最多 60 字。" },
        prompt: { type: "string", description: "到点后在新会话里发给模型的指令。" },
        kind: { type: "string", enum: ["once", "daily", "weekly"] },
        at: { type: "string", description: "kind=once 时必填，本地时间如 2026-12-01 08:30。" },
        time: { type: "string", description: "kind=daily/weekly 时必填，24 小时制 HH:MM。" },
        days: { type: "array", items: { type: "integer", minimum: 1, maximum: 7 }, description: "kind=weekly 时必填，1=周一 … 7=周日。" },
      },
      required: ["title", "prompt", "kind"],
      additionalProperties: false,
    },
    readOnly: false,
  },
  {
    name: "schedule_update",
    description: "修改定时任务；只传需要改的字段。enabled=false 可暂停，true 恢复。",
    inputSchema: {
      type: "object",
      properties: {
        id: idArg,
        title: { type: "string" },
        prompt: { type: "string" },
        kind: { type: "string", enum: ["once", "daily", "weekly"] },
        at: { type: "string" },
        time: { type: "string" },
        days: { type: "array", items: { type: "integer", minimum: 1, maximum: 7 } },
        enabled: { type: "boolean" },
      },
      required: ["id"],
      additionalProperties: false,
    },
    readOnly: false,
  },
  {
    name: "schedule_delete",
    description: "删除定时任务。删除后不再执行。",
    inputSchema: { type: "object", properties: { id: idArg }, required: ["id"], additionalProperties: false },
    readOnly: false,
  },
];

const fail = (code, message) => ({ ok: false, error: { code, message } });

export function createScheduleTools({ store }) {
  return {
    describe() {
      return SCHEDULE_TOOLS.map(({ name, description, inputSchema, readOnly }) => ({ name, description, inputSchema, readOnly: readOnly === true, service: "schedule" }));
    },
    async call(name, args = {}) {
      if (name === "schedule_list") {
        return { ok: true, data: { tasks: await store.list() } };
      }
      if (name === "schedule_create") {
        try {
          return { ok: true, data: { task: await store.create(args) } };
        } catch (error) {
          return fail(error?.code || "INVALID_ARGUMENTS", error?.message || "创建失败。");
        }
      }
      if (name === "schedule_update") {
        if (typeof args.id !== "string" || !args.id) return fail("INVALID_ARGUMENTS", "缺少任务 ID。");
        const { id, ...patch } = args;
        try {
          const task = await store.update(id, patch);
          return task ? { ok: true, data: { task } } : fail("SCHEDULE_NOT_FOUND", "任务不存在。");
        } catch (error) {
          return fail(error?.code || "INVALID_ARGUMENTS", error?.message || "更新失败。");
        }
      }
      if (name === "schedule_delete") {
        if (typeof args.id !== "string" || !args.id) return fail("INVALID_ARGUMENTS", "缺少任务 ID。");
        const removed = await store.remove(args.id);
        return removed ? { ok: true, data: { removed: args.id } } : fail("SCHEDULE_NOT_FOUND", "任务不存在。");
      }
      return fail("UNKNOWN_TOOL", "没有这个定时任务工具。");
    },
  };
}

export function withScheduleTools(host, scheduleTools) {
  return {
    describe() {
      return [...host.describe(), ...scheduleTools.describe()];
    },
    toolForModel() {
      return [
        ...host.toolForModel(),
        ...scheduleTools.describe().map(tool => ({
          type: "function",
          function: { name: tool.name, description: tool.description, parameters: tool.inputSchema },
        })),
      ];
    },
    async call(name, args, context) {
      if (name.startsWith("schedule_")) return scheduleTools.call(name, args, context);
      return host.call(name, args, context);
    },
    async prepareCall(name, args, context) {
      if (name.startsWith("schedule_")) return {};
      return host.prepareCall?.(name, args, context) ?? {};
    },
  };
}

export { normalizeSchedule };