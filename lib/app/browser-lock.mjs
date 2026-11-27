/**
 * 浏览器资料目录同一时刻只能被一个进程/上下文占用。
 * 座位、体育、预约推进器等都会打开同一个持久 profile，
 * 并发调用时后到者会拿到锁失败（表现为 502）。
 * 这里用进程内队列串行化，并给出明确的 BROWSER_BUSY 错误。
 */

let chain = Promise.resolve();
let waiting = 0;
// 当前持有浏览器的任务名：报错时告诉用户到底是谁占着，而不是只让他“先关闭窗口”。
let active = "";

export class BrowserBusyError extends Error {
  constructor(message = "浏览器正在被其它任务使用，请稍后重试。") {
    super(message);
    this.name = "BrowserBusyError";
    this.code = "BROWSER_BUSY";
  }
}

export const browserQueueDepth = () => waiting;
export const browserActiveTask = () => active;
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
      active = label;
      try { resolve(await task()); }
      catch (error) { reject(error); }
      finally { active = ""; waiting -= 1; }
    });
  });
}