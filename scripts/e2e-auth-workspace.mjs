#!/usr/bin/env node
import assert from "node:assert/strict";
import path from "node:path";
import { mkdtemp, mkdir, readdir, readFile, stat, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { chromium } from "playwright-core";
import { createAppServer } from "../lib/app/server.mjs";
import { SessionStore } from "../lib/app/sessions.mjs";
import { WorkspaceFiles } from "../lib/app/workspace-files.mjs";
import { DeviceStore } from "../lib/app/devices.mjs";
import { PairingCodes } from "../lib/app/pairing.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const TOKEN = "auth-workspace-fixture";
let checks = 0;
function check(name, condition) { assert.ok(condition, name); checks++; console.log("  ✔ " + name); }
async function chromiumPath() {
  for (const name of await readdir(path.join(ROOT, ".runtime/browsers"))) {
    const file = path.join(ROOT, ".runtime/browsers", name, "chrome-win64/chrome.exe");
    if (name.startsWith("chromium-") && await stat(file).then(() => true, () => false)) return file;
  }
  throw new Error("Chromium unavailable");
}
const proof = endpoint => ({ verified: true, checkedAt: new Date().toISOString(), source: "protected-api:" + endpoint, sessionValidity: "valid", configured: true });

async function main() {
  const dir = await mkdtemp(path.join(tmpdir(), "campus-auth-workspace-"));
  const screenshotDir = process.env.CAMPUS_E2E_SCREENSHOT_DIR || await mkdtemp(path.join(tmpdir(), "campus-auth-workspace-shots-"));
  await mkdir(screenshotDir, { recursive: true });
  const statuses = { learn_status: { configured: true, account: "configured-account-not-proof", hasCookie: true }, cloud_status: proof("cloud-account-info"), rain_status: { authenticated: false, code: "AUTH_REQUIRED" }, madmodel_status: { configured: true, mode: "mock" } };
  const scope = { accountId: "fixture-account-digest", repoId: "fixture-private-repo", rootPath: "/Agent工作区" };
  const privacy = { verified: true, checkedAt: new Date().toISOString(), code: "PRIVATE_VERIFIED" };
  let storage = { mode: "cloud", state: "uninitialized", scope, privacy }, failStorage = false;
  let loginCalls = 0, jobRequests = 0, directWrites = 0, initCalls = 0, syncCalls = 0, getCalls = 0, stopCalls = 0;
  const sessions = new SessionStore(dir), files = new WorkspaceFiles({ baseDir: path.join(dir, "workspaces") });
  const session = await sessions.create({ title: "Cloud同步受控样本" });
  await files.writeBytes(session.id, { path: "report.pdf", bytes: Buffer.from("%PDF-local-sync-failed-fixture") });
  const makeJob = (jobId, scriptPath, extra = {}) => ({ jobId, state: "succeeded", runtime: "python", scriptPath, stdout: "本地计算结果已保留", stderr: "", statusUrl: `/api/workspaces/${session.id}/jobs/${jobId}`, storage: { mode: "cloud", state: "pending" }, ...extra });
  const pendingJob = makeJob("11111111-1111-4111-8111-111111111111", "analysis.py");
  const cleanupJob = makeJob("22222222-2222-4222-8222-222222222222", "cleanup.py", { state: "interrupted", cleanupPending: true, storage: { mode: "cloud", state: "failed", code: "SANDBOX_CLEANUP_PENDING", message: "容器回收未确认，未上传" } });
  const jobs = new Map([[pendingJob.jobId, pendingJob], [cleanupJob.jobId, cleanupJob]]);
  const record = job => [{ role: "assistant", content: "", toolCalls: [{ id: job.jobId, name: "workspace_run", arguments: JSON.stringify({ runtime: "python", scriptPath: job.scriptPath }) }] }, { role: "tool", toolCallId: job.jobId, content: JSON.stringify({ ok: true, data: job }) }];
  await sessions.append(session.id, [
    { role: "user", content: "本地计算与云盘同步样本" }, ...record(pendingJob), ...record(cleanupJob),
    { role: "assistant", content: "", toolCalls: [{ id: "local-write", name: "workspace_write", arguments: '{"path":"report.pdf"}' }] },
    { role: "tool", toolCallId: "local-write", content: JSON.stringify({ ok: true, data: { path: "report.pdf", storage: { mode: "cloud", state: "unconfirmed", code: "CLOUD_PUSH_FAILED", message: "本地写入已完成，云盘上传尚未确认" } } }) },
    { role: "assistant", reasoning: "受控历史思考样本", content: `## 本地计算结果\n\n[下载本地报告](/api/workspaces/${session.id}/files?path=report.pdf)\n\n| 对象 | 状态 |\n| --- | --- |\n| 本地结果 | 已保留 |\n| 云盘同步 | 待真实回执 |\n\n` + "长消息阅读样本：计算结果与云盘同步分别核对，不把本地缓存当已保存。\n".repeat(18) },
  ]);
  const initialize = { name: "workspace_initialize", service: "workspace", description: "初始化固定私有工作区", readOnly: false, destructive: true, mandatoryApproval: true, inputSchema: { type: "object", properties: {}, additionalProperties: false } };
  const host = {
    workspaceFiles: files,
    storageStatus: async () => { if (failStorage) throw new Error("受控云盘状态接口暂不可用"); return storage; },
    job: (sid, job) => ({ ...job, statusUrl: `/api/workspaces/${sid}/jobs/${job.jobId}` }),
    sandbox: {
      async get(sid, id) { assert.equal(sid, session.id); getCalls++; return { ...jobs.get(id) }; },
      async stop(sid, id) { assert.equal(sid, session.id); stopCalls++; const next = { ...jobs.get(id), state: "cancelled", cleanupPending: false }; jobs.set(id, next); return next; },
      async close() {}, async stopSession() {},
    },
    describe: () => [initialize, { ...initialize, name: "workspace_sync", mandatoryApproval: false }],
    toolForModel: () => [{ type: "function", function: { name: initialize.name, parameters: initialize.inputSchema } }],
    prepareCall: async name => ({ mandatoryApproval: name === "workspace_initialize", approvalArgs: { accountId: scope.accountId, expectedRepoId: scope.repoId, rootPath: scope.rootPath, private: true, sessions: "sessions/<UUID>/" }, risk: "将在已核验的个人私有资料库创建固定Agent工作区，仅限下列完整范围。" }),
    async call(name, args, context) {
      if (name === "campus_browser_login") { loginCalls++; return { ok: true, data: { jobId: "fixture-browser-open", state: "running" } }; }
      if (Object.hasOwn(statuses, name)) {
        assert.equal(args.verify, true, "认证探针必须显式执行只读验证");
        const value = statuses[name]; return value.error ? { ok: false, error: value.error } : { ok: true, data: value };
      }
      assert.equal(context.approved, true);
      if (name === "workspace_initialize") { initCalls++; storage = { ...storage, state: "ready" }; return { ok: true, data: storage }; }
      if (name === "workspace_sync") { syncCalls++; return { ok: true, data: { storage: { mode: "cloud", state: "synced" } } }; }
      throw new Error("Unexpected fixture tool: " + name);
    },
    close: async () => {},
  };
  const route = {
    route: "madmodel", models: async () => [{ id: "fixture", label: "受控本地模型" }], status: async () => ({ configured: true, available: true, mode: "mock" }),
    chat: async request => Response.json({ choices: [{ message: request.messages.at(-1).role === "tool" ? { content: "已完成受控初始化，工作区状态须读取真实接口。" } : { content: "", tool_calls: [{ id: "initialize-fixture", type: "function", function: { name: "workspace_initialize", arguments: "{}" } }] } }] }),
  };
  const keepAlive = { status: () => ({ enabled: true, intervalMs: 1800000, history: [{ at: new Date().toISOString(), trigger: "fixture", durationMs: 1, ok: true, services: { learnx: "ready" } }, { at: new Date().toISOString(), trigger: "fixture", durationMs: 1, ok: true, services: { cloud: "ready" }, serviceEvidence: { cloud: { ...proof("cloud-account-info"), state: "ready" } } }], expiredServices: [] }) };
  const app = createAppServer({ config: { host: "127.0.0.1", hostname: "localhost", port: 0, stateDir: dir, token: TOKEN, modelRoute: "madmodel", modelName: "fixture", requireApproval: true }, host, route, sessions, keepAlive, version: "auth-workspace-test", webuiDir: path.join(ROOT, "webui"), devices: new DeviceStore(dir, { encrypt: async value => value }), pairing: new PairingCodes() });
  let browser;
  try {
    const base = await app.listen(), headers = { authorization: "Bearer " + TOKEN };
    const response = await fetch(base + "/api/auth/status", { headers }); assert.equal(response.status, 200);
    const initial = await response.json();
    check("真实HTTP不把本地配置当已登录", initial.services.learnx.state === "unverified" && initial.services.learnx.verified === false);
    check("真实HTTP保留受保护API证据", initial.services.cloud.state === "ready" && initial.services.cloud.verified === true && initial.services.cloud.source.startsWith("protected-api:"));
    check("真实只读Cloud状态API不执行初始化", (await (await fetch(base + "/api/workspace/storage", { headers })).json()).storage.state === "uninitialized" && initCalls === 0);
    check("无设备令牌不能读取Cloud工作区", (await fetch(base + "/api/workspace/storage")).status === 401);
    for (const name of ["workspace_initialize", "cloud_workspace_init"]) check(name + "手动写API禁止绕审批", (await fetch(base + "/api/tools/" + name, { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: "{}" })).status === 403);
    browser = await chromium.launch({ executablePath: await chromiumPath(), headless: true });
    const page = await browser.newPage({ viewport: { width: 1920, height: 1000 }, acceptDownloads: true });
    const errors = []; page.on("pageerror", error => errors.push(error.message));
    page.on("request", request => { if (/\/api\/jobs\//.test(request.url())) jobRequests++; if (request.method() !== "GET" && /\/api\/(?:workspace\/storage|tools\/(?:cloud_workspace|workspace_initialize|workspace_sync))/.test(request.url())) directWrites++; });
    await page.goto(base + "/#token=" + TOKEN); await page.waitForSelector("#composer");
    check("顶部服务运行状态不代表四服务登录", await page.locator("#account").innerText() === "服务运行中");
    await page.click('button[data-view="services"]');
    const service = name => page.locator(`.auth-service[data-service="${name}"]`), label = name => service(name).locator(".state").innerText();
    const verify = async () => { await page.getByRole("button", { name: "核验登录状态", exact: true }).click(); await page.getByRole("button", { name: "核验登录状态", exact: true }).waitFor(); };
    check("配置未核验、已登录、未登录、模拟分别呈现", await label("learnx") === "未核验" && await label("cloud") === "已登录" && await label("hetang") === "未登录" && await label("madmodel") === "模拟");
    check("不显示配置身份作为登录证据", !(await page.locator("#view").innerText()).includes("configured-account-not-proof"));
    await service("cloud").locator(".auth-evidence > summary").click();
    check("核验记录可主动展开来源与时间", (await service("cloud").locator(".auth-evidence").innerText()).includes("protected-api:cloud-account-info"));
    await page.waitForSelector(".timeline-item");
    check("旧ready历史无证据降未核验，新证据仍显示已登录", (await page.locator(".timeline-item").nth(0).innerText()).includes("未核验") && (await page.locator(".timeline-item").nth(1).innerText()).includes("已登录"));
    await service("hetang").getByRole("button", { name: "登录", exact: true }).click(); await service("hetang").locator(".auth-notice").waitFor();
    check("打开登录窗口不算登录成功", loginCalls === 1 && await label("hetang") === "未核验" && jobRequests === 0);
    await verify(); check("窗口未产生核验证据仍为未登录", await label("hetang") === "未登录");
    statuses.rain_status = proof("rain-basic-info"); await verify(); check("有效保存会话无需新扫码也可真实核验", await label("hetang") === "已登录");
    statuses.rain_status = { error: { code: "AUTH_EXPIRED", message: "fixture expired" } }; statuses.learn_status = { error: { code: "NETWORK_ERROR", message: "fixture unavailable" } }; await verify();
    check("真实过期与网络无法核验分开", await label("hetang") === "登录已过期" && await label("learnx") === "无法核验");
    check("校园核验失败不误报应用停止运行", await page.locator("#account").innerText() === "服务运行中");
    await page.route("**/api/auth/status", route => route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ ok: false, error: { message: "fixture status unavailable" } }) }));
    await verify(); check("HTTP核验失败不保留旧已登录标签且有恢复入口", await label("cloud") === "无法核验" && await page.locator(".auth-panel > .error").count() === 1);
    await page.unroute("**/api/auth/status"); await verify(); check("主动重试恢复真实认证证据", await label("cloud") === "已登录");
    await page.screenshot({ path: path.join(screenshotDir, "auth-light-1920.png") });
    await page.click('button[data-view="settings"]');
    const storageCard = page.locator(".workspace-storage-card"), storageLabel = () => storageCard.locator(".storage-status").innerText();
    const refreshStorage = async () => { await storageCard.getByRole("button", { name: "刷新工作区状态" }).click(); await page.waitForFunction(() => [...document.querySelectorAll(".workspace-storage-card button")].some(button => button.textContent === "刷新工作区状态" && !button.disabled)); };
    check("审计通过的未初始化范围不冒充已创建", await storageLabel() === "云盘工作区待初始化" && initCalls === 0);
    failStorage = true; await refreshStorage(); check("状态查询失败不伪装空列表或旧ready", await storageLabel() === "云盘工作区不可用" && (await storageCard.innerText()).includes("查询失败"));
    failStorage = false; storage = { ...storage, state: "ready", privacy: { ...privacy, verified: false } }; await refreshStorage();
    check("无隐私证据的ready被保守降级且不可初始化", await storageLabel() === "云盘工作区未核验" && await storageCard.getByRole("button", { name: "在对话中初始化" }).count() === 0);
    storage = { ...storage, state: "uninitialized", privacy }; await refreshStorage();
    await storageCard.getByRole("button", { name: "在对话中初始化" }).click();
    check("初始化按钮只填写精确预览草稿，不直接写云盘", (await page.locator("#composer").inputValue()).includes(scope.repoId) && initCalls === 0 && directWrites === 0);
    await page.click("#chat-send"); await page.waitForSelector(".confirm-card");
    const confirmation = await page.locator(".confirm-card").innerText();
    check("初始化由服务端冻结完整私有scope后先审批", initCalls === 0 && confirmation.includes(scope.accountId) && confirmation.includes("expectedRepoId") && confirmation.includes(scope.rootPath) && confirmation.includes("sessions/<UUID>/") && confirmation.includes("private"));
    await page.getByRole("button", { name: "允许执行", exact: true }).click(); await page.waitForFunction(() => !document.querySelector("#chat-send")?.disabled);
    check("允许后才执行真实受控初始化，未调用raw写API", initCalls === 1 && directWrites === 0);
    await page.click('button[data-view="settings"]'); await refreshStorage(); check("真实ready与审计范围到位后工作区可用", await storageLabel() === "云盘工作区可用");
    await page.screenshot({ path: path.join(screenshotDir, "storage-light-1920.png") });
    const openSession = async () => { await page.click('button[data-view="sessions"]'); await page.locator(".session-row .item").filter({ hasText: session.title }).click(); await page.waitForSelector("#composer"); };
    await openSession();
    const analysis = page.locator(".tool-card").filter({ hasText: "analysis.py" }), cleanup = page.locator(".tool-card").filter({ hasText: "cleanup.py" }), local = page.locator(".tool-card").filter({ has: page.locator(".tool-name", { hasText: "workspace_write" }) });
    check("计算完成与云盘pending分别显示", await analysis.locator(".tool-state").innerText() === "计算完成" && await analysis.locator(".job-storage-state").innerText() === "云盘同步中");
    jobs.set(pendingJob.jobId, { ...pendingJob, storage: { mode: "cloud", state: "failed", code: "CLOUD_SYNC_FAILED", message: "受控云盘同步中断，本地结果保留" } });
    await page.waitForFunction(() => [...document.querySelectorAll(".tool-card")].some(card => card.textContent.includes("analysis.py") && card.querySelector(".job-storage-state")?.textContent === "云盘同步失败"));
    check("计算已成功但云盘失败不能显示已保存", await analysis.locator(".tool-state").innerText() === "计算完成" && await analysis.locator(".job-storage-state").innerText() === "云盘同步失败");
    await analysis.locator(":scope > summary").click();
    const downloadEvent = page.waitForEvent("download"); await page.getByRole("link", { name: "下载本地报告" }).click(); const report = await downloadEvent;
    check("同步失败仍可授权下载真实本地结果", (await readFile(await report.path(), "utf8")) === "%PDF-local-sync-failed-fixture");
    await analysis.getByRole("button", { name: "在对话中恢复同步" }).click();
    check("恢复只填workspace_sync草稿且不重跑计算", (await page.locator("#composer").inputValue()).includes("workspace_sync") && (await page.locator("#composer").inputValue()).includes("不要重新运行计算") && syncCalls === 0);
    await local.locator(":scope > summary").click();
    check("本地ok回执但unconfirmed明确非云盘已保存", await local.locator(".tool-state").innerText() === "本地操作完成" && await local.locator(".job-storage-state").innerText() === "仅本地·云盘未确认");
    await local.getByRole("button", { name: "在对话中恢复同步" }).click(); check("本地未确认上传仍有对话恢复动作", (await page.locator("#composer").inputValue()).includes("workspace_sync") && directWrites === 0);
    await cleanup.locator(":scope > summary").click(); check("终态但cleanupPending仍允许重试停止", await cleanup.getByRole("button", { name: "重试停止" }).isEnabled());
    await cleanup.getByRole("button", { name: "重试停止" }).click(); await page.waitForFunction(() => [...document.querySelectorAll(".tool-card")].some(card => card.textContent.includes("cleanup.py") && card.querySelector(".tool-state")?.textContent === "作业已停止"));
    check("重试停止使用独立API且未触发上传", stopCalls === 1 && syncCalls === 0);
    const callsAfterFailure = getCalls; await page.waitForTimeout(1700); check("同步failed与回收终态无空轮询", getCalls === callsAfterFailure);
    const syncedJob = makeJob("33333333-3333-4333-8333-333333333333", "synced.py"); jobs.set(syncedJob.jobId, { ...syncedJob, storage: { mode: "cloud", state: "synced" } });
    await sessions.append(session.id, record(syncedJob)); await openSession();
    const synced = page.locator(".tool-card").filter({ hasText: "synced.py" });
    await page.waitForFunction(() => [...document.querySelectorAll(".tool-card")].some(card => card.textContent.includes("synced.py") && card.querySelector(".job-storage-state")?.textContent === "云盘已保存"));
    check("compute终态的pending仍查询真实synced回执", await synced.locator(".tool-state").innerText() === "计算完成" && await synced.locator(".job-storage-state").innerText() === "云盘已保存");
    await openSession(); check("历史pending不覆盖已经确认的同步终态", await synced.locator(".job-storage-state").innerText() === "云盘已保存");
    const sizes = [];
    for (const width of [390, 1280, 1536, 1920, 2560]) {
      await page.setViewportSize({ width, height: width === 390 ? 640 : 1000 });
      await page.locator(".rich h2").scrollIntoViewIfNeeded();
      const actual = await page.evaluate(() => { const font = selector => parseFloat(getComputedStyle(document.querySelector(selector)).fontSize); const r = document.querySelector("#composer").getBoundingClientRect(); return { width: innerWidth, body: font(".rich p"), tool: font(".tool-name"), state: font(".tool-state"), sync: font(".job-storage-state"), button: font("#chat-send"), overflow: document.documentElement.scrollWidth > innerWidth, reachable: r.top >= 0 && r.bottom <= innerHeight }; });
      const expected = width < 900 ? [16,16,14,15] : width < 1600 ? [18,16,15,16] : [20,17,16,17];
      check(width + "px真实长消息、双状态与输入区字号可达", [actual.body,actual.tool,actual.state,actual.button].every((value, index) => value === expected[index]) && actual.sync === expected[2] && !actual.overflow && actual.reachable);
      sizes.push(actual); await page.screenshot({ path: path.join(screenshotDir, `cloud-light-${width}.png`) });
    }
    await page.setViewportSize({ width: 390, height: 640 }); await page.click("#theme-dark"); await cleanup.locator(":scope > summary").scrollIntoViewIfNeeded();
    check("窄屏深色双状态与输入不溢出", await page.evaluate(() => document.documentElement.dataset.theme === "dark" && document.documentElement.scrollWidth <= innerWidth && document.querySelector("#composer").getBoundingClientRect().bottom <= innerHeight));
    await page.screenshot({ path: path.join(screenshotDir, "cloud-dark-390.png") });
    await page.locator("#composer").focus(); await page.keyboard.press("Tab"); check("键盘可达发送按钮", await page.evaluate(() => document.activeElement.id === "chat-send"));
    check("全程未绕过Cloud写审批", directWrites === 0); check("无浏览器脚本异常", errors.length === 0);
    console.log(JSON.stringify({ checks, sizes, screenshotDir, note: "仅真实本地HTTP+受控host，无校园写入/计费模型/Docker/手机实机。" }, null, 2));
  } finally {
    await browser?.close(); await app.close();
    assert.equal(path.dirname(dir), path.resolve(tmpdir()));
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
}
const watchdog = setTimeout(() => { console.error("auth/workspace e2e timeout"); process.exit(1); }, 120000);
main().then(() => clearTimeout(watchdog)).catch(error => { clearTimeout(watchdog); console.error(error); process.exitCode = 1; });
