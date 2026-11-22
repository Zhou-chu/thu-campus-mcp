/** 课表、作业侧栏与附件上传路由。 */
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { fail, json } from "./respond.mjs";

export function createSidebarRoutes({ config, assignments, timetable, timetableLocal, confirmations, learnxSignals, readBody, readBytes }) {
  return async function handleSidebarRoutes(req, res, { pathname, method, url }) {
    if (pathname === "/api/sidebar/assignments" && method === "GET") {
      const overview = await assignments.overview({ refresh: url.searchParams.get("refresh") === "1" });
      // 作业栏先于状态页发现会话失效时，服务状态统一显示为过期。
      if (overview.state === "unavailable" && overview.error?.code === "AUTH_REQUIRED") learnxSignals.report();
      else if (overview.state === "ready") learnxSignals.clear();
      return json(res, 200, { ok: true, ...overview });
    }
    if (pathname === "/api/timetable" && method === "GET")
      return json(res, 200, { ok: true, ...(await timetable.overview({ refresh: url.searchParams.get("refresh") === "1" })) });
    if (pathname === "/api/timetable/custom" && method === "POST") {
      const body = await readBody(req, 8192).catch(() => null);
      const result = await timetableLocal.add(body);
      if (!result.ok) return json(res, 400, { ok: false, error: result.error });
      return json(res, 200, { ok: true, course: result.course, ...(await timetable.refresh()) });
    }
    if (pathname.startsWith("/api/timetable/custom/") && method === "DELETE") {
      const id = decodeURIComponent(pathname.slice("/api/timetable/custom/".length));
      const result = await timetableLocal.remove(id);
      if (!result.ok) return json(res, 404, { ok: false, error: result.error });
      return json(res, 200, { ok: true, ...(await timetable.refresh()) });
    }
    if (pathname === "/api/timetable/hide" && method === "POST") {
      const body = await readBody(req, 4096).catch(() => null);
      const result = await timetableLocal.hide(body || {});
      if (!result.ok) return json(res, 400, { ok: false, error: result.error });
      return json(res, 200, { ok: true, ...(await timetable.refresh()) });
    }
    if (pathname === "/api/timetable/unhide" && method === "POST") {
      const body = await readBody(req, 4096).catch(() => null);
      await timetableLocal.unhide(body || {});
      return json(res, 200, { ok: true, ...(await timetable.refresh()) });
    }
    const homeworkMatch = /^\/api\/sidebar\/assignments\/([^/]{1,256})\/([^/]{1,256})$/.exec(pathname);
    if (homeworkMatch && method === "GET") {
      const result = await assignments.detail(decodeURIComponent(homeworkMatch[1]), decodeURIComponent(homeworkMatch[2]));
      return result.ok ? json(res, 200, { ok: true, ...result.data }) : json(res, 400, { ok: false, error: result.error });
    }
    if (pathname === "/api/sidebar/attachments" && method === "POST") {
      const name = path.basename(url.searchParams.get("name") || "").replace(/[\u0000-\u001f<>:"/\\|?*]/g, "").slice(0, 180).trim();
      if (!name) return fail(res, 400, "INVALID_FILE_NAME", "文件名不合法。");
      const bytes = await readBytes(req, 64 * 1024 * 1024);
      if (!bytes.length) return fail(res, 400, "EMPTY_FILE", "文件是空的，未保存。");
      const dir = path.join(config.stateDir, "uploads");
      await mkdir(dir, { recursive: true });
      const target = path.join(dir, randomUUID() + path.extname(name).slice(0, 16));
      await writeFile(target, bytes);
      return json(res, 200, { ok: true, file: { path: target, name, size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") } });
    }
    if (pathname === "/api/sidebar/submissions/prepare" && method === "POST") {
      const body = await readBody(req, 65536);
      const result = await assignments.prepare({
        courseId: body.courseId, homeworkId: body.homeworkId,
        content: typeof body.content === "string" ? body.content : undefined,
        filePath: typeof body.filePath === "string" ? body.filePath : undefined,
        overwrite: body.overwrite === true,
      });
      if (!result.ok) return json(res, 400, { ok: false, error: result.error });
      const issued = confirmations.issue("submission", String(result.data?.id || ""));
      return json(res, 200, { ok: true, preparation: result.data, confirmToken: issued.token, confirmExpiresAt: issued.expiresAt });
    }
    if (pathname === "/api/sidebar/submissions/confirm" && method === "POST") {
      const body = await readBody(req, 65536);
      const preparationId = typeof body.preparationId === "string" ? body.preparationId : "";
      if (!confirmations.consume(body.confirmToken, "submission", preparationId))
        return fail(res, 409, "CONFIRMATION_REQUIRED", "提交确认已失效或被重复使用，请重新准备。");
      const result = await assignments.submit(preparationId);
      return result.ok ? json(res, 200, { ok: true, receipt: result.data }) : json(res, 400, { ok: false, error: result.error });
    }
    return false;
  };
}