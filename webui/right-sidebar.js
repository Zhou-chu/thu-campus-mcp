import {
  applyOrder, clampWidth, filterArchived, moveId, readJson, remaining, toggleArchived, writeJson,
  ARCHIVE_KEY, LAYOUT_KEY, ORDER_KEY,
} from "./ddl-model.js";

const SVG = "http://www.w3.org/2000/svg";
const SPORTS_URL = "https://www.sports.tsinghua.edu.cn/venue/mobile/index.html#/";
const KINDS = {
  pending: { label: "待交作业", list: "pending" },
  ungraded: { label: "待批改", list: "ungraded" },
  sports: { label: "清华体育", external: true },
  art: { label: "掌上艺教", unavailable: true },
};
function icon(pathData) {
  const svg = document.createElementNS(SVG, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  const path = document.createElementNS(SVG, "path");
  path.setAttribute("d", pathData);
  svg.append(path);
  return svg;
}
function normalizeTabs(value) {
  const tabs = [];
  for (const kind of Array.isArray(value) ? value : []) if (KINDS[kind] && !tabs.includes(kind)) tabs.push(kind);
  return tabs.length ? tabs : ["pending"];
}
const dateText = value => {
  const ms = Date.parse(value || "");
  return Number.isFinite(ms) ? new Date(ms).toLocaleString("zh-CN", { hour12: false }) : "";
};

/**
 * 右侧可拖宽的多标签栏。标签页各自保留列表/详情/提交视图；
 * 归档与手工顺序只存本机浏览器，不冒充服务端状态。
 */
export function createRightSidebar({ el, api, toast, renderRich, uploadFile, storage = globalThis.localStorage, onResize = () => {}, canLoad = () => true }) {
  const saved = readJson(storage, LAYOUT_KEY, {});
  const dock = {
    open: typeof saved.open === "boolean" ? saved.open : (globalThis.innerWidth || 1280) >= 1100,
    width: clampWidth(saved.width ?? 380),
    tabs: normalizeTabs(saved.tabs),
    active: KINDS[saved.active] ? saved.active : "pending",
  };
  const archived = readJson(storage, ARCHIVE_KEY, {});
  const orders = readJson(storage, ORDER_KEY, {});
  const panels = new Map();
  let root, tabbar, body, grip, toggle;

  function panelOf(kind) {
    if (!panels.has(kind)) panels.set(kind, {
      mode: "list", loading: false, error: "", data: null, showArchived: false,
      detail: null, detailLoading: false, detailError: "",
      submit: null,
    });
    return panels.get(kind);
  }
  function saveLayout() {
    writeJson(storage, LAYOUT_KEY, { open: dock.open, width: dock.width, tabs: dock.tabs, active: dock.active });
  }
  function applyWidth() {
    root.style.setProperty("--rsidebar-width", dock.width + "px");
    grip?.setAttribute("aria-valuenow", String(dock.width));
    onResize();
  }
  let overlayOpen = false;
  let wasVisible = false;
  function visible() { return (globalThis.innerWidth || 1280) < 1100 ? overlayOpen : dock.open; }
  function applyVisibility() {
    const narrow = (globalThis.innerWidth || 1280) < 1100;
    document.body.dataset.sidebarMode = narrow ? "overlay" : "docked";
    const show = visible();
    document.body.dataset.sidebar = show ? "open" : "closed";
    toggle?.setAttribute("aria-expanded", String(show));
    applyWidth();
    if (show && !wasVisible) void refreshData(dock.active);
    wasVisible = show;
  }
  function setOpen(next) {
    if ((globalThis.innerWidth || 1280) < 1100) overlayOpen = next;
    else { dock.open = next; saveLayout(); }
    applyVisibility();
  }

  async function refreshData(kind, force = false) {
    const panel = panelOf(kind);
    if (!KINDS[kind]?.list || panel.loading || !canLoad()) return;
    panel.loading = true; panel.error = "";
    renderBody();
    try {
      panel.data = await api("/api/sidebar/assignments" + (force ? "?refresh=1" : ""));
    } catch (error) {
      panel.error = error.message || "作业列表读取失败。";
    } finally {
      panel.loading = false;
      if (root?.isConnected) renderBody();
    }
  }

  function itemRow(kind, item, overdue) {
    const time = remaining(item.deadlineMs);
    const state = kind === "ungraded" ? "已提交" : time.text;
    const row = el("li", { class: "ddl", dataset: { id: item.id, overdue: String(overdue) } }, [
      el("button", {
        class: "ddl-grip", type: "button", "aria-label": "拖动调整顺序", title: "按住拖动调整顺序",
        onpointerdown: event => beginReorder(kind, event),
      }, [icon("M9 6h.01M9 12h.01M9 18h.01M15 6h.01M15 12h.01M15 18h.01")]),
      el("div", { class: "ddl-main" }, [
        el("div", { class: "ddl-course", text: item.course }),
        el("div", { class: "ddl-title", text: item.title }),
        el("div", { class: "ddl-meta" }, [
          el("span", { class: "ddl-time", dataset: { s: overdue ? "expired" : "open" }, text: state }),
          item.submitTime ? el("span", { class: "ddl-time", text: "提交于 " + dateText(item.submitTime) }) : null,
          item.grade !== null && item.grade !== undefined ? el("span", { class: "ddl-time", text: "成绩 " + item.grade }) : null,
        ]),
      ]),
      el("div", { class: "ddl-actions" }, [
        el("button", { class: "ghost", type: "button", text: "归档", onclick: () => { archive(kind, item.id); } }),
        el("button", { class: "primary", type: "button", text: "详情", onclick: () => { void openDetail(kind, item); } }),
      ]),
    ]);
    return row;
  }

  function beginReorder(kind, event) {
    const row = event.currentTarget.closest(".ddl");
    const list = row?.parentElement;
    if (!row || !list) return;
    event.preventDefault();
    const ids = [...list.querySelectorAll(".ddl")].map(node => node.dataset.id);
    const from = ids.indexOf(row.dataset.id);
    let to = from;
    row.dataset.dragging = "true";
    const move = moveEvent => {
      for (const [index, node] of [...list.querySelectorAll(".ddl")].entries()) {
        const box = node.getBoundingClientRect();
        if (moveEvent.clientY >= box.top && moveEvent.clientY <= box.bottom) { to = index; return; }
      }
    };
    const finish = () => {
      document.removeEventListener("pointermove", move);
      document.removeEventListener("pointerup", finish);
      document.removeEventListener("pointercancel", finish);
      delete row.dataset.dragging;
      if (to === from || from < 0) return;
      orders[kind] = moveId(ids, from, to);
      writeJson(storage, ORDER_KEY, orders);
      renderBody();
    };
    document.addEventListener("pointermove", move);
    document.addEventListener("pointerup", finish);
    document.addEventListener("pointercancel", finish);
  }

  function archive(kind, id) {
    archived[kind] = toggleArchived(archived[kind], id);
    writeJson(storage, ARCHIVE_KEY, archived);
    toast("已归档，可在列表底部恢复");
    renderBody();
  }

  async function openDetail(kind, item) {
    const panel = panelOf(kind);
    panel.mode = "detail";
    panel.detail = null; panel.detailError = ""; panel.detailLoading = true;
    panel.submit = null;
    renderBody();
    try {
      panel.detail = await api(`/api/sidebar/assignments/${encodeURIComponent(item.courseId)}/${encodeURIComponent(item.id)}`);
    } catch (error) {
      panel.detailError = error.message || "作业详情读取失败。";
    } finally {
      panel.detailLoading = false;
      if (root?.isConnected) renderBody();
    }
  }

  function listBlock(kind) {
    const panel = panelOf(kind);
    if (panel.loading && !panel.data) return el("div", { class: "rsidebar-note", role: "status", text: "正在读取作业…" });
    if (panel.error) {
      return el("div", { class: "rsidebar-note error", role: "alert" }, [
        el("p", { text: "作业列表读取失败：" + panel.error }),
        el("button", { class: "ghost", type: "button", text: "重试", onclick: () => { void refreshData(kind, true); } }),
      ]);
    }
    const data = panel.data;
    if (!data) {
      // 自动读取失败或还没触发时，给一个可点的入口，而不是只留一句“尚未读取”。
      return el("div", { class: "rsidebar-note" }, [
        el("p", { text: "尚未读取作业列表。" }),
        el("button", { class: "ghost", type: "button", text: "读取作业列表", onclick: () => { void refreshData(kind, true); } }),
      ]);
    }
    if (data.state === "unavailable") {
      return el("div", { class: "rsidebar-note", role: "alert" }, [
        el("p", { text: "暂时读不到作业：" + (data.error?.message || "网络学堂未登录或接口不可用。") }),
        el("p", { class: "small muted", text: "请先在“服务”页核验网络学堂登录状态，再回到这里刷新。" }),
        el("button", { class: "ghost", type: "button", text: "重新读取", onclick: () => { void refreshData(kind, true); } }),
      ]);
    }
    const source = kind === "pending"
      ? [...(data.active || []).map(item => ({ item, overdue: false })), ...(data.expired || []).map(item => ({ item, overdue: true }))]
      : (data.ungraded || []).map(item => ({ item, overdue: false }));
    const flat = source.map(entry => entry.item);
    const filtered = filterArchived(flat, archived[kind], panel.showArchived);
    const ordered = applyOrder(filtered.visible, orders[kind]);
    const byId = new Map(source.map(entry => [entry.item.id, entry]));
    const list = el("ul", { class: "ddl-list" });
    let dividerShown = false;
    for (const item of ordered) {
      const entry = byId.get(item.id) || { overdue: false };
      if (kind === "pending" && entry.overdue && !dividerShown) {
        list.append(el("li", { class: "ddl-divider", text: "已过期" }));
        dividerShown = true;
      }
      list.append(itemRow(kind, item, entry.overdue));
    }
    if (!ordered.length) list.append(el("li", { class: "ddl-empty", text: kind === "pending" ? "没有待交作业。" : "没有待批改的作业。" }));
    const footer = el("div", { class: "rsidebar-foot" }, [
      el("span", { class: "small muted", text: `更新于 ${dateText(data.fetchedAt)}` }),
      filtered.hidden
        ? el("button", { class: "ghost", type: "button", text: panel.showArchived ? `隐藏 ${filtered.hidden} 条归档` : `显示 ${filtered.hidden} 条归档`, onclick: () => { panel.showArchived = !panel.showArchived; renderBody(); } })
        : null,
      el("button", { class: "ghost", type: "button", text: "刷新", onclick: () => { void refreshData(kind, true); } }),
    ]);
    const errors = Array.isArray(data.courseErrors) ? data.courseErrors : [];
    return el("div", { class: "rsidebar-list" }, [
      errors.length ? el("p", { class: "small muted", text: `${errors.length} 门课程读取失败，列表可能不完整。` }) : null,
      list,
      footer,
    ]);
  }

  function pruneEmptySections(root) {
  const headings = [...root.querySelectorAll("h1, h2, h3")];
  for (const heading of headings) {
    if (!/^(已提交正文|参考答案|批改反馈)$/.test(heading.textContent.trim())) continue;
    let node = heading.nextElementSibling;
    let hasContent = false;
    while (node && !/^H[1-3]$/.test(node.tagName)) {
      if ((node.textContent || "").trim()) { hasContent = true; break; }
      node = node.nextElementSibling;
    }
    if (!hasContent) heading.remove();
  }
}

function detailBlock(kind) {
    const panel = panelOf(kind);
    if (panel.detailLoading) return el("div", { class: "rsidebar-note", role: "status", text: "正在读取作业详情…" });
    if (panel.detailError) return el("div", { class: "rsidebar-note error", role: "alert", text: "详情读取失败：" + panel.detailError });
    const detail = panel.detail;
    if (!detail) return el("div", { class: "rsidebar-note", text: "作业详情不可用。" });
    const attachments = Array.isArray(detail.attachments) ? detail.attachments : [];
    return el("div", { class: "rsidebar-detail" }, [
      el("button", { class: "ghost back", type: "button", text: "← 返回列表", onclick: () => { panel.mode = "list"; panel.submit = null; renderBody(); } }),
      el("h3", { text: detail.title || "作业详情" }),
      el("dl", { class: "ddl-facts" }, [
        el("dt", { text: "截止" }), el("dd", { text: dateText(detail.deadline) || "未知" }),
        el("dt", { text: "状态" }), el("dd", { text: detail.submitted ? "已提交" : "未提交" }),
    detail.completionType !== null && detail.completionType !== 1 ? el("dt", { text: "站点标记" }) : null,
    detail.completionType !== null && detail.completionType !== 1 ? el("dd", { text: "小组作业（需组内成员在官网提交，助手不代提交）" }) : null,
        detail.submitTime ? el("dt", { text: "提交时间" }) : null,
        detail.submitTime ? el("dd", { text: dateText(detail.submitTime) }) : null,
        detail.grade !== null && detail.grade !== undefined ? el("dt", { text: "成绩" }) : null,
        detail.grade !== null && detail.grade !== undefined ? el("dd", { text: String(detail.grade) }) : null,
      ]),
      attachments.length ? el("div", { class: "ddl-attachments" }, [
        el("p", { class: "small muted", text: "附件" }),
        el("ul", {}, attachments.map(file => el("li", { text: file.name + (file.role === "submittedAttachment" ? "（已提交）" : "") }))),
      ]) : null,
      (() => {
    const node = el("div", { class: "rich ddl-body" }, [detail.body ? renderRich(detail.body) : el("p", { class: "small muted", text: "作业正文为空。" })]);
    pruneEmptySections(node);
    return node;
  })(),
      el("div", { class: "rsidebar-foot" }, [
        el("button", { class: "primary", type: "button", text: "提交", onclick: () => { panel.submit = null; panel.mode = "submit"; renderBody(); } }),
      ]),
    ]);
  }

  function submitBlock(kind) {
    const panel = panelOf(kind);
    const detail = panel.detail;
    if (!detail) return el("div", { class: "rsidebar-note", text: "请先打开作业详情。" });
    const state = panel.submit || (panel.submit = { content: "", file: null, overwrite: false, busy: "", error: "", prepared: null, receipt: null });
    const back = el("button", { class: "ghost back", type: "button", text: "← 返回详情", onclick: () => { panel.mode = "detail"; renderBody(); } });
    if (state.receipt) return el("div", { class: "rsidebar-detail", role: "status" }, [
      back,
      el("h3", { text: "提交结果" }),
      el("p", { class: "ddl-receipt", dataset: { s: state.receipt.status || "unknown" }, text: `${state.receipt.status || "unknown"}：${state.receipt.message || "服务器未给出说明。"}` }),
      el("button", { class: "ghost", type: "button", text: "回到详情", onclick: () => { panel.mode = "detail"; panel.submit = null; renderBody(); } }),
    ]);
    const body = el("div", { class: "rsidebar-detail" }, [back, el("h3", { text: "提交作业" })]);
    body.append(el("p", { class: "small muted", text: `${detail.title} · 截止 ${dateText(detail.deadline) || "未知"}` }));
    const content = el("textarea", { class: "ddl-content", rows: 6, placeholder: "提交正文（可与附件同时提交）", value: state.content, oninput: event => { state.content = event.target.value; } });
    const fileLabel = el("span", { class: "ddl-file-name", text: state.file ? `${state.file.name}（${Math.max(1, Math.round(state.file.size / 1024))} KB）` : "未选择附件" });
    const file = el("input", { type: "file", onchange: async event => {
      const picked = event.target.files?.[0];
      if (!picked) return;
      state.busy = "upload"; renderBody();
      try { state.file = await uploadFile(picked); } catch (error) { state.error = error.message || "附件上传失败。"; }
      finally { state.busy = ""; renderBody(); }
    } });
    body.append(el("label", { class: "field" }, [el("span", { text: "正文" }), content]));
    body.append(el("label", { class: "field" }, [el("span", { text: "附件" }), file, fileLabel]));
    if (detail.submitted) {
      body.append(el("label", { class: "field row" }, [
        el("input", { type: "checkbox", checked: state.overwrite, onchange: event => { state.overwrite = event.target.checked; } }),
        el("span", { text: "该作业已有提交，覆盖需要明确授权" }),
      ]));
    }
    if (state.error) body.append(el("p", { class: "error", role: "alert", text: state.error }));
    if (!state.prepared) {
      body.append(el("button", { class: "primary", type: "button", text: state.busy === "upload" ? "上传中…" : "准备提交", disabled: !!state.busy, onclick: () => { void prepare(kind, detail); } }));
      return body;
    }
    const preview = state.prepared.preparation || {};
    body.append(el("div", { class: "ddl-prepared" }, [
      el("p", { text: `将提交到：${preview.course || detail.title}` }),
      el("p", { text: `正文 ${(preview.content || "").length} 字` }),
      el("p", { text: preview.attachment ? `附件：${preview.attachment.name}` : "不带附件" }),
      preview.overwrite ? el("p", { class: "error", text: "这是一次覆盖提交。" }) : null,
      el("p", { class: "small muted", text: `准备记录 ${preview.expiresAt ? dateText(preview.expiresAt) : ""} 前有效。确认后才会真正上传。` }),
    ]));
    body.append(el("div", { class: "ddl-confirm-actions" }, [
      el("button", { class: "ghost", type: "button", text: "取消", onclick: () => { state.prepared = null; renderBody(); } }),
      el("button", { class: "primary", type: "button", text: state.busy === "submit" ? "提交中…" : "确认提交", disabled: state.busy === "submit", onclick: () => { void confirm(kind); } }),
    ]));
    return body;
  }

  async function prepare(kind, detail) {
    const panel = panelOf(kind);
    const state = panel.submit;
    if (!state) return;
    if (!state.content.trim() && !state.file) { state.error = "请填写正文或选择附件。"; renderBody(); return; }
    state.busy = "prepare"; state.error = "";
    renderBody();
    try {
      state.prepared = await api("/api/sidebar/submissions/prepare", {
        method: "POST",
        body: { courseId: detail.courseId, homeworkId: detail.id, content: state.content, filePath: state.file?.path, overwrite: state.overwrite },
      });
    } catch (error) {
      state.error = error.message || "准备提交失败。";
    } finally {
      state.busy = "";
      renderBody();
    }
  }
  async function confirm(kind) {
    const panel = panelOf(kind);
    const state = panel.submit;
    if (!state?.prepared) return;
    state.busy = "submit"; state.error = "";
    renderBody();
    try {
      const data = await api("/api/sidebar/submissions/confirm", {
        method: "POST",
        body: { preparationId: state.prepared.preparation?.id, confirmToken: state.prepared.confirmToken },
      });
      state.receipt = data.receipt || { status: "unknown", message: "服务器未返回回执。" };
      state.prepared = null;
    } catch (error) {
      state.error = error.message || "提交失败。";
    } finally {
      state.busy = "";
      renderBody();
    }
  }

  function externalBlock(kind) {
    if (kind === "sports") {
      return el("div", { class: "rsidebar-note" }, [
        el("p", { text: "清华体育为学校场馆预约站点，网页版需要登录后使用。" }),
        el("p", { class: "small muted", text: "当前版本只提供入口，预约尚未接入；不会伪造可预约的场地。" }),
        el("a", { class: "ghost link-button", href: SPORTS_URL, target: "_blank", rel: "noopener noreferrer", text: "打开清华体育预约页" }),
      ]);
    }
    return el("div", { class: "rsidebar-note" }, [
      el("p", { text: "掌上艺教目前只有微信小程序，桌面网页拿不到授权态。" }),
      el("p", { class: "small muted", text: "琴房预约需要微信登录，暂不接入；这里不显示任何占位名额或虚假预约按钮。" }),
    ]);
  }

  function renderBody() {
    if (!body) return;
    const kind = dock.active;
    const panel = panelOf(kind);
    body.replaceChildren();
    if (KINDS[kind]?.external || KINDS[kind]?.unavailable) body.append(externalBlock(kind));
    else if (panel.mode === "detail") body.append(detailBlock(kind));
    else if (panel.mode === "submit") body.append(submitBlock(kind));
    else body.append(listBlock(kind));
    body.setAttribute("aria-labelledby", "rsidebar-tab-" + kind);
    body.scrollTop = 0;
  }

  function renderTabs() {
    if (!tabbar) return;
    tabbar.replaceChildren();
    for (const kind of dock.tabs) {
      const active = kind === dock.active;
      const tab = el("div", { class: "rsidebar-tab", dataset: { active: String(active) }, role: "tab", id: "rsidebar-tab-" + kind, "aria-selected": String(active), tabindex: active ? "0" : "-1" }, [
        el("button", { class: "rsidebar-tab-name", type: "button", text: KINDS[kind].label, onclick: () => { activate(kind); } }),
        dock.tabs.length > 1
          ? el("button", { class: "rsidebar-tab-close", type: "button", "aria-label": "关闭" + KINDS[kind].label, text: "×", onclick: event => { event.stopPropagation(); closeTab(kind); } })
          : null,
      ]);
      tabbar.append(tab);
    }
    const menu = el("details", { class: "rsidebar-add" }, [
      el("summary", { "aria-label": "添加标签页", title: "添加标签页", text: "+" }),
      el("div", { class: "rsidebar-add-list" }, Object.entries(KINDS).map(([kind, meta]) =>
        el("button", { class: "ghost", type: "button", text: (dock.tabs.includes(kind) ? "打开 " : "添加 ") + meta.label, onclick: () => { openTab(kind); } }),
      )),
    ]);
    tabbar.append(menu);
  }

  function activate(kind) {
    if (!KINDS[kind]) return;
    dock.active = kind;
    saveLayout();
    renderTabs();
    renderBody();
    if (KINDS[kind]?.list) void refreshData(kind);
  }
  function openTab(kind) {
    if (!KINDS[kind]) return;
    if (!dock.tabs.includes(kind)) { dock.tabs.push(kind); saveLayout(); }
    activate(kind);
  }
  function closeTab(kind) {
    const index = dock.tabs.indexOf(kind);
    if (index < 0 || dock.tabs.length === 1) return;
    dock.tabs.splice(index, 1);
    if (dock.active === kind) dock.active = dock.tabs[Math.max(0, index - 1)];
    panels.delete(kind);
    saveLayout();
    renderTabs();
    renderBody();
  }

  function beginResize(event) {
    if (event.button !== 0) return;
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = dock.width;
    grip.dataset.dragging = "true";
    const move = moveEvent => {
      dock.width = clampWidth(startWidth + (startX - moveEvent.clientX));
      applyWidth();
    };
    const finish = () => {
      document.removeEventListener("pointermove", move);
      document.removeEventListener("pointerup", finish);
      delete grip.dataset.dragging;
      saveLayout();
    };
    document.addEventListener("pointermove", move);
    document.addEventListener("pointerup", finish);
  }
  function gripKey(event) {
    const step = event.shiftKey ? 64 : 24;
    if (event.key === "ArrowLeft") dock.width = clampWidth(dock.width + step);
    else if (event.key === "ArrowRight") dock.width = clampWidth(dock.width - step);
    else if (event.key === "Enter" || event.key === " ") dock.width = 380;
    else return;
    event.preventDefault();
    applyWidth();
    saveLayout();
  }

  function init() {
    root = el("aside", { id: "right-sidebar", class: "rsidebar", role: "complementary", "aria-label": "右侧工作区" });
    grip = el("div", { class: "rsidebar-grip", role: "separator", "aria-orientation": "vertical", tabindex: "0", "aria-label": "调整右侧边栏宽度", "aria-valuemin": "320", "aria-valuemax": "720", "aria-description": "左右方向键调整，Enter 恢复默认", onpointerdown: beginResize, onkeydown: gripKey });
    tabbar = el("div", { class: "rsidebar-tabs", role: "tablist", "aria-label": "右侧标签页" });
    body = el("div", { class: "rsidebar-body", role: "tabpanel", tabindex: "0" });
    root.append(grip, el("header", { class: "rsidebar-head" }, [tabbar]), body);
    document.querySelector("#app")?.append(root);
    toggle = el("button", { id: "sidebar-toggle", class: "icon-btn", type: "button", "aria-label": "侧边栏", title: "侧边栏", onclick: () => { setOpen(!visible()); } }, [icon("M4 5h16v14H4V5Z M15 5v14")]);
    document.querySelector(".topbar-meta")?.insertBefore(toggle, document.querySelector("#refresh"));
    renderTabs();
    setOpen(visible());
    renderBody();
    globalThis.addEventListener?.("resize", applyVisibility);
    document.addEventListener("keydown", event => {
      if (event.key === "Escape" && (globalThis.innerWidth || 1280) < 1100 && overlayOpen) setOpen(false);
    });
  }

  return { init, refresh: () => refreshData(dock.active, true), open: () => setOpen(true), toggle: () => setOpen(!visible()), isOpen: () => visible() };
}