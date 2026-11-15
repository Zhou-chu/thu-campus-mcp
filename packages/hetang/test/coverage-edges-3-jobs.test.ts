import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getJob, runJob, stableId, startJob, startMonitor, stopJob, waitEvents, type Job } from "../src/jobs.js";
import { atomicJson, readJson } from "../src/storage.js";
import { loadConfig, type Config } from "../src/config.js";
import { RainError } from "../src/types.js";

const boundary = vi.hoisted(() => ({
  client: undefined as any, spawn: vi.fn(), resource: vi.fn(), prepared: vi.fn(), connect: vi.fn(), join: vi.fn(),
}));
vi.mock("node:child_process", async (original) => ({ ...await original<typeof import("node:child_process")>(), spawn: boundary.spawn }));
vi.mock("../src/factory.js", () => ({ makeClient: vi.fn(async () => boundary.client) }));
vi.mock("../src/resources.js", async (original) => ({ ...await original<typeof import("../src/resources.js")>(), runResourceJob: boundary.resource }));
vi.mock("../src/prepared.js", () => ({ runPreparedAnswer: boundary.prepared }));
vi.mock("../src/live.js", () => ({ connectLesson: boundary.connect }));
vi.mock("../src/classroom.js", async (original) => ({ ...await original<typeof import("../src/classroom.js")>(), joinOnce: boundary.join }));

const QA_ROOT = fileURLToPath(new URL("../../../.local/qa-temp/", import.meta.url));
const ID = "11111111-2222-4333-8444-555555555555";
let root: string;
let cfg: Config;
let child: EventEmitter & { unref: ReturnType<typeof vi.fn> };
const record = (changes: Partial<Job> = {}): Job => ({
  id: ID, kind: "download", accountId: "account", generation: "generation", options: {},
  status: "queued", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  events: [], cursor: 0, ...changes,
});
const jobPath = () => path.join(root, "jobs", ID + ".json");
const save = (changes: Partial<Job> = {}) => atomicJson(jobPath(), record(changes));

beforeEach(async () => {
  vi.clearAllMocks();
  await mkdir(QA_ROOT, { recursive: true });
  root = await mkdtemp(path.join(QA_ROOT, "hetang-jobs-edges-"));
  for (const key of ["TEMP", "TMP", "TMPDIR"]) vi.stubEnv(key, QA_ROOT);
  cfg = loadConfig({ stateDir: root, outputDir: path.join(root, "out"), mock: false });
  boundary.client = {
    identity: "account", checkAuth: vi.fn(async () => {}), generation: vi.fn(async () => "generation"),
    active: vi.fn(async () => []), state: vi.fn(async () => undefined),
  };
  child = Object.assign(new EventEmitter(), { unref: vi.fn() });
  boundary.spawn.mockReturnValue(child);
  boundary.resource.mockResolvedValue({ status: "complete" });
  boundary.prepared.mockResolvedValue({ status: "complete", result: { phase: "complete" } });
  boundary.connect.mockResolvedValue({ open: true, close: vi.fn(async () => {}) });
  boundary.join.mockResolvedValue({ id: ID, status: "complete" });
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  expect(path.dirname(root)).toBe(path.resolve(QA_ROOT));
  expect(path.basename(root)).toMatch(/^hetang-jobs-edges-/);
  await rm(root, { recursive: true, force: true });
});

