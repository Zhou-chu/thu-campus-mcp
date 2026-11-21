import { available, normalizeDate, reserve, scenes } from "../app/sports.mjs";
import { bookingStatus, closeBooking, prepareBooking, BookingError } from "../app/sports-booking.mjs";

const text = properties => ({ type: "object", properties, additionalProperties: false });

export const sportsTools = [
  {
    name: "sports_scenes",
    description: "列出体育场馆系统里可预约的场景（需要先登录体育站点）。只读。",
    inputSchema: text({}),
    annotations: { readOnlyHint: true },
  },
  {
    name: "sports_available",
    description: "查询某场景某天可预约的场地与时段。参数 scene（场景 uuid）与 date（YYYY-MM-DD）。只读。",
    inputSchema: text({ scene: { type: "string" }, date: { type: "string" } }),
    annotations: { readOnlyHint: true },
  },
  {
    name: "sports_prepare_booking",
    description:
      "打开有头浏览器窗口并把流程推进到「已选好时段、已点预约、已同意规则」，停在人工滑块验证之前；不传 start/end 时只打开该场馆预约页供用户自由选择。人工验证与支付必须由用户本人在窗口完成。",
    inputSchema: text({
      sport: { type: "string" },
      venue: { type: "string" },
      start: { type: "string", description: "HH:mm，可选" },
      end: { type: "string", description: "HH:mm，可选" },
      date: { type: "string" },
    }),
    annotations: { readOnlyHint: false, destructiveHint: true },
  },
  {
    name: "sports_booking_status",
    description: "查看当前预约推进窗口的步骤（select / verification / payment）与场馆时段。只读。",
    inputSchema: text({}),
    annotations: { readOnlyHint: true },
  },
  {
    name: "sports_booking_close",
    description: "关闭预约推进窗口。",
    inputSchema: text({}),
    annotations: { readOnlyHint: false, destructiveHint: false },
  },
  {
    name: "sports_reserve",
    description:
      "预约体育场地：先锁定场地再下单。会真实占用场地并计费，调用前必须取得用户明确同意。若官网要求滑块等人工安全验证，会返回 SPORTS_MANUAL_VERIFICATION 并提示由人工完成。",
    inputSchema: text({
      sceneUuid: { type: "string" },
      siteUuid: { type: "string" },
      siteType: { type: "string" },
      day: { type: "string", description: "YYYY-MM-DD" },
      startTime: { type: "string", description: "HH:mm" },
      endTime: { type: "string", description: "HH:mm" },
      members: { type: "array", items: { type: "string" } },
      formId: { type: "string" },
      deployUuid: { type: "string" },
    }),
    annotations: { readOnlyHint: false, destructiveHint: true },
  },
];

export async function callSportsTool(name, args = {}) {
  if (name === "sports_scenes") return scenes();
  if (name === "sports_available") {
    const sceneUuid = typeof args.scene === "string" ? args.scene : "";
    if (!sceneUuid) throw Object.assign(new Error("请指定场景 uuid。"), { code: "ARGUMENT_REQUIRED" });
    return available({ sceneUuid, date: args.date ? normalizeDate(args.date) : "" });
  }
  if (name === "sports_prepare_booking") {
    return prepareBooking({
      sport: typeof args.sport === "string" ? args.sport : "游泳",
      venue: typeof args.venue === "string" ? args.venue : "陈明游泳馆",
      start: typeof args.start === "string" ? args.start : "",
      end: typeof args.end === "string" ? args.end : "",
      date: typeof args.date === "string" ? args.date : "",
    });
  }
  if (name === "sports_booking_status") return bookingStatus();
  if (name === "sports_booking_close") return closeBooking();
  if (name === "sports_reserve") {
    return reserve({
      sceneUuid: typeof args.sceneUuid === "string" ? args.sceneUuid : "",
      siteUuid: typeof args.siteUuid === "string" ? args.siteUuid : "",
      siteType: typeof args.siteType === "string" ? args.siteType : "",
      day: typeof args.day === "string" ? args.day : "",
      startTime: typeof args.startTime === "string" ? args.startTime : "",
      endTime: typeof args.endTime === "string" ? args.endTime : "",
      members: Array.isArray(args.members) ? args.members : [],
      formId: typeof args.formId === "string" ? args.formId : undefined,
      deployUuid: typeof args.deployUuid === "string" ? args.deployUuid : undefined,
    });
  }
  throw Object.assign(new Error("没有此体育工具。"), { code: "UNKNOWN_TOOL" });
}