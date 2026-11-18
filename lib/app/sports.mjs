import { openBrowser } from "@thu-campus/browser";

const HOME = "https://www.sports.tsinghua.edu.cn/venue/index.html#/home";
const SPORT_SELECTOR = "div.text.textOverFlow";
const SLOT_API = "/venue/site/api/reserve/current/page";
const CACHE_MS = 10 * 60_000;

let catalogCache = null;

export class SportsError extends Error {
  constructor(code, message) { super(message); this.name = "SportsError"; this.code = code; }
}

const textOf = node => (node?.textContent || "").trim();

async function clickText(page, selector, text) {
  await page.waitForSelector(selector, { timeout: 20000 });
  const box = await page.evaluate(([sel, wanted]) => {
    const node = [...document.querySelectorAll(sel)].find(item => (item.textContent || "").trim() === wanted);
    if (!node) return null;
    const rect = node.getBoundingClientRect();
    return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
  }, [selector, text]);
  if (!box) return false;
  await page.mouse.click(box.x, box.y);
  return true;
}

const listText = (page, selector, filter) => page.evaluate(([sel, pattern]) => {
  const re = pattern ? new RegExp(pattern) : null;
  return [...new Set([...document.querySelectorAll(sel)].map(node => (node.textContent || "").trim()).filter(text => text && (!re || re.test(text))))];
}, [selector, filter || ""]);

async function openSportsPage() {
  const browser = await openBrowser();
  const page = await browser.context.newPage();
  await page.setViewportSize({ width: 1440, height: 1000 });
  try {
    await page.goto(HOME, { waitUntil: "networkidle", timeout: 45000 });
  } catch {
    await browser.close().catch(() => {});
    throw new SportsError("SPORTS_UNREACHABLE", "打不开体育场馆页面，请检查网络或登录状态。");
  }
  const loginPage = await page.evaluate(() => /统一身份认证登录|校内登录|校外登录/.test(document.body.innerText || "")).catch(() => false);
  if (loginPage) {
    await browser.close().catch(() => {});
    throw new SportsError("SPORTS_LOGIN_REQUIRED", "体育场馆需要先登录：请先用 campus_browser_open 打开 sports 并在窗口中完成登录。");
  }
  if (!(await clickText(page, ".card", "场地预约"))) {
    await browser.close().catch(() => {});
    throw new SportsError("SPORTS_LOGIN_REQUIRED", "页面没有出现“场地预约”，可能需要先登录。");
  }
  await page.waitForFunction(sel => document.querySelectorAll(sel).length >= 5, SPORT_SELECTOR, { timeout: 20000 }).catch(() => {});
  return { browser, page };
}

const number = value => (typeof value === "number" && Number.isFinite(value) ? value : null);

/** 接口把日期给成 20261117 这样的数字，统一成 2026-11-17。 */
export function normalizeDate(value) {
  const text = typeof value === "number" && Number.isFinite(value) ? String(Math.trunc(value)) : String(value ?? "").trim();
  if (/^\d{8}$/.test(text)) return `${text.slice(0, 4)}-${text.slice(4, 6)}-${text.slice(6, 8)}`;
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : "";
}

function statusOf(session) {
  const raw = session?.reserveStatus;
  if (raw && typeof raw === "object") {
    const value = raw.reserveStatus ?? raw.code ?? "";
    return {
      status: value === "" || value === null ? undefined : String(value),
      reason: raw.reserveStatusReason ? String(raw.reserveStatusReason) : undefined,
    };
  }
  return { status: raw === undefined || raw === null || raw === "" ? undefined : String(raw), reason: undefined };
}

function priceOf(session) {
  const unit = number(session?.userFeeDetails?.chargingUnitPrice);
  if (unit !== null) return unit;
  for (const value of [session.userFeeDetails, session.ruleFeeDetails]) {
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (Array.isArray(value)) {
      for (const item of value) {
        const candidate = number(item?.fee ?? item?.price ?? item?.amount ?? item?.money);
        if (candidate !== null) return candidate;
      }
    }
  }
  return null;
}

export function normalizeSlots(payload, { venue = "", date = "" } = {}) {
  const sessions = [];
  for (const item of Array.isArray(payload?.data) ? payload.data : []) {
    const site = textOf({ textContent: item?.siteName ?? item?.sceneName ?? venue });
    for (const session of Array.isArray(item?.sessionVo) ? item.sessionVo : []) {
      const begin = String(session.beginTime ?? "").slice(0, 5);
      const end = String(session.endTime ?? "").slice(0, 5);
      if (!begin || !end) continue;
      const state = statusOf(session);
      sessions.push({
        id: String(session.sessionId ?? session.uuid ?? ""),
        uuid: String(session.uuid ?? ""),
        site: site || venue,
        begin,
        end,
        capacity: number(session.allowUserNum),
        reserved: number(session.resvUserNum),
        status: state.status,
        statusReason: state.reason,
        price: priceOf(session),
        date: normalizeDate(session.beginDate) || undefined,
      });
    }
  }
  sessions.sort((a, b) => a.begin.localeCompare(b.begin) || a.site.localeCompare(b.site, "zh"));
  return { venue, date, sessions };
}

