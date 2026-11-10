import { createHash } from "node:crypto";
export const ORIGIN = "https://madmodel.cs.tsinghua.edu.cn";
export const LOGIN_URL =
  "https://id.tsinghua.edu.cn/do/off/ui/auth/login/form/" +
  createHash("md5").update("DEEPSEEK").digest("hex") +
  "/0?/authLogin";
export class MadModelError extends Error {
  constructor(code, message, status = 502) {
    super(message);
    this.code = code;
    this.status = status;
  }
}
export const error = (code, message, status) =>
  new MadModelError(code, message, status);
export function parseToken(token) {
  try {
    if (
      typeof token !== "string" ||
      token.length > 65536 ||
      token.split(".").length !== 3
    )
      throw 0;
    const p = JSON.parse(
      Buffer.from(token.split(".")[1], "base64url").toString("utf8"),
    );
    const account = p.zjh ?? p.yhm;
    if (
      !["string", "number"].includes(typeof account) ||
      !String(account).trim() ||
      typeof p.exp !== "number" ||
      !Number.isFinite(p.exp) ||
      p.exp <= 0
    )
      throw 0;
    return {
      account: String(account),
      accountId: createHash("sha256")
        .update(String(account))
        .digest("hex")
        .slice(0, 16),
      expiresAt: p.exp * 1000,
      issuedAt: typeof p.iat === "number" ? p.iat * 1000 : undefined,
    };
  } catch {
    throw error("AUTH_TOKEN_INVALID", "MadModel 登录令牌格式无效。", 401);
  }
}
export function discoverModels(script) {
  const start = /\bmodelList\s*:\s*\[/.exec(script);
  if (!start)
    throw error(
      "MODEL_DISCOVERY_FAILED",
      "站点模型目录格式已变化，请检查前端配置。",
    );
  let depth = 1,
    quote = false,
    escape = false,
    end = start.index + start[0].length;
  for (; end < script.length && depth; end++) {
    const c = script[end];
    if (quote) {
      if (escape) escape = false;
      else if (c === "\\") escape = true;
      else if (c === '"') quote = false;
    } else if (c === '"') quote = true;
    else if (c === "[") depth++;
    else if (c === "]") depth--;
  }
  if (depth) throw error("MODEL_DISCOVERY_FAILED", "站点模型目录不完整。");
  const values = [
    ...script
      .slice(start.index, end)
      .matchAll(/\bvalue\s*:\s*("(?:\\.|[^"\\])*")/g),
  ].map((m) => JSON.parse(m[1]));
  const ids = [...new Set(values)].filter(
    (x) => typeof x === "string" && x.length > 0 && x.length <= 200,
  );
  if (!ids.length)
    throw error("MODEL_DISCOVERY_FAILED", "站点未提供可识别的模型。");
  return ids.map((id) => ({
    id,
    object: "model",
    created: 0,
    owned_by: "tsinghua-madmodel",
  }));
}
export function validateCompletion(body) {
  if (
    !body ||
    typeof body !== "object" ||
    Array.isArray(body) ||
    typeof body.model !== "string" ||
    !body.model.trim() ||
    !Array.isArray(body.messages) ||
    !body.messages.length ||
    body.messages.some(
      (m) =>
        !m ||
        typeof m !== "object" ||
        ![
          "system",
          "developer",
          "user",
          "assistant",
          "tool",
          "function",
        ].includes(m.role),
    ) ||
    (body.stream !== undefined && typeof body.stream !== "boolean")
  )
    throw error(
      "INVALID_REQUEST",
      "需要 model、非空 messages，stream 必须为布尔值。",
      400,
    );
  return body;
}
export function safeFailure(e) {
  const messages = {
    BROWSER_BUSY: "独立浏览器正被其他任务占用，请关闭窗口后重试。",
    BROWSER_LOGIN_REQUIRED: "需要在本机浏览器完成 MadModel 登录。",
    VERIFICATION_REQUIRED:
      "学校要求验证码，请运行 madmodel login 在本机完成验证。",
    BROWSER_ACCOUNT_MISMATCH:
      "浏览器账号与当前 MadModel 绑定不同，未替换会话。",
    AUTH_CHANGED: "认证在操作期间变化，未恢复旧会话。",
    AUTH_REQUIRED: "MadModel 已注销，请运行 madmodel login。",
    AUTH_TOKEN_INVALID: "MadModel 登录令牌格式无效。",
    AUTH_EXPIRED: "MadModel 会话已过期。",
    AUTH_COOLDOWN: "登录恢复暂时失败，稍后重试。",
    MODEL_DISCOVERY_FAILED: "无法获取站点当前模型目录。",
    UPSTREAM_PROTOCOL: "上游返回了不兼容的响应。",
    INVALID_REQUEST: "请求格式无效。",
  };
  const code = Object.hasOwn(messages, e?.code)
    ? e.code
    : e?.name === "AbortError"
      ? "CANCELLED"
      : "MADMODEL_FAILED";
  return {
    code,
    message:
      messages[code] ||
      (code === "CANCELLED"
        ? "请求已取消。"
        : "MadModel 操作失败，请检查网络和登录状态。"),
  };
}
