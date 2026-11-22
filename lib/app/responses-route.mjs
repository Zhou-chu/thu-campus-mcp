/** OpenAI Responses 路由：请求翻译 + 事件流翻译，复用与 Anthropic 相同的 SSE 收尾策略。 */
import { createResponsesTranslator, readResponsesSse, toResponsesRequest } from "./responses.mjs";

export class ResponsesError extends Error {
  constructor(code, message, status = 502) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

const trim = value => String(value || "").replace(/\/+$/, "");
const encoder = new TextEncoder();

function streamFrom(response, model) {
  return new Response(new ReadableStream({
    async start(controller) {
      let closed = false;
      const send = payload => { if (!closed) controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`)); };
      const translator = createResponsesTranslator({ model, onFrame: send });
      try {
        await readResponsesSse(response, (event, data) => translator.push(event, data));
      } catch {
        send({ error: { code: "MODEL_FAILED", message: "Responses 事件流中断。" } });
      } finally {
        if (!closed) {
          closed = true;
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          controller.close();
        }
      }
    },
    cancel() { response.body?.cancel?.().catch(() => {}); },
  }), { headers: { "content-type": "text/event-stream; charset=utf-8" } });
}

export function createResponsesRoute(provider) {
  const base = trim(provider.baseUrl);
  const headers = { "content-type": "application/json", authorization: "Bearer " + provider.apiKey };
  return {
    route: "openai-responses",
    async models({ strict = false } = {}) {
      const response = await fetch(base + "/models", { headers, signal: AbortSignal.timeout(15000) }).catch(() => null);
      if (!response?.ok) {
        await response?.body?.cancel();
        if (strict) throw new ResponsesError("MODEL_DISCOVERY_FAILED", "无法获取模型列表。");
        return [];
      }
      const body = await response.json().catch(() => ({}));
      return (Array.isArray(body?.data) ? body.data : [])
        .map(item => ({ id: String(item?.id || ""), label: String(item?.id || "") }))
        .filter(item => item.id);
    },
    async chat(body, { signal } = {}) {
      const request = toResponsesRequest(body, { model: provider.model });
      const response = await fetch(base + "/responses", {
        method: "POST",
        headers,
        body: JSON.stringify(request),
        signal,
      }).catch(() => { throw new ResponsesError("MODEL_UNREACHABLE", "无法连接 Responses 接口。"); });
      if (!response.ok) {
        const detail = await response.json().catch(() => null);
        await response.body?.cancel().catch(() => {});
        throw new ResponsesError(
          response.status === 401 || response.status === 403 ? "MODEL_AUTH_FAILED" : "MODEL_FAILED",
          response.status === 401 || response.status === 403
            ? "接口拒绝了这次请求，请检查密钥与模型名。"
            : detail?.error?.message || `上游返回 ${response.status}。`,
        );
      }
      return streamFrom(response, provider.model);
    },
    async status() {
      return { route: "openai-responses", available: true, configured: true, expired: false, disabled: false, masked: "", expiresAt: null };
    },
  };
}