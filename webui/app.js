const STORAGE_TOKEN = "campus.app.token";
const STORAGE_BASE = "campus.app.base";
const state = {
  token: "",
  base: "",
  meta: null,
  view: "chat",
  messages: [],
  sessionId: null,
  busy: false,
  controller: null,
  tools: [],
  sessions: [],
  settings: null,
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
/** 最小安全 markdown：先当纯文本，再只识别围栏代码、行内代码与粗体。 */
function renderRich(text) {
  const fragment = document.createDocumentFragment();
  const blocks = String(text ?? "").split(/```/);
  blocks.forEach((block, index) => {
    if (index % 2 === 1) {
      const newline = block.indexOf("\n");
      fragment.append(el("pre", { text: newline < 0 ? block : block.slice(newline + 1) }));
      return;
    }
    const lines = block.split("\n");
    lines.forEach((line, lineIndex) => {
      if (lineIndex > 0) fragment.append(document.createTextNode("\n"));
      const parts = line.split(/(`[^`\n]+`|\*\*[^*\n]+\*\*)/g);
      for (const part of parts) {
        if (!part) continue;
        if (part.startsWith("`") && part.endsWith("`") && part.length > 2)
          fragment.append(el("code", { text: part.slice(1, -1) }));
        else if (part.startsWith("**") && part.endsWith("**") && part.length > 4)
          fragment.append(el("strong", { text: part.slice(2, -2) }));
        else fragment.append(document.createTextNode(part));
      }
    });
  });
  return fragment;
}
function endpoint(path) {
  return (state.base || "").replace(/\/+$/, "") + path;
}
async function api(path, { method = "GET", body } = {}) {
  const headers = {};
  if (body !== undefined) headers["content-type"] = "application/json";
  if (state.token) headers.authorization = "Bearer " + state.token;
  const response = await fetch(endpoint(path), {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
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
    $("#health-dot").className = "dot ok";
    $("#account").textContent = state.meta.account?.masked || state.meta.hostname || "";
    return true;
  } catch (e) {
    if (["AUTH_REQUIRED", "HTTP_401"].includes(e.code)) {
      showPair("令牌已失效，请重新配对。");
      return false;
    }
    $("#health-dot").className = "dot bad";
    toast(e.message);
    return false;
  }
}
/* ---------------- 对话 ---------------- */
function blocksFromSession(session) {
  const blocks = [];
  for (const message of session.messages || []) {
    if (message.role === "user") blocks.push({ kind: "user", text: message.content || "" });
    else if (message.role === "assistant") {
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
      if (last) last.result = parsed;
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
function toolCardFor(block) {
  const details = el("details", { class: "tool-card", dataset: { state: block.state || "done" } });
  const summary = el("summary", {});
  const name = el("span", { class: "tool-name", text: block.name || "工具" });
  const stateText = el("span", { class: "tool-state" });
  summary.append(name, stateText);
  const body = el("div", { class: "stack" });
  const args = el("pre", { text: pretty(block.args) });
  const result = el("pre", {});
  body.append(el("div", { class: "small muted", text: "参数" }), args, el("div", { class: "small muted", text: "结果" }), result);
  details.append(summary, body);
  block.node = details;
  block.summary = summary;
  block.stateText = stateText;
  block.resultNode = result;
  applyToolState(block);
  return details;
}
function applyToolState(block) {
  if (!block.node) return;
  block.node.dataset.state = block.state || "done";
  clear(block.stateText);
  if (block.state === "running") {
    block.stateText.append(el("span", { class: "spinner" }), document.createTextNode("执行中"));
  } else if (block.state === "failed") block.stateText.textContent = "失败";
  else block.stateText.textContent = "完成";
  if (block.result !== undefined && block.resultNode)
    block.resultNode.textContent = pretty(block.result);
  else if (block.error && block.resultNode) block.resultNode.textContent = JSON.stringify(block.error, null, 2);
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
const QUICK_ACTIONS = [
  ["未交作业", "列出本学期尚未提交的作业和截止时间，按截止时间排序"],
  ["更新课程", "把本学期所有课程增量更新到 D:\\\\网络学堂，按公告/作业/文件等专栏分类，并报告不完整的内容"],
  ["云盘根目录", "列出我清华云盘各资料库的根目录内容"],
  ["雨课堂课程", "列出我的荷塘雨课堂课程和最近课堂"],
  ["登录状态", "用状态工具检查网络学堂、清华云盘、荷塘雨课堂和 MadModel 的登录状态，逐条说明"],
];
function chatView() {
  const wrap = el("div", { class: "stack chat" });
  const messages = el("div", { class: "messages", id: "messages" });
  const textarea = el("textarea", {
    id: "composer",
    rows: 1,
    placeholder: "问我：把本学期课程更新到 D:\\网络学堂……（Enter 发送，Shift+Enter 换行）",
  });
  const sendButton = el("button", { class: "primary", type: "button", text: "发送" });
  const stopButton = el("button", { class: "ghost danger", type: "button", text: "停止", hidden: true });
  const composer = el("div", { class: "composer" }, [textarea, sendButton, stopButton]);
  const quick = el("div", { class: "quick", role: "group", "aria-label": "常用指令" });
  for (const [label, instruction] of QUICK_ACTIONS) {
    quick.append(
      el("button", {
        class: "chip-btn",
        type: "button",
        text: label,
        title: instruction,
        onclick: () => {
          textarea.value = instruction;
          autoGrow(textarea);
          textarea.focus();
          textarea.setSelectionRange(instruction.length, instruction.length);
        },
      }),
    );
  }
  wrap.append(messages, quick, composer);
  if (!state.messages.length && !state.sessionId) {
    messages.append(
      el("div", { class: "empty", text: "还没有对话。先点「服务」确认登录状态，再开始提问。" }),
    );
  }
  for (const block of state.messages) appendBlock(block);
  const send = async () => {
    const text = textarea.value.trim();
    if (!text || state.busy) return;
    textarea.value = "";
    autoGrow(textarea);
    await sendTurn(text, { messages, sendButton, stopButton, textarea });
  };
  sendButton.addEventListener("click", send);
  textarea.addEventListener("input", () => autoGrow(textarea));
  textarea.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void send();
    }
  });
  stopButton.addEventListener("click", async () => {
    if (!state.sessionId) return;
    try {
      await api(`/api/chat/${state.sessionId}/abort`, { method: "POST" });
    } catch (e) {
      toast(e.message);
    }
  });
  if (state.busy) {
    sendButton.disabled = true;
    stopButton.hidden = false;
  }
  return wrap;
}
function autoGrow(textarea) {
  textarea.style.height = "auto";
  textarea.style.height = Math.min(textarea.scrollHeight, 160) + "px";
}
function appendBlock(block) {
  const container = $("#messages");
  if (!container) return null;
  let node;
  if (block.kind === "tool") node = toolCardFor(block);
  else if (block.kind === "error") {
    node = el("div", { class: "bubble err", text: (block.code ? `[${block.code}] ` : "") + block.message });
  } else if (block.kind === "notice") {
    node = el("div", { class: "bubble notice", text: block.message });
    block.node = node;
  } else node = bubbleFor(block);
  container.append(node);
  return node;
}
function scrollIfNearBottom(container) {
  if (!container) return;
  const near = container.parentElement?.parentElement;
  const scroller = near ? document.querySelector(".view") : null;
  if (!scroller) return;
  const distance = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight;
  if (distance < 160) scroller.scrollTop = scroller.scrollHeight;
}
async function sendTurn(text, ui) {
  state.busy = true;
  ui.sendButton.disabled = true;
  ui.stopButton.hidden = false;
  const empty = $("#messages .empty");
  if (empty) empty.remove();
  const userBlock = { kind: "user", text };
  state.messages.push(userBlock);
  appendBlock(userBlock);
  let assistant = null;
  let pending = "";
  let frame = 0;
  const flush = () => {
    frame = 0;
    if (!assistant) return;
    setBubbleText(assistant, assistant.text);
    scrollIfNearBottom();
  };
  state.controller = new AbortController();
  try {
    const headers = { "content-type": "application/json" };
    if (state.token) headers.authorization = "Bearer " + state.token;
    const response = await fetch(endpoint("/api/chat"), {
      method: "POST",
      headers,
      body: JSON.stringify({ text, sessionId: state.sessionId || undefined }),
      signal: state.controller.signal,
    });
    if (!response.ok || !response.body) {
      const data = await response.json().catch(() => ({}));
      throw Object.assign(new Error(data?.error?.message || `对话失败（HTTP ${response.status}）`), {
        code: data?.error?.code,
      });
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let index;
      while ((index = buffer.indexOf("\n\n")) >= 0) {
        const raw = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        let event = "message";
        const data = [];
        for (const line of raw.split("\n")) {
          if (line.startsWith("event:")) event = line.slice(6).trim();
          else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
        }
        if (!data.length) continue;
        let payload;
        try {
          payload = JSON.parse(data.join("\n"));
        } catch {
          continue;
        }
        if (event === "ready") {
          state.sessionId = payload.sessionId;
        } else if (event === "token") {
          if (!assistant) {
            assistant = { kind: "assistant", text: "" };
            state.messages.push(assistant);
            appendBlock(assistant);
          }
          pending = "";
          assistant.text += payload.text || "";
          if (!frame) frame = requestAnimationFrame(flush);
        } else if (event === "reasoning") {
          /* 推理增量不单独渲染，避免干扰阅读 */
        } else if (event === "message") {
          if (payload.role === "assistant" && typeof payload.content === "string" && payload.content && !assistant?.text) {
            assistant = { kind: "assistant", text: payload.content };
            state.messages.push(assistant);
            appendBlock(assistant);
          }
        } else if (event === "tool") {
          if (payload.phase === "start") {
            const card = { kind: "tool", name: payload.name, args: payload.args, state: "running" };
            state.messages.push(card);
            appendBlock(card);
          } else {
            const card = [...state.messages].reverse().find((b) => b.kind === "tool" && b.name === payload.name && b.state === "running");
            if (card) {
              card.state = payload.ok ? "done" : "failed";
              card.result = payload.ok ? payload.result : undefined;
              card.error = payload.ok ? undefined : payload.error;
              applyToolState(card);
            }
          }
          scrollIfNearBottom();
        } else if (event === "notice") {
          appendBlock({ kind: "notice", message: payload.message || payload.code });
        } else if (event === "error") {
          appendBlock({ kind: "error", code: payload.code, message: payload.message || "本轮失败。" });
        } else if (event === "done") {
          state.sessionId = payload.sessionId || state.sessionId;
          assistant = null;
        }
      }
    }
    if (frame) cancelAnimationFrame(frame);
  } catch (e) {
    if (e.name !== "AbortError")
      appendBlock({ kind: "error", code: e.code, message: e.message || "对话中断。" });
  } finally {
    state.busy = false;
    state.controller = null;
    ui.sendButton.disabled = false;
    ui.stopButton.hidden = true;
    scrollIfNearBottom();
    void loadSessions();
  }
}
/* ---------------- 其它视图 ---------------- */
function sessionsView() {
  const wrap = el("div", { class: "stack" });
  wrap.append(
    el("div", { class: "row between" }, [
      el("h2", { text: "会话" }),
      el("button", {
        class: "ghost",
        type: "button",
        text: "新对话",
        onclick: () => {
          state.sessionId = null;
          state.messages = [];
          state.view = "chat";
          render();
        },
      }),
    ]),
  );
  if (!state.sessions.length) wrap.append(el("div", { class: "empty", text: "还没有历史会话。" }));
  for (const session of state.sessions) {
    const open = el("button", { class: "item", type: "button" }, [
      el("div", { class: "grow stack", style: "gap:2px" }, [
        el("div", { class: "item-title", text: session.title || "未命名对话" }),
        el("div", {
          class: "small muted",
          text: `${new Date(session.updatedAt).toLocaleString()} · ${session.messageCount} 条`,
        }),
      ]),
    ]);
    open.addEventListener("click", async () => {
      try {
        const data = await api(`/api/sessions/${session.id}`);
        state.sessionId = data.session.id;
        state.messages = blocksFromSession(data.session);
        state.view = "chat";
        render();
      } catch (e) {
        toast(e.message);
      }
    });
    const remove = el("button", {
      class: "ghost danger",
      type: "button",
      text: "删除",
      onclick: async (event) => {
        event.stopPropagation();
        try {
          await api(`/api/sessions/${session.id}`, { method: "DELETE" });
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
    wrap.append(el("div", { class: "row" }, [el("div", { class: "grow" }, [open]), remove]));
  }
  return wrap;
}
function servicesView() {
  const wrap = el("div", { class: "stack" });
  const labels = { learnx: "网络学堂", cloud: "清华云盘", hetang: "荷塘雨课堂", madmodel: "MadModel 模型" };
  const texts = { ready: "已就绪", "login-required": "需要登录", expired: "会话过期", unknown: "未知" };
  wrap.append(el("h2", { text: "服务状态" }));
  const services = state.meta?.services || {};
  for (const [name, info] of Object.entries(services)) {
    const row = el("div", { class: "item" }, [
      el("div", { class: "grow stack", style: "gap:2px" }, [
        el("div", { class: "item-title", text: labels[name] || name }),
        el("div", { class: "small muted", text: info.code || "" }),
      ]),
      el("span", { class: "state", dataset: { s: info.state }, text: texts[info.state] || info.state }),
    ]);
    if (["learnx", "cloud", "hetang", "madmodel"].includes(name))
      row.append(
        el("button", {
          class: "ghost",
          type: "button",
          text: "登录",
          onclick: async (event) => {
            const button = event.currentTarget;
            button.disabled = true;
            button.textContent = "启动中…";
            try {
              const data = await api("/api/auth/login", { method: "POST", body: { service: name } });
              toast("已打开独立浏览器窗口，请在本机完成学校登录。");
              await pollJob(data.jobId);
              await refreshMeta();
              render();
            } catch (e) {
              toast(e.message);
            } finally {
              button.disabled = false;
              button.textContent = "登录";
            }
          },
        }),
      );
    wrap.append(row);
  }
  wrap.append(
    el("p", {
      class: "muted small",
      text: "登录在本机独立浏览器窗口完成，密码与验证码只由你本人输入；应用不读取、不保存密码。",
    }),
  );
  return wrap;
}
async function pollJob(jobId) {
  if (!jobId) return;
  for (let i = 0; i < 90; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    try {
      const data = await api(`/api/jobs/${encodeURIComponent(jobId)}`);
      if (data.found && /complete|done|success/i.test(JSON.stringify(data.job?.state || data.job?.status || "")))
        return data.job;
    } catch {
      return null;
    }
  }
  return null;
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
  const submit = el("button", { class: "primary", type: "submit", text: "调用" });
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
function settingsView() {
  const wrap = el("div", { class: "stack" });
  wrap.append(el("h2", { text: "设置" }));
  const meta = state.meta || {};
  wrap.append(
    el("div", { class: "card stack" }, [
      el("h3", { text: "运行信息" }),
      el("div", { class: "small", text: `版本 ${meta.version || "-"} · 主机 ${meta.hostname || "-"}` }),
      el("div", { class: "small", text: `模型路由 ${meta.model?.route || "-"} · 模型 ${meta.model?.name || "自动"}` }),
      el("div", { class: "small", text: `账号 ${meta.account?.masked || "未绑定"}` }),
    ]),
  );
  const modelInput = el("input", { type: "text", placeholder: meta.model?.name || "自动选择" });
  const stepsInput = el("input", { type: "number", min: 1, max: 24 });
  const save = el("button", { class: "primary", type: "button", text: "保存设置" });
  const settingsCard = el("div", { class: "card stack" }, [el("h3", { text: "对话偏好" })]);
  settingsCard.append(
    (() => {
      const label = el("label", { class: "field" });
      label.append(el("span", { text: "模型名" }), modelInput);
      return label;
    })(),
    (() => {
      const label = el("label", { class: "field" });
      label.append(el("span", { text: "单轮最大工具步数（1–24）" }), stepsInput);
      return label;
    })(),
    save,
  );
  api("/api/settings")
    .then((data) => {
      state.settings = data.settings;
      modelInput.value = data.settings.modelName || "";
      stepsInput.value = data.settings.maxSteps ?? 12;
    })
    .catch(() => {});
  save.addEventListener("click", async () => {
    save.disabled = true;
    try {
      const data = await api("/api/settings", {
        method: "PUT",
        body: {
          modelName: modelInput.value.trim(),
          ...(stepsInput.value ? { maxSteps: Number(stepsInput.value) } : {}),
        },
      });
      state.settings = data.settings;
      toast("已保存");
    } catch (e) {
      toast(e.message);
    } finally {
      save.disabled = false;
    }
  });
  wrap.append(settingsCard);
  const codeNode = el("div", { class: "small muted", text: "" });
  const linkBox = el("div", { class: "stack", style: "gap:8px" });
  const inviteButton = el("button", {
    class: "ghost",
    type: "button",
    text: "生成配对码",
    onclick: async () => {
      try {
        const data = await api("/api/pair/invite", { method: "POST" });
        codeNode.textContent = `配对码 ${data.code}（${data.ttlSeconds} 秒内有效，一次性）`;
        clear(linkBox);
        const urls = (data.lanUrls || []).length ? data.lanUrls : [location.origin];
        for (const url of urls) {
          const web = `${url.replace(/\/+$/, "")}/#code=${data.code}`;
          const app = `thucampus://pair?base=${encodeURIComponent(url)}&code=${data.code}`;
          linkBox.append(pairLinkRow("浏览器打开", web), pairLinkRow("App 深链", app));
        }
      } catch (e) {
        toast(e.message);
      }
    },
  });
  wrap.append(
    el("div", { class: "card stack" }, [
      el("h3", { text: "接入其它设备" }),
      el("p", { class: "small muted", text: "在手机或另一台电脑的浏览器里打开本页地址，输入配对码即可共享同一份登录态。" }),
      inviteButton,
      codeNode,
      linkBox,
    ]),
  );
  wrap.append(
    el("div", { class: "card stack" }, [
      el("h3", { text: "安全" }),
      el("p", {
        class: "small muted",
        text: "设备令牌只保存在本机浏览器；服务端只存摘要。退出登录会清空本地令牌，需要在电脑上重新配对。",
      }),
      el("button", {
        class: "ghost danger",
        type: "button",
        text: "清除本地令牌并退出",
        onclick: () => {
          forgetToken();
          showPair("已清除本地令牌。");
        },
      }),
    ]),
  );
  return wrap;
}
async function loadSessions() {
  try {
    const data = await api("/api/sessions");
    state.sessions = data.sessions || [];
  } catch {
    state.sessions = [];
  }
}
function render() {
  const view = $("#view");
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
  if (state.view === "sessions") void loadSessions().then(() => {
    if (state.view === "sessions") render();
  });
  if (state.view === "chat") {
    const scroller = $("#view");
    scroller.scrollTop = scroller.scrollHeight;
  }
}
async function start() {
  bootToken();
  for (const tab of document.querySelectorAll(".tab"))
    tab.addEventListener("click", () => {
      state.view = tab.dataset.view;
      render();
    });
  $("#pair-submit").addEventListener("click", submitPair);
  $("#pair-code").addEventListener("keydown", (event) => {
    if (event.key === "Enter") void submitPair();
  });
  $("#refresh").addEventListener("click", async () => {
    await refreshMeta();
    render();
  });
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




