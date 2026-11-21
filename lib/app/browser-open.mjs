import { openBrowser } from "@thu-campus/browser";
import { BrowserBusyError } from "./browser-lock.mjs";

/**
 * 打开持久浏览器。
 * 上一次任务刚 close 时资料目录锁可能还没释放，这里对 BROWSER_BUSY 做短重试，
 * 避免用户连续点击时被一句「浏览器被占用」挡住。
 */
export async function openBrowserWithRetry({ attempts = 4, delayMs = 700 } = {}) {
  let lastError;
  for (let index = 0; index < attempts; index += 1) {
    try {
      return await openBrowser();
    } catch (error) {
      lastError = error;
      if (error?.code !== "BROWSER_BUSY") throw error;
      await new Promise(resolve => setTimeout(resolve, delayMs * (index + 1)));
    }
  }
  throw new BrowserBusyError("浏览器资料目录仍被占用，请稍后重试。");
}