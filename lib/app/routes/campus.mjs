/** 图书馆座位与体育场馆路由：只读查询、登录、预约二次确认。 */
import { fail, json } from "./respond.mjs";
import { loginFailure, sendLogin, settleLogin } from "../login-contract.mjs";

const reservationArgs = body => ({
  sceneUuid: typeof body?.sceneUuid === "string" ? body.sceneUuid.trim() : "",
  siteUuid: typeof body?.siteUuid === "string" ? body.siteUuid.trim() : "",
  siteType: typeof body?.siteType === "string" ? body.siteType.trim() : "",
  day: typeof body?.day === "string" ? body.day.trim() : "",
  startTime: typeof body?.startTime === "string" ? body.startTime.trim() : "",
  endTime: typeof body?.endTime === "string" ? body.endTime.trim() : "",
  members: Array.isArray(body?.members) ? body.members.slice(0, 10) : [],
  formId: typeof body?.formId === "string" ? body.formId.trim() : "",
  deployUuid: typeof body?.deployUuid === "string" ? body.deployUuid.trim() : "",
});

const seatArgs = body => ({ space: Number(body?.space) || 0, segment: Number(body?.segment) || 0, day: typeof body?.day === "string" ? body.day.slice(0, 10) : "" });

export function createCampusRoutes({
  seat, sports, confirmations, canonicalJson, readBody,
  loadAccount, seatLogin, sportsLogin, seatReserve, sportsReserve,
  prepareBooking, bookingStatus, closeBooking, SeatError, SportsError, BookingError,
}) {
  return async function handleCampusRoutes(req, res, { pathname, method, url }) {
    if (pathname === "/api/sports/booking/prepare" && method === "POST") {
      const body = await readBody(req, 8192).catch(() => null);
      try {
        const result = await prepareBooking({
          sport: typeof body?.sport === "string" ? body.sport.trim() : "游泳",
          venue: typeof body?.venue === "string" ? body.venue.trim() : "陈明游泳馆",
          start: typeof body?.start === "string" ? body.start.trim() : "",
          end: typeof body?.end === "string" ? body.end.trim() : "",
          date: typeof body?.date === "string" ? body.date.trim() : "",
        });
        return json(res, 200, { ok: true, ...result, status: bookingStatus() });
      } catch (error) {
        if (error instanceof BookingError)
          return json(res, error.code === "ARGUMENT_REQUIRED" ? 400 : error.code === "BOOKING_WINDOW_BUSY" ? 409 : error.code === "BOOKING_UNREACHABLE" ? 503 : 409, { ok: false, error: { code: error.code, message: error.message } });
        throw error;
      }
    }
    if (pathname === "/api/seat/bookings" && method === "GET") {
      try {
        return json(res, 200, { ok: true, ...(await seat.bookings()) });
      } catch (error) {
        if (!(error instanceof SeatError)) throw error;
        return json(res, error.code === "SEAT_LOGIN_REQUIRED" ? 401 : error.code === "BROWSER_BUSY" ? 409 : 503, {
          ok: false, error: { code: error.code, message: error.message },
        });
      }
    }
    if (pathname === "/api/sports/reservations" && method === "GET") {
      try {
        return json(res, 200, { ok: true, ...(await sports.reservations()) });
      } catch (error) {
        if (!(error instanceof SportsError)) throw error;
        return json(res, error.code === "SPORTS_LOGIN_REQUIRED" ? 401 : error.code === "SPORTS_THROTTLED" ? 429 : 503, {
          ok: false, error: { code: error.code, message: error.message },
        });
      }
    }
    if (pathname === "/api/sports/booking/status" && method === "GET")
      return json(res, 200, { ok: true, ...bookingStatus() });
    if (pathname === "/api/sports/booking/close" && method === "POST")
      return json(res, 200, { ok: true, ...(await closeBooking()) });
    if (pathname === "/api/sports/login" && method === "POST") {
      const account = await loadAccount();
      if (!account) return sendLogin(res, json, loginFailure("sports", { code: "ACCOUNT_NOT_CONFIGURED", message: "请先在“服务”页配置清华账号。" }));
      try {
        return sendLogin(res, json, settleLogin("sports", await sportsLogin(account)));
      } catch (error) {
        if (!(error instanceof SportsError) && error?.code !== "BROWSER_BUSY") throw error;
        return sendLogin(res, json, loginFailure("sports", error));
      }
    }
    if (pathname === "/api/seat/login" && method === "POST") {
      try {
        return sendLogin(res, json, settleLogin("seat", await seatLogin()));
      } catch (error) {
        if (!(error instanceof SeatError)) throw error;
        return sendLogin(res, json, loginFailure("seat", error));
      }
    }
    if (pathname === "/api/sports/reserve/prepare" && method === "POST") {
      const args = reservationArgs(await readBody(req, 8192).catch(() => null));
      if (!args.sceneUuid || !args.siteUuid || !args.startTime || !args.endTime)
        return json(res, 400, { ok: false, error: { code: "ARGUMENT_REQUIRED", message: "请指定场地与时段。" } });
      const issued = confirmations.issue("sports-reserve", canonicalJson(args));
      return json(res, 200, { ok: true, ...issued, args });
    }
    if (pathname === "/api/sports/reserve" && method === "POST") {
      const body = await readBody(req, 8192).catch(() => null);
      const args = reservationArgs(body);
      if (!confirmations.consume(body?.confirmToken, "sports-reserve", canonicalJson(args)))
        return json(res, 428, { ok: false, error: { code: "APPROVAL_REQUIRED", message: "预约需要二次确认。" } });
      try {
        const result = await sportsReserve(args);
        return json(res, 200, { ok: true, ...result });
      } catch (error) {
        if (error instanceof SportsError)
          return json(res, error.code === "SPORTS_LOCK_FAILED" ? 409 : 502, { ok: false, error: { code: error.code, message: error.message } });
        throw error;
      }
    }
    if (pathname === "/api/seat/reserve/prepare" && method === "POST") {
      const args = seatArgs(await readBody(req, 4096));
      if (!args.space || !args.segment)
        return json(res, 400, { ok: false, error: { code: "ARGUMENT_REQUIRED", message: "请指定座位与时段。" } });
      const issued = confirmations.issue("seat-reserve", canonicalJson(args));
      return json(res, 200, { ok: true, ...issued, args });
    }
    if (pathname === "/api/seat/reserve" && method === "POST") {
      const body = await readBody(req, 4096);
      const args = seatArgs(body);
      if (!confirmations.consume(body?.confirmToken, "seat-reserve", canonicalJson(args)))
        return json(res, 428, { ok: false, error: { code: "APPROVAL_REQUIRED", message: "预约需要二次确认。" } });
      try {
        const result = await seatReserve(args);
        if (!result.ok)
          return json(res, 409, { ok: false, error: { code: result.code || "SEAT_BOOK_FAILED", message: result.message || "预约未成功。" } });
        return json(res, 200, { ok: true, ...result });
      } catch (error) {
        if (error instanceof SeatError)
          return json(res, error.code === "SEAT_LOGIN_REQUIRED" ? 401 : 502, { ok: false, error: { code: error.code, message: error.message } });
        throw error;
      }
    }
    if (pathname.startsWith("/api/seat/") && method === "GET") {
      const handlers = {
        libraries: () => seat.libraries(),
        floors: () => seat.floors(url.searchParams.get("library")),
        areas: () => seat.areas(url.searchParams.get("floor")),
        rules: () => seat.rules(),
        segments: () => seat.segments(url.searchParams.get("section")),
        days: () => seat.days(url.searchParams.get("section")),
        seats: () => seat.seats(url.searchParams.get("section"), url.searchParams.get("date") || ""),
        sections: () => seat.sections(url.searchParams.get("library")),
      };
      const handler = handlers[pathname.slice("/api/seat/".length)];
      if (handler) {
        try {
          return json(res, 200, { ok: true, ...(await handler()) });
        } catch (error) {
          if (error instanceof SeatError)
            return json(res, error.code === "ARGUMENT_REQUIRED" ? 400 : error.code === "BROWSER_BUSY" || error.code === "SPORTS_MAINTENANCE" ? 503 : 502, { ok: false, error: { code: error.code, message: error.message } });
          throw error;
        }
      }
    }
    if (pathname.startsWith("/api/sports/") && method === "GET") {
      const route = pathname.slice("/api/sports/".length);
      try {
        if (route === "sports")
          return json(res, 200, { ok: true, ...(await sports.list({ refresh: url.searchParams.get("refresh") === "1" })) });
        if (route === "venues")
          return json(res, 200, { ok: true, ...(await sports.venues(url.searchParams.get("sport") || "")) });
        if (route === "scenes")
          return json(res, 200, { ok: true, ...(await sports.scenes()) });
        if (route === "available")
          return json(res, 200, {
            ok: true,
            ...(await sports.available({ sceneUuid: url.searchParams.get("scene") || "", date: url.searchParams.get("date") || "" })),
          });
        if (route === "slots")
          return json(res, 200, {
            ok: true,
            ...(await sports.slots({
              sport: url.searchParams.get("sport") || "",
              venue: url.searchParams.get("venue") || "",
              date: url.searchParams.get("date") || "",
            })),
          });
      } catch (error) {
        if (error instanceof SportsError)
          return json(res, error.code === "SPORT_REQUIRED" || error.code === "ARGUMENT_REQUIRED" ? 400 : error.code === "SPORTS_THROTTLED" ? 429 : error.code === "BROWSER_BUSY" ? 503 : 502, {
            ok: false,
            error: { code: error.code, message: error.message },
          });
        throw error;
      }
    }
    return false;
  };
}