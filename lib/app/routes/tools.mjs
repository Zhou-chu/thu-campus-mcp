/** 工具目录、工具调用与后台任务查询路由。 */
import { browserActiveTask, browserQueueDepth, withBrowserLock } from "../browser-lock.mjs";
import { loadAccount } from "../account.mjs";
import { LearnxAccountLoginError } from "../learnx-login.mjs";
import { loginFailure, loginSuccess, sendLogin, settleLogin } from "../login-contract.mjs";
import { fail, json } from "./respond.mjs";

export function createToolRoutes({ config, host, jobs, serviceStates, route, learnx, readBody, searchJob, confirmations, canonicalJson }) {
  return async function handleToolRoutes(req, res, { pathname, method }) {
    if (pathname === "/api/tools" && method === "GET")
      return json(res, 200, { ok: true, tools: host.describe() });
    if (pathname === "/api/browser-state" && method === "GET")
      // 让界面说清“现在是谁占着浏览器”，而不是只让用户干等 45 秒。
      return json(res, 200, { ok: true, active: browserActiveTask(), waiting: browserQueueDepth(), at: new Date().toISOString() });

    const toolMatch = /^\/api\/tools\/([a-z][a-z0-9_]{2,63})$/.exec(pathname);
    if (toolMatch && method === "POST") {
      if (toolMatch[1].startsWith("workspace_") || toolMatch[1].startsWith("cloud_workspace_"))
        return fail(res, 403, "WORKSPACE_CHAT_REQUIRED", "请在对话中调用工作区工具；初始化私有范围、本机导入和代码执行必须经过确认。");
      const body = await readBody(req, 2 * 1024 * 1024);
      // 写入类工具必须先用 /api/tool-approvals 领取一次性凭证；只带设备令牌不足以改动校园数据。
      const tool = host.describe().find(item => item.name === toolMatch[1]);
      if (tool?.destructive && !confirmations.consume(req.headers["x-campus-approval"], "tool:" + tool.name, canonicalJson(body)))
        return json(res, 428, {
          ok: false,
          requiresApproval: true,
          error: { code: "APPROVAL_REQUIRED", message: "该工具会写入校园数据，需要先确认这次调用。" },
        });
      const result = await host.call(toolMatch[1], body);
      return result.ok
        ? json(res, 200, { ok: true, data: result.data })
        : json(res, 400, { ok: false, error: result.error, data: result.data });
    }
    if (pathname === "/api/tool-approvals" && method === "POST") {
      const body = await readBody(req, 65536);
      const tool = host.describe().find(item => item.name === body.name);
      if (!tool) return fail(res, 404, "UNKNOWN_TOOL", "没有此工具。");
      if (!tool.destructive) return fail(res, 400, "NOT_REQUIRED", "该工具是只读的，不需要额外确认。");
      const args = body.args && typeof body.args === "object" && !Array.isArray(body.args) ? body.args : {};
      const issued = confirmations.issue("tool:" + tool.name, canonicalJson(args));
      return json(res, 200, { ok: true, ...issued });
    }
    if (pathname === "/api/auth/status" && method === "GET")
      return json(res, 200, {
        ok: true,
        services: await serviceStates(),
        model: await route.status().catch(() => ({ available: false })),
      });
    if (pathname === "/api/auth/learnx" && method === "POST") {
      try {
        const result = await learnx.login();
        learnx.clearSignal();
        return sendLogin(res, json, settleLogin("learnx", result));
      } catch (error) {
        if (!(error instanceof LearnxAccountLoginError)) throw error;
        return sendLogin(res, json, loginFailure("learnx", error));
      }
    }
    if (pathname === "/api/services/login" && method === "POST") {
      const body = await readBody(req, 8192);
      const service = ["learnx", "cloud", "hetang", "madmodel", "all"].includes(body.service) ? body.service : "";
      if (!service) return fail(res, 400, "INVALID_ARGUMENTS", "服务名不合法。");
      // 登录任务独占浏览器资料目录，必须与座位/体育等操作共用同一把锁。
      const saved = service === "learnx" ? (await loadAccount(config.stateDir))?.username : undefined;
      const account = saved || (typeof body.account === "string" ? body.account.trim() : "");
      const result = await withBrowserLock("登录窗口", () =>
        host.call("campus_browser_login", { service, ...(account ? { account } : {}) }),
      ).catch(error => ({ ok: false, error: { code: error?.code || "BROWSER_BUSY", message: error?.message || "浏览器正忙，请稍后再试。" } }));
      if (!result.ok) return sendLogin(res, json, loginFailure(service, result.error));
      const jobId = result.data?.id || result.data?.jobId || "";
      if (jobId) jobs.set(jobId, { id: jobId, kind: "login", service, startedAt: new Date().toISOString() });
      return sendLogin(res, json, loginSuccess(service, { jobId, job: result.data }));
    }
    if (pathname === "/api/jobs" && method === "GET") {
      // 刷新页面后还能接着跟进度：列出仍在跑（或刚失败待处理）的浏览器任务。
      const { browserOverview } = await import("../../browser.mjs");
      const overview = await browserOverview().catch(() => ({}));
      const list = (overview.jobs || [])
        .filter(job => ["queued", "running", "failed", "interrupted"].includes(job.status))
        .slice(0, 20)
        .map(job => ({
          id: job.id,
          action: job.action,
          service: job.service,
          status: job.status,
          phase: job.phase,
          error: job.error,
          updatedAt: job.updatedAt,
        }));
      return json(res, 200, { ok: true, jobs: list });
    }
    const jobMatch = /^\/api\/jobs\/([A-Za-z0-9_-]{1,128})$/.exec(pathname);
    if (jobMatch && method === "GET") {
      const id = jobMatch[1];
      const { browserOverview } = await import("../../browser.mjs");
      const overview = await browserOverview().catch(() => ({}));
      const found = searchJob(overview, id);
      return json(res, 200, {
        ok: true,
        id,
        kind: jobs.get(id)?.kind || "unknown",
        found: !!found,
        job: found || null,
        overview,
      });
    }
    return false;
  };
}