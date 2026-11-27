/**
 * 清华本科作息时间（《学生手册》/《本科生学习指南》口径）。
 *
 * 课表里的“第N节”是**大节**，每天 6 个大节；每个大节包含 2–3 个小节。
 * 数据源只给到大节，因此官方课程只能显示大节时间；自定义课程可以选到小节。
 *
 * 注意两套编号不能混用：`period` 是大节 1–6，`sections` 是小节 1–14。
 * 解析官方课表拿到的是大节号，按 `period` 查时间；用户按小节选课时再折算成大节区间。
 */
export const BIG_PERIODS = Object.freeze([
  { period: 1, sections: [1, 2], start: "08:00", end: "09:35" },
  { period: 2, sections: [3, 4, 5], start: "09:50", end: "12:15" },
  { period: 3, sections: [6, 7], start: "13:30", end: "15:05" },
  { period: 4, sections: [8, 9], start: "15:20", end: "16:55" },
  { period: 5, sections: [10, 11], start: "17:05", end: "18:40" },
  { period: 6, sections: [12, 13, 14], start: "19:20", end: "21:45" },
]);

export const SMALL_SECTIONS = Object.freeze([
  { n: 1, start: "08:00", end: "08:45" }, { n: 2, start: "08:50", end: "09:35" },
  { n: 3, start: "09:50", end: "10:35" }, { n: 4, start: "10:40", end: "11:25" }, { n: 5, start: "11:30", end: "12:15" },
  { n: 6, start: "13:30", end: "14:15" }, { n: 7, start: "14:20", end: "15:05" },
  { n: 8, start: "15:20", end: "16:05" }, { n: 9, start: "16:10", end: "16:55" },
  { n: 10, start: "17:05", end: "17:50" }, { n: 11, start: "17:55", end: "18:40" },
  { n: 12, start: "19:20", end: "20:05" }, { n: 13, start: "20:10", end: "20:55" }, { n: 14, start: "21:00", end: "21:45" },
]);

/** 小节号（1–14）→ 它所属的大节。 */
export function bigPeriodOf(section) {
  const n = Number(section);
  return BIG_PERIODS.find(item => item.sections.includes(n)) || null;
}

/** 大节区间（1–6）→ 显示用时间范围；不在范围内返回空串。 */
export function bigPeriodTime(from, to = from) {
  const start = Number(from);
  const end = Number(to);
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end > 6 || end < start) return "";
  const first = BIG_PERIODS.find(item => item.period === start);
  const last = BIG_PERIODS.find(item => item.period === end);
  if (!first || !last) return "";
  return first.start + "–" + last.end;
}

/** 小节列表 → 排序去重后的大节区间（1–6）、时间与标签。 */
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
    from: startBig.period,
    to: endBig.period,
  };
}