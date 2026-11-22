/**
 * 会话信号：某个更贴近用户的功能（如作业列表）已经明确报告会话失效时，
 * 服务状态不应继续显示「已登录 / 未核验」，否则同一界面会出现两种结论。
 *
 * 每个运行时实例各持一份信号，不做模块级可变状态：
 * 同一进程里开多个服务器（测试、预览、多档案）不会互相污染。
 */

const TTL_MS = 10 * 60 * 1000;

export function createSessionSignals({ ttlMs = TTL_MS, now = Date.now } = {}) {
  let expiredAt = 0;
  return {
    /** 记录一次明确的会话失效；时间取调用时刻，避免把未来时间当成长期有效。 */
    report(at = now()) {
      const value = Number(at);
      expiredAt = Number.isFinite(value) && value > 0 ? value : now();
    },
    clear() {
      expiredAt = 0;
    },
    current() {
      if (!expiredAt) return null;
      return now() - expiredAt <= ttlMs ? { at: expiredAt } : null;
    },
    /** 把会话信号叠加到服务状态上：命中时统一标为「登录已过期」。 */
    apply(states) {
      const signal = this.current();
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
    },
  };
}