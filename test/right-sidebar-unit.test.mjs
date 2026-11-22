import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import domino from "@mixmark-io/domino";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const moduleUrl = pathToFileURL(path.join(root, "webui/right-sidebar.js")).href;

/** 极简 DOM：右侧栏只依赖 createElement/append/属性，不需要完整浏览器。 */
function makeEl(document) {
  return (tag, props = {}, children = []) => {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(props)) {
      if (value === undefined || value === null) continue;
      if (key === "class") node.className = value;
      else if (key === "text") node.textContent = value;
      else if (key === "dataset") for (const [name, val] of Object.entries(value)) node.setAttribute("data-" + name, String(val));
      else if (key === "style") node.setAttribute("style", typeof value === "string" ? value : "");
      else if (key === "onclick" || key === "onchange" || key === "oninput") node.addEventListener(key.slice(2), value);
      else if (key === "hidden") node.hidden = Boolean(value);
      else node.setAttribute(key, String(value));
    }
    for (const child of [].concat(children)) if (child) node.append(child);
    return node;
  };
}

async function harness({ width = 1600, saved = {}, api: apiImpl } = {}) {
  const dom = domino.createWindow("<!doctype html><body></body>", "https://unit.invalid/");
  const { document } = dom;
  // domino 只实现 appendChild；右栏代码用 append(...)，这里补上等价语义。
  for (const proto of [dom.Element?.prototype, dom.DocumentFragment?.prototype]) {
    if (!proto) continue;
    if (!proto.append) proto.append = function append(...nodes) { for (const node of nodes) if (node) this.appendChild(node); };
    if (!proto.replaceChildren) proto.replaceChildren = function replaceChildren(...nodes) { while (this.firstChild) this.removeChild(this.firstChild); for (const node of nodes) if (node) this.appendChild(node); };
    if (!("dataset" in proto)) Object.defineProperty(proto, "dataset", { configurable: true, get() { const node = this; return new Proxy({}, { get: (_t, key) => node.getAttribute("data-" + String(key)), set: (_t, key, value) => { node.setAttribute("data-" + String(key), String(value)); return true; }, has: (_t, key) => node.hasAttribute("data-" + String(key)), deleteProperty: (_t, key) => { node.removeAttribute("data-" + String(key)); return true; } }); } });
  }
  const store = new Map(Object.entries(saved));
  const storage = {
    getItem: key => store.get(key) ?? null,
    setItem: (key, value) => store.set(key, String(value)),
    removeItem: key => store.delete(key),
  };
  const toasts = [];
  const calls = [];
  const apiImpl2 = apiImpl || (async (route, options) => {
    calls.push({ route, options });
    if (String(route).startsWith("/api/sidebar/assignments")) return { ok: true, state: "ready", items: [] };
    return { ok: true };
  });
  const previousWidth = globalThis.innerWidth;
  const previousDocument = globalThis.document;
  globalThis.innerWidth = width;
  globalThis.document = document;
  const module = await import(moduleUrl);
  const sidebar = module.createRightSidebar({
    el: makeEl(document),
    api: apiImpl2,
    toast: message => toasts.push(message),
    renderRich: () => {},
    uploadFile: async () => ({}),
    storage,
    onResize: () => calls.push({ route: "resize" }),
    canLoad: () => true,
  });
  return { dom, document, sidebar, storage, store, toasts, calls, restore: () => { globalThis.innerWidth = previousWidth; globalThis.document = previousDocument; } };
}

test("右侧栏：初始化、开关、宽度持久化与窄屏覆盖层", async () => {
  const h = await harness({ saved: { "campus.rsidebar.v1": JSON.stringify({ open: true, width: 420, tabs: ["pending", "course"], active: "pending" }) } });
  try {
    const host = h.document.createElement("div");
    h.document.body.appendChild(host);
    h.sidebar.init(host);
    assert.equal(h.sidebar.isOpen(), true);
    assert.equal(host.hidden, false);
    assert.match(host.style.getPropertyValue("--rsidebar-width") || "420px", /420px/);

    h.sidebar.toggle();
    assert.equal(h.sidebar.isOpen(), false);
    h.sidebar.open();
    assert.equal(h.sidebar.isOpen(), true);
    assert.ok(h.calls.some(call => call.route === "resize"), "打开时通知布局重算");
    const savedLayout = JSON.parse(h.store.get("campus.rsidebar.v1"));
    assert.equal(savedLayout.open, true);
  } finally {
    h.restore();
  }
});

test("右侧栏：窄屏用覆盖层，坏配置回落到默认", async () => {
  const h = await harness({ width: 900, saved: { "campus.rsidebar.v1": "{broken" } });
  try {
    const host = h.document.createElement("div");
    h.document.body.appendChild(host);
    h.sidebar.init(host);
    assert.equal(h.sidebar.isOpen(), false, "窄屏默认不占位");
    h.sidebar.open();
    assert.equal(h.sidebar.isOpen(), true, "窄屏以覆盖层打开");
  } finally {
    h.restore();
  }
});
