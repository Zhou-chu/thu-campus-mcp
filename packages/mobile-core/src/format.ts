/** 展示层格式化：与 webui 的规则一致（金额单位是分，日期用本地日历日）。 */

export const yuanText = (cents: number | null | undefined): string =>
  typeof cents === "number" && Number.isFinite(cents) ? `￥${(cents / 100).toFixed(cents % 100 === 0 ? 0 : 2)}` : "费用以官方页面为准";

export const slotText = (session: { begin: string; end: string }): string => `${session.begin}-${session.end}`;

export const orderableText = (session: { capacity: number | null; reserved: number | null; status?: string }): string => {
  if (session.status === "N") return "不可预约";
  if (typeof session.capacity === "number" && typeof session.reserved === "number" && session.reserved >= session.capacity) return "已约满";
  return "可预约";
};

export const isoDate = (date: Date): string =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;

export const serviceText = (status: { state?: string; verified?: boolean; code?: string } | null | undefined): string => {
  if (!status) return "未接入";
  if (status.state === "ready" && status.verified) return "已登录";
  if (status.state === "expired" || status.code === "AUTH_REQUIRED" || status.code === "AUTH_EXPIRED") return "登录已过期";
  if (status.state === "unavailable") return "暂时不可用";
  if (status.state === "unknown") return "未核验";
  return status.state === "mock" ? "模拟数据" : "未知状态";
};