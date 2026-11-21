import http from "node:http";
import https from "node:https";
import path from "node:path";
import { createReadStream } from "node:fs";
import { stat, readFile, mkdir, writeFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { runTurn } from "./agent.mjs";
import { handleWorkspaceRequest } from "./workspace-http.mjs";
import { PairingError, readInvite, clearInvite } from "./pairing.mjs";
import { createServiceProbe } from "./states.mjs";
import { createApprovals } from "./approvals.mjs";
import { taskStatus, startupStatus, startupEntryPath } from "./service.mjs";
import { validSessionId, SessionStore } from "./sessions.mjs";
import { lanUrls, isLoopback, publicBase, loginCapability } from "./settings.mjs";
import { AssignmentsService } from "./assignments.mjs";
import { TimetableService } from "./timetable.mjs";
import { createLocalTimetable } from "./timetable-local.mjs";
import { available as sportsAvailable, listSlots, listSports, listVenues, reserve as sportsReserve, scenes as sportsScenes, SportsError } from "./sports.mjs";
import { prepareBooking, bookingStatus, closeBooking, BookingError } from "./sports-booking.mjs";
import { loadGitlabConfig, saveGitlabConfig, maskToken, gitlabRequest, GitlabError } from "../gitlab/client.mjs";
import { clearAccount, loadAccount, maskAccount, saveAccount } from "./account.mjs";
import { applyLearnxSignal, clearLearnxSignal, learnxExpiredSignal, reportLearnxExpired } from "./session-signals.mjs";
import { loginAll } from "./login-all.mjs";
import { areas as seatAreas, days as seatDays, rules as seatRules, floors as seatFloors, libraries as seatLibraries, login as seatLogin, reserve as seatReserve, seats as seatSeats, sections as seatSections, segments as seatSegments, SeatError } from "./seat.mjs";
import { canonicalJson, createConfirmations } from "./confirmations.mjs";
const here = fileURLToPath(new URL("./", import.meta.url));
const DEFAULT_WEBUI = path.join(path.dirname(path.dirname(here)), "webui");
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
};
const PUBLIC = new Set(["GET /healthz", "POST /api/pair/redeem"]);
function json(res, status, data) {
  if (res.writableEnded) return;
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  res.end(JSON.stringify(data));
}
function fail(res, status, code, message) {
  json(res, status, { ok: false, error: { code, message } });
}
function readBody(req, limit = 1048576) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    const done = (fn, value) => {
      req.off("data", onData);
      req.off("end", onEnd);
      req.off("error", onError);
      fn(value);
    };
    const onData = (chunk) => {
      size += chunk.length;
      if (size > limit) {
        done(reject, Object.assign(new Error("请求体过大。"), { code: "PAYLOAD_TOO_LARGE" }));
        req.resume();
        return;
      }
      chunks.push(chunk);
    };
    const onEnd = () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw.trim()) return done(resolve, {});
      try {
        const parsed = JSON.parse(raw);
        done(resolve, parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {});
      } catch {
        done(reject, Object.assign(new Error("请求体必须是 JSON。"), { code: "INVALID_JSON" }));
      }
    };
    const onError = () => done(reject, Object.assign(new Error("读取请求失败。"), { code: "INVALID_REQUEST" }));
    req.on("data", onData);
    req.once("end", onEnd);
    req.once("error", onError);
  });
}
function readBytes(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    const done = (fn, value) => { req.off("data", onData); req.off("end", onEnd); req.off("error", onError); fn(value); };
    const onData = chunk => {
      size += chunk.length;
      if (size > limit) { done(reject, Object.assign(new Error("文件过大。"), { code: "PAYLOAD_TOO_LARGE" })); req.resume(); return; }
      chunks.push(chunk);
    };
    const onEnd = () => done(resolve, Buffer.concat(chunks));
    const onError = () => done(reject, Object.assign(new Error("读取文件失败。"), { code: "INVALID_REQUEST" }));
    req.on("data", onData);
    req.once("end", onEnd);
    req.once("error", onError);
  });
}
function bearer(req) {
  const value = req.headers.authorization || "";
  const match = /^Bearer\s+(\S+)$/i.exec(value);
  return match ? match[1] : "";
}
function hostOf(value) {
  const raw = String(value || "");
  const trimmed = raw.startsWith("[") ? raw : raw.split(":")[0];
  return trimmed.toLowerCase();
}
/**
 * 把各服务自己的状态载荷归一化成 ready / login-required / expired / unknown。
 * 只反映本机已保存的会话是否可用；not_checked 表示配置存在但尚未在线校验。
 */
