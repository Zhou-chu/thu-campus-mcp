import { DAY_LABELS, PERIODS, periodText, todayIndex, weekText, weeklyLayout } from "./timetable-model.js";

export function createTimetableView({ el, api }) {
  return function timetablePage() {
    const wrap = el("div", { class: "stack timetable-page" });
    const header = el("div", { class: "timetable-head" });
    const body = el("div", { class: "timetable-body", role: "status" });
    wrap.append(header, body);
    let data = null;
    let error = "";
    let loading = true;

    const drawHeader = () => {
      header.replaceChildren();
      const title = el("div", { class: "stack" }, [
        el("h2", { text: "课表" }),
        el("p", { class: "small muted", text: data?.semester?.name || (data?.state === "ready" ? "当前学期" : "") }),
      ]);
      const actions = el("div", { class: "timetable-actions" });
      if (data?.fetchedAt) actions.append(el("span", { class: "small muted", text: "更新于 " + new Date(data.fetchedAt).toLocaleString("zh-CN", { hour12: false }) }));
      const refresh = el("button", { class: "ghost", type: "button", text: loading ? "读取中…" : "刷新", disabled: loading, onclick: () => { void load(true); } });
      actions.append(refresh);
      header.append(title, actions);
    };

    const block = slot => {
      const label = el("button", { class: "course-block", type: "button", dataset: { lane: String(slot.lane), lanes: String(slot.lanes) } }, [
        el("span", { class: "course-name", text: slot.course.name }),
        el("span", { class: "course-meta", text: [periodText(slot.from, slot.to), slot.location, weekText(slot.weeks)].filter(Boolean).join(" · ") }),
      ]);
      label.style.setProperty("--lane", String(slot.lane));
      label.style.setProperty("--lanes", String(slot.lanes));
      label.addEventListener("click", () => {
        const detail = el("p", { class: "course-detail", role: "status", text: [slot.course.name, slot.course.teacher, slot.location, periodText(slot.from, slot.to), weekText(slot.weeks)].filter(Boolean).join(" · ") });
        label.replaceWith(detail);
      });
      return label;
    };

    const grid = courses => {
      const activeDay = todayIndex();
      const node = el("div", { class: "timetable-grid" });
      node.append(el("div", { class: "timetable-corner", "aria-hidden": "true" }));
      DAY_LABELS.forEach((label, index) => node.append(el("div", { class: "timetable-day", dataset: { today: String(index + 1 === activeDay) }, text: label })));
      for (let period = 1; period <= PERIODS; period += 1)
        node.append(el("div", { class: "timetable-period", text: String(period) }));
      const layout = weeklyLayout(courses);
      for (let day = 0; day < 7; day += 1)
        for (let period = 1; period <= PERIODS; period += 1) {
          const cell = el("div", { class: "timetable-cell", dataset: { today: String(day + 1 === activeDay) } });
          cell.style.setProperty("--day", String(day + 2));
          cell.style.setProperty("--period", String(period + 1));
          node.append(cell);
        }
      for (const slots of layout)
        for (const slot of slots) {
          const item = block(slot);
          item.style.setProperty("--day", String(slot.day + 1));
          item.style.setProperty("--from", String(slot.from + 1));
          item.style.setProperty("--span", String(slot.to - slot.from + 1));
          node.append(item);
        }
      return node;
    };

    const agenda = courses => {
      const list = el("div", { class: "timetable-agenda" });
      const layout = weeklyLayout(courses);
      layout.forEach((slots, index) => {
        if (!slots.length) return;
        const section = el("section", { class: "agenda-day" }, [el("h3", { text: DAY_LABELS[index] })]);
        for (const slot of slots)
          section.append(el("button", { class: "agenda-item", type: "button", onclick: () => { void openDetail(slot); } }, [
            el("span", { class: "agenda-time", text: periodText(slot.from, slot.to) }),
            el("span", { class: "agenda-name", text: slot.course.name }),
            el("span", { class: "small muted", text: [slot.location, weekText(slot.weeks)].filter(Boolean).join(" · ") }),
          ]));
        list.append(section);
      });
      return list;
    };

    const openDetail = slot => {
      body.replaceChildren(el("div", { class: "timetable-detail" }, [
        el("h2", { text: slot.course.name }),
        el("dl", { class: "ddl-facts" }, [
          el("dt", { text: "教师" }), el("dd", { text: slot.course.teacher || "未知" }),
          el("dt", { text: "时间" }), el("dd", { text: `${DAY_LABELS[slot.day - 1]} ${periodText(slot.from, slot.to)}` }),
          el("dt", { text: "地点" }), el("dd", { text: slot.location || "未标注" }),
          el("dt", { text: "周次" }), el("dd", { text: weekText(slot.weeks) }),
        ]),
        el("button", { class: "ghost", type: "button", text: "← 返回课表", onclick: () => { draw(); } }),
      ]));
    };

    const draw = () => {
      drawHeader();
      body.replaceChildren();
      if (loading && !data) { body.append(el("p", { class: "small muted", text: "正在读取课表…" })); return; }
      if (error) {
        body.append(el("div", { class: "notice error", role: "alert" }, [
          el("p", { text: "课表读取失败：" + error }),
          el("button", { class: "ghost", type: "button", text: "重试", onclick: () => { void load(true); } }),
        ]));
        return;
      }
      if (!data) return;
      if (data.state === "unavailable") {
        body.append(el("div", { class: "notice error", role: "alert" }, [
          el("p", { text: "暂时读不到课表：" + (data.error?.message || "网络学堂未登录或接口不可用。") }),
          el("p", { class: "small muted", text: "请先在“服务”页核验网络学堂登录状态，再回来刷新。" }),
          el("button", { class: "ghost", type: "button", text: "重新读取", onclick: () => { void load(true); } }),
        ]));
        return;
      }
      if (!data.courses.length) {
        body.append(el("p", { class: "small muted", text: "当前学期的选课表里没有可排进课表的课程。" }));
        return;
      }
      body.append(grid(data.courses), agenda(data.courses));
      if (data.unscheduled) body.append(el("p", { class: "small muted", text: `${data.unscheduled} 门课程没有上课时间地点，未画入课表。` }));
    };

    const load = async force => {
      loading = true; error = "";
      drawHeader();
      try {
        data = await api("/api/timetable" + (force ? "?refresh=1" : ""));
      } catch (e) {
        error = e.message || "请求失败。";
      } finally {
        loading = false;
        draw();
      }
    };

    draw();
    void load(false);
    return wrap;
  };
}