/**
 * 会话保活自检。
 *
 * 校园会话会过期，而运行时常驻在后台、没人盯着。这里按固定间隔调用只读状态工具，
 * 发现 `expired` 时按配置触发一次既有 `browser restore` 流程（复用 CLI，不另写恢复逻辑）。
 * 自检本身**不做任何写入校园系统的动作**。
 */
import { serviceEvidence } from "./states.mjs";

export class KeepAliveError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}
export function createKeepAlive({
  probe,
  restore,
  intervalMs = 1800000,
  restoreExpired = true,
  now = () => Date.now(),
  historyLimit = 50,
  logger = () => {},
}) {
  let timer = null;
  let running = false;
  let lastRunAt = null;
  let lastResult = null;
  const history = [];
  const state = { intervalMs, restoreExpired };
  async function runOnce(trigger = "manual") {
    if (running) return { skipped: true, reason: "already-running" };
    running = true;
    const startedAt = now();
    let services = {};
    try {
      services = (await probe()) || {};
    } catch (e) {
      services = { _probe: { state: "unknown", code: e?.code || "PROBE_FAILED" } };
    }
    const evidence = Object.fromEntries(Object.entries(services)
      .filter(([name]) => !name.startsWith("_"))
      .map(([name, info]) => [name, serviceEvidence(info, { at: new Date(startedAt).toISOString() })]));
    const actions = [];
    for (const [service, info] of Object.entries(evidence)) {
      if (service.startsWith("_")) continue;
      const current = info?.state || "unknown";
      if (current !== "expired") continue;
      if (!state.restoreExpired) {
        actions.push({ service, state: current, action: "skipped" });
        continue;
      }
      let outcome = { ok: false, code: "RESTORE_FAILED" };
      try {
        outcome = (await restore(service)) || { ok: false, code: "RESTORE_FAILED" };
      } catch (e) {
        outcome = { ok: false, code: e?.code || "RESTORE_FAILED" };
      }
      actions.push({
        service,
        state: current,
        action: "restore",
        ok: !!outcome.ok,
        ...(outcome.ok ? {} : { code: outcome.code || "RESTORE_FAILED" }),
      });
    }
    const entry = {
      at: new Date(startedAt).toISOString(),
      trigger,
      durationMs: Math.max(0, now() - startedAt),
      services: Object.fromEntries(Object.entries(evidence).map(([name, info]) => [name, info.state])),
      serviceEvidence: evidence,
      actions,
      ok: !services._probe && Object.keys(evidence).length > 0 && Object.values(evidence).every(info => info.state === "ready" && info.verified) && actions.every((action) => action.ok !== false),
    };
    history.unshift(entry);
    if (history.length > historyLimit) history.pop();
    lastRunAt = startedAt;
    lastResult = entry;
    running = false;
    if (actions.length) logger("keepalive-run", { trigger, actions: actions.length });
    return entry;
  }
  function start() {
    if (timer || !state.intervalMs) return false;
    timer = setInterval(() => void runOnce("timer"), state.intervalMs);
    timer.unref?.();
    return true;
  }
  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
  }
  function configure({ intervalMs: nextInterval, restoreExpired: nextRestore } = {}) {
    if (Number.isInteger(nextInterval) && nextInterval >= 0) state.intervalMs = nextInterval;
    if (typeof nextRestore === "boolean") state.restoreExpired = nextRestore;
    stop();
    start();
    return { intervalMs: state.intervalMs, restoreExpired: state.restoreExpired };
  }
  function status() {
    const expiredNow = lastResult
      ? Object.entries(lastResult.services || {}).filter(([, s]) => s === "expired").map(([n]) => n)
      : [];
    return {
      enabled: !!state.intervalMs,
      intervalMs: state.intervalMs,
      restoreExpired: state.restoreExpired,
      running,
      lastRunAt: lastRunAt ? new Date(lastRunAt).toISOString() : null,
      nextRunAt:
        state.intervalMs && lastRunAt
          ? new Date(lastRunAt + state.intervalMs).toISOString()
          : null,
      expiredServices: expiredNow,
      lastResult,
      history: history.slice(0, 10),
    };
  }
  return { runOnce, start, stop, configure, status };
}