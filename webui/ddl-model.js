export const LAYOUT_KEY = "campus.app.sidebar.layout";
export const ARCHIVE_KEY = "campus.app.sidebar.archived";
export const ORDER_KEY = "campus.app.sidebar.order";
export const MIN_WIDTH = 320;
export const MAX_WIDTH = 720;

export function readJson(storage, key, fallback) {
  try {
    const raw = storage?.getItem(key);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : fallback;
  } catch { return fallback; }
}
export function writeJson(storage, key, value) {
  try { storage?.setItem(key, JSON.stringify(value)); return true; } catch { return false; }
}

export function clampWidth(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 380;
  return Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, Math.round(number)));
}

/** 期限文案只陈述事实：剩余多久，或已过期多久；时间未知时明确说未知。 */
export function remaining(deadlineMs, now = Date.now()) {
  if (!Number.isFinite(deadlineMs)) return { text: "期限未知", overdue: false, unknown: true };
  const diff = deadlineMs - now;
  const minutes = Math.round(Math.abs(diff) / 60000);
  const amount = minutes < 60 ? `${minutes} 分钟`
    : minutes < 1440 ? `${Math.round(minutes / 60)} 小时`
    : `${Math.round(minutes / 1440)} 天`;
  return { text: minutes < 1 ? "即将截止" : (diff < 0 ? `已过期 ${amount}` : `剩 ${amount}`), overdue: diff < 0, unknown: false };
}

/** 手工顺序只作用于仍在列表中的条目，其余保持自动排序在后。 */
export function applyOrder(items, order) {
  if (!Array.isArray(order) || !order.length) return items;
  const rank = new Map();
  for (const id of order) if (typeof id === "string" && !rank.has(id)) rank.set(id, rank.size);
  const placed = items.filter(item => rank.has(item.id)).sort((a, b) => rank.get(a.id) - rank.get(b.id));
  const rest = items.filter(item => !rank.has(item.id));
  return [...placed, ...rest];
}

/** 把一个 id 移到目标下标，返回新的 id 顺序；越界时原样返回。 */
export function moveId(order, from, to) {
  const list = [...order];
  if (!Number.isInteger(from) || !Number.isInteger(to)) return list;
  if (from < 0 || from >= list.length || to < 0 || to >= list.length || from === to) return list;
  const [moved] = list.splice(from, 1);
  list.splice(to, 0, moved);
  return list;
}

export function filterArchived(items, archived, showArchived) {
  const hidden = new Set(Array.isArray(archived) ? archived : []);
  const kept = items.filter(item => !hidden.has(item.id));
  const archivedItems = items.filter(item => hidden.has(item.id));
  return { visible: showArchived ? [...kept, ...archivedItems] : kept, hidden: archivedItems.length };
}
export function toggleArchived(archived, id) {
  const list = Array.isArray(archived) ? [...archived] : [];
  const index = list.indexOf(id);
  if (index >= 0) list.splice(index, 1); else list.push(id);
  return list;
}