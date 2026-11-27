import { readFile } from "node:fs/promises";
import { defaultAccountDir } from "./account.mjs";
import { launchEphemeral, readSnapshot, saveSnapshot } from "@thu-campus/browser";
import { openBrowserWithRetry } from "./browser-open.mjs";
import { withBrowserLock } from "./browser-lock.mjs";
import { CAS_ORIGIN, fillCasForm } from "./cas.mjs";
import { createSeatLogin, createSeatPageReader, createSeatReadSession, loginSeatHttp, probeSeatSession, seatCookieHeader, SEAT_ORIGIN as BASE, SEAT_SESSION_PROBE, SEAT_HOME, SeatError, seatApiPayload } from "./seat-read.mjs";

export { SeatError } from "./seat-read.mjs";

const HOME = "/web/seat3?area=3";

let lastStatus = { state: "unknown", verified: false, code: "UNVERIFIED", checkedAt: null };
const rememberSeat = (state, code) => { lastStatus = { state, verified: state === "ready", code, checkedAt: new Date().toISOString() }; };

/** 最近一次座位读写得到的会话状态，供服务状态列表展示。 */
export function seatStatus() {
  return lastStatus;
}

const listOf = data => (Array.isArray(data?.list) ? data.list : data?.list && typeof data.list === "object" ? [data.list] : []);

/** 场馆树：馆/楼层平铺成便于选择的列表，保留层级与可用性。 */
export function normalizeLibraries(data) {
  return listOf(data)
    .filter(item => item && typeof item === "object" && item.id !== undefined)
    .map(item => ({
      id: Number(item.id),
      name: String(item.name ?? "").trim(),
      parentId: item.parentId === null || item.parentId === undefined ? null : Number(item.parentId),
      level: Number(item.levels ?? 0),
      valid: item.isValid === 1 || item.isValid === true,
    }))
    .filter(item => item.name)
    .sort((a, b) => a.level - b.level || a.id - b.id);
}

/** 某馆某天的楼层列表；childArea 才是有座位的层。 */
export function normalizeFloors(data) {
  const items = listOf(data);
  const floors = [];
  for (const item of items) {
    for (const child of Array.isArray(item?.childArea) ? item.childArea : []) {
      const id = Number(child?.id);
      if (!Number.isFinite(id)) continue;
      floors.push({
        id,
        name: String(child.name ?? "").trim(),
        parentId: Number(child.parentId ?? item?.areaInfo?.id ?? 0),
        valid: child.isValid === 1 || child.isValid === true,
        total: Number.isFinite(Number(child.TotalCount)) ? Number(child.TotalCount) : null,
        free: Number.isFinite(Number(child.UnavailableSpace))
          ? Math.max(0, Number(child.TotalCount ?? 0) - Number(child.UnavailableSpace))
          : null,
      });
    }
  }
  return floors.filter(floor => floor.name).sort((a, b) => a.id - b.id);
}

/** areadays 返回的是 PHP 时间对象，统一成 YYYY-MM-DD 字符串。 */
export function normalizeDays(data) {
  const days = [];
  for (const item of listOf(data)) {
    const raw = item && typeof item === "object" && item.day && typeof item.day === "object" ? item.day.date : item?.day ?? item?.date;
    const text = String(raw ?? "");
    const date = /^\d{4}-\d{2}-\d{2}/.test(text) ? text.slice(0, 10) : "";
    if (date) days.push({ date, sectionId: Number(item?.id ?? item?.sectionId ?? 0) || null, start: item?.startTime ?? null, end: item?.endTime ?? null });
  }
  return days.sort((a, b) => a.date.localeCompare(b.date));
}

/** 把一次性会话里的座位 Cookie 合并回快照，保留其它服务的 Cookie。 */
async function persistSeatCookies(context) {
  const [current, cookies] = await Promise.all([readSnapshot().catch(() => null), context.cookies()]);
  const isSeat = cookie => String(cookie?.domain || "").includes("seat.lib.tsinghua.edu.cn");
  const keep = (current?.cookies ?? []).filter(cookie => !isSeat(cookie));
  const fresh = (cookies ?? []).filter(isSeat);
  if (!fresh.length) return;
  await saveSnapshot({}, { ...(current || { origins: [] }), cookies: [...keep, ...fresh] });
}

/** 本地账号读取放在工厂外：它只依赖环境与文件，不产生浏览器副作用。导出以便测试真实实现（不被注入替身）。 */
export async function readCredentials() {
  const { loadAccount } = await import("./account.mjs");
  const unified = await loadAccount(defaultAccountDir());
  if (unified) return { username: unified.username, password: unified.password };
  // 默认旧路径由统一账号迁移；仅保留操作者显式指定的外部文件兼容入口。
  if (!process.env.SEAT_CREDENTIALS) return null;
  try {
    const raw = JSON.parse(await readFile(credentialsPath(), "utf8"));
    const username = String(raw?.username ?? "").trim();
    const password = String(raw?.password ?? "");
    return username && password ? { username, password } : null;
  } catch {
    return null;
  }
}

/**
 * 核对一条既有记录是否就是本次要预约的目标。
 * 只有座位、时段、日期都能对上才算数：同一天另一笔有效预约不能冒充本次成功。
 */
export function matchesReserveTarget(item, target = {}) {
  if (!item || Number(item.status) !== 2) return false;
  const day = target.day || null;
  if (day) {
    const stamp = String(item.end ?? item.start ?? "");
    if (!stamp.startsWith(day)) return false;
  }
  const space = Number(target.space) || 0;
  if (space) {
    const recordSpace = item.space === null || item.space === undefined ? null : Number(item.space);
    if (recordSpace !== space) return false;
  }
  const segment = Number(target.segment) || 0;
  if (segment) {
    const recordSegment = item.segment === null || item.segment === undefined ? null : Number(item.segment);
    if (recordSegment !== segment) return false;
  }
  return true;
}

