import { readChatEvents } from "./chat-stream.js";
import { renderMarkdown, fetchArtifact, workspaceJob, createJobPoller, JOB_LABELS, authPresentation, storagePresentation, jobStoragePresentation } from "./workspace.js";

import { runAction } from "./ui-feedback.js";
import { recentSessions, sidebarStorageLabel } from "./sidebar.js";
import { HOME_ACTIONS, ADD_ACTIONS, ICON_PATHS, getHomeAction, homeIsEmpty } from "./chat-home.js";

const STORAGE_TOKEN = "campus.app.token";
const STORAGE_BASE = "campus.app.base";
const state = {
  token: "",
  base: "",
  meta: null,
  view: "chat",
  messages: [],
  chatDraft: "",
  sessionId: null,
  busy: false,
  controller: null,
  tools: [],
  sessions: [],
  sessionsError: "",
  settings: null,
  models: [],
  selectedModel: "",
  modelsLoading: false,
  modelSaving: false,
  modelsError: "",
  authChecking: false,
  authError: "",
  authLoginBusy: "",
  authNotices: {},
  workspaceStorage: null,
  workspaceStorageLoading: false,
  workspaceStorageError: "",
  deeplinkCode: "",
};
const el = (tag, props = {}, children = []) => {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === "class") node.className = value;
    else if (key === "text") node.textContent = value;
    else if (key === "dataset") Object.assign(node.dataset, value);
    else if (key.startsWith("on") && typeof value === "function")
      node.addEventListener(key.slice(2), value);
    else if (key in node && key !== "list") node[key] = value;
    else node.setAttribute(key, value);
  }
  for (const child of [].concat(children))
    if (child) node.append(child.nodeType ? child : document.createTextNode(String(child)));
  return node;
};
const clear = (node) => {
  while (node.firstChild) node.removeChild(node.firstChild);
  return node;
};
const $ = (selector) => document.querySelector(selector);
let toastTimer = 0;
function toast(message) {
  const node = $("#toast");
  node.textContent = message;
  node.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    node.hidden = true;
  }, 3200);
}
function renderRich(text) {
  return renderMarkdown(text, { origin: location.origin, onArtifact: downloadArtifact });
}
async function downloadArtifact(link, anchor) {
  if (anchor.getAttribute("aria-busy") === "true") return;
  anchor.setAttribute("aria-busy", "true");
  anchor.parentNode?.querySelector(".download-error")?.remove();
  try {
    const { blob, filename } = await fetchArtifact(link.href, { origin: location.origin, base: state.base, token: state.token });
    const url = URL.createObjectURL(blob);
    const download = el("a", { href: url, download: filename, hidden: true });
    document.body.append(download);
    download.click();
    download.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch (error) {
    anchor.after(el("span", { class: "download-error error", role: "alert", text: "下载失败：" + error.message + " 点击链接重试。" }));
  } finally { anchor.removeAttribute("aria-busy"); }
}
function endpoint(path) {
  return (state.base || "").replace(/\/+$/, "") + path;
}
async function api(path, { method = "GET", body, signal } = {}) {
  const headers = {};
  if (body !== undefined) headers["content-type"] = "application/json";
  if (state.token) headers.authorization = "Bearer " + state.token;
  const response = await fetch(endpoint(path), {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal,
  });
  let data = {};
  try {
    data = await response.json();
  } catch {
    data = { ok: false, error: { code: "BAD_RESPONSE", message: "服务返回了非 JSON 响应。" } };
  }
  if (!response.ok || data.ok === false) {
    const error = new Error(data?.error?.message || `请求失败（HTTP ${response.status}）`);
    error.code = data?.error?.code || `HTTP_${response.status}`;
    throw error;
  }
  return data;
}
function bootToken() {
  const hash = new URLSearchParams(location.hash.replace(/^#/, ""));
  const query = new URLSearchParams(location.search);
  const fromUrl = hash.get("token") || query.get("token");
  const code = hash.get("code") || query.get("code");
  const base = hash.get("base") || query.get("base");
  if (fromUrl) {
    state.token = fromUrl;
    try {
      localStorage.setItem(STORAGE_TOKEN, fromUrl);
    } catch {}
  } else {
    try {
      state.token = localStorage.getItem(STORAGE_TOKEN) || "";
    } catch {
      state.token = "";
    }
  }
  try {
    state.base = localStorage.getItem(STORAGE_BASE) || "";
  } catch {
    state.base = "";
  }
  if (base) {
    state.base = base;
    try {
      localStorage.setItem(STORAGE_BASE, base);
    } catch {}
  }
  if (code) state.deeplinkCode = code;
  if (fromUrl || code || base || location.search || location.hash)
    history.replaceState(null, "", location.pathname);
}
function forgetToken() {
  state.token = "";
  try {
    localStorage.removeItem(STORAGE_TOKEN);
  } catch {}
}
/* ---------------- 配对 ---------------- */
function showPair(message) {
  $("#app").hidden = true;
  $("#pair").hidden = false;
  const errorNode = $("#pair-error");
  errorNode.hidden = !message;
  errorNode.textContent = message || "";
  const baseInput = $("#pair-base");
  if (!baseInput.value) baseInput.value = state.base || location.origin;
  const codeInput = $("#pair-code");
  if (state.deeplinkCode && !codeInput.value) {
    codeInput.value = state.deeplinkCode;
    state.deeplinkCode = "";
  }
  if (state.token) {
    // 有令牌但被拒绝：清掉，回到配对
    forgetToken();
  }
}
async function submitPair() {
  const button = $("#pair-submit");
  const errorNode = $("#pair-error");
  const base = $("#pair-base").value.trim().replace(/\/+$/, "") || location.origin;
  const code = $("#pair-code").value.trim();
  if (!/^\d{6}$/.test(code)) {
    errorNode.hidden = false;
    errorNode.textContent = "配对码是 6 位数字。";
    return;
  }
  button.disabled = true;
  errorNode.hidden = true;
  try {
    const response = await fetch(base + "/api/pair/redeem", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        code,
        deviceName: navigator.platform || "浏览器",
        platform: "webui",
      }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.ok) {
      const map = {
        PAIRING_EXPIRED: "配对码无效或已过期，请在电脑上重新生成。",
        PAIRING_LOCKED: "尝试过于频繁，请稍后再试。",
        PAIRING_INVALID: "配对码格式不对。",
        PAIRING_DISABLED: "这台电脑使用固定令牌，请直接打开带令牌的链接。",
      };
      throw Object.assign(new Error(map[data?.error?.code] || data?.error?.message || "配对失败"), {
        code: data?.error?.code,
      });
    }
    state.token = data.token;
    state.base = base;
    try {
      localStorage.setItem(STORAGE_TOKEN, data.token);
      localStorage.setItem(STORAGE_BASE, base);
    } catch {}
    $("#pair").hidden = true;
    $("#app").hidden = false;
    await refreshMeta();
    render();
  } catch (e) {
    errorNode.hidden = false;
    errorNode.textContent = e.message || "配对失败，请检查地址与网络。";
  } finally {
    button.disabled = false;
  }
}
/* ---------------- 元信息 ---------------- */
async function refreshMeta() {
  try {
    state.meta = await api("/api/meta");
    acceptModels(state.meta.models, state.meta.model?.name);
    $("#health-dot").className = "dot ok";
    $("#account").textContent = "服务运行中";
    state.authError = "";
    await loadWorkspaceStorage();
    return true;
  } catch (e) {
    if (["AUTH_REQUIRED", "HTTP_401"].includes(e.code)) {
      showPair("令牌已失效，请重新配对。");
      return false;
    }
    $("#health-dot").className = "dot bad";
    $("#account").textContent = "服务连接失败";
    state.authError = "状态刷新失败：" + e.message;
    state.workspaceStorageError = "应用连接失败，无法核验云盘工作区。";
    updateStoragePanels();
    toast(e.message);
    return false;
  }
}
/* ---------------- 云盘默认工作区（只读查询；写入交给对话审批） ---------------- */
let storageController = null;
function updateStoragePanels() {
  for (const panel of document.querySelectorAll(".workspace-storage-view")) panel.draw();
}
async function loadWorkspaceStorage() {
  storageController?.abort();
  const current = new AbortController();
  storageController = current;
  state.workspaceStorageLoading = true;
  updateStoragePanels();
  try {
    const data = await api("/api/workspace/storage", { signal: current.signal });
    if (!data.storage || typeof data.storage !== "object") throw new Error("工作区状态响应无效，请重试查询。");
    if (current.signal.aborted) return;
    state.workspaceStorage = data.storage;
    state.workspaceStorageError = "";
  } catch (error) {
    if (!current.signal.aborted) state.workspaceStorageError = "工作区查询失败：" + error.message;
  } finally {
    if (storageController === current) {
      storageController = null;
      state.workspaceStorageLoading = false;
      updateStoragePanels();
    }
  }
}
function currentStoragePresentation() {
  return storagePresentation(state.workspaceStorage, { loading: state.workspaceStorageLoading, error: state.workspaceStorageError });
}
function workspaceStorageSummary() {
  const body = el("div", { class: "composer-popover-body cloud-status-panel" });
  const panel = el("details", { class: "workspace-storage-view workspace-storage-summary composer-popover cloud-picker" }, [
    el("summary", { "aria-label": "校园云盘" }, [homeIcon("cloud"), el("span", { text: "校园云盘" })]), body,
  ]);
  panel.draw = () => {
    const info = currentStoragePresentation();
    clear(body).append(el("span", { class: "state storage-status", dataset: { s: info.state }, text: info.label }));
    if (info.scope) body.append(el("span", { class: "small", text: info.scope.rootPath }));
    if (info.message) body.append(el("span", { class: info.state === "ready" ? "small muted" : "error", text: info.message }));
    body.append(el("button", { class: "ghost", type: "button", text: state.workspaceStorageLoading ? "查询中…" : "查询状态", disabled: state.workspaceStorageLoading, "aria-busy": String(state.workspaceStorageLoading), onclick: loadWorkspaceStorage }), el("button", {
      class: "ghost", type: "button", text: "设置工作区", onclick: () => { state.view = "settings"; render(); },
    }));
  };
  panel.draw();
  return panel;
}
function workspaceStorageCard() {
  const panel = el("section", { class: "settings-section workspace-storage-view workspace-storage-card" });
  panel.draw = () => {
    const expanded = !!panel.querySelector("details")?.open;
    const info = currentStoragePresentation();
    const body = el("div", { class: "settings-content" });
    const heading = el("div", { class: "workspace-heading" });
    if (info.scope) heading.append(el("span", { class: "storage-location", text: info.scope.rootPath }));
    heading.append(el("span", { class: "state storage-status", dataset: { s: info.state }, text: info.label }));
    body.append(heading);
    if (info.message) body.append(el("div", { class: info.state === "ready" ? "small" : "error", role: info.state === "ready" ? "status" : "alert", text: info.message }));
    const actions = el("div", { class: "settings-actions" }, [el("button", {
      class: "ghost", type: "button", text: state.workspaceStorageLoading ? "刷新中…" : "刷新工作区状态",
      "aria-label": "刷新工作区状态", "aria-busy": String(state.workspaceStorageLoading), disabled: state.workspaceStorageLoading, onclick: loadWorkspaceStorage,
    })]);
    if (info.canInitialize) actions.append(el("button", {
      class: "primary", type: "button", text: "在对话中初始化",
      onclick: () => useInChat(`请使用workspace_initialize（无需参数）初始化默认云盘工作区。只读预览范围：${pretty(info.scope)}。以服务端重新核验的精确范围为准，展示确认卡后等待我授权。`),
    }));
    if (info.state === "login-required") actions.append(el("button", { class: "ghost", type: "button", text: "前往登录", onclick: () => { state.view = "services"; render(); } }));
    body.append(actions);
    const record = el("details", { class: "auth-evidence storage-scope", open: expanded }, [el("summary", { text: "范围与核验" })]);
    if (info.scope) record.append(el("pre", { text: pretty(info.scope) }));
    if (info.checkedAt) record.append(el("div", { class: "small", text: "隐私核验：" + new Date(info.checkedAt).toLocaleString() }));
    if (info.code) record.append(el("div", { class: "small", text: "状态码：" + info.code }));
    if (!info.scope && !info.checkedAt && !info.code) record.append(el("div", { class: "small", text: "尚无可确认的云盘范围。" }));
    body.append(record);
    clear(panel).append(el("div", { class: "section-heading" }, [el("h3", { text: "默认工作区" })]), body);
  };
  panel.draw();
  return panel;
}

/* ---------------- 模型目录与选择 ---------------- */
function acceptModels(models, current) {
  state.models = Array.isArray(models) ? models.filter((model) => model?.id) : [];
  state.selectedModel = current || state.selectedModel || state.models[0]?.id || "";
  state.modelsError = state.models.length ? "" : "未获取到可用模型，请刷新模型列表。";
}
function syncModelPickers() {
  refreshSidebar();
  syncChatLayout();
  const send = $("#chat-send");
  if (send) send.disabled = state.busy || state.modelSaving || state.modelsLoading || !state.selectedModel;
  const stop = $("#chat-stop");
  if (stop) stop.hidden = !state.busy;
  for (const picker of document.querySelectorAll(".model-picker")) picker.updateModels();
}
async function refreshModels() {
  if (state.modelsLoading || state.modelSaving) return;
  state.modelsLoading = true;
  state.modelsError = "";
  syncModelPickers();
  try {
    const data = await api("/api/models?refresh=1");
    acceptModels(data.models, data.current);
  } catch (e) {
    state.modelsError = e.message + (state.models.length ? "（仍显示上次成功获取的列表）" : "");
  } finally {
    state.modelsLoading = false;
    syncModelPickers();
  }
}
function modelPicker(id, compact = false) {
  const select = el("select", { id, "aria-label": "对话模型" });
  const refresh = el("button", { class: compact ? "icon-btn model-refresh" : "ghost", type: "button", "aria-label": "刷新模型", title: "刷新模型", onclick: refreshModels });
  const status = el("span", { class: "small muted model-status", role: "status", "aria-live": "polite" });
  const label = el("label", { class: "model-field", htmlFor: id }, [el("span", { text: "对话模型" }), select]);
  const picker = el("div", { class: "model-picker" }, [label, refresh, status]);
  picker.updateModels = () => {
    clear(select);
    for (const model of state.models)
      select.append(el("option", { value: model.id, text: compact ? model.label || model.id : model.label === model.id ? model.id : `${model.label} · ${model.id}` }));
    if (!state.models.some((model) => model.id === state.selectedModel)) {
      select.prepend(el("option", {
        value: state.selectedModel,
        text: state.selectedModel ? `${state.selectedModel}（当前目录中不可用）` : "暂无可用模型",
        disabled: true,
      }));
    }
    select.value = state.selectedModel;
    select.disabled = state.busy || state.modelSaving || state.modelsLoading || !state.models.length;
    refresh.disabled = state.busy || state.modelSaving || state.modelsLoading;
    refresh.setAttribute("aria-busy", String(state.modelsLoading));
    if (compact) refresh.replaceChildren(homeIcon("refresh"));
    else refresh.textContent = state.modelsLoading ? "刷新中…" : "刷新模型";
    status.className = "small model-status " + (state.modelsError ? "error" : "muted");
    status.textContent = state.modelsLoading ? "正在刷新…" : state.modelSaving ? "正在保存…" : state.modelsError;
    status.hidden = !status.textContent;
  };
  select.addEventListener("change", async () => {
    const previous = state.selectedModel;
    const chosen = select.value;
    state.modelSaving = true;
    state.modelsError = "";
    syncModelPickers();
    try {
      const data = await api("/api/settings", { method: "PUT", body: { modelName: chosen } });
      state.settings = data.settings;
      state.selectedModel = data.settings.modelName;
      if (state.meta?.model) state.meta.model.name = state.selectedModel;
      toast("模型已切换为" + state.selectedModel);
    } catch (e) {
      state.selectedModel = previous;
      state.modelsError = "模型未切换：" + e.message;
      toast(state.modelsError);
    } finally {
      state.modelSaving = false;
      syncModelPickers();
    }
  });
  picker.updateModels();
  return picker;
}
/* ---------------- 对话 ---------------- */
function blocksFromSession(session) {
  const blocks = [];
  for (const message of session.messages || []) {
    if (message.role === "user") blocks.push({ kind: "user", text: message.content || "" });
    else if (message.role === "assistant") {
      if (typeof message.reasoning === "string" && message.reasoning)
        blocks.push({ kind: "reasoning", text: message.reasoning, status: message.aborted ? "stopped" : message.interrupted ? "error" : "done" });
      if (message.content) blocks.push({ kind: "assistant", text: message.content, done: true });
      for (const call of message.toolCalls || [])
        blocks.push({ kind: "tool", name: call.name, args: call.arguments, state: "done" });
    } else if (message.role === "tool") {
      const last = [...blocks].reverse().find((b) => b.kind === "tool" && b.state === "done" && b.result === undefined);
      let parsed;
      try {
        parsed = JSON.parse(message.content || "{}");
      } catch {
        parsed = { raw: message.content };
      }
      if (last) {
        last.result = parsed;
        // 历史里的失败调用要如实显示，不能一律标成「完成」。
        if (parsed?.ok === false) last.state = "failed";
      }
    }
  }
  return blocks;
}
function bubbleFor(block) {
  const node = el("div", { class: "bubble " + (block.kind === "user" ? "user" : block.kind === "notice" ? "notice" : "assistant") });
  const rich = el("div", { class: "rich" });
  node.append(rich);
  block.node = node;
  block.rich = rich;
  setBubbleText(block, block.text || "");
  return node;
}
function setBubbleText(block, text) {
  if (!block.rich) return;
  clear(block.rich).append(renderRich(text));
}
function reasoningFor(block) {
  const details = el("details", { class: "reasoning-block", open: !!block.open });
  const summary = el("summary", { "aria-live": "polite" });
  const content = el("div", { class: "reasoning-content", "aria-live": "off" });
  details.append(summary, content);
  details.addEventListener("toggle", () => { block.open = details.open; });
  content.dataset.followTail = "true";
  content.addEventListener("scroll", () => trackTail(content));
  block.node = details;
  block.summary = summary;
  block.contentNode = content;
  updateReasoning(block);
  return details;
}
function updateReasoning(block) {
  if (!block.node) return;
  const labels = { streaming: "思考中…", done: "思考过程", stopped: "思考已停止", error: "思考已中断" };
  block.summary.textContent = labels[block.status] || labels.done;
  block.node.dataset.state = block.status || "done";
  block.contentNode.textContent = block.text || "";
  scrollIfNearBottom(block.contentNode);
}
const workspaceJobs = new Map();
const jobPoller = createJobPoller({
  isActive: () => state.view === "chat" && !document.hidden && !!state.token && !$("#app").hidden,
  getJobs: () => [...workspaceJobs.values()].filter(job => job.sessionId === state.sessionId),
  readJob: (job, signal) => api(job.statusUrl, { signal }),
  onUpdate: job => rememberJob(job),
  onError: (job, error) => rememberJob({ ...job, requestError: "查询失败：" + error.message }),
});
function rememberJob(job) {
  workspaceJobs.set(job.statusUrl, job);
  for (const block of state.messages) {
    if (block.job?.statusUrl === job.statusUrl) { block.job = job; applyToolState(block); }
  }
}
function attachJob(block, fresh = false) {
  const parsed = workspaceJob(block.result);
  if (parsed) {
    block.job = fresh ? parsed : workspaceJobs.get(parsed.statusUrl) || parsed;
    workspaceJobs.set(parsed.statusUrl, block.job);
  }
}
function useInChat(text) {
  state.chatDraft = text;
  state.view = "chat";
  render();
  const input = $("#composer");
  input.value = text;
  autoGrow(input);
  input.focus();
}
function storageForBlock(block) {
  const result = block.result?.ok === true ? block.result.data : block.result;
  return jobStoragePresentation(block.job || result);
}
function syncRecoveryButton(subject) {
  return el("button", {
    class: "ghost", type: "button", text: "在对话中恢复同步",
    onclick: () => useInChat(`请使用workspace_sync（无需参数）检查${subject}的云盘同步并恢复。保留已有本地结果，不要重新运行计算；任何云盘写入前先展示目标范围并等待确认。`),
  });
}
function drawWorkspaceJob(block) {
  const job = block.job;
  const panel = clear(block.jobNode);
  const sync = storageForBlock(block);
  panel.hidden = !job && !sync.visible;
  if (!job) {
    if (sync.visible) {
      if (sync.message || sync.code) panel.append(el("div", { class: "error job-sync-message", role: "alert", text: sync.message || sync.code }));
      if (["failed", "unconfirmed"].includes(sync.state)) panel.append(syncRecoveryButton(block.name || "当前工作区"));
    }
    return;
  }
  const info = [job.runtime, job.scriptPath].filter(Boolean).join(" · ");
  if (info) panel.append(el("div", { class: "job-meta", text: info }));
  if (!sync.visible) panel.append(el("div", { class: "small muted", text: sync.label }));
  if (sync.message) panel.append(el("div", { class: sync.state === "failed" ? "error job-sync-message" : "small job-sync-message", role: sync.state === "failed" ? "alert" : "status", text: sync.message }));
  const actions = el("div", { class: "job-actions" });
  if (job.state === "running" || job.cleanupPending === true) actions.append(el("button", {
    class: "ghost danger", type: "button", text: job.stopping ? "正在停止…" : job.cleanupPending ? "重试停止" : "停止作业", disabled: job.stopping,
    onclick: async () => {
      rememberJob({ ...job, stopping: true });
      jobPoller.sync();
      try {
        const data = await api(job.statusUrl + "/stop", { method: "POST" });
        const next = data?.ok === true ? workspaceJob(data.job) : null;
        if (!next || next.statusUrl !== job.statusUrl) throw new Error("停止响应无效，请查询实际状态。");
        rememberJob(next);
      } catch (error) {
        const latest = workspaceJobs.get(job.statusUrl) || job;
        rememberJob({ ...latest, stopping: false, requestError: "停止失败：" + error.message });
      } finally { jobPoller.sync(); }
    },
  }));
  if (job.requestError) {
    panel.append(el("div", { class: "error", role: "alert", text: job.requestError }));
    actions.append(el("button", {
      class: "ghost", type: "button", text: "重试查询",
      onclick: async () => {
        const latest = workspaceJobs.get(job.statusUrl) || job;
        rememberJob({ ...latest, requestError: "" });
        jobPoller.sync();
      },
    }));
  }
  if (["failed", "timed_out", "interrupted"].includes(job.state)) actions.append(el("button", {
    class: "ghost", type: "button", text: "在对话中处理",
    onclick: () => useInChat(`请检查作业${job.jobId}的状态与日志，说明失败原因并给出恢复方案；再次执行前先确认。`),
  }));
  if (["failed", "unconfirmed"].includes(sync.state)) actions.append(syncRecoveryButton(`作业${job.jobId}`));
  if (actions.childNodes.length) panel.append(actions);
  const logs = el("details", { class: "job-logs", open: !!block.logsOpen });
  logs.addEventListener("toggle", () => { block.logsOpen = logs.open; });
  logs.append(el("summary", { text: "作业日志" }));
  for (const key of ["stdout", "stderr"]) logs.append(el("div", { class: "small muted", text: key }), el("pre", { text: job[key] || "（暂无输出）" }));
  if (job.error) logs.append(el("pre", { text: pretty(job.error) }));
  panel.append(logs);
}
function toolCardFor(block) {
  const details = el("details", { class: "tool-card", dataset: { state: block.state || "done" } });
  const summary = el("summary", {});
  const name = el("span", { class: "tool-name", text: block.name || "工具" });
  const stateText = el("span", { class: "tool-state" });
  const syncText = el("span", { class: "job-storage-state", hidden: true });
  summary.append(name, el("span", { class: "job-summary-states" }, [stateText, syncText]));
  const body = el("div", { class: "stack" });
  const args = el("pre", { text: pretty(block.args) });
  const result = el("pre", {});
  const resultLabel = el("div", { class: "small muted", text: "结果" });
  const jobNode = el("div", { class: "workspace-job stack", hidden: true });
  details.open = !!block.open;
  details.addEventListener("toggle", () => { block.open = details.open; });
  body.append(jobNode, el("div", { class: "small muted", text: "参数" }), args, resultLabel, result);
  details.append(summary, body);
  block.node = details;
  block.summary = summary;
  block.stateText = stateText;
  block.syncText = syncText;
  block.resultNode = result;
  block.resultLabel = resultLabel;
  block.jobNode = jobNode;
  attachJob(block);
  applyToolState(block);
  return details;
}
function applyToolState(block) {
  if (!block.node) return;
  const job = block.job;
  block.node.dataset.state = job ? job.state === "running" ? "running" : job.state === "succeeded" ? "done" : "failed" : block.state || "done";
  clear(block.stateText);
  const sync = storageForBlock(block);
  block.syncText.hidden = !sync.visible;
  block.syncText.textContent = sync.label;
  block.syncText.dataset.s = sync.state;
  if (job) block.stateText.textContent = job.state === "succeeded" && sync.visible ? "计算完成" : JOB_LABELS[job.state];
  else if (block.state === "running") {
    block.stateText.append(el("span", { class: "spinner" }), document.createTextNode("执行中"));
  } else if (block.state === "failed") block.stateText.textContent = "失败";
  else block.stateText.textContent = sync.state === "unconfirmed" ? "本地操作完成" : "完成";
  block.resultNode.hidden = block.resultLabel.hidden = !!job;
  drawWorkspaceJob(block);
  if (block.result !== undefined && block.resultNode)
    block.resultNode.textContent = pretty(block.result);
  else if (block.error && block.resultNode) block.resultNode.textContent = JSON.stringify(block.error, null, 2);
}
/** 写入类工具执行前的确认卡片：默认不执行，必须由人点允许。 */
function confirmCardFor(block) {
  const node = el("div", { class: "confirm-card" });
  node.append(
    el("h3", { text: "确认操作" }),
    el("div", { class: "small", text: typeof block.risk === "string" && block.risk.trim() ? block.risk : "此操作会改动校园数据。" }),
    el("div", { class: "tool-name", text: block.name }),
    el("pre", { text: pretty(block.args) }),
  );
  const actions = el("div", { class: "confirm-actions" });
  const allowBtn = el("button", { class: "primary", type: "button", text: "允许执行" });
  const denyBtn = el("button", { class: "ghost danger", type: "button", text: "拒绝" });
  const decide = async (allow) => {
    if (block.decided) return;
    block.decided = true;
    allowBtn.disabled = true;
    denyBtn.disabled = true;
    try {
      await api(`/api/chat/${state.sessionId}/confirm`, {
        method: "POST",
        body: { callId: block.callId, allow },
      });
      node.append(el("div", { class: "small muted", text: allow ? "已允许，继续执行…" : "已拒绝，本次不会执行。" }));
    } catch (e) {
      toast(e.message);
      node.append(el("div", { class: "small", text: `提交失败：${e.message}` }));
    }
  };
  allowBtn.addEventListener("click", () => decide(true));
  denyBtn.addEventListener("click", () => decide(false));
  actions.append(allowBtn, denyBtn);
  node.append(actions);
  block.node = node;
  return node;
}
function pretty(value) {
  if (typeof value === "string") {
    try {
      return JSON.stringify(JSON.parse(value), null, 2);
    } catch {
      return value;
    }
  }
  try {
    return JSON.stringify(value ?? {}, null, 2);
  } catch {
    return String(value);
  }
}
function homeIcon(name) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  svg.classList.add("home-icon");
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", ICON_PATHS[name] || ICON_PATHS.plus);
  svg.append(path);
  return svg;
}
function syncChatLayout() {
  const chat = document.querySelector(".chat");
  if (!chat) return;
  const empty = String(homeIsEmpty(state.messages, state.busy));
  if (chat.dataset.empty === empty) return;
  chat.dataset.empty = empty;
  const input = $("#composer");
  if (input) autoGrow(input);
}
function activateHomeAction(id, input) {
  const action = getHomeAction(id);
  if (!action) return;
  for (const popover of document.querySelectorAll(".composer-popover[open]")) popover.open = false;
  if (action.view) { state.view = action.view; render(); return; }
  const draft = input.value.trim();
  input.value = draft ? draft + "\n\n" + action.prompt : action.prompt;
  state.chatDraft = input.value;
  autoGrow(input);
  input.focus();
  input.setSelectionRange(input.value.length, input.value.length);
}
function composerAddMenu(input) {
  const menu = el("div", { class: "composer-popover-body add-actions" });
  for (const action of ADD_ACTIONS) menu.append(el("button", {
    type: "button", class: "add-action", onclick: () => activateHomeAction(action.id, input),
  }, [homeIcon(action.icon), el("span", { text: action.label })]));
  return el("details", { class: "composer-popover add-menu" }, [
    el("summary", { "aria-label": "添加内容", title: "添加内容" }, [homeIcon("plus")]), menu,
  ]);
}
function chatView() {
  const wrap = el("div", { class: "stack chat", dataset: { empty: String(homeIsEmpty(state.messages, state.busy)) } });
  const hero = el("div", { class: "chat-home" }, [
    el("div", { class: "home-eyebrow", text: "校园工作台" }),
    el("h2", { class: "home-title" }, [el("span", { text: "今天，" }), el("span", { text: "想完成什么？" })]),
  ]);
  const messages = el("div", { class: "messages", id: "messages", role: "log", "aria-live": "polite", "aria-relevant": "additions text", "aria-label": "对话内容" });
  messages.dataset.followTail = "true";
  messages.addEventListener("scroll", () => trackTail(messages));
  const textarea = el("textarea", { id: "composer", rows: 1, value: state.chatDraft, placeholder: "向校园助手提问…", "aria-label": "消息", "aria-keyshortcuts": "Enter Shift+Enter" });
  const sendButton = el("button", { id: "chat-send", class: "primary composer-send", type: "button", "aria-label": "发送", title: "发送" }, [homeIcon("send")]);
  const stopButton = el("button", { id: "chat-stop", class: "ghost danger composer-stop", type: "button", "aria-label": "停止", title: "停止", hidden: true }, [homeIcon("stop")]);
  const actions = el("div", { class: "composer-actions" }, [composerAddMenu(textarea), workspaceStorageSummary()]);
  const submit = el("div", { class: "composer-submit" }, [sendButton, stopButton]);
  const footer = el("div", { class: "composer-footer" }, [actions, modelPicker("chat-model", true), submit]);
  const composer = el("div", { class: "composer" }, [textarea, footer]);
  const quick = el("div", { class: "home-shortcuts", role: "group", "aria-label": "常用指令" });
  for (const action of HOME_ACTIONS) quick.append(el("button", {
    class: "home-shortcut", type: "button", dataset: { action: action.id }, onclick: () => activateHomeAction(action.id, textarea),
  }, [homeIcon(action.icon), el("span", { text: action.label })]));
  const dock = el("div", { class: "chat-dock" }, [composer]);
  wrap.append(hero, messages, dock, quick);
  for (const block of state.messages) messages.append(blockNode(block));
  const send = async () => {
    const text = textarea.value.trim();
    if (!text || state.busy || state.modelSaving || state.modelsLoading || !state.selectedModel) return;
    textarea.value = "";
    state.chatDraft = "";
    autoGrow(textarea);
    await sendTurn(text);
  };
  sendButton.addEventListener("click", send);
  textarea.addEventListener("input", () => { state.chatDraft = textarea.value; autoGrow(textarea); });
  textarea.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void send(); }
  });
  stopButton.addEventListener("click", async () => {
    if (!state.sessionId) return;
    try { await api("/api/chat/" + state.sessionId + "/abort", { method: "POST" }); } catch (e) { toast(e.message); }
  });
  if (state.busy) { sendButton.disabled = true; stopButton.hidden = false; }
  return wrap;
}
function autoGrow(textarea) {
  textarea.style.height = "auto";
  textarea.style.height = Math.min(textarea.scrollHeight, 160) + "px";
}
/** 只负责把一个块变成节点；不碰文档，历史消息渲染时容器可能还没挂到页面。 */
function blockNode(block) {
  if (block.kind === "reasoning") return reasoningFor(block);
  if (block.kind === "tool") return toolCardFor(block);
  if (block.kind === "confirm") return confirmCardFor(block);
  if (block.kind === "error")
    return el("div", { class: "bubble err", text: (block.code ? `[${block.code}] ` : "") + block.message });
  if (block.kind === "notice") {
    const node = el("div", { class: "bubble notice", text: block.message });
    block.node = node;
    return node;
  }
  return bubbleFor(block);
}
function appendBlock(block) {
  const container = $("#messages");
  if (!container) return null;
  const node = blockNode(block);
  container.append(node);
  scrollIfNearBottom(container);
  return node;
}
function trackTail(container) {
  container.dataset.followTail = String(container.scrollHeight - container.scrollTop - container.clientHeight < 120);
}
function scrollIfNearBottom(container = $("#messages")) {
  if (container && container.dataset.followTail !== "false") container.scrollTop = container.scrollHeight;
}
async function sendTurn(text) {
  state.busy = true;
  syncModelPickers();
  const container = $("#messages");
  if (container) container.dataset.followTail = "true";
  const userBlock = { kind: "user", text };
  state.messages.push(userBlock);
  appendBlock(userBlock);
  let assistant = null;
  let reasoning = null;
  let frame = 0;
  let completed = false;
  const flush = () => {
    frame = 0;
    if (assistant) setBubbleText(assistant, assistant.text);
    if (reasoning) updateReasoning(reasoning);
    scrollIfNearBottom();
  };
  const schedule = () => { if (!frame) frame = requestAnimationFrame(flush); };
  const ensureAssistant = () => {
    if (assistant) return;
    assistant = { kind: "assistant", text: "" };
    state.messages.push(assistant);
    appendBlock(assistant);
  };
  const ensureReasoning = () => {
    if (reasoning) return;
    reasoning = { kind: "reasoning", text: "", status: "streaming" };
    const index = assistant ? state.messages.indexOf(assistant) : -1;
    if (index < 0) state.messages.push(reasoning);
    else state.messages.splice(index, 0, reasoning);
    const node = appendBlock(reasoning);
    if (node && assistant?.node?.parentNode === node.parentNode) assistant.node.before(node);
  };
  const finishStep = (status = "done") => {
    if (frame) cancelAnimationFrame(frame);
    if (reasoning) reasoning.status = status;
    if (assistant) assistant.done = true;
    flush();
    assistant = null;
    reasoning = null;
  };
  const addStatus = block => { state.messages.push(block); appendBlock(block); };
  state.controller = new AbortController();
  try {
    const headers = { "content-type": "application/json" };
    if (state.token) headers.authorization = "Bearer " + state.token;
    const response = await fetch(endpoint("/api/chat"), {
      method: "POST", headers,
      body: JSON.stringify({ text, sessionId: state.sessionId || undefined, model: state.selectedModel || undefined }),
      signal: state.controller.signal,
    });
    if (!response.ok || !response.body) {
      const data = await response.json().catch(() => ({}));
      throw Object.assign(new Error(data?.error?.message || `对话失败（HTTP ${response.status}）`), { code: data?.error?.code });
    }
    for await (const { event, payload } of readChatEvents(response.body)) {
      switch (event) {
        case "ready":
          state.sessionId = payload.sessionId;
          break;
        case "token":
          if (typeof payload.text !== "string") break;
          ensureAssistant();
          assistant.text += payload.text;
          if (reasoning) reasoning.status = "done";
          schedule();
          break;
        case "reasoning":
          if (typeof payload.text !== "string" || !payload.text) break;
          ensureReasoning();
          reasoning.text += payload.text;
          reasoning.status = "streaming";
          schedule();
          break;
        case "message":
          if (payload.role !== "assistant") break;
          if (payload.reasoning) { ensureReasoning(); reasoning.text = payload.reasoning; }
          if (payload.content) { ensureAssistant(); assistant.text = payload.content; }
          finishStep(payload.aborted ? "stopped" : payload.interrupted ? "error" : "done");
          break;
        case "tool": {
          if (payload.phase === "start") {
            const card = { kind: "tool", name: payload.name, args: payload.args, state: "running" };
            state.messages.push(card);
            appendBlock(card);
          } else {
            const card = [...state.messages].reverse().find(b => b.kind === "tool" && b.name === payload.name && b.state === "running");
            if (card) {
              card.state = payload.ok ? "done" : "failed";
              card.result = payload.ok ? payload.result : undefined;
              card.error = payload.ok ? undefined : payload.error;
              attachJob(card, true);
              applyToolState(card);
              jobPoller.sync();
              if (["workspace_initialize", "workspace_sync"].includes(card.name)) void loadWorkspaceStorage();
            }
          }
          scrollIfNearBottom();
          break;
        }
        case "confirm": {
          const card = { kind: "confirm", callId: payload.callId, name: payload.name, args: payload.args, risk: payload.risk };
          state.messages.push(card);
          appendBlock(card);
          break;
        }
        case "notice":
          addStatus({ kind: "notice", message: payload.message || payload.code });
          break;
        case "error":
          finishStep("error");
          addStatus({ kind: "error", code: payload.code, message: payload.message || "本轮失败。" });
          break;
        case "done":
          state.sessionId = payload.sessionId || state.sessionId;
          finishStep(payload.aborted ? "stopped" : "done");
          completed = true;
          break;
      }
    }
    if (!completed) throw Object.assign(new Error("连接中断，已保留收到的内容，请重试。"), { code: "STREAM_INTERRUPTED" });
  } catch (e) {
    finishStep(e.name === "AbortError" ? "stopped" : "error");
    if (e.name !== "AbortError") addStatus({ kind: "error", code: e.code, message: e.message || "对话中断。" });
  } finally {
    finishStep();
    state.busy = false;
    state.controller = null;
    syncModelPickers();
    scrollIfNearBottom();
    void loadSessions();
  }
}
/* ---------------- 其它视图 ---------------- */
function sessionsView() {
  const wrap = el("div", { class: "stack sessions-view", "aria-busy": "false" });
  wrap.append(
    el("div", { class: "row between" }, [
      el("h2", { text: "会话" }),
      el("button", {
        class: "ghost",
        type: "button",
        text: "新对话",
        disabled: state.busy,
        onclick: startNewConversation,
      }),
    ]),
  );
  const search = el("input", { type: "search", placeholder: "搜索会话标题…", "aria-label": "搜索会话" });
  const list = el("div", { class: "list" });
  wrap.append(search, list);
  const draw = () => {
    clear(list);
    const keyword = search.value.trim().toLowerCase();
    const matched = state.sessions.filter(
      (session) => !keyword || String(session.title || "").toLowerCase().includes(keyword),
    );
    if (!matched.length) {
      list.append(
        el("div", { class: "empty", text: keyword ? "没有匹配的会话。" : "还没有历史会话。" }),
      );
      return;
    }
    for (const session of matched) list.append(sessionRow(session));
  };
  search.addEventListener("input", draw);
  wrap.updateSessions = () => {
    if (!list.querySelector(".session-row > input")) draw();
  };
  draw();
  return wrap;
}
function sessionRow(session) {
  const row = el("div", { class: "session-row" });
  const open = el("button", { class: "item", type: "button" }, [
    el("span", { class: "grow stack" }, [
      el("span", { class: "item-title", text: session.title || "未命名对话" }),
      el("span", {
        class: "small muted",
        text: new Date(session.updatedAt).toLocaleString() + " · " + session.messageCount + " 条",
      }),
    ]),
  ]);
  open.addEventListener("click", event => openSavedSession(session.id, event.currentTarget));
  const startRename = () => {
    clear(row);
    const input = el("input", {
      type: "text",
      value: session.title || "",
      maxlength: "80",
      "aria-label": "会话标题",
    });
    const save = el("button", {
      class: "primary",
      type: "button",
      text: "保存",
      onclick: async () => {
        try {
          await api("/api/sessions/" + session.id, { method: "PATCH", body: { title: input.value } });
          await loadSessions();
          render();
        } catch (e) {
          toast(e.message);
        }
      },
    });
    const cancel = el("button", { class: "ghost", type: "button", text: "取消", onclick: () => render() });
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") void save.click();
      if (event.key === "Escape") cancel.click();
    });
    row.append(input, save, cancel);
    input.focus();
    input.select();
  };
  const rename = el("button", {
    class: "ghost",
    type: "button",
    text: "重命名",
    onclick: (event) => {
      event.stopPropagation();
      startRename();
    },
  });
  const remove = el("button", {
    class: "ghost danger",
    type: "button",
    text: "删除",
    onclick: async (event) => {
      event.stopPropagation();
      try {
        await api("/api/sessions/" + session.id, { method: "DELETE" });
        if (state.sessionId === session.id) {
          state.sessionId = null;
          state.messages = [];
        }
        await loadSessions();
        render();
      } catch (e) {
        toast(e.message);
      }
    },
  });
  row.append(open, rename, remove);
  return row;
}
function updateAuthPanels() {
  for (const panel of document.querySelectorAll(".auth-panel")) panel.draw();
}
async function verifyAuthentication() {
  if (state.authChecking) return;
  state.authChecking = true;
  updateAuthPanels();
  try {
    const data = await api("/api/auth/status");
    if (!data.services || typeof data.services !== "object") throw new Error("认证状态响应无效，请重试核验。");
    state.meta = { ...state.meta, services: data.services };
    state.authError = "";
    state.authNotices = {};
    await loadWorkspaceStorage();
  } catch (error) { state.authError = "核验失败：" + error.message; }
  finally { state.authChecking = false; updateAuthPanels(); }
}
async function openLogin(name) {
  if (state.authLoginBusy) return;
  state.authLoginBusy = name;
  delete state.authNotices[name];
  updateAuthPanels();
  try {
    await api("/api/auth/login", { method: "POST", body: { service: name } });
    state.meta = { ...state.meta, services: { ...state.meta?.services, [name]: { ...state.meta?.services?.[name], state: "unverified", verified: false } } };
    state.authNotices[name] = { text: "登录窗口已打开，完成后请点击“核验登录状态”。" };
    if (name === "cloud") { state.workspaceStorageError = "云盘登录窗口已打开，请重新核验工作区。"; updateStoragePanels(); }
  } catch (error) { state.authNotices[name] = { error: true, text: "登录窗口未打开：" + error.message }; }
  finally { state.authLoginBusy = ""; updateAuthPanels(); }
}
function servicesView() {
  const wrap = el("div", { class: "stack" });
  const panel = el("div", { class: "stack auth-panel" });
  const labels = { learnx: "网络学堂", cloud: "清华云盘", hetang: "荷塘雨课堂", madmodel: "MadModel模型" };
  panel.draw = () => {
    clear(panel);
    panel.append(el("div", { class: "auth-header" }, [
      el("h2", { text: "服务状态" }),
      el("button", { class: "ghost", type: "button", text: state.authChecking ? "核验中…" : "核验登录状态", disabled: state.authChecking, onclick: verifyAuthentication }),
    ]));
    if (state.authError) panel.append(el("div", { class: "error", role: "alert", text: state.authError }));
    for (const [name, label] of Object.entries(labels)) {
      const info = authPresentation(state.meta?.services?.[name], { checking: state.authChecking, stale: !!state.authError });
      const row = el("section", { class: "auth-service", dataset: { service: name } }, [
        el("div", { class: "auth-service-main" }, [el("span", { class: "item-title", text: label }), el("span", { class: "state", dataset: { s: info.state }, text: info.label })]),
        el("button", { class: "ghost", type: "button", text: state.authLoginBusy === name ? "打开中…" : "登录", disabled: !!state.authLoginBusy || state.authChecking, onclick: () => openLogin(name) }),
      ]);
      const notice = state.authNotices[name];
      if (notice) row.append(el("div", { class: "auth-notice " + (notice.error ? "error" : "small"), role: notice.error ? "alert" : "status", text: notice.text }));
      const record = el("details", { class: "auth-evidence" }, [el("summary", { text: "核验记录" })]);
      if (info.checkedAt) record.append(el("div", { class: "small", text: "核验时间：" + new Date(info.checkedAt).toLocaleString() }));
      if (info.source) record.append(el("div", { class: "small", text: "来源：" + info.source }));
      if (info.code) record.append(el("div", { class: "small", text: "状态码：" + info.code }));
      if (!info.checkedAt && !info.source && !info.code) record.append(el("div", { class: "small", text: "暂无受保护接口核验记录。" }));
      row.append(record);
      panel.append(row);
    }
  };
  panel.draw();
  wrap.append(panel, keepAliveCard());
  return wrap;
}
const SERVICE_LABEL = { learnx: "网络学堂", cloud: "云盘", hetang: "雨课堂", madmodel: "MadModel" };
function keepAliveCard() {
  const card = el("div", { class: "card stack" }, [el("h3", { text: "会话保活自检" })]);
  const body = el("div", { class: "stack" });
  card.append(body);
  const draw = (data) => {
    clear(body);
    const minutes = Math.round((data.intervalMs || 0) / 60000);
    body.append(
      el("div", {
        class: "muted small",
        text: data.enabled
          ? `每 ${minutes} 分钟自检一次${data.restoreExpired ? "，过期时自动尝试恢复" : "，只记录不恢复"}`
          : "自检已关闭",
      }),
    );
    if (data.lastRunAt)
      body.append(
        el("div", { class: "muted small", text: `上次执行：${new Date(data.lastRunAt).toLocaleString()}` }),
      );
    if (data.nextRunAt)
      body.append(
        el("div", { class: "muted small", text: `下次执行：${new Date(data.nextRunAt).toLocaleString()}` }),
      );
    const runButton = el("button", {
      class: "ghost",
      type: "button",
      text: data.running ? "自检中…" : "立即自检",
      disabled: !!data.running,
      onclick: async () => {
        runButton.disabled = true;
        runButton.textContent = "自检中…";
        try {
          draw(await api("/api/keepalive/run", { method: "POST", body: {} }));
          toast("自检已完成");
        } catch (e) {
          toast(e.message);
          runButton.disabled = false;
          runButton.textContent = "立即自检";
        }
      },
    });
    body.append(runButton);
    const history = data.history || [];
    if (!history.length) {
      body.append(el("div", { class: "empty", text: "还没有自检记录。" }));
      return;
    }
    const timeline = el("div", { class: "timeline" });
    for (const entry of history) timeline.append(timelineItem(entry));
    body.append(timeline);
  };
  api("/api/keepalive")
    .then(draw)
    .catch((e) => body.append(el("div", { class: "empty", text: e.message })));
  return card;
}
function timelineItem(entry) {
  const states = Object.entries(entry.services || {})
    .map(([name, value]) => `${SERVICE_LABEL[name] || name} ${authPresentation(entry.serviceEvidence?.[name] || value).label}`)
    .join(" · ");
  const trigger = { startup: "启动", timer: "定时", api: "手动" }[entry.trigger] || entry.trigger;
  const verified = Object.keys(entry.services || {}).length > 0 && Object.keys(entry.services).every(name => authPresentation(entry.serviceEvidence?.[name]).verified);
  const item = el("div", { class: "timeline-item", dataset: { ok: entry.ok !== false && verified ? "good" : "bad" } }, [
    el("div", {
      class: "timeline-time",
      text: `${new Date(entry.at).toLocaleString()}（${sinceText(entry.at)}） · ${trigger} · ${entry.durationMs || 0}ms`,
      title: `接口返回 ${entry.at}（UTC ISO），此处按本机时区显示`,
    }),
    el("div", { class: "small", text: states || "无服务状态" }),
  ]);
  for (const action of entry.actions || [])
    item.append(
      el("div", {
        class: "small",
        text:
          action.action === "skipped"
            ? `${SERVICE_LABEL[action.service] || action.service} 过期但未恢复`
            : `${SERVICE_LABEL[action.service] || action.service} ${action.ok ? "恢复请求已完成" : `恢复尝试失败（${action.code || "未知原因"}）`}`,
      }),
    );
  return item;
}
function toolsView() {
  const wrap = el("div", { class: "stack" });
  const search = el("input", { type: "search", placeholder: "搜索工具名或描述…" });
  const list = el("div", { class: "list" });
  wrap.append(el("h2", { text: "工具" }), search, list);
  const draw = () => {
    clear(list);
    const keyword = search.value.trim().toLowerCase();
    const matched = state.tools.filter(
      (tool) =>
        !keyword ||
        tool.name.toLowerCase().includes(keyword) ||
        (tool.description || "").toLowerCase().includes(keyword),
    );
    if (!matched.length) return list.append(el("div", { class: "empty", text: "没有匹配的工具。" }));
    for (const tool of matched) list.append(toolItem(tool));
  };
  search.addEventListener("input", draw);
  if (!state.tools.length) {
    list.append(el("div", { class: "empty", text: "加载中…" }));
    api("/api/tools")
      .then((data) => {
        state.tools = data.tools || [];
        draw();
      })
      .catch((e) => {
        clear(list).append(el("div", { class: "empty", text: e.message }));
      });
  } else draw();
  return wrap;
}
function toolItem(tool) {
  const details = el("details", { class: "card" });
  const summary = el("summary", { class: "row between" });
  summary.append(
    el("span", { class: "tool-name", text: tool.name }),
    el("span", {
      class: "state",
      dataset: { s: tool.readOnly ? "ready" : "unknown" },
      text: tool.readOnly ? "只读" : "写入",
    }),
  );
  details.append(summary, el("p", { class: "small muted", text: tool.description || "无描述" }));
  const form = el("form", { class: "stack" });
  const properties = tool.inputSchema?.properties || {};
  const required = new Set(tool.inputSchema?.required || []);
  const inputs = {};
  for (const [key, schema] of Object.entries(properties)) {
    const label = el("label", { class: "field" });
    label.append(el("span", { text: key + (required.has(key) ? " *" : "") }));
    let input;
    if (Array.isArray(schema.enum))
      input = el(
        "select",
        {},
        [el("option", { value: "", text: "（不填）" })].concat(
          schema.enum.map((value) => el("option", { value, text: String(value) })),
        ),
      );
    else if (schema.type === "boolean") input = el("input", { type: "checkbox" });
    else if (schema.type === "number" || schema.type === "integer") input = el("input", { type: "number" });
    else if (schema.type === "array") input = el("input", { type: "text", placeholder: "多个值用英文逗号分隔" });
    else input = el("input", { type: "text", placeholder: schema.description || "" });
    inputs[key] = { input, schema };
    label.append(input);
    form.append(label);
  }
  const output = el("pre", {});
  const workspaceTool = tool.service === "workspace" || tool.name.startsWith("workspace_");
  const submit = el("button", { class: "primary", type: "submit", text: workspaceTool ? "在对话中使用" : "调用" });
  form.append(submit, output);
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const args = {};
    for (const [key, { input, schema }] of Object.entries(inputs)) {
      if (schema.type === "boolean") args[key] = input.checked;
      else if (input.value !== "") {
        if (schema.type === "number" || schema.type === "integer") args[key] = Number(input.value);
        else if (schema.type === "array") args[key] = input.value.split(",").map((v) => v.trim()).filter(Boolean);
        else args[key] = input.value;
      }
    }
    if (workspaceTool) {
      useInChat(`请使用工具${tool.name}，参数：${JSON.stringify(args)}。需要执行或导入时请先展示风险并等待我的确认。`);
      return;
    }
    submit.disabled = true;
    output.textContent = "调用中…";
    try {
      const data = await api(`/api/tools/${tool.name}`, { method: "POST", body: args });
      output.textContent = pretty(data.data ?? data);
    } catch (e) {
      output.textContent = `失败：${e.code || ""} ${e.message}`;
    } finally {
      submit.disabled = false;
    }
  });
  details.append(form);
  return details;
}
function pairLinkRow(label, value) {
  const input = el("input", { type: "text", readonly: true, value });
  const copy = el("button", {
    class: "ghost",
    type: "button",
    text: "复制",
    onclick: async () => {
      try {
        await navigator.clipboard.writeText(value);
        toast(`${label}链接已复制`);
      } catch {
        input.select();
        toast("已选中，请手动复制");
      }
    },
  });
  return el("div", { class: "stack", style: "gap:4px" }, [
    el("span", { class: "small muted", text: label }),
    el("div", { class: "row" }, [input, copy]),
  ]);
}
/** 相对时间：接口给的是 UTC ISO，展示按本机时区。 */
function sinceText(iso) {
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return "时间未知";
  const diff = Date.now() - then;
  if (diff < 0) return "刚刚";
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return "刚刚";
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  return `${Math.floor(hours / 24)} 天前`;
}
function residentCard() {
  const card = el("div", { class: "card stack" }, [el("h3", { text: "常驻运行" })]);
  const body = el("div", { class: "stack" });
  card.append(body);
  const draw = (data) => {
    clear(body);
    if (!data.supported) {
      body.append(el("div", { class: "small muted", text: "当前平台不支持自动安装" }));
      return;
    }
    const modeText = { "scheduled-task": "登录计划任务（推荐）", "startup-folder": "启动文件夹", none: "尚未安装" }[data.mode] || data.mode;
    body.append(
      el("div", { class: "row between" }, [
        el("span", { class: "small", text: `方式：${modeText}` }),
        el("span", { class: "state", dataset: { s: data.installed ? "ready" : "unknown" }, text: data.installed ? "已安装" : "未安装" }),
      ]),
    );
    if (data.task?.installed && data.task.state)
      body.append(el("div", { class: "small muted", text: `任务状态：${data.task.state}` }));
    if (data.startup?.entryPath)
      body.append(el("div", { class: "small muted", text: `启动项：${data.startup.installed ? data.startup.entryPath : "未创建"}` }));
    body.append(el("div", { class: "small muted", text: `日志：${data.logFile}` }));
    body.append(pairLinkRow("安装命令（在仓库目录执行）", data.installHint));
  };
  api("/api/service")
    .then(draw)
    .catch((e) => body.append(el("div", { class: "empty", text: e.message })));
  return card;
}
function helpPanel(diagnostics) {
  const usage = el("details", { class: "help-section" }, [
    el("summary", { text: "使用说明" }),
    el("div", { class: "stack" }, [
      el("p", { text: "Enter发送，Shift+Enter换行。切换模型自动保存；刷新列表保留草稿。" }),
      el("p", { text: "在服务页登录。密码和验证码在弹出的学校登录窗口中输入，完成后主动核验登录状态。" }),
      el("p", { text: "默认工作区位于云盘私有目录。计算状态与云盘同步分别显示；仅本地缓存或同步未确认，不代表云盘已保存。初始化和重试同步在对话中确认。" }),
      el("p", { text: "连接其它设备：生成配对码，在新设备输入服务器地址与配对码。配对码一次有效。" }),
      el("p", { text: "退出会清除本机连接令牌，再次连接需重新配对。" }),
    ]),
  ]);
  return el("details", { class: "card help-panel" }, [
    el("summary", { text: "帮助与说明" }), usage, diagnostics,
  ]);
}
function settingsSection(title, children, extra = "") {
  return el("section", { class: "settings-section " + extra }, [
    el("div", { class: "section-heading" }, [el("h3", { text: title })]),
    el("div", { class: "settings-content" }, children),
  ]);
}
function settingsView() {
  const wrap = el("div", { class: "stack settings-page" });
  wrap.append(el("h2", { text: "设置" }));
  const meta = state.meta || {};
  const diagnostics = el("details", { class: "help-section" }, [
    el("summary", { text: "诊断信息" }),
    el("div", { class: "stack" }, [
      el("h3", { text: "运行信息" }),
      el("div", { class: "small", text: `版本 ${meta.version || "-"} · 主机 ${meta.hostname || "-"}` }),
      el("div", { class: "small", text: `模型路由 ${meta.model?.route || "-"} · 模型 ${meta.model?.name || "自动"}` }),
      el("div", { class: "small", text: `账号 ${meta.account?.masked || "未绑定"}` }),
    ]),
  ]);
  const surface = el("div", { class: "settings-surface" });
  surface.append(workspaceStorageCard(), settingsSection("对话模型", [modelPicker("settings-model")]));
  const codeNode = el("output", { class: "pair-code", "aria-label": "一次性配对码", hidden: true });
  const validity = el("span", { class: "small muted", hidden: true });
  const errorNode = el("p", { class: "error inline-error", role: "alert", hidden: true });
  const linkBox = el("div", { class: "stack pair-links" });
  const inviteButton = el("button", {
    class: "primary", type: "button", text: "生成配对码",
    onclick: (event) => runAction(event.currentTarget, async () => {
      const data = await api("/api/pair/invite", { method: "POST" });
      codeNode.textContent = data.code; codeNode.hidden = false;
      validity.textContent = `${data.ttlSeconds}秒内有效 · 仅可使用一次`; validity.hidden = false;
      clear(linkBox);
      const urls = (data.lanUrls || []).length ? data.lanUrls : [location.origin];
      for (const url of urls) {
        const web = `${url.replace(/\/+$/, "")}/#code=${data.code}`;
        const app = `thucampus://pair?base=${encodeURIComponent(url)}&code=${data.code}`;
        linkBox.append(pairLinkRow("浏览器打开", web), pairLinkRow("App深链", app));
      }
      return data;
    }, { pending: "正在生成…", success: "配对码已生成", errorNode }),
  });
  surface.append(settingsSection("接入其它设备", [inviteButton, errorNode, codeNode, validity, linkBox]));
  diagnostics.append(residentCard(), el("a", { href: "/preview.html", target: "_blank", rel: "noreferrer", text: "设计目录" }));
  surface.append(settingsSection("帮助与诊断", [helpPanel(diagnostics)]));
  surface.append(settingsSection("设备安全", [el("button", {
    class: "ghost danger", type: "button", text: "清除本地令牌并退出",
    onclick: () => { forgetToken(); showPair("已清除本地令牌。"); },
  })], "settings-security"));
  wrap.append(surface);
  return wrap;
}

