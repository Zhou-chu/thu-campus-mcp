/**
 * 会话信号：某个更贴近用户的功能（如作业列表）已经明确报告会话失效时，
 * 服务状态不应继续显示「已登录 / 未核验」，否则同一界面会出现两种结论。
 *
 * 这里只记录「最近一次 AUTH_REQUIRED 的时间」，由服务状态汇总时叠加。
 */

const TTL_MS = 10 * 60 * 1000;

let learnxExpiredAt = 0;

export function reportLearnxExpired(at = Date.now()) {
  learnxExpiredAt = Number(at) || Date.now();
}

export function clearLearnxSignal() {
  learnxExpiredAt = 0;
}

export function learnxExpiredSignal({ now = Date.now(), ttlMs = TTL_MS } = {}) {
  if (!learnxExpiredAt) return null;
  return now - learnxExpiredAt <= ttlMs ? { at: learnxExpiredAt } : null;
}

/** 把会话信号叠加到服务状态上：命中时统一标为「登录已过期」。 */
export function applyLearnxSignal(states, signal) {
  if (!signal || !states || !states.learnx) return states;
  return {
    ...states,
    learnx: {
      ...states.learnx,
      state: "expired",
      verified: false,
      code: "AUTH_REQUIRED",
      sessionValidity: "expired",
      signalAt: new Date(signal.at).toISOString(),
    },
  };
}