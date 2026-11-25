import http from "node:http";
import https from "node:https";
import path from "node:path";
import { createReadStream } from "node:fs";
import { stat, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { runTurn } from "./agent.mjs";
import { PairingError, readInvite, clearInvite } from "./pairing.mjs";
import { createAuthRoutes } from "./auth-routes.mjs";
import { createAuthGate } from "./auth-gate.mjs";
import { loginWithAccount as sportsLogin } from "./sports.mjs";
import { createApprovals } from "./approvals.mjs";
import { validSessionId, SessionStore } from "./sessions.mjs";
import { lanUrls, isLoopback, publicBase, loginCapability } from "./settings.mjs";
import { requestCanCarrySecrets } from "./transport.mjs";
import { bearer, hostOf, searchJob } from "./http-helpers.mjs";
import { sendError, sendJson } from "./http-envelope.mjs";
import { createAccountRoutes } from "./routes/account.mjs";
import { createMetaRoutes } from "./routes/meta.mjs";
import { createSessionExchange } from "./session-exchange.mjs";
import { createCompactToolset } from "./compact-tools.mjs";
import { ScheduleStore } from "./schedules.mjs";
import { createScheduleRunner } from "./schedule-runner.mjs";
import { createScheduleRouter } from "./schedule-router.mjs";
import { createScheduleTools, withScheduleTools } from "./schedule-tools.mjs";
import { createScheduleRoutes } from "./routes/schedules.mjs";
import { createProviderRoutes } from "./routes/providers.mjs";
import { ProviderStore } from "./providers.mjs";
import { createChatRoutes } from "./routes/chat.mjs";
import { createSessionRouter } from "./session-router.mjs";
import { runWithUser } from "./request-context.mjs";
import { createUserSettings } from "./user-settings.mjs";
import { createDebugLog, withDebugLog } from "./debug-log.mjs";
import { createAccountSync } from "./account-sync.mjs";
import { createSecureConfig } from "./secure-config.mjs";
import { createSyncRoutes } from "./sync-routes.mjs";
import { createToolRoutes } from "./routes/tools.mjs";
import { createCampusRoutes } from "./routes/campus.mjs";
import { createSidebarRoutes } from "./routes/sidebar.mjs";
import { handleWorkspaceRequest } from "./workspace-http.mjs";
import { createSettingsRoutes } from "./routes/settings.mjs";
import { AssignmentsService } from "./assignments.mjs";
import { TimetableService } from "./timetable.mjs";
import { createLocalTimetable } from "./timetable-local.mjs";
import { createTimetableRouter } from "./timetable-router.mjs";
import { available as sportsAvailable, listReservations, listSlots, listSports, listVenues, reserve as sportsReserve, scenes as sportsScenes, SportsError } from "./sports.mjs";
import { prepareBooking, bookingStatus, closeBooking, BookingError } from "./sports-booking.mjs";

import { loadAccount } from "./account.mjs";
import { createSessionSignals } from "./session-signals.mjs";
import { createServiceStatus } from "./service-status.mjs";

import { loginAll } from "./login-all.mjs";
import { LearnxAccountLoginError, loginLearnxWithAccount } from "./learnx-login.mjs";
import { areas as seatAreas, bookings as seatBookings, cancel as seatCancel, days as seatDays, rules as seatRules, floors as seatFloors, libraries as seatLibraries, login as seatLogin, reserve as seatReserve, seats as seatSeats, sections as seatSections, segments as seatSegments, SeatError } from "./seat.mjs";
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
const json = sendJson;
function fail(res, status, code, message) {
  sendError(res, status, code, message);
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
export function createAppServer({
  providerStore: givenProviderStore,
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
  auth = null,
  store = null, campus = null, // 测试接缝：只替换校园适配器（座位/体育）
}) {
  const settingsFile = path.join(config.stateDir, "settings.json");
  // 有数据库且有本机账号时，聊天会话落到 PostgreSQL；多设备指向同一库即共享。
  const chatSessions = createSessionRouter({ store, fileSessions: sessions });
  const approvals = createApprovals({ timeoutMs: config.approvalTimeoutMs });
  const confirmations = createConfirmations();
  const assignments = new AssignmentsService(host);
  const timetableLocal = createTimetableRouter({ store, fileStore: createLocalTimetable(path.join(config.stateDir, "timetable-local.json")) });
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
  const EFFORTS = new Set(["low", "medium", "high"]);
  // 未设置时不保留该键，响应与磁盘都与旧版本一致。
  const setEffort = value => { if (value) overrides.reasoningEffort = value; else delete overrides.reasoningEffort; };
  const overrides = { modelName: config.modelName };
  const debugLog = createDebugLog({ stateDir: config.stateDir }); void debugLog.load();
  const userSettings = createUserSettings({ store, base: overrides });
  const accountSync = createAccountSync({ store, stateDir: config.stateDir });
  const secureConfig = createSecureConfig({ store, stateDir: config.stateDir });
  const loaded = readFile(settingsFile, "utf8")
    .then((raw) => {
      const parsed = JSON.parse(raw);
      if (typeof parsed.modelName === "string") overrides.modelName = parsed.modelName;
      if (EFFORTS.has(parsed.reasoningEffort)) setEffort(parsed.reasoningEffort);
      // 旧 settings.json 的 maxSteps 兼容忽略，不恢复已移除的步数截断。
    })
    .catch(() => {});
  const authRoutes = auth ? createAuthRoutes({ auth, secureCookies: Boolean(config.tlsCert || config.publicUrl), pairingEnabled: !config.token, onLogin: user => accountSync.syncOnLogin(user.id) }) : null;
  const authGate = createAuthGate({ authRoutes, authorize, pairingEnabled: !config.token });
  async function authorize(req) {
    const token = bearer(req);
    if (token) {
      if (config.token && token === config.token) return { id: "local", name: "本机固定令牌", platform: "local" };
      const device = devices.verify(token);
      if (device) return device;
    }
    const identity = authRoutes ? await authRoutes.identityOf(req) : null;
    if (identity) return { id: "user:" + identity.user.id, userId: identity.user.id, name: identity.user.email, platform: "webui-cookie", viaCookie: true };
    return null;
  }
  let learnxLoginInFlight;
  const handleAccountRoutes = createAccountRoutes({ config, loginAll, readBody, accountSync, gitlab: store ? secureConfig : null });
  const handleSettingsRoutes = createSettingsRoutes({ config, overrides, setEffort, efforts: EFFORTS, keepAlive, settingsFile, debugLog, readBody, settingsOf: () => userSettings.load(), saveUserSettings: patch => userSettings.save(patch) });
  const learnxSignals = createSessionSignals();
  const serviceStates = createServiceStatus({ host, stateDir: config.stateDir, signals: learnxSignals });
  const handleSidebarRoutes = createSidebarRoutes({ config, assignments, timetable, timetableLocal, confirmations, learnxSignals, readBody, readBytes });
  const exchange = createSessionExchange();
  const handleMetaRoutes = createMetaRoutes({
    config, route, overrides, settingsOf: () => userSettings.load(), serviceStates, devices, pairing, keepAlive, version,
    needsLoaded: () => loaded,
    exchange,
    tokenOf: req => bearer(req),
  });
  const handleChatRoutes = createChatRoutes({ host, sessions: chatSessions, turns, approvals, handleChat, readBody });
  const handleSyncRoutes = createSyncRoutes({ store });
  const handleCampusRoutes = createCampusRoutes({
    seat: { libraries: seatLibraries, floors: seatFloors, areas: seatAreas, rules: seatRules, segments: seatSegments, days: seatDays, seats: seatSeats, sections: seatSections, bookings: seatBookings, cancel: seatCancel, ...campus?.seat },
    sports: { list: listSports, venues: listVenues, scenes: sportsScenes, available: sportsAvailable, slots: listSlots, reservations: listReservations, ...campus?.sports },
    confirmations, canonicalJson, readBody,
    loadAccount: () => loadAccount(config.stateDir), seatLogin, sportsLogin, seatReserve, sportsReserve,
    prepareBooking, bookingStatus, closeBooking, SeatError, SportsError, BookingError,
  });
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
  let providerHydrated = false;
  const hydrateProviders = async () => {
    if (providerHydrated || !store) return;
    providerHydrated = true;
    const stored = await secureConfig.get("model-providers");
    if (stored && Array.isArray(stored.providers)) {
      providerStore.state = stored;
      providerStore.loaded = true;
    } else if (providerStore.state.providers.length) {
      await secureConfig.put("model-providers", providerStore.state);
    }
  };
  const providerStore = givenProviderStore || new ProviderStore(config.stateDir).loadSync();
  if (store) providerStore.persist ||= state => secureConfig.put("model-providers", state);
  const handleProviderRoutes = createProviderRoutes({ store: providerStore, readBody, hydrate: hydrateProviders });
  const scheduleStore = createScheduleRouter({ store, fileStore: new ScheduleStore(config.stateDir) });
  const scheduleTools = createScheduleTools({ store: scheduleStore });
  const agentHost = withScheduleTools(host, scheduleTools); const loggedHost = withDebugLog(agentHost, debugLog);
  const scheduleRunner = createScheduleRunner({
    store: scheduleStore,
    sessions,
    runAsUser: (id, fn) => runWithUser(id, fn),
    runTurn: async options => {
      // 定时执行没有界面可选模型，必须在这里解析出与手动对话一致的默认模型。
      const prefs = await userSettings.load();
      let model = prefs.modelName || "";
      if (!model) model = (await route.models().catch(() => []))[0]?.id || "";
      if (!model) throw Object.assign(new Error("没有可用模型，请先检查模型登录状态。"), { code: "MODEL_UNAVAILABLE" });
      return runTurn({
        host: prefs.compactTools ? createCompactToolset({ host: agentHost }) : agentHost,
        route, store: sessions,
        ...options,
        model,
        reasoningEffort: prefs.reasoningEffort || "",
        emit: options.emit || (() => {}),
      });
    },
  });
  scheduleRunner.start();
  const handleScheduleRoutes = createScheduleRoutes({ store: scheduleStore, runner: scheduleRunner });
  const compactHost = createCompactToolset({ host: agentHost });
  const handleToolRoutes = createToolRoutes({ config, host: agentHost, jobs, serviceStates, route, learnx: { login: () => learnxLoginInFlight ??= loginLearnxWithAccount({ stateDir: config.stateDir }).finally(() => { learnxLoginInFlight = undefined; }), clearSignal: () => learnxSignals.clear() }, readBody, searchJob, confirmations, canonicalJson });
  async function handleChat(req, res, body) {
    const text = typeof body.text === "string" ? body.text.trim() : "";
    if (!text) return fail(res, 400, "INVALID_ARGUMENTS", "消息不能为空。");
    if (text.length > 20000) return fail(res, 400, "INVALID_ARGUMENTS", "单条消息过长。");
    let sessionId = body.sessionId;
    if (sessionId === undefined || sessionId === null || sessionId === "") {
      sessionId = (await chatSessions.create({})).id;
    } else if (!validSessionId(sessionId)) {
      return fail(res, 400, "INVALID_SESSION", "会话 ID 不合法。");
    } else if (!(await chatSessions.get(sessionId))) {
      return fail(res, 404, "SESSION_NOT_FOUND", "会话不存在。");
    }
    if (turns.has(sessionId)) return fail(res, 409, "TURN_RUNNING", "该会话正在对话中。");
    // 必须给出具体模型名：madmodel 收到空 model 会直接回 INVALID_REQUEST。
    const prefs = await userSettings.load();
    let model = typeof body.model === "string" && body.model ? body.model : prefs.modelName || "";
    const reasoningEffort = EFFORTS.has(body.reasoningEffort) ? body.reasoningEffort : prefs.reasoningEffort || "";
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
        host: prefs.compactTools ? compactHost : loggedHost,
        route,
        store: chatSessions,
        sessionId,
        text,
        model,
        reasoningEffort,
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
    const startedAt = Date.now();
    res.once("finish", () => debugLog.log({ module: "http", event: "request", durationMs: Date.now() - startedAt, data: { method: req.method || "GET", path: req.url || "/", status: res.statusCode } }));
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
      if (pathname === "/api/session/redeem") {
        if (method !== "POST") return fail(res, 405, "METHOD_NOT_ALLOWED", "不支持的请求方法。");
        if (!requestCanCarrySecrets(req, config)) return fail(res, 403, "PAIRING_HTTPS_REQUIRED", "请通过HTTPS或本机回环地址兑换会话码。");
        const body = await readBody(req, 8192);
        const token = exchange.redeem(body?.code);
        if (!token) return fail(res, 403, "SESSION_CODE_INVALID", "会话码无效或已过期，请从本机重新打开。");
        return json(res, 200, { ok: true, token, baseUrl: publicBase(config) });
      }
      if (pathname === "/api/pair/redeem") {
        if (method !== "POST") return fail(res, 405, "METHOD_NOT_ALLOWED", "不支持的请求方法。");
        if (!requestCanCarrySecrets(req, config)) return fail(res, 403, "PAIRING_HTTPS_REQUIRED", "请通过HTTPS或本机回环地址完成配对。");
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
      const gate = await authGate(req, res, { pathname, method, readBody, json, fail });
      if (gate.handled) return;
      return await runWithUser(gate.userId, async () => {
        await loaded;
        if (await handleWorkspaceRequest({ method, url, res, host, sessions, json, fail })) return;
        if (await handleMetaRoutes(req, res, { pathname, method, url })) return;
        if (await handleToolRoutes(req, res, { pathname, method })) return;
        if (await handleSidebarRoutes(req, res, { pathname, method, url })) return;
        if (await handleScheduleRoutes(req, res, { pathname, method })) return;
        if (await handleProviderRoutes(req, res, { pathname, method })) return;
        if (await handleAccountRoutes(req, res, { pathname, method })) return;
        if (await handleCampusRoutes(req, res, { pathname, method, url })) return;
        if (await handleChatRoutes(req, res, { pathname, method })) return;
        if (await handleSyncRoutes(req, res, { pathname, method, url, json, fail })) return;
        if (await handleSettingsRoutes(req, res, { pathname, method })) return;
        return fail(res, 404, "NOT_FOUND", "接口不存在。"); });
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
      scheduleRunner.stop();
      approvals.cancelAll("shutdown");
      await host.sandbox?.close?.();
      await new Promise((resolve) => server.close(() => resolve()));
      await store?.close?.();
    },
  };
}
export { SessionStore };
