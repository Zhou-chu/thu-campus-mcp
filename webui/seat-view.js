const today = () => new Date().toLocaleDateString("sv-SE");

export function createSeatView({ el, api }) {
  const state = {
    libraries: [], floors: [], areas: [], segments: [], seats: [],
    library: null, floor: null, area: null, seat: null,
    date: today(), days: [], loading: false, error: "", notice: "", loaded: false,
  };

  return function seatPage() {
    const wrap = el("div", { class: "stack seat-page" });
    const header = el("div", { class: "page-header" });
    const panel = el("div", { class: "seat-panel", role: "status" });
    wrap.append(header, panel);

    const chips = (items, active, label, onPick) => {
      const group = el("div", { class: "seat-chips", role: "group", "aria-label": label });
      for (const item of items) {
        const isActive = Boolean(active && item.id === active.id);
        group.append(el("button", {
          class: "seat-chip",
          type: "button",
          dataset: { active: String(isActive) },
          "aria-pressed": String(isActive),
          text: item.name,
          onclick: () => onPick(item),
        }));
      }
      return group;
    };

    const seatGrid = () => {
      if (state.loading) return el("p", { class: "seat-empty", text: "正在读取座位…" });
      if (state.error) {
        const box = el("div", { class: "seat-empty" }, [el("span", { text: state.error })]);
        if (/登录/.test(state.error)) {
          box.append(el("button", { class: "seat-chip", type: "button", text: "打开登录窗口", onclick: () => { void openLogin(); } }));
        }
        return box;
      }
      if (!state.seats.length) return el("p", { class: "seat-empty", text: state.area ? "该分区当前没有可约座位。" : "先选择分区。" });
      const grid = el("div", { class: "seat-grid" });
      for (const seat of state.seats) {
        grid.append(el("button", {
          class: "seat",
          type: "button",
          disabled: !seat.available,
          dataset: { open: String(seat.available), active: String(state.seat !== null && state.seat.id === seat.id) },
          "aria-pressed": String(state.seat !== null && state.seat.id === seat.id),
          title: seat.available ? "可预约" : "不可预约",
          text: seat.name,
          onclick: () => { state.seat = seat; state.notice = ""; render(); },
        }));
      }
      return grid;
    };

    const confirmBlock = () => {
      if (!state.seat) return null;
      const line = [state.library?.name, state.floor?.name, state.area?.name, state.seat.name, state.date, [state.seat.begin, state.seat.end].filter(Boolean).join("-")]
        .filter(Boolean).join(" · ");
      return el("div", { class: "seat-confirm" }, [
        el("p", { class: "seat-confirm-line", text: line }),
        el("button", { class: "seat-confirm-button", type: "button", text: "预约此座位", onclick: () => { void submitReserve(); } }),
      ]);
    };

    function render() {
      header.replaceChildren(
        el("div", { class: "stack" }, [el("p", { class: "eyebrow", text: "图书馆" }), el("h2", { text: "座位预约" })]),
        el("div", { class: "seat-actions" }, [
          el("button", { class: "ghost", type: "button", text: state.loading ? "读取中…" : "刷新", disabled: state.loading, onclick: () => { void loadLibraries(); } }),
        ]),
      );
      const children = [];
      const block = confirmBlock();
      if (block) children.push(block);
      children.push(el("h3", { class: "seat-label", text: "馆区" }));
      children.push(state.libraries.length
        ? chips(state.libraries, state.library, "馆区", item => { state.library = item; void loadFloors(); })
        : el("p", { class: "seat-empty", text: state.loading ? "正在读取馆区（首次需先登录座位系统，约 30 秒）" : state.error || "暂无馆区。" }));
      children.push(el("h3", { class: "seat-label", text: "楼层" }));
      children.push(state.floors.length
        ? chips(state.floors, state.floor, "楼层", item => { state.floor = item; void loadAreas(); })
        : el("p", { class: "seat-empty", text: state.library ? "该馆区没有可读楼层。" : "先选择馆区。" }));
      children.push(el("h3", { class: "seat-label", text: "分区" }));
      children.push(state.areas.length
        ? el("select", {
            class: "seat-select",
            "aria-label": "分区",
            onchange: event => {
              const picked = state.areas.find(item => String(item.id) === event.target.value);
              if (picked) { state.area = picked; void loadSegments(); }
            },
          }, state.areas.map(item => el("option", {
            value: String(item.id),
            text: item.free !== null && item.free !== undefined ? `${item.name}（空位 ${item.free}）` : item.name,
            selected: state.area !== null && item.id === state.area.id,
          })))
        : el("p", { class: "seat-empty", text: state.floor ? "该楼层没有分区。" : "先选择楼层。" }));
      children.push(el("h3", { class: "seat-label", text: "日期" }));
      const strip = el("div", { class: "seat-dates", role: "group", "aria-label": "日期" });
      const candidates = state.days.length ? state.days : Array.from({ length: 7 }, (_, index) => new Date(Date.now() + index * 86400000).toLocaleDateString("sv-SE"));
      for (const value of candidates) {
        strip.append(el("button", {
          class: "seat-chip",
          type: "button",
          dataset: { active: String(value === state.date) },
          "aria-pressed": String(value === state.date),
          text: value.slice(5),
          onclick: () => { state.date = value; state.seat = null; state.notice = ""; void loadSeats(); },
        }));
      }
      children.push(strip);
      children.push(el("h3", { class: "seat-label", text: "座位" }));
      children.push(seatGrid());
      if (state.notice) children.push(el("p", { class: "seat-notice", text: state.notice }));
      panel.replaceChildren(...children);
    }

    async function openLogin() {
      try {
        await api("/api/tools/campus_browser_open", { method: "POST", body: { service: "seat" } });
        state.notice = "已打开登录窗口，登录后回来点刷新。";
      } catch {
        state.notice = "打开登录窗口失败，请稍后重试。";
      }
      render();
    }

    async function loadLibraries() {
      state.loading = true;
      state.error = "";
      render();
      try {
        const data = await api("/api/seat/libraries");
        state.libraries = Array.isArray(data.libraries) ? data.libraries : [];
        const usable = state.libraries.filter(item => item.valid !== false);
  state.library = state.libraries.find(item => item.id === 35) ?? usable[0] ?? state.libraries[0] ?? null;
      } catch (error) {
        state.error = error?.code === "SEAT_LOGIN_REQUIRED" ? "需要先登录图书馆座位系统。" : "暂时读不到馆区。";
      } finally {
        state.loading = false;
        state.loaded = true;
        render();
      }
      if (state.library) await loadFloors();
    }

    async function loadFloors() {
      state.floors = [];
      state.areas = [];
      state.segments = [];
      state.seats = [];
      state.floor = null;
      state.area = null;
      state.seat = null;
      state.error = "";
      render();
      if (!state.library) return;
      try {
        const data = await api(`/api/seat/floors?library=${state.library.id}`);
        state.floors = (Array.isArray(data.floors) ? data.floors : []).filter(item => item.valid !== false);
        state.floor = state.floors[0] ?? null;
      } catch (error) {
        state.error = error?.code === "SEAT_LOGIN_REQUIRED" ? "需要先登录图书馆座位系统。" : "暂时读不到楼层。";
      }
      render();
      if (state.floor) await loadAreas();
    }

    async function loadAreas() {
      state.areas = [];
      state.segments = [];
      state.seats = [];
      state.area = null;
      state.seat = null;
      render();
      if (!state.floor) return;
      try {
        const data = await api(`/api/seat/areas?floor=${state.floor.id}`);
        state.areas = (Array.isArray(data.areas) ? data.areas : []).filter(item => (item.total ?? 1) > 0);
        state.area = state.areas[0] ?? null;
      } catch {
        state.error = "暂时读不到分区。";
      }
      render();
      if (state.area) await loadSegments();
    }

    async function loadSegments() {
      state.segments = [];
      state.days = [];
      state.seats = [];
      state.seat = null;
      state.error = "";
      render();
      if (!state.area) return;
      try {
        const data = await api(`/api/seat/segments?section=${state.area.id}`);
        state.segments = Array.isArray(data.segments) ? data.segments : [];
        state.days = [...new Set(state.segments.map(item => item.day))].filter(day => day >= today());
        if (state.days.length && !state.days.includes(state.date)) state.date = state.days[0];
      } catch (error) {
        state.error = error?.code === "SEAT_LOGIN_REQUIRED" ? "需要先登录图书馆座位系统。" : "";
      }
      render();
      await loadSeats();
    }

    async function loadSeats() {
      if (!state.area) return;
      state.loading = true;
      state.error = "";
      render();
      try {
        const data = await api(`/api/seat/seats?section=${state.area.id}&date=${state.date}`);
        state.seats = Array.isArray(data.seats) ? data.seats : [];
      } catch (error) {
        state.seats = [];
        state.error = error?.code === "SEAT_WINDOW_CLOSED"
          ? "系统开放预约时间为 06:00-23:00（北京时间），请在开放时段操作。"
          : error?.code === "SEAT_EMPTY" ? "该分区当天不可预约。" : "暂时读不到座位。";
      } finally {
        state.loading = false;
        render();
      }
    }

    async function submitReserve() {
      if (!state.seat) return;
      state.notice = "";
      render();
      try {
        const body = { space: state.seat.id, segment: state.seat.segment, day: state.date };
        const prepared = await api("/api/seat/reserve/prepare", { method: "POST", body });
        const result = await api("/api/seat/reserve", { method: "POST", body: { ...body, confirmToken: prepared.token } });
        state.notice = result.ok
          ? `已提交预约：${state.seat.name} ${state.date} ${[state.seat.begin, state.seat.end].filter(Boolean).join("-")}`
          : result.message || "预约未成功。";
        if (result.ok) await loadSeats();
      } catch (error) {
        const hints = {
          SEAT_LOGIN_REQUIRED: "登录已过期，请重新登录后再预约。",
          SEAT_ALREADY_BOOKED: "你在这个时段已有预约，先去「我的预约」取消后再试。",
          SEAT_WINDOW_CLOSED: "当前不在预约时段内（系统 23:00 截止），请在开放时间再试。",
          SEAT_TAKEN: "这个座位刚被占用了，换一个再试。",
          SEAT_SEGMENT_INVALID: "该时段已失效，刷新后重选。",
        };
        state.notice = hints[error?.code] ?? error?.message ?? "预约请求失败。";
      } finally {
        render();
      }
    }

    render();
    if (!state.loaded) void loadLibraries();
    return wrap;
  };
}