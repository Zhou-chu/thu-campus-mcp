export const CHAT_WIDTH_KEY = 'campus.app.chatWidth';

const DEFAULT_WIDTH = 1440;
const MAX_PREFERENCE = 16384;
const numericText = /^[+\-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+\-]?\d+)?$/i;
const finite = value => typeof value === 'number' && Number.isFinite(value);
const validWidth = value => finite(value) && value > 0
  && value <= MAX_PREFERENCE && Math.round(value) > 0;

function bounds(available) {
  const max = finite(available) && available >= 0 ? Math.floor(available) : 0;
  return { min: Math.min(640, max), max };
}

function clamp(value, { min, max }) {
  return Math.min(max, Math.max(min, value));
}

/** Storage is injected; importing and using this model never accesses the DOM. */
export function createChatWidth(storage) {
  let preferred = null;
  let error = null;
  try {
    const raw = storage.getItem(CHAT_WIDTH_KEY);
    if (typeof raw === 'string' && numericText.test(raw.trim())) {
      const value = Number(raw.trim());
      if (validWidth(value)) preferred = Math.round(value);
    }
  } catch {
    error = '读取会话宽度失败';
  }

  function persist() {
    try {
      if (preferred === null) storage.removeItem(CHAT_WIDTH_KEY);
      else storage.setItem(CHAT_WIDTH_KEY, String(preferred));
      error = null;
      return true;
    } catch {
      error = '保存会话宽度失败';
      return false;
    }
  }

  return {
    snapshot(available) {
      const limits = bounds(available);
      return {
        preferred,
        automatic: preferred === null,
        value: clamp(preferred ?? DEFAULT_WIDTH, limits),
        ...limits,
        error,
      };
    },
    set(value, save = true) {
      if (value !== null && !validWidth(value)) return false;
      preferred = value === null ? null : Math.round(value);
      if (save) persist();
      return true;
    },
    persist,
  };
}

/** A centered panel changes width by twice the grip's pointer displacement. */
export function dragChatWidth(start, delta, edge, available) {
  const initial = finite(start) ? start : DEFAULT_WIDTH;
  const movement = finite(delta) ? delta : 0;
  const direction = edge === 'right' ? 1 : edge === 'left' ? -1 : 0;
  return clamp(initial + direction * 2 * movement, bounds(available));
}

export function keyChatWidth(current, key, edge, available, shift = false) {
  if (edge !== 'left' && edge !== 'right') return undefined;
  const limits = bounds(available);
  if (key === 'Home') return limits.min;
  if (key === 'End') return limits.max;
  if (key === 'Enter' || key === ' ') return null;
  if (key !== 'ArrowLeft' && key !== 'ArrowRight') return undefined;
  const direction = (key === 'ArrowRight' ? 1 : -1) * (edge === 'right' ? 1 : -1);
  const initial = finite(current) ? current : DEFAULT_WIDTH;
  return clamp(initial + direction * (shift === true ? 128 : 32), limits);
}
