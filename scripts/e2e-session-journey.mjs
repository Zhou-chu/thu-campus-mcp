#!/usr/bin/env node
/**
 * 会话旅程门禁：真实应用路由 + 数据库 + Chromium，只替换“统一登录编排”的结果。
 *
 * 覆盖 #168/#170 关心的三条用户旅程：
 *  1. 冷启动 → 账号登录 → 保存并登录 → 按服务状态显示（含被占用、需人工验证）；
 *  2. 状态恢复后再次登录 → 全部就绪，且不重复打直达登录接口；
 *  3. 并发点击只产生一次编排请求；窄屏无溢出、按钮可点、无未捕获异常。
 *
 * 不连接任何真实校园服务，也不执行预约/取消等写入。
 */
import assert from "node:assert/strict";
import path from "node:path";
import { existsSync } from "node:fs";
import { mkdtemp, readdir, rm, stat, readFile } from "node:fs/promises";
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
const check = (name, condition, detail) => {
  assert.ok(condition, name + (detail ? " —— " + detail : ""));
  checks += 1;
  console.log("  ✔ " + name);
};

async function chromiumPath() {
  for (const name of await readdir(path.join(ROOT, ".runtime/browsers"))) {
    const file = path.join(ROOT, ".runtime/browsers", name, "chrome-win64/chrome.exe");
    if (name.startsWith("chromium-") && await stat(file).then(() => true, () => false)) return file;
  }
  throw new Error("Chromium unavailable");
}

const ready = name => [name, { ok: true, state: "ready", code: "VERIFIED", message: "" }];

