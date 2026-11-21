import { describe, expect, it } from "vitest";
import { isoDate, orderableText, serviceText, slotText, yuanText } from "../src/format.js";

describe("format", () => {
  it("金额按分转元，整数不带小数", () => {
    expect(yuanText(700)).toBe("￥7");
    expect(yuanText(750)).toBe("￥7.50");
    expect(yuanText(null)).toBe("费用以官方页面为准");
    expect(yuanText(undefined)).toBe("费用以官方页面为准");
  });

  it("时段与可约状态如实表达", () => {
    expect(slotText({ begin: "20:00", end: "21:00" })).toBe("20:00-21:00");
    expect(orderableText({ capacity: 300, reserved: 300 })).toBe("已约满");
    expect(orderableText({ capacity: 300, reserved: 5 })).toBe("可预约");
    expect(orderableText({ capacity: null, reserved: null, status: "N" })).toBe("不可预约");
  });

  it("日期用本地日历日，不因时区跨天", () => {
    expect(isoDate(new Date(2026, 10, 22, 23, 30))).toBe("2026-11-22");
    expect(isoDate(new Date(2026, 0, 1, 0, 5))).toBe("2026-01-01");
  });

  it("服务状态不把未核验说成已登录", () => {
    expect(serviceText({ state: "ready", verified: true })).toBe("已登录");
    expect(serviceText({ state: "unknown", verified: false, code: "UPSTREAM_PROTOCOL" })).toBe("未核验");
    expect(serviceText({ state: "unknown", code: "AUTH_REQUIRED" })).toBe("登录已过期");
    expect(serviceText(null)).toBe("未接入");
    expect(serviceText({ state: "mock" })).toBe("模拟数据");
  });
});