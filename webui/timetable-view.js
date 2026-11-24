import { DAY_LABELS, PERIODS, periodText, todayIndex, weekText, weeklyLayout } from "./timetable-model.js";

const DAY_NAMES = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"];

export function createTimetableView({ el, api }) {
  return function timetablePage() {
    const wrap = el("div", { class: "stack timetable-page" });
    const header = el("div", { class: "timetable-head" });
    const body = el("div", { class: "timetable-body", role: "status" });
    wrap.append(header, body);
    let data = null;
    let error = "";
    let loading = true;
    let mode = "grid"; // grid | detail | add
    let activeSlot = null;

    const drawHeader = () => {
      header.replaceChildren();
      const title = el("div", { class: "stack" }, [
        el("h2", { text: "课表" }),
        el("p", { class: "small muted", text: data?.semester?.name || (data?.state === "ready" ? "当前学期" : "") }),
      ]);
      const actions = el("div", { class: "timetable-actions" });
      if (data?.fetchedAt) actions.append(el("span", { class: "small muted", text: "更新于 " + new Date(data.fetchedAt).toLocaleString("zh-CN", { hour12: false }) }));
      actions.append(el("button", {
        class: "ghost",
        type: "button",
        text: "添加课程",
        onclick: () => { mode = "add"; draw(); },
      }));
      actions.append(el("details", { class: "timetable-legend" }, [
        el("summary", { text: "节次时间" }),
        el("div", { class: "small muted", text: "第一大节 08:00–09:35（第1-2小节）· 第二大节 09:50–12:15（第3-5小节）· 第三大节 13:30–15:05（第6-7小节）· 第四大节 15:20–16:55（第8-9小节）· 第五大节 17:05–18:40（第10-11小节）· 第六大节 19:20–21:45（第12-14小节）" }),
      ]));
      actions.append(el("button", { class: "ghost", type: "button", text: loading ? "读取中…" : "刷新", disabled: loading, onclick: () => { void load(true); } }));
      header.append(title, actions);
    };

    const block = slot => {
      const label = el("button", { class: "course-block", type: "button", dataset: { lane: String(slot.lane), lanes: String(slot.lanes), custom: String(Boolean(slot.course.custom)) } }, [
        el("span", { class: "course-name", text: slot.course.name }),
        el("span", { class: "course-meta", text: [periodText(slot.from, slot.to), slot.sectionLabel, slot.time, slot.location, weekText(slot.weeks)].filter(Boolean).join(" · ") }),
      ]);
      label.style.setProperty("--lane", String(slot.lane));
      label.style.setProperty("--lanes", String(slot.lanes));
      // 点击只切换详情视图，不再把课程块替换掉。
      label.addEventListener("click", () => { activeSlot = slot; mode = "detail"; draw(); });
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
          section.append(el("button", { class: "agenda-item", type: "button", onclick: () => { activeSlot = slot; mode = "detail"; draw(); } }, [
            el("span", { class: "agenda-time", text: [periodText(slot.from, slot.to), slot.time].filter(Boolean).join(" ") }),
            el("span", { class: "agenda-name", text: slot.course.name }),
            el("span", { class: "small muted", text: [slot.location, weekText(slot.weeks)].filter(Boolean).join(" · ") }),
          ]));
        list.append(section);
      });
      return list;
    };

    const detailView = () => {
      const slot = activeSlot;
      if (!slot) { mode = "grid"; return null; }
      const remove = el("button", {
        class: "ghost danger",
        type: "button",
        text: slot.course.custom ? "删除这门自定义课程" : "从课表移除这个时段",
        onclick: async () => {
          remove.disabled = true;
          try {
            if (slot.course.custom) await api(`/api/timetable/custom/${encodeURIComponent(slot.course.id)}`, { method: "DELETE" });
            else await api("/api/timetable/hide", { method: "POST", body: { courseId: slot.course.id, day: slot.day, from: slot.from } });
            mode = "grid";
            activeSlot = null;
            await load(true);
          } catch (e) {
            remove.disabled = false;
            toastError(e.message || "操作失败。");
          }
        },
      });
      return el("div", { class: "timetable-detail" }, [
        el("h2", { text: slot.course.name }),
        el("dl", { class: "ddl-facts" }, [
          el("dt", { text: "教师" }), el("dd", { text: slot.course.teacher || "未知" }),
          el("dt", { text: "时间" }), el("dd", { text: [DAY_LABELS[slot.day - 1], periodText(slot.from, slot.to), slot.sectionLabel, slot.time].filter(Boolean).join(" ") }),
          el("dt", { text: "地点" }), el("dd", { text: slot.location || "未标注" }),
          el("dt", { text: "周次" }), el("dd", { text: weekText(slot.weeks) }),
          slot.course.custom ? el("dt", { text: "来源" }) : null,
          slot.course.custom ? el("dd", { text: "本地添加" }) : null,
        ]),
        el("div", { class: "timetable-actions" }, [
          el("button", { class: "ghost", type: "button", text: "← 返回课表", onclick: () => { mode = "grid"; activeSlot = null; draw(); } }),
          remove,
        ]),
      ]);
    };

    let toastError = message => {
      const node = body.querySelector(".timetable-error");
      if (node) node.textContent = message;
    };

    const addView = () => {
      const status = el("p", { class: "timetable-error", role: "alert" });
      const field = (label, control) => el("label", { class: "field" }, [el("span", { text: label }), control]);
      const name = el("input", { type: "text", maxLength: 60, placeholder: "例如 大学物理" });
      const teacher = el("input", { type: "text", maxLength: 40, placeholder: "可选" });
      const location = el("input", { type: "text", maxLength: 60, placeholder: "例如 六教6A216" });
      const day = el("select", { "aria-label": "星期" }, DAY_NAMES.map((label, index) => el("option", { value: String(index + 1), text: label })));
      const from = el("select", { "aria-label": "开始节次" }, Array.from({ length: PERIODS }, (_, index) => el("option", { value: String(index + 1), text: `第${index + 1}节` })));
      const to = el("select", { "aria-label": "结束节次" }, Array.from({ length: PERIODS }, (_, index) => el("option", { value: String(index + 1), text: `第${index + 1}节` })));
      to.value = "2";
      const sectionOptions = ["沿用大节", ...Array.from({ length: 14 }, (_, index) => `第${index + 1}小节`)];
      const sectionFrom = el("select", { "aria-label": "精确开始小节" }, sectionOptions.map((label, index) => el("option", { value: index === 0 ? "" : String(index), text: label })));
      const sectionTo = el("select", { "aria-label": "精确结束小节" }, sectionOptions.map((label, index) => el("option", { value: index === 0 ? "" : String(index), text: label })));
      const submit = el("button", {
        class: "primary",
        type: "button",
        text: "保存到课表",
        onclick: async () => {
          if (sectionFrom.value && sectionTo.value && Number(sectionFrom.value) > Number(sectionTo.value)) {
            status.textContent = "精确小节结束不能早于开始。";
            return;
          }
          submit.disabled = true;
          try {
            await api("/api/timetable/custom", {
              method: "POST",
              body: {
                name: name.value, teacher: teacher.value, location: location.value, day: Number(day.value),
                ...(sectionFrom.value && sectionTo.value
                  ? { sections: Array.from({ length: Number(sectionTo.value) - Number(sectionFrom.value) + 1 }, (_, index) => Number(sectionFrom.value) + index) }
                  : { from: Number(from.value), to: Number(to.value) }),
              },
            });
            mode = "grid";
            await load(true);
          } catch (e) {
            status.textContent = e.message || "保存失败。";
            submit.disabled = false;
          }
        },
      });
      return el("div", { class: "timetable-detail" }, [
        el("h2", { text: "添加课程" }),
        field("名称", name), field("教师", teacher), field("地点", location),
        field("星期", day), field("开始", from), field("结束", to),
        field("精确到小节（可选）", sectionFrom), field("精确结束小节", sectionTo),
        status,
        el("div", { class: "timetable-actions" }, [
          el("button", { class: "ghost", type: "button", text: "← 返回课表", onclick: () => { mode = "grid"; draw(); } }),
          submit,
        ]),
      ]);
    };

    const draw = () => {
      drawHeader();
      body.replaceChildren();
      if (mode === "detail") {
        const node = detailView();
        if (node) { body.append(node); return; }
      }
      if (mode === "add") { body.append(addView()); return; }
      if (loading && !data) { body.append(el("p", { class: "small muted", text: "正在读取课表…" })); return; }
      if (error) {
        body.append(el("div", { class: "notice error", role: "alert" }, [
          el("p", { text: "课表读取失败：" + error }),
          el("button", { class: "ghost", type: "button", text: "重试", onclick: () => { void load(true); } }),
        ]));
        return;
      }
      if (!data) return;
      if (data.state === "unavailable" && !data.courses.length) {
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
      if (data.state === "unavailable") {
        body.append(el("div", { class: "notice", role: "status" }, [
          el("p", { text: "教务课表读不到：" + (data.error?.message || "网络学堂未登录或接口不可用。") }),
          el("p", { class: "small muted", text: "下面只显示你本地添加的课程。" }),
          el("button", { class: "ghost", type: "button", text: "重新读取", onclick: () => { void load(true); } }),
        ]));
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