/**
 * OpenAI Responses API 适配器（`/v1/responses`）。
 *
 * 与 Chat Completions 的差异集中在：
 * - 输入是 `input` 项数组（message / function_call / function_call_output），工具是扁平结构
 * - 输出是语义事件流（response.output_text.delta、response.function_call_arguments.delta…）
 *
 * 这里把应用内的 Chat Completions 形状双向翻译，agent 仍然只看到一种协议。
 */

function textOf(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.filter(part => part?.type === "text").map(part => part.text || "").join("");
}

function contentParts(content) {
  if (typeof content === "string") return content ? [{ type: "input_text", text: content }] : [];
  if (!Array.isArray(content)) return [];
  return content.map(part => {
    if (part?.type === "text") return { type: "input_text", text: part.text || "" };
    if (part?.type === "image_url" && part.image_url?.url) {
      return { type: "input_image", image_url: String(part.image_url.url), detail: "auto" };
    }
    return null;
  }).filter(Boolean);
}

/** Chat Completions messages → Responses input 项。 */
export function toResponsesInput(messages = []) {
  const items = [];
  let instructions = "";
  for (const message of messages) {
    if (message.role === "system") {
      const text = textOf(message.content);
      if (text) instructions = instructions ? instructions + "\n\n" + text : text;
      continue;
    }
    if (message.role === "tool") {
      items.push({ type: "function_call_output", call_id: message.tool_call_id, output: String(message.content ?? "") });
      continue;
    }
    if (message.role === "assistant") {
      const text = textOf(message.content);
      if (text) items.push({ type: "message", role: "assistant", content: [{ type: "output_text", text }] });
      for (const call of message.tool_calls || []) {
        items.push({ type: "function_call", call_id: call.id, name: call.function?.name, arguments: call.function?.arguments || "{}" });
      }
      continue;
    }
    const parts = contentParts(message.content);
    if (parts.length) items.push({ type: "message", role: "user", content: parts });
  }
  return { instructions, input: items };
}

export function toResponsesTools(tools = []) {
  return tools
    .map(tool => {
      const fn = tool?.function || {};
      return { type: "function", name: fn.name, description: fn.description || "", parameters: fn.parameters || { type: "object", properties: {} }, strict: false };
    })
    .filter(tool => typeof tool.name === "string" && tool.name);
}

export function toResponsesRequest(body = {}, { model } = {}) {
  const { instructions, input } = toResponsesInput(body.messages || []);
  const request = { model: model || body.model, input, stream: true, store: false };
  if (instructions) request.instructions = instructions;
  const tools = toResponsesTools(body.tools || []);
  if (tools.length) request.tools = tools;
  if (body.temperature !== undefined) request.temperature = body.temperature;
  return request;
}

/** Responses 事件 → OpenAI Chat Completions SSE 帧。 */
export function createResponsesTranslator({ model, onFrame }) {
  let sentRole = false;
  const toolIndex = new Map();
  const emit = delta => onFrame({ id: "chatcmpl-responses", object: "chat.completion.chunk", model, choices: [{ index: 0, delta, finish_reason: null }] });
  const finish = reason => onFrame({ id: "chatcmpl-responses", object: "chat.completion.chunk", model, choices: [{ index: 0, delta: {}, finish_reason: reason }] });

  return {
    push(event, data) {
      if (event === "response.output_item.added" && data?.item?.type === "function_call") {
        if (!sentRole) { sentRole = true; emit({ role: "assistant", content: "" }); }
        const index = toolIndex.size;
        toolIndex.set(data.item.id ?? data.output_index ?? index, index);
        emit({ tool_calls: [{ index, id: data.item.call_id || data.item.id, type: "function", function: { name: data.item.name || "", arguments: "" } }] });
        return;
      }
      if (event === "response.output_text.delta" && typeof data?.delta === "string") {
        if (!sentRole) { sentRole = true; emit({ role: "assistant", content: "" }); }
        emit({ content: data.delta });
        return;
      }
      if (event === "response.function_call_arguments.delta" && typeof data?.delta === "string") {
        const index = toolIndex.get(data.item_id ?? data.output_index) ?? 0;
        emit({ tool_calls: [{ index, function: { arguments: data.delta } }] });
        return;
      }
      if (event === "response.completed") {
        const hasTools = Array.isArray(data?.response?.output) && data.response.output.some(item => item.type === "function_call");
        finish(hasTools ? "tool_calls" : "stop");
        return;
      }
      if (event === "response.failed" || event === "error") {
        onFrame({ error: { code: "MODEL_FAILED", message: data?.response?.error?.message || data?.error?.message || "上游返回错误。" } });
      }
    },
  };
}

/** 解析 Responses 的 SSE 流；每帧是 `event: <name>` + `data: {...}`。 */
export async function readResponsesSse(response, onEvent) {
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
      let event = "";
      const dataLines = [];
      for (const line of chunk.split("\n")) {
        if (line.startsWith("event:")) event = line.slice(6).trim();
        else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
      }
      if (dataLines.length) {
        try {
          const data = JSON.parse(dataLines.join("\n"));
          onEvent(event || data?.type || "message", data);
        } catch { /* 忽略坏帧 */ }
      }
      boundary = buffer.indexOf("\n\n");
    }
  }
}