import { openBrowser } from "@thu-campus/browser";

const BASE = "https://seat.lib.tsinghua.edu.cn";
const HOME = "/home/web/f_second";

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

export const floors = (libraryId, date) => withSeatSession(async ({ call }) => {
  const id = Number(libraryId);
  if (!Number.isFinite(id) || id <= 0) throw new SeatError("ARGUMENT_REQUIRED", "请指定馆区 id。");
  const day = /^\d{4}-\d{2}-\d{2}$/.test(String(date ?? "")) ? date : new Date().toISOString().slice(0, 10);
  const data = await call(`/api.php/areas/${id}/date/${day}`);
  const items = normalizeFloors(data.data);
  if (!items.length) throw new SeatError("SEAT_EMPTY", "该馆区当日没有可用楼层。");
  return { libraryId: id, date: day, floors: items };
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
      area: Number(item.area ?? 0) || null,
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
export const seats = (sectionId, date) => withSeatSession(async ({ call }) => {
  const id = Number(sectionId);
  if (!Number.isFinite(id) || id <= 0) throw new SeatError("ARGUMENT_REQUIRED", "请指定区域 id。");
  const wanted = /^\d{4}-\d{2}-\d{2}$/.test(String(date ?? "")) ? date : "";
  const dayData = await call(`/api.php/areadays/${id}`);
  const all = normalizeSegments(dayData.data);
  const segment = wanted ? all.find(item => item.day === wanted) : all[0];
  if (!segment) throw new SeatError("SEAT_EMPTY", "该区域在指定日期没有时段。");
  const query = `area=${id}&segment=${segment.id}&day=${segment.day}&startTime=${segment.start}&endTime=${segment.end}`;
  const data = await call(`/api.php/spaces_old?${query}`);
  const list = normalizeSeats(data.data);
  return { sectionId: id, segment, seats: list, available: list.filter(seat => seat.available).length };
});
