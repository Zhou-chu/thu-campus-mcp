import { readSnapshot } from "@thu-campus/browser";
import { openBrowserWithRetry } from "./browser-open.mjs";
import { withBrowserLock } from "./browser-lock.mjs";
import { CAS_ORIGIN, fillCasForm, waitFor } from "./cas.mjs";
import { defaultAccountDir, loadAccount } from "./account.mjs";

const HOME = "https://www.sports.tsinghua.edu.cn/venue/index.html#/home";
const SPORT_SELECTOR = "div.text.textOverFlow";
const SLOT_API = "/venue/site/api/reserve/current/page";
const SCENES_API = "/venue/site/api/site/scene/list";
const MENU_API = "/venue/site/api/site/menu";
const CURRENT_USER_API = "/venue/site/system/login/getLoginUser";
const SPORTS_ORIGIN = new URL(HOME).origin;
const READ_ENDPOINTS = {
  user: { path: CURRENT_USER_API, method: "GET" },
  menu: { path: MENU_API, method: "GET", version: "2.0.0" },
  scenes: { path: SCENES_API, method: "GET" },
  sites: { path: SLOT_API, method: "POST" },
  slots: { path: SLOT_API, method: "POST", version: "2.0.0" },
  buildings: { path: "/venue/site/api/site/chooseByType", method: "GET", version: "2.0.0", query: ({ sceneUuid }) => ({ sceneUuid, siteType: "BUILDING" }) },
  devKinds: { path: "/venue/site/api/site/devKind/list", method: "GET", version: "2.0.0", query: ({ sceneUuid }) => ({ uuid: sceneUuid }) },
  reservations: { path: "/venue/site/api/reserve/reserveRecord", method: "POST", version: "2.0.0" },
};

export function createSportsReader({ snapshot = readSnapshot, fetchImpl = fetch } = {}) {
  return async (name, body) => {
    if (!Object.hasOwn(READ_ENDPOINTS, name)) throw new SportsError("INVALID_ARGUMENTS", "不支持该体育查询接口。");
    const { path, method, version, query } = READ_ENDPOINTS[name];
    const target = new URL(SPORTS_ORIGIN + path);
    if (query) target.search = new URLSearchParams(query(body ?? {})).toString();
    const state = await snapshot();
    const raw = state?.origins?.find(item => item.origin === SPORTS_ORIGIN)?.localStorage?.find(item => item.name === "token")?.value;
    if (!raw) throw new SportsError("SPORTS_LOGIN_REQUIRED", "体育场馆需要先登录。");
    let token;
    try { token = JSON.parse(raw); } catch { /* Bad snapshot data cannot be used as a header. */ }
    if (typeof token !== "string" || !/^[\x21-\x7e]{1,4096}$/.test(token)) throw new SportsError("SPORTS_SESSION_INVALID", "体育会话无法读取，请重新登录。");
    const headers = { token };
    if (version) headers["x-api-version"] = version;
    if (method === "POST") headers["content-type"] = "application/json";
    try {
      const response = await fetchImpl(target.href, {
        method, headers, redirect: "manual", signal: AbortSignal.timeout(8000),
        body: method === "POST" ? JSON.stringify(body) : undefined,
      });
      return { status: response.status, ok: response.ok, data: await response.json().catch(() => null) };
    } catch { throw new SportsError("SPORTS_UNREACHABLE", "暂时无法连接体育场馆接口，请稍后再试。"); }
  };
}

const rawSportsRead = createSportsReader();

