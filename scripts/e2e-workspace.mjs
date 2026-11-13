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
const TOKEN = "workspace-e2e-device";
let checks = 0;
function check(name, value) { assert.ok(value, name); checks++; console.log("  ✔ " + name); }
async function chromiumPath() {
  for (const entry of await readdir(path.join(ROOT, ".runtime/browsers"))) {
    const file = path.join(ROOT, ".runtime/browsers", entry, "chrome-win64/chrome.exe");
    if (entry.startsWith("chromium-") && await stat(file).then(() => true, () => false)) return file;
  }
  throw new Error("Chromium unavailable");
}
const jobUrl = (sid, id) => `/api/workspaces/${sid}/jobs/${id}`;
function jobFor(sid, id, state = "running") {
  return { jobId: id, state, runtime: "python", scriptPath: "analysis.py", startedAt: new Date().toISOString(), timeoutSeconds: 120, stdout: "fixture: reading CSV", stderr: "", statusUrl: jobUrl(sid, id) };
}
function markdown(sid) {
  return `## 本地处理结果\n\n- 已读取工作区数据\n- **报告**可下载\n\n1. 核对结果\n2. 下载文件\n\n[下载报告](/api/workspaces/${sid}/files?path=report.pdf)\n[待生成报告](/api/workspaces/${sid}/files?path=missing.pdf)\n[外部参考](https://example.org/reference)\n[危险脚本](javascript:alert(1))\n[数据链接](data:text/html,danger)\n[本机路径](file:///C:/secret)\n<img src=x onerror=alert(1)>\n\n| 字段 | 结果 |\n| --- | --- |\n| 样本 | 3 |\n| 工具 | workspace_run |\n\n\`\`\`python\nprint("fixture only")\n\`\`\`\n` + "长消息阅读样本：只使用受控本地数据，核对真实状态、日志与下载。\n".repeat(12);
}
async function main() {
  const dir = await mkdtemp(path.join(tmpdir(), "campus-workspace-e2e-"));
  const screenshotDir = process.env.CAMPUS_E2E_SCREENSHOT_DIR || await mkdtemp(path.join(tmpdir(), "campus-workspace-shots-"));
  await mkdir(screenshotDir, { recursive: true });
  const sessions = new SessionStore(dir), files = new WorkspaceFiles({ baseDir: path.join(dir, "workspaces") });
  const session = await sessions.create({ title: "工作区受控样本" });
  await sessions.create({ title: "无作业样本" });
  const initial = jobFor(session.id, "11111111-1111-4111-8111-111111111111");
  const jobs = new Map([[initial.jobId, initial]]);
  let getCalls = 0, stopCalls = 0, hostCalls = 0, failGet = false, failStop = false, stream, streamClosed = false;
  const fakeSandbox = {
    async get(sid, id) {
      assert.equal(sid, session.id); getCalls++;
      if (failGet) throw Object.assign(new Error("受控状态服务暂不可用"), { code: "FIXTURE_UNAVAILABLE" });
      const job = jobs.get(id); if (!job) throw Object.assign(new Error("作业不存在"), { code: "JOB_NOT_FOUND" });
      return { ...job };
    },
    async stop(sid, id) {
      assert.equal(sid, session.id); stopCalls++;
      if (failStop) throw Object.assign(new Error("受控停止失败"), { code: "FIXTURE_STOP_FAILED" });
      const job = { ...jobs.get(id), state: "cancelled", stderr: "stopped by fixture" }; jobs.set(id, job); return job;
    },
    async close() {}, async stopSession() {},
  };
  await files.writeBytes(session.id, { path: "report.pdf", bytes: Buffer.from("%PDF-fixture-report") });
  await sessions.append(session.id, [
    { role: "user", content: "生成报告（受控历史样本）" },
    { role: "assistant", content: "", toolCalls: [{ id: "history-run", name: "workspace_run", arguments: '{"runtime":"python","scriptPath":"analysis.py"}' }] },
    { role: "tool", toolCallId: "history-run", content: JSON.stringify({ ok: true, data: initial }) },
    { role: "assistant", content: markdown(session.id), reasoning: "受控历史思考样本" },
  ]);
  const tool = { name: "workspace_run", service: "workspace", description: "运行受控样本", readOnly: false, destructive: true, mandatoryApproval: true,
    inputSchema: { type: "object", properties: { runtime: { type: "string", enum: ["python", "node"] }, scriptPath: { type: "string" } } } };
  const host = {
    workspaceFiles: files, sandbox: fakeSandbox,
    describe: () => [tool, { name: "fixture_campus_write", readOnly: false, destructive: true, inputSchema: { type: "object", properties: {} } }],
    toolForModel: () => [{ type: "function", function: { name: tool.name, parameters: tool.inputSchema } }],
    prepareCall: async name => name === "workspace_run" ? ({ mandatoryApproval: true, approvalArgs: { runtime: "python", scriptPath: "analysis.py", script: "print('fixture')" }, risk: "受控风险：将执行已冻结的隔离脚本，可修改当前工作区。" }) : undefined,
    call: async (_name, _args, context) => {
      if (["learn_status", "cloud_status", "rain_status", "madmodel_status"].includes(_name)) return { ok: true, data: { configured: true } };
      assert.equal(_name, "workspace_run");
      hostCalls++; assert.equal(context.approved, true);
      const job = jobFor(context.sessionId, "22222222-2222-4222-8222-222222222222"); jobs.set(job.jobId, job);
      return { ok: true, data: job };
    },
    close: async () => {},
  };
  const route = {
    route: "madmodel", models: async () => [{ id: "fixture", label: "本地受控样本" }],
    status: async () => ({ configured: true, available: true, masked: "受控样本" }),
    chat: async request => {
      const last = request.messages.at(-1);
      if (last.role === "tool") return Response.json({ choices: [{ message: { content: "已提交受控作业；尚未完成。" } }] });
      if (last.content.includes("校园风险样本")) return Response.json({ choices: [{ message: { content: "", tool_calls: [{ id: "campus-fixture", type: "function", function: { name: "fixture_campus_write", arguments: "{}" } }] } }] });
      if (last.content.includes("确认样本")) return Response.json({ choices: [{ message: { content: "", tool_calls: [{ id: "approve-fixture", type: "function", function: { name: "workspace_run", arguments: '{"runtime":"python","scriptPath":"analysis.py"}' } }] } }] });
      streamClosed = false;
      return new Response(new ReadableStream({
        start(controller) {
          stream = controller;
          const deltas = [{ reasoning_content: "受控增量思考" }, { content: "### 仍在对话\n首段先于done" }];
          controller.enqueue(new TextEncoder().encode(deltas.map(delta => "data: " + JSON.stringify({ choices: [{ delta }] }) + "\n\n").join("")));
        },
        cancel() { streamClosed = true; },
      }), { headers: { "content-type": "text/event-stream" } });
    },
  };
  const app = createAppServer({ config: { host: "127.0.0.1", hostname: "localhost", port: 0, stateDir: dir, token: TOKEN, modelRoute: "madmodel", modelName: "fixture", requireApproval: true },
    host, route, sessions, version: "workspace-test", webuiDir: path.join(ROOT, "webui"), devices: new DeviceStore(dir, { encrypt: async value => value }), pairing: new PairingCodes() });
  let browser;
  try {
    const base = await app.listen();
    const headers = { authorization: "Bearer " + TOKEN };
    const status = await fetch(base + initial.statusUrl, { headers });
    assert.equal(status.status, 200, "workspace API not ready");
    check("真实状态API回执包含job和statusUrl", (await status.json()).job.statusUrl === initial.statusUrl);
    check("产物API拒绝无设备授权请求", (await fetch(base + `/api/workspaces/${session.id}/files?path=report.pdf`)).status === 401);
    browser = await chromium.launch({ executablePath: await chromiumPath(), headless: true });
    const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, acceptDownloads: true });
    const errors = [], fileRequests = [];
    let abortRequests = 0, directToolRequests = 0;
    page.on("pageerror", error => errors.push(error.message));
    page.on("request", request => {
      if (request.url().includes("/files?")) fileRequests.push({ url: request.url(), auth: request.headers().authorization });
      if (request.url().endsWith("/abort")) abortRequests++;
      if (/\/api\/tools\/workspace_/.test(request.url())) directToolRequests++;
    });
    await page.goto(base + "/#token=" + TOKEN);
    try { await page.waitForSelector("#composer", { timeout: 8000 }); }
    catch (error) { console.error("启动诊断", (await page.locator("body").innerText()).slice(0, 2000), errors); throw error; }
    const openSession = async title => {
      await page.click('button[data-view="sessions"]');
      await page.locator(".session-row .item").filter({ hasText: title }).click();
      await page.waitForSelector("#composer");
    };
    await openSession("工作区受控样本");
    await page.waitForSelector(".rich h2");
    check("标题列表真实渲染而非字面Markdown", await page.locator(".rich h2").innerText() === "本地处理结果" && await page.locator(".rich ul li").count() === 2 && await page.locator(".rich ol li").count() === 2);
    check("表格代码保留且原始HTML及危险协议不可执行", await page.locator(".rich table").count() === 1 && await page.locator(".rich pre").count() === 1 && await page.locator(".rich img, .rich script, .rich a[href^='javascript:'], .rich a[href^='data:'], .rich a[href^='file:']").count() === 0);
    check("外链隔离opener", (await page.getByRole("link", { name: "外部参考" }).getAttribute("rel")).includes("noopener"));
    const download = async name => { const event = page.waitForEvent("download"); await page.getByRole("link", { name, exact: true }).click(); return event; };
    const report = await download("下载报告");
    check("授权Blob下载真实文件内容与名称", report.suggestedFilename() === "report.pdf" && (await readFile(await report.path(), "utf8")) === "%PDF-fixture-report");
    check("设备令牌只在下载请求头，不在URL", fileRequests[0].auth === "Bearer " + TOKEN && !fileRequests.some(item => item.url.includes(TOKEN)));
    await page.getByRole("link", { name: "待生成报告" }).click();
    await page.waitForSelector(".download-error");
    check("下载失败就地显示且可以重试", (await page.locator(".download-error").innerText()).includes("下载失败"));
    await files.writeBytes(session.id, { path: "missing.pdf", bytes: Buffer.from("%PDF-recovered") });
    await download("待生成报告");
    check("下载恢复后移除原错误", await page.locator(".download-error").count() === 0);
    const card = page.locator(".tool-card").first();
    await card.locator(":scope > summary").click();
    await card.locator(".job-logs > summary").click();
    check("作业提交不冒充计算完成且可展开日志", await card.locator(".tool-state").innerText() === "作业运行中" && (await card.locator(".job-logs").innerText()).includes("fixture: reading CSV"));
    jobs.set(initial.jobId, { ...initial, stdout: "fixture: updated real output", stderr: "fixture warning" });
    await page.waitForFunction(() => document.querySelector(".job-logs")?.textContent.includes("updated real output"));
    check("作业轮询保留真实stdout与stderr", (await card.locator(".job-logs").textContent()).includes("fixture warning"));
    await page.click('button[data-view="settings"]');
    const paused = getCalls; await page.waitForTimeout(1800);
    check("离开chat停止轮询", getCalls === paused);
    await page.click('button[data-view="chat"]');
    check("切页保留日志与展开状态", await card.getAttribute("open") !== null && await card.locator(".job-logs").getAttribute("open") !== null);
    await openSession("无作业样本");
    const otherPaused = getCalls; await page.waitForTimeout(1800);
    check("其他chat不轮询前一会话作业", getCalls === otherPaused);
    await openSession("工作区受控样本");
    if (await card.getAttribute("open") === null) await card.locator(":scope > summary").click();
    failGet = true;
    await page.waitForSelector(".workspace-job .error");
    const errorCalls = getCalls; await page.waitForTimeout(1800);
    check("状态API失败保留running并暂停重试风暴", await card.locator(".tool-state").innerText() === "作业运行中" && getCalls === errorCalls);
    failGet = false;
    await page.getByRole("button", { name: "重试查询", exact: true }).click();
    await page.waitForFunction(() => !document.querySelector(".workspace-job .error"));
    check("重试查询从真实API恢复", true);
    await page.fill("#composer", "继续流式样本"); await page.click("#chat-send");
    await page.waitForSelector(".rich h3");
    check("首段标题与思考先于done出现", await page.locator("#chat-stop").isVisible() && !streamClosed && (await page.locator(".reasoning-content").last().textContent()).includes("受控增量思考"));
    failStop = true;
    await page.getByRole("button", { name: "停止作业", exact: true }).click();
    await page.waitForFunction(() => document.querySelector(".workspace-job .error")?.textContent.includes("停止失败"));
    check("停止API失败不伪装cancelled", await card.locator(".tool-state").innerText() === "作业运行中");
    failStop = false;
    await page.getByRole("button", { name: "停止作业", exact: true }).click();
    await page.waitForFunction(() => document.querySelector(".tool-state")?.textContent === "作业已停止");
    check("停止精确作业独立于停止对话", stopCalls === 2 && abortRequests === 0 && await page.locator("#chat-stop").isVisible());
    stream.enqueue(new TextEncoder().encode("data: [DONE]\n\n")); stream.close(); streamClosed = true;
    await page.waitForFunction(() => document.querySelector("#chat-stop").hidden);
    check("停止后保留作业日志", (await card.locator(".job-logs").textContent()).includes("stopped by fixture"));
    const settled = getCalls; await page.waitForTimeout(1800);
    check("终态无后台空轮询", getCalls === settled);
    await page.reload(); await page.waitForSelector("#composer"); await openSession("工作区受控样本");
    await page.waitForFunction(() => document.querySelector(".tool-state")?.textContent === "作业已停止");
    check("历史恢复pending后向真实API校正终态", true);
    await card.locator(":scope > summary").click();
    for (const [index, state] of ["succeeded", "failed", "timed_out", "interrupted"].entries()) {
      const job = jobFor(session.id, "33333333-3333-4333-8333-" + String(index).padStart(12, "0"), state);
      job.stderr = "真实终态样本：" + state;
      await sessions.append(session.id, [{ role: "assistant", content: "", toolCalls: [{ id: job.jobId, name: "workspace_run", arguments: "{}" }] }, { role: "tool", toolCallId: job.jobId, content: JSON.stringify({ ok: true, data: job }) }]);
    }
    await openSession("工作区受控样本");
    const states = await page.locator(".tool-state").allTextContents();
    check("终态完成失败超时中断均如实呈现", ["作业完成", "作业失败", "作业超时", "作业已中断"].every(label => states.includes(label)));
    const failed = page.locator(".tool-card").filter({ hasText: "作业失败" });
    await failed.locator(":scope > summary").click();
    await failed.getByRole("button", { name: "在对话中处理" }).click();
    check("失败恢复填对话草稿，不自动重跑", (await page.locator("#composer").inputValue()).includes("恢复方案") && hostCalls === 0);
    await page.click('button[data-view="tools"]');
    await page.locator("#view details").filter({ hasText: "workspace_run" }).locator(":scope > summary").click();
    await page.getByRole("button", { name: "在对话中使用", exact: true }).click();
    check("workspace目录仅进入对话，不直接绕过审批", directToolRequests === 0 && hostCalls === 0 && (await page.locator("#composer").inputValue()).includes("workspace_run"));
    await page.fill("#composer", "确认样本"); await page.click("#chat-send");
    await page.waitForSelector(".confirm-card");
    check("确认卡优先呈现具体risk与冻结脚本", (await page.locator(".confirm-card").innerText()).includes("受控风险") && (await page.locator(".confirm-card pre").innerText()).includes("print('fixture')") && hostCalls === 0);
    await page.getByRole("button", { name: "允许执行", exact: true }).click();
    await page.waitForFunction(() => document.querySelector("#chat-stop").hidden);
    check("允许后才提交作业，提交后仍为running", hostCalls === 1 && (await page.locator(".tool-state").last().innerText()) === "作业运行中");
    jobs.set("22222222-2222-4222-8222-222222222222", { ...jobs.get("22222222-2222-4222-8222-222222222222"), state: "succeeded", stdout: "approved completed" });
    await page.waitForFunction(() => [...document.querySelectorAll(".tool-state")].at(-1)?.textContent === "作业完成");
    check("仅真实job终态才显示计算完成", true);
    await page.fill("#composer", "校园风险样本"); await page.click("#chat-send");
    await page.waitForFunction(() => [...document.querySelectorAll(".confirm-card")].at(-1)?.textContent.includes("此操作会改动校园数据。"));
    check("缺省risk保留校园风险原提示", (await page.locator(".confirm-card").last().innerText()).includes("此操作会改动校园数据。"));
    await page.locator(".confirm-card").last().getByRole("button", { name: "拒绝", exact: true }).click();
    await page.waitForFunction(() => document.querySelector("#chat-stop").hidden);
    check("拒绝后不执行受控写入", hostCalls === 1);
    const sizes = [];
    for (const width of [390, 1280, 1536, 1920, 2560]) {
      await page.setViewportSize({ width, height: width === 390 ? 740 : 1000 });
      const fonts = await page.evaluate(() => {
        const size = selector => parseFloat(getComputedStyle(document.querySelector(selector)).fontSize);
        return { body: size(".bubble.assistant"), tool: size(".tool-name"), state: size(".tool-state"), button: size("#chat-send"), overflow: document.documentElement.scrollWidth > innerWidth, reachable: document.querySelector(".composer").getBoundingClientRect().bottom <= innerHeight };
      });
      const expected = width < 900 ? [16, 16, 14, 15] : width < 1600 ? [18, 16, 15, 16] : [20, 17, 16, 17];
      check(`${width}px真实长消息字阶与输入可达`, !fonts.overflow && fonts.reachable && [fonts.body, fonts.tool, fonts.state, fonts.button].every((value, index) => value === expected[index]));
      sizes.push({ width, ...fonts });
      await page.locator(".rich h2").scrollIntoViewIfNeeded();
      await page.screenshot({ path: path.join(screenshotDir, `workspace-light-${width}.png`) });
    }
    await page.click("#theme-dark");
    await page.setViewportSize({ width: 390, height: 640 });
    await page.locator(".rich h2").scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(screenshotDir, "workspace-dark-390.png") });
    await page.locator(".tool-card").first().locator(":scope > summary").scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(screenshotDir, "workspace-job-dark-390.png") });
    check("窄屏深色仍可达且无横向溢出", await page.evaluate(() => document.documentElement.dataset.theme === "dark" && document.documentElement.scrollWidth <= innerWidth && document.querySelector(".composer").getBoundingClientRect().bottom <= innerHeight));
    await page.locator("#composer").focus(); await page.keyboard.press("Tab");
    check("键盘可达发送按钮", await page.locator("#chat-send").evaluate(node => node === document.activeElement));
    check("无浏览器脚本异常", errors.length === 0);
    console.log(JSON.stringify({ checks, sizes, screenshotDir, note: "仅受控fixture，无真实校园、计费模型或Docker运行；窄屏为浏览器而非手机实机。" }, null, 2));
  } finally {
    await browser?.close(); await app.close();
    assert.equal(path.dirname(dir), path.resolve(tmpdir()));
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
}
const watchdog = setTimeout(() => { console.error("workspace e2e timeout"); process.exit(1); }, 120000);
main().then(() => clearTimeout(watchdog)).catch(error => { clearTimeout(watchdog); console.error(error); process.exitCode = 1; });
