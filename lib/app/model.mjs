import net from "node:net";
import { MadModelClient } from "../madmodel/client.mjs";
import { SessionStore } from "../madmodel/auth.mjs";
import { parseToken } from "../madmodel/protocol.mjs";
import { loadConfig as loadMadModelConfig } from "../madmodel/config.mjs";
import { maskAccount, trimTrailingSlashes } from "./settings.mjs";
import { createAnthropicRoute } from "./anthropic-route.mjs";
import { createResponsesRoute } from "./responses-route.mjs";
export class ModelError extends Error {
  constructor(code, message, status = 502) {
    super(message);
    this.code = code;
    this.status = status;
  }
}
async function catalog(get) {
  try {
    const list = await get();
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}
function normalize(list) {
  return list
    .map((item) =>
      typeof item === "string"
        ? { id: item, label: item }
        : {
            id: String(item?.id ?? ""),
            label: String(item?.label ?? item?.name ?? item?.id ?? ""),
          },
    )
    .filter((item) => item.id);
}
function madmodelRoute(config, { signal }) {
  const madmodelConfig = loadMadModelConfig();
  const client = new MadModelClient({ config: madmodelConfig, signal });
  return {
    route: "madmodel",
    async models({ refresh = false, strict = false } = {}) {
      const get = async () => (await client.models({ refresh })).data;
      if (!strict) return normalize(await catalog(get));
      try {
        return normalize(await get());
      } catch {
        throw new ModelError("MODEL_DISCOVERY_FAILED", "无法获取MadModel模型列表，请刷新重试。");
      }
    },
    async chat(body, { signal: requestSignal } = {}) {
      try {
        return await client.completion(body, { signal: requestSignal });
      } catch (e) {
        throw new ModelError(
          /^[A-Z_]+$/.test(e?.code || "") ? e.code : "MODEL_FAILED",
          e?.code === "VERIFICATION_REQUIRED" ||
            e?.code === "BROWSER_LOGIN_REQUIRED"
            ? "清华统一认证需要重新验证，请在应用中完成登录。"
            : "模型服务暂不可用，请检查登录状态后重试。",
          e?.status || 502,
        );
      }
    },
    async status() {
      const status = await client.manager.status().catch(() => ({}));
      let masked = "";
      try {
        const { data } = await new SessionStore(madmodelConfig.stateDir).load();
        if (data?.token && !data.disabled)
          masked = maskAccount(parseToken(data.token).account);
      } catch {
        masked = "";
      }
      return {
        route: "madmodel",
        available: !!status.configured && !status.expired && !status.disabled,
        configured: !!status.configured,
        expired: !!status.expired,
        disabled: !!status.disabled,
        masked,
        expiresAt: status.expiresAt || null,
      };
    },
  };
}
function openaiRoute(config) {
  const base = trimTrailingSlashes(config.modelBaseUrl);
  if (!base)
    throw new ModelError(
      "MODEL_NOT_CONFIGURED",
      "openai 路由需要 THU_CAMPUS_APP_MODEL_BASE_URL。",
      400,
    );
  const headers = () => {
    const value = { "Content-Type": "application/json" };
    if (config.modelApiKey) value.Authorization = "Bearer " + config.modelApiKey;
    return value;
  };
  return {
    route: "openai",
    async models({ strict = false } = {}) {
      const response = await fetch(base + "/models", {
        headers: headers(),
        signal: AbortSignal.timeout(15000),
      }).catch(() => null);
      if (!response?.ok) {
        await response?.body?.cancel();
        if (strict) throw new ModelError("MODEL_DISCOVERY_FAILED", "无法获取外部模型列表。");
        return [];
      }
      const body = await response.json().catch(() => ({}));
      return normalize(Array.isArray(body.data) ? body.data : []);
    },
    async chat(body, { signal } = {}) {
      // 提供商配置的默认模型：请求里没指定时补上，避免上游要求 model 字段。
      if (!body.model && config.modelName) body = { ...body, model: config.modelName };
      const response = await fetch(base + "/chat/completions", {
        method: "POST",
        headers: headers(),
        body: JSON.stringify(body),
        signal,
      }).catch(() => {
        throw new ModelError("MODEL_UNREACHABLE", "无法连接外部模型服务。");
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw new ModelError(
          "MODEL_FAILED",
          `外部模型服务返回 ${response.status}。`,
        );
      }
      return response;
    },
    async status() {
      return {
        route: "openai",
        available: true,
        configured: true,
        expired: false,
        disabled: false,
        masked: "",
        expiresAt: null,
      };
    },
  };
}
/**
 * 路由选择顺序：
 * 1. 设置里启用了第三方提供商 → 用该提供商（openai 兼容或 Anthropic 原生协议）
 * 2. 否则沿用配置的 modelRoute（默认 madmodel）
 *
 * 提供商可随时在界面切换/停用，因此这里返回一个按需解析的门面，而不是启动时固定。
 */
export function createModelRoute(config, options = {}) {
  const { providerStore = null } = options;
  if (providerStore) {
    const cache = new Map();
    const providerRoute = provider => {
      const key = [provider.id, provider.kind, provider.baseUrl, provider.model, provider.apiKey].join("|");
      let route = cache.get(key);
      if (!route) {
        if (provider.kind === "anthropic") route = createAnthropicRoute(provider);
        else if (provider.kind === "openai-responses") route = createResponsesRoute(provider);
        else route = openaiRoute({ modelBaseUrl: provider.baseUrl, modelApiKey: provider.apiKey, modelName: provider.model });
        cache.set(key, route);
      }
      return route;
    };
    const active = () => {
      const provider = providerStore.active();
      return provider ? { provider, route: providerRoute(provider) } : null;
    };
    const fallback = () => (config.modelRoute === "openai" ? openaiRoute(config) : madmodelRoute(config, options));
    return {
      get route() {
        return active()?.route.route || config.modelRoute;
      },
      async models(args) {
        const current = active();
        return current ? current.route.models(args) : fallback().models(args);
      },
      async chat(body, opts) {
        const current = active();
        if (!current) return fallback().chat(body, opts);
        const withModel = body.model ? body : { ...body, model: current.provider.model };
        return current.route.chat(withModel, opts);
      },
      async status() {
        const current = active();
        if (!current) return fallback().status();
        return { ...(await current.route.status()), provider: current.provider.name, providerId: current.provider.id, model: current.provider.model };
      },
    };
  }
  return config.modelRoute === "openai"
    ? openaiRoute(config)
    : madmodelRoute(config, options);
}
export function assertPortFree(port, host = "127.0.0.1") {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", (e) =>
      resolve(
        e.code === "EADDRINUSE"
          ? { free: false, code: "APP_PORT_BUSY" }
          : { free: false, code: e.code || "APP_PORT_ERROR" },
      ),
    );
    server.listen({ port, host, exclusive: true }, () => {
      server.close(() => resolve({ free: true }));
    });
  });
}