export function createSeatApi({
  openBrowser = openBrowserWithRetry,
  openEphemeral = (options) => launchEphemeral(options),
  withLock = withBrowserLock,
  casFill = fillCasForm,
  casOrigin = CAS_ORIGIN,
  readCredentials: readCreds = readCredentials,
  readRulesPage = null,
  persistCookies = persistSeatCookies,
  loginHttp = loginSeatHttp,
  createReadSession = createSeatReadSession,
  probe = probeSeatSession,
  createLogin = createSeatLogin,
  readSnapshotState = readSnapshot,
  fetchImpl = fetch,
  // 测试默认不走网络：只有显式打开（或非测试进程）才允许纯 HTTP 预约/取消。
  httpReserve = !process.env.NODE_TEST_CONTEXT,
  now = () => new Date(),
} = {}) {
const loggedOut = message => /登录|超时|未登录/.test(String(message ?? ""));
const withSeatRead = createReadSession({ refresh: () => login(), onState: rememberSeat });

/**
 * 打开一次座位页，在同一会话里连续取多个接口，避免每个请求都开浏览器。
 * 所有请求都是同源 GET，带站点 cookie；不提交任何预约。
 */
// 浏览器驱动层需要真实登录会话，按集成测试验证；单元测试覆盖上面的纯函数。

async function withSeatSession(action, { autoLogin = true } = {}) {
  return withLock("图书馆座位", () => withSeatSessionInner(action, autoLogin));
}

/**
 * 预约/取消优先走纯 HTTP：站点要的 access_token / userid 既在 Cookie 里、也在首页的
 * window.ska 里，两处都能用普通请求取到，没必要为此打开浏览器。
 *
 * 返回 null 表示“拿不到可用会话”，调用方再回退到浏览器路径（旧快照可能只带 Cookie）。
 */
async function seatHttpSession() {
  const cookies = (await readSnapshotState().catch(() => null))?.cookies ?? [];
  const home = new URL(SEAT_HOME, BASE);
  const cookie = seatCookieHeader(cookies, home, now().getTime());
  if (!cookie) return null;
  const pick = name => cookies.find(item => item.name === name)?.value || "";
  let token = pick("access_token");
  let userid = pick("userid");
  if (!token || !userid) {
    const response = await fetchImpl(home, { method: "GET", headers: { cookie }, redirect: "manual", signal: AbortSignal.timeout(10000) }).catch(() => null);
    if (!response) return null;
    const html = await response.text().catch(() => "");
    token ||= /access_token["']?\s*[:=]\s*["']([^"']+)["']/.exec(html)?.[1] || "";
    userid ||= /userid["']?\s*[:=]\s*["'](\d+)["']/.exec(html)?.[1] || "";
  }
  if (!token) return null;
  const post = async (path, form) => {
    const url = new URL(path, BASE);
    const response = await fetchImpl(url, {
      method: "POST",
      headers: { cookie, "content-type": "application/x-www-form-urlencoded", "x-requested-with": "XMLHttpRequest", referer: home.href },
      body: form,
      signal: AbortSignal.timeout(15000),
    }).catch(() => null);
    if (!response) throw new SeatError("SEAT_UNREACHABLE", "暂时无法访问座位系统，请稍后重试。");
    const text = await response.text().catch(() => "");
    try { return { status: response.status, json: JSON.parse(text) }; }
    catch { return { status: response.status, json: null, text: text.slice(0, 120) }; }
  };
  return { cookie, token, userid, post };
}

/**
 * 座位会话：优先复用持久档案；档案被别的窗口占着时改用一次性无头浏览器，
 * 成功后把座位 Cookie 合并回快照——这样恢复不再依赖、也不阻塞其它浏览器任务。
 */
async function withSeatSessionInner(action, autoLogin) {
  let browser;
  let ephemeral = false;
  try {
    browser = await openBrowser({ headless: true, label: "seat:session" });
  } catch (error) {
    if (error?.code !== "BROWSER_BUSY") throw new SeatError("SEAT_UNREACHABLE", "无法启动浏览器读取图书馆座位。");
    try {
      browser = await openEphemeral({ headless: true });
      ephemeral = true;
    } catch {
      throw new SeatError("BROWSER_BUSY", "浏览器正被登录窗口占用，先关闭窗口再试。");
    }
  }
  const checkpoint = ephemeral ? () => persistCookies(browser.context) : () => browser.checkpoint();
  try {
    const page = await browser.context.newPage();
    await page.goto(`${BASE}${HOME}&_=${Date.now()}`, { waitUntil: "domcontentloaded", timeout: 45000 });
    if (autoLogin) await performSeatLogin(page);
    return await action({ page, browser, checkpoint });
  } finally {
    // 一次性会话用完即弃：先把座位 Cookie 写回快照，后续只读查询才能继续走 HTTP。
    if (ephemeral) await persistCookies(browser.context).catch(() => {});
    await browser.close().catch(() => {});
  }
}


/** 本地凭据文件（用户自行创建，权限 600）；不存在则退回浏览器密码管理器。 */
function credentialsPath() {
  const dir = defaultAccountDir();
  return process.env.SEAT_CREDENTIALS || dir.replace(/[\\/]$/, "") + "/seat-credentials.json";
}


/** 座位页面状态：未开放时段、需要登录、或已可用。 */
function seatPageState(text) {
  const flat = String(text || "").replace(/\s+/g, " ");
  if (/系统开放预约时间|请在开放时间段进行预约/.test(flat)) return "closed";
  if (/已登录/.test(flat)) return "ready";
  if (/登录/.test(flat)) return "login";
  return "ready";
}

/** 已有会话直接核验；只有官网明确判过期时才清理图书馆域并尝试CAS。 */
const loginViaBrowser = createSeatLogin({
  probe,
  onState: rememberSeat,
  open: action => withSeatSession(action, { autoLogin: false }),
  verify: async ({ browser }) => {
    const response = await browser.context.request.get(BASE + SEAT_SESSION_PROBE, { timeout: 10000, maxRedirects: 0 });
    seatApiPayload(await response.json().catch(() => null), response.status());
  },
  reset: async ({ page, browser }) => {
    await browser.context.clearCookies({ domain: /^\.?seat\.lib\.tsinghua\.edu\.cn$/ });
    await page.goto(BASE + HOME, { waitUntil: "domcontentloaded", timeout: 25000 });
  },
  authenticate: ({ page }) => performSeatLogin(page),
});

/**
 * 登录优先走纯 HTTP：拿统一认证换座位 Cookie，再写回快照。
 * 只有“网络/页面结构”这类不确定失败才退回浏览器；凭据错误、需要二次认证直接如实返回，
 * 不为了绕过失败去开一个窗口。
 */
const login = async () => {
  const saved = await readCreds().catch(() => null);
  if (saved?.username && saved?.password) {
    try {
      const result = await loginHttp({ credentials: saved, casOrigin: casOrigin });
      await persistSeatCookieList(result.cookies);
      rememberSeat("ready", "VERIFIED");
      return { ok: true, alreadyLoggedIn: false, via: "http", checkedAt: result.at };
    } catch (error) {
      if (error?.code === "SEAT_CREDENTIALS_INVALID")
        return { ok: false, code: error.code, message: error.message, needsManual: false };
      if (error?.code === "CAS_CAPTCHA_REQUIRED")
        return { ok: false, code: error.code, message: error.message, needsManual: true };
      // 其它错误（网络、页面结构变化）继续尝试浏览器路径。
    }
  }
  return loginViaBrowser();
};

/** 把 HTTP 登录拿到的 Cookie 合并进快照，保留其它服务的 Cookie。 */
async function persistSeatCookieList(cookies) {
  const current = await readSnapshot().catch(() => null);
  const isSeat = cookie => String(cookie?.domain || "").includes("seat.lib.tsinghua.edu.cn");
  const keep = (current?.cookies ?? []).filter(cookie => !isSeat(cookie));
  const fresh = (cookies ?? []).filter(isSeat);
  if (!fresh.length) return;
  await saveSnapshot({}, { ...(current || { origins: [] }), cookies: [...keep, ...fresh] });
}

async function performSeatLogin(page) {
  const tokenOf = () => page.evaluate(origin => location.origin === origin && Boolean(window.ska?.access_token), BASE).catch(() => false);
  const text = () => page.evaluate(() => document.body?.innerText || "").catch(() => "");
  const closed = { ok: false, code: "SEAT_CLOSED", message: "座位系统开放时间 06:00~23:00，当前不在开放时段。" };
  const unconfirmed = { ok: false, code: "SEAT_LOGIN_UNCONFIRMED", message: "未能确认图书馆座位登录，请核对保存的清华账号或手动完成验证。", needsManual: true };
  if (await tokenOf()) return { ok: true, alreadyLoggedIn: true };
  if (seatPageState(await text()) === "closed") return closed;
  const saved = await readCreds();
  if (!saved) return { ok: false, code: "ACCOUNT_NOT_CONFIGURED", message: "请先在“清华账号”配置学号与密码。" };
  if (new URL(page.url()).origin === BASE) {
    await page.locator("a,button").filter({ hasText: /^\s*登录\s*$/ }).first().click({ timeout: 10000 }).catch(() => {});
  }
  await page.waitForFunction(({ cas, seat }) => location.origin === cas || location.origin === seat && Boolean(window.ska?.access_token),
    { cas: casOrigin, seat: BASE }, { timeout: 12000 }).catch(() => {});
  const challengeOnCas = async () => {
    const value = await page.evaluate(origin => location.origin === origin && /验证码|短信验证|二次验证/.test(document.body?.innerText || ""), casOrigin).catch(() => false);
    return value === true || (typeof value === "string" && /验证码|短信验证|二次验证/.test(value));
  };
  if (new URL(page.url()).origin === casOrigin) {
    if (await challengeOnCas()) return { ok: false, code: "CAS_CAPTCHA_REQUIRED", message: "学校统一身份认证要求人工验证。", needsManual: true };
    await page.locator("input#i_pass, input[type=password]").first().waitFor({ state: "visible", timeout: 8000 }).catch(() => {});
    const result = await casFill(page, saved);
    if (!result.ok && result.code !== "CAS_SUBMIT_INTERRUPTED") return { ...result, needsManual: true };
  }
  if (await tokenOf()) return { ok: true, alreadyLoggedIn: false };
  const seating = await Promise.race([
    page.waitForFunction(origin => location.origin === origin && Boolean(window.ska?.access_token), BASE, { timeout: 15000, polling: 250 }).then(() => "ready", () => "timeout"),
    (async () => {
      if (typeof page.waitForFunction !== "function") return new Promise(() => {});
      try {
        await page.waitForFunction(origin => location.origin === origin && /验证码|短信验证|二次验证/.test(document.body?.innerText || ""), casOrigin, { timeout: 15000, polling: 250 });
        return (await challengeOnCas()) ? "challenge" : "timeout";
      } catch { return "timeout"; }
    })(),
  ]);
  if (seating === "challenge") return { ok: false, code: "CAS_CAPTCHA_REQUIRED", message: "学校统一身份认证要求人工验证。", needsManual: true };
  if (seating !== "ready") await page.waitForFunction(origin => location.origin === origin && Boolean(window.ska?.access_token), BASE, { timeout: 1500 }).catch(() => {});
  if (await tokenOf()) return { ok: true, alreadyLoggedIn: false };
  const final = await text();
  if (seatPageState(final) === "closed") return closed;
  if (new URL(page.url()).origin === casOrigin && /验证码|短信验证|二次验证/.test(final)) {
    return { ok: false, code: "CAS_CAPTCHA_REQUIRED", message: "学校统一身份认证要求人工验证。", needsManual: true };
  }
  return unconfirmed;
}

/** 官网预约规则原文与开放时段：来自页面的 ska.bookRule，不自行编造。 */
function normalizeRules(rawText) {
  const text = String(rawText ?? "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  const windowMatch = /(\d{1,2})\s*[：:]\s*(\d{2})\s*[-–~至]\s*(\d{1,2})\s*[：:]\s*(\d{2})/.exec(text);
  const pad = value => String(value).padStart(2, "0");
  const bookingWindow = windowMatch
    ? { open: pad(windowMatch[1]) + ":" + windowMatch[2], close: pad(windowMatch[3]) + ":" + windowMatch[4] }
    : null;
  return {
    window: bookingWindow,
    sameDayOrNext: /当日或次日/.test(text),
    text,
  };
}

/** 预约规则优先直读页面 HTML（不打开浏览器）；读不到才退回页面求值。 */
// 规则默认走 HTTP 页面读取；注入 readRulesPage 可完全绕开网络（测试或无网环境）。
const seatRulesPage = readRulesPage ?? createSeatReadSession({ createReader: () => createSeatPageReader(), refresh: () => login() });
const rules = async () => {
  const text = await seatRulesPage(async ({ call }) => call(SEAT_HOME)).catch(() => "");
  if (text) {
    const normalized = normalizeRules(text);
    if (normalized.text) return { ...normalized, source: "page:ska.bookRule", fetchedAt: new Date().toISOString() };
  }
  return withSeatSession(async ({ page }) => {
    const raw = await page.evaluate(() => window.ska?.bookRule ?? "");
    const ruleText = Array.isArray(raw) ? raw.join(" ") : String(raw);
    const normalized = normalizeRules(ruleText);
    if (!normalized.text) throw new SeatError("SEAT_EMPTY", "页面没有返回预约规则。");
    return { ...normalized, source: "window.ska.bookRule", fetchedAt: new Date().toISOString() };
  });
};

const libraries = () => withSeatRead(async ({ call }) => {
  const data = await call("/api.php/areas/1/tree/1");
  const items = normalizeLibraries(data.data);
  if (!items.length) throw new SeatError("SEAT_EMPTY", "没有读到任何馆区。");
  return { libraries: items };
}, { authenticated: false });

function normalizeSections(data) {
  const sections = [];
  for (const item of listOf(data)) {
    for (const sub of Array.isArray(item?.seatinfo) ? item.seatinfo : []) {
      const id = Number(sub?.id);
      if (!Number.isFinite(id)) continue;
      const total = Number(sub.TotalCount) || 0;
      const used = Number(sub.UnavailableSpace) || 0;
      if (!total) continue;
      sections.push({
        id,
        name: String(sub.name ?? "").trim(),
        valid: sub.isValid === 1 || sub.isValid === true,
        total,
        free: Math.max(0, total - used),
      });
    }
  }
  return sections.filter(item => item.name).sort((a, b) => b.free - a.free || a.id - b.id);
}

/** v3areas 的真实结构是 { areaInfo, childArea, seatinfo }；childArea 才是下一层。 */
function normalizeChildren(data) {
  const list = data && typeof data === "object" ? data.list ?? data : {};
  const children = Array.isArray(list.childArea) ? list.childArea : [];
  const areaInfo = list.areaInfo ?? null;
  const nodes = children
    .filter(item => item && typeof item === "object")
    .map(item => ({
      id: Number(item.id),
      name: String(item.name ?? "").trim(),
      parentId: Number(item.parentId ?? areaInfo?.id ?? 0) || null,
      valid: item.isValid === 1 || item.isValid === true,
      total: Number.isFinite(Number(item.TotalCount)) ? Number(item.TotalCount) : null,
      free: Number.isFinite(Number(item.UnavailableSpace))
        ? Math.max(0, Number(item.TotalCount ?? 0) - Number(item.UnavailableSpace))
        : null,
    }))
    .filter(item => Number.isFinite(item.id) && item.name);
  return {
    area: areaInfo ? { id: Number(areaInfo.id), name: String(areaInfo.name ?? "").trim() } : null,
    children: nodes,
  };
}

const floors = (libraryId) => withSeatRead(async ({ call }) => {
  const id = Number(libraryId);
  if (!Number.isFinite(id) || id <= 0) throw new SeatError("ARGUMENT_REQUIRED", "请指定馆区 id。");
  const data = await call("/api.php/v3areas/" + id);
  const parsed = normalizeChildren(data.data);
  if (!parsed.children.length) throw new SeatError("SEAT_EMPTY", "该馆区没有楼层。");
  return { libraryId: id, library: parsed.area, floors: parsed.children };
});

const areas = floorId => withSeatRead(async ({ call }) => {
  const id = Number(floorId);
  if (!Number.isFinite(id) || id <= 0) throw new SeatError("ARGUMENT_REQUIRED", "请指定楼层 id。");
  const data = await call("/api.php/v3areas/" + id);
  const parsed = normalizeChildren(data.data);
  if (!parsed.children.length) throw new SeatError("SEAT_EMPTY", "该楼层没有分区。");
  return { floorId: id, floor: parsed.area, areas: parsed.children };
});


/** 轻量 TTL 缓存：分区扫描要上百次请求，短时间内复用结果。 */
function createTtlCache({ ttlMs = 5 * 60_000, now = () => Date.now() } = {}) {
  const store = new Map();
  return {
    get(key) {
      const hit = store.get(key);
      if (!hit) return null;
      if (now() - hit.at > ttlMs) {
        store.delete(key);
        return null;
      }
      return hit.value;
    },
    set(key, value) {
      store.set(key, { at: now(), value });
      return value;
    },
    clear() {
      store.clear();
    },
  };
}

/** 一次会话内批量探测各分区的可约日期，避免逐分区反复登录。 */
function createSeatSections({ cache = createTtlCache(), read = withSeatRead, today = () => new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10) } = {}) {
  return libraryId => read(async ({ call }) => {
    const id = Number(libraryId) || 35;
    const todayIso = today();
    const cacheKey = id + ":" + todayIso;
    const cached = cache.get(cacheKey);
    if (cached) return { ...cached, cached: true };
  const library = normalizeChildren((await call("/api.php/v3areas/" + id)).data);
  const collected = [];
  for (const floor of library.children) {
    let children = [];
    try {
      children = normalizeChildren((await call("/api.php/v3areas/" + floor.id)).data).children;
    } catch (error) {
      if (error?.code === "SEAT_LOGIN_REQUIRED") throw error;
      continue;
    }
    for (const area of children) {
      try {
        const data = await call("/api.php/areadays/" + area.id);
        const days = [...new Set(normalizeSegments(data.data).map(seg => seg.day))].filter(day => day >= todayIso);
        if (days.length) collected.push({ ...area, floorId: floor.id, floorName: floor.name, days: days.sort((a, b) => a.localeCompare(b)) });
      } catch (error) {
        if (error?.code === "SEAT_LOGIN_REQUIRED") throw error;
        // 单个分区不可预约不影响整体列表。
      }
    }
  }
  collected.sort((a, b) => b.free - a.free || a.name.localeCompare(b.name, "zh"));
    return cache.set(cacheKey, { libraryId: id, today: todayIso, sections: collected });
  });
}

/** 进程内默认实例；缓存归属这个实例，测试与多服务器可各自构造。 */
const defaultSections = createSeatSections();
const sections = libraryId => defaultSections(libraryId);

const days = sectionId => withSeatRead(async ({ call }) => {
  const id = Number(sectionId);
  if (!Number.isFinite(id) || id <= 0) throw new SeatError("ARGUMENT_REQUIRED", "请指定楼层 id。");
  const data = await call(`/api.php/v3areadays/${id}`);
  const items = normalizeDays(data.data);
  return { sectionId: id, days: items };
});
/** areadays 的时段：id 即 segment，时间可能是 PHP 时间对象。 */
const hhmm = value => {
  const text = String(value?.date ?? value ?? "");
  const match = /(\d{1,2}):(\d{2})/.exec(text.slice(11) || text);
  return match ? `${match[1].padStart(2, "0")}:${match[2]}` : "";
};

function normalizeSegments(data) {
  const segments = [];
  for (const item of listOf(data)) {
    if (!item || typeof item !== "object") continue;
    const id = Number(item.id);
    const day = /^\d{4}-\d{2}-\d{2}/.test(String(item.day ?? "")) ? String(item.day).slice(0, 10) : "";
    if (!Number.isFinite(id) || !day) continue;
    const start = hhmm(item.startTime);
    const end = hhmm(item.endTime);
    segments.push({ id, day, start, end, area: Number(item.area ?? 0) || null });
  }
  return segments.sort((a, b) => a.day.localeCompare(b.day) || a.start.localeCompare(b.start));
}

function seatPosition(item) {
  const raw = [item.point_x, item.point_y, item.width, item.height];
  if (raw.some(value => value == null || String(value).trim() === "")) return null;
  const values = raw.map(Number);
  const [x, y, width, height] = values;
  if (!values.every(Number.isFinite) || x < 0 || y < 0 || width <= 0 || height <= 0 || x + width > 100 || y + height > 100) return null;
  return { x, y, width, height };
}

function normalizeSeats(data) {
  const seats = [];
  for (const item of listOf(data)) {
    const id = Number(item?.id);
    if (!Number.isFinite(id)) continue;
    seats.push({
      id,
      name: String(item.name ?? item.no ?? "").trim(),
      area: Number(item.area?.id ?? item.area) || null,
      category: item.category === undefined || item.category === null ? null : String(item.category),
      status: item.status === undefined || item.status === null ? null : Number(item.status),
      available: Number(item.status) === 1,
      statusLabel: typeof item.status_name === "string" ? item.status_name.trim().slice(0, 32) : "",
      position: seatPosition(item),
    });
  }
  return seats.filter(seat => seat.name).sort((a, b) => a.name.localeCompare(b.name, "zh"));
}

const segments = sectionId => withSeatRead(async ({ call }) => {
  const id = Number(sectionId);
  if (!Number.isFinite(id) || id <= 0) throw new SeatError("ARGUMENT_REQUIRED", "请指定区域 id。");
  const data = await call(`/api.php/areadays/${id}`);
  const items = normalizeSegments(data.data);
  if (!items.length) throw new SeatError("SEAT_EMPTY", "该区域没有可选时段。");
  return { sectionId: id, segments: items };
});

/** 座位列表：用区域真实返回的时段参数取，不自造时间。 */
/** 官网时间窗：每日 06:00-23:00（北京时间）可预约。 */
function bookingWindowOpen(now = new Date()) {
  const beijing = new Date(now.getTime() + 8 * 3600_000);
  const hour = beijing.getUTCHours();
  return hour >= 6 && hour < 23;
}

function assertBookingWindow(now = new Date()) {
  if (bookingWindowOpen(now)) return;
  throw new SeatError("SEAT_WINDOW_CLOSED", "系统开放预约时间为 06:00-23:00（北京时间），请在开放时段操作。");
}

/** 场次桶：space_time_buckets 对时段型与整日型分区都适用。 */
function normalizeBuckets(data) {
  const buckets = [];
  for (const item of listOf(data)) {
    const spaceId = Number(item?.spaceId);
    const bookTimeId = Number(item?.bookTimeId ?? item?.id);
    if (!Number.isFinite(spaceId) || !Number.isFinite(bookTimeId)) continue;
    buckets.push({
      spaceId,
      bookTimeId,
      name: String(item.spaceName ?? "").trim(),
      area: Number(item.area ?? 0) || null,
      day: /^\d{4}-\d{2}-\d{2}/.test(String(item.day ?? "")) ? String(item.day).slice(0, 10) : null,
      begin: hhmm(item.beginTime) || hhmm(item.startTime),
      end: hhmm(item.endTime),
      status: item.status === undefined || item.status === null ? null : Number(item.status),
      available: Number(item.status) === 1,
    });
  }
  const seen = new Set();
  return buckets
    .filter(bucket => {
      const key = bucket.spaceId + "@" + bucket.bookTimeId;
      if (seen.has(key)) return false;
      seen.add(key);
      return bucket.name.length > 0;
    })
    .sort((a, b) => a.name.localeCompare(b.name, "zh") || a.begin.localeCompare(b.begin));
}

const CAMPUS_ZONE = "Asia/Shanghai";
const seatDate = instant => instant.toLocaleDateString("sv-SE", { timeZone: CAMPUS_ZONE });

/** 当天的已过去时段不能用于查询当前占用；未来日期仍从官网时段起点查询。 */
function seatQueryWindow(segment, instant = new Date()) {
  if (!segment?.id || !segment.start || !segment.end) return null;
  const today = seatDate(instant);
  if (segment.day < today) return null;
  const now = instant.toLocaleTimeString("en-GB", { timeZone: CAMPUS_ZONE, hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  const start = segment.day === today && now > segment.start ? now : segment.start;
  return start < segment.end ? { start, end: segment.end } : null;
}

/** 从当天全部时段里选出请求的时段；不传 segment 时取第一个可用时段。 */
function chooseSeatSegment(dayList, wanted, segmentId = "", checked = new Date()) {
  const candidates = (dayList || []).filter(item => item.day === wanted)
    .map(segment => ({ segment, window: seatQueryWindow(segment, checked) })).filter(item => item.window);
  if (!candidates.length) throw new SeatError("SEAT_EMPTY", "该区域当天没有剩余的预约时段。");
  const wantedSegment = Number(segmentId);
  const match = segmentId ? candidates.find(item => item.segment.id === wantedSegment) : candidates[0];
  if (!match) throw new SeatError("SEAT_SEGMENT_INVALID", "所选时段已失效，请刷新后重选。");
  return { match, candidates };
}

const seats = (sectionId, date, segmentId = "") => {
  assertBookingWindow(now());
  const id = Number(sectionId);
  if (!Number.isFinite(id) || id <= 0) throw new SeatError("ARGUMENT_REQUIRED", "请指定区域 id。");
  if (date && !/^\d{4}-\d{2}-\d{2}$/.test(String(date))) throw new SeatError("INVALID_ARGUMENTS", "日期须为 YYYY-MM-DD。");
  return withSeatRead(async ({ call }) => {
    const dayList = await call("/api.php/areadays/" + id).then(data => normalizeSegments(data.data));
    const checked = now();
    const wanted = date || seatDate(checked);
    const { match, candidates } = chooseSeatSegment(dayList, wanted, segmentId, checked);
    const { segment, window } = match;
    const query = new URLSearchParams({ area: id, segment: segment.id, day: wanted, startTime: window.start, endTime: window.end });
    const data = await call("/api.php/spaces_old?" + query);
    const list = normalizeSeats(data.data);
    if (!list.length) throw new SeatError("SEAT_EMPTY", "官网没有返回该时段的座位数据。");
    return {
      sectionId: id, date: wanted, segment, queryWindow: window, checkedAt: checked.toISOString(),
      segments: candidates.map(item => ({ id: item.segment.id, start: item.segment.start, end: item.segment.end })),
      seats: list.map(item => ({ ...item, segment: segment.id, begin: window.start, end: window.end })),
      available: list.filter(item => item.available).length,
    };
  });
};

/** 预约结果归一：官方返回 status/message 语义，不擅自判定成功。 */
const RESERVE_CODES = [
  [/已存在预约|不可重复预约/, "SEAT_ALREADY_BOOKED"],
  [/结束预约时间|已过预约时间/, "SEAT_WINDOW_CLOSED"],
  [/已被预约|已被占用|手慢了/, "SEAT_TAKEN"],
  [/时间段不存在/, "SEAT_SEGMENT_INVALID"],
  [/没有登录|登录已超时/, "SEAT_LOGIN_REQUIRED"],
];

/** 把官网文案归类成稳定错误码，界面与工具据此给出可执行提示。 */
function reserveErrorCode(message) {
  const text = String(message ?? "");
  for (const [pattern, code] of RESERVE_CODES) if (pattern.test(text)) return code;
  return null;
}

function normalizeReserve(payload) {
  const status = payload?.status;
  const message = String(payload?.msg ?? payload?.message ?? "").trim();
  const ok = Number(status) === 1 || status === true || status === "1";
  const code = ok ? null : reserveErrorCode(message);
  return {
    ok,
    code,
    status: status === undefined ? null : status,
    message: message || (ok ? "" : "预约未成功"),
    data: payload?.data ?? null,
  };
}

/**
 * 提交预约。参数与站点自身一致：POST /api.php/spaces/<座位>/book
 * 表单字段 access_token / userid / segment / type=1 / operateChannel=2。
 * 只提交一次，不自动重试；失败如实返回。
 */
const reserveOnce = async ({ space, segment, day } = {}) => {
  const spaceId = Number(space);
  const segmentId = Number(segment);
  if (!Number.isFinite(spaceId) || spaceId <= 0) throw new SeatError("ARGUMENT_REQUIRED", "请指定座位 id。");
  if (!Number.isFinite(segmentId) || segmentId <= 0) throw new SeatError("ARGUMENT_REQUIRED", "请指定时段 id。");
  const direct = httpReserve ? await seatHttpSession().catch(() => null) : null;
  if (direct) {
    const body = new URLSearchParams({ access_token: direct.token, userid: direct.userid, segment: String(segmentId), type: "1", operateChannel: "2" }).toString();
    const payload = await direct.post(`/api.php/spaces/${spaceId}/book`, body);
    if (!payload.json) throw new SeatError("SEAT_BAD_RESPONSE", "预约接口返回了非 JSON 响应。");
    if (loggedOut(payload.json.msg)) throw new SeatError("SEAT_LOGIN_REQUIRED", "登录已过期，请重新登录后再预约。");
    return { space: spaceId, segment: segmentId, day: day ?? null, ...normalizeReserve(payload.json) };
  }
  return reserveViaBrowser({ space: spaceId, segment: segmentId, day });
};

const reserveViaBrowser = ({ space, segment, day } = {}) => withSeatSession(async ({ page }) => {
  const spaceId = Number(space);
  const segmentId = Number(segment);
  if (!Number.isFinite(spaceId) || spaceId <= 0) throw new SeatError("ARGUMENT_REQUIRED", "请指定座位 id。");
  if (!Number.isFinite(segmentId) || segmentId <= 0) throw new SeatError("ARGUMENT_REQUIRED", "请指定时段 id。");
  const jar = await page.context().cookies();
  const fromJar = (name) => jar.find(cookie => cookie.name === name)?.value || "";
  const credentials = await page.evaluate(() => {
    const cookie = Object.fromEntries(document.cookie.split(";").map(item => {
      const [key, ...rest] = item.trim().split("=");
      return [key, rest.join("=")];
    }));
    return { token: window.ska?.access_token || cookie.access_token || "", userid: window.ska?.userid || cookie.userid || "" };
  });
  // 页面渲染出来的 ska 令牌与当前会话同步，优先于可能过期的 cookie。
  const token = credentials.token || fromJar("access_token");
  const userid = credentials.userid || fromJar("userid");
  if (!token || !userid) throw new SeatError("SEAT_LOGIN_REQUIRED", "图书馆座位系统需要先登录。");
  const body = new URLSearchParams({ access_token: token, userid, segment: String(segmentId), type: "1", operateChannel: "2" }).toString();
  const payload = await page.evaluate(async ({ url, form }) => {
    const response = await fetch(url, { method: "POST", credentials: "include", headers: { "content-type": "application/x-www-form-urlencoded", "x-requested-with": "XMLHttpRequest" }, body: form });
    const text = await response.text();
    try {
      return { status: response.status, json: JSON.parse(text) };
    } catch {
      return { status: response.status, json: null, text: text.slice(0, 120) };
    }
  }, { url: `/api.php/spaces/${spaceId}/book`, form: body });
  if (!payload.json) throw new SeatError("SEAT_BAD_RESPONSE", "预约接口返回了非 JSON 响应。");
  if (loggedOut(payload.json.msg)) throw new SeatError("SEAT_LOGIN_REQUIRED", "登录已过期，请重新登录后再预约。");
    return { space: spaceId, segment: segmentId, day: day ?? null, ...normalizeReserve(payload.json) };
});

/** 登录态失效时自动用已保存凭据重登，并先核对是否其实已经下单，避免重复预约。 */
const reserve = async (args = {}) => {
  assertBookingWindow(now());
  try {
    return await reserveOnce(args);
  } catch (error) {
    if (error?.code !== "SEAT_LOGIN_REQUIRED") throw error;
    const session = await login();
    if (!session.ok) throw error;
    const target = { space: Number(args?.space) || null, segment: Number(args?.segment) || null, day: /^\d{4}-\d{2}-\d{2}$/.test(String(args?.day ?? "")) ? args.day : null };
    const after = (await bookings()).bookings;
    const exact = after.find(item => matchesReserveTarget(item, target));
    if (exact)
      return { space: target.space, segment: target.segment, day: target.day, ok: true, code: null, status: 1, message: "预约已生效（服务器已创建记录 " + exact.id + "）", bookingId: exact.id, reconciled: true, data: null };
    const sameDay = after.filter(item => target.day ? String(item.end ?? item.start ?? "").startsWith(target.day) : true);
    // 有同日记录但对不上目标：无法证明成功也不能证明失败，不重发，交给用户核对。
    if (sameDay.length)
      return {
        space: target.space, segment: target.segment, day: target.day,
        ok: false, code: "SEAT_RESERVE_UNKNOWN", status: null, reconciled: false, needsReview: true,
        message: `登录已过期并已重登，但当天已有 ${sameDay.length} 笔有效预约且与本目标不一致，无法确认这次是否已创建。请先核对「我的预约」，不要直接重复提交。`,
        data: null,
      };
    return await reserveOnce(args);
  }
};

/** 我的预约列表归一。 */
function normalizeBookings(data) {
  const list = listOf(data);
  return list
    .filter(item => item && typeof item === "object" && item.id !== undefined)
    .map(item => ({
      id: Number(item.id),
      code: item.code ?? item.bookNo ?? null,
      title: String(item.title ?? item.spaceName ?? item.areaName ?? "").trim(),
      status: item.status ?? null,
      // 核对本次预约目标需要座位与时段，缺了它们就无法区分“同一天的另一笔”。
      space: item.space?.id ?? item.spaceId ?? item.space ?? null,
      segment: item.segment?.id ?? item.segmentId ?? item.segment ?? null,
      start: item.startTime?.date ?? item.startTime ?? null,
      end: item.endTime?.date ?? item.endTime ?? null,
    }))
    .filter(item => Number.isFinite(item.id));
}

const bookings = () => withSeatRead(async ({ call }) => {
  const data = await call("/api.php/profile/books/");
  return { bookings: normalizeBookings(data.data) };
});

/** 取消预约：站点用 _method=delete 覆盖 POST。 */
const cancelOnce = async bookingId => {
  const id = Number(bookingId);
  if (!Number.isFinite(id) || id <= 0) throw new SeatError("ARGUMENT_REQUIRED", "请指定预约 id。");
  const direct = httpReserve ? await seatHttpSession().catch(() => null) : null;
  if (direct) {
    const form = new URLSearchParams({ _method: "delete", id: String(id), userid: direct.userid, access_token: direct.token, operateChannel: "2" }).toString();
    const payload = await direct.post(`/api.php/profile/books/${id}`, form);
    if (!payload.json) throw new SeatError("SEAT_BAD_RESPONSE", "取消接口返回了非 JSON 响应。");
    if (loggedOut(payload.json.msg)) throw new SeatError("SEAT_LOGIN_REQUIRED", "登录已过期，请重新登录。");
    return { id, unknown: false, ...normalizeReserve(payload.json) };
  }
  return cancelViaBrowser(id);
};

const cancelViaBrowser = bookingId => withSeatSession(async ({ page }) => {
  const id = Number(bookingId);
  if (!Number.isFinite(id) || id <= 0) throw new SeatError("ARGUMENT_REQUIRED", "请指定预约 id。");
  const jar = await page.context().cookies();
  const jarToken = jar.find(cookie => cookie.name === "access_token")?.value || "";
  const jarUser = jar.find(cookie => cookie.name === "userid")?.value || "";
  const result = await page.evaluate(async ({ target, jarToken, jarUser }) => {
    const cookie = Object.fromEntries(document.cookie.split(";").map(item => {
      const [key, ...rest] = item.trim().split("=");
      return [key, rest.join("=")];
    }));
    const token = window.ska?.access_token || cookie.access_token || jarToken || "";
    const userid = window.ska?.userid || cookie.userid || jarUser || "";
    const body = new URLSearchParams({ _method: "delete", id: String(target), userid, access_token: token, operateChannel: "2" }).toString();
    const response = await fetch(`/api.php/profile/books/${target}`, { method: "POST", credentials: "include", headers: { "content-type": "application/x-www-form-urlencoded", "x-requested-with": "XMLHttpRequest" }, body });
    const json = await response.json().catch(() => null);
    // 非 JSON 响应（网关错误页等）意味着“结果不明”，不是“取消失败”，交给只读核对判断。
    return json ?? { status: -1, msg: "取消接口返回了非 JSON 响应。", unknown: true };
  }, { target: id, jarToken, jarUser });
  if (loggedOut(result.msg)) throw new SeatError("SEAT_LOGIN_REQUIRED", "登录已过期，请重新登录。");
  return { id, unknown: result.unknown === true, ...normalizeReserve(result) };
});

/** 登录态失效时自动重登一次，再重试取消；仍失败则原样抛错。 */
const cancelAttempt = async bookingId => {
  try {
    return await cancelOnce(bookingId);
  } catch (error) {
    if (error?.code !== "SEAT_LOGIN_REQUIRED") throw error;
    const session = await login();
    if (!session.ok) throw error;
    return await cancelOnce(bookingId);
  }
};

/**
 * 取消一条预约：明确拒绝按错误码抛出；传输层结果不明时只读核对一次，绝不重发取消。
 * 这样“没取消掉”和“不知道有没有取消”是两种结果，界面和工具不会把后者当成失败让人重复点。
 */
const cancel = async bookingId => {
  const id = Number(bookingId);
  if (!Number.isFinite(id) || id <= 0) throw new SeatError("ARGUMENT_REQUIRED", "请指定预约 id。");
  try {
    const result = await cancelAttempt(id);
    if (result.ok) return { ...result, cancelled: true };
    const failure = Object.assign(new SeatError(result.code || "SEAT_CANCEL_FAILED", result.message || "取消预约未成功。"), { status: result.status });
    // 结果不明（非 JSON / 网络中断）时必须走下面的只读核对，不能直接当成失败让人重试。
    if (result.unknown) failure.unknown = true;
    throw failure;
  } catch (error) {
    if (error instanceof SeatError && !error.unknown) throw error;
    // 请求可能已经生效：用一次只读查询核对，不把不确定的结果当成可重试的失败。
    const after = await bookings().then(result => result.bookings).catch(() => null);
    if (after === null) throw new SeatError("SEAT_CANCEL_UNKNOWN", "取消请求已发出但没有收到明确结果，请先点“读取预约记录”核对，不要立即重复取消。");
    const record = after.find(item => Number(item.id) === id);
    // status=2 是有效预约；状态缺失/不可解析时按“仍在”保守处理，只有明确是别的状态才算已取消。
    const raw = record?.status;
    const known = raw !== null && raw !== undefined && raw !== "" && Number.isFinite(Number(raw));
    if (record && (!known || Number(raw) === 2)) throw new SeatError("SEAT_CANCEL_FAILED", "取消没有生效，预约仍在。");
    return { id, ok: true, cancelled: true, verified: true, message: record ? "预约已不在有效状态。" : "" };
  }
};
  return {
    withSeatSession,
    credentialsPath,
    seatPageState,
    login,
    normalizeRules,
    rules,
    libraries,
    normalizeSections,
    normalizeChildren,
    floors,
    areas,
    createTtlCache,
    createSeatSections,
    sections,
    days,
    normalizeSegments,
    normalizeSeats,
    segments,
    bookingWindowOpen,
    assertBookingWindow,
    normalizeBuckets,
    seatQueryWindow,
    seats,
    reserveErrorCode,
    normalizeReserve,
    reserve,
    normalizeBookings,
    chooseSeatSegment,
    bookings,
    cancel,
  };
}

/** 生产入口：模块加载时构造一次，行为与拆分前一致。 */
const defaultSeatApi = createSeatApi();
export const {
  withSeatSession,
  credentialsPath,
  seatPageState,
  login,
  normalizeRules,
  rules,
  libraries,
  normalizeSections,
  normalizeChildren,
  floors,
  areas,
  createTtlCache,
  createSeatSections,
  sections,
  days,
  normalizeSegments,
  normalizeSeats,
  segments,
  bookingWindowOpen,
  assertBookingWindow,
  normalizeBuckets,
  seatQueryWindow,
  seats,
  reserveErrorCode,
  normalizeReserve,
  reserve,
  normalizeBookings,
  chooseSeatSegment,
  bookings,
  cancel,
} = defaultSeatApi;