/** Only listed read operations recover, never the auth probe or a booking request. */
export function createSportsReadRecovery({ read = rawSportsRead, login = () => loginWithAccount(), now = Date.now } = {}) {
  let inFlight, manualVerification;
  const run = async (name, body) => {
    const result = await read(name, body);
    if (sportsLoginProof(result).state === "login-required")
      throw new SportsError("SPORTS_LOGIN_REQUIRED", "体育场馆的会话已失效，请重新登录。");
    return result;
  };
  return async (name, body) => {
    if (name === "user") return read(name, body);
    try {
      const result = await run(name, body);
      manualVerification = undefined;
      return result;
    } catch (error) {
      if (error?.code !== "SPORTS_LOGIN_REQUIRED") throw error;
    }
    if (manualVerification && now() < manualVerification.until) throw manualVerification.error;
    inFlight ??= Promise.resolve().then(login).finally(() => { inFlight = undefined; });
    const outcome = await inFlight;
    if (!outcome?.ok) {
      const err = new SportsError(outcome?.code || "SPORTS_LOGIN_REQUIRED", outcome?.message || "体育场馆需要先登录。");
      if (err.code === "CAS_CAPTCHA_REQUIRED") manualVerification = { until: now() + 120000, error: err };
      throw err;
    }
    return run(name, body);
  };
}

/** 预约记录归一：官网字段可能缺失，只保留能核对的字段。 */
export function normalizeReservations(payload) {
  const list = Array.isArray(payload?.data) ? payload.data : [];
  return list.filter(item => item && typeof item === "object").map(item => {
    const site = Array.isArray(item.siteVoList) ? item.siteVoList[0] : null;
    return {
      id: String(item.resvUuid || item.uuid || item.id || ""),
      site: String(site?.siteName || item.siteName || "").trim(),
      location: String(site?.location || "").trim() || undefined,
      start: item.resvTime?.startTime || null,
      end: item.resvTime?.endTime || null,
      status: String(item.resvStatus || "").trim() || null,
      checkStatus: String(item.resvCheckStatus || "").trim() || null,
    };
  }).filter(item => item.id || item.site);
}

export async function listReservations() {
  const payload = sportsReadData(await readSports("reservations", { pageNum: 1, pageSize: 10, orderItems: "resvBeginTime", orderRule: "desc" }));
  return { reservations: normalizeReservations(payload), fetchedAt: new Date().toISOString() };
}

const readSports = createSportsReadRecovery();
function sportsReadData(result) {
  if (sportsLoginProof(result).state === "login-required") throw new SportsError("SPORTS_LOGIN_REQUIRED", "体育场馆的会话已失效，请重新登录。");
  if (result.status === 429 || Number(result.data?.errorCode) === 1610001) throw new SportsError("SPORTS_THROTTLED", "体育官网限制了查询频率，请稍后重试。");
  if (!result.ok || result.data?.success !== true) throw new SportsError("SPORTS_API_FAILED", "体育场馆接口未返回查询结果。");
  return result.data;
}

export function sportsLoginProof(result) {
  const body = result?.data;
  if (result?.status === 401 || Number(body?.errorCode) === 1130002) return { state: "login-required", code: "SPORTS_LOGIN_REQUIRED" };
  const user = body?.data;
  const id = user?.id;
  const validId = (typeof id === "string" && id.trim().length > 0) || (Number.isSafeInteger(id) && id > 0);
  if (result?.ok && body?.success === true && validId) return { state: "ready", code: "VERIFIED" };
  return { state: "unknown", code: "SPORTS_PROBE_FAILED" };
}

export async function sportsSessionStatus({ snapshot = readSnapshot, fetchImpl = fetch, now = Date.now } = {}) {
  let proof = sportsLoginProof(null);
  try {
    proof = sportsLoginProof(await createSportsReader({ snapshot, fetchImpl })("user"));
  } catch (error) {
    if (error?.code === "SPORTS_LOGIN_REQUIRED") proof = { state: "unverified", code: "UNVERIFIED" };
  }
  return { ...proof, verified: proof.state === "ready", source: "protected-api:sports-current-user", checkedAt: new Date(now()).toISOString() };
}

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

async function withSportsPage(action) {
  return withBrowserLock("体育场馆", async () => {
    const { browser, page } = await openSportsPageInner();
    try {
      return await action({ browser, page });
    } finally {
      await browser.close().catch(() => {});
    }
  });
}

