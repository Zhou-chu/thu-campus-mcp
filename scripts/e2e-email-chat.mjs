#!/usr/bin/env node
/**
 * 邮箱用户旅程：真实应用路由 + 数据库 + Chromium，从邮箱注册走到首轮流式回复，再刷新回读。
 * 只替换模型（受控替身），不注入设备令牌，也不消耗真实模型额度。
 * 验证缺 CSRF 的写请求被拒且不会额外调用模型。
 */
import assert from "node:assert/strict";
import path from "node:path";
import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { chromium } from "playwright-core";
import { newDb } from "pg-mem";
import { createAppServer } from "../lib/app/server.mjs";
import { SessionStore } from "../lib/app/sessions.mjs";
import { DeviceStore } from "../lib/app/devices.mjs";
import { PairingCodes } from "../lib/app/pairing.mjs";
import { openStore } from "../lib/store/index.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const REPLY = "这是邮箱模式下的流式正文样本。";
let checks = 0;
const check = (name, condition) => { assert.ok(condition, name); checks += 1; console.log("  ✔ " + name); };

async function chromiumPath() {
  for (const name of await readdir(path.join(ROOT, ".runtime/browsers"))) {
    const file = path.join(ROOT, ".runtime/browsers", name, "chrome-win64/chrome.exe");
    if (name.startsWith("chromium-") && await stat(file).then(() => true, () => false)) return file;
  }
  throw new Error("Chromium unavailable");
}

function sseResponse() {
  const body = new ReadableStream({
    start(controller) {
      const send = delta => controller.enqueue(new TextEncoder().encode("data: " + JSON.stringify({ choices: [{ delta }] }) + "\r\n\r\n"));
      send({ content: REPLY.slice(0, 8) });
      send({ content: REPLY.slice(8) });
      controller.enqueue(new TextEncoder().encode("data: [DONE]\r\n\r\n"));
      controller.close();
    },
  });
  return new Response(body, { headers: { "content-type": "text/event-stream" } });
}

async function main() {
  const dir = await mkdtemp(path.join(tmpdir(), "campus-email-chat-"));
  const db = newDb({ autoCreateForeignKeyIndices: true });
  const session = await openStore({ pool: new (db.adapters.createPg().Pool)() });
  const host = {
    describe: () => [],
    toolForModel: () => [],
    async call() { return { ok: true, data: {} }; },
    async close() {},
  };
  const model = { calls: 0, streamed: 0 };
  const route = {
    route: "madmodel",
    models: async () => [{ id: "fixture", label: "受控模型替身" }],
    status: async () => ({ configured: true, available: true, masked: "替身" }),
    async chat(request) {
      model.calls += 1;
      if (request.stream) model.streamed += 1;
      return sseResponse();
    },
  };
  const app = createAppServer({
    config: { root: ROOT, host: "127.0.0.1", port: 0, stateDir: dir, token: "", modelRoute: "madmodel", modelName: "fixture", hostname: "email-chat-gate", version: "gate" },
    host, route,
    devices: new DeviceStore(dir, { encrypt: async buffer => buffer }),
    pairing: new PairingCodes(),
    sessions: new SessionStore(dir),
    version: "gate",
    webuiDir: path.join(ROOT, "webui"),
    auth: session.auth,
    store: session,
  });
  let browser;
  try {
    const base = await app.listen();
    browser = await chromium.launch({ executablePath: await chromiumPath(), headless: true });
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    const pageErrors = [];
    page.on("pageerror", error => pageErrors.push(error.message));
    await page.goto(base + "/");
    await page.click("#auth-switch");
    await page.fill("#auth-email", "chat-" + Date.now() + "@mails.tsinghua.edu.cn");
    await page.fill("#auth-password", "long-enough-pass");
    await page.click("#auth-submit");
    await page.waitForSelector("#app:not([hidden])", { timeout: 15000 });
    check("邮箱注册后进入应用", true);

    const question = "你好，用一句话介绍你自己";
    await page.waitForFunction(() => document.querySelector("#chat-send") && !document.querySelector("#chat-send").disabled, null, { timeout: 10000 });
    await page.fill("#composer", question);
    await page.click("#chat-send");
    await page.waitForFunction(text => (document.querySelector("#messages")?.textContent || "").includes(text), REPLY, { timeout: 20000 });
    check("首轮对话收到流式正文", (await page.locator("#messages").innerText()).includes(REPLY));
    check("模型替身恰好被调用一次", model.calls === 1 && model.streamed === 1);

    const denied = await page.evaluate(async () => {
      const response = await fetch("/api/chat", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "缺 CSRF 的写请求" }) });
      return { status: response.status, body: await response.json().catch(() => null) };
    });
    check("缺 CSRF 的聊天请求被拒", denied.status === 403 && denied.body?.error?.code === "CSRF_REQUIRED");
    check("被拒请求没有再调用模型", model.calls === 1);

    await page.reload();
    await page.waitForSelector("#app:not([hidden])", { timeout: 15000 });
    check("刷新后仍是登录状态", (await page.locator("#app").isVisible()));
    await page.click('.tab[data-view="sessions"]');
    await page.waitForSelector(".session-row .item-title", { timeout: 10000 });
    const titles = await page.locator(".session-row .item-title").allInnerTexts();
    check("刷新后会话列表包含本轮", titles.some(title => title.includes(question.slice(0, 6))));
    await page.locator(".session-row .item").first().click();
    await page.waitForFunction(text => (document.querySelector("#messages")?.textContent || "").includes(text), REPLY, { timeout: 15000 });
    const reopened = await page.locator("#messages").innerText();
    check("重新打开后用户消息与回复都还在", reopened.includes(question) && reopened.includes(REPLY));
    check("页面无未捕获异常", pageErrors.length === 0);
    console.log(`email chat gate: ${checks} checks passed`);
  } finally {
    await browser?.close().catch(() => {});
    await app.close();
    await session.close();
    await rm(dir, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });