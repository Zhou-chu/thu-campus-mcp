/**
 * 浏览器资料目录同一时刻只能被一个进程/上下文占用。
 * 座位、体育、预约推进器等都会打开同一个持久 profile，
 * 并发调用时后到者会拿到锁失败（表现为 502）。
 *
 * 进程内用队列串行化；跨进程（worker 开着的登录窗口）用状态目录里的租约对齐，
 * 这样“显示在占用”和“真的占着”是同一件事。
 */
import { acquireLease, readLease, releaseLease, startLeaseHeartbeat } from "../browser-lease.mjs";

let chain = Promise.resolve();
let waiting = 0;
// 当前持有浏览器的任务名：报错时告诉用户到底是谁占着，而不是只让他“先关闭窗口”。
let active = "";
// 由组合根设置：没有状态目录时只做进程内排队（单元测试与独立调用）。
let leaseStateDir = "";
const owner = `app:${process.pid}`;

export class BrowserBusyError extends Error {
  constructor(message = "浏览器正在被其它任务使用，请稍后重试。") {
    super(message);
    this.name = "BrowserBusyError";
    this.code = "BROWSER_BUSY";
  }
}

export const browserQueueDepth = () => waiting;
export const browserActiveTask = () => active;
export function configureBrowserLock({ stateDir = "" } = {}) {
  leaseStateDir = stateDir;
}
const holder = () => (active ? `（正在执行：${active}）` : "");

/**
 * 串行执行浏览器任务。
 * @param {string} label 任务名，用于错误信息与“谁在占用”提示
 * @param {() => Promise<any>} task
 * @param {{timeoutMs?: number, maxQueue?: number}} options 排队超时（超过则直接 BROWSER_BUSY）
 */
export function withBrowserLock(label, task, { timeoutMs = 45_000, maxQueue = 4 } = {}) {
  if (waiting >= maxQueue) return Promise.reject(new BrowserBusyError(`浏览器正被占用${holder()}，${label} 稍后再试。`));
  waiting += 1;
  return new Promise((resolve, reject) => {
    let expired = false;
    const timer = setTimeout(() => {
      expired = true;
      waiting -= 1;
      reject(new BrowserBusyError(`${label} 排队超时${holder()}，可以先关闭占用的窗口再重试。`));
    }, timeoutMs);
    // The deadline is for waiting only. A caller that received BROWSER_BUSY must never
    // see its queued task execute after a different task releases the browser.
    chain = chain.then(async () => {
      if (expired) return;
      clearTimeout(timer);
      // 跨进程租约：worker 的登录窗口还开着时，这里不该以为浏览器空着。
      const foreign = leaseStateDir ? await readLease(leaseStateDir).catch(() => null) : null;
      if (foreign && foreign.owner !== owner) {
        waiting -= 1;
        reject(new BrowserBusyError(`浏览器正被占用（正在执行：${foreign.label}），${label} 稍后再试。`));
        return;
      }
      const claimed = leaseStateDir ? await acquireLease(leaseStateDir, { owner, label }).catch(() => ({ ok: false })) : { ok: true };
      if (!claimed.ok) {
        waiting -= 1;
        const busyWith = claimed.holder?.label ? `（正在执行：${claimed.holder.label}）` : "";
        reject(new BrowserBusyError(`浏览器正被占用${busyWith}，${label} 稍后再试。`));
        return;
      }
      const stopHeartbeat = leaseStateDir ? startLeaseHeartbeat(leaseStateDir, owner) : () => {};
      active = label;
      let value;
      let failure = null;
      try { value = await task(); }
      catch (error) { failure = error; }
      // 先收尾再交付结果：调用方拿到返回值时，租约必须已经释放、占用者已经清空。
      active = "";
      stopHeartbeat();
      if (leaseStateDir) await releaseLease(leaseStateDir, { owner }).catch(() => {});
      waiting -= 1;
      if (failure) reject(failure);
      else resolve(value);
    });
  });
}