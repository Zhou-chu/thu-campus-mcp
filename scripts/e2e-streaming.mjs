#!/usr/bin/env node
import assert from "node:assert/strict";
import path from "node:path";
import { mkdtemp, readdir, stat, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { chromium } from "playwright-core";
import { createAppServer } from "../lib/app/server.mjs";
import { SessionStore } from "../lib/app/sessions.mjs";
import { DeviceStore } from "../lib/app/devices.mjs";
import { PairingCodes } from "../lib/app/pairing.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const TOKEN = "stream-test";
const contexts = new Map();
let calls = 0, checks = 0;
function check(name, value) { assert.ok(value, name); checks++; console.log("  ✔ " + name); }
function streamFor(name, request) {
  let control;
  const context = { closed: false, cancelled: false };
  const body = new ReadableStream({
    start(c) { control = c; },
    cancel() { context.cancelled = true; context.closed = true; },
  });
  context.send = delta => control.enqueue(new TextEncoder().encode("data: " + JSON.stringify({ choices: [{ delta }] }) + "\r\n\r\n"));
  context.finish = () => { control.enqueue(new TextEncoder().encode("data: [DONE]\r\n\r\n")); control.close(); context.closed = true; };
  context.close = () => { control.close(); context.closed = true; };
  context.fail = () => { control.error(new Error("fixture stream disconnected")); context.closed = true; };
  const list = contexts.get(name) || [];
  list.push(context); contexts.set(name, list);
  const second = request.messages.at(-1)?.role === "tool";
  if (name === "无思考流式验收") context.send({ content: "只提供正文的测试样本" });
  else context.send({ reasoning_content: second ? "第二步思考样本" : "这是测试样本：先核对信息。" });
  return new Response(body, { headers: { "content-type": "text/event-stream" } });
}
const host = {
  describe: () => [{ name: "learn_status", description: "测试工具", readOnly: true, service: "learnx", inputSchema: { type: "object", properties: {} } }],
  toolForModel: () => [{ type: "function", function: { name: "learn_status", parameters: { type: "object", properties: {} } } }],
  call: async () => { calls++; return { ok: true, data: { fixture: true } }; },
  close: async () => {},
};
const route = {
  route: "madmodel", models: async () => [{ id: "fixture", label: "流式验收样本" }],
  status: async () => ({ configured: true, available: true, masked: "测试样本" }),
  chat: async request => {
    assert.equal(request.stream, true);
    const name = request.messages.filter(m => m.role === "user").at(-1).content;
    if (name === "完整响应验收") return Response.json({ choices: [{ message: { content: "一次性正文样本", reasoning: "一次性思考样本" } }] });
    return streamFor(name, request);
  },
};
async function chromiumPath() {
  for (const entry of await readdir(path.join(ROOT, ".runtime/browsers"))) {
    const file = path.join(ROOT, ".runtime/browsers", entry, "chrome-win64/chrome.exe");
    if (entry.startsWith("chromium-") && await stat(file).then(() => true, () => false)) return file;
  }
  throw new Error("Chromium unavailable");
}
async function main() {
  const dir = await mkdtemp(path.join(tmpdir(), "campus-stream-e2e-"));
  const app = createAppServer({
    config: { host: "127.0.0.1", hostname: "localhost", port: 0, stateDir: dir, token: TOKEN, modelRoute: "madmodel", modelName: "fixture", requireApproval: true },
    host, route, sessions: new SessionStore(dir), version: "stream-test", webuiDir: path.join(ROOT, "webui"),
    devices: new DeviceStore(dir, { encrypt: async value => value }), pairing: new PairingCodes(),
  });
  const base = await app.listen();
  const browser = await chromium.launch({ executablePath: await chromiumPath(), headless: true });
  try {
    for (const endpoint of ["/api/meta", "/api/models"]) {
      const response = await fetch(base + endpoint, { headers: { authorization: "Bearer " + TOKEN } });
      if (!response.ok) throw new Error(endpoint + ": " + response.status + " " + await response.text());
    }
    const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    const start = async name => {
      await page.goto(base + "/?case=" + encodeURIComponent(name) + "#token=" + TOKEN);
      try {
        await page.waitForFunction(() => document.querySelector("#chat-send") && !document.querySelector("#chat-send").disabled, null, { timeout: 8000 });
      } catch (error) {
        console.error("启动诊断", (await page.locator("body").innerText()).slice(0, 2000), errors);
        throw error;
      }
      await page.fill("#composer", name);
      await page.click("#chat-send");
    };
    const idle = () => page.waitForFunction(() => document.querySelector("#chat-stop").hidden && !document.querySelector("#chat-send").disabled);
    const name = "分块流式验收";
    await start(name);
    await page.waitForSelector(".reasoning-block");
    const context = contexts.get(name)[0];
    check("思考首段在上游结束前可见", !context.closed && await page.locator("#chat-stop").isVisible());
    check("思考默认可主动展开", (await page.locator(".reasoning-block").getAttribute("open")) === null);
    await page.locator(".reasoning-block > summary").click();
    check("思考正文可读且此时没有答案", (await page.locator(".reasoning-content").innerText()).includes("先核对信息") && await page.locator(".bubble.assistant").count() === 0);
    context.send({ reasoning: "追加思考样本。<img src=x onerror=alert(1)>" });
    await page.waitForFunction(() => document.querySelector(".reasoning-content").textContent.includes("追加思考"));
    check("思考增量更新且按纯文本展示", await page.locator(".reasoning-content img").count() === 0);
    context.send({ content: "第一段正文。" });
    await page.waitForFunction(() => document.querySelector(".bubble.assistant")?.textContent.includes("第一段正文"));
    check("正文首段先于整轮完成", !context.closed && await page.locator("#chat-stop").isVisible());
    context.send({ content: "\n长回复测试样本：验证消息区自动跟随最新到达的内容。".repeat(45) });
    await page.waitForFunction(() => {
      const box = document.querySelector("#messages");
      return box.scrollHeight > box.clientHeight + 100 && box.scrollHeight - box.clientHeight - box.scrollTop < 4;
    });
    check("长增量跟随实际消息区", true);
    await page.evaluate(() => { const box = document.querySelector("#messages"); box.scrollTop = 0; box.dispatchEvent(new Event("scroll")); });
    context.send({ content: "\n用户上翻时继续到达的样本。" });
    await page.waitForFunction(() => document.querySelector(".bubble.assistant").textContent.includes("用户上翻"));
    check("用户上翻不被强拉到底部", await page.locator("#messages").evaluate(box => box.scrollTop < 4));
    await page.click('button[data-view="settings"]');
    context.send({ content: "\n切页期间仍在更新。" });
    await page.click('button[data-view="chat"]');
    await page.waitForFunction(() => document.querySelector(".bubble.assistant").textContent.includes("切页期间"));
    check("切页后恢复增量和展开状态", await page.locator(".reasoning-block").getAttribute("open") !== null);
    if (process.env.CAMPUS_E2E_SCREENSHOT_DIR) await page.screenshot({ path: path.join(process.env.CAMPUS_E2E_SCREENSHOT_DIR, "streaming-sample-1920.png") });
    context.finish();
    await idle();
    check("完成后当前视图停止按钮收起", await page.locator("#chat-stop").isHidden());
    check("最终事件不重复追加正文或思考", await page.locator(".reasoning-block").count() === 1 && await page.locator(".bubble.assistant").count() === 1);
    check("思考状态完成", await page.locator(".reasoning-block > summary").innerText() === "思考过程");
    await page.reload();
    await page.click('button[data-view="sessions"]');
    await page.locator(".session-row .item").filter({ hasText: name }).click();
    await page.waitForSelector(".reasoning-block");
    await page.locator(".reasoning-block > summary").click();
    check("历史恢复完整思考而非丢弃字段", (await page.locator(".reasoning-content").innerText()).includes("追加思考"));
    await page.setViewportSize({ width: 390, height: 640 });
    check("窄屏思考可读且不挤走输入", await page.evaluate(() => parseFloat(getComputedStyle(document.querySelector(".reasoning-content")).fontSize) >= 16 && document.querySelector(".composer").getBoundingClientRect().bottom <= innerHeight && document.documentElement.scrollWidth <= innerWidth));
    if (process.env.CAMPUS_E2E_SCREENSHOT_DIR) await page.screenshot({ path: path.join(process.env.CAMPUS_E2E_SCREENSHOT_DIR, "streaming-sample-390.png") });

    await start("停止思考验收");
    await page.waitForSelector(".reasoning-block");
    await page.click("#chat-stop");
    await idle();
    check("只输出思考时也能停止", contexts.get("停止思考验收")[0].cancelled);
    check("停止保留思考且状态正确", (await page.locator(".reasoning-block > summary").innerText()) === "思考已停止");
    await page.click('button[data-view="sessions"]');
    await page.locator(".session-row .item").filter({ hasText: "停止思考验收" }).click();
    await page.waitForSelector(".reasoning-block");
    check("停止片段可从历史恢复", (await page.locator(".reasoning-block > summary").innerText()) === "思考已停止");

    for (const mode of ["fail", "close"]) {
      const title = "中断验收-" + mode;
      await start(title); await page.waitForSelector(".reasoning-block");
      const stream = contexts.get(title)[0];
      stream.send({ content: "中断前的正文片段" }); stream[mode]();
      await idle();
      check(mode + "中断保留末帧", (await page.locator(".bubble.assistant").innerText()).includes("中断前"));
      check(mode + "明确错误而非伪装完成", (await page.locator(".bubble.err").innerText()).includes("MODEL_PROTOCOL") && await page.locator(".reasoning-block > summary").innerText() === "思考已中断");
    }
    await start("无思考流式验收");
    await page.waitForSelector(".bubble.assistant");
    check("上游未提供思考不创建空块", await page.locator(".reasoning-block").count() === 0);
    contexts.get("无思考流式验收")[0].finish(); await idle();
    await start("完整响应验收"); await idle();
    check("完整响应如实展示，不模拟打字", (await page.locator(".bubble.assistant").innerText()) === "一次性正文样本" && await page.locator(".reasoning-block").count() === 1);

    await page.route("**/api/chat", intercepted => intercepted.fulfill({
      status: 200, contentType: "text/event-stream", body: 'event: reasoning\r\ndata: {"text":"HTTP中断思考样本"}\r\n\r\nevent: token\r\ndata: {"text":"HTTP中断末帧"}',
    }));
    await start("HTTP中断验收"); await idle();
    check("CRLF与EOF末帧保留", (await page.locator(".bubble.assistant").innerText()) === "HTTP中断末帧");
    check("HTTP缺少done有明确反馈", (await page.locator(".bubble.err").innerText()).includes("STREAM_INTERRUPTED"));
    await page.click('button[data-view="settings"]'); await page.click('button[data-view="chat"]');
    check("切页不丢中断内容及错误", await page.locator(".bubble.err").count() === 1 && await page.locator(".reasoning-block").count() === 1);
    await page.unroute("**/api/chat");

    await start("多步思考验收"); await page.waitForSelector(".reasoning-block");
    const before = calls;
    contexts.get("多步思考验收")[0].send({ tool_calls: [{ index: 0, id: "read", function: { name: "learn_status", arguments: "{}" } }] });
    contexts.get("多步思考验收")[0].finish();
    await page.waitForFunction(() => document.querySelectorAll(".reasoning-block").length === 2);
    check("工具前后思考独立成段", calls === before + 1);
    contexts.get("多步思考验收")[1].send({ content: "第二步正文样本" });
    contexts.get("多步思考验收")[1].finish(); await idle();
    check("两步均完成而不串段", await page.locator(".reasoning-block").count() === 2 && (await page.locator(".reasoning-content").last().textContent()) === "第二步思考样本");
    check("无页面脚本错误", errors.length === 0);
    console.log(`\n流式与思考真实浏览器回归通过${checks}项；仅使用受控样本，没有调用计费模型或真实校园工具。`);
  } finally {
    await browser.close(); await app.close();
    assert.equal(path.dirname(dir), path.resolve(tmpdir()));
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
}
const watchdog = setTimeout(() => { console.error("stream e2e timeout"); process.exit(1); }, 120000);
main().then(() => clearTimeout(watchdog)).catch(error => { clearTimeout(watchdog); console.error(error); process.exitCode = 1; });
