import { openBrowser } from "@thu-campus/browser";

const BASE = "https://seat.lib.tsinghua.edu.cn";
const HOME = "/web/seat3?area=3";

export class SeatError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "SeatError";
    this.code = code;
  }
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

const loggedOut = message => /登录|超时|未登录/.test(String(message ?? ""));

/**
 * 打开一次座位页，在同一会话里连续取多个接口，避免每个请求都开浏览器。
 * 所有请求都是同源 GET，带站点 cookie；不提交任何预约。
 */
// 浏览器驱动层需要真实登录会话，按集成测试验证；单元测试覆盖上面的纯函数。
/* c8 ignore start */
export async function withSeatSession(action) {
  let browser;
  try {
    browser = await openBrowser();
  } catch (error) {
    throw new SeatError(error?.code === "BROWSER_BUSY" ? "BROWSER_BUSY" : "SEAT_UNREACHABLE", error?.code === "BROWSER_BUSY" ? "浏览器正被登录窗口占用，先关闭窗口再试。" : "无法启动浏览器读取图书馆座位。");
  }
  const page = await browser.context.newPage();
  try {
    await page.goto(BASE + HOME, { waitUntil: "networkidle", timeout: 45000 });
    const call = async path => {
      const payload = await page.evaluate(async target => {
        const response = await fetch(target, { credentials: "include" });
        const text = await response.text();
        try {
          return { status: response.status, json: JSON.parse(text) };
        } catch {
          return { status: response.status, json: null, text: text.slice(0, 120) };
        }
      }, path);
      const json = payload.json;
      if (!json) throw new SeatError("SEAT_BAD_RESPONSE", "座位系统返回了非 JSON 响应。");
      if (loggedOut(json.msg)) throw new SeatError("SEAT_LOGIN_REQUIRED", "图书馆座位系统需要先登录。");
      if (json.status !== undefined && Number(json.status) !== 0 && Array.isArray(json.data) === false && !json.data && json.status !== 200) {
        throw new SeatError("SEAT_API_ERROR", String(json.msg || "座位系统返回失败。"));
      }
      return json;
    };
    return await action({ call, page });
  } finally {
    await browser.close().catch(() => {});
  }
}

export const libraries = () => withSeatSession(async ({ call }) => {
  const data = await call("/api.php/areas/1/tree/1");
  const items = normalizeLibraries(data.data);
  if (!items.length) throw new SeatError("SEAT_EMPTY", "没有读到任何馆区。");
  return { libraries: items };
});

export function normalizeSections(data) {
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

export const floors = (libraryId, date) => withSeatSession(async ({ call }) => {
  const id = Number(libraryId);
  if (!Number.isFinite(id) || id <= 0) throw new SeatError("ARGUMENT_REQUIRED", "请指定馆区 id。");
  const day = /^\d{4}-\d{2}-\d{2}$/.test(String(date ?? "")) ? date : new Date().toISOString().slice(0, 10);
  const data = await call("/api.php/v3areas/" + id);
  const items = normalizeSections(data.data);
  if (!items.length) throw new SeatError("SEAT_EMPTY", "该馆区没有可用区域。");
  return { libraryId: id, date: day, floors: items };
});

/** 一次会话内批量探测各分区的可约日期，避免逐分区反复登录。 */
export const sections = libraryId => withSeatSession(async ({ call }) => {
  const id = Number(libraryId) || 35;
  const todayIso = new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10);
  const areaData = await call("/api.php/v3areas/" + id);
  const items = normalizeSections(areaData.data);
  const bookable = [];
  for (const item of items) {
    try {
      const data = await call("/api.php/areadays/" + item.id);
      const days = [...new Set(normalizeSegments(data.data).map(seg => seg.day))].filter(day => day >= todayIso);
      if (days.length) bookable.push({ ...item, days: days.sort() });
    } catch {
      // 单个分区不可预约不影响整体列表。
    }
  }
  bookable.sort((a, b) => b.free - a.free || a.name.localeCompare(b.name, "zh"));
  return { libraryId: id, today: todayIso, scanned: items.length, sections: bookable };
});

export const days = sectionId => withSeatSession(async ({ call }) => {
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

export function normalizeSegments(data) {
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

export function normalizeSeats(data) {
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
    });
  }
  return seats.filter(seat => seat.name).sort((a, b) => a.name.localeCompare(b.name, "zh"));
}

export const segments = sectionId => withSeatSession(async ({ call }) => {
  const id = Number(sectionId);
  if (!Number.isFinite(id) || id <= 0) throw new SeatError("ARGUMENT_REQUIRED", "请指定区域 id。");
  const data = await call(`/api.php/areadays/${id}`);
  const items = normalizeSegments(data.data);
  if (!items.length) throw new SeatError("SEAT_EMPTY", "该区域没有可选时段。");
  return { sectionId: id, segments: items };
});

