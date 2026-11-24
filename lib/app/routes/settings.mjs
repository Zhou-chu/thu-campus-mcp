/**
 * 运行时设置、保活与服务状态路由。
 * 依赖全部由 server.mjs 注入；本模块不读写全局变量。
 */
import path from "node:path";
import { startupEntryPath, startupStatus, taskStatus } from "../service.mjs";
import { fail, json } from "./respond.mjs";

export function createSettingsRoutes({ config, overrides, setEffort, efforts, keepAlive, settingsFile, debugLog = null, readBody, settingsOf = null, saveUserSettings = null }) {
  const currentSettings = async req => (settingsOf ? await settingsOf(req) : overrides);
  return async function handleSettingsRoutes(req, res, { pathname, method }) {
    if (pathname === "/api/service" && method === "GET") {
      const supported = process.platform === "win32";
      const startup = supported
        ? startupStatus({ entryPath: startupEntryPath() })
        : { installed: false, entryPath: null };
      const task = supported
        ? await taskStatus({}).catch(() => ({ installed: false }))
        : { installed: false };
      return json(res, 200, {
        ok: true,
        platform: process.platform,
        supported,
        installed: !!startup.installed || !!task.installed,
        mode: task.installed ? "scheduled-task" : startup.installed ? "startup-folder" : "none",
        task: { installed: !!task.installed, ...(task.state ? { state: task.state } : {}) },
        startup,
        wrapperPath: path.join(config.stateDir, "service-run.cmd"),
        logFile: path.join(config.stateDir, "service.log"),
        installHint: "node bin/thu-campus.mjs app service install",
      });
    }
    if (pathname === "/api/keepalive" || pathname === "/api/keepalive/run") {
      if (!keepAlive) return json(res, 200, { ok: true, enabled: false, history: [] });
      if (method === "GET" && pathname === "/api/keepalive")
        return json(res, 200, { ok: true, ...keepAlive.status() });
      if (method === "POST")
        return json(res, 200, {
          ok: true,
          result: await keepAlive.runOnce("api"),
          ...keepAlive.status(),
        });
    }
    if (pathname === "/api/debug-log" && method === "GET") return json(res, 200, { ok: true, ...(debugLog ? await debugLog.status() : { enabled: false, files: [], totalBytes: 0 }) });
    if (pathname === "/api/debug-log" && method === "PUT") {
      if (!debugLog) return json(res, 503, { ok: false, error: { code: "UNAVAILABLE", message: "当前实例不支持调试日志。" } });
      const body = await readBody(req, 4096).catch(() => null);
      await debugLog.setEnabled(body?.enabled === true);
      return json(res, 200, { ok: true, ...(await debugLog.status()) });
    }
    if (pathname === "/api/debug-log/download" && method === "GET") {
      if (!debugLog) return json(res, 503, { ok: false, error: { code: "UNAVAILABLE", message: "当前实例不支持调试日志。" } });
      const text = await debugLog.readRecent();
      res.writeHead(200, { "Content-Type": "application/x-ndjson; charset=utf-8", "Content-Disposition": "attachment; filename=debug.jsonl", "Cache-Control": "no-store" });
      res.end(text);
      return true;
    }
    if (pathname === "/api/debug-log/clear" && method === "POST") {
      if (!debugLog) return json(res, 503, { ok: false, error: { code: "UNAVAILABLE", message: "当前实例不支持调试日志。" } });
      await debugLog.clear();
      return json(res, 200, { ok: true, ...(await debugLog.status()) });
    }
    if (pathname === "/api/settings") {
      if (method === "GET") {
        const settings = await currentSettings(req);
        return json(res, 200, {
          ok: true,
          settings: {
            modelName: settings.modelName,
            ...(settings.reasoningEffort ? { reasoningEffort: settings.reasoningEffort } : {}),
            compactTools: settings.compactTools === true,
            keepAliveMinutes: keepAlive ? Math.round(keepAlive.status().intervalMs / 60000) : 0,
            keepAliveRestore: keepAlive ? keepAlive.status().restoreExpired : false,
          },
          modelRoute: config.modelRoute,
        });
      }
      if (method === "PUT") {
        const body = await readBody(req, 8192);
        const patch = {};
        if (typeof body.modelName === "string") patch.modelName = body.modelName.slice(0, 200);
        if (body.compactTools !== undefined) {
          if (typeof body.compactTools !== "boolean") return fail(res, 400, "INVALID_ARGUMENTS", "compactTools 必须是布尔值。");
          patch.compactTools = body.compactTools;
        }
        if (body.reasoningEffort !== undefined) {
          if (typeof body.reasoningEffort !== "string" || (body.reasoningEffort && !efforts.has(body.reasoningEffort)))
            return fail(res, 400, "INVALID_ARGUMENTS", "reasoningEffort 只能是空、low、medium 或 high。");
          patch.reasoningEffort = body.reasoningEffort;
        }
        // 兼容旧客户端提交 maxSteps：忽略且不再持久化或返回该字段。
        if (keepAlive && (body.keepAliveMinutes !== undefined || body.keepAliveRestore !== undefined)) {
          if (body.keepAliveMinutes !== undefined) {
            const minutes = Number(body.keepAliveMinutes);
            if (!Number.isInteger(minutes) || minutes < 0 || minutes > 1440)
              return fail(res, 400, "INVALID_ARGUMENTS", "keepAliveMinutes 必须是 0–1440 的整数。");
            keepAlive.configure({ intervalMs: minutes * 60000 });
          }
          if (body.keepAliveRestore !== undefined)
            keepAlive.configure({ restoreExpired: !!body.keepAliveRestore });
        }
        if (saveUserSettings && (await saveUserSettings(patch))) {
          return json(res, 200, { ok: true, settings: await currentSettings(req) });
        }
        if (patch.modelName !== undefined) overrides.modelName = patch.modelName;
        if (patch.compactTools !== undefined) {
          if (patch.compactTools) overrides.compactTools = true; else delete overrides.compactTools;
        }
        if (patch.reasoningEffort !== undefined) setEffort(patch.reasoningEffort);
        const { atomic, directory } = await import("../../../packages/browser/core.mjs");
        await directory(config.stateDir);
        await atomic(settingsFile, Buffer.from(JSON.stringify(overrides)));
        return json(res, 200, { ok: true, settings: overrides });
      }
    }
    return false;
  };
}