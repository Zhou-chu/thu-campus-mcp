import { MadModelClient } from "./client.mjs";
export const madmodelTools = [
  {
    name: "madmodel_status",
    description:
      "只读验证MadModel已有会话；verify=false仅查本地配置。不自动登录、不调用付费模型，不返回身份或令牌。",
    inputSchema: {
      type: "object",
      properties: { verify: { type: "boolean", default: true } },
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
export async function callMadmodelTool(name, args = {}, { client = new MadModelClient() } = {}) {
  if (
    !args || Array.isArray(args) || typeof args !== "object" ||
    Object.keys(args).some(key => name !== "madmodel_status" || key !== "verify") ||
    (Object.hasOwn(args, "verify") && typeof args.verify !== "boolean")
  )
    throw Object.assign(new Error("无效的 MadModel 工具参数。"), {
      code: "INVALID_ARGUMENTS",
    });
  if (name === "madmodel_status") return client.manager.status({ verify: args.verify ?? true });
  if (name === "madmodel_models") return client.models();
  throw Object.assign(new Error("未知 MadModel 工具。"), {
    code: "UNKNOWN_TOOL",
  });
}
