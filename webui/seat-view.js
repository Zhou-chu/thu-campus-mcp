const today = () => new Date().toISOString().slice(0, 10);

export function createSeatView({ el, api }) {
  const state = {
    libraries: [], floors: [], segments: [], seats: [], days: [],
    library: null, floor: null, segment: null, seat: null, retry: 0,
    date: today(), loading: false, error: "", notice: "", loaded: false, pending: null,
  };

  return function seatPage() {
    const wrap = el("div", { class: "stack seat-page" });
    const header = el("div", { class: "page-header" });
    const panel = el("div", { class: "seat-panel", role: "status" });
    wrap.append(header, panel);

    const drawHeader = () => {
      header.replaceChildren(
        el("div", { class: "stack" }, [el("p", { class: "eyebrow", text: "图书馆" }), el("h2", { text: "座位预约" })]),
        el("div", { class: "seat-actions" }, [
          el("button", { class: "ghost", type: "button", text: state.loading ? "读取中…" : "刷新", disabled: state.loading, onclick: () => { void loadLibraries(); } }),
        ]),
      );
    };

    const chips = (items, active, label, onPick) => {
      const group = el("div", { class: "seat-chips", role: "group", "aria-label": label });
      for (const item of items) {
        group.append(el("button", {
          class: "seat-chip",
          type: "button",
          dataset: { active: String(active !== null && item.id === active.id) },
          "aria-pressed": String(active !== null && item.id === active.id),
          text: item.name,
          onclick: () => onPick(item),
        }));
      }
      return group;
    };

    const seatGrid = () => {
      if (state.loading) return el("p", { class: "seat-empty", text: "正在读取座位…" });
      if (state.error) return el("p", { class: "seat-empty", text: state.error });

      if (!state.seats.length) return el("p", { class: "seat-empty", text: "该时段没有座位数据。" });
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
          onclick: () => {
            state.seat = seat;
            state.notice = "";
            render();
          },
        }));
      }
      return grid;
    };

    const confirmBlock = () => {
      if (!state.seat) return null;
      const line = `${state.library?.name ?? ""} · ${state.floor?.name ?? ""} · ${state.seat.name} · ${state.date} ${state.seat.begin || ""}-${state.seat.end || ""}`;
      const box = el("div", { class: "seat-confirm" }, [
        el("p", { class: "seat-confirm-line", text: line }),
        el("button", {
          class: "seat-confirm-button",
          type: "button",
          text: state.pending ? "确认预约" : "预约此座位",
          disabled: Boolean(state.pending),
          onclick: () => { void submitReserve(); },
        }),
      ]);
      return box;
    };

    function render() {
      drawHeader();
      const children = [
        el("h3", { class: "seat-label", text: "馆区" }),
        state.libraries.length
          ? chips(state.libraries, state.library, "馆区", item => { state.library = item; void loadFloors(); })
          : el("p", { class: "seat-empty", text: state.loading ? "正在读取…" : state.error || "暂无馆区。" }),
        el("h3", { class: "seat-label", text: "楼层" }),
        state.floors.length
          ? chips(state.floors, state.floor, "楼层", item => { state.floor = item; void loadSegments(); })
          : el("p", { class: "seat-empty", text: state.library ? "该馆区暂无可用楼层。" : "先选择馆区。" }),
        el("h3", { class: "seat-label", text: "日期" }),
        (() => {
          const strip = el("div", { class: "seat-dates", role: "group", "aria-label": "日期" });
          const candidates = state.days.length ? state.days : Array.from({ length: 7 }, (_, index) => new Date(Date.now() + index * 86400000).toISOString().slice(0, 10));
          for (const value of candidates) {
            strip.append(el("button", { class: "seat-chip", type: "button", dataset: { active: String(value === state.date) }, "aria-pressed": String(value === state.date), text: value.slice(5), onclick: () => { state.date = value; state.seat = null; state.notice = ""; void loadSeats(); } }));
          }
          return strip;
        })(),
        el("h3", { class: "seat-label", text: "时段" }),
        state.segments.length
          ? chips(state.segments.map(item => ({ ...item, name: `${item.day} ${item.start}-${item.end}` })), state.segment, "时段", item => { state.segment = item; state.seat = null; void loadSeats(); })
          : el("p", { class: "seat-empty", text: state.floor ? "该楼层按整日预约，无需选择时段。" : "先选择楼层。" }),
        el("h3", { class: "seat-label", text: "座位" }),
        seatGrid(),
      ];
      const block = confirmBlock();
      if (block) children.push(block);
      if (state.notice) children.push(el("p", { class: "seat-notice", text: state.notice }));
      panel.replaceChildren(...children);
    }

    async function loadLibraries() {
      state.loading = true;
      state.error = "";
      render();
      try {
        const data = await api("/api/seat/libraries");
        state.libraries = Array.isArray(data.libraries) ? data.libraries : [];
        if (!state.libraries.length) state.error = "接口没有返回馆区。";
        state.library = state.libraries.find(item => item.id === 35) ?? state.libraries[0] ?? null;
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
      state.segments = [];
      state.seats = [];
      state.floor = null;
      state.segment = null;
      state.seat = null;
      state.error = "";
      render();
      if (!state.library) return;
      try {
        const data = await api(`/api/seat/floors?library=${state.library.id}&date=${state.date}`);
        state.floors = (Array.isArray(data.floors) ? data.floors : []).filter(item => !/已停用|停用区域/.test(item.name));
        state.retry = 0;
        state.date = state.date || new Date().toISOString().slice(0, 10);
        state.floor = state.floors.find(item => (item.free ?? 0) > 0) ?? state.floors[0] ?? null;
      } catch {
        state.error = "暂时读不到楼层。";
      }
      render();
      if (state.floor) await loadSegments();
    }

    async function loadSegments() {
      state.segments = [];
      state.seats = [];
      state.segment = null;
      state.seat = null;
      render();
      if (!state.floor) return;
      try {
        const data = await api(`/api/seat/segments?section=${state.floor.id}`);
        state.segments = Array.isArray(data.segments) ? data.segments : [];
        state.days = [...new Set(state.segments.map(item => item.day))];
        if (state.days.length && !state.days.includes(state.date)) state.date = state.days[0];
        state.segment = state.segments.find(item => item.day === state.date) ?? state.segments[0] ?? null;
      } catch {
        state.error = "暂时读不到时段。";
      }
      render();
      if (state.floor) { await loadSeats(); return; }
      // 该分区没有时段时，有界地尝试下一个候选，而不是卡住。
      if (state.retry < 2 && state.floor) {
        const index = state.floors.findIndex(item => item.id === state.floor.id);
        const next = state.floors[index + 1];
        if (next) {
          state.retry += 1;
          state.floor = next;
          await loadSegments();
        }
      }
    }

    async function loadSeats() {
      if (!state.floor) return;
      state.loading = true;
      state.error = "";
      render();
      try {
        const data = await api(`/api/seat/seats?section=${state.floor.id}&date=${state.segment?.day ?? state.date}`);
        state.seats = Array.isArray(data.seats) ? data.seats : [];
      } catch {
        state.seats = [];
        state.error = "暂时读不到座位。";
      } finally {
        state.loading = false;
        render();
      }
    }

    async function submitReserve() {
      if (!state.seat) return;
      state.pending = "prepare";
      state.notice = "";
      render();
      try {
        const prepared = await api("/api/seat/reserve/prepare", { method: "POST", body: { space: state.seat.id, segment: state.seat.segment, day: state.date } });
        const result = await api("/api/seat/reserve", { method: "POST", body: { space: state.seat.id, segment: state.seat.segment, day: state.date, confirmToken: prepared.token } });
        state.notice = result.ok ? `已提交预约：${state.seat.name} ${state.date} ${state.seat.begin || ""}-${state.seat.end || ""}` : result.message || "预约未成功。";
        if (result.ok) await loadSeats();
      } catch (error) {
        state.notice = error?.code === "SEAT_LOGIN_REQUIRED" ? "登录已过期，请重新登录后再预约。" : error?.message || "预约请求失败。";
      } finally {
        state.pending = null;
        render();
      }
    }

    render();
    if (!state.loaded) void loadLibraries();
    return wrap;
  };
}