/** 座位列表：用区域真实返回的时段参数取，不自造时间。 */
/** 场次桶：space_time_buckets 对时段型与整日型分区都适用。 */
export function normalizeBuckets(data) {
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

export const seats = (sectionId, date) => withSeatSession(async ({ call }) => {
  const id = Number(sectionId);
  if (!Number.isFinite(id) || id <= 0) throw new SeatError("ARGUMENT_REQUIRED", "请指定区域 id。");
  const wanted = /^\d{4}-\d{2}-\d{2}$/.test(String(date ?? "")) ? date : new Date().toISOString().slice(0, 10);
  // 只有 areadays 返回带 id 的时段才可预约；bookTimeId 不是预约用的 segment。
  const dayList = await call("/api.php/areadays/" + id).then(data => normalizeSegments(data.data));
  const segment = dayList.find(item => item.day === wanted) ?? null;
  if (!segment || !segment.id)
    throw new SeatError("SEAT_EMPTY", "该区域当天不可预约；可预约日期以时段接口返回为准。");
  const query = "area=" + id + "&segment=" + segment.id + "&day=" + wanted + "&startTime=" + (segment.start || "08:00") + "&endTime=" + (segment.end || "22:00");
  const data = await call("/api.php/spaces_old?" + query);
  const list = normalizeSeats(data.data);
  if (!list.length) throw new SeatError("SEAT_EMPTY", "该区域当日没有可预约座位。");
  return {
    sectionId: id,
    date: wanted,
    segment: { id: segment.id, day: segment.day, start: segment.start, end: segment.end },
    seats: list.map(item => ({ ...item, segment: segment.id })),
    available: list.filter(item => item.available).length,
  };
});

/** 预约结果归一：官方返回 status/message 语义，不擅自判定成功。 */
const RESERVE_CODES = [
  [/已存在预约|不可重复预约/, "SEAT_ALREADY_BOOKED"],
  [/结束预约时间|已过预约时间/, "SEAT_WINDOW_CLOSED"],
  [/已被预约|已被占用|手慢了/, "SEAT_TAKEN"],
  [/时间段不存在/, "SEAT_SEGMENT_INVALID"],
  [/没有登录|登录已超时/, "SEAT_LOGIN_REQUIRED"],
];

/** 把官网文案归类成稳定错误码，界面与工具据此给出可执行提示。 */
export function reserveErrorCode(message) {
  const text = String(message ?? "");
  for (const [pattern, code] of RESERVE_CODES) if (pattern.test(text)) return code;
  return null;
}

export function normalizeReserve(payload) {
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
export const reserve = ({ space, segment, day } = {}) => withSeatSession(async ({ call, page }) => {
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
    return { token: cookie.access_token || window.ska?.access_token || "", userid: cookie.userid || window.ska?.userid || "" };
  });
  const token = fromJar("access_token") || credentials.token;
  const userid = fromJar("userid") || credentials.userid;
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

/** 我的预约列表归一。 */
export function normalizeBookings(data) {
  const list = listOf(data);
  return list
    .filter(item => item && typeof item === "object" && item.id !== undefined)
    .map(item => ({
      id: Number(item.id),
      code: item.code ?? item.bookNo ?? null,
      title: String(item.title ?? item.spaceName ?? item.areaName ?? "").trim(),
      status: item.status ?? null,
      start: item.startTime?.date ?? item.startTime ?? null,
      end: item.endTime?.date ?? item.endTime ?? null,
    }))
    .filter(item => Number.isFinite(item.id));
}

export const bookings = () => withSeatSession(async ({ call }) => {
  const data = await call("/api.php/profile/books/");
  return { bookings: normalizeBookings(data.data) };
});

/** 取消预约：站点用 _method=delete 覆盖 POST。 */
export const cancel = bookingId => withSeatSession(async ({ page }) => {
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
    const token = jarToken || cookie.access_token || window.ska?.access_token || "";
    const userid = jarUser || cookie.userid || window.ska?.userid || "";
    const body = new URLSearchParams({ _method: "delete", id: String(target), userid, access_token: token, operateChannel: "2" }).toString();
    const response = await fetch(`/api.php/profile/books/${target}`, { method: "POST", credentials: "include", headers: { "content-type": "application/x-www-form-urlencoded", "x-requested-with": "XMLHttpRequest" }, body });
    const json = await response.json().catch(() => null);
    return json ?? { status: -1, msg: "取消接口返回了非 JSON 响应。" };
  }, { target: id, jarToken, jarUser });
  if (loggedOut(result.msg)) throw new SeatError("SEAT_LOGIN_REQUIRED", "登录已过期，请重新登录。");
  return { id, ...normalizeReserve(result) };
});
/* c8 ignore stop */
