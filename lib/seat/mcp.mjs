import { bookings, cancel, floors, libraries, reserve, seats, segments } from "../app/seat.mjs";

const text = props => ({ type: "object", properties: props, additionalProperties: false });

export const seatTools = [
  {
    name: "seat_libraries",
    description: "列出图书馆座位系统的馆区与楼层归属。只读，不预约。",
    inputSchema: text({}),
    annotations: { readOnlyHint: true },
  },
  {
    name: "seat_floors",
    description: "查看某馆区某天的楼层与空位统计。参数 library 为馆区 id，date 为 YYYY-MM-DD。",
    inputSchema: text({ library: { type: "string" }, date: { type: "string" } }),
    annotations: { readOnlyHint: true },
  },
  {
    name: "seat_segments",
    description: "查看某楼层可预约的时段（含 segment id 与起止时间）。参数 section 为楼层 id。",
    inputSchema: text({ section: { type: "string" } }),
    annotations: { readOnlyHint: true },
  },
  {
    name: "seat_seats",
    description: "查看某楼层某天的座位与可用状态。参数 section 为楼层 id，date 为 YYYY-MM-DD。",
    inputSchema: text({ section: { type: "string" }, date: { type: "string" } }),
    annotations: { readOnlyHint: true },
  },
  {
    name: "seat_bookings",
    description: "查看我的图书馆座位预约记录。只读。",
    inputSchema: text({}),
    annotations: { readOnlyHint: true },
  },
  {
    name: "seat_reserve",
    description:
      "预约图书馆座位。必须先 seat_seats 拿到座位 id 与时段 id；这一步会真实占用座位。参数 space 为座位 id，segment 为时段 id，day 为 YYYY-MM-DD。",
    inputSchema: text({ space: { type: "string" }, segment: { type: "string" }, day: { type: "string" } }),
    annotations: { readOnlyHint: false, destructiveHint: true },
  },
  {
    name: "seat_cancel",
    description: "取消一条图书馆座位预约。参数 id 来自 seat_bookings。id 必填。",
    inputSchema: text({ id: { type: "string" } }),
    annotations: { readOnlyHint: false, destructiveHint: true },
  },
];

export async function callSeatTool(name, args = {}) {
  switch (name) {
    case "seat_libraries":
      return libraries();
    case "seat_floors":
      return floors(args.library, args.date);
    case "seat_segments":
      return segments(args.section);
    case "seat_seats":
      return seats(args.section, args.date);
    case "seat_bookings":
      return bookings();
    case "seat_reserve":
      return reserve({ space: args.space, segment: args.segment, day: args.day });
    case "seat_cancel":
      return cancel(args.id);
    default:
      throw new Error("未知的图书馆工具：" + name);
  }
}