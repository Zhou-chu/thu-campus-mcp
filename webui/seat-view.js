const today = () => new Date().toLocaleDateString("sv-SE", { timeZone: "Asia/Shanghai" });

function drawSeatPlan(seats, makeButton, el, zoom = 1) {
  const positioned = seats.filter(seat => seat.position);
  if (!positioned.length) return null;
  const positions = positioned.map(seat => seat.position);
  const minX = Math.min(...positions.map(p => p.x));
  const minY = Math.min(...positions.map(p => p.y));
  const width = Math.max(...positions.map(p => p.x + p.width)) - minX;
  const height = Math.max(...positions.map(p => p.y + p.height)) - minY;
  // Scale the two axes from the measured seats—not the viewport—so touch targets remain usable.
  const sx = 64 / Math.min(...positions.map(p => p.width));
  const sy = 54 / Math.min(...positions.map(p => p.height));
  const baseWidth = width * sx + 24;
  const baseHeight = height * sy + 24;
  const plan = el("div", { class: "seat-plan", role: "group", "aria-label": "座位分布图" });
  plan.style.width = baseWidth + "px";
  plan.style.height = baseHeight + "px";
  plan.style.transform = "scale(" + zoom + ")";
  plan.style.transformOrigin = "top left";
  for (const seat of positioned) {
    const p = seat.position;
    const button = makeButton(seat, true);
    button.style.left = ((p.x - minX) * sx + 12) + "px";
    button.style.top = ((p.y - minY) * sy + 12) + "px";
    plan.append(button);
  }
  const scaler = el("div", { class: "seat-plan-scaler" }, [plan]);
  scaler.style.width = Math.ceil(baseWidth * zoom) + "px";
  scaler.style.height = Math.ceil(baseHeight * zoom) + "px";
  return el("div", { class: "seat-plan-frame", tabIndex: 0, "aria-label": "可滚动的座位分布图，可用缩放按钮调整比例" }, [scaler]);
}