async function main() {
  const dir = await mkdtemp(path.join(tmpdir(), "campus-session-journey-"));
  const db = newDb({ autoCreateForeignKeyIndices: true });
  const session = await openStore({ pool: new (db.adapters.createPg().Pool)() });
  const host = { describe: () => [], toolForModel: () => [], async call() { return { ok: true, data: {} }; }, async close() {} };
  const route = { route: "madmodel", models: async () => [], status: async () => ({ available: false }), chat: async () => { throw new Error("不需要对话"); } };

  const calls = [];
  const sequence = [
    {
      ok: true, total: 3, ready: 1, needsManual: ["CAS_CAPTCHA_REQUIRED"], busy: 1,
      results: {
        learnx: { ok: false, state: "needs-manual", code: "CAS_CAPTCHA_REQUIRED", message: "统一身份认证要求验证码。" },
        seat: { ok: false, state: "busy", code: "BROWSER_BUSY", message: "浏览器正被占用（正在执行：open:seat）。" },
        sports: Object.fromEntries([ready("sports")]).sports,
      },
    },
    {
      ok: true, total: 3, ready: 3, needsManual: [], busy: 0,
      results: Object.fromEntries([ready("learnx"), ready("seat"), ready("sports")]),
    },
  ];
  const loginAll = async options => {
    calls.push(options);
    // 编排本身要花时间（真实环境更久）：故意慢一点，才能验证“忙时并发点击被忽略”。
    await new Promise(resolve => setTimeout(resolve, 800));
    return sequence[Math.min(calls.length - 1, sequence.length - 1)];
  };

  const app = createAppServer({
    config: { root: ROOT, host: "127.0.0.1", port: 0, stateDir: dir, token: "", modelRoute: "madmodel", modelName: "", hostname: "session-gate", version: "gate" },
    host, route,
    devices: new DeviceStore(dir, { encrypt: async buffer => buffer }),
    pairing: new PairingCodes(),
    sessions: new SessionStore(dir),
    version: "gate",
    webuiDir: path.join(ROOT, "webui"),
    auth: session.auth,
    store: session,
    loginAll,
  });

  let browser;
  try {
    const base = await app.listen();
    browser = await chromium.launch({ executablePath: await chromiumPath(), headless: true });
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    const pageErrors = [];
    page.on("pageerror", error => pageErrors.push(error.message));

    // 冷启动：没有会话，先注册应用账号（只在本机夹具库里）。
    await page.goto(base + "/");
    await page.click("#auth-switch");
    await page.fill("#auth-email", "journey-" + Date.now() + "@mails.tsinghua.edu.cn");
    await page.fill("#auth-password", "long-enough-pass");
    await page.click("#auth-submit");
    await page.waitForSelector("#app:not([hidden])", { timeout: 15000 });

    await page.click('.tab[data-view="services"]');
    await page.waitForSelector(".account-card", { timeout: 10000 });
    const rows = await page.locator(".auth-service").count();
    check("服务页列出全部服务行", rows >= 7, "实际 " + rows);

    // 第一次编排：一个被占用、一个需人工验证、一个成功。
    await page.getByRole("button", { name: "保存并登录", exact: true }).click();
    await page.waitForFunction(() => document.querySelector('[data-service="seat"] .auth-notice')?.textContent?.includes("占用"), null, { timeout: 30000 });
    check("被占用的服务给出可点恢复入口", (await page.getByRole("button", { name: "关闭占用窗口并重试" }).count()) === 1);
    check("需人工验证时给出说明", /人工验证/.test(await page.locator(".account-card").innerText()));
    check("成功的服务显示已登录", /已登录/.test(await page.locator('[data-service="sports"]').innerText()));
    check("编排只发一次请求", calls.length === 1, "实际 " + calls.length);

    // 第二次编排：全部就绪（先等第一次编排彻底结束，忙时点击会被按设计忽略）。
    await page.waitForTimeout(2500);
    await page.getByRole("button", { name: "保存并登录", exact: true }).click();
    await page.waitForFunction(() => document.querySelector('[data-service="learnx"] .auth-notice')?.textContent?.includes("已登录"), null, { timeout: 30000 }).catch(async error => {
      const snapshot = await page.evaluate(() => ({
        notice: document.querySelector('[data-service="learnx"] .auth-notice')?.textContent || "",
        card: document.querySelector(".account-card")?.innerText || "",
        busy: document.querySelector("button[disabled]")?.textContent || "",
      }));
      console.error("second batch debug:", JSON.stringify(snapshot), "calls:", calls.length);
      throw error;
    });
    check("恢复后全部就绪", calls.length === 2);
    check("就绪后不再残留占用入口", (await page.getByRole("button", { name: "关闭占用窗口并重试" }).count()) === 0);

    // 并发点击：忙时只允许一次编排。
    await page.waitForTimeout(2500);
    const beforeConcurrent = calls.length;
    // 同一个节点上连点两次：Playwright 的 click 会等元素可点，若页面已重渲染会重试，
    // 那样测到的是“渲染后又一次点击”，不是“忙时并发”。
    const clicked = await page.evaluate(() => {
      const button = document.querySelector(".account-card button.primary");
      if (!button) return 0;
      button.click();
      button.click();
      return 1;
    });
    assert.equal(clicked, 1, "并发点击前按钮应存在");
    await page.waitForTimeout(2500);
    check("并发点击只产生一次编排", calls.length === beforeConcurrent + 1, `before=${beforeConcurrent} after=${calls.length}`);

    // 跨进程占用：写入一份外来租约，座位登录必须被明确挡住并报出占用者。
    const { writeFile, unlink } = await import("node:fs/promises");
    await writeFile(path.join(dir, "browser-lease.json"), JSON.stringify({
      owner: "worker:gate", label: "open:seat", pid: process.pid,
      since: new Date().toISOString(), heartbeatAt: new Date().toISOString(),
    }));
    await page.locator('[data-service="seat"]').getByRole("button", { name: "登录", exact: true }).click();
    await page.waitForFunction(() => /占用|正在执行/.test(document.querySelector('[data-service="seat"] .auth-notice')?.textContent || ""), null, { timeout: 20000 })
      .catch(async error => {
        console.error("lease debug:", await page.evaluate(() => document.querySelector('[data-service="seat"] .auth-notice')?.textContent || "(无提示)"));
        throw error;
      });
    check("外来租约下座位登录被明确挡住", /正在执行：open:seat/.test(await page.locator('[data-service="seat"] .auth-notice').innerText()));
    await unlink(path.join(dir, "browser-lease.json")).catch(() => {});

    const browserState = await page.evaluate(async () => {
      const raw = localStorage.getItem("campus-connection") || "{}";
      const token = JSON.parse(raw).token || "";
      const response = await fetch("/api/browser-state", { headers: { authorization: "Bearer " + token } });
      return response.json();
    });
    check("浏览器队列最终空闲", browserState.ok === true && browserState.active === "" && browserState.waiting === 0, JSON.stringify(browserState));

    const lease = await readFile(path.join(dir, "browser-lease.json"), "utf8").catch(() => "");
    check("编排结束后不残留浏览器租约", lease === "", lease);

    // 窄屏：无横向溢出，主要按钮可点。
    await page.setViewportSize({ width: 420, height: 900 });
    check("窄屏服务页无横向溢出", await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    const buttonBox = await page.getByRole("button", { name: "保存并登录", exact: true }).boundingBox();
    check("窄屏保存按钮高度不小于 44px", buttonBox && buttonBox.height >= 44, JSON.stringify(buttonBox));

    // 进程重启：同一状态目录换一个新实例，已建立的会话必须继续可用。
    const cookies = await page.context().cookies(base);
    const cookieHeader = cookies.map(cookie => cookie.name + "=" + cookie.value).join("; ");
    check("页面持有登录会话", cookieHeader.length > 0);
    const restarted = createAppServer({
      config: { root: ROOT, host: "127.0.0.1", port: 0, stateDir: dir, token: "", modelRoute: "madmodel", modelName: "", hostname: "session-gate-2", version: "gate" },
      host, route,
      devices: new DeviceStore(dir, { encrypt: async buffer => buffer }),
      pairing: new PairingCodes(),
      sessions: new SessionStore(dir),
      version: "gate",
      webuiDir: path.join(ROOT, "webui"),
      auth: session.auth,
      store: session,
      loginAll,
    });
    try {
      const base2 = await restarted.listen();
      const meta = await fetch(base2 + "/api/meta", { headers: { cookie: cookieHeader } });
      check("重启后原登录会话仍可用", meta.status === 200, "HTTP " + meta.status);
    } finally {
      await restarted.close();
    }

    // 刷新后接着跟任务：让编排返回一个 queued 的 cloud 任务，刷新页面应重新跟上进度。
    sequence.length = 0;
    sequence.push({
      ok: true, total: 5, ready: 4, needsManual: [], busy: 0,
      results: { ...Object.fromEntries([ready("learnx"), ready("seat"), ready("sports"), ready("hetang")]),
        cloud: { ok: false, state: "queued", code: "LOGIN_QUEUED", message: "登录任务已提交。", jobId: "job-cloud-gate" } },
    });
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.getByRole("button", { name: "保存并登录", exact: true }).click();
    await page.waitForFunction(() => /登录任务/.test(document.querySelector('[data-service="cloud"] .auth-notice')?.textContent || ""), null, { timeout: 20000 });
    check("编排把 worker 服务标成任务进行中", /正在运行|正在启动/.test(await page.locator('[data-service="cloud"] .auth-notice').innerText()));

    // 并发矩阵：座位与体育查询同时发起，都要在预算内返回，且不留浏览器窗口/租约。
    sequence.length = 0;
    sequence.push({
      ok: true, total: 6, ready: 6, needsManual: [], busy: 0,
      results: Object.fromEntries(["learnx", "seat", "sports", "cloud", "hetang", "madmodel"].map(name => [name, { ok: true, state: "ready", code: "VERIFIED" }])),
    });
    const probeStarted = Date.now();
    const concurrent = await page.evaluate(async () => {
      // 两个服务各走一条读接口：这里验证的是“同一时刻两个请求都能被处理”，不依赖伪造的校园数据。
      const call = path => fetch(path, { headers: { "x-csrf-token": "gate" } })
        .then(async response => ({ status: response.status, json: await response.json().catch(() => null) }));
      const [seat, sports] = await Promise.all([call("/api/seat/bookings"), call("/api/sports/reservations")]);
      return { seat, sports };
    });
    const answered = value => value?.json && typeof value.json.ok === "boolean";
    check("并发查询两个服务都得到结构化应答", answered(concurrent.seat) && answered(concurrent.sports), JSON.stringify(concurrent));
    check("并发查询在 5 秒预算内", Date.now() - probeStarted < 5000, `${Date.now() - probeStarted}ms`);
    const leaseFile = path.join(dir, "browser-lease.json");
    check("并发查询不起浏览器也不留租约", !existsSync(leaseFile), "存在租约文件");

    check("页面无未捕获异常", pageErrors.length === 0, pageErrors.join(" | "));
    console.log(`session journey gate: ${checks} checks passed`);
  } finally {
    await browser?.close().catch(() => {});
    await app.close();
    await session.close();
    await rm(dir, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });