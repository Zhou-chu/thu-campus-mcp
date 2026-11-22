/** 会话、对话与审批路由。turn 的并发锁与审批状态由 server 注入。 */
import { fail, json } from "./respond.mjs";

export function createChatRoutes({ host, sessions, turns, approvals, handleChat, readBody }) {
  return async function handleChatRoutes(req, res, { pathname, method }) {
    if (pathname === "/api/sessions" && method === "GET")
      return json(res, 200, { ok: true, sessions: await sessions.list() });
    const sessionMatch = /^\/api\/sessions\/([0-9a-f-]{36})$/.exec(pathname);
    if (sessionMatch) {
      if (method === "GET") {
        const session = await sessions.get(sessionMatch[1]);
        return session
          ? json(res, 200, { ok: true, session })
          : fail(res, 404, "SESSION_NOT_FOUND", "会话不存在。");
      }
      if (method === "PATCH") {
        const body = await readBody(req, 4096);
        const renamed = await sessions
          .rename(sessionMatch[1], body.title)
          .catch((error) => ({ error }));
        if (renamed?.error)
          return fail(res, 400, renamed.error.code || "INVALID_ARGUMENTS", renamed.error.message);
        return renamed
          ? json(res, 200, { ok: true, session: renamed })
          : fail(res, 404, "SESSION_NOT_FOUND", "会话不存在。");
      }
      if (method === "DELETE") {
        await host.sandbox?.stopSession?.(sessionMatch[1]);
        const removed = await sessions.remove(sessionMatch[1]);
        return removed
          ? json(res, 200, { ok: true, removed: sessionMatch[1] })
          : fail(res, 404, "SESSION_NOT_FOUND", "会话不存在。");
      }
    }
    if (pathname === "/api/chat" && method === "POST") {
      const body = await readBody(req, 65536);
      return await handleChat(req, res, body);
    }
    const abortMatch = /^\/api\/chat\/([0-9a-f-]{36})\/abort$/.exec(pathname);
    if (abortMatch && method === "POST") {
      const controller = turns.get(abortMatch[1]);
      approvals.cancelSession(abortMatch[1], "aborted");
      if (!controller) return json(res, 200, { ok: true, aborted: false });
      controller.abort();
      return json(res, 200, { ok: true, aborted: true });
    }
    const confirmMatch = /^\/api\/chat\/([0-9a-f-]{36})\/confirm$/.exec(pathname);
    if (confirmMatch && method === "POST") {
      const body = await readBody(req, 8192);
      if (typeof body.callId !== "string" || !body.callId)
        return fail(res, 400, "INVALID_ARGUMENTS", "缺少 callId。");
      const decided = approvals.decide(body.callId, !!body.allow, confirmMatch[1]);
      return json(res, 200, { ok: true, decided });
    }
    return false;
  };
}