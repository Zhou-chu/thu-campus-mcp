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
  const state = { sports: [], venues: [], sessions: [], sport: "", venue: "", date: isoDate(new Date()), loading: false, error: "", loaded: false };

  return function sportsPage() {
    const wrap = el("div", { class: "stack sports-page" });
    const header = el("div", { class: "page-header" });
    const panel = el("div", { class: "sports-panel", role: "status" });
    wrap.append(header, panel);

    function drawHeader() {
      header.replaceChildren(
        el("div", { class: "stack" }, [el("p", { class: "eyebrow", text: "清华体育" }), el("h2", { text: "场馆预约" })]),
        el("div", { class: "sports-actions" }, [
          el("button", { class: "ghost", type: "button", text: state.loading ? "读取中…" : "刷新", disabled: state.loading, onclick: () => { void loadSports(); } }),
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
      if (state.error) return el("p", { class: "sports-empty", text: state.error });
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
        list.append(el("div", { class: "sports-slot" }, [
          el("div", { class: "sports-slot-time", text: slot }),
          sites,
          el("div", { class: "sports-slot-meta", text: `${open}/${items.length} 可约 · ${priceText(items[0]?.price)}` }),
        ]));
      }
      return list;
    }

    function render() {
      drawHeader();
      panel.replaceChildren(
        el("h3", { class: "sports-label", text: "运动项目" }),
        state.sports.length ? chipGroup(state.sports, state.sport, item => { state.sport = item; void loadVenues(); }, "运动项目")
          : el("p", { class: "sports-empty", text: state.loading ? "正在读取…" : state.error || "暂无运动项目。" }),
        el("h3", { class: "sports-label", text: "场馆" }),
        state.venues.length ? chipGroup(state.venues, state.venue, item => { state.venue = item; void loadSlots(); }, "场馆")
          : el("p", { class: "sports-empty", text: state.sport ? "该运动暂无场馆。" : "先选一个运动项目。" }),
        el("h3", { class: "sports-label", text: "日期" }),
        dateStrip(),
        el("h3", { class: "sports-label", text: "场次" }),
        sessionList(),
      );
    }

    async function loadSports() {
      state.loading = true;
      state.error = "";
      render();
      try {
        const data = await api("/api/sports/sports");
        state.sports = Array.isArray(data.sports) ? data.sports : [];
        if (!state.sports.length) state.error = "接口没有返回运动项目。";
        state.sport = state.sports.includes(state.sport) ? state.sport : state.sports[0] || "";
      } catch (error) {
        state.sports = [];
        state.error = error?.code === "SPORTS_LOGIN_REQUIRED" ? "需要先登录体育场馆：打开体育窗口完成登录后再回来。" : "暂时读不到运动项目。";
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
      } catch {
        state.error = "暂时读不到该运动的场馆。";
      }
      render();
      if (state.venue) await loadSlots();
    }

    async function loadSlots() {
      if (!state.sport || !state.venue) return;
      state.loading = true;
      state.error = "";
      render();
      try {
        const data = await api(`/api/sports/slots?sport=${encodeURIComponent(state.sport)}&venue=${encodeURIComponent(state.venue)}&date=${state.date}`);
        state.sessions = Array.isArray(data.sessions) ? data.sessions : [];
      } catch {
        state.sessions = [];
        state.error = "暂时读不到场次。";
      } finally {
        state.loading = false;
        render();
      }
    }

    render();
    if (!state.loaded) void loadSports();
    else if (!state.venues.length && state.sport) void loadVenues();
    return wrap;
  };
}
