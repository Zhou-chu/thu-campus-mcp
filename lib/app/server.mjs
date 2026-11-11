import http from "node:http";
import https from "node:https";
import path from "node:path";
import { createReadStream } from "node:fs";
import { stat, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { runTurn } from "./agent.mjs";
import { PairingError } from "./pairing.mjs";
import { validSessionId, SessionStore } from "./sessions.mjs";
import { lanUrls, isLoopback, maskAccount, publicBase } from "./settings.mjs";
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
function stateOf(payload) {
  if (!payload || typeof payload !== "object") return "unknown";
  const auth =
    payload.authentication && typeof payload.authentication === "object"
      ? payload.authentication
      : null;
  const validity = payload.sessionValidity;
  if (payload.expired === true || payload.expiresIn === 0) return "expired";
  if (validity === "expired" || validity === "invalid") return "expired";
  if (payload.disabled === true) return "login-required";
  if (auth && auth.configured === false) return "login-required";
  if (payload.authenticated === false || payload.loggedIn === false)
    return "login-required";
  if (!auth && payload.configured === false && payload.hasToken !== true)
    return "login-required";
  if (validity === "valid" || validity === "verified") return "ready";
  if (payload.configured === true) return "ready";
  if (auth && auth.configured === true) return "ready";
  if (payload.authenticated === true || payload.loggedIn === true) return "ready";
  if (payload.account || payload.token != null) return "ready";
  return "unknown";
}
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
}) {
  const settingsFile = path.join(config.stateDir, "settings.json");
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
  let overrides = { modelName: config.modelName, maxSteps: config.maxSteps };
  const loaded = readFile(settingsFile, "utf8")
    .then((raw) => {
      const parsed = JSON.parse(raw);
      if (typeof parsed.modelName === "string") overrides.modelName = parsed.modelName;
      if (Number.isInteger(parsed.maxSteps))
        overrides.maxSteps = Math.min(Math.max(parsed.maxSteps, 1), 24);
    })
    .catch(() => {});
  async function authorize(req) {
    const token = bearer(req);
    if (!token) return null;
    if (config.token && token === config.token) return { id: "local", name: "本机固定令牌", platform: "local" };
    return devices.verify(token);
  }
  async function serviceStates() {
    const probes = [
      ["learnx", "learn_status"],
      ["cloud", "cloud_status"],
      ["hetang", "rain_status"],
      ["madmodel", "madmodel_status"],
    ];
    const entries = await Promise.all(
      probes.map(async ([service, tool]) => {
        const result = await host.call(tool, {});
        if (!result.ok) {
          const loginRequired = ["AUTH_REQUIRED", "AUTH_EXPIRED"].includes(result.error?.code);
          return [service, { state: loginRequired ? "login-required" : "unknown", code: result.error?.code }];
        }
        return [service, { state: stateOf(result.data) }];
      }),
    );
    return Object.fromEntries(entries);
  }
  function resolveStatic(pathname) {
    const relative = decodeURIComponent(pathname).replace(/^\/+/, "");
    const target = path.resolve(webuiDir, relative || "index.html");
    if (target !== webuiDir && !target.startsWith(webuiDir + path.sep)) return null;
    return target;
  }
  async function serveStatic(req, res, pathname) {
    let target = resolveStatic(pathname);
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
    // 本地应用：升级后必须立刻生效，因此一律要求重新校验，不做长期缓存。
    res.writeHead(200, {
      "Content-Type": type,
      "Cache-Control": "no-cache",
      "X-Content-Type-Options": "nosniff",
    });
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
    const controller = new AbortController();
    turns.set(sessionId, controller);
    const model = typeof body.model === "string" && body.model ? body.model : overrides.modelName || undefined;
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-store",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    const emit = (event, data) => {
      if (res.writableEnded) return;
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };
    emit("ready", { sessionId, model: model || "auto" });
    req.on("close", () => {
      if (!res.writableEnded) controller.abort();
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
        maxSteps: overrides.maxSteps,
        emit,
        signal: controller.signal,
      });
    } catch (e) {
      emit("error", {
        code: /^[A-Z_]+$/.test(e?.code || "") ? e.code : "TURN_FAILED",
        message: e?.code === "SESSION_NOT_FOUND" ? "会话不存在。" : "本轮对话失败。",
      });
    } finally {
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
          if (e instanceof PairingError) return fail(res, 403, e.code, e.message);
          throw e;
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
      if (pathname === "/api/tools" && method === "GET")
        return json(res, 200, { ok: true, tools: host.describe() });
      const toolMatch = /^\/api\/tools\/([a-z][a-z0-9_]{2,63})$/.exec(pathname);
      if (toolMatch && method === "POST") {
        const body = await readBody(req, 2 * 1024 * 1024);
        const result = await host.call(toolMatch[1], body);
        return result.ok
          ? json(res, 200, { ok: true, data: result.data })
          : json(res, 400, { ok: false, error: result.error, data: result.data });
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
        if (method === "DELETE") {
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
        if (!controller) return json(res, 200, { ok: true, aborted: false });
        controller.abort();
        return json(res, 200, { ok: true, aborted: true });
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
      if (pathname === "/api/settings") {
        if (method === "GET")
          return json(res, 200, {
            ok: true,
            settings: { modelName: overrides.modelName, maxSteps: overrides.maxSteps },
            modelRoute: config.modelRoute,
          });
        if (method === "PUT") {
          const body = await readBody(req, 8192);
          if (typeof body.modelName === "string") overrides.modelName = body.modelName.slice(0, 200);
          if (body.maxSteps !== undefined) {
            const value = Number(body.maxSteps);
            if (!Number.isInteger(value) || value < 1 || value > 24)
              return fail(res, 400, "INVALID_ARGUMENTS", "maxSteps 必须是 1–24 的整数。");
            overrides.maxSteps = value;
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
      await new Promise((resolve) => server.close(() => resolve()));
    },
  };
}
export { SessionStore };
