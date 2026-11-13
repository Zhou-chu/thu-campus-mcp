import {
  ORIGIN,
  discoverModels,
  validateCompletion,
  error,
} from "./protocol.mjs";
import { loadConfig } from "./config.mjs";
import { SessionStore, SessionManager } from "./auth.mjs";
import { browserLogin } from "./browser.mjs";
export async function verifyToken(token, signal, fetcher = fetch) {
  const response = await fetcher(ORIGIN + "/model-api/auth-login", {
    headers: { Authorization: "Bearer " + token },
    redirect: "manual",
    signal: signal
      ? AbortSignal.any([signal, AbortSignal.timeout(15000)])
      : AbortSignal.timeout(15000),
  });
  if ([401, 403].includes(response.status)) {
    await response.body?.cancel();
    return false;
  }
  if (
    !response.ok ||
    !response.headers.get("content-type")?.includes("application/json")
  ) {
    await response.body?.cancel();
    throw error("UPSTREAM_PROTOCOL", "登录校验未返回有效 JSON。");
  }
  const body = await response.json();
  return body.data === true && body.success !== false;
}
export class MadModelClient {
  constructor({
    config = loadConfig(),
    fetcher = fetch,
    manager,
    signal,
  } = {}) {
    Object.assign(this, { config, fetcher, signal });
    this.manager =
      manager ||
      new SessionManager({
        store: new SessionStore(config.stateDir),
        signal,
        refreshAheadMs: config.refreshAheadMs,
        checkIntervalMs: config.checkIntervalMs,
        verify: (token, s) => verifyToken(token, s, fetcher),
        login: (options) =>
          browserLogin({
            ...options,
            timeoutMs: options.headless ? config.loginTimeoutMs : 600000,
            verify: (token, s) => verifyToken(token, s, fetcher),
          }),
      });
  }
  async models({ signal, refresh = false } = {}) {
    if (!refresh && this.catalog && Date.now() - this.catalogAt < 3600000)
      return { object: "list", data: this.catalog };
    const fetchText = async (url) => {
      const response = await this.fetcher(url, {
        redirect: "error",
        signal: AbortSignal.any([
          AbortSignal.timeout(15000),
          ...[signal, this.signal].filter(Boolean),
        ]),
      });
      if (!response.ok)
        throw error("MODEL_DISCOVERY_FAILED", "无法读取站点配置。");
      return response.text();
    };
    const html = await fetchText(ORIGIN + "/");
    const source = [...html.matchAll(/<script\b[^>]*\bsrc=["']([^"']+)["']/gi)]
      .map((m) => new URL(m[1], ORIGIN))
      .find(
        (u) =>
          u.origin === ORIGIN &&
          u.pathname.startsWith("/assets/") &&
          u.pathname.endsWith(".js"),
      );
    if (!source)
      throw error("MODEL_DISCOVERY_FAILED", "网页未提供模型配置脚本。");
    this.catalog = discoverModels(await fetchText(source.href));
    this.catalogAt = Date.now();
    return { object: "list", data: this.catalog };
  }
  async completion(body, { signal } = {}) {
    validateCompletion(body);
    const requestSignal = AbortSignal.any([
      AbortSignal.timeout(this.config.timeoutMs),
      ...[signal, this.signal].filter(Boolean),
    ]);
    let session = await this.manager.ensure({ signal: requestSignal });
    const send = () =>
      this.fetcher(ORIGIN + "/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer " + session.token,
        },
        body: JSON.stringify(body),
        redirect: "manual",
        signal: requestSignal,
      });
    let response = await send();
    if (response.status === 401) {
      await response.body?.cancel();
      session = await this.manager.ensure({
        force: true,
        rejectedToken: session.token,
        signal: requestSignal,
      });
      response = await send();
    }
    if (response.ok) {
      const type = response.headers.get("content-type") || "";
      if (
        !response.body ||
        !(body.stream
          ? type.includes("text/event-stream")
          : type.includes("application/json"))
      ) {
        await response.body?.cancel();
        throw error("UPSTREAM_PROTOCOL", "上游返回了非预期格式。");
      }
    }
    return response;
  }
}