export function createSeatView({ el, api }) {
  const state = {
    libraries: [], floors: [], areas: [], seats: [],
    library: null, floor: null, area: null, seat: null,
    date: today(), days: [], loading: false, error: "", notice: "", loaded: false, display: "map", queryWindow: null, request: 0, zoom: 1,
  };

  return function seatPage() {
    const wrap = el("div", { class: "stack seat-page" });
    const header = el("div", { class: "page-header" });
    const panel = el("div", { class: "seat-panel" });
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
      const count = state.seats.filter(seat => seat.available === true).length;
      const hasMap = state.seats.some(seat => seat.position);
      const usingMap = hasMap && state.display === "map";
      const selection = el("div", { class: "seat-selection" });
      const display = el("div", { class: "seat-results" });
      function updateSelection() {
        selection.replaceChildren();
        const block = confirmBlock();
        if (block) selection.append(block);
      }
      function pickSeat(seat) {
        if (!seat.available) return;
        state.seat = seat;
        state.notice = "";
        panel.querySelector(".seat-notice")?.remove();
        for (const button of display.querySelectorAll(".seat")) {
          const active = button.dataset.seatId === String(seat.id);
          button.dataset.active = String(active);
          button.setAttribute("aria-pressed", String(active));
        }
        updateSelection();
      }
      const makeButton = (seat, onMap = false) => {
        const status = seat.available ? "可预约" : seat.statusLabel || "不可预约";
        const active = seat.id === state.seat?.id;
        return el("button", {
          class: "seat", type: "button", disabled: !seat.available,
          dataset: { seatId: String(seat.id), open: String(seat.available), active: String(active) },
          "aria-pressed": String(active), "aria-label": seat.name + "，" + status,
          title: seat.name + " · " + status,
          onclick: () => pickSeat(seat),
        }, [el("span", { text: seat.name }), el("span", { class: "seat-status", text: onMap && seat.available ? "可选" : status })]);
      };
      const key = el("div", { class: "seat-key", role: "status" }, [
        el("span", { dataset: { open: "true" }, text: `可预约 ${count}` }),
        el("span", { dataset: { open: "false" }, text: `不可预约 ${state.seats.length - count}` }),
      ]);
      const controlBar = el("div", { class: "seat-result-bar" }, [key]);
      if (state.queryWindow) controlBar.append(el("span", { class: "seat-window", text: state.queryWindow.start + "–" + state.queryWindow.end + "（北京时间）" }));
      if (hasMap) controlBar.append(el("div", { class: "seat-view-switch", role: "group", "aria-label": "座位显示方式" }, [
        ["map", "分布图"], ["list", "列表"],
      ].map(([mode, label]) => el("button", { class: "ghost", type: "button", text: label, "aria-pressed": String(state.display === mode),
        onclick: () => { state.display = mode; render(); panel.querySelector('.seat-view-switch [aria-pressed="true"]')?.focus(); },
      }))));
      if (usingMap) {
        const zoomOut = el("button", { class: "ghost", type: "button", text: "－", "aria-label": "缩小座位图", disabled: state.zoom <= 1,
          onclick: () => { state.zoom = Math.max(1, Math.round((state.zoom - 0.25) * 100) / 100); render(); } });
        const zoomIn = el("button", { class: "ghost", type: "button", text: "＋", "aria-label": "放大座位图", disabled: state.zoom >= 3,
          onclick: () => { state.zoom = Math.min(3, Math.round((state.zoom + 0.25) * 100) / 100); render(); } });
        controlBar.append(el("div", { class: "seat-zoom", role: "group", "aria-label": "座位图缩放" }, [
          zoomOut,
          el("span", { class: "seat-zoom-value", role: "status", text: Math.round(state.zoom * 100) + "%" }),
          zoomIn,
          el("button", { class: "ghost", type: "button", text: "重置", disabled: state.zoom === 1,
            onclick: () => { state.zoom = 1; render(); } }),
        ]));
        display.append(drawSeatPlan(state.seats, makeButton, el, state.zoom));
      }
      const listed = usingMap ? state.seats.filter(seat => !seat.position) : state.seats;
      if (listed.length) {
        if (usingMap) display.append(el("h4", { class: "seat-label", text: "无位置数据的座位" }));
        display.append(el("div", { class: "seat-grid" }, listed.map(seat => makeButton(seat))));
      }
      updateSelection();
      return el("div", { class: "stack seat-results-section" }, [controlBar, selection, display]);
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
        el("h2", { text: "座位预约" }),
        el("div", { class: "seat-actions" }, [
          el("button", { class: "ghost", type: "button", text: state.loading ? "读取中…" : "刷新", disabled: state.loading, onclick: () => { void (state.area ? state.days.length ? loadSeats() : loadSegments() : state.floor ? loadAreas() : state.library ? loadFloors() : loadLibraries()); } }),
        ]),
      );
      const children = [];
      children.push(el("h3", { class: "seat-label", text: "馆区" }));
      children.push(state.libraries.length
        ? chips(state.libraries, state.library, "馆区", item => { state.library = item; void loadFloors(); })
        : el("p", { class: "seat-empty", text: state.loading ? "正在读取馆区…" : state.error || "暂无馆区。" }));
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
            text: item.name,
            selected: state.area !== null && item.id === state.area.id,
          })))
        : el("p", { class: "seat-empty", text: state.floor ? "该楼层没有分区。" : "先选择楼层。" }));
      children.push(el("h3", { class: "seat-label", text: "日期" }));
      const strip = el("div", { class: "seat-dates", role: "group", "aria-label": "日期" });
      const candidates = state.days;
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
      children.push(candidates.length ? strip : el("p", { class: "seat-empty", text: state.area ? "未取得可预约日期。" : "先选择分区。" }));
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

    function beginRead() {
      const request = ++state.request;
      state.loading = true;
      state.seat = null;
      state.error = "";
      state.queryWindow = null;
      state.seats = [];
      return request;
    }

    async function readScoped(path, apply, fallback) {
      const request = beginRead();
      render();
      try {
        const data = await api(path);
        if (request !== state.request) return false;
        apply(data);
        return true;
      } catch (error) {
        if (request !== state.request) return false;
        const hints = {
          SEAT_LOGIN_REQUIRED: "需要先登录图书馆座位系统。",
          SEAT_WINDOW_CLOSED: "系统开放预约时间为06:00-23:00（北京时间）。",
          CAS_CAPTCHA_REQUIRED: "校方登录需要人工验证。",
        };
        state.error = hints[error?.code] ?? (["SEAT_EMPTY", "ACCOUNT_NOT_CONFIGURED"].includes(error?.code) ? error.message : fallback);
        return false;
      } finally {
        if (request === state.request) { state.loading = false; render(); }
      }
    }

    async function loadLibraries() {
      state.loaded = true;
      const ok = await readScoped("/api/seat/libraries", data => {
        state.libraries = (Array.isArray(data.libraries) ? data.libraries : []).filter(item => item.valid !== false);
        state.library = state.libraries.find(item => item.id === 35) ?? state.libraries[0] ?? null;
      }, "暂时读不到馆区。");
      if (ok && state.library) await loadFloors();
    }

    async function loadFloors() {
      Object.assign(state, { floors: [], areas: [], days: [], floor: null, area: null });
      if (!state.library) return;
      const ok = await readScoped("/api/seat/floors?library=" + state.library.id, data => {
        state.floors = (Array.isArray(data.floors) ? data.floors : []).filter(item => item.valid !== false);
        state.floor = state.floors[0] ?? null;
      }, "暂时读不到楼层。");
      if (ok && state.floor) await loadAreas();
    }

    async function loadAreas() {
      Object.assign(state, { areas: [], days: [], area: null });
      if (!state.floor) return;
      const ok = await readScoped("/api/seat/areas?floor=" + state.floor.id, data => {
        state.areas = (Array.isArray(data.areas) ? data.areas : []).filter(item => item.valid !== false && (item.total ?? 1) > 0);
        state.area = state.areas[0] ?? null;
      }, "暂时读不到分区。");
      if (ok && state.area) await loadSegments();
    }

    async function loadSegments() {
      state.days = [];
      if (!state.area) return;
      const ok = await readScoped("/api/seat/segments?section=" + state.area.id, data => {
        const segments = Array.isArray(data.segments) ? data.segments : [];
        state.days = [...new Set(segments.map(item => item.day))].filter(day => day >= today());
        if (state.days.length && !state.days.includes(state.date)) state.date = state.days[0];
      }, "暂时读不到预约日期。");
      if (ok && state.days.length) await loadSeats();
    }

    async function loadSeats() {
      if (!state.area || !state.days.includes(state.date)) return;
      const { id } = state.area;
      const date = state.date;
      await readScoped("/api/seat/seats?" + new URLSearchParams({ section: id, date }), data => {
        if (data.sectionId !== id || data.date !== date) throw new Error("Seat scope mismatch");
        state.seats = Array.isArray(data.seats) ? data.seats : [];
        state.queryWindow = data.queryWindow ?? null;
      }, "暂时读不到座位。");
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