describe("real startJob reservation and process boundary", () => {
  it.each([
    [{ accountId: "other", generation: "generation" }],
    [{ accountId: "account", generation: "other" }],
  ])("rejects a changed auth lease before creating a record", async (lease) => {
    await expect(startJob(cfg, "download", {}, lease)).rejects.toMatchObject({ code: "AUTH_CHANGED" });
    expect(boundary.spawn).not.toHaveBeenCalled();
    expect(await readJson(jobPath())).toBeUndefined();
  });

  it("creates the worker with ignored stdio and explicit config, never actually spawning it", async () => {
    const result = await startJob(cfg, "download", { lessonIds: ["l"] }, { accountId: "account", generation: "generation" }, ID);
    expect(result).toEqual({ id: ID, status: "queued" });
    expect(await readJson(jobPath())).toMatchObject({ id: ID, accountId: "account", generation: "generation", options: { lessonIds: ["l"] } });
    expect(boundary.spawn).toHaveBeenCalledWith(process.execPath, expect.arrayContaining(["worker", ID]), expect.objectContaining({
      detached: true, stdio: "ignore", env: expect.objectContaining({ HETANG_MOCK: "0", HETANG_STATE_DIR: root }),
    }));
    expect(child.unref).toHaveBeenCalledOnce();
  });

  it("uses a generated ID and propagates mock mode only in the child environment", async () => {
    const result = await startJob({ ...cfg, mock: true }, "archive", {});
    expect(result.id).toMatch(/^[\da-f-]{36}$/);
    expect(boundary.spawn.mock.calls[0][2].env.HETANG_MOCK).toBe("1");
  });

  it.each([
    { kind: "monitor" }, { accountId: "other" }, { generation: "old" }, { options: { different: true } },
  ] as Partial<Job>[])("rejects a fixed ID bound to different request data: %j", async (change) => {
    await save(change);
    await expect(startJob(cfg, "download", {}, undefined, ID)).rejects.toMatchObject({ code: "REQUEST_CONFLICT" });
    expect(boundary.spawn).not.toHaveBeenCalled();
  });

  it.each(["complete", "partial", "failed", "stopped"] as const)("reuses terminal %s reservations without a worker", async (status) => {
    await save({ status });
    expect(await startJob(cfg, "download", {}, undefined, ID)).toEqual({ id: ID, status });
    expect(boundary.spawn).not.toHaveBeenCalled();
  });

  it("turns a stopped queued reservation into a cancelled terminal record", async () => {
    await save({ stop: true });
    expect(await startJob(cfg, "download", {}, undefined, ID)).toEqual({ id: ID, status: "stopped" });
    expect(await getJob(cfg, ID)).toMatchObject({ result: { phase: "cancelled", dispatched: false } });
    expect(boundary.spawn).not.toHaveBeenCalled();
  });

  it.each([false, true])("records worker startup errors, stop=%s", async (stop) => {
    await startJob(cfg, "download", {}, undefined, ID);
    if (stop) await stopJob(cfg, ID);
    child.emit("error", new Error("fake startup failure"));
    await vi.waitFor(async () => {
      expect(await getJob(cfg, ID)).toMatchObject({ status: stop ? "stopped" : "failed", error: { code: "WORKER_START" } });
    });
  });

  it("ignores a late process error after another worker completes the job", async () => {
    await startJob(cfg, "download", {}, undefined, ID);
    await save({ status: "complete" });
    child.emit("error", new Error("late error"));
    // A second reservation waits for the same real record lock, draining the listener.
    await startJob(cfg, "download", {}, undefined, ID);
    expect((await getJob(cfg, ID)).status).toBe("complete");
  });
});

