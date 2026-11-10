import { MadModelClient } from "./client.mjs";
export const madmodelTools = [
  {
    name: "madmodel_status",
    description:
      "查看本机 MadModel 登录与到期状态，不返回密码、Cookie 或令牌。模型 HTTP 服务用 madmodel serve 启动。",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: "madmodel_models",
    description: "读取 MadModel 站点当前模型目录，返回 OpenAI 模型列表。",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
  },
];
export async function callMadmodelTool(name, args = {}) {
  if (
    !args ||
    Array.isArray(args) ||
    typeof args !== "object" ||
    Object.keys(args).length
  )
    throw Object.assign(new Error("无效的 MadModel 工具参数。"), {
      code: "INVALID_ARGUMENTS",
    });
  const client = new MadModelClient();
  if (name === "madmodel_status") return client.manager.status();
  if (name === "madmodel_models") return client.models();
  throw Object.assign(new Error("未知 MadModel 工具。"), {
    code: "UNKNOWN_TOOL",
  });
}
