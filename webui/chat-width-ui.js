import { createChatWidth, dragChatWidth, keyChatWidth } from "./chat-width.js";

const $ = selector => document.querySelector(selector);
function node(tag, className, text) {
  const result = document.createElement(tag);
  result.className = className;
  if (text) result.textContent = text;
  return result;
}
function localWidthStorage() {
  try { return window.localStorage; } catch { return undefined; }
}

/** Width-only updates: never re-render a conversation or interrupt its stream. */
export function createChatWidthUI() {
  const preference = createChatWidth(localWidthStorage());
  let drag = null;

  function available() {
    const view = $("#view");
    const style = getComputedStyle(view);
    return Math.max(0, view.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight));
  }
  function refresh() {
    const desktop = innerWidth >= 900;
    const chat = $("#view").dataset.view === "chat";
    if (drag && (!desktop || !chat)) finishDrag(true);
    const value = preference.snapshot(available());
    document.body.dataset.chatCustomWidth = String(desktop && chat && !value.automatic);
    document.documentElement.style.setProperty("--chat-width", value.value + "px");
    const picker = $("#chat-width-picker");
    if (picker) {
      picker.hidden = !desktop || !chat;
      const range = $("#chat-width-range");
      range.min = value.min; range.max = value.max; range.value = value.value;
      range.disabled = value.min === value.max;
      $("#chat-width-value").textContent = (value.automatic ? "自动 · " : "") + value.value + "px";
      $("#chat-width-reset").disabled = value.automatic;
      $("#chat-width-error").textContent = value.error;
      $("#chat-width-error").hidden = !value.error;
    }
    for (const handle of document.querySelectorAll(".chat-resize-handle")) {
      handle.hidden = !desktop || value.min === value.max;
      handle.setAttribute("aria-valuemin", value.min);
      handle.setAttribute("aria-valuemax", value.max);
      handle.setAttribute("aria-valuenow", value.value);
      handle.setAttribute("aria-valuetext", value.value + "px" + (value.automatic ? "，自动" : ""));
    }
    const messages = $("#messages");
    if (messages?.dataset.followTail === "true") messages.scrollTop = messages.scrollHeight;
  }
  function finishDrag(commit) {
    const current = drag;
    if (!current) return;
    drag = null;
    document.body.classList.remove("chat-resizing");
    if (commit && current.moved) preference.persist();
    if (!commit) preference.set(current.preferred, false);
    if (current.target.hasPointerCapture(current.id)) current.target.releasePointerCapture(current.id);
    refresh();
  }
  function beginDrag(event) {
    if (event.button !== 0 || innerWidth < 900) return;
    const target = event.currentTarget;
    const canvas = $("#view > .chat");
    drag = { id: event.pointerId, target, x: event.clientX, width: canvas.getBoundingClientRect().width, preferred: preference.snapshot(available()).preferred, moved: false };
    target.setPointerCapture(event.pointerId);
    target.focus({ preventScroll: true });
    document.body.classList.add("chat-resizing");
    event.preventDefault();
  }
  function moveDrag(event) {
    if (!drag || drag.id !== event.pointerId) return;
    const delta = event.clientX - drag.x;
    if (!drag.moved && Math.abs(delta) < 2) return;
    drag.moved = true;
    preference.set(dragChatWidth(drag.width, delta, drag.target.dataset.edge, available()), false);
    refresh();
  }
  function handleKey(event) {
    if (drag) return;
    const value = preference.snapshot(available());
    const next = keyChatWidth(value.value, event.key, event.currentTarget.dataset.edge, value.max, event.shiftKey);
    if (next === undefined) return;
    event.preventDefault();
    preference.set(next);
    refresh();
  }
  function handles() {
    return ["left", "right"].map(edge => {
      const handle = node("div", "chat-resize-handle");
      handle.dataset.edge = edge;
      handle.tabIndex = 0;
      handle.setAttribute("role", "separator");
      handle.setAttribute("aria-orientation", "vertical");
      handle.setAttribute("aria-label", edge === "left" ? "调整会话左边界" : "调整会话右边界");
      handle.setAttribute("aria-description", "左右方向键调整，Home最窄，End最宽，Enter或双击恢复默认");
      handle.title = "拖动调整会话宽度，双击恢复默认";
      handle.addEventListener("pointerdown", beginDrag);
      handle.addEventListener("keydown", handleKey);
      handle.addEventListener("dblclick", () => { preference.set(null); refresh(); });
      handle.addEventListener("lostpointercapture", () => finishDrag(true));
      return handle;
    });
  }
  function picker() {
    const details = node("details", "composer-popover width-picker");
    details.id = "chat-width-picker";
    const summary = node("summary", "ghost", "宽度");
    summary.setAttribute("aria-label", "会话宽度");
    const body = node("div", "composer-popover-body width-picker-body");
    const label = node("label", "width-label", "会话宽度");
    label.htmlFor = "chat-width-range";
    const output = node("output", "small"); output.id = "chat-width-value";
    const range = node("input", "width-range");
    range.id = "chat-width-range"; range.type = "range"; range.step = "1";
    range.addEventListener("input", () => { preference.set(Number(range.value), false); refresh(); });
    range.addEventListener("change", () => { preference.persist(); refresh(); });
    const reset = node("button", "ghost", "恢复默认");
    reset.id = "chat-width-reset"; reset.type = "button";
    reset.addEventListener("click", () => { preference.set(null); refresh(); });
    const help = node("p", "small muted", "也可拖动会话两侧，或用方向键调整");
    const error = node("p", "small error"); error.id = "chat-width-error"; error.setAttribute("role", "status");
    body.append(label, output, range, reset, help, error);
    details.append(summary, body);
    return details;
  }
  function init() {
    $(".topbar-meta").insertBefore(picker(), $("#refresh"));
    window.addEventListener("resize", refresh);
    window.addEventListener("blur", () => finishDrag(true));
    document.addEventListener("pointermove", moveDrag);
    document.addEventListener("pointerup", event => { if (event.pointerId === drag?.id) finishDrag(true); });
    document.addEventListener("pointercancel", event => { if (event.pointerId === drag?.id) finishDrag(false); });
    document.addEventListener("keydown", event => { if (event.key === "Escape" && drag) { event.preventDefault(); finishDrag(false); } });
  }
  return { init, refresh, handles };
}
