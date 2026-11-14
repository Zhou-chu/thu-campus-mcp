import { test } from "node:test";
import assert from "node:assert/strict";
import { runAction } from "../webui/ui-feedback.js";

class Node {
  constructor(tagName, ownerDocument) {
    this.tagName = tagName;
    this.ownerDocument = ownerDocument;
    this.childNodes = [];
    this.parentNode = null;
    this.attributes = new Map();
    this.dataset = {};
    this.disabled = false;
    this.hidden = false;
    this.data = "";
  }
  get textContent() { return this.tagName === "#text" ? this.data : this.childNodes.map(node => node.textContent).join(""); }
  set textContent(value) {
    if (this.tagName === "#text") this.data = String(value);
    else this.replaceChildren(...(String(value) ? [this.ownerDocument.createTextNode(String(value))] : []));
  }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  removeAttribute(name) { this.attributes.delete(name); }
  replaceChildren(...nodes) {
    for (const child of this.childNodes) child.parentNode = null;
    this.childNodes = [];
    for (const node of nodes) { node.remove(); node.parentNode = this; this.childNodes.push(node); }
  }
  after(node) {
    if (!this.parentNode) return;
    node.remove();
    node.parentNode = this.parentNode;
    this.parentNode.childNodes.splice(this.parentNode.childNodes.indexOf(this) + 1, 0, node);
  }
  remove() {
    if (this.parentNode) {
      this.parentNode.childNodes.splice(this.parentNode.childNodes.indexOf(this), 1);
      this.parentNode = null;
    }
  }
}
const document = {
  createElement: tag => new Node(tag, document),
  createTextNode: text => { const node = new Node("#text", document); node.data = text; return node; },
};
function fixture() {
  const root = document.createElement("div"), button = document.createElement("button"), errorNode = document.createElement("div"), input = document.createElement("input");
  button.textContent = "保存";
  input.value = "必须保留的草稿";
  errorNode.hidden = true;
  root.replaceChildren(button, errorNode, input);
  return { root, button, errorNode, input };
}
function clock(t) { t.mock.timers.enable({ apis: ["setTimeout"] }); return t.mock.timers; }
const feedback = (root, role) => root.childNodes.filter(node => node.getAttribute("role") === role);

 test("真实pending覆盖到结算，保留按钮原子节点与输入，成功状态按时清除", async t => {
  const timer = clock(t), { root, button, errorNode, input } = fixture(), gate = Promise.withResolvers();
  const icon = document.createElement("span"); icon.textContent = "✓";
  button.replaceChildren(icon, document.createTextNode("保存"));
  const original = [...button.childNodes], result = { id: "exact-object" };
  errorNode.textContent = "旧错误"; errorNode.hidden = false;
  const request = runAction(button, () => gate.promise, { pending: "保存中…", success: "已保存", errorNode });
  assert.equal(button.disabled, true);
  assert.equal(button.textContent, "保存中…");
  assert.equal(button.getAttribute("aria-busy"), "true");
  assert.equal(button.dataset.phase, "pending");
  assert.equal(errorNode.hidden, true); assert.equal(errorNode.textContent, "");
  assert.equal(input.value, "必须保留的草稿");
  timer.tick(5000); assert.equal(button.dataset.phase, "pending");
  gate.resolve(result); assert.equal(await request, result);
  assert.equal(button.disabled, false); assert.equal(button.getAttribute("aria-busy"), null);
  assert.deepEqual(button.childNodes, original); assert.equal(button.childNodes[0], icon);
  assert.equal(button.textContent, "✓保存"); assert.equal(button.dataset.phase, "success");
  assert.equal(feedback(root, "status")[0].textContent, "已保存");
  assert.equal(input.value, "必须保留的草稿");
  timer.tick(1599); assert.equal(feedback(root, "status").length, 1);
  timer.tick(1); assert.equal(feedback(root, "status").length, 0);
  assert.equal(button.dataset.phase, undefined);
});

