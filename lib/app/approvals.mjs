/**
 * 写入类工具的审批闸门。
 *
 * 模型只能"提议"调用 destructive 工具；在用户明确允许之前，调用不会发出。
 * 拒绝或超时都会作为一次普通的工具失败结果回灌给模型，让它知道这件事没做成，
 * 而不是静默跳过或假装成功。
 */
export class ApprovalError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}
export function createApprovals({ timeoutMs = 120000, now = () => Date.now() } = {}) {
  const pending = new Map();
  function register(callId, meta = {}) {
    if (pending.has(callId)) {
      const existing = pending.get(callId);
      return { callId, promise: existing.promise, meta: existing.meta };
    }
    let resolve;
    const promise = new Promise((settle) => (resolve = settle));
    const timer = setTimeout(() => {
      const entry = pending.get(callId);
      if (!entry) return;
      pending.delete(callId);
      entry.resolve({ allow: false, reason: "timeout" });
    }, timeoutMs);
    timer.unref?.();
    const entry = {
      callId,
      meta,
      createdAt: now(),
      timer,
      resolve: (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      promise,
    };
    pending.set(callId, entry);
    return { callId, promise, meta };
  }
  function decide(callId, allow, sessionId) {
    const entry = pending.get(callId);
    if (!entry || (sessionId !== undefined && entry.meta?.sessionId !== sessionId)) return false;
    pending.delete(callId);
    entry.resolve(allow ? { allow: true } : { allow: false, reason: "denied" });
    return true;
  }
  function cancel(callId, reason = "aborted") {
    const entry = pending.get(callId);
    if (!entry) return false;
    pending.delete(callId);
    entry.resolve({ allow: false, reason });
    return true;
  }
  function cancelSession(sessionId, reason = "turn-ended") {
    let count = 0;
    for (const entry of [...pending.values()])
      if (entry.meta?.sessionId === sessionId && cancel(entry.callId, reason)) count += 1;
    return count;
  }
  function cancelAll(reason = "aborted") {
    for (const callId of [...pending.keys()]) cancel(callId, reason);
  }
  function list() {
    return [...pending.values()].map((entry) => ({
      callId: entry.callId,
      name: entry.meta?.name || "",
      sessionId: entry.meta?.sessionId || "",
      createdAt: new Date(entry.createdAt).toISOString(),
    }));
  }
  return { register, decide, cancel, cancelSession, cancelAll, list, timeoutMs };
}

