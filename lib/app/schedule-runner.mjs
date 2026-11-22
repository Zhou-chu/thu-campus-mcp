/**
 * 定时任务执行器：每 20 秒检查一次到期任务，为每个任务新建会话并跑一轮对话。
 * 与手动对话共用 runTurn，因此工具、审批、落库行为一致；失败只记录原因，不影响下一轮。
 */
const TICK_MS = 20_000;

export function createScheduleRunner({ store, sessions, runTurn, emit = () => {}, intervalMs = TICK_MS }) {
  let timer = null;
  let running = false;
  const state = { startedAt: null, ticks: 0, lastError: "" };

  async function runTask(task) {
    const session = await sessions.create({ title: `定时：${task.title}`.slice(0, 80) });
    let answered = false;
    let failure = "";
    try {
      const result = await runTurn({
        sessionId: session.id,
        text: task.prompt,
        emit: (event, data) => {
          if (event === "message" && String(data?.content || "").trim()) answered = true;
          if (event === "error") failure = `${data?.code ? data.code + "：" : ""}${data?.message || "模型调用失败"}`;
          emit("schedule", { taskId: task.id, sessionId: session.id, event, data });
        },
        signal: new AbortController().signal,
        approvals: null,
        requireApproval: false,
      });
      // 没有产出任何助手内容就不能算成功：模型报错时 agent 会正常返回。
      if (!answered || result?.aborted) throw new Error(failure || "本轮没有产生回复，请检查模型状态。");
      await store.finish(task.id, { ok: true, sessionId: session.id });
      emit("schedule", { taskId: task.id, sessionId: session.id, event: "done" });
    } catch (error) {
      const reason = `${error?.code ? error.code + "：" : ""}${error?.message || "执行失败"}`;
      await store.finish(task.id, { ok: false, sessionId: session.id, error: reason });
      emit("schedule", { taskId: task.id, sessionId: session.id, event: "error", message: `${error?.code ? error.code + "：" : ""}${error?.message || "执行失败"}` });
    }
  }

  async function tick() {
    if (running) return;
    running = true;
    state.ticks += 1;
    try {
      for (const task of await store.due()) {
        await runTask(task);
      }
      state.lastError = "";
    } catch (error) {
      state.lastError = error?.message || "定时任务检查失败";
    } finally {
      running = false;
    }
  }

  return {
    start() {
      if (timer) return;
      state.startedAt = new Date().toISOString();
      timer = setInterval(() => void tick(), intervalMs);
      timer.unref?.();
      void tick();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
    tick,
    status() {
      return { running: !!timer, intervalMs, ...state };
    },
  };
}