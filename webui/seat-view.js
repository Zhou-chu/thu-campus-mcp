const today = () => new Date().toLocaleDateString("sv-SE");

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
      if (state.error) {
        const box = el("div", { class: "seat-empty" }, [el("span", { text: state.error })]);
        if (/登录/.test(state.error)) {
          box.append(el("button", { class: "seat-chip", type: "button", text: "打开登录窗口", onclick: () => { void openLogin(); } }));
        }
        return box;
      }

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
        el("h3", { class: "seat-label", text: "区域" }),
        state.floors.length
          ? el("select", { class: "seat-select", "aria-label": "区域", onchange: event => {
              const picked = state.floors.find(item => String(item.id) === event.target.value);
              if (picked) { state.floor = picked; void loadSegments(); }
            } }, state.floors.map(item => el("option", { value: String(item.id), text: item.free !== undefined && item.free !== null ? item.name + "（空位 " + item.free + "）" : item.name, selected: state.floor !== null && item.id === state.floor.id })))
          : el("p", { class: "seat-empty", text: state.library ? state.error || "该馆区暂无可用区域。" : "先选择馆区。" }),
        el("h3", { class: "seat-label", text: "日期" }),
        (() => {
          const strip = el("div", { class: "seat-dates", role: "group", "aria-label": "日期" });
          const candidates = state.days.length ? state.days : Array.from({ length: 7 }, (_, index) => new Date(Date.now() + index * 86400000).toISOString().slice(0, 10));
          for (const value of candidates) {
            strip.append(el("button", { class: "seat-chip", type: "button", dataset: { active: String(value === state.date) }, "aria-pressed": String(value === state.date), text: value.slice(5), onclick: () => { state.date = value; state.seat = null; state.notice = ""; void loadSeats(); } }));
          }
          return strip;
        })(),

        el("h3", { class: "seat-label", text: "座位" }),
        seatGrid(),
      ];
      const block = confirmBlock();
      if (block) children.unshift(block);
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
        const data = await api(`/api/seat/sections?library=${state.library.id}`);
        state.floors = (Array.isArray(data.sections) ? data.sections : []).map(item => ({
          id: item.id,
          name: item.name,
          free: item.free,
          total: item.total,
          days: Array.isArray(item.days) ? item.days : [],
        }));
        const pick = state.floors[0] ?? null;
        state.floor = pick;
        state.days = pick?.days ?? [];
        if (state.days.length && !state.days.includes(state.date)) state.date = state.days[0];
      } catch (error) {
        state.error = error?.code === "SEAT_LOGIN_REQUIRED" ? "需要先登录图书馆座位系统。" : "暂时读不到可预约分区。";
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
        state.days = [...new Set(state.segments.map(item => item.day))].filter(day => day >= today());
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
        const hints = {
          SEAT_LOGIN_REQUIRED: "登录已过期，请重新登录后再预约。",
          SEAT_ALREADY_BOOKED: "你在这个时段已有预约，先去「我的预约」取消后再试。",
          SEAT_WINDOW_CLOSED: "当前不在预约时段内（系统 23:00 截止），请在开放时间再试。",
          SEAT_TAKEN: "这个座位刚被占用了，换一个再试。",
          SEAT_SEGMENT_INVALID: "该时段已失效，刷新后重选。",
        };
        state.notice = hints[error?.code] ?? error?.message ?? "预约请求失败。";
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