function searchJob(node, id, depth = 0) {
  if (!node || typeof node !== "object" || depth > 6) return null;
  if (Array.isArray(node)) {
    for (const item of node) {
      const found = searchJob(item, id, depth + 1);
      if (found) return found;
    }
    return null;
  }
  if (node.id === id || node.jobId === id) return node;
  for (const value of Object.values(node)) {
    const found = searchJob(value, id, depth + 1);
    if (found) return found;
  }
  return null;
}
export function createAppServer({
  config,
  host,
  route,
  devices,
  pairing,
  sessions,
  version,
  webuiDir = DEFAULT_WEBUI,
  logger = () => {},
  tls = null,
  keepAlive = null,
}) {
  const settingsFile = path.join(config.stateDir, "settings.json");
  const approvals = createApprovals({ timeoutMs: config.approvalTimeoutMs });
  const confirmations = createConfirmations();
  const assignments = new AssignmentsService(host);
  const timetableLocal = createLocalTimetable(path.join(config.stateDir, "timetable-local.json"));
  const timetable = new TimetableService(host, { local: timetableLocal });
  const jobs = new Map();
  const turns = new Map();
  const allowedHosts = new Set([
    "127.0.0.1",
    "localhost",
    "[::1]",
    "::1",
    config.hostname.toLowerCase(),
  ]);
  for (const url of lanUrls(config.port)) {
    try {
      allowedHosts.add(new URL(url).hostname.toLowerCase());
    } catch {}
  }
  for (const extra of config.extraHosts || []) allowedHosts.add(extra);
  if (config.publicUrl) {
    try {
      allowedHosts.add(new URL(config.publicUrl).hostname.toLowerCase());
    } catch {}
  }
  const overrides = { modelName: config.modelName };
  const loaded = readFile(settingsFile, "utf8")
    .then((raw) => {
      const parsed = JSON.parse(raw);
      if (typeof parsed.modelName === "string") overrides.modelName = parsed.modelName;
      // 旧 settings.json 的 maxSteps 兼容忽略，不恢复已移除的步数截断。
    })
    .catch(() => {});
  async function authorize(req) {
    const token = bearer(req);
    if (!token) return null;
    if (config.token && token === config.token) return { id: "local", name: "本机固定令牌", platform: "local" };
    return devices.verify(token);
  }
  const probeServices = createServiceProbe(host);
  const serviceStates = async () => applyLearnxSignal(await probeServices(), learnxExpiredSignal());
  function resolveStatic(pathname) {
    const relative = decodeURIComponent(pathname).replace(/^\/+/, "");
    const target = path.resolve(webuiDir, relative || "index.html");
    if (target !== webuiDir && !target.startsWith(webuiDir + path.sep)) return null;
    return target;
  }
  async function serveStatic(req, res, pathname) {
    // 浏览器总会顺手请求 /favicon.ico：直接给 SVG 图标，省掉一条 404 噪音。
    let target =
      pathname === "/favicon.ico" ? path.join(webuiDir, "icons", "icon.svg") : resolveStatic(pathname);
    if (!target) return fail(res, 400, "INVALID_PATH", "路径不合法。");
    let info = await stat(target).catch(() => null);
    if (!info && path.extname(target) === "") {
      target = path.join(webuiDir, "index.html");
      info = await stat(target).catch(() => null);
    }
    if (!info || !info.isFile()) {
      if (pathname === "/" || pathname === "/index.html") {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
        res.end(
          `<!doctype html><meta charset="utf-8"><title>thu-campus app</title>` +
            `<body style="font:16px system-ui;padding:2rem;max-width:40rem;margin:auto">` +
            `<h1>运行时已启动</h1><p>WebUI 静态文件尚未安装：运行 <code>npm run build</code> 后重启，或等待 webui 分支合并。</p>` +
            `<p>API 可用：<code>/healthz</code>、<code>/api/meta</code>（需设备令牌）。</p></body>`,
        );
        return;
      }
      return fail(res, 404, "NOT_FOUND", "资源不存在。");
    }
    const type = MIME[path.extname(target).toLowerCase()] || "application/octet-stream";
    // HTML 与 service worker 里的 __ASSET_VERSION__ 统一在此替换，版本号只有一个来源。
    const versioned = path.extname(target) === ".html" || target.endsWith(`${path.sep}sw.js`);
    let payload = null;
    if (versioned) {
      const text = await readFile(target, "utf8");
      payload = text.replaceAll("__ASSET_VERSION__", version || "");
    }
    // 本地应用：升级后必须立刻生效，因此一律要求重新校验，不做长期缓存。
    res.writeHead(200, {
      "Content-Type": type,
      "Cache-Control": "no-cache",
      "X-Content-Type-Options": "nosniff",
      // frame-ancestors 只能通过响应头生效，写在 <meta> 里会被浏览器忽略。
      "X-Frame-Options": "DENY",
      "Content-Security-Policy": "frame-ancestors 'none'",
    });
    if (payload !== null) {
      res.end(payload);
      return;
    }
    createReadStream(target).pipe(res);
  }
  async function handleChat(req, res, body) {
    const text = typeof body.text === "string" ? body.text.trim() : "";
    if (!text) return fail(res, 400, "INVALID_ARGUMENTS", "消息不能为空。");
    if (text.length > 20000) return fail(res, 400, "INVALID_ARGUMENTS", "单条消息过长。");
    let sessionId = body.sessionId;
    if (sessionId === undefined || sessionId === null || sessionId === "") {
      sessionId = (await sessions.create({})).id;
    } else if (!validSessionId(sessionId)) {
      return fail(res, 400, "INVALID_SESSION", "会话 ID 不合法。");
    } else if (!(await sessions.get(sessionId))) {
      return fail(res, 404, "SESSION_NOT_FOUND", "会话不存在。");
    }
    if (turns.has(sessionId)) return fail(res, 409, "TURN_RUNNING", "该会话正在对话中。");
    // 必须给出具体模型名：madmodel 收到空 model 会直接回 INVALID_REQUEST。
    let model = typeof body.model === "string" && body.model ? body.model : overrides.modelName || "";
    if (!model) {
      const available = await route.models().catch(() => []);
      model = available[0]?.id || "";
    }
    if (!model) return fail(res, 503, "MODEL_UNAVAILABLE", "没有可用的模型，请先检查模型登录状态。");
    // 解析目录包含异步操作，必须在其后再次检查并占用会话。
    if (turns.has(sessionId)) return fail(res, 409, "TURN_RUNNING", "该会话正在对话中。");
    const controller = new AbortController();
    turns.set(sessionId, controller);
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-store",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    const emit = (event, data) => {
      if (res.writableEnded || res.destroyed) return;
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };
    emit("ready", { sessionId, model: model || "auto" });
    res.once("close", () => {
      if (res.writableEnded) return;
      controller.abort();
      approvals.cancelSession(sessionId, "aborted");
    });
    let result = { sessionId, steps: 0 };
    try {
      result = await runTurn({
        host,
        route,
        store: sessions,
        sessionId,
        text,
        model,
        emit,
        signal: controller.signal,
        approvals,
        requireApproval: config.requireApproval !== false,
      });
    } catch (e) {
      emit("error", {
        code: /^[A-Z_]+$/.test(e?.code || "") ? e.code : "TURN_FAILED",
        message: e?.code === "SESSION_NOT_FOUND" ? "会话不存在。" : "本轮对话失败。",
      });
    } finally {
      approvals.cancelSession(sessionId);
      turns.delete(sessionId);
      emit("done", {
        sessionId,
        steps: result.steps,
        ...(result.usage ? { usage: result.usage } : {}),
        ...(result.aborted ? { aborted: true } : {}),
      });
      res.end();
    }
  }
  const handler = async (req, res) => {
    try {
      const url = new URL(req.url || "/", "http://localhost");
      const pathname = url.pathname;
      const method = req.method || "GET";
      const hostHeader = hostOf(req.headers.host);
      if (hostHeader && !allowedHosts.has(hostHeader))
        return fail(res, 403, "HOST_REJECTED", "请求来源主机不被允许。");
      const origin = req.headers.origin;
      if (origin) {
        let originHost = "";
        try {
          originHost = hostOf(new URL(origin).host);
        } catch {
          originHost = "";
        }
        const listed = (config.extraOrigins || []).includes(origin.toLowerCase());
        if (!listed && (!originHost || !allowedHosts.has(originHost)))
          return fail(res, 403, "ORIGIN_REJECTED", "拒绝跨站请求。");
      }
      const key = `${method} ${pathname}`;
      if (!PUBLIC.has(key) && !pathname.startsWith("/api/")) {
        if (method === "GET" || method === "HEAD") return await serveStatic(req, res, pathname);
        return fail(res, 405, "METHOD_NOT_ALLOWED", "不支持的请求方法。");
      }
      if (pathname === "/healthz") {
        if (method !== "GET") return fail(res, 405, "METHOD_NOT_ALLOWED", "不支持的请求方法。");
        return json(res, 200, { ok: true, version, uptimeMs: Math.round(process.uptime() * 1000) });
      }
      if (pathname === "/api/pair/redeem") {
        if (method !== "POST") return fail(res, 405, "METHOD_NOT_ALLOWED", "不支持的请求方法。");
        if (config.token) return fail(res, 403, "PAIRING_DISABLED", "已配置固定令牌，配对被禁用。");
        const body = await readBody(req, 8192);
        try {
          pairing.consume(body.code);
        } catch (e) {
          // 回落到 `app invite` 预生成的邀请码（守护进程场景，控制台不可见）。
          const invite = readInvite(config.stateDir);
          if (invite && String(body.code || "").trim() === invite.code) {
            clearInvite(config.stateDir);
          } else {
            if (e instanceof PairingError) return fail(res, 403, e.code, e.message);
            throw e;
          }
        }
        const platform = ["webui", "desktop", "android", "harmony"].includes(body.platform)
          ? body.platform
          : "webui";
        const issued = await devices.issue({
          name: typeof body.deviceName === "string" ? body.deviceName.slice(0, 64) : "未命名设备",
          platform,
        });
        logger("device-paired", { platform });
        return json(res, 200, {
          ok: true,
          token: issued.token,
          deviceId: issued.id,
          baseUrl: publicBase(config),
        });
      }
      const device = await authorize(req);
      if (!device) return fail(res, 401, "AUTH_REQUIRED", "需要设备令牌，请先配对。");
      await loaded;
      if (pathname === "/api/meta" && method === "GET") {
        const status = await route.status().catch(() => ({ available: false, route: config.modelRoute }));
        const models = await route.models().catch(() => []);
        return json(res, 200, {
          ok: true,
          version,
          hostname: config.hostname,
          account: { bound: !!status.masked, masked: status.masked || "" },
          model: {
            route: status.route,
            name: overrides.modelName || models[0]?.id || "",
            available: !!status.available,
          },
          models,
          services: await serviceStates(),
          pairing: { enabled: !config.token, deviceCount: await devices.count() },
          lanUrls: isLoopback(config.host) ? lanUrls(config.port) : [],
          loginCapability: loginCapability(),
          keepAlive: keepAlive
            ? {
                enabled: keepAlive.status().enabled,
                lastRunAt: keepAlive.status().lastRunAt,
                expiredServices: keepAlive.status().expiredServices,
              }
            : { enabled: false },
          security: {
            https: !!config.tlsCert,
            hosted: !isLoopback(config.host) || !!config.publicUrl,
            publicUrl: config.publicUrl || null,
            allowRemote: !!config.allowRemote,
          },
        });
      }
      if (pathname === "/api/pair/invite" && method === "POST") {
        if (config.token) return fail(res, 403, "PAIRING_DISABLED", "已配置固定令牌，配对被禁用。");
        const issued = pairing.issue();
        return json(res, 200, {
          ok: true,
          code: issued.code,
          expiresAt: issued.expiresAt,
          ttlSeconds: issued.ttlSeconds,
          lanUrls: lanUrls(config.port),
        });
      }
      if (pathname === "/api/devices" && method === "GET")
        return json(res, 200, { ok: true, devices: await devices.list() });
      const deviceMatch = /^\/api\/devices\/([A-Za-z0-9-]+)$/.exec(pathname);
      if (deviceMatch && method === "DELETE") {
        const removed = await devices.revoke(deviceMatch[1]);
        return removed
          ? json(res, 200, { ok: true, revoked: deviceMatch[1] })
          : fail(res, 404, "DEVICE_NOT_FOUND", "设备不存在。");
      }
      if (pathname === "/api/models" && method === "GET") {
        try {
          const models = await route.models({ refresh: url.searchParams.get("refresh") === "1", strict: true });
          if (!models.length)
            return fail(res, 502, "MODEL_DISCOVERY_FAILED", "模型服务没有返回可用模型，请刷新重试。");
          return json(res, 200, {
            ok: true,
            models,
            current: overrides.modelName || models[0].id,
            route: config.modelRoute,
          });
        } catch {
          return fail(res, 502, "MODEL_DISCOVERY_FAILED", "无法获取模型列表，请检查网络后刷新重试。");
        }
      }
      if (pathname === "/api/tools" && method === "GET")
        return json(res, 200, { ok: true, tools: host.describe() });
      if (await handleWorkspaceRequest({ method, url, res, host, sessions, json, fail })) return;
      const toolMatch = /^\/api\/tools\/([a-z][a-z0-9_]{2,63})$/.exec(pathname);
      if (toolMatch && method === "POST") {
        if (toolMatch[1].startsWith("workspace_") || toolMatch[1].startsWith("cloud_workspace_")) return fail(res, 403, "WORKSPACE_CHAT_REQUIRED", "请在对话中调用工作区工具；初始化私有范围、本机导入和代码执行必须经过确认。");
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
      if (pathname === "/api/sidebar/assignments" && method === "GET") {
        const overview = await assignments.overview({ refresh: url.searchParams.get("refresh") === "1" });
        if (overview.state === "unavailable" && overview.error?.code === "AUTH_REQUIRED") reportLearnxExpired();
        else if (overview.state === "ready") clearLearnxSignal();
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
      if (pathname === "/api/account") {
      if (method === "GET") {
        const account = await loadAccount(config.stateDir);
        return json(res, 200, {
          ok: true,
          configured: Boolean(account),
          masked: account ? maskAccount(account) : "",
          source: account?.source || "none",
        });
      }
      if (method === "PUT") {
        const body = await readBody(req, 8192);
        try {
          const saved = await saveAccount({ username: body?.username, password: body?.password }, config.stateDir);
          return json(res, 200, { ok: true, configured: true, masked: maskAccount(saved), source: "account" });
        } catch (error) {
          return fail(res, 400, error?.code || "INVALID_ARGUMENTS", error?.message || "账号保存失败。");
        }
      }
      if (method === "DELETE") {
        await clearAccount(config.stateDir);
        return json(res, 200, { ok: true, configured: false, masked: "", source: "none" });
      }
    }
    if (pathname === "/api/account/login" && method === "POST") {
      try {
        const result = await loginAll();
        return json(res, result.ok ? 200 : 502, { ok: result.ok, ...result });
      } catch (error) {
        if (error?.code === "ACCOUNT_NOT_CONFIGURED") return fail(res, 409, "ACCOUNT_NOT_CONFIGURED", error.message);
        throw error;
      }
    }
    if (pathname === "/api/gitlab/config") {
      const options = { stateDir: config.stateDir };
      if (method === "GET") {
        const current = await loadGitlabConfig(options);
        return json(res, 200, { ok: true, baseUrl: current.baseUrl, configured: current.configured, masked: maskToken(current.token), source: current.source });
      }
      if (method === "PUT") {
        const body = await readBody(req, 8192);
        try {
          const saved = await saveGitlabConfig({ baseUrl: body?.baseUrl, token: body?.token }, options);
          const current = await loadGitlabConfig(options);
          return json(res, 200, { ok: true, baseUrl: saved.baseUrl, configured: saved.configured, masked: maskToken(current.token) });
        } catch (error) {
          if (error instanceof GitlabError) return fail(res, 400, error.code, error.message);
          throw error;
        }
      }
    }
    if (pathname === "/api/gitlab/test" && method === "POST") {
      const current = await loadGitlabConfig({ stateDir: config.stateDir });
      try {
        const [user, version] = await Promise.all([
          gitlabRequest("user", { config: current }),
          gitlabRequest("version", { config: current }),
        ]);
        return json(res, 200, { ok: true, version: version?.version || "unknown", user: { username: user?.username, name: user?.name } });
      } catch (error) {
        if (error instanceof GitlabError) return json(res, error.code === "GITLAB_NOT_CONFIGURED" ? 409 : 502, { ok: false, error: { code: error.code, message: error.message } });
        throw error;
      }
    }
    if (pathname === "/api/sports/booking/prepare" && method === "POST") {
      const body = await readBody(req, 8192).catch(() => null);
      try {
        const result = await prepareBooking({
          sport: typeof body?.sport === "string" ? body.sport.trim() : "游泳",
          venue: typeof body?.venue === "string" ? body.venue.trim() : "陈明游泳馆",
          start: typeof body?.start === "string" ? body.start.trim() : "",
          end: typeof body?.end === "string" ? body.end.trim() : "",
          date: typeof body?.date === "string" ? body.date.trim() : "",
        });
        return json(res, 200, { ok: true, ...result, status: bookingStatus() });
      } catch (error) {
        if (error instanceof BookingError)
          return json(res, error.code === "ARGUMENT_REQUIRED" ? 400 : 409, { ok: false, error: { code: error.code, message: error.message } });
        throw error;
      }
    }
    if (pathname === "/api/sports/booking/status" && method === "GET")
      return json(res, 200, { ok: true, ...bookingStatus() });
    if (pathname === "/api/sports/booking/close" && method === "POST")
      return json(res, 200, { ok: true, ...(await closeBooking()) });
    if (pathname === "/api/seat/login" && method === "POST") {
        try {
          return json(res, 200, { ok: true, ...(await seatLogin()) });
        } catch (error) {
          if (error instanceof SeatError)
            return json(res, error.code === "BROWSER_BUSY" ? 409 : 502, { ok: false, error: { code: error.code, message: error.message } });
          throw error;
        }
      }
      if (pathname === "/api/sports/reserve/prepare" && method === "POST") {
      const body = await readBody(req, 8192).catch(() => null);
      const args = {
        sceneUuid: typeof body?.sceneUuid === "string" ? body.sceneUuid.trim() : "",
        siteUuid: typeof body?.siteUuid === "string" ? body.siteUuid.trim() : "",
        siteType: typeof body?.siteType === "string" ? body.siteType.trim() : "",
        day: typeof body?.day === "string" ? body.day.trim() : "",
        startTime: typeof body?.startTime === "string" ? body.startTime.trim() : "",
        endTime: typeof body?.endTime === "string" ? body.endTime.trim() : "",
        members: Array.isArray(body?.members) ? body.members.slice(0, 10) : [],
        formId: typeof body?.formId === "string" ? body.formId.trim() : "",
        deployUuid: typeof body?.deployUuid === "string" ? body.deployUuid.trim() : "",
      };
      if (!args.sceneUuid || !args.siteUuid || !args.startTime || !args.endTime)
        return json(res, 400, { ok: false, error: { code: "ARGUMENT_REQUIRED", message: "请指定场地与时段。" } });
      const issued = confirmations.issue("sports-reserve", canonicalJson(args));
      return json(res, 200, { ok: true, ...issued, args });
    }
    if (pathname === "/api/sports/reserve" && method === "POST") {
      const body = await readBody(req, 8192).catch(() => null);
      const args = {
        sceneUuid: typeof body?.sceneUuid === "string" ? body.sceneUuid.trim() : "",
        siteUuid: typeof body?.siteUuid === "string" ? body.siteUuid.trim() : "",
        siteType: typeof body?.siteType === "string" ? body.siteType.trim() : "",
        day: typeof body?.day === "string" ? body.day.trim() : "",
        startTime: typeof body?.startTime === "string" ? body.startTime.trim() : "",
        endTime: typeof body?.endTime === "string" ? body.endTime.trim() : "",
        members: Array.isArray(body?.members) ? body.members.slice(0, 10) : [],
        formId: typeof body?.formId === "string" ? body.formId.trim() : "",
        deployUuid: typeof body?.deployUuid === "string" ? body.deployUuid.trim() : "",
      };
      if (!confirmations.consume(body?.confirmToken, "sports-reserve", canonicalJson(args)))
        return json(res, 428, { ok: false, error: { code: "APPROVAL_REQUIRED", message: "预约需要二次确认。" } });
      try {
        const result = await sportsReserve(args);
        return json(res, 200, { ok: true, ...result });
      } catch (error) {
        if (error instanceof SportsError)
          return json(res, error.code === "SPORTS_LOCK_FAILED" ? 409 : 502, { ok: false, error: { code: error.code, message: error.message } });
        throw error;
      }
    }
    if (pathname === "/api/seat/reserve/prepare" && method === "POST") {
        const body = await readBody(req, 4096);
        const args = { space: Number(body?.space) || 0, segment: Number(body?.segment) || 0, day: typeof body?.day === "string" ? body.day.slice(0, 10) : "" };
        if (!args.space || !args.segment)
          return json(res, 400, { ok: false, error: { code: "ARGUMENT_REQUIRED", message: "请指定座位与时段。" } });
        const issued = confirmations.issue("seat-reserve", canonicalJson(args));
        return json(res, 200, { ok: true, ...issued, args });
      }
      if (pathname === "/api/seat/reserve" && method === "POST") {
        const body = await readBody(req, 4096);
        const args = { space: Number(body?.space) || 0, segment: Number(body?.segment) || 0, day: typeof body?.day === "string" ? body.day.slice(0, 10) : "" };
        if (!confirmations.consume(body?.confirmToken, "seat-reserve", canonicalJson(args)))
          return json(res, 428, { ok: false, error: { code: "APPROVAL_REQUIRED", message: "预约需要二次确认。" } });
        try {
          const result = await seatReserve(args);
          if (!result.ok)
            return json(res, 409, { ok: false, error: { code: result.code || "SEAT_BOOK_FAILED", message: result.message || "预约未成功。" } });
          return json(res, 200, { ok: true, ...result });
        } catch (error) {
          if (error instanceof SeatError)
            return json(res, error.code === "SEAT_LOGIN_REQUIRED" ? 401 : 502, { ok: false, error: { code: error.code, message: error.message } });
          throw error;
        }
      }
      if (pathname.startsWith("/api/seat/") && method === "GET") {
        const handlers = {
          libraries: () => seatLibraries(),
          floors: () => seatFloors(url.searchParams.get("library")),
          areas: () => seatAreas(url.searchParams.get("floor")),
          rules: () => seatRules(),
          segments: () => seatSegments(url.searchParams.get("section")),
          days: () => seatDays(url.searchParams.get("section")),
          seats: () => seatSeats(url.searchParams.get("section"), url.searchParams.get("date") || ""),
          sections: () => seatSections(url.searchParams.get("library")),
        };
        const handler = handlers[pathname.slice("/api/seat/".length)];
        if (handler) {
          try {
            return json(res, 200, { ok: true, ...(await handler()) });
          } catch (error) {
            if (error instanceof SeatError)
              return json(res, error.code === "ARGUMENT_REQUIRED" ? 400 : error.code === "BROWSER_BUSY" || error.code === "SPORTS_MAINTENANCE" ? 503 : 502, { ok: false, error: { code: error.code, message: error.message } });
            throw error;
          }
        }
      }
      if (pathname.startsWith("/api/sports/") && method === "GET") {
        const route = pathname.slice("/api/sports/".length);
        try {
          if (route === "sports")
            return json(res, 200, { ok: true, ...(await listSports({ refresh: url.searchParams.get("refresh") === "1" })) });
          if (route === "venues")
            return json(res, 200, { ok: true, ...(await listVenues(url.searchParams.get("sport") || "")) });
          if (route === "scenes")
        return json(res, 200, { ok: true, ...(await sportsScenes()) });
      if (route === "available")
        return json(res, 200, {
          ok: true,
          ...(await sportsAvailable({ sceneUuid: url.searchParams.get("scene") || "", date: url.searchParams.get("date") || "" })),
        });
      if (route === "slots")
            return json(res, 200, {
              ok: true,
              ...(await listSlots({
                sport: url.searchParams.get("sport") || "",
                venue: url.searchParams.get("venue") || "",
                date: url.searchParams.get("date") || "",
              })),
            });
        } catch (error) {
          if (error instanceof SportsError)
            return json(res, error.code === "SPORT_REQUIRED" || error.code === "ARGUMENT_REQUIRED" ? 400 : error.code === "BROWSER_BUSY" || error.code === "SEAT_CLOSED" ? 503 : 502, {
              ok: false,
              error: { code: error.code, message: error.message },
            });
          throw error;
        }
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
      if (pathname === "/api/auth/status" && method === "GET")
        return json(res, 200, {
          ok: true,
          services: await serviceStates(),
          model: await route.status().catch(() => ({ available: false })),
        });
      if (pathname === "/api/auth/login" && method === "POST") {
        const body = await readBody(req, 8192);
        const service = ["learnx", "cloud", "hetang", "madmodel", "all"].includes(body.service)
          ? body.service
          : "";
        if (!service) return fail(res, 400, "INVALID_ARGUMENTS", "服务名不合法。");
        const result = await host.call("campus_browser_login", {
          service,
          ...(typeof body.account === "string" && body.account.trim()
            ? { account: body.account.trim() }
            : {}),
        });
        if (!result.ok) return json(res, 400, { ok: false, error: result.error });
        const jobId = result.data?.id || result.data?.jobId || "";
        if (jobId) jobs.set(jobId, { id: jobId, kind: "login", service, startedAt: new Date().toISOString() });
        return json(res, 200, { ok: true, jobId, job: result.data });
      }
      const jobMatch = /^\/api\/jobs\/([A-Za-z0-9_-]{1,128})$/.exec(pathname);
      if (jobMatch && method === "GET") {
        const id = jobMatch[1];
        const { browserOverview } = await import("../browser.mjs");
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
      if (pathname === "/api/settings") {
        if (method === "GET")
          return json(res, 200, {
            ok: true,
            settings: {
              modelName: overrides.modelName,
              keepAliveMinutes: keepAlive ? Math.round(keepAlive.status().intervalMs / 60000) : 0,
              keepAliveRestore: keepAlive ? keepAlive.status().restoreExpired : false,
            },
            modelRoute: config.modelRoute,
          });
        if (method === "PUT") {
          const body = await readBody(req, 8192);
          if (typeof body.modelName === "string") overrides.modelName = body.modelName.slice(0, 200);
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
          const { atomic, directory } = await import("../../packages/browser/core.mjs");
          await directory(config.stateDir);
          await atomic(settingsFile, Buffer.from(JSON.stringify(overrides)));
          return json(res, 200, { ok: true, settings: overrides });
        }
      }
      return fail(res, 404, "NOT_FOUND", "接口不存在。");
    } catch (e) {
      const code = /^[A-Z_]+$/.test(e?.code || "") ? e.code : "APP_ERROR";
      const status = code === "PAYLOAD_TOO_LARGE" ? 413 : code === "INVALID_JSON" ? 400 : 500;
      return fail(res, status, code, status === 500 ? "请求处理失败。" : e.message);
    }
  };
  const server = tls
    ? https.createServer({ cert: tls.cert, key: tls.key }, handler)
    : http.createServer(handler);
  server.on("clientError", (_err, socket) => {
    if (socket.writable) socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
  });
  return {
    server,
    get overrides() {
      return overrides;
    },
    listen() {
      return new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(config.port, config.host, () => {
          server.off("error", reject);
          const address = server.address();
          if (address && typeof address === "object" && address.port)
            config.port = address.port;
          resolve(`http://${config.host}:${config.port}`);
        });
      });
    },
    async close() {
      for (const controller of turns.values()) controller.abort();
      turns.clear();
      approvals.cancelAll("shutdown");
      await host.sandbox?.close?.();
      await new Promise((resolve) => server.close(() => resolve()));
    },
  };
}
export { SessionStore };
