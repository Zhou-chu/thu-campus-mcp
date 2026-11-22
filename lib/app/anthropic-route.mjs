/** Anthropic 路由：把应用内的 OpenAI 形状请求翻译为 /v1/messages，并把事件流翻译回 OpenAI SSE。 */
import { createAnthropicTranslator, readSse, toAnthropicRequest } from "./anthropic.mjs";

export class ModelError extends Error {
  constructor(code, message, status = 502) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

function trimSlashes(value) {
  return String(value || "").replace(/\/+$/, "");
}

export function createAnthropicRoute(provider) {
  const base = trimSlashes(provider.baseUrl);
  const headers = {
    "content-type": "application/json",
    "x-api-key": provider.apiKey,
    "anthropic-version": "2023-06-01",
  };
  return {
    route: "anthropic",
    async models({ strict = false } = {}) {
      const response = await fetch(base + "/models?limit=100", { headers, signal: AbortSignal.timeout(15000) }).catch(() => null);
      if (!response?.ok) {
        await response?.body?.cancel();
        if (strict) throw new ModelError("MODEL_DISCOVERY_FAILED", "无法获取 Anthropic 模型列表。");
        return [];
      }
      const body = await response.json().catch(() => ({}));
      return (Array.isArray(body?.data) ? body.data : [])
        .map(item => ({ id: String(item?.id || ""), label: String(item?.display_name || item?.id || "") }))
        .filter(item => item.id);
    },
    async chat(body, { signal } = {}) {
      const request = toAnthropicRequest(body, { model: provider.model });
      const response = await fetch(base + "/messages", {
        method: "POST",
        headers,
        body: JSON.stringify(request),
        signal,
      }).catch(() => {
        throw new ModelError("MODEL_UNREACHABLE", "无法连接 Anthropic 接口。");
      });
      if (!response.ok) {
        const detail = await response.json().catch(() => null);
        await response.body?.cancel().catch(() => {});
        throw new ModelError(
          response.status === 401 || response.status === 403 ? "MODEL_AUTH_FAILED" : "MODEL_FAILED",
          response.status === 401 || response.status === 403
            ? "Anthropic 拒绝了这次请求，请检查密钥与模型名。"
            : detail?.error?.message || `Anthropic 返回 ${response.status}。`,
        );
      }
      return toOpenAiStream(response, provider.model, signal);
    },
    async status() {
      return { route: "anthropic", available: true, configured: true, expired: false, disabled: false, masked: "", expiresAt: null };
    },
  };
}

/** 把 Anthropic 事件流转成 OpenAI SSE 的 ReadableStream。 */
export function toOpenAiStream(response, model, signal) {
  const encoder = new TextEncoder();
  return new Response(new ReadableStream({
    async start(controller) {
      let closed = false;
      const send = payload => {
        if (closed) return;
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`));
      };
      const translator = createAnthropicTranslator({ model, onFrame: send });
      try {
        await readSse(response, (event, data) => translator.push(event, data));
      } catch {
        send({ error: { code: "MODEL_FAILED", message: "Anthropic 事件流中断。" } });
      } finally {
        if (!closed) {
          closed = true;
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          controller.close();
        }
      }
      signal?.throwIfAborted?.();
    },
    cancel() {
      response.body?.cancel?.().catch(() => {});
    },
  }), { headers: { "content-type": "text/event-stream; charset=utf-8" } });
}