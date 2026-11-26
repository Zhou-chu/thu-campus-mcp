#!/usr/bin/env node
/**
 * 邮箱模式的服务页门禁：真实应用路由 + 数据库，浏览器完成邮箱注册、进入服务页、核验状态，
 * 并检查 #112 回归（/api/auth/status 404）会让本脚本失败。
 *
 * 不连接校园服务；只验证应用自身的认证/服务路由与页面组合。
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
let checks = 0;
const check = (name, condition) => { assert.ok(condition, name); checks += 1; console.log("  ✔ " + name); };

async function chromiumPath() {
  for (const name of await readdir(path.join(ROOT, ".runtime/browsers"))) {
    const file = path.join(ROOT, ".runtime/browsers", name, "chrome-win64/chrome.exe");
    if (name.startsWith("chromium-") && await stat(file).then(() => true, () => false)) return file;
  }
  throw new Error("Chromium unavailable");
}

async function main() {
  const dir = await mkdtemp(path.join(tmpdir(), "campus-auth-services-"));
  const db = newDb({ autoCreateForeignKeyIndices: true });
  const session = await openStore({ pool: new (db.adapters.createPg().Pool)() });
  const host = {
    describe: () => [],
    toolForModel: () => [],
    async call() { return { ok: true, data: {} }; },
    async close() {},
  };
  const route = { route: "madmodel", models: async () => [], status: async () => ({ available: false }), chat: async () => { throw new Error("不需要对话"); } };
  const app = createAppServer({
    config: { root: ROOT, host: "127.0.0.1", port: 0, stateDir: dir, token: "", modelRoute: "madmodel", modelName: "", hostname: "services-gate", version: "gate" },
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
    await page.fill("#auth-email", "gate-" + Date.now() + "@mails.tsinghua.edu.cn");
    await page.fill("#auth-password", "long-enough-pass");
    await page.click("#auth-submit");
    await page.waitForSelector("#app:not([hidden])", { timeout: 15000 });
    check("邮箱注册后进入应用", true);

    await page.click('.tab[data-view="services"]');
    await page.waitForSelector('.auth-service[data-service="learnx"]', { timeout: 10000 });
    check("服务页渲染服务行", (await page.locator(".auth-service").count()) === 7);

    await page.getByRole("button", { name: "核验登录状态", exact: true }).click();
    await page.waitForFunction(() => !document.body.innerText.includes("核验中…"), { timeout: 15000 });
    const panel = await page.locator(".auth-panel").innerText();
    check("核验状态不再返回接口不存在", !/接口不存在|NOT_FOUND/.test(panel));
    check("服务状态拿到响应", panel.length > 0);

    const serviceLogin = await page.evaluate(async () => {
      const response = await fetch("/api/services/login", { method: "POST", headers: { "content-type": "application/json", "x-thu-csrf": "1" }, body: JSON.stringify({ service: "nope" }) });
      return { status: response.status, body: await response.json().catch(() => null) };
    });
    check("服务登录走独立路径并校验参数", serviceLogin.status === 400 && serviceLogin.body?.error?.code === "INVALID_ARGUMENTS");

    await page.setViewportSize({ width: 420, height: 900 });
    check("窄屏服务页无横向溢出", await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    const tabs = await page.evaluate(() => {
      const all = [...document.querySelectorAll(".tab")];
      const inside = all.filter(tab => {
        const box = tab.getBoundingClientRect();
        return box.left >= -1 && box.right <= innerWidth + 1;
      });
      return { total: all.length, inside: inside.length, labels: inside.map(tab => tab.textContent.trim()) };
    });
    check("窄屏九个入口都在屏幕内", tabs.total === 9 && tabs.inside === 9 && ["服务", "工具", "设置"].every(name => tabs.labels.includes(name)));
    await page.click('.tab[data-view="chat"]');
    await page.waitForSelector("#chat-model", { timeout: 5000 });
    const effortLabel = await page.evaluate(() => {
      const label = document.querySelector("#chat-effort")?.closest(".effort-field")?.querySelector("span");
      const select = document.querySelector("#chat-model");
      return { text: label?.textContent || "", visible: (label?.getBoundingClientRect().width || 0) > 2, modelWidth: Math.round(select?.getBoundingClientRect().width || 0) };
    });
    check("思考强度有可见标签且模型名不再挤成一个字", effortLabel.text === "思考" && effortLabel.visible && effortLabel.modelWidth >= 96);
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.click('.tab[data-view="services"]');
    await page.waitForTimeout(400);
    const gitlabButton = page.locator('.auth-service[data-service="gitlab"]').getByRole("button", { name: "配置访问令牌" });
    check("GitLab 行给出可点的配置入口", (await gitlabButton.count()) === 1);
    await gitlabButton.click();
    check("点配置入口能到设置里的 GitLab 分区", await page.evaluate(() => {
      const section = document.querySelector(".settings-gitlab");
      return document.querySelector("#view")?.dataset.view === "settings" && !!section && section.getBoundingClientRect().top < innerHeight;
    }));
    const hint = await page.locator("#auth-hint").textContent();
    check("登录页说明这是本机账号而不是清华密码", /不是清华统一账号/.test(hint || ""));
    // #152：邮箱模式下右侧作业面板要真的去取数据，不能停在“尚未读取作业列表”这个死胡同。
    await page.waitForTimeout(1500);
    const sidebarText = (await page.locator(".rsidebar-body").innerText()).replace(/\s+/g, " ").trim();
    check("邮箱模式下右侧作业面板会加载而不是停在未读取", sidebarText.length > 0 && !/^尚未读取作业列表。\s*(读取作业列表)?$/.test(sidebarText));
    check("页面无未捕获异常", pageErrors.length === 0);
    console.log(`auth-services gate: ${checks} checks passed`);
  } finally {
    await browser?.close().catch(() => {});
    await app.close();
    await session.close();
    await rm(dir, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });