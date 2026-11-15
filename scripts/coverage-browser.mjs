/** Coverage-only preload. Never imported by production/E2E entry points themselves. */
import path from "node:path";
import { randomUUID } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { hashSource, isProductionPath } from "./coverage.mjs";

export function webSourceForUrl(url) {
  try {
    const parsed = new URL(url);
    if (!["http:", "https:"].includes(parsed.protocol) || !["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname) || parsed.username || parsed.password) return null;
    const pathname = decodeURIComponent(parsed.pathname).replace(/^\/+/, "");
    const relative = pathname.startsWith("webui/") ? pathname : `webui/${pathname}`;
    return isProductionPath(relative) && relative.startsWith("webui/") ? relative : null;
  } catch { return null; }
}
/** URL/query/fragment and page data are never persisted; only matching repository JS. */
export async function saveBrowserEntries(entries, { root, manifest, directory }) {
  const records = [], errors = [];
  for (const entry of entries) {
    const file = webSourceForUrl(entry.url);
    if (!file || !Object.hasOwn(manifest.files, file)) continue;
    if (typeof entry.source !== "string" || !Array.isArray(entry.functions)) { errors.push(`BROWSER_SOURCE_UNAVAILABLE:${file}`); continue; }
    const source = await readFile(path.join(root, file), "utf8");
    const hash = hashSource(source);
    if (hash !== manifest.files[file] || hashSource(entry.source) !== hash) { errors.push(`BROWSER_SOURCE_MISMATCH:${file}`); continue; }
    records.push({ file, hash, source, functions: entry.functions });
  }
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, `${process.pid}-${randomUUID()}.json`), JSON.stringify({ records, errors }));
  return { records: records.length, errors };
}
function replaceMethod(target, name, factory) {
  if (typeof target?.[name] !== "function") return;
  const original = target[name].bind(target);
  target[name] = factory(original);
}
/** Await start before each public newPage resolves; flush before page/context/browser close. */
export function instrumentChromium(chromium, { save, problem = () => { process.exitCode = 1; } }) {
  const browsers = new WeakSet(), contexts = new WeakSet(), states = new WeakMap();
  const reportProblem = async code => { await problem(code); };
  function preparePage(page) {
    if (states.has(page)) return states.get(page).ready;
    const state = { started: false, stopped: null, ready: null };
    states.set(page, state);
    state.ready = (async () => {
      try {
        await page.coverage.startJSCoverage({ resetOnNavigation: false, reportAnonymousScripts: false });
        state.started = true;
      } catch { await reportProblem("BROWSER_COVERAGE_START_FAILED"); }
      return page;
    })();
    replaceMethod(page, "close", original => async (...args) => {
      try { await stopPage(page); } finally { return original(...args); }
    });
    page.on?.("close", () => { if (!state.stopped) void stopPage(page).catch(() => reportProblem("BROWSER_CLOSED_WITHOUT_FLUSH")); });
    return state.ready;
  }
  function stopPage(page) {
    const state = states.get(page);
    if (!state) return Promise.resolve();
    if (state.stopped) return state.stopped;
    state.stopped = (async () => {
      await state.ready;
      if (!state.started) return;
      try {
        const result = await save(await page.coverage.stopJSCoverage());
        for (const error of result?.errors || []) await reportProblem(error);
      } catch { await reportProblem("BROWSER_COVERAGE_STOP_FAILED"); }
    })();
    return state.stopped;
  }
  async function prepareContext(context) {
    if (!contexts.has(context)) {
      contexts.add(context);
      replaceMethod(context, "newPage", original => async (...args) => {
        const page = await original(...args); await preparePage(page); return page;
      });
      replaceMethod(context, "close", original => async (...args) => {
        try { await Promise.all(context.pages().map(stopPage)); } finally { return original(...args); }
      });
      context.on?.("page", page => { void preparePage(page).catch(() => reportProblem("BROWSER_PAGE_CAPTURE_FAILED")); });
    }
    await Promise.all(context.pages().map(preparePage));
    return context;
  }
  async function prepareBrowser(browser) {
    if (browsers.has(browser)) return browser;
    browsers.add(browser);
    replaceMethod(browser, "newContext", original => async (...args) => prepareContext(await original(...args)));
    replaceMethod(browser, "newPage", original => async (...args) => {
      const page = await original(...args);
      await prepareContext(page.context()); await preparePage(page); return page;
    });
    replaceMethod(browser, "close", original => async (...args) => {
      try { await Promise.all(browser.contexts().flatMap(context => context.pages()).map(stopPage)); } finally { return original(...args); }
    });
    await Promise.all(browser.contexts().map(prepareContext));
    return browser;
  }
  replaceMethod(chromium, "launch", original => async (...args) => prepareBrowser(await original(...args)));
  replaceMethod(chromium, "launchPersistentContext", original => async (...args) => prepareContext(await original(...args)));
}
export async function installBrowserCoverage(env = process.env) {
  const root = env.CAMPUS_COVERAGE_ROOT, directory = env.CAMPUS_COVERAGE_BROWSER_DIR;
  if (!root || !directory || !env.CAMPUS_COVERAGE_MANIFEST) throw new Error("BROWSER_COVERAGE_ENV_REQUIRED");
  const manifest = JSON.parse(await readFile(env.CAMPUS_COVERAGE_MANIFEST, "utf8"));
  const { chromium } = await import("playwright-core");
  const problem = async code => {
    process.exitCode = 1;
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, `${process.pid}-${randomUUID()}.json`), JSON.stringify({ records: [], errors: [code] }));
  };
  instrumentChromium(chromium, { save: entries => saveBrowserEntries(entries, { root, manifest, directory }), problem });
}
if (process.env.CAMPUS_COVERAGE_BROWSER === "1") await installBrowserCoverage();
