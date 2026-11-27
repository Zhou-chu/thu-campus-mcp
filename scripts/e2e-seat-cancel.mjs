#!/usr/bin/env node
/**
 * 座位取消的浏览器旅程：真实应用路由 + 数据库 + Chromium，只替换校园座位适配器。
 * 验证“先确认再写入、双击只写一次、结果未知不重发”，并检查桌面与 420px 两种视口。
 * 不登录真实图书馆，也不取消任何真实预约。
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
import { SeatError } from "../lib/app/seat.mjs";

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

/** 可切换行为的座位替身：记录写入次数，不触达真实图书馆。 */
function fakeSeat() {
  const day = new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
  const state = {
    bookings: [{ id: 41, title: "北馆 A001", status: 2, start: "2026-11-26 08:00", end: "2026-11-26 12:00" }],
    cancelCalls: [], seatCalls: [], mode: "ok", delayMs: 0, day,
  };
  return {
    state,
    api: {
      libraries: async () => ({ libraries: [{ id: 35, name: "北馆", valid: true }, { id: 36, name: "西馆", valid: true }] }),
      floors: async () => ({ floors: [{ id: 1, name: "一层", valid: true }] }),
      areas: async () => ({ areas: [{ id: 96, name: "A区", valid: true, total: 8 }, { id: 97, name: "B区", valid: true, total: 8 }] }),
      rules: async () => ({ rules: [] }),
      segments: async section => ({ segments: [{ id: Number(section) * 10, day }] }),
      days: async () => ({ days: [{ date: day }] }),
      seats: async (section, date, segment) => {
        // 记录每次读座位的参数：切换分区后不能再带上一分区的 segment。
        state.seatCalls.push({ section: Number(section), segment: segment ? Number(segment) : null });
        return {
          sectionId: Number(section),
          date,
          seats: [{ id: 5122, name: "A001", status: 0, segment: Number(section) * 10, begin: "08:00", end: "12:00" }],
          segments: [],
        };
      },
      sections: async () => ({ sections: [] }),
      bookings: async () => ({ bookings: state.bookings.map(item => ({ ...item })) }),
      cancel: async id => {
        state.cancelCalls.push(id);
        if (state.delayMs) await new Promise(resolve => setTimeout(resolve, state.delayMs));
        if (state.mode === "unknown") throw new SeatError("SEAT_CANCEL_UNKNOWN", "取消请求已发出但没有收到明确结果。");
        state.bookings = state.bookings.filter(item => item.id !== Number(id));
        return { id: Number(id), ok: true, cancelled: true };
      },
    },
  };
}

