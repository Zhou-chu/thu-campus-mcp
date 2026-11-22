/**
 * 浏览器资料目录同一时刻只能被一个进程/上下文占用。
 * 座位、体育、预约推进器等都会打开同一个持久 profile，
 * 并发调用时后到者会拿到锁失败（表现为 502）。
 * 这里用进程内队列串行化，并给出明确的 BROWSER_BUSY 错误。
 */

let chain = Promise.resolve();
let waiting = 0;

export class BrowserBusyError extends Error {
  constructor(message = "浏览器正在被其它任务使用，请稍后重试。") {
    super(message);
    this.name = "BrowserBusyError";
    this.code = "BROWSER_BUSY";
  }
}

export const browserQueueDepth = () => waiting;

/**
 * 串行执行浏览器任务。
 * @param {string} label 任务名，仅用于错误信息
 * @param {() => Promise<any>} task
 * @param {{timeoutMs?: number}} options 排队超时（超过则直接 BROWSER_BUSY）
 */
export function withBrowserLock(label, task, { timeoutMs = 45_000, maxQueue = 4 } = {}) {
  if (waiting >= maxQueue) return Promise.reject(new BrowserBusyError(`浏览器正被占用，${label} 稍后再试。`));
  waiting += 1;
  return new Promise((resolve, reject) => {
    let expired = false;
    const timer = setTimeout(() => {
      expired = true;
      waiting -= 1;
      reject(new BrowserBusyError(`${label} 排队超时，浏览器仍被占用。`));
    }, timeoutMs);
    // The deadline is for waiting only. A caller that received BROWSER_BUSY must never
    // see its queued task execute after a different task releases the browser.
    chain = chain.then(async () => {
      if (expired) return;
      clearTimeout(timer);
      try { resolve(await task()); }
      catch (error) { reject(error); }
      finally { waiting -= 1; }
    });
  });
}