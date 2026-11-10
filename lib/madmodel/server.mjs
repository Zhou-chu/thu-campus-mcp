import http from "node:http";
import { createHash, timingSafeEqual } from "node:crypto";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { MadModelClient } from "./client.mjs";
import { loadConfig } from "./config.mjs";
import { validateCompletion, safeFailure, error } from "./protocol.mjs";
const loopbacks = ["127.0.0.1", "localhost", "[::1]"];
function json(res, status, data) {
  if (res.destroyed || res.headersSent) return;
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  res.end(JSON.stringify(data));
}
function failure(res, status, code, message) {
  json(res, status, {
    error: {
      message,
      type: status < 500 ? "invalid_request_error" : "server_error",
      param: null,
      code,
    },
  });
}
function authorized(actual, expected) {
  return timingSafeEqual(
    createHash("sha256")
      .update(actual || "")
      .digest(),
    createHash("sha256")
      .update("Bearer " + expected)
      .digest(),
  );
}
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let bytes = 0;
    const chunks = [];
    const clear = () => {
      req.off("data", data);
      req.off("end", end);
      req.off("aborted", aborted);
      req.off("error", failed);
    };
    const failed = (e) => {
      clear();
      reject(e);
    };
    const aborted = () => failed(error("INVALID_REQUEST", "请求已中断。", 400));
    const data = (chunk) => {
      bytes += chunk.length;
      if (bytes > limit) {
        clear();
        req.resume();
        reject(error("INVALID_REQUEST", "请求体过大。", 413));
      } else chunks.push(chunk);
    };
    const end = () => {
      clear();
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(error("INVALID_REQUEST", "请求体必须为 JSON。", 400));
      }
    };
    req.on("data", data);
    req.once("end", end);
    req.once("aborted", aborted);
    req.once("error", failed);
  });
}
export function createModelServer({
  client,
  config = loadConfig(),
  signal,
} = {}) {
  if (
    !["127.0.0.1", "::1", "localhost"].includes(config.host) &&
    !config.apiKey
  )
    throw error(
      "INVALID_REQUEST",
      "监听非回环地址必须设置 MADMODEL_API_KEY。",
      400,
    );
  const server = http.createServer(
    { maxHeaderSize: 16384 },
    async (req, res) => {
      const controller = new AbortController();
      const requestSignal = signal
        ? AbortSignal.any([signal, controller.signal])
        : controller.signal;
      const abort = () => {
        if (!res.writableFinished) controller.abort();
      };
      req.once("aborted", abort);
      res.once("close", abort);
      let upstream;
      try {
        // Reject browser-origin requests and DNS rebinding even when local clients
        // choose to run without an API key.
        let host;
        try {
          host = new URL("http://" + req.headers.host).hostname;
        } catch {}
        if (
          req.headers.origin ||
          (["127.0.0.1", "::1", "localhost"].includes(config.host) &&
            !loopbacks.includes(host))
        )
          return failure(
            res,
            403,
            "FORBIDDEN",
            "此服务仅接受受信任的客户端请求。",
          );
        if (
          config.apiKey &&
          !authorized(req.headers.authorization, config.apiKey)
        ) {
          res.setHeader("WWW-Authenticate", "Bearer");
          return failure(res, 401, "INVALID_API_KEY", "下游 API Key 无效。");
        }
        const pathname = new URL(req.url, "http://localhost").pathname;
        if (
          req.method === "GET" &&
          ["/health", "/auth/status"].includes(pathname)
        ) {
          const status = await client.manager.status();
          const healthy =
            status.configured && !status.expired && !status.lastError;
          return json(
            res,
            pathname === "/health" && !healthy ? 503 : 200,
            pathname === "/health"
              ? {
                  status: healthy ? "ok" : "degraded",
                  service: "madmodel",
                  auth: status,
                }
              : status,
          );
        }
        if (req.method === "GET" && pathname === "/v1/models")
          return json(res, 200, await client.models({ signal: requestSignal }));
        if (pathname !== "/v1/chat/completions")
          return failure(res, 404, "NOT_FOUND", "接口不存在。");
        if (req.method !== "POST") {
          res.setHeader("Allow", "POST");
          return failure(res, 405, "METHOD_NOT_ALLOWED", "请使用 POST。");
        }
        if (
          !/^application\/json(?:\s*;|$)/i.test(
            req.headers["content-type"] || "",
          )
        )
          return failure(
            res,
            415,
            "UNSUPPORTED_MEDIA_TYPE",
            "请使用 application/json。",
          );
        if (Number(req.headers["content-length"]) > config.maxBodyBytes)
          return failure(res, 413, "REQUEST_TOO_LARGE", "请求体过大。");
        const body = validateCompletion(
          await readBody(req, config.maxBodyBytes),
        );
        upstream = await client.completion(body, { signal: requestSignal });
        if (!upstream.ok) {
          const status = [
            400, 401, 403, 404, 408, 413, 422, 429, 500, 502, 503, 504,
          ].includes(upstream.status)
            ? upstream.status
            : 502;
          const retry = upstream.headers.get("retry-after");
          if (retry && /^\d{1,8}$/.test(retry))
            res.setHeader("Retry-After", retry);
          return failure(
            res,
            status,
            "UPSTREAM_" + upstream.status,
            "MadModel 上游拒绝请求（HTTP " + upstream.status + "）。",
          );
        }
        const type = upstream.headers.get("content-type") || "";
        if (
          !upstream.body ||
          !(body.stream
            ? type.includes("text/event-stream")
            : type.includes("application/json"))
        )
          throw error("UPSTREAM_PROTOCOL", "上游返回了非预期格式。");
        res.writeHead(200, {
          "Content-Type": body.stream
            ? "text/event-stream; charset=utf-8"
            : "application/json; charset=utf-8",
          "Cache-Control": "no-cache, no-transform",
          "X-Accel-Buffering": "no",
          "X-Content-Type-Options": "nosniff",
        });
        res.flushHeaders();
        await pipeline(Readable.fromWeb(upstream.body), res, {
          signal: requestSignal,
        });
      } catch (e) {
        if (res.headersSent) {
          res.destroy();
          return;
        }
        const safe = safeFailure(e);
        failure(
          res,
          Number.isInteger(e.status)
            ? e.status
            : requestSignal.aborted
              ? 499
              : 502,
          safe.code,
          safe.message,
        );
      } finally {
        if (upstream?.body && !upstream.body.locked)
          await upstream.body.cancel().catch(() => {});
        req.off("aborted", abort);
        res.off("close", abort);
      }
    },
  );
  server.headersTimeout = 15000;
  server.requestTimeout = 30000;
  return server;
}
export async function startModelService(
  config = loadConfig(),
  {
    client,
    log = (data) => process.stderr.write(JSON.stringify(data) + "\n"),
  } = {},
) {
  const controller = new AbortController();
  client ||= new MadModelClient({ config, signal: controller.signal });
  const server = createModelServer({
    client,
    config,
    signal: controller.signal,
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.port, config.host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  let lastState,
    closed = false,
    checking = false;
  const check = async () => {
    if (closed || checking) return;
    checking = true;
    try {
      await client.manager.check();
      const s = await client.manager.status();
      const state = JSON.stringify({
        configured: s.configured,
        expiresAt: s.expiresAt,
      });
      if (state !== lastState) {
        lastState = state;
        log({ event: "auth-check", ...s });
      }
    } catch (e) {
      const safe = safeFailure(e);
      if (safe.code !== lastState) {
        lastState = safe.code;
        log({ event: "auth-check", ...safe });
      }
    } finally {
      checking = false;
    }
  };
  const timer = setInterval(() => void check(), config.checkIntervalMs);
  timer.unref();
  void check();
  const address = server.address();
  log({
    event: "listening",
    host: config.host,
    port: address.port,
    apiKeyRequired: !!config.apiKey,
    checkIntervalMs: config.checkIntervalMs,
  });
  let closing;
  return {
    server,
    client,
    address,
    close: () =>
      (closing ||= (async () => {
        closed = true;
        clearInterval(timer);
        controller.abort();
        server.closeAllConnections();
        await new Promise((resolve) => server.close(resolve));
        await client.manager.pending?.catch(() => {});
      })()),
  };
}