async function main() {
  const dir = await mkdtemp(path.join(tmpdir(), "campus-seat-cancel-"));
  const db = newDb({ autoCreateForeignKeyIndices: true });
  const session = await openStore({ pool: new (db.adapters.createPg().Pool)() });
  const seat = fakeSeat();
  const host = {
    describe: () => [],
    toolForModel: () => [],
    async call() { return { ok: true, data: {} }; },
    async close() {},
  };
  const route = { route: "madmodel", models: async () => [], status: async () => ({ available: false }), chat: async () => { throw new Error("不需要对话"); } };
  const app = createAppServer({
    config: { root: ROOT, host: "127.0.0.1", port: 0, stateDir: dir, token: "", modelRoute: "madmodel", modelName: "", hostname: "seat-cancel-gate", version: "gate" },
    host, route,
    devices: new DeviceStore(dir, { encrypt: async buffer => buffer }),
    pairing: new PairingCodes(),
    sessions: new SessionStore(dir),
    version: "gate",
    webuiDir: path.join(ROOT, "webui"),
    auth: session.auth,
    store: session,
    campus: { seat: seat.api },
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
    await page.fill("#auth-email", "seat-" + Date.now() + "@mails.tsinghua.edu.cn");
    await page.fill("#auth-password", "long-enough-pass");
    await page.click("#auth-submit");
    await page.waitForSelector("#app:not([hidden])", { timeout: 15000 });

    await page.click('.tab[data-view="seat"]');
    // 等首屏座位加载完成，再切换分区：切换后不得把上一分区的 segment 带进新查询。
    await page.waitForSelector(".seat-select", { timeout: 10000 });
    await page.waitForFunction(() => document.querySelectorAll(".seat-grid .seat-cell, .seat-map button, .seat-seat").length > 0, null, { timeout: 10000 }).catch(() => {});
    await page.selectOption(".seat-select", "97");
    await page.waitForFunction(() => true, null, { timeout: 1000 });
    await page.waitForTimeout(800);
    const seatCalls = seat.state.seatCalls;
    check("切换分区后会重新读座位", seatCalls.at(-1)?.section === 97, JSON.stringify(seatCalls));
    check("切换分区后不再带上一分区的 segment", seatCalls.at(-1)?.segment === null, JSON.stringify(seatCalls));
    check("切换分区不报读取失败", !/暂时读不到座位|时段已变化|该时段已失效/.test(await page.locator("#app").innerText()));

    await page.getByRole("button", { name: "读取预约记录", exact: true }).click();
    await page.waitForSelector(".seat-bookings-list li", { timeout: 10000 });
    check("读取记录后每条预约都有取消入口", (await page.locator(".seat-bookings-list li button").count()) === 1);
    check("预约条目显示真实字段", (await page.locator(".seat-bookings-list li").first().innerText()).includes("北馆 A001"));

    await page.getByRole("button", { name: "取消预约", exact: true }).click();
    await page.waitForSelector(".seat-cancel", { timeout: 5000 });
    check("第一次点击只展开确认，尚未写入", seat.state.cancelCalls.length === 0);
    check("确认块说明后果", /无法撤销/.test(await page.locator(".seat-cancel").innerText()));

    await page.getByRole("button", { name: "保留", exact: true }).click();
    check("选择保留后不写入", seat.state.cancelCalls.length === 0 && (await page.locator(".seat-cancel").count()) === 0);

    seat.state.delayMs = 200;
    await page.getByRole("button", { name: "取消预约", exact: true }).click();
    await page.locator(".seat-cancel .seat-chip").dblclick();
    await page.waitForFunction(() => document.querySelectorAll(".seat-bookings-list li").length === 0, null, { timeout: 10000 });
    check("双击确认只取消一次", seat.state.cancelCalls.length === 1);
    check("取消成功后列表刷新并提示结果", /已取消预约 #41/.test(await page.locator(".seat-notice").innerText()));

    seat.state.delayMs = 0;
    seat.state.mode = "unknown";
    seat.state.bookings = [{ id: 42, title: "北馆 B002", status: 2, start: "2026-11-27 13:00", end: "2026-11-27 17:00" }];
    await page.getByRole("button", { name: "读取预约记录", exact: true }).click();
    await page.waitForSelector(".seat-bookings-list li", { timeout: 10000 });
    await page.getByRole("button", { name: "取消预约", exact: true }).click();
    await page.locator(".seat-cancel .seat-chip").click();
    await page.waitForFunction(() => /核对/.test(document.querySelector(".seat-notice")?.textContent || ""), null, { timeout: 10000 });
    check("结果未知时提示核对而不是失败", /不要立即重复取消/.test(await page.locator(".seat-notice").innerText()));
    check("结果未知不自动重发", seat.state.cancelCalls.length === 2, "只多了本次这一次取消");
    check("结果未知仍显示原记录供核对", (await page.locator(".seat-bookings-list li").innerText()).includes("北馆 B002"));

    await page.setViewportSize({ width: 420, height: 900 });
    check("窄屏座位页无横向溢出", await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    const buttonHeight = await page.locator(".seat-bookings-list li button").first().evaluate(node => node.getBoundingClientRect().height);
    check("窄屏取消按钮触控高度不小于 44px", buttonHeight >= 44);
    check("页面无未捕获异常", pageErrors.length === 0);
    console.log(`seat-cancel gate: ${checks} checks passed`);
  } finally {
    await browser?.close().catch(() => {});
    await app.close();
    await session.close();
    await rm(dir, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });