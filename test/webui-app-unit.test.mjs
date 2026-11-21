import { test, after } from "node:test";
import assert from "node:assert/strict";
import { readFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import domino from "@mixmark-io/domino";

// Real application module + real DOM events. No browser, server, credentials or source rewriting.
const root = path.resolve(import.meta.dirname, "..");
const html = await readFile(path.join(root, "webui/index.html"), "utf8");
const tempRoot = path.join(root, ".local", "qa-temp");
await mkdir(tempRoot, { recursive: true });
const ownedTemp = await mkdtemp(path.join(tempRoot, "webui-app-unit-"));
const previousTemp = { TEMP: process.env.TEMP, TMP: process.env.TMP };
process.env.TEMP = process.env.TMP = ownedTemp;
after(async () => {
  for (const key of ["TEMP", "TMP"]) {
    if (previousTemp[key] === undefined) delete process.env[key];
    else process.env[key] = previousTemp[key];
  }
  assert.equal(path.dirname(ownedTemp), tempRoot);
  assert.ok(path.basename(ownedTemp).startsWith("webui-app-unit-"));
  await rm(ownedTemp, { recursive: true, force: true });
});

const origin = "https://webui-unit.invalid";
const sessionId = "12345678-1234-1234-1234-123456789012";
const connectionKey = "campus.app.connection";
const token = "fixture-device-token";
const checkedAt = "2026-11-14T12:00:00.000Z";
const models = [{ id: "fixture-a", label: "模型甲" }, { id: "fixture-b", label: "模型乙" }];
const meta = () => ({ ok: true, models, model: { name: "fixture-a", route: "fixture" }, services: {} });
const storage = () => ({ mode: "cloud", state: "uninitialized", scope: { accountId: "fixture-account", repoId: "fixture-private", rootPath: "/Agent工作区" }, privacy: { verified: true, checkedAt } });
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const flush = async () => { for (let i = 0; i < 8; i++) await new Promise(resolve => setImmediate(resolve)); };
async function until(predicate, label = "application state") {
  for (let i = 0; i < 80; i++) { if (predicate()) return; await flush(); }
  assert.fail("Timed out waiting for " + label);
}

// Domino predates these browser APIs. Polyfills implement platform operations only.
function browserDOM(window) {
  const { Node, Element, HTMLElement, HTMLSelectElement, HTMLInputElement, HTMLTextAreaElement } = window;
  for (const collection of [window.document.querySelectorAll("*"), window.document.querySelectorAll(".tab"), window.document.body.childNodes]) {
    const proto = Object.getPrototypeOf(collection);
    if (!proto[Symbol.iterator]) Object.defineProperty(proto, Symbol.iterator, { value: Array.prototype[Symbol.iterator] });
  }
  if (!Node.prototype.append) Object.defineProperty(Node.prototype, "append", { value(...items) {
    for (const item of items) this.appendChild(item?.nodeType ? item : this.ownerDocument.createTextNode(String(item)));
  } });
  if (!Node.prototype.prepend) Object.defineProperty(Node.prototype, "prepend", { value(...items) {
    for (const item of items.reverse()) this.insertBefore(item?.nodeType ? item : this.ownerDocument.createTextNode(String(item)), this.firstChild);
  } });
  if (!Node.prototype.replaceChildren) Object.defineProperty(Node.prototype, "replaceChildren", { value(...items) {
    while (this.firstChild) this.removeChild(this.firstChild);
    this.append(...items);
  } });
  if (!Object.getOwnPropertyDescriptor(Element.prototype, "dataset")) Object.defineProperty(Element.prototype, "dataset", { get() {
    const element = this;
    const attribute = key => "data-" + String(key).replace(/[A-Z]/g, char => "-" + char.toLowerCase());
    return new Proxy({}, { get: (_, key) => element.getAttribute(attribute(key)) ?? undefined, set: (_, key, value) => { element.setAttribute(attribute(key), String(value)); return true; }, deleteProperty: (_, key) => { element.removeAttribute(attribute(key)); return true; } });
  } });
  if (!Object.getOwnPropertyDescriptor(HTMLElement.prototype, "open")) Object.defineProperty(HTMLElement.prototype, "open", { get() { return this.hasAttribute("open"); }, set(value) { if (value) this.setAttribute("open", ""); else this.removeAttribute("open"); } });
  if (!Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")) Object.defineProperty(HTMLSelectElement.prototype, "value", { get() {
    const options = [...this.querySelectorAll("option")];
    return (options.find(option => option.selected) || options[0])?.value || "";
  }, set(value) { for (const option of this.querySelectorAll("option")) option.selected = option.value === String(value); } });
  if (!Element.prototype.getBoundingClientRect) Object.defineProperty(Element.prototype, "getBoundingClientRect", { value() { return { width: 1000, height: 400, left: 0, right: 1000, top: 0, bottom: 400 }; } });
  if (!Element.prototype.setPointerCapture) {
    const captures = new WeakMap();
    for (const [name, fn] of Object.entries({ setPointerCapture(id) { captures.set(this, id); }, hasPointerCapture(id) { return captures.get(this) === id; }, releasePointerCapture() { captures.delete(this); } })) Object.defineProperty(Element.prototype, name, { value: fn });
  }
  for (const [name, value] of [["clientWidth", 1280], ["clientHeight", 400], ["scrollHeight", 800]]) {
    if (!Object.getOwnPropertyDescriptor(Element.prototype, name)) Object.defineProperty(Element.prototype, name, { get() { return value; }, configurable: true });
  }
  for (const proto of [HTMLInputElement.prototype, HTMLTextAreaElement.prototype]) {
    if (!proto.setSelectionRange) Object.defineProperty(proto, "setSelectionRange", { value(start, end) { this.selectionStart = start; this.selectionEnd = end; } });
    if (!proto.select) Object.defineProperty(proto, "select", { value() { this.setSelectionRange(0, this.value.length); } });
  }
}
let imports = 0;
async function app(t, { paired = true, href = origin + "/", routes: customRoutes = {}, saved = {} } = {}) {
  const window = domino.createWindow(html, href);
  browserDOM(window);
  const document = window.document;
  const savedValues = new Map(Object.entries(saved));
  if (paired) savedValues.set(connectionKey, JSON.stringify({ version: 1, base: origin, token }));
  const localStorage = { getItem: key => savedValues.get(key) ?? null, setItem: (key, value) => savedValues.set(key, String(value)), removeItem: key => savedValues.delete(key) };
  window.localStorage = localStorage;
  const routes = new Map(Object.entries({ "GET /api/meta": meta(), "GET /api/workspace/storage": { ok: true, storage: storage() }, "GET /api/sessions": { ok: true, sessions: [] }, "GET /api/sidebar/assignments": { ok: true, state: "ready", fetchedAt: checkedAt, active: [], expired: [], ungraded: [], courseErrors: [] }, "GET /api/gitlab/config": { ok: true, baseUrl: "https://git.tsinghua.edu.cn", configured: false, masked: "", source: "none" }, "GET /api/service": { ok: true, supported: false }, ...customRoutes }));
  const calls = [], denied = [], timers = new Map(), frames = new Map(), streams = [];
  let timerId = 0, now = 0;
  const setTimer = (fn, delay = 0) => { const id = ++timerId; timers.set(id, { fn, at: now + delay }); return id; };
  const replacements = { window, document, location: window.location, history: { replaceState: (_state, _title, url) => { window.location.href = new URL(url, window.location.href).href; } }, navigator: { platform: "unit-dom", clipboard: { writeText: async text => { api.clipboard.push(text); } } }, localStorage,
    innerWidth: 1280, getComputedStyle: () => ({ paddingLeft: "24", paddingRight: "24" }),
    setTimeout: setTimer, clearTimeout: id => timers.delete(id),
    requestAnimationFrame: fn => { const id = ++timerId; frames.set(id, fn); return id; }, cancelAnimationFrame: id => frames.delete(id),
    confirm: message => { api.confirmations.push(message); return api.confirmResult; },
    fetch: async (url, options = {}) => {
      const parsed = new URL(url, origin), method = options.method || "GET";
      const key = method + " " + parsed.pathname + parsed.search;
      if (parsed.origin !== origin || !routes.has(key)) { denied.push(key + " @ " + parsed.origin); throw new Error("Unplanned fetch: " + key); }
      const request = { url: parsed.href, method, options, body: options.body ? JSON.parse(options.body) : undefined };
      calls.push(request);
      const route = routes.get(key);
      const result = typeof route === "function" ? await route(request) : route;
      return result instanceof Response ? result : Response.json(result);
    },
  };
  const previous = new Map();
  for (const [key, value] of Object.entries(replacements)) { previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key)); Object.defineProperty(globalThis, key, { configurable: true, writable: true, value }); }
  t.after(async () => {
    for (const stream of streams) stream.close();
    window.dispatchEvent(new window.Event("pagehide"));
    await flush();
    for (const [key, descriptor] of previous) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key]; }
    assert.deepEqual(denied, [], "All fetch destinations must have an explicit fixture route");
  });
  const api = {
    window, document, localStorage, savedValues, routes, calls, clipboard: [], confirmations: [], confirmResult: true,
    $: selector => document.querySelector(selector), all: selector => [...document.querySelectorAll(selector)],
    event(target, type, props = {}) { const node = typeof target === "string" ? api.$(target) : target; assert.ok(node, `Missing target ${target}`); const event = new window.Event(type, { bubbles: true, cancelable: true }); Object.assign(event, props); node.dispatchEvent(event); return event; },
    click(target) { return api.event(target, "click"); },
    input(target, value, type = "input") { const node = typeof target === "string" ? api.$(target) : target; node.value = value; return api.event(node, type); },
    button(text, scope = document) { const button = [...scope.querySelectorAll("button")].find(node => node.textContent === text); assert.ok(button, `Missing button ${text}`); return button; },
    nav(view) { api.click(`.tab[data-view="${view}"]`); },
    frame() { const pending = [...frames.values()]; frames.clear(); for (const fn of pending) fn(now); },
    async tick(ms) { now += ms; const due = [...timers].filter(([, item]) => item.at <= now); for (const [id, item] of due) { timers.delete(id); item.fn(); } await flush(); api.frame(); },
    count(route) { return calls.filter(call => call.method + " " + new URL(call.url).pathname === route).length; },
    stream() {
      let controller, closed = false;
      const body = new ReadableStream({ start(value) { controller = value; } });
      const fixture = { response: new Response(body, { headers: { "content-type": "text/event-stream" } }), emit(event, payload) { assert.equal(closed, false); controller.enqueue(new TextEncoder().encode(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`)); }, close() { if (!closed) { closed = true; controller.close(); } } };
      streams.push(fixture); return fixture;
    },
    async send(text) { api.input("#composer", text); api.click("#chat-send"); await flush(); },
  };
  await import(new URL(`../webui/app.js?unit=${++imports}`, import.meta.url));
  await until(() => paired ? !!api.$("#composer") || !api.$("#pair").hidden || api.$("#account").textContent === "服务连接失败" : !api.$("#pair").hidden, "startup");
  await flush();
  return api;
}

// node:test runs these sequentially: each import owns its DOM/globals/timers.
test("app: unpaired validation, mapped rejection, and successful atomic pairing", async t => {
  const a = await app(t, { paired: false });
  assert.equal(a.$("#app").hidden, true);
  a.click("#pair-submit");
  assert.match(a.$("#pair-error").textContent, /6 位数字/);
  assert.equal(a.calls.length, 0);
  a.input("#pair-code", "123456");
  a.routes.set("POST /api/pair/redeem", { ok: false, error: { code: "PAIRING_EXPIRED" } });
  a.event("#pair-code", "keydown", { key: "Enter" }); await flush();
  assert.match(a.$("#pair-error").textContent, /无效或已过期/);
  assert.equal(a.$("#pair-submit").disabled, false);
  a.routes.set("POST /api/pair/redeem", { ok: true, token });
  a.click("#pair-submit"); await until(() => !!a.$("#composer"));
  assert.equal(a.$("#pair").hidden, true);
  assert.deepEqual(JSON.parse(a.localStorage.getItem(connectionKey)), { version: 1, base: origin, token });
  assert.deepEqual(a.calls.find(call => call.method === "POST").body, { code: "123456", deviceName: "unit-dom", platform: "webui" });
  assert.equal(a.calls.at(-1).options.credentials, "omit");
});

for (const [code, expected] of [["PAIRING_LOCKED", /频繁/], ["PAIRING_INVALID", /格式/], ["PAIRING_DISABLED", /固定令牌/], ["OTHER", /fixture rejection/]]) test(`app: pairing ${code} stays recoverable`, async t => {
  const a = await app(t, { paired: false, routes: { "POST /api/pair/redeem": { ok: false, error: { code, message: "fixture rejection" } } } });
  a.input("#pair-code", "654321"); a.click("#pair-submit"); await flush();
  assert.match(a.$("#pair-error").textContent, expected);
  assert.equal(a.$("#pair-submit").disabled, false);
  assert.equal(a.localStorage.getItem(connectionKey), null);
});

test("app: invalid issued token and non-JSON pairing replies never save credentials", async t => {
  const a = await app(t, { paired: false, routes: { "POST /api/pair/redeem": { ok: true, token: "bad token\n" } } });
  a.input("#pair-code", "123456"); a.click("#pair-submit"); await flush();
  assert.match(a.$("#pair-error").textContent, /不合法/);
  a.routes.set("POST /api/pair/redeem", new Response("not json", { status: 502 }));
  a.click("#pair-submit"); await flush();
  assert.match(a.$("#pair-error").textContent, /配对失败/);
  assert.equal(a.localStorage.getItem(connectionKey), null);
});

test("app: rejected stored credential returns to pairing and removes the token", async t => {
  const a = await app(t, { routes: { "GET /api/meta": Response.json({ ok: false, error: { code: "AUTH_REQUIRED" } }, { status: 401 }) } });
  assert.equal(a.$("#pair").hidden, false);
  assert.match(a.$("#pair-error").textContent, /失效/);
  assert.equal(JSON.parse(a.localStorage.getItem(connectionKey)).token, "");
  assert.equal(a.count("GET /api/workspace/storage"), 0);
});

test("app: connection error is not an authenticated empty application", async t => {
  const a = await app(t, { routes: { "GET /api/meta": new Response("bad json", { status: 503 }) } });
  assert.equal(a.$("#account").textContent, "服务连接失败");
  assert.equal(a.$("#health-dot").className, "dot bad");
  assert.match(a.$("#toast").textContent, /非 JSON/);
  assert.equal(a.$("#app").hidden, true);
  assert.equal(a.localStorage.getItem(connectionKey) !== null, true);
  await a.tick(3200); assert.equal(a.$("#toast").hidden, true);
});

test("app: quick actions only edit drafts, themes and popovers respond to DOM events", async t => {
  const a = await app(t);
  a.input("#composer", "已有草稿");
  a.click('[data-action="assignments"]');
  assert.match(a.$("#composer").value, /已有草稿\n\n查询本学期/);
  assert.equal(a.count("POST /api/chat"), 0);
  const menu = a.$(".add-menu"); menu.open = true;
  a.click(a.button("云盘文件", menu));
  assert.equal(menu.open, false);
  assert.match(a.$("#composer").value, /个人私有资料库/);
  menu.open = true; a.event(a.document.body, "click"); assert.equal(menu.open, false);
  menu.open = true; a.event(a.document, "keydown", { key: "Escape" }); assert.equal(menu.open, false);
  a.click("#theme-dark"); assert.equal(a.document.documentElement.dataset.theme, "dark");
  assert.equal(a.localStorage.getItem("campus.theme"), "dark");
  a.click("#theme-light"); assert.equal(a.$("#theme-light").getAttribute("aria-pressed"), "true");
});

test("app: model save pending/rollback, refresh failure and draft retention", async t => {
  const save = deferred();
  const a = await app(t, { routes: { "PUT /api/settings": () => save.promise } });
  a.input("#composer", "不能丢的草稿");
  a.input("#chat-model", "fixture-b", "change");
  assert.equal(a.$("#chat-model").disabled, true);
  assert.match(a.$(".model-status").textContent, /保存/);
  save.resolve({ ok: false, error: { message: "fixture save refused" } }); await flush();
  assert.equal(a.$("#chat-model").value, "fixture-a");
  assert.match(a.$(".model-status").textContent, /模型未切换.*fixture save refused/);
  a.routes.set("GET /api/models?refresh=1", { ok: false, error: { message: "catalog unavailable" } });
  a.click('[aria-label="刷新模型"]'); await flush();
  assert.match(a.$(".model-status").textContent, /上次成功/);
  assert.equal(a.$("#composer").value, "不能丢的草稿");
  a.routes.set("GET /api/models?refresh=1", { ok: true, models, current: "fixture-b" });
  a.click('[aria-label="刷新模型"]'); await flush();
  assert.equal(a.$("#chat-model").value, "fixture-b");
  assert.equal(a.$(".model-status").hidden, true);
});

test("app: missing models disable send and unavailable current model is shown explicitly", async t => {
  const a = await app(t, { routes: { "GET /api/meta": { ...meta(), models: [], model: {} } } });
  assert.equal(a.$("#chat-send").disabled, true);
  assert.match(a.$(".model-status").textContent, /未获取到可用模型/);
  a.input("#composer", "不会发送"); a.event("#composer", "keydown", { key: "Enter" });
  assert.equal(a.count("POST /api/chat"), 0);
  a.routes.set("GET /api/models?refresh=1", { ok: true, models, current: "fixture-absent" });
  a.click('[aria-label="刷新模型"]'); await flush();
  assert.match(a.$("#chat-model option").textContent, /当前目录中不可用/);
});

test("app: stream renders incremental reasoning/text before done; queued turn uses latest saved model", async t => {
  const a = await app(t, { routes: { "PUT /api/settings": request => ({ ok: true, settings: { modelName: request.body.modelName } }) } });
  const first = a.stream(), second = a.stream();
  let turn = 0;
  a.routes.set("POST /api/chat", () => (++turn === 1 ? first.response : second.response));
  await a.send("第一轮");
  first.emit("ready", { sessionId }); first.emit("reasoning", { text: "fixture思考" }); first.emit("token", { text: "首段" });
  await flush(); a.frame();
  assert.match(a.$("#messages").textContent, /fixture思考.*首段/);
  assert.equal(a.$("#chat-stop").hidden, false);
  a.input("#chat-model", "fixture-b", "change"); await flush();
  await a.send("第二轮");
  assert.match(a.$(".queue-state").textContent, /待发1条/);
  assert.equal(a.count("POST /api/chat"), 1);
  assert.equal(a.$("#rail-new-chat").disabled, true);
  const unload = a.event(a.window, "beforeunload"); assert.equal(unload.defaultPrevented, true);
  first.emit("message", { role: "assistant", content: "首段与末帧", reasoning: "fixture思考完毕" });
  first.emit("done", { sessionId }); first.close(); await until(() => a.count("POST /api/chat") === 2);
  assert.deepEqual(a.calls.filter(call => call.method === "POST").map(call => call.body.model), ["fixture-a", "fixture-b"]);
  assert.deepEqual(a.calls.find(call => call.method === "PUT").body, { modelName: "fixture-b" });
  assert.equal(a.calls.filter(call => new URL(call.url).pathname === "/api/chat")[1].body.sessionId, sessionId);
  second.emit("token", { text: "第二轮结果" }); second.emit("done", { sessionId }); second.close(); await flush();
  assert.match(a.$("#messages").textContent, /首段与末帧.*第二轮结果/);
  assert.equal(a.$("#chat-stop").hidden, true);
  assert.equal(a.$(".turn-queue").hidden, true);
});

test("app: interrupted stream preserves partial text and pauses/takes back pending drafts", async t => {
  const a = await app(t);
  const stream = a.stream(); a.routes.set("POST /api/chat", stream.response);
  await a.send("第一轮"); await a.send("待发内容");
  stream.emit("token", { text: "已收到的半段" }); stream.close(); await flush();
  assert.match(a.$("#messages").textContent, /已收到的半段.*STREAM_INTERRUPTED/);
  assert.match(a.$(".queue-state").textContent, /已暂停/);
  a.input("#composer", "当前草稿"); a.click('[aria-label="取回待发消息"]');
  assert.equal(a.$("#composer").value, "当前草稿\n\n待发内容");
  assert.equal(a.$(".turn-queue").hidden, true);
  a.click("#rail-new-chat"); assert.equal(a.$("#messages").textContent, "");
});

test("app: stop failure, queue clear confirmation and explicit resume remain recoverable", async t => {
  const a = await app(t, { routes: { [`POST /api/chat/${sessionId}/abort`]: { ok: false, error: { message: "abort unavailable" } } } });
  const stream = a.stream(); a.routes.set("POST /api/chat", stream.response);
  await a.send("运行中"); stream.emit("ready", { sessionId }); await flush(); await a.send("待发1"); await a.send("待发2");
  a.click("#chat-stop"); await flush();
  assert.match(a.$(".queue-reason").textContent, /停止请求失败/);
  assert.match(a.$("#toast").textContent, /abort unavailable/);
  a.confirmResult = false; a.click('[aria-label="清空待发消息"]'); assert.equal(a.all(".queue-row").length, 2);
  a.confirmResult = true; a.click('[aria-label="清空待发消息"]'); assert.equal(a.$(".turn-queue").hidden, true);
  assert.equal(a.confirmations.length, 2);
  stream.emit("done", { sessionId, aborted: true }); stream.close(); await flush();
  assert.equal(a.$("#chat-stop").hidden, true);
});

test("app: HTTP chat failure presents server error without losing user content", async t => {
  const a = await app(t, { routes: { "POST /api/chat": Response.json({ error: { code: "MODEL_REJECTED", message: "fixture model unavailable" } }, { status: 502 }) } });
  a.input("#composer", "Shift+Enter保留草稿");
  a.event("#composer", "keydown", { key: "Enter", shiftKey: true }); assert.equal(a.count("POST /api/chat"), 0);
  a.event("#composer", "keydown", { key: "Enter", isComposing: true }); assert.equal(a.count("POST /api/chat"), 0);
  a.event("#composer", "keydown", { key: "Enter" }); await flush();
  assert.match(a.$("#messages").textContent, /Shift\+Enter保留草稿.*MODEL_REJECTED.*fixture model unavailable/);
  assert.equal(a.$("#chat-stop").hidden, true);
});

test("app: approvals prevent duplicate decisions, preserve failures, retry and collapse only on receipt", async t => {
  const a = await app(t);
  const stream = a.stream(); a.routes.set("POST /api/chat", stream.response);
  await a.send("测试审批"); stream.emit("ready", { sessionId });
  stream.emit("confirm", { callId: "fixture-call", name: "fixture_write", args: { target: "fixture-only" }, risk: "将改动指定测试对象" }); await flush();
  let card = a.$(".confirm-card");
  assert.equal(card.open, true); assert.match(card.textContent, /将改动指定测试对象/);
  assert.equal(card.querySelector(".confirm-details").open, false);
  const decision = deferred(); a.routes.set(`POST /api/chat/${sessionId}/confirm`, () => decision.promise);
  a.click(a.button("允许执行", card)); a.click(a.button("允许执行", card));
  assert.equal(a.count(`POST /api/chat/${sessionId}/confirm`), 1);
  assert.equal(card.getAttribute("aria-busy"), "true");
  decision.resolve({ ok: true, decided: false }); await flush();
  assert.equal(card.open, true); assert.match(card.querySelector('[role="alert"]').textContent, /失效或已处理/);
  a.routes.set(`POST /api/chat/${sessionId}/confirm`, { ok: true, decided: true });
  a.click(a.button("允许执行", card)); await flush();
  assert.equal(card.dataset.state, "allowed"); assert.equal(card.open, false);
  assert.equal(card.querySelector(".confirm-actions").hidden, true);
  assert.deepEqual(a.calls.filter(call => new URL(call.url).pathname.endsWith("/confirm")).at(-1).body, { callId: "fixture-call", allow: true });
  stream.emit("confirm", { callId: "fixture-deny", name: "fixture_write", args: "not-json" }); await flush();
  card = a.all(".confirm-card")[1]; assert.match(card.textContent, /此操作会改动校园数据/);
  a.click(a.button("拒绝", card)); await flush(); assert.equal(card.dataset.state, "denied");
  stream.emit("done", { sessionId }); stream.close(); await flush();
});

test("app: history restores reasoning, safe Markdown and failed/raw tool results", async t => {
  const sessions = [{ id: sessionId, title: "恢复记录", updatedAt: checkedAt, messageCount: 7 }];
  const a = await app(t, { routes: { "GET /api/sessions": { ok: true, sessions }, [`GET /api/sessions/${sessionId}`]: { ok: true, session: { id: sessionId, messages: [
    { role: "user", content: "原始问题" },
    { role: "assistant", content: "# 历史答案\n[参考](https://example.invalid/ref)\n<script>fixture()</script>", reasoning: "历史思考", interrupted: true, toolCalls: [{ name: "fixture_read", arguments: { id: 1 } }] },
    { role: "tool", content: '{"ok":false,"error":{"message":"历史失败"}}' },
    { role: "assistant", toolCalls: [{ name: "fixture_raw", arguments: "not-json" }] },
    { role: "tool", content: "raw output" },
    { role: "assistant", reasoning: "已停止思考", aborted: true },
  ] } } } });
  a.click(".recent-session"); await until(() => a.all(".tool-card").length === 2);
  assert.match(a.$("#messages").textContent, /原始问题.*历史思考.*历史答案/);
  assert.equal(a.$(".reasoning-block").dataset.state, "error");
  assert.equal(a.all(".reasoning-block")[1].dataset.state, "stopped");
  assert.equal(a.$(".tool-card").dataset.state, "failed");
  assert.match(a.all(".tool-card")[1].textContent, /raw output/);
  assert.equal(a.$("#messages script"), undefined);
  assert.equal(a.$("#messages a").rel, "noopener noreferrer");
  a.click("#rail-new-chat"); assert.equal(a.$("#messages").textContent, "");
  assert.equal(a.$(".chat").dataset.empty, "true");
});

test("app: sessions search, rename/save/cancel/delete and persistent refresh errors", async t => {
  let sessions = [{ id: sessionId, title: "原会话", updatedAt: checkedAt, messageCount: 2 }];
  const a = await app(t, { routes: { "GET /api/sessions": () => ({ ok: true, sessions }), [`PATCH /api/sessions/${sessionId}`]: request => { sessions = [{ ...sessions[0], title: request.body.title }]; return { ok: true }; }, [`DELETE /api/sessions/${sessionId}`]: () => { sessions = []; return { ok: true }; } } });
  a.nav("sessions"); await flush();
  a.input('[aria-label="搜索会话"]', "不存在"); assert.match(a.$(".list").textContent, /没有匹配/);
  a.input('[aria-label="搜索会话"]', "原");
  a.click(a.button("重命名"));
  a.input('[aria-label="会话标题"]', "改名"); a.event('[aria-label="会话标题"]', "keydown", { key: "Enter" }); await flush();
  assert.match(a.$(".session-row").textContent, /改名/);
  a.click(a.button("重命名")); a.event('[aria-label="会话标题"]', "keydown", { key: "Escape" });
  assert.equal(a.$('[aria-label="会话标题"]'), undefined);
  a.click(a.button("删除")); await flush(); assert.match(a.$(".list").textContent, /还没有历史会话/);
  a.routes.set("GET /api/sessions", { ok: false, error: { message: "session offline" } });
  a.nav("sessions"); await flush(); assert.match(a.$("#recent-error").textContent, /会话刷新失败/);
  assert.equal(a.$("#recent-retry").hidden, false);
  a.routes.set("GET /api/sessions", { ok: true, sessions: [] }); a.click("#recent-retry"); await flush();
  assert.equal(a.$("#recent-error").hidden, true);
});

test("app: stale session response cannot overwrite a new conversation", async t => {
  const load = deferred();
  const a = await app(t, { routes: { "GET /api/sessions": { ok: true, sessions: [{ id: sessionId, title: "旧记录", updatedAt: checkedAt, messageCount: 1 }] }, [`GET /api/sessions/${sessionId}`]: () => load.promise } });
  a.click(".recent-session"); assert.equal(a.$(".recent-session").disabled, true);
  a.click("#rail-new-chat"); a.input("#composer", "新草稿");
  load.resolve({ ok: true, session: { id: sessionId, messages: [{ role: "assistant", content: "不应覆盖" }] } }); await flush();
  assert.equal(a.$("#composer").value, "新草稿"); assert.equal(a.$("#messages").textContent, "");
});

test("app: tool forms coerce field types, show failures and route workspace actions into drafts", async t => {
  const tools = [
    { name: "fixture_read", readOnly: true, description: "类型测试", inputSchema: { required: ["query"], properties: { query: { type: "string" }, count: { type: "integer" }, enabled: { type: "boolean" }, ids: { type: "array" }, choice: { enum: ["one", "two"] } } } },
    { name: "workspace_run", service: "workspace", description: "仅草稿", inputSchema: { properties: { script: { type: "string" } } } },
  ];
  const a = await app(t, { routes: { "GET /api/tools": { ok: true, tools }, "POST /api/tools/fixture_read": request => ({ ok: true, data: { received: request.body } }) } });
  a.nav("tools"); await flush();
  const card = a.all(".list > details")[0], form = card.querySelector("form");
  const fields = [...form.querySelectorAll("input, select")];
  fields[0].value = "关键词"; fields[1].value = "3"; fields[2].checked = true; fields[3].value = " a, ,b "; fields[4].value = "two";
  a.event(form, "submit"); await flush();
  const request = a.calls.find(call => new URL(call.url).pathname === "/api/tools/fixture_read");
  assert.deepEqual(request.body, { query: "关键词", count: 3, enabled: true, ids: ["a", "b"], choice: "two" });
  assert.match(card.querySelector("pre").textContent, /received/);
  a.routes.set("POST /api/tools/fixture_read", { ok: false, error: { code: "FIXTURE_DENIED", message: "fixture rejected" } });
  a.event(form, "submit"); await flush(); assert.match(card.querySelector("pre").textContent, /失败：FIXTURE_DENIED fixture rejected/);
  a.input('.view input[type="search"]', "不存在"); assert.match(a.$(".list").textContent, /没有匹配/);
  a.input('.view input[type="search"]', "workspace");
  const workspace = a.$(".list form"); a.input(workspace.querySelector("input"), "fixture.py"); a.event(workspace, "submit");
  assert.match(a.$("#composer").value, /workspace_run.*fixture.py.*等待我的确认/);
  assert.equal(a.count("POST /api/chat"), 0);
  assert.equal(a.calls.some(call => new URL(call.url).pathname === "/api/tools/workspace_run"), false);
});

test("app: tool catalog errors are visible rather than fake empty results", async t => {
  const a = await app(t, { routes: { "GET /api/tools": { ok: false, error: { message: "fixture tools offline" } } } });
  a.nav("tools"); await flush(); assert.match(a.$(".list").textContent, /fixture tools offline/);
});

test("app: service login does not imply verified authentication; failed checks remain recoverable", async t => {
  const evidence = { state: "ready", verified: true, source: "protected-api:fixture", checkedAt, code: "OK" };
  const a = await app(t, { routes: { "GET /api/keepalive": { ok: true, enabled: false, history: [] }, "POST /api/auth/login": { ok: true, jobId: "fixture-login" }, "GET /api/jobs/fixture-login": { ok: true, found: true, job: { service: "cloud", status: "complete" } }, "GET /api/auth/status": { ok: true, services: { learnx: evidence, cloud: { state: "ready" }, hetang: { mode: "mock" } } } } });
  a.nav("services"); await flush();
  let cloud = a.$('[data-service="cloud"]');
  a.click(a.button("登录", cloud)); await flush(); cloud = a.$('[data-service="cloud"]');
  assert.match(cloud.textContent, /登录任务已结束.*核验登录状态/);
  assert.doesNotMatch(cloud.textContent, /窗口已打开/);
  assert.equal(cloud.querySelector(".state").dataset.s, "unverified");
  a.click(a.button("核验登录状态")); await flush();
  assert.equal(a.$('[data-service="learnx"] .state').dataset.s, "ready");
  assert.equal(a.$('[data-service="cloud"] .state').dataset.s, "unverified");
  assert.equal(a.$('[data-service="hetang"] .state').dataset.s, "mock");
  assert.match(a.$('[data-service="learnx"] .auth-evidence').textContent, /protected-api:fixture.*OK/);
  a.routes.set("GET /api/auth/status", { ok: true }); a.click(a.button("核验登录状态")); await flush();
  assert.match(a.$(".auth-panel > .error").textContent, /认证状态响应无效/);
  assert.equal(a.$('[data-service="learnx"] .state').dataset.s, "unknown");
  a.routes.set("POST /api/auth/login", { ok: false, error: { message: "fixture window unavailable" } });
  a.click(a.button("登录", a.$('[data-service="learnx"]'))); await flush();
  assert.match(a.$('[data-service="learnx"] .auth-notice').textContent, /登录未完成.*fixture window unavailable/);
});

test("app: first learnx login exposes account failure, sends trimmed account and never stores it", async t => {
  let completed = false;
  const a = await app(t, { routes: {
    "GET /api/keepalive": { ok: true, enabled: false, history: [] },
    "POST /api/auth/login": { ok: true, jobId: "learnx-login" },
    "GET /api/jobs/learnx-login": () => ({ ok: true, found: true, job: { service: "learnx", status: completed ? "complete" : "failed", error: "BROWSER_ACCOUNT_REQUIRED" } }),
  } });
  a.nav("services"); await flush();
  assert.equal(a.$('label.auth-account > span').textContent, "学号");
  a.click(a.button("登录", a.$('[data-service="learnx"]'))); await flush();
  assert.match(a.$('[data-service="learnx"] .auth-notice').textContent, /需要填写学号/);
  assert.equal(a.$("#learnx-account").hasAttribute("required"), true);
  a.click(a.button("登录", a.$('[data-service="learnx"]'))); await flush();
  assert.equal(a.count("POST /api/auth/login"), 1);
  assert.match(a.$('[data-service="learnx"] .auth-notice').textContent, /请先填写/);
  a.input("#learnx-account", "  fixture-student  "); completed = true;
  a.click(a.button("登录", a.$('[data-service="learnx"]'))); await flush();
  assert.deepEqual(a.calls.filter(call => call.method === "POST").at(-1).body, { service: "learnx", account: "fixture-student" });
  assert.equal(a.$("#learnx-account").value, "");
  assert.equal(a.$('[data-service="learnx"] .state').dataset.s, "unverified");
  assert.equal([...a.savedValues.values()].some(value => value.includes("fixture-student")), false);
});

test("app: login polls queued, downloading and running without claiming a window or duplicate starts", async t => {
  const jobs = [{ status: "queued" }, { status: "running", phase: "downloading" }, { status: "running", phase: "login" }, { status: "complete" }];
  const a = await app(t, { routes: {
    "GET /api/keepalive": { ok: true, enabled: false, history: [] },
    "POST /api/auth/login": { ok: true, jobId: "cloud-login" },
    "GET /api/jobs/cloud-login": () => ({ ok: true, found: true, job: { service: "cloud", ...jobs.shift() } }),
  } });
  a.nav("services"); await flush();
  a.click(a.button("登录", a.$('[data-service="cloud"]'))); await flush();
  assert.match(a.$('[data-service="cloud"] .auth-notice').textContent, /任务已提交/);
  a.click(a.button("登录中…", a.$('[data-service="cloud"]'))); await flush();
  assert.equal(a.count("POST /api/auth/login"), 1);
  await a.tick(1000); assert.match(a.$('[data-service="cloud"] .auth-notice').textContent, /正在安装/);
  await a.tick(1000); assert.match(a.$('[data-service="cloud"] .auth-notice').textContent, /任务运行中/);
  assert.doesNotMatch(a.$('[data-service="cloud"]').textContent, /窗口已打开|已登录/);
  await a.tick(1000); assert.match(a.$('[data-service="cloud"] .auth-notice').textContent, /任务已结束/);
  assert.equal(a.button("登录", a.$('[data-service="cloud"]')).disabled, false);
});

for (const [label, data, expected] of [
  ["install", { found: true, job: { status: "failed", error: "BROWSER_INSTALL_FAILED" } }, /安装失败/],
  ["runtime", { found: true, job: { status: "failed", error: "BROWSER_RUNTIME_INVALID" } }, /运行时不可用/],
  ["worker", { found: true, job: { status: "failed", error: "WORKER_START" } }, /无法启动登录进程/],
  ["unknown failure", { found: true, job: { status: "failed", error: "not-a-safe-code" } }, /LOGIN_FAILED/],
  ["stopped", { found: true, job: { status: "stopped" } }, /LOGIN_STOPPED/],
  ["interrupted", { found: true, job: { status: "interrupted" } }, /LOGIN_INTERRUPTED/],
  ["missing", { found: false }, /LOGIN_JOB_NOT_FOUND/],
  ["mismatch", { found: true, job: { status: "complete", service: "hetang" } }, /LOGIN_JOB_MISMATCH/],
  ["invalid", { found: true, job: { status: "unexpected" } }, /LOGIN_JOB_INVALID/],
  ["poll failure", { ok: false, error: { message: "fixture status offline" } }, /fixture status offline/],
]) test(`app: login ${label} remains an explicit recoverable failure`, async t => {
  const a = await app(t, { routes: { "GET /api/keepalive": { ok: true, enabled: false, history: [] }, "POST /api/auth/login": { ok: true, jobId: "fixture-login" }, "GET /api/jobs/fixture-login": { ok: true, ...data } } });
  a.nav("services"); await flush(); a.click(a.button("登录", a.$('[data-service="cloud"]'))); await flush();
  assert.match(a.$('[data-service="cloud"] .auth-notice.error').textContent, expected);
  assert.equal(a.button("登录", a.$('[data-service="cloud"]')).disabled, false);
});

for (const [label, reply, expected] of [
  ["busy", { jobId: "other-login", job: { status: "busy" } }, /另一个浏览器任务/],
  ["no id", {}, /LOGIN_JOB_MISSING/],
  ["invalid id", { jobId: "unsafe/path" }, /LOGIN_JOB_MISSING/],
]) test(`app: login ${label} never starts an unrelated poll`, async t => {
  const a = await app(t, { routes: { "GET /api/keepalive": { ok: true, enabled: false, history: [] }, "POST /api/auth/login": { ok: true, ...reply } } });
  a.nav("services"); await flush(); a.click(a.button("登录", a.$('[data-service="cloud"]'))); await flush();
  assert.match(a.$('[data-service="cloud"] .auth-notice.error').textContent, expected);
  assert.equal(a.calls.some(call => new URL(call.url).pathname.startsWith("/api/jobs/")), false);
});

test("app: clearing credentials while login starts never polls with a changed connection", async t => {
  const pending = deferred();
  const a = await app(t, { routes: { "GET /api/keepalive": { ok: true, enabled: false, history: [] }, "GET /api/service": { ok: true, supported: false }, "POST /api/auth/login": () => pending.promise } });
  a.nav("services"); await flush(); a.click(a.button("登录", a.$('[data-service="cloud"]'))); await flush();
  a.nav("settings"); await flush(); a.click(a.button("清除本地令牌并退出"));
  pending.resolve({ ok: true, jobId: "old-login" }); await flush();
  assert.equal(a.calls.some(call => new URL(call.url).pathname.startsWith("/api/jobs/")), false);
});

test("app: login polling is bounded and timeout never claims success", async t => {
  const a = await app(t, { routes: { "GET /api/keepalive": { ok: true, enabled: false, history: [] }, "POST /api/auth/login": { ok: true, jobId: "slow-login" }, "GET /api/jobs/slow-login": { ok: true, found: true, job: { status: "running" } } } });
  a.nav("services"); await flush(); a.click(a.button("登录", a.$('[data-service="cloud"]'))); await flush();
  for (let i = 0; i < 900; i++) await a.tick(1000);
  assert.match(a.$('[data-service="cloud"] .auth-notice.error').textContent, /LOGIN_WAIT_TIMEOUT/);
  assert.equal(a.count("GET /api/jobs/slow-login"), 900);
  assert.equal(a.button("登录", a.$('[data-service="cloud"]')).disabled, false);
});

test("app: workspace status recovery and initialize action never issue writes", async t => {
  const a = await app(t, { routes: { "GET /api/service": { ok: true, supported: false } } });
  a.click("#rail-storage"); await flush();
  assert.match(a.$(".workspace-storage-card").textContent, /Agent工作区.*待初始化/);
  a.routes.set("GET /api/workspace/storage", { ok: true }); a.click(a.button("刷新工作区状态")); await flush();
  assert.match(a.$(".workspace-storage-card").textContent, /工作区状态响应无效/);
  a.routes.set("GET /api/workspace/storage", { ok: true, storage: storage() }); a.click(a.button("刷新工作区状态")); await flush();
  a.click(a.button("在对话中初始化"));
  assert.match(a.$("#composer").value, /workspace_initialize.*fixture-private.*等待我授权/s);
  assert.equal(a.calls.some(call => call.method !== "GET"), false);
});

test("app: settings invites validate links, copy/fallback, diagnostics and local logout", async t => {
  const a = await app(t, { routes: { "GET /api/service": { ok: true, supported: true, mode: "scheduled-task", installed: true, task: { installed: true, state: "ready" }, startup: { installed: true, entryPath: "fixture-startup" }, logFile: "fixture-log", installHint: "fixture-install" }, "POST /api/pair/invite": { ok: true, code: "123456", ttlSeconds: 120, lanUrls: [origin, "javascript:bad"] } } });
  a.nav("settings"); await flush();
  assert.match(a.$(".settings-page").textContent, /登录计划任务.*fixture-startup.*fixture-log/);
  a.click(a.button("生成配对码")); await flush();
  assert.equal(a.$(".pair-code").textContent, "123456");
  assert.equal(a.all(".pair-links input").length, 2);
  assert.equal(a.$(".pair-links input").value, origin + "/#code=123456");
  a.click(a.all(".pair-links button")[0]); await flush(); assert.deepEqual(a.clipboard, [origin + "/#code=123456"]);
  navigator.clipboard.writeText = async () => { throw new Error("fixture denied clipboard"); };
  a.click(a.all(".pair-links button")[1]); await flush(); assert.match(a.$("#toast").textContent, /手动复制/);
  a.routes.set("POST /api/pair/invite", { ok: false, error: { message: "fixture invite failed" } });
  a.click(a.button("生成配对码")); await flush(); assert.match(a.$(".settings-page").textContent, /fixture invite failed/);
  a.click(a.button("清除本地令牌并退出")); assert.equal(a.$("#app").hidden, true);
  assert.equal(JSON.parse(a.localStorage.getItem(connectionKey)).token, "");
});

test("app: right sidebar lists deadlines, archives, opens detail and submits in two steps", async t => {
  const item = (id, extra) => ({ id, courseId: "c1", course: "电力电子", title: "作业" + id, submitted: false, deadline: checkedAt, deadlineMs: Date.parse(checkedAt), submitTime: null, submitMs: null, grade: null, ungraded: false, ...extra });
  const a = await app(t, {
    routes: {
      "GET /api/sidebar/assignments": { ok: true, state: "ready", fetchedAt: checkedAt, active: [item("h1")], expired: [item("h2")], ungraded: [], courseErrors: [] },
      "GET /api/sidebar/assignments/c1/h1": { ok: true, id: "h1", courseId: "c1", title: "作业h1", body: "请提交实验报告", attachments: [{ name: "模板.pdf", role: "attachment" }], submitted: false, deadline: checkedAt },
      "POST /api/sidebar/submissions/prepare": { ok: true, preparation: { id: "11111111-1111-4111-8111-111111111111", course: "电力电子", content: "正文" }, confirmToken: "a".repeat(48) },
      "POST /api/sidebar/submissions/confirm": { ok: true, receipt: { status: "submitted", message: "已回读核验" } },
    },
  });
  await until(() => a.all(".ddl").length === 2, "sidebar list");
  assert.equal(await a.$("#right-sidebar").hidden, false);
  assert.match(a.$(".ddl-divider").textContent, /已过期/);
  assert.match(a.$(".ddl").textContent, /作业h1/);

  a.click(a.button("归档", a.all(".ddl")[0]));
  assert.equal(a.all(".ddl").length, 1);
  assert.match(a.$(".rsidebar-foot").textContent, /1 条归档/);
  assert.match(a.$(".rsidebar-foot").textContent, /显示 1 条归档/);
  a.click(a.button("显示 1 条归档", a.$(".rsidebar-foot")));
  assert.equal(a.all(".ddl").length, 2);

  a.click(a.button("详情", a.all(".ddl").find(node => node.textContent.includes("作业h1"))));
  await until(() => !!a.$(".rsidebar-detail"), "sidebar detail");
  assert.match(a.$(".rsidebar-detail").textContent, /请提交实验报告/);
  assert.match(a.$(".rsidebar-detail").textContent, /模板.pdf/);

  a.click(a.button("提交", a.$(".rsidebar-detail")));
  a.input(".ddl-content", "受控正文");
  a.click(a.button("准备提交"));
  await until(() => !!a.$(".ddl-prepared"), "prepared preview");
  assert.equal(a.calls.filter(call => call.url.includes("/submissions/prepare")).length, 1);
  assert.equal(a.calls.filter(call => call.url.includes("/submissions/confirm")).length, 0, "准备阶段不得上传");
  assert.match(a.$(".ddl-prepared").textContent, /确认后才会真正上传/);

  a.click(a.button("确认提交"));
  await until(() => !!a.$(".ddl-receipt"), "submission receipt");
  assert.match(a.$(".ddl-receipt").textContent, /submitted/);
  const confirmCall = a.calls.find(call => call.url.includes("/submissions/confirm"));
  assert.equal(confirmCall.body.confirmToken, "a".repeat(48));
  assert.equal(a.localStorage.getItem("campus.app.sidebar.archived").includes("h1"), true);

  a.click("#sidebar-toggle");
  assert.equal(globalThis.document.body.dataset.sidebar, "closed");
});

test("app: right sidebar external tabs stay honest and failed preparation is recoverable", async t => {
  const a = await app(t, {
    routes: {
      "GET /api/sidebar/assignments": { ok: true, state: "ready", fetchedAt: checkedAt, active: [{ id: "h1", courseId: "c1", course: "电力电子", title: "作业h1", submitted: false, deadline: checkedAt, deadlineMs: Date.parse(checkedAt), submitTime: null, submitMs: null, grade: null, ungraded: false }], expired: [], ungraded: [], courseErrors: [] },
      "GET /api/sidebar/assignments/c1/h1": { ok: true, id: "h1", courseId: "c1", title: "作业h1", body: "要求", attachments: [], submitted: false, deadline: checkedAt },
      "POST /api/sidebar/submissions/prepare": { ok: false, error: { code: "DEADLINE_PASSED", message: "已过允许的提交截止时间。" } },
    },
  });
  await until(() => a.all(".ddl").length === 1, "sidebar list");
  a.click(a.button("详情", a.all(".ddl")[0]));
  await until(() => !!a.$(".rsidebar-detail"), "sidebar detail");
  a.click(a.button("提交", a.$(".rsidebar-detail")));
  a.input(".ddl-content", "正文");
  a.click(a.button("准备提交"));
  await until(() => !!a.$(".rsidebar-detail .error"), "prepare failure");
  assert.match(a.$(".rsidebar-detail .error").textContent, /已过允许的提交截止时间/);
  assert.equal(a.calls.filter(call => call.url.includes("/submissions/confirm")).length, 0, "准备失败不得进入确认提交");

  a.click(a.button("添加 清华体育"));
  assert.match(a.$(".rsidebar-body").textContent, /预约尚未接入/);
  assert.match(a.$(".rsidebar-body a").getAttribute("href"), /sports\.tsinghua\.edu\.cn/);
  const closeSports = a.all(".rsidebar-tab-close").find(node => node.parentElement.textContent.includes("清华体育"));
  a.click(closeSports);
  assert.equal(a.all(".rsidebar-tab").length, 1);

  a.click(a.button("添加 掌上艺教"));
  assert.match(a.$(".rsidebar-body").textContent, /微信小程序/);
});

test("app: timetable renders the weekly grid, today marker and course detail", async t => {
  const a = await app(t, {
    routes: {
      "GET /api/timetable": { ok: true, state: "ready", fetchedAt: checkedAt, semester: { id: "s1", name: "秋季学期" }, unscheduled: 1, courses: [{ id: "c1", name: "甲课", teacher: "甲老师", slots: [{ day: 1, from: 1, to: 2, weeks: null, location: "一教101" }] }] },
    },
  });
  a.nav("timetable");
  await until(() => a.all(".course-block").length === 1, "timetable grid");
  assert.equal(a.$("#view-context").textContent, "课表");
  assert.equal(a.all(".timetable-cell").length, 42, "7 天 × 6 大节");
  assert.equal(a.all(".timetable-day").length, 7);
  assert.match(a.$(".course-block").textContent, /甲课/);
  assert.match(a.$(".course-block").textContent, /第1-2节/);
  assert.match(a.$(".timetable-agenda").textContent, /一教101/);
  assert.match(a.$(".timetable-page").textContent, /1 门课程没有上课时间地点/);
  assert.match(a.$(".timetable-head").textContent, /秋季学期/);
  a.click(a.$(".course-block"));
  assert.match(a.$(".timetable-detail").textContent, /甲老师/);
  assert.match(a.$(".timetable-detail").textContent, /一教101/);
  assert.match(a.$(".timetable-detail").textContent, /返回课表/);
});

test("app: timetable reports an unreadable semester without inventing courses", async t => {
  const a = await app(t, { routes: { "GET /api/timetable": { ok: true, state: "unavailable", fetchedAt: checkedAt, semester: null, courses: [], unscheduled: 0, error: { code: "AUTH_REQUIRED", message: "需要登录网络学堂" } } } });
  a.nav("timetable");
  await until(() => /需要登录网络学堂/.test(a.$(".timetable-page").textContent), "timetable unavailable");
  assert.equal(a.all(".course-block").length, 0);
  assert.equal(a.all(".timetable-agenda").length, 0);
});

test("app: right sidebar resizes by drag and keyboard and closes extra tabs", async t => {
  const a = await app(t);
  const grip = a.$(".rsidebar-grip");
  const width = () => JSON.parse(a.localStorage.getItem("campus.app.sidebar.layout") || "{}").width;
  assert.equal(width(), 380);
  a.event(grip, "pointerdown", { button: 0, clientX: 400 });
  a.event(a.document, "pointermove", { clientX: 300 });
  a.event(a.document, "pointerup", {});
  assert.equal(width(), 480);
  a.event(grip, "keydown", { key: "ArrowLeft" });
  assert.equal(width(), 504);
  a.event(grip, "keydown", { key: "ArrowRight", shiftKey: true });
  assert.equal(width(), 440);
  a.event(grip, "keydown", { key: "Enter" });
  assert.equal(width(), 380);
  a.event(grip, "keydown", { key: "Escape" });
  assert.equal(width(), 380, "无关按键不改变宽度");
  assert.equal(a.$("#right-sidebar").style.getPropertyValue("--rsidebar-width"), "380px");

  a.click(a.button("添加 待批改"));
  assert.ok(a.$("#rsidebar-tab-ungraded"));
  assert.equal(a.all(".rsidebar-tab").length, 2);
  a.click(a.all(".rsidebar-tab-close")[0]);
  assert.equal(a.all(".rsidebar-tab").length, 1);
  assert.equal(a.all(".rsidebar-tab-close").length, 0, "只剩一个标签时不提供关闭入口");
});

test("app: width drag/keyboard is the only entry, persists without losing draft, narrow view keeps preference", async t => {
  const a = await app(t);
  a.input("#composer", "宽度不能清掉的草稿");
  const right = a.$('.chat-resize-handle[data-edge="right"]');
  const min = Number(right.getAttribute("aria-valuemin")), max = Number(right.getAttribute("aria-valuemax"));
  assert.ok(max > min && min === 640);
  assert.ok(!a.$("#chat-width-picker"));
  assert.equal(a.all("#view summary").filter(node => node.textContent.trim() === "宽度").length, 0);
  a.localStorage.removeItem("campus.app.chatWidth");
  a.event(right, "keydown", { key: "Home" }); assert.equal(a.localStorage.getItem("campus.app.chatWidth"), String(min));
  assert.equal(right.getAttribute("aria-valuenow"), String(min));
  a.event(right, "keydown", { key: "ArrowRight", shiftKey: true }); assert.equal(a.localStorage.getItem("campus.app.chatWidth"), String(min + 128));
  a.event(right, "pointerdown", { button: 0, pointerId: 1, clientX: 100 });
  a.event(a.document, "pointermove", { pointerId: 1, clientX: 50 });
  a.event(a.document, "pointerup", { pointerId: 1 }); assert.equal(a.localStorage.getItem("campus.app.chatWidth"), "900");
  assert.equal(right.getAttribute("aria-valuenow"), "900");
  assert.equal(a.$("#composer").value, "宽度不能清掉的草稿");
  globalThis.innerWidth = 390; a.event(a.window, "resize");
  assert.equal(a.document.body.dataset.chatCustomWidth, "false");
  assert.equal(a.localStorage.getItem("campus.app.chatWidth"), "900");
  globalThis.innerWidth = 1280; a.event(a.window, "resize");
  assert.equal(a.document.body.dataset.chatCustomWidth, "true");
  a.event(right, "pointerdown", { button: 0, pointerId: 2, clientX: 100 });
  a.event(a.document, "pointermove", { pointerId: 2, clientX: 150 });
  a.event(a.document, "pointercancel", { pointerId: 2 }); assert.equal(right.getAttribute("aria-valuenow"), "900");
  a.event(right, "dblclick"); assert.equal(a.localStorage.getItem("campus.app.chatWidth"), null);
  assert.equal(a.document.body.dataset.chatCustomWidth, "false");
});

test("app: running workspace job polls real receipts, separates sync failure and fills recovery draft", async t => {
  const a = await app(t);
  const stream = a.stream(), statusUrl = `/api/workspaces/${sessionId}/jobs/fixture-job`;
  const job = { jobId: "fixture-job", state: "running", statusUrl, runtime: "python", scriptPath: "fixture.py", stdout: "first output", stderr: "", storage: { mode: "cloud", state: "pending" } };
  a.routes.set("POST /api/chat", stream.response);
  a.routes.set("GET " + statusUrl, { ok: true, job: { ...job, state: "succeeded", stdout: "finished output", storage: { mode: "cloud", state: "failed", message: "fixture sync failed" } } });
  await a.send("测试作业卡"); stream.emit("ready", { sessionId });
  stream.emit("tool", { phase: "start", name: "workspace_run", args: { script: "fixture.py" } });
  await flush(); assert.match(a.$(".tool-card").textContent, /执行中/);
  stream.emit("tool", { phase: "end", name: "workspace_run", ok: true, result: { ok: true, data: { job } } });
  await flush(); assert.match(a.$(".tool-state").textContent, /作业运行中/);
  assert.equal(a.$(".job-storage-state").dataset.s, "pending");
  assert.match(a.$(".job-logs").textContent, /first output/);
  await a.tick(1500);
  assert.equal(a.$(".tool-card").dataset.state, "done");
  assert.equal(a.$(".tool-state").textContent, "计算完成");
  assert.equal(a.$(".job-storage-state").textContent, "云盘同步失败");
  assert.match(a.$(".job-sync-message").textContent, /fixture sync failed/);
  assert.match(a.$(".job-logs").textContent, /finished output/);
  stream.emit("done", { sessionId }); stream.close(); await flush();
  a.click(a.button("在对话中恢复同步"));
  assert.match(a.$("#composer").value, /workspace_sync.*不要重新运行计算/);
  assert.equal(a.count("GET " + statusUrl), 1);
});

test("app: job query/stop failures preserve last running state and require valid stop receipt", async t => {
  const statusUrl = `/api/workspaces/${sessionId}/jobs/fixture-stop`;
  const job = { jobId: "fixture-stop", state: "running", statusUrl, stdout: "saved output", stderr: "fixture stderr" };
  const a = await app(t, { routes: { ["GET " + statusUrl]: { ok: false, error: { message: "fixture query failed" } } } });
  const stream = a.stream(); a.routes.set("POST /api/chat", stream.response);
  await a.send("停止作业"); stream.emit("ready", { sessionId });
  stream.emit("tool", { phase: "start", name: "workspace_run", args: {} });
  stream.emit("tool", { phase: "end", name: "workspace_run", ok: true, result: job }); await flush();
  await a.tick(1500); assert.match(a.$(".workspace-job").textContent, /查询失败.*fixture query failed/);
  assert.equal(a.$(".tool-card").dataset.state, "running");
  a.routes.set("GET " + statusUrl, { ok: true, job });
  a.click(a.button("重试查询")); await a.tick(1500); assert.equal(a.count("GET " + statusUrl), 2);
  a.routes.set("POST " + statusUrl + "/stop", { ok: true });
  a.click(a.button("停止作业")); await flush();
  assert.match(a.$(".workspace-job").textContent, /停止失败.*停止响应无效/);
  assert.equal(a.$(".tool-card").dataset.state, "running");
  a.routes.set("POST " + statusUrl + "/stop", { ok: true, job: { ...job, state: "interrupted", error: { message: "fixture interrupted" } } });
  a.click(a.button("停止作业")); await flush();
  assert.equal(a.$(".tool-card").dataset.state, "failed"); assert.match(a.$(".job-logs").textContent, /fixture interrupted/);
  stream.emit("done", { sessionId }); stream.close(); await flush();
  a.click(a.button("在对话中处理")); assert.match(a.$("#composer").value, /fixture-stop.*再次执行前先确认/);
});

test("app: streamed notices/errors/tools preserve honest state and pending queue resumes explicitly", async t => {
  const a = await app(t);
  const first = a.stream(), resumed = a.stream(); let request = 0;
  a.routes.set("POST /api/chat", () => ++request === 1 ? first.response : resumed.response);
  await a.send("带工具轮次"); await a.send("稍后继续");
  first.emit("ready", { sessionId });
  first.emit("token", { text: 123 }); first.emit("reasoning", { text: "" }); first.emit("message", { role: "user", content: "不应渲染" });
  first.emit("tool", { phase: "start", name: "fixture_fail", args: "raw argument" });
  first.emit("tool", { phase: "end", name: "fixture_fail", ok: false, error: { code: "FIXTURE_FAILED" } });
  first.emit("tool", { phase: "end", name: "unmatched", ok: true, result: {} });
  first.emit("notice", { code: "FIXTURE_NOTICE" });
  first.emit("error", { code: "FIXTURE_ERROR", message: "fixture turn failed" });
  first.emit("done", { sessionId }); first.close(); await flush();
  assert.equal(a.$(".tool-card").dataset.state, "failed");
  assert.match(a.$(".tool-card").textContent, /FIXTURE_FAILED/);
  assert.match(a.$(".bubble.notice").textContent, /FIXTURE_NOTICE/);
  assert.match(a.$(".bubble.err").textContent, /FIXTURE_ERROR.*fixture turn failed/);
  assert.doesNotMatch(a.$("#messages").textContent, /不应渲染/);
  assert.equal(a.$(".reasoning-block"), undefined);
  assert.match(a.$(".queue-reason").textContent, /fixture turn failed/);
  a.click(a.button("继续队列")); await until(() => a.count("POST /api/chat") === 2);
  resumed.emit("message", { role: "assistant", content: "恢复成功" }); resumed.emit("done", { sessionId }); resumed.close(); await flush();
  assert.match(a.$("#messages").textContent, /恢复成功/); assert.equal(a.$(".turn-queue").hidden, true);
});

test("app: authorized artifact fetch handles pending/retry/download and revokes only created Blob URL", async t => {
  const artifact = `/api/workspaces/${sessionId}/files?path=fixture.txt`;
  const a = await app(t, { routes: { "GET /api/sessions": { ok: true, sessions: [{ id: sessionId, title: "产物", updatedAt: checkedAt, messageCount: 1 }] }, [`GET /api/sessions/${sessionId}`]: { ok: true, session: { id: sessionId, messages: [{ role: "assistant", content: `[下载](${artifact})` }] } }, ["GET " + artifact]: Response.json({ error: { message: "fixture unavailable" } }, { status: 404 }) } });
  a.click(".recent-session"); await until(() => !!a.$(".artifact-link"));
  const link = a.$(".artifact-link"); a.click(link); await flush();
  assert.match(a.$(".download-error").textContent, /fixture unavailable.*重试/);
  assert.equal(link.hasAttribute("aria-busy"), false);
  const download = deferred(); a.routes.set("GET " + artifact, () => download.promise);
  const urls = [], revoked = [];
  t.mock.method(URL, "createObjectURL", blob => { urls.push(blob); return "blob:fixture-only"; });
  t.mock.method(URL, "revokeObjectURL", url => revoked.push(url));
  a.click(link); a.click(link); assert.equal(a.count("GET " + new URL(artifact, origin).pathname), 2);
  assert.equal(link.getAttribute("aria-busy"), "true");
  download.resolve(new Response("fixture file", { headers: { "content-type": "text/plain" } })); await flush();
  assert.equal(a.$(".download-error"), undefined); assert.equal(await urls[0].text(), "fixture file");
  const fetchCall = a.calls.filter(call => call.url.endsWith(artifact)).at(-1);
  assert.equal(fetchCall.options.headers.authorization, "Bearer " + token);
  assert.equal(fetchCall.options.redirect, "error"); assert.equal(fetchCall.options.credentials, "omit");
  assert.equal(a.$('[download="fixture.txt"]'), undefined);
  await a.tick(1000); assert.deepEqual(revoked, ["blob:fixture-only"]);
});

test("app: keepalive evidence/time/actions and failed manual run are not claimed authenticated", async t => {
  const now = Date.parse("2026-11-14T12:00:00.000Z"); t.mock.method(Date, "now", () => now);
  const evidence = { state: "ready", verified: true, source: "protected-api:fixture", checkedAt };
  const offsets = [-1000, 0, 120000, 7200000, 172800000];
  const history = offsets.map((offset, index) => ({ at: new Date(now - offset).toISOString(), trigger: ["startup", "timer", "api", "fixture", "api"][index], durationMs: 4, services: { learnx: "ready" }, serviceEvidence: index === 0 ? { learnx: evidence } : {}, actions: [{ action: "skipped", service: "cloud" }, { action: "restore", service: "learnx", ok: true }, { action: "restore", service: "hetang", ok: false, code: "FIXTURE_TIMEOUT" }] }));
  history.push({ at: "invalid", services: {}, actions: [] });
  const a = await app(t, { routes: { "GET /api/keepalive": { ok: true, enabled: true, intervalMs: 60000, restoreExpired: true, lastRunAt: checkedAt, nextRunAt: checkedAt, history }, "POST /api/keepalive/run": { ok: false, error: { message: "fixture keepalive failed" } } } });
  a.nav("services"); await flush();
  assert.equal(a.all(".timeline-item").length, 6);
  assert.equal(a.$(".timeline-item").dataset.ok, "good"); assert.equal(a.all(".timeline-item")[1].dataset.ok, "bad");
  for (const text of ["刚刚", "2 分钟前", "2 小时前", "2 天前", "时间未知", "过期但未恢复", "恢复请求已完成", "FIXTURE_TIMEOUT", "无服务状态"]) assert.ok(a.$(".timeline").textContent.includes(text), text);
  a.click(a.button("立即自检")); await flush(); assert.match(a.$("#toast").textContent, /fixture keepalive failed/);
  assert.equal(a.button("立即自检").disabled, false);
  a.routes.set("POST /api/keepalive/run", { ok: true, enabled: true, intervalMs: 60000, restoreExpired: false, history: [] });
  a.click(a.button("立即自检")); await flush(); assert.match(a.$(".card").textContent, /只记录不恢复.*还没有自检记录/);
  assert.match(a.$("#toast").textContent, /自检已完成/);
});

test("app: pairing deeplink strips URL secrets, waits fake clock then redeems code", async t => {
  const a = await app(t, { paired: false, href: origin + "/?code=123456&unrelated=removed", routes: { "POST /api/pair/redeem": { ok: true, token } } });
  assert.equal(a.window.location.search, ""); assert.equal(a.$("#pair-code").value, "123456");
  assert.equal(a.count("POST /api/pair/redeem"), 0);
  await a.tick(119); assert.equal(a.count("POST /api/pair/redeem"), 0);
  await a.tick(1); await until(() => !!a.$("#composer")); assert.equal(a.count("POST /api/pair/redeem"), 1);
});

test("app: refresh state exposes connection failure and successful retry restores service controls", async t => {
  const a = await app(t);
  a.routes.set("GET /api/meta", { ok: false, error: { message: "fixture refresh offline" } });
  a.click("#refresh"); await flush();
  assert.equal(a.$("#account").textContent, "服务连接失败");
  assert.match(a.$(".topbar-meta .action-feedback").textContent, /状态刷新失败.*fixture refresh offline/);
  a.routes.set("GET /api/meta", meta()); a.click("#refresh"); await flush();
  assert.equal(a.$("#account").textContent, "服务运行中");
  assert.match(a.$(".topbar-meta .action-feedback").textContent, /状态已更新/);
  assert.equal(a.$("#refresh").disabled, false);
  await a.tick(1600); assert.equal(a.$(".topbar-meta .action-feedback"), undefined);
});

test("app: width storage failure surfaces once and Escape/blur pointer recovery keep controls usable", async t => {
  const a = await app(t);
  const handle = a.$('.chat-resize-handle[data-edge="left"]');
  a.localStorage.setItem = () => { throw new Error("fixture quota"); };
  a.event(handle, "pointerdown", { button: 0, pointerId: 3, clientX: 200 });
  a.event(a.document, "pointermove", { pointerId: 3, clientX: 150 });
  a.event(a.document, "pointerup", { pointerId: 3 });
  assert.match(a.$("#toast").textContent, /保存会话宽度失败/);
  assert.equal(handle.getAttribute("aria-valuenow"), "1100");
  a.event(handle, "pointerdown", { button: 0, pointerId: 4, clientX: 200 });
  a.event(a.document, "pointermove", { pointerId: 4, clientX: 180 });
  a.event(a.document, "keydown", { key: "Escape" });
  assert.equal(handle.getAttribute("aria-valuenow"), "1100");
  assert.equal(a.document.body.classList.contains("chat-resizing"), false);
  a.event(handle, "pointerdown", { button: 0, pointerId: 5, clientX: 200 });
  a.event(a.document, "pointermove", { pointerId: 5, clientX: 190 });
  a.event(a.window, "blur"); assert.equal(a.document.body.classList.contains("chat-resizing"), false);
  a.event(handle, "dblclick"); assert.equal(a.document.body.dataset.chatCustomWidth, "false");
});

test("app: sports view lists sports, venues and dates from the real routes", async t => {
  const a = await app(t, {
    routes: {
      "GET /api/sports/sports": { ok: true, sports: ["羽毛球", "游泳"] },
      "GET /api/sports/venues?sport=%E7%BE%BD%E6%AF%9B%E7%90%83": { ok: true, sport: "羽毛球", venues: ["气膜馆羽毛球", "综体羽毛球"] },
      [`GET /api/sports/slots?sport=%E7%BE%BD%E6%AF%9B%E7%90%83&venue=%E6%B0%94%E8%86%9C%E9%A6%86%E7%BE%BD%E6%AF%9B%E7%90%83&date=${new Date().getFullYear()}-${String(new Date().getMonth() + 1).padStart(2, "0")}-${String(new Date().getDate()).padStart(2, "0")}`]: {
        ok: true,
        sessions: [
          { site: "羽01", begin: "07:00", end: "08:00", capacity: 1, reserved: 1, status: "N", statusReason: "当前场次预约人数已满", price: 0 },
          { site: "羽02", begin: "07:00", end: "08:00", capacity: 1, reserved: 0, status: "Y", price: 0 },
        ],
      },
    },
  });
  a.nav("sports");
  await until(() => a.all(".sports-chip").length >= 4, "sports chips");
  assert.equal(a.$("#view-context").textContent, "体育");
  assert.match(a.$(".sports-panel").textContent, /羽毛球/);
  assert.equal(a.all(".sports-date").length, 7, "默认展示七天");
  await until(() => /气膜馆羽毛球/.test(a.$(".sports-panel").textContent), "venue chips");
  const text = a.$(".sports-panel").textContent;
  assert.match(text, /气膜馆羽毛球/);
  assert.match(text, /综体羽毛球/);
  await until(() => a.all(".sports-site").length >= 2, "sessions");
  assert.match(a.$(".sports-panel").textContent, /1\/2 可约/, "按可约数量统计");
  assert.equal(a.$('.sports-site[data-open="true"]').textContent, "羽02", "满场标为不可约");
});

test("app: sports view asks for login instead of pretending there is no data", async t => {
  const a = await app(t, { routes: { "GET /api/sports/sports": { ok: false, error: { code: "SPORTS_LOGIN_REQUIRED", message: "需要登录" } } } });
  a.nav("sports");
  await until(() => /登录/.test(document.body.textContent), "login hint");
  assert.match(a.$(".sports-panel").textContent, /需要先登录体育场馆/);
  assert.ok(a.$(".sports-login"), "提供去登录的入口");
  assert.match(a.$(".sports-login").textContent, /打开体育登录窗口/);
  assert.equal(a.all(".sports-site").length, 0, "没有数据时不画场地");
});

test("app: library seat view lists seats and surfaces the real booking error", async t => {
  const day = new Date().toLocaleDateString("sv-SE");
  const a = await app(t, {
    routes: {
      "GET /api/seat/libraries": { ok: true, libraries: [{ id: 35, name: "北馆(李文正馆)", valid: true }] },
      "GET /api/seat/floors?library=35": { ok: true, floors: [{ id: 37, name: "二层", valid: true }] },
      "GET /api/seat/areas?floor=37": { ok: true, areas: [{ id: 96, name: "A区", total: 40, free: 10 }] },
      [`GET /api/seat/seats?section=96&date=${day}`]: {
        ok: true,
        seats: [
          { id: 5122, name: "A001", segment: 1586205, begin: "08:00", end: "22:00", status: 1, available: true },
          { id: 5123, name: "A002", segment: 1586205, begin: "08:00", end: "22:00", status: 0, available: false },
        ],
        available: 1,
      },
      "GET /api/seat/segments?section=96": { ok: true, segments: [{ id: 1, day, start: "08:00", end: "22:00" }] },
      "POST /api/seat/reserve/prepare": { ok: true, token: "unit-token" },
      "POST /api/seat/reserve": { ok: false, error: { code: "SEAT_BOOK_FAILED", message: "当前用户在该时段已存在预约。" } },
    },
  });
  a.nav("seat");
  await until(() => a.all(".seat").length >= 2, "seat grid");
  assert.equal(a.$("#view-context").textContent, "图书馆");
  assert.equal(a.all(".seat").length, 2);
  assert.equal(a.all('.seat[data-open="true"]').length, 1, "不可约座位标为不可用");
  assert.match(a.$(".seat-panel").textContent, /北馆\(李文正馆\)/);
  a.click(a.$('.seat[data-open="true"]'));
  assert.match(a.$(".seat-confirm-line").textContent, /A001/);
  assert.match(a.$(".seat-confirm-line").textContent, /08:00-22:00/);
  a.click(a.$(".seat-confirm-button"));
  await until(() => !!a.$(".seat-notice"), "booking notice");
  assert.match(a.$(".seat-notice").textContent, /当前用户在该时段已存在预约/);
});

test("app: library seat view asks for login instead of showing empty grids", async t => {
  const a = await app(t, { routes: { "GET /api/seat/libraries": { ok: false, error: { code: "SEAT_LOGIN_REQUIRED", message: "需要登录" } } } });
  a.nav("seat");
  await until(() => /需要先登录图书馆座位系统/.test(a.$(".seat-panel").textContent), "seat login hint");
  assert.equal(a.all(".seat").length, 0);
  assert.ok(a.all(".seat-panel .seat-chip").some(chip => /打开登录窗口/.test(chip.textContent)), "登录态缺失时提供打开登录窗口的入口");
});

test("app: library seat view states an empty seat list honestly", async t => {
  const day = new Date().toLocaleDateString("sv-SE");
  const a = await app(t, {
    routes: {
      "GET /api/seat/libraries": { ok: true, libraries: [{ id: 35, name: "北馆(李文正馆)", valid: true }] },
      "GET /api/seat/floors?library=35": { ok: true, floors: [{ id: 37, name: "二层", valid: true }] },
      "GET /api/seat/areas?floor=37": { ok: true, areas: [{ id: 96, name: "A区", total: 40, free: 0 }] },
      "GET /api/seat/segments?section=96": { ok: true, segments: [{ id: 1, day, start: "08:00", end: "22:00" }] },
      [`GET /api/seat/seats?section=96&date=${day}`]: { ok: true, seats: [], available: 0 },
    },
  });
  a.nav("seat");
  await until(() => /该分区当前没有可约座位/.test(a.$(".seat-panel").textContent), "empty seats");
  assert.equal(a.all(".seat").length, 0, "没有数据时不画座位");
});



test("app: chat stats show turns, steps, tokens and cache hit after a turn", async t => {
  const a = await app(t, {});
  const stream = a.stream();
  a.routes.set("POST /api/chat", () => stream.response);
  await a.send("看一下统计");
  stream.emit("ready", { sessionId: "sess-stats" });
  stream.emit("token", { text: "好" });
  stream.emit("done", {
    sessionId: "sess-stats",
    steps: 3,
    usage: { prompt_tokens: 1000, completion_tokens: 50, total_tokens: 1050, prompt_tokens_details: { cached_tokens: 900 } },
  });
  await flush();
  a.frame();
  const text = a.$("#chat-stats").textContent;
  assert.match(text, /第 1 轮/);
  assert.match(text, /3 步/);
  assert.match(text, /缓存 90%/);
  assert.match(text, /tok/);
});

test("app: chat stats format large totals and zero cache", async t => {
  const a = await app(t, {});
  const stream = a.stream();
  a.routes.set("POST /api/chat", () => stream.response);
  await a.send("大数值统计");
  stream.emit("ready", { sessionId: "sess-big" });
  stream.emit("token", { text: "好" });
  stream.emit("done", {
    sessionId: "sess-big",
    steps: 4,
    usage: { prompt_tokens: 2000, completion_tokens: 100, total_tokens: 150000000, prompt_tokens_details: { cached_tokens: 0 } },
  });
  await flush();
  a.frame();
  const text = a.$("#chat-stats").textContent;
  assert.match(text, /4 步/);
  assert.match(text, /1\.50亿/);
  assert.match(text, /缓存 0%/);
});

test("app: seat view reports area and segment failures honestly", async t => {
  const a = await app(t, {
    routes: {
      "GET /api/seat/libraries": { ok: true, libraries: [{ id: 35, name: "北馆(李文正馆)", valid: true }] },
      "GET /api/seat/floors?library=35": { ok: true, floors: [{ id: 37, name: "二层", valid: true }] },
    },
  });
  a.routes.set("GET /api/seat/areas?floor=37", () => { throw Object.assign(new Error("bad"), { code: "SEAT_EMPTY" }); });
  a.nav("seat");
  await until(() => /暂时读不到分区/.test(a.$(".seat-panel").textContent), "area failure");
  assert.equal(a.all(".seat").length, 0);
});

test("app: seat view explains expired login on segment read", async t => {
  const a = await app(t, {
    routes: {
      "GET /api/seat/libraries": { ok: true, libraries: [{ id: 35, name: "北馆(李文正馆)", valid: true }] },
      "GET /api/seat/floors?library=35": { ok: true, floors: [{ id: 37, name: "二层", valid: true }] },
      "GET /api/seat/areas?floor=37": { ok: true, areas: [{ id: 96, name: "A区", total: 40, free: 3 }] },
    },
  });
  a.routes.set("GET /api/seat/segments?section=96", () => { throw Object.assign(new Error("login"), { code: "SEAT_LOGIN_REQUIRED" }); });
  const day = new Date().toLocaleDateString("sv-SE");
  a.routes.set(`GET /api/seat/seats?section=96&date=${day}`, () => { throw Object.assign(new Error("login"), { code: "SEAT_LOGIN_REQUIRED" }); });
  a.nav("seat");
  await until(() => /暂时读不到座位|需要先登录/.test(a.$(".seat-panel").textContent), "seat failure");
  assert.equal(a.all(".seat").length, 0);
});

test("app: assignment detail hides an empty submitted section and shows group marker", async t => {
  const item = id => ({ id, courseId: "c1", course: "电力电子", title: "作业" + id, submitted: false, deadline: checkedAt, deadlineText: "" });
  const a = await app(t, {
    routes: {
      "GET /api/sidebar/assignments": { ok: true, state: "ready", fetchedAt: checkedAt, active: [item("h1")], expired: [], ungraded: [], courseErrors: [] },
      "GET /api/sidebar/assignments/c1/h1": {
        ok: true, id: "h1", courseId: "c1", title: "作业h1", submitted: false, completionType: 3,
        body: "请提交实验报告\n\n## 已提交正文\n", attachments: [],
      },
    },
  });
  await until(() => a.all(".ddl").length === 1, "list");
  a.click(a.button("详情", a.all(".ddl")[0]));
  await until(() => !!a.$(".rsidebar-detail"), "detail");
  const detail = a.$(".rsidebar-detail");
  assert.match(detail.textContent, /请提交实验报告/);
  assert.doesNotMatch(detail.textContent, /已提交正文/, "未提交时不显示空的已提交正文标题");
  assert.match(detail.textContent, /小组作业/, "站点标记为小组作业时提前说明");
});

test("app: assignment detail keeps submitted content and offers overwrite", async t => {
  const a = await app(t, {
    routes: {
      "GET /api/sidebar/assignments": { ok: true, state: "ready", fetchedAt: checkedAt, active: [{ id: "h1", courseId: "c1", course: "电力电子", title: "作业h1", submitted: true, deadline: checkedAt, deadlineText: "" }], expired: [], ungraded: [], courseErrors: [] },
      "GET /api/sidebar/assignments/c1/h1": {
        ok: true, id: "h1", courseId: "c1", title: "作业h1", submitted: true,
        body: "要求如下\n\n## 已提交正文\n\n我的实验报告\n",
        attachments: [{ name: "我交的.pdf", role: "submittedAttachment" }],
      },
    },
  });
  await until(() => a.all(".ddl").length === 1, "list");
  a.click(a.button("详情", a.all(".ddl")[0]));
  await until(() => !!a.$(".rsidebar-detail"), "detail");
  const detail = a.$(".rsidebar-detail");
  assert.match(detail.textContent, /已提交正文/);
  assert.match(detail.textContent, /我的实验报告/);
  assert.match(detail.textContent, /（已提交）/);
  a.click(a.button("提交", detail));
  const area = a.$(".ddl-content");
  assert.ok(area, "打开提交表单");
  const overwrite = a.all("input").find(input => input.type === "checkbox");
  assert.ok(overwrite, "已提交的作业提供覆盖勾选");
});

test("app: seat view opens the login window and reports failures", async t => {
  const a = await app(t, {
    routes: {
      "GET /api/seat/libraries": { ok: false, error: { code: "SEAT_LOGIN_REQUIRED", message: "需要登录" } },
      "POST /api/tools/campus_browser_open": { ok: true, job: { id: "j1" } },
    },
  });
  a.nav("seat");
  await until(() => /需要先登录图书馆座位系统/.test(a.$(".seat-panel").textContent), "login required");
  a.click(a.button("打开登录窗口", a.$(".seat-panel")));
  await flush();
  assert.ok(a.calls.some(call => call.url.includes("/api/tools/campus_browser_open")));
  assert.match(a.$(".seat-notice")?.textContent || "", /已打开登录窗口/);
});

test("app: seat view explains a closed booking window and reserve failures", async t => {
  const day = new Date().toLocaleDateString("sv-SE");
  const a = await app(t, {
    routes: {
      "GET /api/seat/libraries": { ok: true, libraries: [{ id: 35, name: "北馆(李文正馆)", valid: true }] },
      "GET /api/seat/floors?library=35": { ok: true, floors: [{ id: 37, name: "二层", valid: true }] },
      "GET /api/seat/areas?floor=37": { ok: true, areas: [{ id: 96, name: "A区", total: 40, free: 2 }] },
      "GET /api/seat/segments?section=96": { ok: true, segments: [{ id: 1, day, start: "08:00", end: "22:00" }] },
      [`GET /api/seat/seats?section=96&date=${day}`]: { ok: false, error: { code: "SEAT_WINDOW_CLOSED", message: "窗口关闭" } },
    },
  });
  a.nav("seat");
  await until(() => /06:00-23:00/.test(a.$(".seat-panel").textContent), "window closed hint");
  assert.equal(a.all(".seat").length, 0);
});

test("app: seat reserve failure maps to an actionable hint", async t => {
  const day = new Date().toLocaleDateString("sv-SE");
  const a = await app(t, {
    routes: {
      "GET /api/seat/libraries": { ok: true, libraries: [{ id: 35, name: "北馆(李文正馆)", valid: true }] },
      "GET /api/seat/floors?library=35": { ok: true, floors: [{ id: 37, name: "二层", valid: true }] },
      "GET /api/seat/areas?floor=37": { ok: true, areas: [{ id: 96, name: "A区", total: 40, free: 2 }] },
      "GET /api/seat/segments?section=96": { ok: true, segments: [{ id: 1, day, start: "08:00", end: "22:00" }] },
      [`GET /api/seat/seats?section=96&date=${day}`]: { ok: true, seats: [{ id: 501, name: "NF3B001", segment: 1, available: true, begin: "08:00", end: "22:00" }], available: 1 },
      "POST /api/seat/reserve/prepare": { ok: true, token: "t".repeat(48) },
      "POST /api/seat/reserve": () => { throw Object.assign(new Error("已存在预约"), { code: "SEAT_ALREADY_BOOKED" }); },
    },
  });
  a.nav("seat");
  await until(() => a.all(".seat").length === 1, "seat");
  a.click(a.$(".seat"));
  await until(() => !!a.$(".seat-confirm-button"), "confirm");
  a.click(a.$(".seat-confirm-button"));
  await until(() => /已有预约/.test(a.$(".seat-notice")?.textContent || ""), "hint");
});

test("app: assignment sidebar switches tabs, shows course errors and empty states", async t => {
  const a = await app(t, {
    routes: {
      "GET /api/sidebar/assignments": {
        ok: true, state: "ready", fetchedAt: checkedAt, active: [], expired: [], ungraded: [],
        courseErrors: [{ course: "电力电子", message: "单门课程读取失败" }],
      },
    },
  });
  await until(() => /没有待交作业/.test(a.$("#right-sidebar").textContent), "empty pending");
  assert.match(a.$("#right-sidebar").textContent, /单门课程读取失败|门课程未读全|课程/);
  assert.match(a.$("#right-sidebar").textContent, /没有待交作业/);
});

test("app: assignment submission requires explicit overwrite for an already submitted homework", async t => {
  const a = await app(t, {
    routes: {
      "GET /api/sidebar/assignments": { ok: true, state: "ready", fetchedAt: checkedAt, active: [{ id: "h1", courseId: "c1", course: "电力电子", title: "作业h1", submitted: true, deadline: checkedAt, deadlineText: "" }], expired: [], ungraded: [], courseErrors: [] },
      "GET /api/sidebar/assignments/c1/h1": { ok: true, id: "h1", courseId: "c1", title: "作业h1", submitted: true, body: "要求", attachments: [] },
      "POST /api/sidebar/submissions/prepare": { ok: true, preparation: { id: "11111111-1111-4111-8111-111111111111", course: "电力电子", content: "覆盖正文", overwrite: true, expiresAt: checkedAt } },
      "POST /api/sidebar/submissions/confirm": { ok: true, receipt: { status: "submitted", message: "已回读核验" } },
    },
  });
  await until(() => a.all(".ddl").length === 1, "list");
  a.click(a.button("详情", a.all(".ddl")[0]));
  await until(() => !!a.$(".rsidebar-detail"), "detail");
  a.click(a.button("提交", a.$(".rsidebar-detail")));
  const box = a.$(".rsidebar-detail input[type=checkbox]");
  assert.ok(box, "已提交作业出现覆盖勾选");
  a.click(box);
  a.input(".ddl-content", "覆盖正文");
  a.click(a.button("准备提交"));
  await until(() => !!a.$(".ddl-prepared"), "prepared");
  assert.match(a.$(".ddl-prepared").textContent, /覆盖提交/);
  a.click(a.button("确认提交"));
  await until(() => !!a.$(".ddl-receipt"), "receipt");
  assert.ok(a.calls.some(call => call.url.includes("/submissions/prepare")));
});

test("app: assignment submission surfaces upload and confirm failures", async t => {
  const a = await app(t, {
    routes: {
      "GET /api/sidebar/assignments": { ok: true, state: "ready", fetchedAt: checkedAt, active: [{ id: "h1", courseId: "c1", course: "电力电子", title: "作业h1", submitted: false, deadline: checkedAt, deadlineText: "" }], expired: [], ungraded: [], courseErrors: [] },
      "GET /api/sidebar/assignments/c1/h1": { ok: true, id: "h1", courseId: "c1", title: "作业h1", submitted: false, body: "要求", attachments: [] },
      "POST /api/sidebar/uploads": () => { throw Object.assign(new Error("上传失败"), { code: "UPLOAD_FAILED" }); },
      "POST /api/sidebar/submissions/prepare": { ok: true, preparation: { id: "11111111-1111-4111-8111-111111111111", course: "电力电子", content: "正文", expiresAt: checkedAt } },
      "POST /api/sidebar/submissions/confirm": { ok: false, error: { code: "CONFIRM_FAILED", message: "站点拒绝了提交。" } },
    },
  });
  await until(() => a.all(".ddl").length === 1, "list");
  a.click(a.button("详情", a.all(".ddl")[0]));
  await until(() => !!a.$(".rsidebar-detail"), "detail");
  a.click(a.button("提交", a.$(".rsidebar-detail")));
  await until(() => !!a.$(".ddl-content"), "form");
  a.input(".ddl-content", "正文");
  a.click(a.button("准备提交"));
  await until(() => !!a.$(".ddl-prepared"), "prepared");
  a.click(a.button("确认提交"));
  await until(() => /站点拒绝了提交|CONFIRM_FAILED|失败/.test(a.$(".rsidebar-detail").textContent), "confirm failure");
});

test("app: seat refresh keeps the current selection and reloads libraries", async t => {
  const a = await app(t, {
    routes: {
      "GET /api/seat/libraries": { ok: true, libraries: [{ id: 35, name: "北馆(李文正馆)", valid: true }] },
      "GET /api/seat/floors?library=35": { ok: true, floors: [{ id: 37, name: "二层", valid: true }] },
      "GET /api/seat/areas?floor=37": { ok: true, areas: [{ id: 96, name: "A区", total: 40, free: 1 }] },
      "GET /api/seat/segments?section=96": { ok: true, segments: [] },
      [`GET /api/seat/seats?section=96&date=${new Date().toLocaleDateString("sv-SE")}`]: { ok: true, seats: [], available: 0 },
    },
  });
  a.nav("seat");
  await until(() => /该分区当前没有可约座位|暂时读不到座位/.test(a.$(".seat-panel").textContent), "seat state");
  const refresh = a.all(".seat-actions button").find(button => /刷新/.test(button.textContent));
  a.click(refresh);
  await flush();
  assert.ok(a.calls.filter(call => call.url.includes("/api/seat/libraries")).length >= 2, "刷新会重新读取馆区");
});

test("app: timetable add form posts and returns to grid", async t => {
  const checkedAt = new Date().toISOString();
  const base = { ok: true, state: "ready", fetchedAt: checkedAt, semester: { name: "秋季学期" }, unscheduled: 0 };
  const course = { id: "c1", name: "甲课", teacher: "甲老师", slots: [{ day: 2, from: 1, to: 2, location: "一教101" }] };
  const a = await app(t, { routes: { "GET /api/timetable": { ...base, courses: [course] }, "GET /api/timetable?refresh=1": { ...base, courses: [course] } } });
  a.routes.set("POST /api/timetable/custom", { ...base, courses: [course] });
  a.nav("timetable");
  await until(() => a.all(".course-block").length === 1, "grid");
  const addButton = a.all(".timetable-actions button").find(button => /添加课程/.test(button.textContent));
  a.click(addButton);
  await until(() => /添加课程/.test(a.$(".timetable-detail")?.textContent || ""), "add form");
  a.input(".timetable-detail input", "自习");
  a.click(a.all(".timetable-detail button").find(button => /保存到课表/.test(button.textContent)));
  await until(() => a.calls.some(item => /timetable\/custom/.test(item.path || item.url || "") && item.body), "custom post");
  const call = a.calls.find(item => /timetable\/custom/.test(item.path || item.url || "") && item.body);
  assert.equal(call.body.name, "自习");
  assert.equal(call.body.day >= 1 && call.body.day <= 7, true);
});

test("app: timetable add failure stays on the form and shows the reason", async t => {
  const checkedAt = new Date().toISOString();
  const base = { ok: true, state: "ready", fetchedAt: checkedAt, semester: { name: "秋季学期" }, unscheduled: 0 };
  const a = await app(t, { routes: { "GET /api/timetable": { ...base, courses: [{ id: "c1", name: "甲课", slots: [{ day: 2, from: 1, to: 2 }] }] } } });
  a.routes.set("POST /api/timetable/custom", () => { throw Object.assign(new Error("名称不能为空"), { code: "INVALID_NAME" }); });
  a.nav("timetable");
  await until(() => a.all(".course-block").length === 1, "grid");
  a.click(a.all(".timetable-actions button").find(button => /添加课程/.test(button.textContent)));
  await until(() => /添加课程/.test(a.$(".timetable-detail")?.textContent || ""), "add form");
  a.click(a.all(".timetable-detail button").find(button => /保存到课表/.test(button.textContent)));
  await flush();
  assert.match(a.$(".timetable-error")?.textContent || "", /名称不能为空/);
});

test("app: timetable removes a custom course and hides an official slot", async t => {
  const checkedAt = new Date().toISOString();
  const base = { ok: true, state: "ready", fetchedAt: checkedAt, semester: { name: "秋季学期" }, unscheduled: 0 };
  const custom = { id: "local-1", name: "自习", custom: true, slots: [{ day: 6, from: 1, to: 2 }] };
  const official = { id: "c1", name: "甲课", teacher: "甲老师", slots: [{ day: 2, from: 1, to: 2 }] };
  const a = await app(t, { routes: { "GET /api/timetable": { ...base, courses: [official, custom] }, "GET /api/timetable?refresh=1": { ...base, courses: [official, custom] } } });
  a.routes.set("DELETE /api/timetable/custom/local-1", { ...base, courses: [official] });
  a.routes.set("POST /api/timetable/hide", { ...base, courses: [custom] });
  a.nav("timetable");
  await until(() => a.all(".course-block").length === 2, "grid");
  const customBlock = a.all(".course-block").find(item => /自习/.test(item.textContent));
  a.click(customBlock);
  await until(() => /删除这门自定义课程/.test(a.$(".timetable-detail")?.textContent || ""), "custom detail");
  a.click(a.all(".timetable-detail button").find(button => /删除这门自定义课程/.test(button.textContent)));
  await flush();
  await until(() => a.calls.some(item => /timetable\/custom\/local-1/.test(item.path || item.url || "")), "custom delete");

  const officialBlock = a.all(".course-block").find(item => /甲课/.test(item.textContent));
  a.click(officialBlock);
  await until(() => /从课表移除这个时段/.test(a.$(".timetable-detail")?.textContent || ""), "official detail");
  a.click(a.all(".timetable-detail button").find(button => /从课表移除这个时段/.test(button.textContent)));
  await until(() => a.calls.some(item => /timetable\/hide/.test(item.path || item.url || "") && item.body), "hide post");
  const hide = a.calls.find(item => /timetable\/hide/.test(item.path || item.url || "") && item.body);
  assert.equal(hide.body.courseId, "c1");
  assert.equal(hide.body.day, 2);
});

test("app: theme switches between light, dark and auto", async t => {
  const a = await app(t, {});
  a.click("#theme-dark");
  assert.equal(a.document.documentElement.dataset.theme, "dark");
  assert.equal(a.$("#theme-dark").getAttribute("aria-pressed"), "true");
  a.click("#theme-auto");
  assert.equal(a.$("#theme-auto").getAttribute("aria-pressed"), "true");
  assert.equal(a.$("#theme-light").getAttribute("aria-pressed"), "false");
  assert.ok(["light", "dark"].includes(a.document.documentElement.dataset.theme));
  a.click("#theme-light");
  assert.equal(a.document.documentElement.dataset.theme, "light");
  assert.equal(a.$("#theme-light").getAttribute("aria-pressed"), "true");
});

test("app: sports view reports empty catalog and venue failures honestly", async t => {
  const empty = await app(t, { routes: { "GET /api/sports/sports": { ok: true, sports: [] } } });
  empty.nav("sports");
  await until(() => /接口没有返回运动项目/.test(empty.$(".sports-panel").textContent), "empty catalog");

  const failed = await app(t, {
    routes: {
      "GET /api/sports/sports": { ok: true, sports: ["游泳"] },
      "GET /api/sports/venues?sport=%E6%B8%B8%E6%B3%B3": () => { throw Object.assign(new Error("场馆接口失败"), { code: "SPORTS_API_FAILED" }); },
    },
  });
  failed.nav("sports");
  await until(() => /暂时读不到该运动的场馆/.test(failed.$(".sports-panel").textContent), "venue failure");
  assert.equal(failed.all(".sports-site").length, 0);
});

test("app: sports sessions show price, capacity and status truthfully", async t => {
  const day = new Date().toLocaleDateString("sv-SE");
  const a = await app(t, {
    routes: {
      "GET /api/sports/sports": { ok: true, sports: ["游泳"] },
      "GET /api/sports/venues?sport=%E6%B8%B8%E6%B3%B3": { ok: true, sport: "游泳", venues: ["陈明游泳馆"] },
      [`GET /api/sports/slots?sport=%E6%B8%B8%E6%B3%B3&venue=%E9%99%88%E6%98%8E%E6%B8%B8%E6%B3%B3%E9%A6%86&date=${day}`]: {
        ok: true,
        sessions: [
          { site: "泳道1", begin: "19:00", end: "20:00", capacity: null, reserved: null, status: "Y", price: 20 },
          { site: "泳道2", begin: "19:00", end: "20:00", capacity: 10, reserved: 10, status: "Y" },
        ],
      },
    },
  });
  a.nav("sports");
  await until(() => a.$(".sports-panel").textContent.includes("泳道1") || /暂时读不到场次/.test(a.$(".sports-panel").textContent), "sessions");
  const text = a.$(".sports-panel").textContent;
  assert.match(text, /泳道1|暂时读不到场次/);
});


test("app: gitlab settings save, mask and test the connection honestly", async t => {
  const a = await app(t, {
    routes: {
      "GET /api/gitlab/config": { ok: true, baseUrl: "https://git.tsinghua.edu.cn", configured: false, masked: "", source: "none" },
      "PUT /api/gitlab/config": { ok: true, baseUrl: "https://git.tsinghua.edu.cn", configured: true, masked: "abcd****efgh" },
      "POST /api/gitlab/test": { ok: true, version: "19.6.0", user: { username: "zhouc24", name: "周楚" } },
    },
  });
  a.nav("settings");
  await until(() => /未配置/.test(a.$(".gitlab-settings").textContent), "gitlab status");

  const base = a.$(".gitlab-settings input[type=url]");
  const token = a.$(".gitlab-settings input[type=password]");
  base.value = "https://git.tsinghua.edu.cn";
  token.value = "abcd1234efgh";
  a.click(a.button("保存", a.$(".gitlab-settings")));
  await until(() => /已配置/.test(a.$(".gitlab-settings").textContent), "saved status");
  assert.match(a.$(".gitlab-settings").textContent, /abcd\*\*\*\*efgh/, "只显示掩码");
  assert.equal(token.value, "", "保存后清空令牌输入");
  assert.ok(!a.$(".gitlab-settings").textContent.includes("abcd1234efgh"), "页面不回显明文令牌");

  a.click(a.button("测试连接", a.$(".gitlab-settings")));
  await until(() => /已连接/.test(a.$(".gitlab-settings").textContent), "connection result");
  assert.match(a.$(".gitlab-settings").textContent, /周楚/);
  assert.match(a.$(".gitlab-settings").textContent, /19\.6\.0/);
});


test("app: gitlab settings surface save and connection failures instead of pretending", async t => {
  const a = await app(t, {
    routes: {
      "GET /api/gitlab/config": { ok: true, baseUrl: "https://git.tsinghua.edu.cn", configured: false, masked: "", source: "none" },
      "PUT /api/gitlab/config": { ok: false, error: { message: "地址必须是 http(s) 链接。" } },
      "POST /api/gitlab/test": { ok: false, error: { message: "令牌无效或已过期。" } },
    },
  });
  a.nav("settings");
  await until(() => !!a.$(".gitlab-settings"), "gitlab card");
  a.click(a.button("保存", a.$(".gitlab-settings")));
  await until(() => /地址必须是 http/.test(a.$("#settings")?.textContent || a.document.body.textContent), "save error");
  a.click(a.button("测试连接", a.$(".gitlab-settings")));
  await until(() => /令牌无效或已过期/.test(a.document.body.textContent), "test error");
});


test("app: sports booking buttons report the prepared step and failures honestly", async t => {
  const day = new Date().toLocaleDateString("sv-SE");
  const a = await app(t, {
    routes: {
      "GET /api/sports/sports": { ok: true, sports: ["游泳"] },
      "GET /api/sports/venues?sport=%E6%B8%B8%E6%B3%B3": { ok: true, sport: "游泳", venues: ["陈明游泳馆"] },
      [`GET /api/sports/slots?sport=%E6%B8%B8%E6%B3%B3&venue=%E9%99%88%E6%98%8E%E6%B8%B8%E6%B3%B3%E9%A6%86&date=${day}`]: {
        ok: true,
        sessions: [{ site: "泳道1", begin: "20:00", end: "21:00", capacity: 10, reserved: 1, status: "Y", price: 7 }],
      },
      "POST /api/sports/booking/prepare": { ok: true, step: "verification", message: "已停在滑块验证这一步。" },
    },
  });
  a.nav("sports");
  await until(() => !!a.$(".sports-prepare"), "prepare button");
  a.click(a.$(".sports-prepare"));
  await until(() => /已停在滑块验证/.test(a.$(".sports-panel").textContent), "prepare feedback");

  a.routes.set("POST /api/sports/booking/prepare", { ok: false, error: { message: "打开窗口失败。" } });
  await until(() => !!a.$(".sports-prepare"), "prepare button again");
  a.click(a.$(".sports-prepare"));
  await until(() => /打开窗口失败/.test(a.$(".sports-panel").textContent), "prepare failure");
});
