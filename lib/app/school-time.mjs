/**
 * 清华本科作息时间（《学生手册》/《本科生学习指南》口径）。
 *
 * 课表里的“第N节”是**大节**，每天 6 个大节；每个大节包含 2–3 个小节。
 * 数据源只给到大节，因此官方课程只能显示大节时间；自定义课程可以选到小节。
 */
export const BIG_PERIODS = Object.freeze([
  { from: 1, to: 2, start: "08:00", end: "09:35", sections: [1, 2] },
  { from: 3, to: 5, start: "09:50", end: "12:15", sections: [3, 4, 5] },
  { from: 6, to: 7, start: "13:30", end: "15:05", sections: [6, 7] },
  { from: 8, to: 9, start: "15:20", end: "16:55", sections: [8, 9] },
  { from: 10, to: 11, start: "17:05", end: "18:40", sections: [10, 11] },
  { from: 12, to: 14, start: "19:20", end: "21:45", sections: [12, 13, 14] },
]);

export const SMALL_SECTIONS = Object.freeze([
  { n: 1, start: "08:00", end: "08:45" }, { n: 2, start: "08:50", end: "09:35" },
  { n: 3, start: "09:50", end: "10:35" }, { n: 4, start: "10:40", end: "11:25" }, { n: 5, start: "11:30", end: "12:15" },
  { n: 6, start: "13:30", end: "14:15" }, { n: 7, start: "14:20", end: "15:05" },
  { n: 8, start: "15:20", end: "16:05" }, { n: 9, start: "16:10", end: "16:55" },
  { n: 10, start: "17:05", end: "17:50" }, { n: 11, start: "17:55", end: "18:40" },
  { n: 12, start: "19:20", end: "20:05" }, { n: 13, start: "20:10", end: "20:55" }, { n: 14, start: "21:00", end: "21:45" },
]);

export function bigPeriodOf(section) {
  return BIG_PERIODS.find(item => item.sections.includes(section)) || null;
}

/** 大节区间 → 显示用时间范围；不在范围内返回空串。 */
export function bigPeriodTime(from, to = from) {
  if (!Number.isInteger(from) || !Number.isInteger(to) || from < 1 || to > 14 || to < from) return "";
  const start = BIG_PERIODS.find(item => from >= item.from && from <= item.to);
  const end = BIG_PERIODS.find(item => to >= item.from && to <= item.to);
  if (!start || !end) return "";
  return start.start + "–" + end.end;
}

/** 小节列表 → 排序去重后的大节区间、时间与标签。 */
export function sectionsInfo(sections) {
  const list = [...new Set((sections || []).map(Number).filter(n => Number.isInteger(n) && n >= 1 && n <= 14))].sort((a, b) => a - b);
  if (!list.length) return null;
  const first = SMALL_SECTIONS.find(item => item.n === list[0]);
  const last = SMALL_SECTIONS.find(item => item.n === list[list.length - 1]);
  const startBig = bigPeriodOf(list[0]);
  const endBig = bigPeriodOf(list[list.length - 1]);
  if (!first || !last || !startBig || !endBig) return null;
  return {
    sections: list,
    label: list.length === 1 ? `第${list[0]}小节` : `第${list[0]}-${list[list.length - 1]}小节`,
    time: first.start + "–" + last.end,
    from: startBig.from,
    to: endBig.to,
  };
}