describe("real runJob transitions and callback checkpoints", () => {
  it("leaves an already terminal job unchanged", async () => {
    await save({ status: "partial" });
    await runJob(cfg, ID);
    expect((await getJob(cfg, ID)).status).toBe("partial");
    expect(boundary.resource).not.toHaveBeenCalled();
  });

  it.each(["download", "scheduled-answer"] as const)("stops a pre-cancelled %s before work", async (kind) => {
    await save({ kind, stop: true });
    await runJob(cfg, ID);
    const result = await getJob(cfg, ID);
    expect(result.status).toBe("stopped");
    if (kind === "scheduled-answer") expect(result.result).toEqual({ phase: "cancelled", dispatched: false });
    expect(boundary.resource).not.toHaveBeenCalled();
    expect(boundary.prepared).not.toHaveBeenCalled();
  });

  it.each([
    ["identity", "AUTH_CHANGED"], ["generation", "AUTH_CHANGED"], ["auth", "AUTH_REQUIRED"],
  ])("captures %s failure as a public failed job", async (cause, code) => {
    await save();
    if (cause === "identity") boundary.client.identity = "other";
    if (cause === "generation") boundary.client.generation.mockResolvedValue("other");
    if (cause === "auth") boundary.client.checkAuth.mockRejectedValue(new RainError("AUTH_REQUIRED", "expired"));
    await runJob(cfg, ID);
    expect(await getJob(cfg, ID)).toMatchObject({ status: "failed", error: { code } });
    expect(boundary.resource).not.toHaveBeenCalled();
  });

  it("persists real progress, enforces the 500-event retention cap, and returns partial", async () => {
    const events = Array.from({ length: 500 }, (_, n) => ({ seq: n + 1, data: { kind: "old" } }));
    await save({ events, cursor: 500 });
    boundary.resource.mockImplementation(async (_c, _cfg, _job, check, progress) => {
      expect(await check()).toBe(true);
      await progress({ kind: "downloaded", resourceId: "r" });
      return { status: "partial", failed: 1 };
    });
    await runJob(cfg, ID);
    const result = await getJob(cfg, ID);
    expect(result).toMatchObject({ status: "partial", cursor: 501, pid: process.pid, result: { failed: 1 } });
    expect(result.events).toHaveLength(500);
    expect(result.events[0].seq).toBe(2);
    expect(result.events.at(-1)).toEqual({ seq: 501, data: { kind: "downloaded", resourceId: "r" } });
  });

  it("observes cancellation written by a concurrent caller during resource work", async () => {
    await save();
    boundary.resource.mockImplementation(async (_c, _cfg, _job, check, progress) => {
      await stopJob(cfg, ID);
      expect(await check()).toBe(false);
      await progress({ kind: "cancelled" });
      return { status: "stopped" };
    });
    await runJob(cfg, ID);
    expect(await getJob(cfg, ID)).toMatchObject({ status: "stopped", stop: true, cursor: 1 });
  });

  it("redacts unknown resource errors rather than persisting raw exception messages", async () => {
    await save({ kind: "archive" });
    boundary.resource.mockRejectedValue(new Error("cookie=secret"));
    await runJob(cfg, ID);
    const result = await getJob(cfg, ID);
    expect(result).toMatchObject({ status: "failed", error: { code: "OPERATION_FAILED" } });
    expect(JSON.stringify(result)).not.toContain("cookie=secret");
  });

  it("persists prepared checkpoints, progress and dispatch commit before completion", async () => {
    await save({ kind: "scheduled-answer" });
    boundary.prepared.mockImplementation(async (_c, _cfg, _job, hooks) => {
      expect(await hooks.check()).toBe(true);
      await hooks.checkpoint({ phase: "waiting" });
      expect((await getJob(cfg, ID)).result.phase).toBe("waiting");
      await hooks.progress({ kind: "published" });
      await hooks.commitDispatch({ phase: "dispatching", intentAt: "synthetic-intent" });
      expect((await getJob(cfg, ID)).result.intentAt).toBe("synthetic-intent");
      return { status: "complete", result: { phase: "verified" } };
    });
    await runJob(cfg, ID);
    expect(await getJob(cfg, ID)).toMatchObject({ status: "complete", cursor: 1, result: { phase: "verified" } });
  });

  it.each([false, true])("classifies prepared failure using durable dispatch intent, dispatched=%s", async (dispatched) => {
    await save({ kind: "scheduled-answer" });
    boundary.prepared.mockImplementation(async (_c, _cfg, _job, hooks) => {
      await hooks.checkpoint(dispatched ? { intentAt: "intent" } : { phase: "waiting" });
      throw new RainError("PREPARED_FAILURE", "synthetic");
    });
    await runJob(cfg, ID);
    expect(await getJob(cfg, ID)).toMatchObject({ status: dispatched ? "unknown" : "failed", error: { code: "PREPARED_FAILURE" } });
  });

  it("refuses the dispatch commit after a stop marker is persisted", async () => {
    await save({ kind: "scheduled-answer" });
    boundary.prepared.mockImplementation(async (_c, _cfg, _job, hooks) => {
      await stopJob(cfg, ID);
      await hooks.commitDispatch({ intentAt: "must-not-be-written" });
      throw new Error("unreachable");
    });
    await runJob(cfg, ID);
    const result = await getJob(cfg, ID);
    expect(result).toMatchObject({ status: "failed", stop: true, error: { code: "SCHEDULE_CANCELLED" } });
    expect(result.result?.intentAt).toBeUndefined();
  });
});

