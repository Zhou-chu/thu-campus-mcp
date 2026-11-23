import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";

export const DEFAULT_BASE_URL = "https://git.tsinghua.edu.cn";
const CONFIG_FILE = "gitlab.json";
const TIMEOUT_MS = 20_000;

export class GitlabError extends Error {
  constructor(code, message, extra = {}) {
    super(message);
    this.name = "GitlabError";
    this.code = code;
    Object.assign(this, extra);
  }
}

const cleanBase = value => {
  const text = String(value || "").trim();
  if (!text) return "";
  if (!/^https?:\/\//i.test(text)) return "";
  return text.replace(/\/+$/, "");
};

export function resolveConfig({ stateDir = process.env.THU_CAMPUS_APP_STATE_DIR || "", env = process.env, secure = null } = {}) {
  return { stateDir, env, file: stateDir ? path.join(stateDir, CONFIG_FILE) : "", secure };
}

/** 读取配置：文件优先，环境变量兜底。令牌只在进程内使用，不返回给前端。 */
export async function loadGitlabConfig(options = {}) {
  const { file, env, secure } = resolveConfig(options);
  let stored = {};
  if (secure) {
    const encrypted = await secure.get("gitlab").catch(() => null);
    if (encrypted) stored = encrypted;
  }
  if (!stored.token && file) {
    try {
      stored = JSON.parse(await readFile(file, "utf8"));
    } catch {
      stored = {};
    }
  }
  const baseUrl = cleanBase(stored.baseUrl) || cleanBase(env.GITLAB_BASE_URL) || DEFAULT_BASE_URL;
  const token = String(stored.token || env.GITLAB_TOKEN || "").trim();
  return { baseUrl, token, configured: Boolean(token), source: stored.token ? (secure ? "db" : "file") : env.GITLAB_TOKEN ? "env" : "none" };
}

export async function saveGitlabConfig({ baseUrl, token }, options = {}) {
  const { file, secure } = resolveConfig(options);
  if (!file && !secure) throw new GitlabError("GITLAB_STATE_DIR_MISSING", "没有配置状态目录，无法保存 GitLab 设置。");
  const next = {};
  const cleanUrl = cleanBase(baseUrl);
  if (cleanUrl) next.baseUrl = cleanUrl;
  else if (String(baseUrl || "").trim()) throw new GitlabError("INVALID_BASE_URL", "GitLab 地址必须是 http(s) 链接。");
  if (typeof token === "string" && token.trim()) next.token = token.trim();
  const current = secure ? ((await secure.get("gitlab").catch(() => null)) || {}) : await loadGitlabConfigRaw(file);
  const merged = { ...current, ...next };
  if (!merged.baseUrl) merged.baseUrl = DEFAULT_BASE_URL;
  if (secure) {
    await secure.put("gitlab", merged);
    return { baseUrl: merged.baseUrl, configured: Boolean(merged.token), source: "db" };
  }
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(merged), { encoding: "utf8", mode: 0o600 });
  return { baseUrl: merged.baseUrl, configured: Boolean(merged.token), source: "file" };
}

async function loadGitlabConfigRaw(file) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch {
    return {};
  }
}

export function maskToken(token) {
  const text = String(token || "");
  if (!text) return "";
  if (text.length <= 8) return "****";
  return `${text.slice(0, 4)}****${text.slice(-4)}`;
}

const mapStatus = status => {
  if (status === 401) return new GitlabError("GITLAB_UNAUTHORIZED", "GitLab 令牌无效或已过期。", { status });
  if (status === 403) return new GitlabError("GITLAB_FORBIDDEN", "当前令牌没有访问该资源的权限。", { status });
  if (status === 404) return new GitlabError("GITLAB_NOT_FOUND", "GitLab 上找不到该资源。", { status });
  if (status === 429) return new GitlabError("GITLAB_RATE_LIMITED", "GitLab 限流了，请稍后再试。", { status });
  return new GitlabError("GITLAB_REQUEST_FAILED", `GitLab 返回 HTTP ${status}。`, { status });
};

/**
 * 调用 GitLab REST API v4。
 * 未配置令牌时抛 GITLAB_NOT_CONFIGURED（而不是网络错误），便于前端提示去设置页。
 */
export async function gitlabRequest(pathname, { query = null, method = "GET", body = null, config, fetchImpl = globalThis.fetch } = {}) {
  const resolved = config || (await loadGitlabConfig());
  if (!resolved.configured) throw new GitlabError("GITLAB_NOT_CONFIGURED", "还没有配置 GitLab 访问令牌，请到「设置 → 服务」里填写。");
  const url = new URL(`/api/v4/${String(pathname).replace(/^\/+/, "")}`, resolved.baseUrl);
  for (const [key, value] of Object.entries(query || {})) {
    if (value === undefined || value === null || value === "") continue;
    url.searchParams.set(key, String(value));
  }
  let response;
  try {
    response = await fetchImpl(url, {
      method,
      headers: { "PRIVATE-TOKEN": resolved.token, accept: "application/json", ...(body ? { "content-type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (error) {
    throw new GitlabError("GITLAB_UNREACHABLE", `连不上 GitLab：${error?.message || "网络错误"}。`);
  }
  if (!response.ok) throw mapStatus(response.status);
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    throw new GitlabError("GITLAB_INVALID_RESPONSE", "GitLab 返回的不是 JSON。");
  }
}

export const encodeProject = project => {
  const text = String(project || "").trim();
  if (!text) throw new GitlabError("ARGUMENT_REQUIRED", "需要项目 id 或 path（例如 zhouc24/gtep-cli）。");
  if (/^\d+$/.test(text)) return text;
  return encodeURIComponent(text);
};