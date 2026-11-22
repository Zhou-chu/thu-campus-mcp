import path from "node:path";
import { readFile, rm, realpath, lstat, readdir, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import lockfile from "proper-lockfile";
import { chromium } from "playwright-core";
import {
  browserConfig,
  BrowserError,
  directory,
  inside,
  atomic,
  dpapi,
  readJson,
} from "./core.mjs";
import { runtimeInfo } from "./runtime.mjs";
export async function launchEphemeral(options = {}) {
  const runtime = await runtimeInfo(options);
  if (!runtime.installed)
    throw new BrowserError(
      "BROWSER_NOT_INSTALLED",
      "请先运行 browser install。",
    );
  return chromium.launch({
    executablePath: runtime.executablePath,
    headless: options.headless !== false,
  });
}
/** 清掉崩溃残留的租约目录：超过 10 分钟没有更新的一律视为死锁。 */
export async function clearStaleLocks(stateDir, { now = Date.now(), ttlMs = 600000 } = {}) {
  const dir = path.join(stateDir, "locks");
  let names;
  try {
    names = await readdir(dir);
  } catch {
    return 0;
  }
  let removed = 0;
  for (const name of names) {
    const target = path.join(dir, name);
    try {
      const info = await stat(target);
      if (now - info.mtimeMs <= ttlMs) continue;
      await rm(target, { recursive: true, force: true });
      removed += 1;
    } catch {
      // 并发清理或权限问题都不影响主流程
    }
  }
  return removed;
}

export async function profileLease(options = {}) {
  const cfg = browserConfig(options);
  await directory(cfg.stateDir);
  await clearStaleLocks(cfg.stateDir).catch(() => {});
  let release;
  try {
    release = await lockfile.lock(cfg.stateDir, {
      retries: 0,
      stale: 30000,
      update: 10000,
    });
    const marker = await readJson(path.join(cfg.stateDir, "workspace.json"));
    if (!marker) {
      for (const name of ["profile", "profile-msedge", "profile-chrome"]) {
        try {
          if ((await readdir(path.join(cfg.stateDir, name))).length)
            throw new BrowserError(
              "BROWSER_UNOWNED_PROFILE",
              "目录已有未登记的浏览器资料，未打开或清理。",
            );
        } catch (e) {
          if (e.code !== "ENOENT") throw e;
        }
      }
      await atomic(
        path.join(cfg.stateDir, "workspace.json"),
        JSON.stringify({ owner: "thu-campus-browser", version: 1 }) + "\n",
      );
    } else if (marker.owner !== "thu-campus-browser")
      throw new BrowserError(
        "BROWSER_UNOWNED_PROFILE",
        "该浏览器目录不属于本项目。",
      );
    return { config: cfg, release };
  } catch (e) {
    await release?.().catch(() => {});
    if (e.code === "ELOCKED")
      throw new BrowserError(
        "BROWSER_BUSY",
        "独立浏览器正在使用，请先关闭现有窗口再恢复登录。",
      );
    throw e;
  }
}
export async function readSnapshot(options = {}) {
  const cfg = browserConfig(options);
  try {
    return JSON.parse(
      (
        await dpapi(
          await readFile(path.join(cfg.stateDir, "session.dpapi")),
          true,
        )
      ).toString("utf8"),
    );
  } catch (e) {
    if (e.code === "ENOENT") return;
    throw e;
  }
}
export async function saveSnapshot(options, state) {
  const cfg = browserConfig(options);
  await atomic(
    path.join(cfg.stateDir, "session.dpapi"),
    await dpapi(Buffer.from(JSON.stringify(state))),
  );
}
// Playwright exports localStorage/IndexedDB for the browser's observed origins, not the entire persistent profile.
export function preserveUnvisitedOrigins(state, previous, visited) {
  const current = new Set(state.origins.map(item => item.origin));
  const carried = (previous?.origins ?? []).filter(item => !current.has(item.origin) && !visited.has(item.origin));
  return carried.length ? { ...state, origins: [...state.origins, ...carried] } : state;
}

export async function openBrowser(options = {}) {
  const lease = await profileLease(options),
    cfg = lease.config;
  let context,
    timer,
    lastHash,
    closing = false,
    queue = Promise.resolve();
  try {
    if (options.signal?.aborted)
      throw new BrowserError("BROWSER_CANCELLED", "浏览器任务已取消。");
    const runtime = options.channel ? {} : await runtimeInfo(cfg);
    if (!options.channel && !runtime.installed)
      throw new BrowserError(
        "BROWSER_NOT_INSTALLED",
        "请先运行 node bin/thu-campus.mjs browser install，或 npm run setup。",
      );
    const profile = await directory(
      path.join(
        cfg.stateDir,
        options.channel ? "profile-" + options.channel : "profile",
      ),
    );
    const emptyProfile = !(await readdir(profile)).length;
    const metaFile = path.join(cfg.stateDir, "snapshot-meta.json");
    const priorMeta = await readJson(metaFile);
    await atomic(metaFile, JSON.stringify({ clean: false }));
    context = await chromium.launchPersistentContext(profile, {
      ...(options.channel
        ? { channel: options.channel }
        : { executablePath: runtime.executablePath }),
      headless: Boolean(options.headless),
      viewport: options.headless ? { width: 1280, height: 900 } : null,
      timeout: 30000,
    });
    const saved = await readSnapshot(cfg);
    const trusted = priorMeta?.clean ? saved : undefined;
    const visited = new Set();
    const mark = frame => {
      try {
        const url = new URL(frame.url());
        if (url.protocol === "https:" || url.protocol === "http:") visited.add(url.origin);
      } catch { /* Ignore initial blank or invalid frame URLs. */ }
    };
    const observe = page => {
      page.frames().forEach(mark);
      page.on("framenavigated", mark);
    };
    context.pages().forEach(observe);
    context.on("page", observe);
    if (saved && priorMeta?.clean) {
      if (emptyProfile) await context.setStorageState(saved);
      else {
        const nativeCookies = await context.cookies();
        const sessions = saved.cookies.filter(
          (c) =>
            c.expires < 0 &&
            !nativeCookies.some(
              (n) =>
                n.name === c.name && n.domain === c.domain && n.path === c.path,
            ),
        );
        if (sessions.length) await context.addCookies(sessions);
      }
    }
    if (options.initialCookies?.length) {
      const existing = await context.cookies();
      const missing = options.initialCookies.filter(
        (c) =>
          !existing.some(
            (e) =>
              e.name === c.name &&
              e.domain.replace(/^\./, "") === c.domain.replace(/^\./, ""),
          ),
      );
      if (missing.length) await context.addCookies(missing);
    }
    const checkpoint = () => {
      queue = queue
        .catch(() => {})
        .then(async () => {
          if (closing) return;
          const state = preserveUnvisitedOrigins(await context.storageState({ indexedDB: true }), trusted, visited);
          const hash = createHash("sha256")
            .update(JSON.stringify(state))
            .digest("hex");
          if (hash !== lastHash) {
            await saveSnapshot(cfg, state);
            lastHash = hash;
          }
        });
      return queue;
    };
    timer = setInterval(() => {
      void checkpoint().catch(() => {});
    }, 5000);
    timer.unref();
    const closed = new Promise((resolve) => context.once("close", resolve));
    const nativeClose = context.close.bind(context);
    let closePromise;
    const close = () =>
      (closePromise ||= (async () => {
        if (closing) return;
        clearInterval(timer);
        let failure;
        try {
          await checkpoint();
          await atomic(metaFile, JSON.stringify({ clean: true }));
        } catch (e) {
          if (context.pages().length) failure = e;
        }
        closing = true;
        options.signal?.removeEventListener("abort", abort);
        await nativeClose().catch(() => {});
        await queue.catch(() => {});
        await lease.release().catch(() => {});
        if (failure)
          throw new BrowserError(
            "BROWSER_SAVE_FAILED",
            "浏览器状态未能保存，请检查用户目录权限。",
          );
      })());
    context.close = close;
    const abort = () => {
      void close().catch(() => {});
    };
    options.signal?.addEventListener("abort", abort, { once: true });
    context.once("close", () => {
      clearInterval(timer);
      void queue.finally(() => lease.release().catch(() => {})).catch(() => {});
    });
    return { context, checkpoint, close, closed, config: cfg };
  } catch (e) {
    clearInterval(timer);
    await context?.close().catch(() => {});
    await lease.release().catch(() => {});
    throw e;
  }
}
export async function withBrowser(options, fn) {
  const browser = await openBrowser(options);
  try {
    const result = await fn(browser.context);
    await browser.checkpoint();
    await options.onSaved?.(await readSnapshot(browser.config), result);
    return result;
  } finally {
    await browser.close();
  }
}
export async function browserStatus(options = {}) {
  const cfg = browserConfig(options);
  let busy = false,
    snapshot = false;
  try {
    busy = await lockfile.check(cfg.stateDir);
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
  }
  try {
    snapshot = (await lstat(path.join(cfg.stateDir, "session.dpapi"))).isFile();
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
  }
  return {
    stateDir: cfg.stateDir,
    runtime: await runtimeInfo(cfg),
    busy,
    encryptedSnapshot: snapshot,
    snapshotSafeToRestore:
      (await readJson(path.join(cfg.stateDir, "snapshot-meta.json")))?.clean ===
      true,
  };
}
export async function resetBrowser(options = {}) {
  const lease = await profileLease(options),
    cfg = lease.config;
  try {
    for (const name of ["profile", "profile-msedge", "profile-chrome"]) {
      const target = path.join(cfg.stateDir, name);
      try {
        const stat = await lstat(target);
        if (
          stat.isSymbolicLink() ||
          !inside(await realpath(cfg.stateDir), await realpath(target))
        )
          throw new BrowserError(
            "BROWSER_UNSAFE_PATH",
            "拒绝清理非本浏览器管理的目录。",
          );
        await rm(target, { recursive: true, force: true });
      } catch (e) {
        if (e.code !== "ENOENT") throw e;
      }
    }
    await rm(path.join(cfg.stateDir, "session.dpapi"), { force: true });
    await rm(path.join(cfg.stateDir, "bindings.json"), { force: true });
    await rm(path.join(cfg.stateDir, "snapshot-meta.json"), { force: true });
  } finally {
    await lease.release();
  }
  return { reset: true, serviceAuthStoresRetained: true };
}