describe("real monitor orchestration", () => {
  // Only the worker's one-second pacing is accelerated. Real filesystem and locks remain real.
  function accelerateClock() {
    let clock = Date.now();
    vi.spyOn(Date, "now").mockImplementation(() => clock);
    const nativeTimeout = globalThis.setTimeout;
    vi.spyOn(globalThis, "setTimeout").mockImplementation(((fn: (...args: any[]) => void, ms: number, ...args: any[]) => {
      if (ms === 1000) { clock += 1000; queueMicrotask(() => fn(...args)); return 0; }
      return nativeTimeout(fn, ms, ...args);
    }) as any);
  }

  it("filters scope, closed state and unjoined lessons; opens and closes only eligible sessions", async () => {
    await save({ kind: "monitor", options: { lessonIds: ["ok", "finished", "left", "unjoined", "wrong-course"], classroomIds: ["course"], durationMinutes: 1, pollSeconds: 15, autoJoin: false } });
    boundary.client.active.mockResolvedValue(["outside", "ok", "finished", "left", "unjoined", "wrong-course"].map((id) => ({ id, classroomId: id === "wrong-course" ? "other" : "course" })));
    boundary.client.state.mockImplementation(async (id: string) => ({ lessonToken: id === "unjoined" ? undefined : "token", finished: id === "finished", locallyLeft: id === "left" }));
    const close = vi.fn(async () => {});
    boundary.connect.mockResolvedValue({ open: true, close });
    accelerateClock();
    await runJob(cfg, ID);
    expect(boundary.connect).toHaveBeenCalledTimes(1);
    expect(boundary.connect).toHaveBeenCalledWith(boundary.client, "ok", expect.any(Function));
    expect(close).toHaveBeenCalledOnce();
    expect(boundary.join).not.toHaveBeenCalled();
    expect(await getJob(cfg, ID)).toMatchObject({ status: "complete", result: { reason: "duration-finished" } });
  });

  it("replaces disconnected sessions, auto-joins, and emits real persisted progress", async () => {
    await save({ kind: "monitor", options: { durationMinutes: 1, autoJoin: true } });
    boundary.client.active.mockResolvedValue([{ id: "lesson", classroomId: "course" }]);
    let joined = false;
    boundary.client.state.mockImplementation(async () => joined ? { lessonToken: "token" } : undefined);
    boundary.join.mockImplementation(async () => { joined = true; return { id: ID, status: "complete" }; });
    const closeOld = vi.fn(async () => {}), closeNew = vi.fn(async () => {});
    boundary.connect.mockResolvedValueOnce({ open: false, close: closeOld }).mockResolvedValue({ open: true, close: closeNew });
    accelerateClock();
    await runJob(cfg, ID);
    expect(boundary.join).toHaveBeenCalledOnce();
    expect(boundary.connect).toHaveBeenCalledTimes(2);
    expect(closeOld).toHaveBeenCalledOnce();
    expect(closeNew).toHaveBeenCalledOnce();
    expect((await getJob(cfg, ID)).events[0].data).toMatchObject({ kind: "join-result", status: "complete" });
  });

  it("does not connect after a non-complete join receipt", async () => {
    await save({ kind: "monitor", options: { durationMinutes: 1, autoJoin: true } });
    boundary.client.active.mockResolvedValue([{ id: "lesson" }]);
    boundary.join.mockResolvedValue({ id: ID, status: "unknown" });
    accelerateClock();
    await runJob(cfg, ID);
    expect(boundary.connect).not.toHaveBeenCalled();
    expect((await getJob(cfg, ID)).events[0].data).toMatchObject({ status: "unknown" });
  });

  it("uses the mock event socket without a real WebSocket and handles requested stop", async () => {
    cfg = { ...cfg, mock: true };
    await save({ kind: "monitor", options: { autoJoin: true, durationMinutes: 1 } });
    boundary.client.active.mockResolvedValue([{ id: "lesson" }]);
    boundary.join.mockResolvedValue({ id: ID, status: "complete" });
    boundary.client.checkAuth.mockImplementation(async () => {
      const current = await readJson<Job>(jobPath());
      if (current?.cursor) await stopJob(cfg, ID);
    });
    accelerateClock();
    await runJob(cfg, ID);
    expect(boundary.connect).not.toHaveBeenCalled();
    expect(await getJob(cfg, ID)).toMatchObject({ status: "stopped", result: { reason: "requested-stop" } });
    expect((await getJob(cfg, ID)).events.some((e) => (e.data as any).kind === "question-published")).toBe(true);
  });
});