/** 运动清单只读一次并缓存，避免每次都走一遍页面。 */
export async function listSports({ refresh = false } = {}) {
  if (!refresh && catalogCache && Date.now() - catalogCache.at < CACHE_MS) return catalogCache.data;
  const { browser, page } = await openSportsPage();
  try {
    const sports = await listText(page, SPORT_SELECTOR);
    if (!sports.length) {
      const info = await page.evaluate(() => ({ title: document.title, address: location.href.split(/[?#]/)[0], cards: document.querySelectorAll(".card").length, texts: document.querySelectorAll("div.text.textOverFlow").length, body: (document.body.innerText || "").replace(/\s+/g, " ").slice(0, 100) })).catch(() => null);
      throw new SportsError("SPORTS_EMPTY", "页面没有列出任何运动项目：" + JSON.stringify(info));
    }
    const data = { sports, at: new Date().toISOString() };
    catalogCache = { at: Date.now(), data };
    return data;
  } finally {
    await browser.close().catch(() => {});
  }
}

export async function listVenues(sport) {
  if (!sport) throw new SportsError("SPORT_REQUIRED", "请指定运动项目。");
  const { browser, page } = await openSportsPage();
  try {
    const sports = await listText(page, SPORT_SELECTOR);
    if (!sports.includes(sport)) throw new SportsError("SPORT_NOT_FOUND", `运动项目里没有“${sport}”。`);
    if (!(await clickText(page, SPORT_SELECTOR, sport))) throw new SportsError("SPORT_CLICK_FAILED", "无法进入该运动项目。");
    await page.waitForFunction(sel => {
      const texts = [...document.querySelectorAll(sel)].map(node => (node.textContent || "").trim());
      return texts.some(text => /馆|场/.test(text));
    }, SPORT_SELECTOR, { timeout: 20000 }).catch(() => {});
    const venues = await listText(page, SPORT_SELECTOR, "馆|场");
    return { sport, venues };
  } finally {
    await browser.close().catch(() => {});
  }
}

/**
 * 读取某场馆某天的场次。日期用 YYYY-MM-DD；当天以外的日期会先在页面上切到对应日期，
 * 一切数据仍以官方接口返回为准，不做推算。
 */
export async function listSlots({ sport, venue, date } = {}) {
  if (!sport || !venue) throw new SportsError("ARGUMENT_REQUIRED", "请同时指定运动项目与场馆。");
  const { browser, page } = await openSportsPage();
  try {
    if (!(await clickText(page, SPORT_SELECTOR, sport))) throw new SportsError("SPORT_CLICK_FAILED", "无法进入该运动项目。");
    await page.waitForFunction(sel => [...document.querySelectorAll(sel)].some(node => /馆|场/.test(node.textContent || "")), SPORT_SELECTOR, { timeout: 20000 }).catch(() => {});
    if (!(await clickText(page, SPORT_SELECTOR, venue))) throw new SportsError("VENUE_CLICK_FAILED", `无法进入场馆“${venue}”。`);
    const first = await page.waitForResponse(response => response.url().includes(SLOT_API), { timeout: 25000 }).catch(() => null);
    if (!first) throw new SportsError("SLOTS_UNAVAILABLE", "场馆页没有返回场次数据。");
    let payload = await first.json().catch(() => null);
    const today = new Date().toISOString().slice(0, 10);
    const wanted = typeof date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : today;
    if (wanted !== today) {
      const label = `${String(new Date(wanted + "T00:00:00").getMonth() + 1).padStart(2, "0")}.${wanted.slice(8, 10)}`;
      const changed = await clickText(page, "div,span,li", label).catch(() => false);
      if (changed) {
        const next = await page.waitForResponse(response => response.url().includes(SLOT_API), { timeout: 20000 }).catch(() => null);
        if (next) payload = await next.json().catch(() => payload);
      }
    }
    const normalized = normalizeSlots(payload, { venue, date: wanted });
    // 页面默认选中的日期可能与“今天”不同，以接口实际返回的日期为准，不假装是今天。
    const actualDate = normalized.sessions.find(session => session.date)?.date || wanted;
    normalized.date = actualDate;
    return { sport, ...normalized, fetchedAt: new Date().toISOString() };
  } finally {
    await browser.close().catch(() => {});
  }
}