async function loadSessions() {
  try {
    const data = await api("/api/sessions");
    state.sessions = data.sessions || [];
    state.sessionsError = "";
  } catch {
    state.sessionsError = "会话刷新失败，请重试。";
  }
  refreshSidebar();
}
let sessionNavigation = 0;
function startNewConversation() {
  if (state.busy) { toast("请先停止当前对话。"); return; }
  sessionNavigation++;
  state.sessionId = null;
  state.messages = [];
  state.chatDraft = "";
  state.view = "chat";
  render();
  $("#composer")?.focus();
}
async function openSavedSession(id, button) {
  if (state.busy) { toast("请先停止当前对话。"); return; }
  const ticket = ++sessionNavigation;
  const displayedView = $("#view").firstElementChild;
  await runAction(button, async () => {
    const data = await api("/api/sessions/" + encodeURIComponent(id));
    if (ticket !== sessionNavigation || state.busy || $("#view").firstElementChild !== displayedView) return;
    state.sessionId = data.session.id;
    state.messages = blocksFromSession(data.session);
    state.view = "chat";
    render();
  }, { pending: "正在打开…" });
}
function refreshSidebar() {
  const list = $("#recent-list");
  if (!list) return;
  const sessions = recentSessions(state.sessions);
  $("#rail-new-chat").disabled = state.busy;
  $("#rail-recents").hidden = !sessions.length && !state.sessionsError;
  $("#recent-error").hidden = !state.sessionsError;
  $("#recent-error").textContent = state.sessionsError;
  $("#recent-retry").hidden = !state.sessionsError;
  clear(list);
  for (const session of sessions) list.append(el("button", {
    class: "recent-session", type: "button", text: session.title, title: session.title,
    disabled: state.busy, "aria-current": String(state.view === "chat" && state.sessionId === session.id),
    dataset: { sessionId: session.id },
    onclick: event => openSavedSession(session.id, event.currentTarget),
  }));
}
function initSidebar() {
  const storage = $("#rail-storage");
  storage.draw = () => {
    const info = currentStoragePresentation();
    storage.querySelector(".rail-storage-label").textContent = sidebarStorageLabel(info);
    storage.dataset.s = info.state;
  };
  storage.addEventListener("click", () => { state.view = "settings"; render(); });
  $("#rail-new-chat").addEventListener("click", startNewConversation);
  $("#recent-retry").addEventListener("click", loadSessions);
  storage.draw();
  refreshSidebar();
}

