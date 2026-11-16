export const DAY_LABELS = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"];
export const PERIODS = 6;

/** 同一格重叠的课程并排显示，而不是互相盖住。 */
export function assignLanes(slots) {
  const sorted = [...slots].sort((a, b) => a.from - b.from || a.to - b.to);
  const ends = [];
  for (const slot of sorted) {
    const lane = ends.findIndex(end => end < slot.from);
    if (lane === -1) { ends.push(slot.to); slot.lane = ends.length - 1; }
    else { ends[lane] = slot.to; slot.lane = lane; }
  }
  return { slots: sorted, lanes: ends.length };
}

export function weeklyLayout(courses) {
  const days = Array.from({ length: 7 }, () => []);
  for (const course of Array.isArray(courses) ? courses : [])
    for (const slot of course.slots || []) {
      const day = days[slot.day - 1];
      if (day) day.push({ ...slot, course });
    }
  return days.map(slots => {
    const placed = assignLanes(slots);
    return placed.slots.map(slot => ({ ...slot, lanes: placed.lanes }));
  });
}

export function weekText(weeks) {
  if (!weeks) return "全周";
  if (!weeks.ranges.length) return weeks.odd ? "单周" : "双周";
  const ranges = weeks.ranges.map(([from, to]) => (from === to ? `${from}` : `${from}-${to}`)).join("、");
  return `第${ranges}周${weeks.odd ? "（单周）" : weeks.even ? "（双周）" : ""}`;
}

export function periodText(from, to) {
  return from === to ? `第${from}节` : `第${from}-${to}节`;
}

export function todayIndex(now = new Date()) {
  const day = now.getDay();
  return day === 0 ? 7 : day;
}