test("同按钮pending期间重复调用不执行action，也不替换当前反馈", async t => {
  clock(t);
  const { button } = fixture(), gate = Promise.withResolvers(); let calls = 0;
  const first = runAction(button, () => { calls++; return gate.promise; });
  assert.equal(await runAction(button, () => { calls++; return "duplicate"; }, { pending: "不应显示" }), undefined);
  assert.equal(calls, 1); assert.equal(button.textContent, "处理中…");
  assert.equal(button.dataset.phase, "pending");
  gate.resolve(42); assert.equal(await first, 42);
  assert.equal(await runAction(button, () => { calls++; return "retry"; }), "retry");
  assert.equal(calls, 2);
});

test("不同按钮独立操作，原disabled和非缺省aria-busy精确恢复", async t => {
  clock(t);
  const a = fixture(), b = fixture(), first = Promise.withResolvers(), second = Promise.withResolvers();
  a.button.disabled = true; a.button.setAttribute("aria-busy", "false");
  b.button.setAttribute("aria-busy", "");
  const pa = runAction(a.button, () => first.promise), pb = runAction(b.button, () => second.promise);
  second.resolve("B"); assert.equal(await pb, "B");
  assert.equal(b.button.disabled, false); assert.equal(b.button.getAttribute("aria-busy"), "");
  assert.equal(a.button.dataset.phase, "pending"); assert.equal(a.button.disabled, true);
  first.resolve("A"); assert.equal(await pa, "A");
  assert.equal(a.button.disabled, true); assert.equal(a.button.getAttribute("aria-busy"), "false");
});

test("同步抛错就地写纯文本alert，原错误交给onError且反馈不会提前消失", async t => {
  const timer = clock(t), { root, button, errorNode, input } = fixture();
  const failure = new Error("<img src=x onerror=bad()>上传失败"); let observed;
  assert.equal(await runAction(button, () => { throw failure; }, { errorNode, onError: error => { observed = error; } }), undefined);
  assert.equal(observed, failure); assert.equal(errorNode.getAttribute("role"), "alert");
  assert.equal(errorNode.hidden, false); assert.equal(errorNode.textContent, failure.message);
  assert.equal(errorNode.childNodes[0].tagName, "#text");
  assert.equal(root.childNodes.length, 3); assert.equal(button.dataset.phase, "error");
  assert.equal(button.disabled, false); assert.equal(button.textContent, "保存");
  timer.tick(2000); assert.equal(button.dataset.phase, undefined);
  assert.equal(errorNode.hidden, false); assert.equal(errorNode.textContent, failure.message);
  assert.equal(input.value, "必须保留的草稿");
});

test("异步拒绝无errorNode时也有持久相邻alert并调用异步onError，重试清旧反馈", async t => {
  const timer = clock(t), { root, button } = fixture(), failure = new Error("网络断开"); let observed;
  assert.equal(await runAction(button, async () => { throw failure; }, { onError: async error => { observed = error; } }), undefined);
  assert.equal(observed, failure); assert.equal(feedback(root, "alert")[0].textContent, "网络断开");
  timer.tick(2000); assert.equal(feedback(root, "alert").length, 1);
  await runAction(button, () => "ok", { success: "已重试" });
  assert.equal(feedback(root, "alert").length, 0); assert.equal(feedback(root, "status")[0].textContent, "已重试");
  timer.tick(1600); assert.equal(feedback(root, "status").length, 0);
});

test("onError自身同步或异步失败不泄漏未处理拒绝，仍保留原操作错误", async t => {
  clock(t);
  for (const onError of [() => { throw new Error("observer sync"); }, async () => { throw new Error("observer async"); }]) {
    const { root, button } = fixture();
    assert.equal(await runAction(button, () => Promise.reject(new Error("原操作失败")), { onError }), undefined);
    assert.equal(feedback(root, "alert")[0].textContent, "原操作失败");
    assert.equal(button.dataset.phase, "error"); assert.equal(button.disabled, false);
  }
});

