const actions = new WeakMap();
const FEEDBACK_MS = 1600;

function adjacentFeedback(button, role, text) {
  const node = button.ownerDocument.createElement("span");
  node.className = "action-feedback";
  node.setAttribute("role", role);
  node.textContent = text;
  button.after(node);
  return node;
}

/**
 * Run one action per button; duplicate pending calls resolve undefined.
 * Successful values are returned unchanged. Actions must throw/reject on failure.
 * A supplied errorNode is dedicated to this action; otherwise an inline alert is created.
 * Success text and data-phase clear after 1.6s, while errors remain until the next attempt.
 */
export async function runAction(button, action, { pending = "处理中…", success = "", errorNode, onError } = {}) {
  const previous = actions.get(button);
  if (previous?.pending) return undefined;
  if (previous) {
    clearTimeout(previous.timer);
    previous.feedback?.remove();
    previous.error?.remove();
  }
  const original = { disabled: button.disabled, children: [...button.childNodes], busy: button.getAttribute("aria-busy") };
  const current = { pending: true, phase: "error", timer: null, feedback: null, error: null };
  actions.set(button, current);
  if (errorNode) { errorNode.hidden = true; errorNode.textContent = ""; }
  button.disabled = true;
  button.setAttribute("aria-busy", "true");
  button.dataset.phase = "pending";
  button.textContent = pending;
  try {
    const value = await action();
    if (success) current.feedback = adjacentFeedback(button, "status", success);
    current.phase = "success";
    return value;
  } catch (error) {
    const message = typeof error?.message === "string" && error.message ? error.message : typeof error === "string" && error ? error : "操作失败，请重试。";
    const target = errorNode || (current.error = adjacentFeedback(button, "alert", message));
    target.textContent = message;
    target.hidden = false;
    target.setAttribute("role", "alert");
    try { await onError?.(error); } catch { /* The original failure remains visible even if its observer fails. */ }
    return undefined;
  } finally {
    button.disabled = original.disabled;
    button.replaceChildren(...original.children);
    if (original.busy === null) button.removeAttribute("aria-busy");
    else button.setAttribute("aria-busy", original.busy);
    current.pending = false;
    button.dataset.phase = current.phase;
    current.timer = setTimeout(() => {
      if (actions.get(button) !== current) return;
      if (button.dataset.phase === current.phase) delete button.dataset.phase;
      current.feedback?.remove();
      current.feedback = null;
      current.timer = null;
    }, FEEDBACK_MS);
    current.timer.unref?.();
  }
}