describe("event cursor and monitor catalog public API", () => {
  it("filters the event cursor and signals a truncated retained history", async () => {
    await save({ status: "running", events: [{ seq: 5, data: "a" }, { seq: 6, data: "b" }], cursor: 6 });
    expect(await waitEvents(cfg, ID, 1)).toMatchObject({ eventsTruncated: true, cursor: 6, events: [{ seq: 5, data: "a" }, { seq: 6, data: "b" }] });
    expect(await waitEvents(cfg, ID, 5)).toMatchObject({ eventsTruncated: false, events: [{ seq: 6, data: "b" }] });
  });

  it("returns immediately for a terminal job with no events", async () => {
    await save({ status: "complete" });
    expect(await waitEvents(cfg, ID)).toMatchObject({ status: "complete", events: [], eventsTruncated: false });
  });

  it("waits with a capped minimum duration and then returns an empty queued result", async () => {
    await save();
    const result = await waitEvents(cfg, ID, 0, 0);
    expect(result).toMatchObject({ status: "queued", cursor: 0, events: [], eventsTruncated: false });
  });

  it("canonicalizes scope ordering for catalog reuse and recreates a stopped monitor", async () => {
    const options = { lessonIds: ["b", "a", "a"], classroomIds: ["z", "a"], autoJoin: true };
    const first = await startMonitor(boundary.client, cfg, options);
    const same = await startMonitor(boundary.client, cfg, { ...options, lessonIds: ["a", "b", "a"], classroomIds: ["a", "z"] });
    expect(same).toEqual({ ...first, reused: true });
    expect(boundary.spawn).toHaveBeenCalledOnce();
    await stopJob(cfg, first.id);
    const next = await startMonitor(boundary.client, cfg, options);
    expect(next.id).not.toBe(first.id);
    expect(boundary.spawn).toHaveBeenCalledTimes(2);
  });

  it("recreates catalog entries that point to missing or foreign jobs", async () => {
    const first = await startMonitor(boundary.client, cfg, {});
    const firstPath = path.join(root, "jobs", first.id + ".json");
    const current = await readJson<Job>(firstPath);
    await atomicJson(firstPath, { ...current, accountId: "other" });
    const second = await startMonitor(boundary.client, cfg, {});
    expect(second.id).not.toBe(first.id);
    const secondPath = path.join(root, "jobs", second.id + ".json");
    await atomicJson(secondPath, null);
    const third = await startMonitor(boundary.client, cfg, {});
    expect(third.id).not.toBe(second.id);
  });

  it("reports mayHaveDispatched=false for a scheduled job with no durable intent", async () => {
    await save({ kind: "scheduled-answer" });
    expect(await stopJob(cfg, ID)).toMatchObject({ mayHaveDispatched: false });
    expect(stableId("same")).toBe(stableId("same"));
  });
});
