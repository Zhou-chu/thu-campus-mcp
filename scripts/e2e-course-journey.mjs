#!/usr/bin/env node
/**
 * 课表用户旅程：真实应用路由 + 数据库 + Chromium，只替换网络学堂（校园）适配器。
 * 验证桌面周视图与手机窄屏日程指向同一门课、未排课课程不画格子，
 * 以及上游不可用时仍保留本地自定义课程、恢复后不重复。
 * 不登录真实网络学堂。
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

const COURSES = [
  { id: "c1", name: "数据结构", teacher: "张三", timeAndLocation: ["星期一第2节(全周)，六教6A216"] },
  { id: "c2", name: "专题讨论", teacher: "李四", timeAndLocation: [] },
];

/** 可切换的网络学堂替身；只影响课表读取，不触达真实教务。 */
function fakeLearnx() {
  const state = { failing: false, calls: [] };
  const unavailable = { ok: false, error: { code: "LEARNX_UNAVAILABLE", message: "网络学堂未登录，请先核验登录状态。" } };
  return {
    state,
    host: {
      describe: () => [],
      toolForModel: () => [],
      async call(name, args) {
        state.calls.push(name);
        if (name === "learn_list_semesters") return state.failing ? unavailable : { ok: true, data: { current: { id: "2026-1", name: "2026 秋", startDate: "2026-09-14" } } };
        if (name === "learn_list_courses") return state.failing ? unavailable : { ok: true, data: { items: COURSES.map(course => ({ ...course })), nextOffset: null } };
        return { ok: true, data: {} };
      },
      async close() {},
    },
  };
}

async function main() {
  const dir = await mkdtemp(path.join(tmpdir(), "campus-course-journey-"));
  const db = newDb({ autoCreateForeignKeyIndices: true });
  const session = await openStore({ pool: new (db.adapters.createPg().Pool)() });
  const learnx = fakeLearnx();
  const route = { route: "madmodel", models: async () => [], status: async () => ({ available: false }), chat: async () => { throw new Error("不需要对话"); } };
  const app = createAppServer({
    config: { root: ROOT, host: "127.0.0.1", port: 0, stateDir: dir, token: "", modelRoute: "madmodel", modelName: "", hostname: "course-gate", version: "gate" },
    host: learnx.host, route,
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
    await page.fill("#auth-email", "course-" + Date.now() + "@mails.tsinghua.edu.cn");
    await page.fill("#auth-password", "long-enough-pass");
    await page.click("#auth-submit");
    await page.waitForSelector("#app:not([hidden])", { timeout: 15000 });

    await page.click('.tab[data-view="timetable"]');
    await page.waitForSelector(".timetable-page", { timeout: 10000 });
    await page.waitForFunction(() => document.querySelectorAll(".course-block").length > 0, null, { timeout: 15000 });
    check("桌面周视图画出已排课程", (await page.locator(".course-block").count()) === 1);
    const desktop = await page.locator(".course-block").innerText();
    check("课程块给出大节时间与地点", /08:00–09:35/.test(desktop) && /六教6A216/.test(desktop));
    check("未排课课程不画格子但如实计数", /1 门课程没有上课时间地点/.test(await page.locator(".timetable-page").innerText()));

    await page.setViewportSize({ width: 420, height: 900 });
    await page.waitForFunction(() => {
      const item = document.querySelector(".agenda-item");
      return item && item.getBoundingClientRect().height > 0;
    }, null, { timeout: 5000 });
    const agenda = await page.locator(".agenda-item").first().innerText();
    check("窄屏日程显示同一门课与同一时间", /数据结构/.test(agenda) && /08:00–09:35/.test(agenda));
    check("窄屏课表无横向溢出", await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await page.setViewportSize({ width: 1280, height: 900 });

    await page.locator("#view").getByRole("button", { name: "添加课程", exact: true }).click();
    await page.getByPlaceholder("例如 大学物理").fill("本地自习");
    await page.getByPlaceholder("例如 六教6A216").fill("图书馆");
    await page.getByLabel("星期").selectOption("3");
    await page.getByLabel("开始节次").selectOption("3");
    await page.getByLabel("结束节次").selectOption("3");
    await page.locator("#view").getByRole("button", { name: "保存到课表", exact: true }).click();
    await page.waitForFunction(() => document.querySelectorAll('.course-block[data-custom="true"]').length === 1, null, { timeout: 15000 });
    check("本地自定义课程保存后出现在课表", /本地自习/.test(await page.locator('.course-block[data-custom="true"]').innerText()));

    learnx.state.failing = true;
    await page.locator("#view").getByRole("button", { name: "刷新", exact: true }).click();
    await page.waitForFunction(() => /教务课表读不到/.test(document.querySelector(".timetable-page")?.textContent || ""), null, { timeout: 15000 });
    check("上游不可用时说明原因并只显示本地课程", (await page.locator(".course-block").count()) === 1 && /本地自习/.test(await page.locator(".course-block").innerText()));
    check("失败状态不把旧教务课程当新结果", !/数据结构/.test(await page.locator(".timetable-page").innerText()));

    learnx.state.failing = false;
    await page.locator("#view").getByRole("button", { name: "重新读取", exact: true }).click();
    await page.waitForFunction(() => document.querySelectorAll(".course-block").length === 2, null, { timeout: 15000 });
    const restored = await page.locator(".timetable-page").innerText();
    check("恢复后同时显示教务课与本地课且不重复", /数据结构/.test(restored) && /本地自习/.test(restored) && (restored.match(/数据结构/g) || []).length === 1);
    check("页面无未捕获异常", pageErrors.length === 0);
    console.log(`course journey gate: ${checks} checks passed`);
  } finally {
    await browser?.close().catch(() => {});
    await app.close();
    await session.close();
    await rm(dir, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });