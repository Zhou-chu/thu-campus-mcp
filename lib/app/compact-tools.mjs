/**
 * 精简工具模式：把 86 个工具压成两个入口，模型按需检索再调用。
 *
 * - 只暴露只读工具：写操作必须在完整模式或工具页进行，避免把审批语义藏在转发层后面。
 * - 检索按名称/服务/描述匹配，中文描述可直接搜。
 * - 结果裁剪到 limit 条，并保留完整 inputSchema，模型拿到后可以立刻调用。
 */
const MAX_LIMIT = 8;

export const SEARCH_TOOL = {
  name: "campus_tool_search",
  description: "按关键词检索可用的清华校园只读工具，返回名称、服务与参数 Schema。先检索再调用，不要凭记忆猜工具名。",
  inputSchema: {
    type: "object",
    properties: {
      query: { type: "string", description: "关键词，如“成绩”“座位”“体育场馆”“作业”。" },
      limit: { type: "integer", minimum: 1, maximum: MAX_LIMIT, description: "返回条数，默认 5。" },
    },
    required: ["query"],
    additionalProperties: false,
  },
  readOnly: true,
};

export const CALL_TOOL = {
  name: "campus_tool_call",
  description: "调用 campus_tool_search 找到的只读工具。name 必须来自检索结果；写操作请提示用户在工具页使用完整模式。",
  inputSchema: {
    type: "object",
    properties: {
      name: { type: "string", description: "检索结果里的工具名。" },
      arguments: { type: "object", description: "该工具的入参对象；无参数时传 {}。", additionalProperties: true },
    },
    required: ["name"],
    additionalProperties: false,
  },
  readOnly: true,
};

export function createCompactToolset({ host }) {
  const catalog = () => host.describe().filter(tool => tool.readOnly && tool.name !== SEARCH_TOOL.name && tool.name !== CALL_TOOL.name);
  const byName = name => catalog().find(tool => tool.name === name);

  function search(args = {}) {
    const raw = String(args.query ?? "").trim();
    const limit = Math.min(MAX_LIMIT, Math.max(1, Number(args.limit) || 5));
    if (!raw) return { ok: false, error: { code: "INVALID_ARGUMENTS", message: "请给出检索关键词。" } };
    const words = raw.toLowerCase().split(/[\s,，、]+/).filter(Boolean);
    const scored = catalog().map(tool => {
      const haystack = `${tool.name} ${tool.service || ""} ${tool.description || ""}`.toLowerCase();
      let score = 0;
      for (const word of words) if (haystack.includes(word)) score += 1;
      if (tool.name.toLowerCase().includes(words[0])) score += 2;
      return { tool, score };
    }).filter(item => item.score > 0)
      .sort((a, b) => b.score - a.score || a.tool.name.localeCompare(b.tool.name))
      .slice(0, limit)
      .map(({ tool }) => ({ name: tool.name, service: tool.service, description: tool.description, inputSchema: tool.inputSchema }));
    return {
      ok: true,
      data: {
        query: raw,
        total: catalog().length,
        matched: scored.length,
        tools: scored,
        ...(scored.length ? {} : { hint: "没有匹配的只读工具。换个关键词，或提示用户在工具页查看完整列表。" }),
      },
    };
  }

  async function call(args = {}, context) {
    const name = String(args.name ?? "").trim();
    if (!name) return { ok: false, error: { code: "INVALID_ARGUMENTS", message: "缺少工具名。" } };
    const tool = byName(name);
    if (!tool) {
      const write = host.describe().find(item => item.name === name);
      return {
        ok: false,
        error: write
          ? { code: "WRITE_TOOL_REQUIRES_FULL_MODE", message: `“${name}”会写入校园数据，精简模式不提供。请让用户到工具页用完整模式确认执行。` }
          : { code: "UNKNOWN_TOOL", message: `没有名为“${name}”的只读工具，请先检索。` },
      };
    }
    const payload = args.arguments && typeof args.arguments === "object" && !Array.isArray(args.arguments) ? args.arguments : {};
    return host.call(name, payload, context);
  }

  return {
    toolForModel() {
      return [SEARCH_TOOL, CALL_TOOL].map(tool => ({
        type: "function",
        function: { name: tool.name, description: tool.description, parameters: tool.inputSchema },
      }));
    },
    describe() {
      return [SEARCH_TOOL, CALL_TOOL].map(({ name, description, inputSchema, readOnly }) => ({ name, description, inputSchema, readOnly }));
    },
    async call(name, args = {}, context) {
      if (name === SEARCH_TOOL.name) return search(args);
      if (name === CALL_TOOL.name) return call(args, context);
      return { ok: false, error: { code: "UNKNOWN_TOOL", message: "精简模式只有两个入口，请先检索。" } };
    },
  };
}