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
import { acquireLease, releaseLease, startLeaseHeartbeat } from "./browser-lease.mjs";
import {
  services,
  service,
  loadModule,
  root,
  serviceEnvironment,
} from "./services.mjs";
const sites = {
  madmodel: "https://madmodel.cs.tsinghua.edu.cn/",
  learnx: "https://learn.tsinghua.edu.cn/f/wlxt/index/course/student/",
  cloud: "https://cloud.tsinghua.edu.cn/",
  hetang: "https://pro.yuketang.cn/",
  // 场馆预约与图书馆座位没有可校验的登录回执，只借持久资料手动登录，不冒充已核验。
  sports: "https://www.sports.tsinghua.edu.cn/venue/index.html#/home",
  seat: "https://seat.lib.tsinghua.edu.cn/cas/index.php?callback=https%3A%2F%2Fseat.lib.tsinghua.edu.cn%2Fhome%2Fweb%2Ff_second",
};
const manualSites = new Set(["sports", "seat"]);
const browserServices = [...services, { name: "madmodel" }];
const browserService = (name) => name === "madmodel" || manualSites.has(name) ? { name } : service(name);
const safeCode = (e) =>
  typeof e?.code === "string" && /^[A-Z_]+$/.test(e.code)
    ? e.code
    : "BROWSER_FAILED";
// 双摘要：cookieDigest 为完整摘要（值+过期时间，精确快路径）；
// cookieSetDigest 只哈希 cookie 名称/域名/路径，容忍站点正常轮换 cookie 值。
// 三个服务共享同一份浏览器快照，任一服务会话都会整份重写快照，
// 只用完整摘要会让登录绑定在下次任意浏览器使用后必然失配、拒绝无头自动恢复。
// 账号身份仍由在线校验与 accountId 比对兜底，此处仅作会话陈旧性启发式。
const cookieDigest = (s, name, { stable = false } = {}) =>
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
          .map((c) =>
            stable
              ? { name: c.name, domain: c.domain, path: c.path }
              : {
                  name: c.name,
                  domain: c.domain,
                  path: c.path,
                  value: c.value,
                  expires: c.expires,
                },
          )
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
  if (manualSites.has(name))
    throw new BrowserError(
      "BROWSER_MANUAL_LOGIN",
      "该站点没有可供校验的登录回执，请用 campus_browser_open 打开后由本人在窗口中登录。",
    );
  if (name === "madmodel") {
    const { MadModelClient } = await import("./madmodel/client.mjs");
    const client = new MadModelClient({ signal });
    await client.manager.ensure({ force: true, headless, interactive: !headless });
    return client.manager.status();
  }
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
      cookieSetDigest: cookieDigest(snapshot, s.name, { stable: true }),
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
export async function restoreService(name, { expectedAccountId } = {}) {
  try {
    if (name === "madmodel") {
      const { MadModelClient } = await import("./madmodel/client.mjs");
      const client = new MadModelClient();
      if (!(await client.manager.status()).configured) return false;
      await client.manager.ensure({ force: true });
      return true;
    }
    const s = service(name),
      { store } = await auth(s),
      guard = await authGuard(store),
      status = await store.status();
    await authGuard(store, guard);
    if (!status.configured || (expectedAccountId && status.accountId !== expectedAccountId)) return false;
    const cfg = browserConfig(),
      binding = (await readJson(path.join(cfg.stateDir, "bindings.json")))?.[
        s.name
      ];
    const snapshot = await readSnapshot();
    if (
      !binding ||
      binding.accountId !== status.accountId ||
      (binding.cookieDigest !== cookieDigest(snapshot, s.name) &&
        binding.cookieSetDigest !==
          cookieDigest(snapshot, s.name, { stable: true }))
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
  const STALE_QUEUED_MS = 30_000;
  const jobs = [];
  for (const f of names.filter((f) => f.endsWith(".json"))) {
    const j = await readJson(path.join(browserConfig().stateDir, "jobs", f));
    if (j) {
      let status = j.status;
      if (status === "running" || status === "queued") {
        if (j.pid) {
          try {
            process.kill(j.pid, 0);
          } catch {
            status = "interrupted";
          }
        } else if (Date.now() - Date.parse(j.updatedAt || "") > STALE_QUEUED_MS) {
          // 还没写 PID 就消失了（spawn 前崩溃）：不能让它永远占着“有任务在跑”。
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
  if (name !== "all") name = browserService(name).name;
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
  // A synchronous spawn failure arrives on the next tick. Waiting one tick lets the caller
  // learn about it, and lets us persist the failed state before returning instead of racing
  // an unobserved fire-and-forget write against readers of the same file.
  const spawnFailure = await new Promise(resolve => {
    const timer = setTimeout(() => resolve(null), 0);
    child.once("error", error => { clearTimeout(timer); resolve(error ?? new Error("WORKER_START")); });
  });
  if (spawnFailure) {
    const failed = { ...job, status: "failed", error: "WORKER_START", updatedAt: new Date().toISOString() };
    // A state directory that disappears during shutdown must not crash the runtime.
    await atomic(jobPath(job.id), JSON.stringify(failed)).catch(() => {});
    return { id: job.id, status: "failed", error: "WORKER_START", service: name, action };
  }
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
/** 取消单个任务：只写 stop 标记，真正的收敛由 worker 自己处理。 */
export async function cancelBrowserJob(id) {
  const job = (await browserJobs()).find(item => item.id === id);
  if (!job) return { ok: false, code: "JOB_NOT_FOUND" };
  if (!["queued", "running"].includes(job.status)) return { ok: false, code: "JOB_FINISHED", status: job.status };
  await metadataLock(job.id, async () => {
    const raw = await readJson(jobPath(job.id));
    await atomic(jobPath(job.id), JSON.stringify({ ...raw, stop: true }));
  });
  return { ok: true, requested: true, status: job.status };
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
  let leaseOwner = "";
  let stopHeartbeat = () => {};
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
    // 窗口真实存活期间持有跨进程租约：app 侧任务看到它就不会再撞档案目录。
    leaseOwner = `worker:${job.id}`;
    const claim = await acquireLease(browserConfig().stateDir, { owner: leaseOwner, label: `${job.action}:${job.service}`, pid: process.pid }).catch(() => ({ ok: false }));
    if (claim.ok) stopHeartbeat = startLeaseHeartbeat(browserConfig().stateDir, leaseOwner);
    if (job.action === "login") {
      for (const s of job.service === "all"
        ? browserServices
        : [browserService(job.service)]) {
        if ((await readJson(file))?.stop) break;
        await loginService(s.name, {
          account: job.account,
          signal: controller.signal,
        });
      }
    } else {
      const b = await openBrowser();
      try {
        const targets = job.service === "all" ? browserServices : [browserService(job.service)];
        for (const [index, s] of targets.entries()) {
          // 只让第一站复用初始空白页；后续站点各开一个标签页，否则会互相覆盖。
          const p = index === 0 ? b.context.pages()[0] || await b.context.newPage() : await b.context.newPage();
          // 导航期间也要能被“停止”打断，否则会一直开到 60 秒超时。
          await p.goto(sites[s.name], {
            waitUntil: "domcontentloaded",
            timeout: 60000,
            signal: controller.signal,
          });
        }
        let closed = false;
        // closed is a resolve-only event notification; close/save failures are awaited below.
        void b.closed.then(() => (closed = true));
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
    stopHeartbeat();
    if (leaseOwner) await releaseLease(browserConfig().stateDir, { owner: leaseOwner }).catch(() => {});
  }
  await save();
}
export async function browserOverview() {
  return { ...(await browserStatus()), jobs: await browserJobs() };
}