async function openSportsBrowser({ headless = false } = {}) {
  let browser;
  try {
    browser = await openBrowserWithRetry({ headless });
  } catch (error) {
    // 登录窗口开着时资料被占用，说清楚而不是笼统失败。
    throw new SportsError(
      error?.code === "BROWSER_BUSY" ? "BROWSER_BUSY" : "SPORTS_UNREACHABLE",
      error?.code === "BROWSER_BUSY" ? "浏览器正被登录窗口占用，先关闭窗口再刷新。" : "无法启动浏览器读取体育场馆。",
    );
  }
  const page = await browser.context.newPage();
  await page.setViewportSize({ width: 1440, height: 1000 });
  try {
    await page.goto(HOME, { waitUntil: "networkidle", timeout: 45000 });
  } catch {
    await browser.close().catch(() => {});
    throw new SportsError("SPORTS_UNREACHABLE", "打不开体育场馆页面，请检查网络或登录状态。");
  }
  return { browser, page };
}

async function openSportsPageInner() {
  const { browser, page } = await openSportsBrowser();
  let loginPage = await page.evaluate(() => /统一身份认证登录|校内登录|校外登录/.test(document.body.innerText || "")).catch(() => false);
  if (loginPage) {
    // 会话过期时先用统一账号静默登录一次，避免每次都要人工开窗口。
    const saved = await loadAccount(defaultAccountDir());
    if (saved?.username && saved?.password) {
      const result = await performSportsLogin(page, saved).catch(error => ({ ok: false, message: error?.message }));
      if (result.ok) {
        await page.goto(HOME, { waitUntil: "networkidle", timeout: 45000 }).catch(() => {});
        await page.waitForTimeout(1500);
        loginPage = await page.evaluate(() => /统一身份认证登录|校内登录|校外登录/.test(document.body.innerText || "")).catch(() => false);
      } else if (result.code === "CAS_CAPTCHA_REQUIRED") {
        await browser.close().catch(() => {});
        throw new SportsError("SPORTS_MANUAL_VERIFICATION", "体育登录需要验证码，请在窗口中人工完成。");
      }
    }
    if (loginPage) {
      await browser.close().catch(() => {});
      throw new SportsError("SPORTS_LOGIN_REQUIRED", "体育场馆需要先登录：请先用 campus_browser_open 打开 sports 并在窗口中完成登录。");
    }
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
  // 官方接口金额单位是分（如 700 表示 ￥7），这里统一换算成元。
  const unit = number(session?.userFeeDetails?.chargingUnitPrice);
  if (unit !== null) return Math.round(unit) / 100;
  for (const value of [session.userFeeDetails, session.ruleFeeDetails]) {
    if (typeof value === "number" && Number.isFinite(value)) return Math.round(value) / 100;
    if (Array.isArray(value)) {
      for (const item of value) {
        const candidate = number(item?.fee ?? item?.price ?? item?.amount ?? item?.money);
        if (candidate !== null) return Math.round(candidate) / 100;
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

/** 沿官网“场地预约”分类取场馆，不用字串猜运动归属。 */
export function normalizeSportsMenu(payload) {
  const entries = Array.isArray(payload?.data) ? payload.data : [];
  const section = entries.find(item => item?.menuName === "场地预约");
  if (!Array.isArray(section?.childrenVo)) return [];
  return section.childrenVo.flatMap(group => {
    const sport = typeof group?.menuName === "string" ? group.menuName.trim() : "";
    if (!sport || !Array.isArray(group.childrenVo)) return [];
    const venues = group.childrenVo.flatMap(item => {
      const name = typeof item?.menuName === "string" ? item.menuName.trim() : "";
      return name && typeof item.uuid === "string" && item.uuid ? [{ name, uuid: item.uuid, ...(Number.isInteger(item.sceneUseType) ? { sceneUseType: item.sceneUseType } : {}) }] : [];
    });
    return venues.length ? [{ sport, venues }] : [];
  });
}

async function readSportsMenu() {
  const menu = normalizeSportsMenu(sportsReadData(await readSports("menu")));
  if (!menu.length) throw new SportsError("SPORTS_EMPTY", "官网没有返回可读的体育目录。");
  return menu;
}

export async function listSports() {
  return { sports: (await readSportsMenu()).map(group => group.sport), at: new Date().toISOString() };
}

export async function listVenues(sport) {
  if (!sport) throw new SportsError("SPORT_REQUIRED", "请指定运动项目。");
  const group = (await readSportsMenu()).find(entry => entry.sport === sport);
  if (!group) throw new SportsError("SPORT_NOT_FOUND", `运动项目里没有“${sport}”。`);
  return { sport, venues: group.venues.map(venue => venue.name) };
}

const campusDay = () => new Date().toLocaleDateString("sv-SE", { timeZone: "Asia/Shanghai" });

function onlySportsUuid(payload) {
  const items = payload?.data;
  const uuid = Array.isArray(items) && items.length === 1 ? items[0]?.uuid : null;
  return typeof uuid === "string" && uuid.trim() ? uuid : null;
}

async function slotScope(read, venue) {
  if (venue.sceneUseType === 2) return { siteType: "ROOM", sceneUseType: "SPORT_GROUP", pageSize: 99 };
  if (venue.sceneUseType !== 4) throw new SportsError("SPORTS_SLOTS_UNSUPPORTED", "这个场馆使用不同的预约入口，请到体育官网查看场次。");

  const args = { sceneUuid: venue.uuid };
  const [buildings, kinds] = await Promise.all([read("buildings", args), read("devKinds", args)]);
  const classTypeUuid = onlySportsUuid(sportsReadData(buildings));
  const devKindUuid = onlySportsUuid(sportsReadData(kinds));
  if (!classTypeUuid || !devKindUuid) throw new SportsError("SLOTS_UNAVAILABLE", "官网场馆或设备分类无法唯一确定，请到体育官网查看场次。");
  return { devKindUuid, siteType: "DEV", searchValue: "", siteKindId: "", classTypeEnum: "BUILDING", classTypeUuid, sceneUseType: "SPORT_PERSON", pageSize: 999 };
}

export function createSportsSlotReader({ read = readSports, today = campusDay } = {}) {
  return async ({ sport, venue, date } = {}) => {
    if (!sport || !venue) throw new SportsError("ARGUMENT_REQUIRED", "请同时指定运动项目与场馆。");
    const wanted = date ? normalizeDate(date) : today();
    if (!wanted) throw new SportsError("INVALID_ARGUMENTS", "日期须为 YYYY-MM-DD。");
    const menu = normalizeSportsMenu(sportsReadData(await read("menu")));
    const venueInfo = menu.find(group => group.sport === sport)?.venues.find(item => item.name === venue);
    if (!venueInfo) throw new SportsError("VENUE_NOT_FOUND", "官网目录没有这个运动项目下的场馆。");
    const scope = await slotScope(read, venueInfo);
    const payload = sportsReadData(await read("slots", {
      sceneUuid: venueInfo.uuid, resvKind: "CURRENT_RESERVE", reserveDate: wanted, pageNum: 1, ...scope,
    }));
    const records = payload.data;
    if (!Array.isArray(records) || !records.length || !records.every(site => Array.isArray(site?.sessionVo))) {
      throw new SportsError("SLOTS_UNAVAILABLE", "官网未返回可核验的场次，请到体育官网查看或稍后重试。");
    }
    const normalized = normalizeSlots(payload, { venue, date: wanted });
    if (normalized.sessions.some(session => session.date !== wanted)) throw new SportsError("SPORTS_DATE_MISMATCH", "官网返回的场次日期与所选日期不一致。");
    return { sport, ...normalized, fetchedAt: new Date().toISOString() };
  };
}
export const listSlots = createSportsSlotReader();

/* c8 ignore start —— 页面内 fetch 与登录页判定 */
/** 已核对官网的只读请求使用专用会话头；不改变预约写入的传输方式。 */
async function sportsApi(page, path, { method = "GET", body } = {}) {
  const signedRead = method === "GET" && path === CURRENT_USER_API;
  return page.evaluate(async ({ path, method, body, signedRead, origin }) => {
    if (location.origin !== origin) return { status: 0, ok: false, data: null };
    const headers = body ? { "content-type": "application/json" } : {};
    // 官网写接口也校验 token；同源接口统一带上，读接口仍按需。
    const token = JSON.parse(localStorage.getItem("token") || "null");
    if (typeof token === "string" && /^[\x21-\x7e]{1,4096}$/.test(token)) headers.token = token;
    const response = await fetch(path, {
      method,
      credentials: "include",
      headers,
      redirect: "manual",
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await response.text();
    let data = null;
    try { data = JSON.parse(text); } catch { data = null; }
    return { status: response.status, ok: response.ok, data, text: text.slice(0, 300) };
  }, { path, method, body, signedRead, origin: SPORTS_ORIGIN });
}

/* c8 ignore stop */

/** 场景列表：uuid / 名称 / 站点类型 / 表单 id / 可提前预约天数。 */
export function normalizeScenes(payload) {
  const list = Array.isArray(payload?.data) ? payload.data : Array.isArray(payload) ? payload : [];
  return list
    .filter(item => item && typeof item === "object")
    .map(item => ({
      uuid: String(item.uuid || item.sceneUuid || ""),
      name: String(item.sceneName || item.sceneEnName || "").trim(),
      siteType: String(item.siteType || "").trim() || undefined,
      formId: String(item.formRuleVo?.formUuid || "").trim() || undefined,
      beforeReserveDays: Array.isArray(item.beforeReserveDays) ? item.beforeReserveDays.map(Number).filter(Number.isFinite) : [],
    }))
    .filter(item => item.uuid && item.name);
}

/** 某场景某天可约场地与时段。 */
export function normalizeAvailable(payload, { sceneUuid = "", date = "" } = {}) {
  const records = Array.isArray(payload?.data?.records) ? payload.data.records : Array.isArray(payload?.data) ? payload.data : [];
  const sites = [];
  for (const record of records) {
    if (!record || typeof record !== "object") continue;
    const uuid = String(record.uuid || record.siteUuid || "").trim();
    if (!uuid) continue;
    const slots = [];
    for (const slot of Array.isArray(record.reserveTime) ? record.reserveTime : []) {
      const start = String(slot?.startTime || "").trim();
      const end = String(slot?.endTime || "").trim();
      if (!start || !end) continue;
      slots.push({ start, end, available: slot.available !== false && slot.status !== 0 });
    }
    sites.push({
      uuid,
      name: String(record.siteName || record.name || "").trim() || uuid,
      siteType: String(record.siteType || "").trim() || undefined,
      formId: String(record.formRuleVo?.formUuid || "").trim() || undefined,
      deployUuid: String(record.deployUuid || "").trim() || undefined,
      slots,
    });
  }
  return { sceneUuid, date, sites };
}

/** lockSite / addReserve 的请求体，抽出来便于单测与人工复查。 */
export function buildReservePayload({ sceneUuid, siteUuid, siteType, resvKind = "CURRENT_RESERVE", members = [], startTime, endTime, formId, deployUuid }) {
  return {
    sceneUuid,
    resvKind,
    siteUuid,
    siteType,
    resvMember: members,
    reserveTime: [{ startTime, endTime }],
    formParam: { formId, ...(deployUuid ? { deployUuid } : {}) },
  };
}

/** 场景列表（需登录）。 */
export async function scenes() {
  const list = normalizeScenes(sportsReadData(await readSports("scenes")));
  if (!list.length) throw new SportsError("SPORTS_EMPTY", "官网没有返回可读的场景。");
  return { scenes: list, fetchedAt: new Date().toISOString() };
}

/** 某场景某天的场地；没有时段字段时明确标作未核验。 */
export async function available({ sceneUuid, date } = {}) {
  const uuid = String(sceneUuid || "").trim();
  if (!uuid) throw new SportsError("ARGUMENT_REQUIRED", "请指定场景 uuid。");
  const day = date ? normalizeDate(date) : new Date().toLocaleDateString("sv-SE", { timeZone: "Asia/Shanghai" });
  if (!day) throw new SportsError("INVALID_ARGUMENTS", "日期须为 YYYY-MM-DD。");
  const payload = sportsReadData(await readSports("sites", { pageSize: 50, pageNum: 1, reserveDate: day, sceneUuid: uuid, resvKind: "CURRENT_RESERVE" }));
  const records = payload.data?.records ?? payload.data;
  if (!Array.isArray(records)) throw new SportsError("SPORTS_API_FAILED", "体育场馆接口没有返回场地列表。");
  const slotsVerified = records.length > 0 && records.every(record => Array.isArray(record?.reserveTime));
  return { ...normalizeAvailable(payload, { sceneUuid: uuid, date: day }), slotsVerified, fetchedAt: new Date().toISOString() };
}

/**
 * 下单结果归类是纯函数，放在排除块外接受单测。
 * 只有明确依据（code 为 0 或成功文案）才算成功：回执缺失时报未知，绝不臆测已订上。
 */
export function reserveOutcome(payload) {
  const message = String(payload?.message || payload?.msg || "");
  const code = payload?.code ?? payload?.status;
  const hasCode = code !== undefined && code !== null && code !== "";
  const numeric = hasCode && Number.isFinite(Number(code));
  if (numeric && Number(code) !== 0) return { ok: false, code: "SPORTS_RESERVE_FAILED", message: message || "预约未成功。" };
  if (/安全验证|验证码|滑动/.test(message)) {
    return { ok: false, code: "SPORTS_MANUAL_VERIFICATION", message: "官网要求人工完成安全验证（滑块），自动化无法继续；请在场馆页面手动完成。" };
  }
  if (numeric && Number(code) === 0) return { ok: true, message };
  if (/预约成功|已预约成功|下单成功/.test(message)) return { ok: true, message };
  return {
    ok: false,
    code: "SPORTS_RESERVE_UNKNOWN",
    message: message
      ? `下单接口返回了无法确认是否成功的结果（${message}）。请先到「预约记录」核对，不要直接重复预约。`
      : "下单接口没有返回结果，无法确认是否预约成功。请先到「预约记录」核对，不要直接重复预约。",
  };
}

/** 预约参数校验与请求体构造（纯函数，可单测）。 */
export function reserveRequest({ sceneUuid, siteUuid, siteType, day, startTime, endTime, members = [], formId, deployUuid } = {}) {
  if (!sceneUuid || !siteUuid) throw new SportsError("ARGUMENT_REQUIRED", "请指定场景与场地。");
  if (!startTime || !endTime) throw new SportsError("ARGUMENT_REQUIRED", "请指定开始与结束时间。");
  const date = normalizeDate(day);
  const payload = buildReservePayload({
    sceneUuid: String(sceneUuid),
    siteUuid: String(siteUuid),
    siteType: String(siteType || ""),
    members: Array.isArray(members) ? members : [],
    startTime: date + " " + String(startTime).slice(0, 5) + ":00",
    endTime: date + " " + String(endTime).slice(0, 5) + ":00",
    formId,
    deployUuid,
  });
  return { sceneUuid, siteUuid, date, startTime, endTime, payload };
}

/* c8 ignore start —— 真实浏览器会话需要人工确认，按集成测试验证；编排本身在 reserveWith 内单测 */
/**
 * 预约：lockSite 拿 lockKey → addReserve；失败时尝试解锁。
 * 真实下单会占用场地并计费，调用方必须先取得用户明确同意。
 */
export async function reserve(args = {}) {
  const request = reserveRequest(args);
  return withSportsPage(({ page }) => reserveWith(sportsApi, request, page));
}

/* c8 ignore stop */

/**
 * 预约写入编排：拿锁 → 下单 → 失败时用同一 lockKey 解锁一次。
 * 传输层由调用方注入（真实为 sportsApi），因此可以只用替身核对写入与补偿次数。
 * 解锁失败不覆盖原始失败原因：补上 error.unlock 供上层如实告知。
 */
export async function reserveWith(api, request, page) {
  const { sceneUuid, siteUuid, date, startTime, endTime, payload } = request;
  let lockKey = "";
  try {
    const lock = await api(page, "/venue/site/api/reserve/lockSite", { method: "POST", body: payload });
    if (!lock.ok) throw new SportsError("SPORTS_LOCK_FAILED", lock.data?.message || "场地锁定失败。");
    lockKey = String(lock.data?.data?.lockKey || lock.data?.lockKey || lock.data?.data?.lock || "").trim();
    if (!lockKey) throw new SportsError("SPORTS_LOCK_FAILED", "场地锁定失败，可能已被占用。");
    const added = await api(page, "/venue/site/api/reserve/addReserve", { method: "POST", body: { ...payload, lockKey, ignoreError: 0 } });
    if (!added.ok) throw new SportsError("SPORTS_RESERVE_FAILED", added.data?.message || "预约未成功。");
    const outcome = reserveOutcome(added.data);
    if (!outcome.ok) throw new SportsError(outcome.code, outcome.message);
    return { ok: true, sceneUuid, siteUuid, date, startTime, endTime, lockKey, raw: added.data };
  } catch (error) {
    if (lockKey) {
      const released = await api(page, "/venue/site/api/reserve/unLockSite", { method: "POST", body: { ...payload, lockKey } })
        .then(result => ({
          ok: result?.ok === true && (result?.data?.code === undefined || Number(result.data.code) === 0),
          message: String(result?.data?.message || result?.data?.msg || ""),
        }))
        .catch(cause => ({ ok: false, message: String(cause?.message || "解锁请求失败。") }));
      if (error && typeof error === "object") error.unlock = released;
    }
    throw error;
  }
}

/** 用统一账号登录体育站点；遇到验证码/表单缺失如实返回，不冒充成功。 */
/** 在已打开的页面上完成统一身份认证登录；返回结果对象，不抛错。 */
async function performSportsLogin(page, credentials) {
  const sportsOrigin = new URL(HOME).origin;
  const isVenue = () => page.evaluate(origin => location.origin === origin && /个人中心|场地预约/.test(document.body?.innerText || "") &&
    !/校内登录|统一身份认证登录/.test(document.body?.innerText || ""), sportsOrigin).catch(() => false);
  const loggedIn = await isVenue();
  if (loggedIn) return { ok: true, alreadyLoggedIn: true };
  const clicked = await page
    .evaluate(() => {
      const button = [...document.querySelectorAll("button")].find(element => (element.textContent || "").includes("统一身份认证登录"));
      if (!button) return false;
      button.click();
      return true;
    })
    .catch(() => false);
  if (!clicked) return { ok: false, code: "SPORTS_LOGIN_BUTTON_MISSING", message: "体育站点没有找到统一身份认证登录入口。" };
  await page.waitForFunction(({ cas, sports }) => location.origin === cas || (location.origin === sports && /个人中心/.test(document.body?.innerText || "")),
    { cas: CAS_ORIGIN, sports: sportsOrigin }, { timeout: 10000 }).catch(() => {});
  if (await isVenue()) return { ok: true, alreadyLoggedIn: false };
  if (new URL(page.url()).origin !== CAS_ORIGIN) return { ok: false, code: "SPORTS_LOGIN_UNCONFIRMED", message: "未进入清华统一身份认证，请稍后重试。" };
  await page.locator("input#i_pass, input[type=password]").first().waitFor({ state: "visible", timeout: 8000 }).catch(() => {});
  const filled = await fillCasForm(page, credentials);
  if (!filled.ok && filled.code !== "CAS_SUBMIT_INTERRUPTED") return filled;
  const outcome = await Promise.race([
    waitFor(page, () => location.origin === "https://www.sports.tsinghua.edu.cn" && Boolean(localStorage.getItem("token")), { timeoutMs: 25000 }).then(ok => ok ? "ready" : "timeout"),
    (async () => {
      if (typeof page.waitForFunction !== "function") return new Promise(() => {});
      try {
        await page.waitForFunction(origin => location.origin === origin && /验证码|短信验证|二次验证/.test(document.body?.innerText || ""), CAS_ORIGIN, { timeout: 25000, polling: 250 });
        const value = await page.evaluate(origin => location.origin === origin && /验证码|短信验证|二次验证/.test(document.body?.innerText || ""), CAS_ORIGIN).catch(() => false);
        return value === true || (typeof value === "string" && /验证码|短信验证|二次验证/.test(value)) ? "challenge" : "timeout";
      } catch { return "timeout"; }
    })(),
  ]);
  if (outcome === "challenge") return { ok: false, code: "CAS_CAPTCHA_REQUIRED", message: "学校统一身份认证要求人工验证，请在体育登录窗口完成。" };
  if (outcome === "ready") return { ok: true, alreadyLoggedIn: false };
  const needsManual = await page.evaluate(origin => location.origin === origin && /验证码|短信验证|二次验证/.test(document.body?.innerText || ""), CAS_ORIGIN).catch(() => false);
  return needsManual
    ? { ok: false, code: "CAS_CAPTCHA_REQUIRED", message: "学校统一身份认证要求人工验证，请在体育登录窗口完成。" }
    : { ok: false, code: "SPORTS_LOGIN_UNCONFIRMED", message: "已提交登录，但未能确认体育场馆会话。" };
}

const sportsLoginFailure = proof => ({ ok: false, code: proof.code, message: proof.state === "login-required"
  ? "体育场馆的会话未建立或已经过期。" : "无法从体育场馆的当前用户接口核验登录。" });

export async function loginWithAccount(account) {
  const proof = await sportsSessionStatus();
  if (proof.verified) return { ok: true, alreadyLoggedIn: true };
  if (proof.state === "unknown") return sportsLoginFailure(proof);
  const credentials = account || (await loadAccount(defaultAccountDir()));
  if (!credentials?.username || !credentials?.password)
    throw new SportsError("ACCOUNT_NOT_CONFIGURED", "还没有配置清华账号，请先在“服务”页配置。");
  return withBrowserLock("体育登录", async () => {
    if ((await sportsSessionStatus()).verified) return { ok: true, alreadyLoggedIn: true };
    const { browser, page } = await openSportsBrowser({ headless: true });
    try {
      const current = sportsLoginProof(await sportsApi(page, CURRENT_USER_API).catch(() => null));
      if (current.state === "ready") {
        await browser.checkpoint();
        return { ok: true, alreadyLoggedIn: true };
      }
      if (current.state !== "login-required") return sportsLoginFailure(current);
      const removed = await page.evaluate(origin => {
        if (location.origin !== origin) return false;
        localStorage.removeItem("token");
        return true;
      }, SPORTS_ORIGIN).catch(() => false);
      if (!removed) return sportsLoginFailure(current);
      await page.reload({ waitUntil: "networkidle", timeout: 25000 });
      const result = await performSportsLogin(page, credentials);
      if (!result.ok) return result;
      const verified = sportsLoginProof(await sportsApi(page, CURRENT_USER_API).catch(() => null));
      if (verified.state !== "ready") return sportsLoginFailure(verified);
      await browser.checkpoint();
      return { ok: true, alreadyLoggedIn: false };
    } finally {
      await browser.close().catch(() => {});
    }
  });
}