function render() {
  jobPoller.stop();
  const view = $("#view");
  view.dataset.view = state.view;
  $("#view-context").textContent = ({chat:"对话工作台",sessions:"会话记录",services:"连接与服务",tools:"工具目录",settings:"偏好设置"})[state.view] || "对话工作台";
  clear(view);
  for (const tab of document.querySelectorAll(".tab"))
    tab.setAttribute("aria-current", tab.dataset.view === state.view ? "page" : "false");
  const views = {
    chat: chatView,
    sessions: sessionsView,
    services: servicesView,
    tools: toolsView,
    settings: settingsView,
  };
  view.append((views[state.view] || chatView)());
  syncModelPickers();
  jobPoller.sync();
  if (state.view === "chat") {
    const scroller = $("#messages");
    scroller.scrollTop = scroller.scrollHeight;
  }
}
async function start() {
  initSidebar();
  document.addEventListener("click", event => {
    for (const popover of document.querySelectorAll(".composer-popover[open]")) if (!popover.contains(event.target)) popover.open = false;
  });
  document.addEventListener("keydown", event => {
    if (event.key !== "Escape") return;
    for (const popover of document.querySelectorAll(".composer-popover[open]")) { popover.open = false; popover.querySelector("summary").focus(); }
  });
  bootToken();
  document.addEventListener("visibilitychange", () => jobPoller.sync());
  window.addEventListener("pagehide", () => jobPoller.stop());
  for (const tab of document.querySelectorAll(".tab"))
    tab.addEventListener("click", () => {
      state.view = tab.dataset.view;
      render();
      // 只在切到会话页时取一次数据；不能让 render 自己触发加载，否则会自激。
      if (state.view === "sessions") {
        $("#view .sessions-view").setAttribute("aria-busy", "true");
        void loadSessions().then(() => {
          if (state.view !== "sessions") return;
          const panel = $("#view .sessions-view");
          panel?.updateSessions();
          panel?.setAttribute("aria-busy", "false");
        });
      }
    });
  const applyTheme = (mode) => {
    document.documentElement.dataset.theme = mode;
    try {
      localStorage.setItem("campus.theme", mode);
    } catch {}
    $("#theme-light").setAttribute("aria-pressed", String(mode === "light"));
    $("#theme-dark").setAttribute("aria-pressed", String(mode === "dark"));
  };
  $("#theme-light").addEventListener("click", () => applyTheme("light"));
  $("#theme-dark").addEventListener("click", () => applyTheme("dark"));
  applyTheme(document.documentElement.dataset.theme === "dark" ? "dark" : "light");
  $("#pair-submit").addEventListener("click", submitPair);
  $("#pair-code").addEventListener("keydown", (event) => {
    if (event.key === "Enter") void submitPair();
  });
  $("#refresh").addEventListener("click", (event) => runAction(event.currentTarget, async () => {
    const ok = await refreshMeta();
    if (!ok) throw new Error(state.authError || "状态刷新失败，请重试。");
    render();
  }, { pending: "", success: "状态已更新" }));
  if (!state.token) {
    const autoPair = !!state.deeplinkCode;
    showPair();
    if (autoPair) setTimeout(() => void submitPair(), 120);
    return;
  }
  const ok = await refreshMeta();
  if (!ok) return;
  $("#app").hidden = false;
  $("#pair").hidden = true;
  await loadSessions();
  render();
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => {});
}
start().catch((e) => {
  showPair("启动失败：" + (e?.message || "未知错误"));
});
