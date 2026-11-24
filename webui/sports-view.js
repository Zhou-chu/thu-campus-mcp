const DAY = 24 * 60 * 60 * 1000;
const WEEKDAYS = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

const isoDate = date => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
const dayNumber = date => `${date.getMonth() + 1}/${date.getDate()}`;
const priceText = price => (typeof price === "number" ? `￥${price}` : "费用以官方页面为准");
const isOrderable = session => session.status !== "N" && !(session.capacity !== null && session.reserved !== null && session.reserved >= session.capacity);
const statusText = session => {
  if (session.status === "N") return session.statusReason || "不可预约";
  if (session.capacity !== null && session.reserved !== null && session.reserved >= session.capacity) return "已约满";
  return "可预约";
};

export function createSportsView({ el, api }) {
  const state = { venuesLoading: false, notice: "", sports: [], venues: [], sessions: [], sport: "", venue: "", date: isoDate(new Date()), loading: false, error: "", loaded: false, loginRequired: false, booking: null, bookingLoading: false, reservations: null, reservationsLoading: false };

  return function sportsPage() {
    const wrap = el("div", { class: "stack sports-page" });
    const header = el("div", { class: "page-header" });
    const panel = el("div", { class: "sports-panel", role: "status" });
    wrap.append(header, panel);

    function drawHeader() {
      header.replaceChildren(
        el("div", { class: "stack" }, [el("p", { class: "eyebrow", text: "清华体育" }), el("h2", { text: "场馆预约" })]),
        el("div", { class: "sports-actions" }, [
          el("button", { class: "ghost", type: "button", text: state.loading ? "读取中…" : "刷新", disabled: state.loading, onclick: () => { void (state.venue ? loadSlots() : state.sport ? loadVenues() : loadSports()); } }),
        ]),
      );
    }

    function dateStrip() {
      const strip = el("div", { class: "sports-dates", role: "tablist", "aria-label": "日期" });
      for (let index = 0; index < 7; index += 1) {
        const date = new Date(Date.now() + index * DAY);
        const value = isoDate(date);
        strip.append(el("button", {
          class: "sports-date", type: "button", role: "tab",
          dataset: { active: String(value === state.date) },
          "aria-selected": String(value === state.date),
          onclick: () => { state.date = value; void loadSlots(); },
        }, [el("span", { class: "sports-date-day", text: WEEKDAYS[date.getDay()] }), el("span", { class: "sports-date-num", text: dayNumber(date) })]));
      }
      return strip;
    }

    function chipGroup(items, active, onPick, label) {
      const group = el("div", { class: "sports-chips", role: "group", "aria-label": label });
      for (const item of items)
        group.append(el("button", { class: "sports-chip", type: "button", dataset: { active: String(item === active) }, "aria-pressed": String(item === active), text: item, onclick: () => onPick(item) }));
      return group;
    }

    function sessionList() {
      if (state.loading) return el("p", { class: "sports-empty", text: "正在读取场次…" });
      if (state.error) {
        const message = el("p", { class: "sports-empty", text: state.error });
        return state.openOfficial ? el("div", { class: "stack" }, [message,
          el("a", { class: "ghost", href: "https://www.sports.tsinghua.edu.cn/venue/mobile/index.html", target: "_blank", rel: "noopener noreferrer", text: "打开体育官网" }),
        ]) : message;
      }
      if (!state.venue) return el("p", { class: "sports-empty", text: "先选一个场馆。" });
      if (!state.sessions.length) return el("p", { class: "sports-empty", text: "该场馆当天没有放出场次。" });
      const list = el("div", { class: "sports-sessions" });
      const groups = new Map();
      for (const session of state.sessions) {
        const key = `${session.begin}-${session.end}`;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(session);
      }
      for (const [slot, items] of [...groups].sort((a, b) => a[0].localeCompare(b[0]))) {
        const sites = el("div", { class: "sports-slot-sites" });
        for (const item of items)
          sites.append(el("span", { class: "sports-site", dataset: { open: String(isOrderable(item)) }, title: `${item.site} · ${statusText(item)} · ${priceText(item.price)}`, text: item.site }));
        const open = items.filter(isOrderable).length;
    const [begin, end] = slot.split("-");
    const prepare = el("button", {
      class: "ghost sports-prepare", type: "button", text: "打开预约窗口",
      title: "自动选好该时段并停在人工验证前",
      onclick: async () => {
        prepare.disabled = true; prepare.textContent = "正在打开…";
        try {
          const result = await api("/api/sports/booking/prepare", { method: "POST", body: { sport: state.sport, venue: state.venue, start: begin, end, date: state.date } });
          state.notice = result.message || "窗口已打开，请在窗口内完成验证与支付。";
        } catch (error) {
          state.error = error?.message || "打开预约窗口失败。";
        } finally {
          prepare.disabled = false; prepare.textContent = "打开预约窗口"; render();
        }
      },
    });
        list.append(el("div", { class: "sports-slot" }, [
          el("div", { class: "sports-slot-time", text: slot }),
          sites,
          el("div", { class: "sports-slot-meta", text: `${open}/${items.length} 可约 · ${priceText(items[0]?.price)}` }),
      prepare,
        ]));
      }
      return list;
    }

    function render() {
      drawHeader();
      panel.replaceChildren(
        el("h3", { class: "sports-label", text: "运动项目" }),
        state.sports.length ? chipGroup(state.sports, state.sport, item => { state.sport = item; void loadVenues(); }, "运动项目")
          : state.loginRequired
            ? el("div", { class: "sports-login-required" }, [
              el("p", { class: "sports-empty", text: state.error }),
              el("button", { class: "sports-login", type: "button", text: "打开体育登录窗口", onclick: () => { void openLogin(); } }),
            ])
            : el("p", { class: "sports-empty", text: state.loading ? "正在读取…" : state.error || "暂无运动项目。" }),
        el("h3", { class: "sports-label", text: "场馆" }),
        state.venues.length ? chipGroup(state.venues, state.venue, item => { state.venue = item; void loadSlots(); }, "场馆")
          : el("p", { class: "sports-empty", text: state.venuesLoading ? "正在读取场馆…" : state.sport ? "该运动暂无场馆，换个运动试试。" : "先选一个运动项目。" }),
        el("h3", { class: "sports-label", text: "日期" }),
        dateStrip(),
        el("h3", { class: "sports-label", text: "场次" }),
    ...(state.notice ? [el("p", { class: "sports-notice", role: "status", text: state.notice })] : []),
        sessionList(),
        bookingStatusCard(),
      );
    }

    function bookingStatusCard() {
      const active = state.booking?.active === true;
      return el("div", { class: "sports-booking-status stack" }, [
        el("div", { class: "sports-result-bar" }, [
          el("h3", { class: "sports-label", text: "我的预约" }),
          el("button", { class: "ghost", type: "button", text: state.bookingLoading ? "读取中…" : "读取预约状态", disabled: state.bookingLoading,
            onclick: () => { void loadBookingStatus(); } }),
        ]),
        active
          ? el("p", { class: "sports-notice", role: "status", text: [state.booking.sport, state.booking.venue, state.booking.start, state.booking.end, "流程进行中"].filter(Boolean).join(" · ") })
          : el("p", { class: "sports-empty", text: state.booking ? "当前没有进行中的预约流程。历史预约请到体育官网「我的预约」查看。" : "读取后显示当前预约流程状态。" }),
        el("button", { class: "ghost", type: "button", text: state.reservationsLoading ? "读取中…" : "读取预约历史", disabled: state.reservationsLoading,
          onclick: () => { void loadReservations(); } }),
        state.reservations === null
          ? el("p", { class: "sports-empty", text: "读取后显示官网返回的预约记录。" })
          : state.reservations.length
            ? el("ul", { class: "sports-reservations" }, state.reservations.map(item => el("li", {
                text: [item.site || "场馆预约", item.start, item.end, item.status].filter(Boolean).join(" · "),
              })))
            : el("p", { class: "sports-empty", text: "官网没有返回预约记录。" }),
        el("a", { class: "ghost", href: "https://www.sports.tsinghua.edu.cn/venue/mobile/index.html", target: "_blank", rel: "noopener noreferrer", text: "打开体育官网" }),
      ]);
    }

    async function loadReservations() {
      state.reservationsLoading = true;
      render();
      try {
        const data = await api("/api/sports/reservations");
        state.reservations = Array.isArray(data.reservations) ? data.reservations : [];
      } catch (error) {
        state.reservations = [];
        state.notice = error?.code === "SPORTS_LOGIN_REQUIRED" ? "体育登录态已失效，请先登录。" : "读取预约历史失败：" + (error?.message || "请稍后重试。");
      } finally {
        state.reservationsLoading = false;
        render();
      }
    }

    async function loadBookingStatus() {
      state.bookingLoading = true;
      render();
      try {
        state.booking = await api("/api/sports/booking/status");
      } catch (error) {
        state.booking = { active: false, error: error?.message || "读取失败" };
        state.notice = "读取预约状态失败：" + (error?.message || "请稍后重试。");
      } finally {
        state.bookingLoading = false;
        render();
      }
    }

    async function loadSports() {
      state.loading = true;
      state.error = "";
  state.notice = "";
      render();
      try {
        const data = await api("/api/sports/sports");
        state.sports = Array.isArray(data.sports) ? data.sports : [];
        if (!state.sports.length) state.error = "接口没有返回运动项目。";
        state.loginRequired = false;
        state.sport = state.sports.includes(state.sport) ? state.sport : state.sports[0] || "";
      } catch (error) {
        state.sports = [];
        state.loginRequired = ["SPORTS_LOGIN_REQUIRED", "CAS_CAPTCHA_REQUIRED"].includes(error?.code);
        state.error = error?.code === "SPORTS_LOGIN_REQUIRED" ? "需要先登录体育场馆：登录完成后回到这里点刷新。"
          : ["CAS_CAPTCHA_REQUIRED", "ACCOUNT_NOT_CONFIGURED", "SPORTS_THROTTLED", "BROWSER_BUSY"].includes(error?.code) ? error.message
          : "暂时读不到运动项目。";
      } finally {
        state.loading = false;
        state.loaded = true;
        render();
      }
      if (state.sport) await loadVenues();
    }

    async function loadVenues() {
      state.venues = [];
      state.sessions = [];
      state.venue = "";
      state.error = "";
      render();
      if (!state.sport) return;
      try {
        const data = await api(`/api/sports/venues?sport=${encodeURIComponent(state.sport)}`);
        state.venues = Array.isArray(data.venues) ? data.venues : [];
        state.venue = state.venues[0] || "";
      } catch (error) {
    state.error = error?.code === "BROWSER_BUSY" ? "浏览器正被其它任务占用，请稍后重试。" : "暂时读不到该运动的场馆。";
      }
      render();
      if (state.venue) await loadSlots();
    }

    async function openLogin() {
      try {
        await api("/api/tools/campus_browser_open", { method: "POST", body: { service: "sports" } });
        state.error = "已请求打开登录窗口，请在运行实例的电脑上完成后刷新。";
      } catch {
        state.error = "打不开登录窗口，稍后再试。";
      }
      render();
    }

    let slotRequest = 0;
    async function loadSlots() {
      if (!state.sport || !state.venue) return;
      const id = ++slotRequest;
      const { sport, venue, date } = state;
      const isCurrent = () => id === slotRequest && state.sport === sport && state.venue === venue && state.date === date;
      state.loading = true;
      state.error = "";
      state.openOfficial = false;
      state.sessions = [];
      render();
      try {
        const data = await api(`/api/sports/slots?sport=${encodeURIComponent(sport)}&venue=${encodeURIComponent(venue)}&date=${date}`);
        if (isCurrent()) state.sessions = Array.isArray(data.sessions) ? data.sessions : [];
      } catch (error) {
        if (!isCurrent()) return;
        const officialErrors = ["SPORTS_SLOTS_UNSUPPORTED", "SLOTS_UNAVAILABLE", "SPORTS_THROTTLED", "SPORTS_DATE_MISMATCH", "SPORTS_MAINTENANCE", "SPORTS_LOGIN_REQUIRED"];
        state.openOfficial = officialErrors.includes(error?.code);
        state.error = state.openOfficial ? error.message : error?.code === "BROWSER_BUSY" ? "浏览器正被其它任务占用，请稍后重试。" : "暂时读不到场次。";
      } finally {
        if (isCurrent()) { state.loading = false; render(); }
      }
    }

    render();
    if (!state.loaded) void loadSports();
    else if (!state.venues.length && state.sport) void loadVenues();
    return wrap;
  };
}
