import { openBrowser, browserConfig } from "@thu-campus/browser";
import { randomUUID } from "node:crypto";
import { BrowserBusyError } from "./browser-lock.mjs";
import { acquireLease, releaseLease, startLeaseHeartbeat } from "../browser-lease.mjs";

/**
 * 打开持久浏览器，并在浏览器存活期间持有一份跨进程租约。
 *
 * 目的：CLI/MCP/预约窗口这些“不经过 worker”的入口以前直接开浏览器，
 * worker 看不到它们，会以为队列空闲并去抢同一份资料目录。现在所有直接入口都先租后开，
 * 租约跟着 `browser.close()` 一起释放——包括预约窗口那种长时间开着的场景。
 */
export async function openBrowserWithRetry({
  attempts = 4,
  delayMs = 700,
  lease = true,
  label = "app:browser",
  stateDir = null,
  open = openBrowser,
  ...options
} = {}) {
  const dir = stateDir || browserConfig().stateDir;
  const owner = `${label}:${process.pid}:${randomUUID().slice(0, 8)}`;
  let claim = null;
  if (lease) {
    claim = await acquireLease(dir, { owner, label, pid: process.pid }).catch(() => ({ ok: false, holder: null }));
    if (!claim.ok) {
      const holder = claim.holder?.label;
      throw new BrowserBusyError(`浏览器正被占用${holder ? `（正在执行：${holder}）` : ""}，稍后再试。`);
    }
  }
  const stop = claim?.ok ? startLeaseHeartbeat(dir, owner) : () => {};
  const rollback = async () => {
    stop();
    if (claim?.ok) await releaseLease(dir, { owner }).catch(() => {});
  };

  for (let index = 0; index < attempts; index += 1) {
    try {
      const browser = await open(options);
      if (!claim?.ok) return browser;
      // 租约跟着浏览器生命周期走：关闭成功或失败都要释放，不能留孤儿。
      const close = browser.close.bind(browser);
      browser.close = async () => {
        try { return await close(); }
        finally { await rollback(); }
      };
      return browser;
    } catch (error) {
      if (error?.code !== "BROWSER_BUSY") { await rollback(); throw error; }
      if (index + 1 < attempts) await new Promise(resolve => setTimeout(resolve, delayMs * (index + 1)));
      else { await rollback(); throw new BrowserBusyError("浏览器资料目录仍被占用，请稍后重试。"); }
    }
  }
  await rollback();
  throw new BrowserBusyError("浏览器资料目录仍被占用，请稍后重试。");
}