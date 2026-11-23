/**
 * 第三方模型提供商配置。
 *
 * 支持两类协议：
 * - openai：`/models` + `/chat/completions`（OpenAI、DeepSeek、Moonshot、通义、vLLM、Ollama 等兼容端点）
 * - anthropic：`/v1/models` + `/v1/messages`（Claude 原生协议，由 anthropic.mjs 翻译）
 *
 * 密钥只保存在本机 stateDir/model-providers.json；接口只返回掩码。
 */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { atomic, directory } from "../../packages/browser/core.mjs";

export const PROVIDER_KINDS = ["openai", "openai-responses", "anthropic"];
const NAME_MAX = 40;

export class ProviderError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function trimSlash(value) {
  return String(value || "").replace(/\/+$/, "");
}

export function maskKey(key) {
  const value = String(key || "");
  if (!value) return "";
  if (value.length <= 8) return "****";
  return value.slice(0, 4) + "****" + value.slice(-4);
}

export function providerDefaults(kind) {
  if (kind === "anthropic") return { baseUrl: "https://api.anthropic.com/v1", model: "claude-sonnet-4-5" };
  if (kind === "openai-responses") return { baseUrl: "https://api.openai.com/v1", model: "gpt-5" };
  return { baseUrl: "https://api.openai.com/v1", model: "gpt-4.1-mini" };
}