test("空或非标准错误使用可读兜底，字符串/有效message原样显示，无观察者也不静默", async t => {
  clock(t);
  const { button, errorNode } = fixture();
  const fallbackMessage = "操作失败，请重试。";
  for (const [error, message] of [[null, fallbackMessage], [undefined, fallbackMessage], ["", fallbackMessage], [0, fallbackMessage], [{}, fallbackMessage], [{ message: 7 }, fallbackMessage], [new Error(""), fallbackMessage], ["网络异常", "网络异常"], [{ message: "指定错误" }, "指定错误"]]) {
    assert.equal(await runAction(button, () => { throw error; }, { errorNode }), undefined);
    assert.equal(errorNode.textContent, message);
    assert.equal(errorNode.hidden, false);
  }
  const fallback = fixture();
  assert.equal(await runAction(fallback.button, () => { throw undefined; }), undefined);
  assert.equal(feedback(fallback.root, "alert")[0].textContent, "操作失败，请重试。");
});

test("成功返回值包括false、0、null、undefined与对象均不被包装或吞掉", async t => {
  const timer = clock(t), { root, button } = fixture();
  for (const value of [false, 0, null, undefined, "", { ok: false, business: "caller-owned" }]) {
    assert.equal(await runAction(button, () => value), value);
    assert.equal(button.dataset.phase, "success");
    assert.equal(feedback(root, "status").length, 0);
  }
  timer.tick(1600); assert.equal(button.dataset.phase, undefined);
});

test("开始新动作取消前次短暂反馈，旧计时器不会清掉新的pending", async t => {
  const timer = clock(t), { root, button } = fixture();
  await runAction(button, () => 1, { success: "第一次完成" });
  timer.tick(800);
  const gate = Promise.withResolvers(), second = runAction(button, () => gate.promise);
  assert.equal(feedback(root, "status").length, 0);
  timer.tick(2000); assert.equal(button.dataset.phase, "pending"); assert.equal(button.disabled, true);
  gate.resolve(2); assert.equal(await second, 2);
  timer.tick(1600); assert.equal(button.dataset.phase, undefined);
});

test("已排队的旧回调与外部phase更改不会被组件过期清理覆盖，兼容浏览器数字timer", async t => {
  const callbacks = [];
  t.mock.method(globalThis, "setTimeout", callback => { callbacks.push(callback); return callbacks.length; });
  t.mock.method(globalThis, "clearTimeout", () => {});
  const { button } = fixture();
  await runAction(button, () => 1);
  const gate = Promise.withResolvers(), second = runAction(button, () => gate.promise);
  callbacks[0](); assert.equal(button.dataset.phase, "pending");
  gate.resolve(2); await second;
  button.dataset.phase = "caller-owned";
  callbacks[1](); assert.equal(button.dataset.phase, "caller-owned");
});

test("原生Node反馈timer已unref，不会延长进程生命周期", async t => {
  const nativeSetTimeout = globalThis.setTimeout, handles = [];
  t.mock.method(globalThis, "setTimeout", (...args) => { const handle = nativeSetTimeout(...args); handles.push(handle); return handle; });
  const { button } = fixture();
  try {
    await runAction(button, () => "done");
    assert.equal(handles.length, 1); assert.equal(handles[0].hasRef(), false);
  } finally { for (const handle of handles) clearTimeout(handle); }
});

test("动作期间按钮离开页面仍安全恢复原DOM，反馈清理不抛异常", async t => {
  const timer = clock(t), { button } = fixture(), gate = Promise.withResolvers();
  const request = runAction(button, () => gate.promise, { success: "已完成" });
  button.remove(); gate.resolve("detached");
  assert.equal(await request, "detached"); assert.equal(button.textContent, "保存");
  timer.tick(1600); assert.equal(button.dataset.phase, undefined);
});
