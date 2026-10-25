import { RainClient } from "./client.js";
import { RainError } from "./types.js";
import { parseJson } from "./protocol.js";
import { applyEvent } from "./classroom.js";
export async function connectLesson(
  client: RainClient,
  lessonId: string,
  onEvent: (e: unknown) => Promise<void>,
) {
  const initial = await client.state(lessonId);
  if (!initial?.lessonToken)
    throw new RainError("JOIN_REQUIRED", "没有可用的课堂会话。");
  const user = await client.user();
  let queue: Promise<unknown> = Promise.resolve(),
    stopped = false;
  const socket = new WebSocket("wss://pro.yuketang.cn/wsapp/");
  socket.addEventListener("open", () => {
    void (async () => {
      await client.checkAuth();
      if (!stopped)
        socket.send(
          JSON.stringify({
            op: "hello",
            role: "student",
            auth: initial.lessonToken,
            lessonid: lessonId,
            userid: user.id,
          }),
        );
    })().catch(() => socket.close());
  });
  socket.addEventListener("message", (event) => {
    queue = queue
      .catch(() => {})
      .then(async () => {
        await client.checkAuth();
        if (stopped) return;
        const state = await client.state(lessonId);
        if (!state) return;
        let message;
        try {
          message =
            typeof event.data === "string" ? parseJson(event.data) : null;
        } catch {
          return;
        }
        if (!message) return;
        let events: ReturnType<typeof applyEvent> = [];
        await client.updateState(lessonId, (current) => {
          const next = current || state;
          events = applyEvent(next, message, Date.now(), user.id);
          return next;
        });
        if (
          events.some(
            (e) => e.kind === "question-published" || e.kind === "presentation",
          )
        ) {
          try {
            await client.refreshQuestions(lessonId);
          } catch {
            /* a later event or explicit question request can refresh */
          }
        }
        for (const item of events) await onEvent(item);
        if (state.finished) socket.close();
      })
      .catch(async () => {
        stopped = true;
        socket.close();
        await onEvent({ kind: "session-stopped", lessonId });
      });
  });
  socket.addEventListener("error", () => {
    void onEvent({ kind: "connection-error", lessonId });
  });
  socket.addEventListener("close", () => {
    void onEvent({ kind: "disconnected", lessonId });
  });
  return {
    close: async () => {
      stopped = true;
      socket.close();
      await queue.catch(() => {});
    },
    get open() {
      return socket.readyState === WebSocket.OPEN;
    },
  };
}