export function normalizeProvider(input = {}, existing = null) {
  const kind = String(input.kind || existing?.kind || "");
  if (!PROVIDER_KINDS.includes(kind)) throw new ProviderError("INVALID_ARGUMENTS", "提供商类型只能是 openai 或 anthropic。");
  const name = String(input.name ?? existing?.name ?? "").trim().slice(0, NAME_MAX);
  if (!name) throw new ProviderError("INVALID_ARGUMENTS", "请填写提供商名称，便于在列表里区分。");
  const rawBase = String(input.baseUrl ?? existing?.baseUrl ?? "").trim();
  if (!/^https?:\/\//i.test(rawBase)) throw new ProviderError("INVALID_ARGUMENTS", "接口地址必须是 http(s) 地址。");
  const baseUrl = trimSlash(rawBase);
  // 留空表示沿用已有密钥；首次配置必须给密钥。
  const keyInput = typeof input.apiKey === "string" ? input.apiKey.trim() : "";
  const apiKey = keyInput || existing?.apiKey || "";
  if (!apiKey) throw new ProviderError("INVALID_ARGUMENTS", "请填写 API 密钥。");
  const models = Array.isArray(input.models)
    ? [...new Set(input.models.map(item => String(item || "").trim()).filter(Boolean))].slice(0, 200)
    : existing?.models || [];
  const model = String(input.model ?? existing?.model ?? "").trim() || models[0] || providerDefaults(kind).model;
  return { kind, name, baseUrl, apiKey, models, model };
}

export class ProviderStore {
  constructor(stateDir, { encrypt = null, persist = null } = {}) {
    this.file = path.join(stateDir, "model-providers.json");
    this.stateDir = stateDir;
    this.encrypt = encrypt;
    this.persist = persist;
    this.state = { providers: [], activeId: "" };
    this.loaded = false;
  }

  /** 同步读取：应用启动时要在构造阶段就拿到启用状态。 */
  loadSync() {
    try {
      const raw = readFileSync(this.file);
      const text = this.encrypt ? this.encrypt(raw, true) : raw.toString("utf8");
      const parsed = JSON.parse(String(text));
      this.state = {
        providers: Array.isArray(parsed?.providers) ? parsed.providers : [],
        activeId: typeof parsed?.activeId === "string" ? parsed.activeId : "",
      };
    } catch {
      this.state = { providers: [], activeId: "" };
    }
    this.loaded = true;
    return this;
  }

  async load() {
    if (this.loaded) return this;
    try {
      const raw = await readFile(this.file);
      const text = this.encrypt ? (await this.encrypt(raw, true)).toString("utf8") : raw.toString("utf8");
      const parsed = JSON.parse(text);
      this.state = {
        providers: Array.isArray(parsed?.providers) ? parsed.providers : [],
        activeId: typeof parsed?.activeId === "string" ? parsed.activeId : "",
      };
    } catch {
      this.state = { providers: [], activeId: "" };
    }
    this.loaded = true;
    return this;
  }

  async save() {
    await directory(this.stateDir);
    const bytes = Buffer.from(JSON.stringify(this.state));
    await atomic(this.file, this.encrypt ? await this.encrypt(bytes) : bytes);
    if (this.persist) await this.persist(this.state);
  }

  list() {
    return this.state.providers.map(({ apiKey, ...rest }) => ({ ...rest, masked: maskKey(apiKey), hasKey: Boolean(apiKey) }));
  }

  get(id) {
    return this.state.providers.find(item => item.id === id);
  }

  active() {
    if (!this.state.activeId) return null;
    return this.get(this.state.activeId) || null;
  }

  async create(input) {
    await this.load();
    const normalized = normalizeProvider(input);
    if (this.state.providers.some(item => item.name === normalized.name))
      throw new ProviderError("INVALID_ARGUMENTS", "已有同名提供商，请换个名称。");
    const provider = { id: randomUUID(), ...normalized, createdAt: new Date().toISOString() };
    this.state.providers = [...this.state.providers, provider];
    if (!this.state.activeId) this.state.activeId = provider.id;
    await this.save();
    return { ...provider, apiKey: undefined, masked: maskKey(provider.apiKey), hasKey: true };
  }

  async update(id, patch = {}) {
    await this.load();
    const existing = this.get(id);
    if (!existing) return null;
    const normalized = normalizeProvider({ ...patch, kind: patch.kind ?? existing.kind }, existing);
    const index = this.state.providers.findIndex(item => item.id === id);
    this.state.providers[index] = { ...existing, ...normalized };
    await this.save();
    return { ...this.state.providers[index], apiKey: undefined, masked: maskKey(this.state.providers[index].apiKey), hasKey: true };
  }

  async remove(id) {
    await this.load();
    const before = this.state.providers.length;
    this.state.providers = this.state.providers.filter(item => item.id !== id);
    if (this.state.providers.length === before) return false;
    if (this.state.activeId === id) this.state.activeId = this.state.providers[0]?.id || "";
    await this.save();
    return true;
  }

  async setActive(id) {
    await this.load();
    if (id && !this.get(id)) throw new ProviderError("PROVIDER_NOT_FOUND", "提供商不存在。");
    this.state.activeId = id || "";
    await this.save();
    return this.active();
  }

  async setModels(id, models) {
    await this.load();
    const existing = this.get(id);
    if (!existing) return null;
    existing.models = [...new Set((models || []).map(item => String(item || "").trim()).filter(Boolean))].slice(0, 200);
    if (!existing.model && existing.models.length) existing.model = existing.models[0];
    await this.save();
    return { ...existing, apiKey: undefined, masked: maskKey(existing.apiKey), hasKey: true };
  }
}

/** 读取上游模型列表：两类协议都返回 id 数组；失败抛带状态的错误，不猜模型。 */
export async function fetchProviderModels(provider, { fetchImpl = fetch, timeoutMs = 15000 } = {}) {
  const base = trimSlash(provider.baseUrl);
  const headers = provider.kind === "anthropic"
    ? { "x-api-key": provider.apiKey, "anthropic-version": "2023-06-01", "content-type": "application/json" }
    : { authorization: "Bearer " + provider.apiKey, "content-type": "application/json" };
  const url = provider.kind === "anthropic" ? base + "/models?limit=100" : base + "/models";
  const response = await fetchImpl(url, { headers, signal: AbortSignal.timeout(timeoutMs) }).catch(() => null);
  if (!response) throw new ProviderError("PROVIDER_UNREACHABLE", "无法连接该接口地址，请检查网络或地址。");
  if (!response.ok) {
    await response.body?.cancel();
    throw new ProviderError(response.status === 401 || response.status === 403 ? "PROVIDER_AUTH_FAILED" : "PROVIDER_MODELS_FAILED",
      response.status === 401 || response.status === 403 ? "密钥被拒绝，请检查 API Key。" : `上游返回 ${response.status}，无法读取模型列表。`);
  }
  const body = await response.json().catch(() => ({}));
  const rows = Array.isArray(body?.data) ? body.data : Array.isArray(body?.models) ? body.models : [];
  const models = rows.map(item => String(item?.id ?? item?.name ?? "")).filter(Boolean);
  if (!models.length) throw new ProviderError("PROVIDER_MODELS_EMPTY", "上游没有返回任何模型。");
  return models;
}