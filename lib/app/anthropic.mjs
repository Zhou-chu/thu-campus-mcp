/**
 * Anthropic Messages 适配器：应用内部只用 OpenAI Chat Completions 形状，
 * 这里把请求翻译成 /v1/messages，再把事件流翻译回 OpenAI SSE，让 agent 无需分支。
 *
 * 支持：system、文本、图片（data URL）、工具定义与 tool_use/tool_result 往返、流式文本与工具增量。
 * 明确不支持：OpenAI 的 response_format / audio / 并行 tool_choice 细节（会忽略而不是伪造）。
 */

function textOf(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.filter(part => part?.type === "text").map(part => part.text || "").join("");
}

function imageParts(content) {
  if (!Array.isArray(content)) return [];
  return content.filter(part => part?.type === "image_url" && part.image_url?.url).map(part => {
    const url = String(part.image_url.url);
    const match = /^data:([^;,]+);base64,(.*)$/s.exec(url);
    if (!match) return { type: "image", source: { type: "url", url } };
    return { type: "image", source: { type: "base64", media_type: match[1], data: match[2] } };
  });
}

/** OpenAI messages → Anthropic system + messages。 */
export function toAnthropicMessages(messages = []) {
  const system = [];
  const out = [];
  for (const message of messages) {
    if (message.role === "system") {
      const text = textOf(message.content);
      if (text) system.push(text);
      continue;
    }
    if (message.role === "tool") {
      out.push({
        role: "user",
        content: [{ type: "tool_result", tool_use_id: message.tool_call_id, content: String(message.content ?? "") }],
      });
      continue;
    }
    if (message.role === "assistant") {
      const blocks = [];
      const text = textOf(message.content);
      if (text) blocks.push({ type: "text", text });
      for (const call of message.tool_calls || []) {
        let input = {};
        try { input = JSON.parse(call.function?.arguments || "{}"); } catch { input = {}; }
        blocks.push({ type: "tool_use", id: call.id, name: call.function?.name, input });
      }
      if (blocks.length) out.push({ role: "assistant", content: blocks });
      continue;
    }
    const blocks = [];
    const text = textOf(message.content);
    if (text) blocks.push({ type: "text", text });
    blocks.push(...imageParts(message.content));
    if (blocks.length) out.push({ role: "user", content: blocks });
  }
  // Anthropic 要求首条消息是 user 且角色交替；合并相邻同角色消息。
  const merged = [];
  for (const message of out) {
    const last = merged.at(-1);
    if (last && last.role === message.role) last.content.push(...(Array.isArray(message.content) ? message.content : [{ type: "text", text: message.content }]));
    else merged.push({ role: message.role, content: [...(Array.isArray(message.content) ? message.content : [{ type: "text", text: message.content }])] });
  }
  if (merged[0]?.role === "assistant") merged.unshift({ role: "user", content: [{ type: "text", text: "继续。" }] });
  return { system: system.join("\n\n"), messages: merged };
}

export function toAnthropicTools(tools = []) {
  return tools
    .map(tool => ({
      name: tool?.function?.name,
      description: tool?.function?.description || "",
      input_schema: tool?.function?.parameters || { type: "object", properties: {} },
    }))
    .filter(tool => typeof tool.name === "string" && tool.name);
}

export function toAnthropicRequest(body = {}, { model, maxTokens = 4096 } = {}) {
  const { system, messages } = toAnthropicMessages(body.messages || []);
  const request = {
    model: model || body.model,
    max_tokens: Math.min(64_000, Math.max(256, Number(body.max_tokens) || maxTokens)),
    messages,
    stream: true,
  };
  if (system) request.system = system;
  const tools = toAnthropicTools(body.tools || []);
  if (tools.length) request.tools = tools;
  if (body.temperature !== undefined) request.temperature = body.temperature;
  return request;
}

/** 把 Anthropic SSE 事件转成 OpenAI Chat Completions 的 SSE 帧。 */
export function createAnthropicTranslator({ model, onFrame }) {
  let sentRole = false;
  const toolIndex = new Map();
  const emit = delta => onFrame({ id: "chatcmpl-anthropic", object: "chat.completion.chunk", model, choices: [{ index: 0, delta, finish_reason: null }] });

  return {
    push(event, data) {
      if (event === "message_start" || (event === "content_block_start" && data?.content_block?.type === "text")) {
        if (!sentRole) { sentRole = true; emit({ role: "assistant", content: "" }); }
        return;
      }
      if (event === "content_block_start" && data?.content_block?.type === "tool_use") {
        if (!sentRole) { sentRole = true; emit({ role: "assistant", content: "" }); }
        const index = toolIndex.size;
        toolIndex.set(data.index, index);
        emit({ tool_calls: [{ index, id: data.content_block.id, type: "function", function: { name: data.content_block.name, arguments: "" } }] });
        return;
      }
      if (event === "content_block_delta") {
        const delta = data?.delta || {};
        if (delta.type === "text_delta" && delta.text) emit({ content: delta.text });
        else if (delta.type === "input_json_delta" && delta.partial_json) {
          const index = toolIndex.get(data.index) ?? 0;
          emit({ tool_calls: [{ index, function: { arguments: delta.partial_json } }] });
        }
        return;
      }
      if (event === "message_delta") {
        const stop = data?.delta?.stop_reason;
        if (stop) onFrame({ id: "chatcmpl-anthropic", object: "chat.completion.chunk", model, choices: [{ index: 0, delta: {}, finish_reason: stop === "tool_use" ? "tool_calls" : "stop" }] });
        return;
      }
      if (event === "error") {
        onFrame({ error: { code: "MODEL_FAILED", message: data?.error?.message || "上游返回错误。" } });
      }
    },
  };
}

/** 解析一次 SSE 流（Anthropic 格式），逐事件回调。 */
export async function readSse(response, onEvent) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let boundary = buffer.indexOf("\n\n");
    while (boundary >= 0) {
      const chunk = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      let event = "message";
      const dataLines = [];
      for (const line of chunk.split("\n")) {
        if (line.startsWith("event:")) event = line.slice(6).trim();
        else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
      }
      if (dataLines.length) {
        try { onEvent(event, JSON.parse(dataLines.join("\n"))); } catch { /* 忽略无法解析的帧 */ }
      }
      boundary = buffer.indexOf("\n\n");
    }
  }
}