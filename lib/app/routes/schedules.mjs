/** 定时任务 HTTP 路由：界面与模型工具读写同一份计划。 */
import { fail, json } from "./respond.mjs";

export function createScheduleRoutes({ store, runner }) {
  return async function handleScheduleRoutes(req, res, { pathname, method }) {
    if (pathname === "/api/schedules" && method === "GET") {
      return json(res, 200, { ok: true, tasks: await store.list(), runner: runner?.status?.() || null });
    }
    if (pathname === "/api/schedules" && method === "POST") {
      const body = await readBodyJson(req);
      if (!body || typeof body !== "object") return fail(res, 400, "INVALID_ARGUMENTS", "请求体必须是 JSON 对象。");
      try {
        return json(res, 200, { ok: true, task: await store.create(body) });
      } catch (error) {
        return fail(res, 400, error?.code || "INVALID_ARGUMENTS", error?.message || "创建失败。");
      }
    }
    const match = /^\/api\/schedules\/([0-9a-f-]{36})$/.exec(pathname);
    if (match) {
      const id = match[1];
      if (method === "PATCH" || method === "PUT") {
        const body = await readBodyJson(req);
        if (!body || typeof body !== "object") return fail(res, 400, "INVALID_ARGUMENTS", "请求体必须是 JSON 对象。");
        const { id: _ignored, createdAt, lastRunAt, lastStatus, lastSessionId, lastError, running, nextRunAt, when, ...patch } = body;
        try {
          const task = await store.update(id, patch);
          return task ? json(res, 200, { ok: true, task }) : fail(res, 404, "SCHEDULE_NOT_FOUND", "任务不存在。");
        } catch (error) {
          return fail(res, 400, error?.code || "INVALID_ARGUMENTS", error?.message || "更新失败。");
        }
      }
      if (method === "DELETE") {
        const removed = await store.remove(id);
        return removed ? json(res, 200, { ok: true, removed: id }) : fail(res, 404, "SCHEDULE_NOT_FOUND", "任务不存在。");
      }
    }
    return false;
  };
}

async function readBodyJson(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(chunk);
    if (chunks.reduce((size, item) => size + item.length, 0) > 65536) return null;
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  } catch {
    return null;
  }
}