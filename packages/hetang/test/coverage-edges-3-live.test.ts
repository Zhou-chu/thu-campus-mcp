import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { connectLesson } from "../src/live.js";
import type { RainClient } from "../src/client.js";
import type { LessonData } from "../src/types.js";

class FakeSocket extends EventTarget {
  static readonly OPEN = 1;
  static instances: FakeSocket[] = [];
  readyState = 0;
  send = vi.fn();
  close = vi.fn(() => {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.dispatchEvent(new Event("close"));
  });
  constructor(readonly url: string) { super(); FakeSocket.instances.push(this); }
  openNow() { this.readyState = FakeSocket.OPEN; this.dispatchEvent(new Event("open")); }
  message(data: unknown) { this.dispatchEvent(Object.assign(new Event("message"), { data })); }
}
const flush = async () => { for (let n = 0; n < 50; n++) await Promise.resolve(); };
let state: LessonData | undefined;
let client: RainClient;
let onEvent: ReturnType<typeof vi.fn>;
const connections: Awaited<ReturnType<typeof connectLesson>>[] = [];
const socket = () => FakeSocket.instances.at(-1)!;
async function connect() {
  const connection = await connectLesson(client, "lesson", onEvent);
  connections.push(connection);
  return connection;
}

beforeEach(() => {
  FakeSocket.instances = [];
  vi.stubGlobal("WebSocket", FakeSocket);
  state = {
    account: "account", lessonId: "lesson", lessonToken: "local-socket-token", presentationId: "deck",
    published: [], resources: [], questions: [{ id: "q", lessonId: "lesson", presentationId: "deck", slideId: "s", type: "single", prompt: "question", options: [{ key: "A", text: "one" }], published: false, answered: false }],
  };
  client = {
    state: vi.fn(async () => state), user: vi.fn(async () => ({ id: "user" })),
    checkAuth: vi.fn(async () => {}), refreshQuestions: vi.fn(async () => ({ items: state?.questions ?? [] })),
    updateState: vi.fn(async (_id, update) => { state = update(state); return state; }),
  } as unknown as RainClient;
  onEvent = vi.fn(async () => {});
});
afterEach(async () => {
  for (const connection of connections.splice(0)) await connection.close();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("live WebSocket lifecycle without a real network", () => {
  it("requires a joined lesson and never creates a socket when its token is absent", async () => {
    state = undefined;
    await expect(connect()).rejects.toMatchObject({ code: "JOIN_REQUIRED" });
    state = { account: "account", lessonId: "lesson", published: [], questions: [], resources: [] };
    await expect(connect()).rejects.toMatchObject({ code: "JOIN_REQUIRED" });
    expect(FakeSocket.instances).toHaveLength(0);
    expect(client.user).not.toHaveBeenCalled();
  });

  it("authenticates before sending the official student hello and exposes real socket state", async () => {
    const connection = await connect();
    expect(connection.open).toBe(false);
    expect(socket().url).toBe("wss://pro.yuketang.cn/wsapp/");
    socket().openNow();
    await flush();
    expect(connection.open).toBe(true);
    expect(socket().send).toHaveBeenCalledWith(JSON.stringify({ op: "hello", role: "student", auth: "local-socket-token", lessonid: "lesson", userid: "user" }));
    expect(client.checkAuth).toHaveBeenCalledOnce();
    await connection.close();
    expect(connection.open).toBe(false);
    expect(onEvent).toHaveBeenCalledWith({ kind: "disconnected", lessonId: "lesson" });
  });

  it("closes an unauthenticated open without sending credentials", async () => {
    await connect();
    vi.mocked(client.checkAuth).mockRejectedValue(new Error("expired"));
    socket().openNow();
    await flush();
    expect(socket().send).not.toHaveBeenCalled();
    expect(socket().close).toHaveBeenCalledOnce();
  });

  it("does not send hello or apply messages after explicit stop", async () => {
    const connection = await connect();
    await connection.close();
    socket().openNow();
    socket().message(JSON.stringify({ op: "unlockproblem", problemId: "q" }));
    await flush();
    expect(socket().send).not.toHaveBeenCalled();
    expect(client.updateState).not.toHaveBeenCalled();
  });

  it("emits connection errors and disconnections as events rather than HTTP polling", async () => {
    await connect();
    socket().dispatchEvent(new Event("error"));
    socket().dispatchEvent(new Event("close"));
    expect(onEvent.mock.calls.map(([e]) => e.kind)).toEqual(["connection-error", "disconnected"]);
    expect(client.refreshQuestions).not.toHaveBeenCalled();
  });
});

describe("live serial event queue and state transitions", () => {
  it("ignores binary frames, malformed JSON, null frames, and missing lesson state", async () => {
    await connect();
    for (const message of [new Uint8Array([1]), "not-json", "null"]) socket().message(message);
    await flush();
    expect(client.updateState).not.toHaveBeenCalled();
    state = undefined;
    socket().message(JSON.stringify({ op: "unlockproblem", problemId: "q" }));
    await flush();
    expect(client.updateState).not.toHaveBeenCalled();
    expect(onEvent).not.toHaveBeenCalled();
  });

  it("serializes messages while an earlier state mutation is blocked", async () => {
    await connect();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const original = client.updateState;
    vi.mocked(client.updateState).mockImplementationOnce(async (...args) => { await gate; return original(...args); });
    socket().message(JSON.stringify({ op: "unlockproblem", problemId: "q", limit: 30 }));
    socket().message(JSON.stringify({ op: "problemanswered", problemId: "q", userId: "user", answer: ["A"] }));
    await flush();
    expect(onEvent).not.toHaveBeenCalled();
    expect(client.updateState).toHaveBeenCalledTimes(1);
    release();
    await flush();
    expect(onEvent.mock.calls.map(([e]) => e.kind)).toEqual(["question-published", "question-answered"]);
    expect(state?.questions[0]).toMatchObject({ published: true, answered: true, answer: ["A"] });
    expect(client.refreshQuestions).toHaveBeenCalledOnce();
  });

  it("refreshes presentation events, survives refresh failure and falls back to the observed state", async () => {
    await connect();
    vi.mocked(client.updateState).mockImplementation(async (_id, update) => { state = update(undefined); return state; });
    vi.mocked(client.refreshQuestions).mockRejectedValue(new Error("synthetic transient refresh failure"));
    socket().message(JSON.stringify({ op: "showpresentation", pres: "new-deck" }));
    await flush();
    expect(state?.presentationId).toBe("new-deck");
    expect(onEvent).toHaveBeenCalledWith(expect.objectContaining({ kind: "presentation", presentationId: "new-deck" }));
    expect(socket().close).not.toHaveBeenCalled();
    socket().message(JSON.stringify({ op: "unknown-event" }));
    await flush();
    expect(onEvent).toHaveBeenCalledTimes(1);
  });

  it("closes on lesson completion after delivering the final event", async () => {
    await connect();
    socket().openNow();
    await flush();
    socket().message(JSON.stringify({ op: "lessonfinished" }));
    await flush();
    expect(state?.finished).toBe(true);
    expect(onEvent.mock.calls.map(([e]) => e.kind)).toEqual(["lesson-ended", "disconnected"]);
    expect(socket().close).toHaveBeenCalledOnce();
  });

  it("stops the session when authentication changes while handling a message", async () => {
    await connect();
    vi.mocked(client.checkAuth).mockRejectedValueOnce(new Error("auth changed"));
    socket().message(JSON.stringify({ op: "unlockproblem", problemId: "q" }));
    await flush();
    expect(onEvent).toHaveBeenCalledWith({ kind: "session-stopped", lessonId: "lesson" });
    expect(client.updateState).not.toHaveBeenCalled();
    socket().message(JSON.stringify({ op: "unlockproblem", problemId: "q" }));
    await flush();
    expect(client.updateState).not.toHaveBeenCalled();
  });

  it("converts event-consumer failure into session-stopped and drains the failed queue on close", async () => {
    const connection = await connect();
    onEvent.mockImplementation(async (event) => { if (event.kind === "question-published") throw new Error("consumer failed"); });
    socket().message(JSON.stringify({ op: "unlockproblem", problemId: "q" }));
    await flush();
    await expect(connection.close()).resolves.toBeUndefined();
    expect(onEvent).toHaveBeenCalledWith({ kind: "session-stopped", lessonId: "lesson" });
  });
});
