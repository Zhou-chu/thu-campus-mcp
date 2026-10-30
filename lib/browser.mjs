import path from "node:path";
import { spawn } from "node:child_process";
import lockfile from "proper-lockfile";
import { randomUUID, createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import {
  browserConfig,
  browserStatus,
  openBrowser,
  installRuntime,
  runtimeInfo,
  readSnapshot,
  BrowserError,
  authGuard,
} from "@thu-campus/browser";
import { atomic, readJson, directory } from "../packages/browser/core.mjs";
import {
  services,
  service,
  loadModule,
  root,
  serviceEnvironment,
} from "./services.mjs";
const sites = {
  learnx: "https://learn.tsinghua.edu.cn/f/wlxt/index/course/student/",
  cloud: "https://cloud.tsinghua.edu.cn/",
  hetang: "https://pro.yuketang.cn/",
};
const safeCode = (e) =>
  typeof e?.code === "string" && /^[A-Z_]+$/.test(e.code)
    ? e.code
    : "BROWSER_FAILED";
const cookieDigest = (s, name) =>
  createHash("sha256")
    .update(
      JSON.stringify(
        (s?.cookies || [])
          .filter((c) => {
            const d = c.domain.replace(/^\./, "");
            return (
              d === "id.tsinghua.edu.cn" ||
              d ===
                {
                  learnx: "learn.tsinghua.edu.cn",
                  cloud: "cloud.tsinghua.edu.cn",
                  hetang: "pro.yuketang.cn",
                }[name] ||
              (name === "hetang" && d === "yuketang.cn")
            );
          })
          .map((c) => ({
            name: c.name,
            domain: c.domain,
            path: c.path,
            value: c.value,
            expires: c.expires,
          }))
          .sort((a, b) =>
            (a.domain + a.name + a.path).localeCompare(
              b.domain + b.name + b.path,
            ),
          ),
      ),
    )
    .digest("hex");
async function auth(s) {
  const [{ AuthStore }, { loadConfig }] = await Promise.all([
    loadModule(s, "auth.js"),
    loadModule(s, "config.js"),
  ]);
  const cfg = loadConfig();
  return { cfg, store: new AuthStore(cfg.stateDir) };
}
export async function loginService(
  name,
  { headless = false, account, signal, guard } = {},
) {
  const s = service(name),
    { cfg, store } = await auth(s),
    frozen = await authGuard(store, guard),
    before = await store.status();
  await authGuard(store, frozen);
  if (guard?.accountId && guard.accountId !== before.accountId)
    throw new BrowserError("AUTH_CHANGED", "恢复期间账号已变化。");
  const { browserLogin } = await loadModule(s, "browser-auth.js");
  const options = {
    headless,
    signal,
    timeoutMs: headless ? 45000 : 600000,
    expectedAccountId: headless ? before.accountId : undefined,
    expectedGeneration: frozen.epoch,
    expectedVersion: frozen.version,
  };
  options.onSaved = async (snapshot, result) => {
    const after = await store.status();
    if (
      (await store.version()) !== result.authVersion ||
      after.accountId !== result.accountId
    )
      throw new BrowserError(
        "AUTH_CHANGED",
        "登录完成时认证已变化，未绑定旧浏览器状态。",
      );
    if (headless && after.accountId !== before.accountId)
      throw new BrowserError(
        "BROWSER_ACCOUNT_MISMATCH",
        "浏览器账号与 MCP 账号不一致。",
      );
    const bindingsFile = path.join(browserConfig().stateDir, "bindings.json"),
      bindings = (await readJson(bindingsFile)) || {};
    bindings[s.name] = {
      accountId: after.accountId,
      cookieDigest: cookieDigest(snapshot, s.name),
      updatedAt: new Date().toISOString(),
    };
    await atomic(bindingsFile, JSON.stringify(bindings, null, 2) + "\n");
  };
  let result;
  if (s.name === "learnx") {
    const local = await store.load();
    const bound = account || local?.account;
    if (!bound)
      throw new BrowserError(
        "BROWSER_ACCOUNT_REQUIRED",
        "首次网络学堂登录需要本地绑定学号；请运行 browser login learnx --account 学号。",
      );
    result = await browserLogin(store, bound, undefined, options);
  } else result = await browserLogin(cfg, undefined, options);
  return result;
}
export async function restoreService(name) {
  try {
    const s = service(name),
      { store } = await auth(s),
      guard = await authGuard(store),
      status = await store.status();
    await authGuard(store, guard);
    if (!status.configured) return false;
    const cfg = browserConfig(),
      binding = (await readJson(path.join(cfg.stateDir, "bindings.json")))?.[
        s.name
      ];
    if (
      !binding ||
      binding.accountId !== status.accountId ||
      binding.cookieDigest !== cookieDigest(await readSnapshot(), s.name)
    )
      return false;
    if (
      !(await browserStatus()).snapshotSafeToRestore ||
      !(await runtimeInfo()).installed
    )
      return false;
    await loginService(s.name, {
      headless: true,
      guard: { ...guard, accountId: status.accountId },
    });
    return true;
  } catch {
    return false;
  }
}
function jobPath(id) {
  if (!/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(id))
    throw new BrowserError("INVALID_ID", "浏览器任务 ID 无效。");
  return path.join(browserConfig().stateDir, "jobs", id + ".json");
}
export async function browserJobs() {
  let names = [];
  try {
    names = await readdir(path.join(browserConfig().stateDir, "jobs"));
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
  }
  const jobs = [];
  for (const f of names.filter((f) => f.endsWith(".json"))) {
    const j = await readJson(path.join(browserConfig().stateDir, "jobs", f));
    if (j) {
      let status = j.status;
      if (status === "running" || status === "queued") {
        try {
          if (j.pid) process.kill(j.pid, 0);
        } catch {
          status = "interrupted";
        }
      }
      jobs.push({
        id: j.id,
        action: j.action,
        service: j.service,
        status,
        phase: j.phase,
        error: j.error,
        updatedAt: j.updatedAt,
      });
    }
  }
  return jobs
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, 20);
}
async function metadataLock(name, fn) {
  const dir = path.join(browserConfig().stateDir, "locks", name);
  await directory(dir);
  const release = await lockfile.lock(dir, {
    retries: { retries: 30, minTimeout: 25, maxTimeout: 200 },
    stale: 120000,
    update: 10000,
  });
  try {
    return await fn();
  } finally {
    await release();
  }
}
export async function startBrowserJob(action, name = "all", account) {
  return metadataLock("catalog", () => startUnlocked(action, name, account));
}
async function startUnlocked(action, name = "all", account) {
  if (!["open", "login"].includes(action))
    throw new BrowserError("BROWSER_USAGE", "不支持的浏览器操作。");
  if (name !== "all") name = service(name).name;
  const running = (await browserJobs()).find((j) =>
    ["queued", "running"].includes(j.status),
  );
  if (running) {
    const original = await readJson(jobPath(running.id));
    const same =
      running.action === action &&
      running.service === name &&
      original.account === account;
    return {
      ...running,
      status: same ? running.status : "busy",
      reused: same,
      requestedAction: action,
      requestedService: name,
      requiresClose: !same,
    };
  }
  const job = {
    id: randomUUID(),
    action,
    service: name,
    account,
    status: "queued",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  await atomic(jobPath(job.id), JSON.stringify(job));
  const child = spawn(
    process.execPath,
    [path.join(root, "bin/thu-campus.mjs"), "browser", "worker", job.id],
    {
      detached: true,
      windowsHide: true,
      stdio: "ignore",
      env: serviceEnvironment(),
    },
  );
  child.once(
    "error",
    () =>
      void atomic(
        jobPath(job.id),
        JSON.stringify({ ...job, status: "failed", error: "WORKER_START" }),
      ),
  );
  child.unref();
  return { id: job.id, status: "queued", service: name, action };
}
export async function closeBrowserJobs() {
  let stopped = 0;
  for (const j of await browserJobs()) {
    if (!["queued", "running"].includes(j.status)) continue;
    await metadataLock(j.id, async () => {
      const raw = await readJson(jobPath(j.id));
      await atomic(jobPath(j.id), JSON.stringify({ ...raw, stop: true }));
    });
    stopped++;
  }
  return { stopRequested: stopped };
}
export async function runBrowserJob(id) {
  const file = jobPath(id),
    job = await readJson(file);
  if (!job || job.status !== "queued") return;
  const save = async () =>
    metadataLock(id, async () => {
      if ((await readJson(file))?.stop) job.stop = true;
      job.updatedAt = new Date().toISOString();
      await atomic(file, JSON.stringify(job));
    });
  job.pid = process.pid;
  job.status = "running";
  await save();
  const controller = new AbortController();
  const stopTimer = setInterval(() => {
    void readJson(file)
      .then((j) => {
        if (j?.stop) controller.abort();
      })
      .catch(() => {});
  }, 500);
  stopTimer.unref();
  try {
    if (process.env.THU_CAMPUS_MOCK === "1") {
      job.status = "complete";
      job.simulation = true;
      await save();
      return;
    }
    if (!(await runtimeInfo()).installed) {
      job.phase = "downloading";
      await save();
      await installRuntime();
    }
    if ((await readJson(file))?.stop) {
      job.status = "stopped";
      await save();
      return;
    }
    job.phase = job.action;
    await save();
    if (job.action === "login") {
      for (const s of job.service === "all"
        ? services
        : [service(job.service)]) {
        if ((await readJson(file))?.stop) break;
        await loginService(s.name, {
          account: job.account,
          signal: controller.signal,
        });
      }
    } else {
      const b = await openBrowser();
      try {
        for (const s of job.service === "all"
          ? services
          : [service(job.service)]) {
          const p = await b.context.newPage();
          await p.goto(sites[s.name], {
            waitUntil: "domcontentloaded",
            timeout: 60000,
          });
        }
        let closed = false;
        b.closed.then(() => (closed = true));
        while (!closed) {
          if ((await readJson(file))?.stop) break;
          await new Promise((r) => setTimeout(r, 500));
        }
      } finally {
        await b.close();
      }
    }
    job.status = (await readJson(file))?.stop ? "stopped" : "complete";
  } catch (e) {
    job.status = (await readJson(file))?.stop ? "stopped" : "failed";
    job.error = safeCode(e);
    // Playwright messages may contain redirect tickets or input arguments.
    job.detail = /timeout/i.test(String(e?.message)) ? "Browser operation timed out."
      : /interrupted|ERR_ABORTED/i.test(String(e?.message)) ? "Browser navigation was interrupted."
      : /closed|detached/i.test(String(e?.message)) ? "Browser page was closed or detached."
      : "Browser operation failed; use the error code to diagnose.";
  } finally {
    clearInterval(stopTimer);
  }
  await save();
}
export async function browserOverview() {
  return { ...(await browserStatus()), jobs: await browserJobs() };
}
