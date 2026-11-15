import { createChatWidth, dragChatWidth, keyChatWidth } from "./chat-width.js";

const $ = selector => document.querySelector(selector);
function localWidthStorage() {
  try { return window.localStorage; } catch { return undefined; }
}

/** Width-only updates: never re-render a conversation or interrupt its stream. */
export function createChatWidthUI({ onError } = {}) {
  const preference = createChatWidth(localWidthStorage());
  let drag = null;
  let lastError = null;

  function available() {
    const view = $("#view");
    const style = getComputedStyle(view);
    return Math.max(0, view.clientWidth - Number.parseFloat(style.paddingLeft) - Number.parseFloat(style.paddingRight));
  }
  function refresh() {
    const desktop = innerWidth >= 900;
    const chat = $("#view").dataset.view === "chat";
    if (drag && (!desktop || !chat)) finishDrag(true);
    const value = preference.snapshot(available());
    document.body.dataset.chatCustomWidth = String(desktop && chat && !value.automatic);
    document.documentElement.style.setProperty("--chat-width", value.value + "px");
    if (value.error && value.error !== lastError) onError?.(value.error);
    lastError = value.error;
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
      const handle = document.createElement("div");
      handle.className = "chat-resize-handle";
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
  function init() {
    window.addEventListener("resize", refresh);
    window.addEventListener("blur", () => finishDrag(true));
    document.addEventListener("pointermove", moveDrag);
    document.addEventListener("pointerup", event => { if (event.pointerId === drag?.id) finishDrag(true); });
    document.addEventListener("pointercancel", event => { if (event.pointerId === drag?.id) finishDrag(false); });
    document.addEventListener("keydown", event => { if (event.key === "Escape" && drag) { event.preventDefault(); finishDrag(false); } });
  }
  return { init, refresh, handles };
}
