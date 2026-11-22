import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { root, serviceEnvironment } from "../services.mjs";
const prefixes = {
  learn_: "learnx",
  cloud_: "cloud",
  rain_: "hetang",
  madmodel_: "madmodel",
  campus_browser_: "browser",
};
const SERVICES = new Set(["learnx", "cloud", "hetang", "madmodel", "browser", "seat", "sports", "gitlab", "campus"]);
/** 优先使用网关标注的归属；前缀推断只作为旧版网关的兜底。 */
export function serviceOf(tool) {
  const named = typeof tool === "string" ? undefined : tool?._meta?.service;
  if (SERVICES.has(named)) return named;
  const toolName = typeof tool === "string" ? tool : tool?.name || "";
  for (const [prefix, service] of Object.entries(prefixes))
    if (toolName.startsWith(prefix)) return service;
  return "campus";
}
/**
 * 进程内目录：与网关共用 createCatalog，工具调用不再跨 stdio 进程。
 * 形状对齐 MCP 客户端的 listTools/callTool/close，其余代码无需分支。
 */
async function createCatalogClient() {
  const { createCatalog } = await import("../gateway.mjs");
  const catalog = await createCatalog();
  return {
    async listTools() {
      return { tools: catalog.tools };
    },
    async callTool(request) {
      return catalog.callTool(request);
    },
    async close() {
      await catalog.close();
    },
  };
}
function payload(result) {
  if (result.structuredContent) return result.structuredContent;
  const text = result.content?.find((c) => c.type === "text")?.text;
  if (typeof text !== "string") return {};
  try {
    return JSON.parse(text);
  } catch {
    return { text };
  }
}
/**
 * 工具主机：直接连现有统一 MCP 入口，复用 51 个校园工具、4 个浏览器工具
 * 与 madmodel 工具，以及既有的登录恢复与错误码语义。
 */
export class ToolHost {
  constructor({ client, timeoutMs = 180000 }) {
    this.client = client;
    this.timeoutMs = timeoutMs;
    this.tools = [];
  }
  static async start({ env = process.env, timeoutMs = 180000, inProcess = true } = {}) {
    if (inProcess && env.THU_CAMPUS_APP_TOOLHOST !== "stdio") {
      const catalog = await createCatalogClient().catch(() => null);
      if (catalog) {
        const host = new ToolHost({ client: catalog, timeoutMs });
        await host.refresh();
        return host;
      }
    }
    const childEnv = { ...env };
    delete childEnv.THU_CAMPUS_APP_TOOLHOST;
    const client = new Client({ name: "campus-app", version: "1.3.0" });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [path.join(root, "bin/thu-campus.mjs"), "serve"],
      env: serviceEnvironment(childEnv),
      stderr: "pipe",
    });
    transport.stderr?.resume();
    await client.connect(transport);
    const host = new ToolHost({ client, timeoutMs });
    await host.refresh();
    return host;
  }
  async refresh() {
    this.tools = (await this.client.listTools()).tools || [];
    return this.tools;
  }
  describe() {
    return this.tools.map((tool) => ({
      name: tool.name,
      description: tool.description || "",
      service: serviceOf(tool),
      inputSchema: tool.inputSchema || { type: "object", properties: {} },
      readOnly: tool.annotations?.readOnlyHint === true,
      destructive: tool.annotations?.destructiveHint === true,
    }));
  }
  toolForModel() {
    return this.tools.map((tool) => ({
      type: "function",
      function: {
        name: tool.name,
        description: (tool.description || "").slice(0, 1024),
        parameters: tool.inputSchema || { type: "object", properties: {} },
      },
    }));
  }
  async call(name, args = {}) {
    if (typeof name !== "string" || !/^[a-z][a-z0-9_]{2,63}$/.test(name))
      return {
        ok: false,
        error: { code: "INVALID_TOOL", message: "工具名不合法。" },
      };
    if (!args || typeof args !== "object" || Array.isArray(args))
      return {
        ok: false,
        error: { code: "INVALID_ARGUMENTS", message: "工具参数必须是对象。" },
      };
    const known = this.tools.find((t) => t.name === name);
    if (!known) {
      await this.refresh().catch(() => {});
      if (!this.tools.some((t) => t.name === name))
        return {
          ok: false,
          error: { code: "UNKNOWN_TOOL", message: "没有此工具。" },
        };
    }
    try {
      const result = await this.client.callTool({ name, arguments: args }, undefined, {
        timeout: this.timeoutMs,
      });
      const data = payload(result);
      if (result.isError)
        return {
          ok: false,
          error: {
            code: typeof data.code === "string" && /^[A-Z_]+$/.test(data.code)
              ? data.code
              : "TOOL_FAILED",
            message:
              typeof data.message === "string"
                ? data.message
                : "工具未完成，请检查会话及浏览器任务状态。",
          },
        };
      return { ok: true, data };
    } catch (e) {
      return {
        ok: false,
        error: {
          code: /^[A-Z_]+$/.test(e?.code || "") ? e.code : "TOOL_FAILED",
          message: "工具调用失败，请重试或检查状态。",
        },
      };
    }
  }
  async close() {
    await this.client.close().catch(() => {});
  }
}