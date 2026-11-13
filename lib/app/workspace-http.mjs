import path from "node:path";
import { validSessionId } from "./sessions.mjs";

/** Auth and Origin checks are performed by the parent HTTP handler before this route. */
export async function handleWorkspaceRequest({ method, url, res, host, sessions, json, fail }) {
  if (url.pathname === "/api/workspace/storage") {
    if (method !== "GET") { fail(res, 405, "METHOD_NOT_ALLOWED", "工作区状态接口只读。"); return true; }
    const storage = typeof host.storageStatus === "function" ? await host.storageStatus() : { mode: "cloud", state: "unavailable", code: "WORKSPACE_UNAVAILABLE", message: "当前运行时未提供工作区存储能力。" };
    json(res, 200, { ok: true, storage }); return true;
  }
  const match = /^\/api\/workspaces\/([0-9a-f-]{36})\/(files|jobs\/([0-9a-f-]{36})(\/stop)?)$/.exec(url.pathname);
  if (!match) return false;
  const sessionId = match[1];
  if (!validSessionId(sessionId) || !(await sessions.get(sessionId))) {
    fail(res, 404, "SESSION_NOT_FOUND", "会话不存在。");
    return true;
  }
  if (!host.workspaceFiles || !host.sandbox) {
    fail(res, 404, "WORKSPACE_UNAVAILABLE", "当前运行时没有工作区能力。");
    return true;
  }
  try {
    if (match[2] === "files" && method === "GET") {
      const relative = url.searchParams.get("path");
      if (!relative) { fail(res, 400, "INVALID_ARGUMENTS", "缺少文件相对路径。"); return true; }
      const bytes = await host.workspaceFiles.readBytes(sessionId, relative, { maxBytes: 64 * 1024 * 1024 });
      const name = path.basename(relative);
      res.writeHead(200, {
        "Content-Type": path.extname(name).toLowerCase() === ".pdf" ? "application/pdf" : "application/octet-stream",
        "Content-Length": bytes.length,
        "Content-Disposition": "attachment; filename*=UTF-8''" + encodeURIComponent(name).replace(/[()']/g, char => "%" + char.charCodeAt(0).toString(16).toUpperCase()),
        "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Content-Security-Policy": "default-src 'none'; sandbox",
      });
      res.end(bytes);
    } else if (match[3] && ((!match[4] && method === "GET") || (match[4] && method === "POST"))) {
      const jobId = match[3];
      if (!validSessionId(jobId)) { fail(res, 400, "INVALID_ARGUMENTS", "任务ID不合法。"); return true; }
      const job = match[4] ? await host.sandbox.stop(sessionId, jobId) : await host.sandbox.get(sessionId, jobId);
      json(res, 200, { ok: true, job: typeof host.job === "function" ? host.job(sessionId, job) : { ...job, statusUrl: `/api/workspaces/${sessionId}/jobs/${jobId}` } });
    } else fail(res, 405, "METHOD_NOT_ALLOWED", "不支持此操作。");
  } catch (error) {
    fail(res, /NOT_FOUND|ENOENT/.test(error.code || "") ? 404 : 400,
      /^[A-Z_]+$/.test(error.code || "") ? error.code : "WORKSPACE_FAILED", error.message || "工作区操作失败。");
  }
  return true;
}
