import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AuthStore } from "../src/auth.js";
import { RainClient } from "../src/client.js";
import { MockRain } from "../src/mock.js";
import { loadConfig, type Config } from "../src/config.js";
import { RainError, type LessonData } from "../src/types.js";
import { activeLessons, dataOf, id, identifier, milliseconds, parseJson, questions, resourcesFromSummary } from "../src/protocol.js";

const QA_ROOT = fileURLToPath(new URL("../../../.local/qa-temp/", import.meta.url));
let root: string;
let cfg: Config;
let c: RainClient;
let epoch: string;
let auth: { account: string; userId: string; cookieHeader: string; bearerToken?: string };
const states = new Map<string, any>();
const lesson = (extra: Partial<LessonData> = {}): LessonData => ({ account: c.identity, lessonId: "lesson", lessonToken: "socket", published: [], questions: [], resources: [], ...extra });

beforeEach(async () => {
  await mkdir(QA_ROOT, { recursive: true });
  root = await mkdtemp(path.join(QA_ROOT, "hetang-client-edges-"));
  for (const key of ["TEMP", "TMP", "TMPDIR"]) vi.stubEnv(key, QA_ROOT);
  cfg = loadConfig({ stateDir: root, outputDir: path.join(root, "out"), mock: false });
  epoch = "gen";
  auth = { account: "account", userId: "user", cookieHeader: "sessionid=fixture" };
  states.clear();
  vi.spyOn(AuthStore.prototype, "generation").mockImplementation(async () => epoch);
  vi.spyOn(AuthStore.prototype, "loadVersioned").mockImplementation(async () => ({ data: auth, version: "version" }));
  vi.spyOn(AuthStore.prototype, "load").mockImplementation(async function () { return states.get(this.directory); });
  vi.spyOn(AuthStore.prototype, "save").mockImplementation(async function (value) { states.set(this.directory, value); });
  // No branch may accidentally reach a network if its endpoint is not explicitly supplied below.
  vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("unexpected network boundary"); }));
  c = new RainClient(cfg);
});
afterEach(async () => {
  vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs();
  expect(path.dirname(root)).toBe(path.resolve(QA_ROOT));
  expect(path.basename(root)).toMatch(/^hetang-client-edges-/);
  await rm(root, { recursive: true, force: true });
});

describe("RainClient request and authentication boundary", () => {
  it("exposes a stable generation and rejects an auth change during the initial read", async () => {
    expect(await c.generation()).toBe("gen");
    const fresh = new RainClient(cfg);
    vi.mocked(AuthStore.prototype.loadVersioned).mockImplementationOnce(async () => { epoch = "changed"; return { data: auth, version: "version" }; });
    await expect(fresh.checkAuth()).rejects.toMatchObject({ code: "AUTH_CHANGED" });
    await expect(fresh.checkAuth()).rejects.toMatchObject({ code: "AUTH_CHANGED" });
  });

  it("can recover its serialization queue after missing auth, but never reuses changed auth", async () => {
    vi.mocked(AuthStore.prototype.loadVersioned).mockResolvedValueOnce(undefined);
    await expect(c.checkAuth()).rejects.toMatchObject({ code: "AUTH_REQUIRED" });
    await expect(c.checkAuth()).resolves.toBeUndefined();
    epoch = "changed";
    await expect(c.checkAuth()).rejects.toMatchObject({ code: "AUTH_CHANGED" });
    expect(c.identity).toBe("");
    await expect(c.generation()).rejects.toMatchObject({ code: "AUTH_CHANGED" });
  });

  it("applies gate hooks before sending, preserves explicit headers, and captures refreshed bearer", async () => {
    auth.cookieHeader += "; csrftoken=csrf-fixture";
    auth.bearerToken = "account-bearer";
    const order: string[] = [];
    const fetcher = vi.fn(async (_url: URL, init: RequestInit) => {
      order.push("fetch");
      const h = new Headers(init.headers);
      expect(h.get("x-csrftoken")).toBe("csrf-fixture");
      expect(h.get("lesson-token")).toBe("lesson-token");
      expect(h.get("authorization")).toBe("Bearer lesson-bearer");
      expect(h.get("x-custom")).toBe("fixture");
      expect(init.redirect).toBe("manual");
      return Response.json({ code: 0, result: { ok: true } }, { headers: { "set-auth": "Bearer rotated" } });
    });
    vi.stubGlobal("fetch", fetcher);
    const capture = vi.fn();
    await c.request("/api/example", { method: "POST", headers: { "x-custom": "fixture" } }, "lesson-token", "lesson-bearer", capture, {
      beforeSend: async () => { order.push("before"); }, assertNow: () => { order.push("assert"); },
    });
    expect(order).toEqual(["before", "assert", "fetch"]);
    expect(capture).toHaveBeenCalledWith("rotated");
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("captures the sent account bearer when the response does not rotate it", async () => {
    auth.bearerToken = "sent";
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ data: {} })));
    const capture = vi.fn();
    await c.request("/api/example", {}, undefined, undefined, capture);
    expect(capture).toHaveBeenCalledWith("sent");
  });

  it.each([
    [401, "GET", "AUTH_REQUIRED", 401], [403, "GET", "AUTH_REQUIRED", 403],
    [500, "GET", "HTTP_ERROR", 500], [302, "POST", "HTTP_ERROR", 500], [302, "GET", "HTTP_ERROR", 302],
  ])("does not retry HTTP %s for %s", async (status, method, code, expectedStatus) => {
    const fetcher = vi.fn(async () => new Response("fixture", { status }));
    vi.stubGlobal("fetch", fetcher);
    await expect(c.request("/api/example", { method })).rejects.toMatchObject({ code, status: expectedStatus });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it.each(["POST", "GET"])("redacts malformed JSON for %s", async (method) => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("cookie=must-not-leak")));
    await expect(c.request("/api/example", { method })).rejects.toMatchObject({ code: "INVALID_RESPONSE", status: method === "POST" ? 500 : undefined });
  });

  it.each([7, "not-number"])("rejects platform code %s without a retry", async (code) => {
    const fetcher = vi.fn(async () => Response.json({ code }));
    vi.stubGlobal("fetch", fetcher);
    await expect(c.request("/api/example")).rejects.toMatchObject({ code: "API_REJECTED", status: 400 });
    expect(fetcher).toHaveBeenCalledOnce();
  });
});

describe("RainClient public catalogs and lesson storage", () => {
  it.each([
    [{ data: { userInfo: { userId: "u", name: "name" } } }, { id: "u", name: "name" }],
    [{ result: { user_info: { user_id: 7, nickname: "nick" } } }, { id: "7", name: "nick" }],
    [{ id: "u" }, { id: "u", name: "" }],
  ])("normalizes the actual user response aliases", async (response, expected) => {
    vi.spyOn(c, "request").mockResolvedValue(response);
    expect(await c.user()).toEqual(expected);
  });

  it("normalizes course aliases and rejects an unrecognizable course list", async () => {
    const request = vi.spyOn(c, "request").mockResolvedValue({ data: { list: [
      { classroom_id: 1, name: "named", role: 2, term: "term" },
      { id: "2", course: { name: "nested" }, semester: "semester" }, { id: "3" },
    ] } });
    expect(await c.courses()).toEqual([
      { id: "1", name: "named", role: 2, term: "term" },
      { id: "2", name: "nested", role: undefined, term: "semester" },
      { id: "3", name: "课程", role: undefined, term: null },
    ]);
    request.mockResolvedValue({ data: {} });
    await expect(c.courses()).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
  });

  it("uses real pagination bounds, aliases, filtering and duplicate-page detection", async () => {
    const request = vi.spyOn(c, "request").mockResolvedValueOnce({ data: { activities: [
      { type: 14, courseware_id: "l1", title: "title", is_finished: true },
      { type: "14", lesson_id: "l2" }, { type: 3, courseware_id: "ignored" }, { type: 14 },
    ] } });
    expect(await c.lessons("course with spaces")).toEqual({ complete: true, items: [
      { id: "l1", classroomId: "course with spaces", title: "title", status: "ended" },
      { id: "l2", classroomId: "course with spaces", title: "课堂", status: "unknown" },
    ] });
    expect(request.mock.calls[0][0]).toContain("course%20with%20spaces");
    const full = { data: { activities: Array.from({ length: 200 }, (_, n) => ({ type: 14, lesson_id: `l-${n}` })) } };
    request.mockResolvedValue(full);
    expect((await c.lessons("c", 1)).complete).toBe(false);
    await expect(c.lessons("c", 2)).rejects.toMatchObject({ code: "PAGINATION" });
    request.mockResolvedValue({ data: {} });
    await expect(c.lessons("c")).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
    expect(await c.lessons("c", 0)).toEqual({ items: [], complete: false });
  });

  it("guards stable IDs and account ownership on real lesson-state methods", async () => {
    await c.checkAuth();
    await expect(c.state("../escape")).rejects.toMatchObject({ code: "INVALID_ID" });
    expect(await c.state("lesson")).toBeUndefined();
    await c.saveState(lesson());
    expect(await c.state("lesson")).toMatchObject({ lessonToken: "socket" });
    await c.updateState("lesson", (old) => ({ ...old!, locallyLeft: true }));
    expect((await c.state("lesson"))?.locallyLeft).toBe(true);
    const stored = [...states.values()][0]; stored.account = "other";
    expect(await c.state("lesson")).toBeUndefined();
    await expect(c.updateState("lesson", () => lesson())).rejects.toMatchObject({ code: "AUTH_CHANGED" });
  });

  it("rejects absent/inactive lessons, reuses valid checkins, and refuses missing checkin tokens", async () => {
    await c.checkAuth();
    vi.spyOn(c, "active").mockResolvedValue([]);
    await expect(c.join("lesson")).rejects.toMatchObject({ code: "NOT_ACTIVE" });
    vi.mocked(c.active).mockResolvedValue([{ id: "lesson", classroomId: "", title: "lesson", status: "active" }]);
    await c.saveState(lesson({ expiresAt: null, locallyLeft: true }));
    expect(await c.join("lesson")).toMatchObject({ alreadyJoined: true });
    expect((await c.state("lesson"))?.locallyLeft).toBe(false);
    await c.updateState("lesson", (s) => ({ ...s!, expiresAt: 1 }));
    vi.spyOn(c, "request").mockResolvedValue({ data: {} });
    const before = vi.fn();
    await expect(c.join("lesson", before)).rejects.toMatchObject({ code: "JOIN_UNKNOWN" });
    expect(before).toHaveBeenCalledOnce();
    vi.mocked(c.request).mockImplementation(async (_endpoint, init, _token, _bearer, capture) => {
      expect(JSON.parse(String(init?.body))).not.toHaveProperty("classroomId");
      capture?.("new-bearer"); return { data: { lesson_token: "new-token", expiresIn: 60 } };
    });
    await c.join("lesson");
    expect(await c.state("lesson")).toMatchObject({ lessonToken: "new-token", lessonBearerToken: "new-bearer" });
    expect((await c.state("lesson"))!.expiresAt).toBeGreaterThan(Date.now());
  });

  it("does not refresh before checkin or without a presentation", async () => {
    await expect(c.refreshQuestions("lesson")).rejects.toMatchObject({ code: "JOIN_REQUIRED" });
    await c.saveState(lesson());
    expect(await c.refreshQuestions("lesson")).toMatchObject({ items: [], notice: expect.any(String) });
  });

  it("keeps old publication/answer/deadline state when a fresh presentation is incomplete", async () => {
    await c.checkAuth();
    const old = { id: "q", lessonId: "lesson", presentationId: "deck", slideId: "s", type: "single" as const, prompt: "old", options: [], published: true, answered: true, answer: ["A"], startAt: 1000, endAt: 6000, publicationTimeSource: "observed" as const };
    await c.saveState(lesson({ presentationId: "deck", published: ["q"], questions: [old], timings: { q: { startAt: 2000, endAt: 5000, publicationTimeSource: "server" } } }));
    vi.spyOn(c, "request").mockResolvedValue({ data: { slides: [
      { id: "s", problem: { id: "q", type: 1, endTime: 9 } }, { id: "s2", problem: { id: "new", type: 4 } },
    ] } });
    const result = await c.refreshQuestions("lesson");
    expect(result.items[0]).toMatchObject({ published: true, answered: true, answer: ["A"], startAt: 2000, endAt: 5000, publicationTimeSource: "server" });
    expect(result.items[1].endAt).toBeUndefined();
  });

  it("rejects live resources before slide synchronization or for malformed slide catalogs", async () => {
    await c.checkAuth();
    await c.saveState(lesson());
    vi.spyOn(c, "active").mockResolvedValue([{ id: "lesson" } as any]);
    await expect(c.collectResources("lesson")).rejects.toMatchObject({ code: "LIVE_SNAPSHOT_REQUIRED" });
    await c.updateState("lesson", (s) => ({ ...s!, publishedSlides: { deck: ["s"] } }));
    vi.spyOn(c, "request").mockResolvedValue({ data: {} });
    await expect(c.collectResources("lesson")).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
  });

  it("collects post-class resources, tolerates replay failure but never swallows auth changes", async () => {
    const request = vi.spyOn(c, "request").mockResolvedValueOnce({ data: { errorCode: 7 } });
    await expect(c.collectResources("lesson")).rejects.toMatchObject({ code: "RESOURCES_NOT_READY" });
    request.mockImplementation(async (endpoint) => {
      if (endpoint.includes("/replay")) throw new Error("replay unavailable");
      if (endpoint.includes("/presentation?")) return { data: { slides: [{ cover: "https://s3.yuketang.cn/slide" }] } };
      return { data: { errorCode: 0, presentations: [{ presentation_id: "deck" }] } };
    });
    const result = await c.collectResources("lesson");
    expect(result).toMatchObject({ title: "课堂", replayUnavailable: true });
    expect(result.resources).toHaveLength(1);
    expect((await c.state("lesson"))?.resources).toHaveLength(1);
    request.mockImplementation(async (endpoint) => {
      if (endpoint.includes("/replay")) throw new RainError("AUTH_CHANGED", "changed");
      return { data: { presentations: [] } };
    });
    await expect(c.collectResources("lesson")).rejects.toMatchObject({ code: "AUTH_CHANGED" });
  });
});

describe("MockRain public API rejected paths", () => {
  it("does not allow arbitrary network endpoints or unknown mock lessons/questions", async () => {
    const mock = new MockRain({ ...cfg, mock: true });
    await expect(mock.join("unknown")).rejects.toMatchObject({ code: "NOT_ACTIVE" });
    await expect(mock.refreshQuestions("lesson-1")).rejects.toMatchObject({ code: "JOIN_REQUIRED" });
    await expect(mock.request("https://example.com")).rejects.toMatchObject({ code: "MOCK_NETWORK" });
    await mock.join("lesson-1");
    expect(await mock.join("lesson-1")).toMatchObject({ alreadyJoined: true });
    await expect(mock.request("/api/v3/lesson/problem/answer", { body: JSON.stringify({ problemId: "absent", result: ["A"] }) })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("protocol alias and missing-data edges", () => {
  it("handles optional identifiers, finite timestamp conversion and escaped numeric JSON", () => {
    for (const value of [undefined, null, ""]) expect(id(value)).toBeUndefined();
    expect(id(0)).toBe("0");
    for (const value of [{}, true, ""]) expect(() => identifier(value)).toThrow();
    for (const value of [undefined, null, "", "NaN", Infinity]) expect(milliseconds(value)).toBeUndefined();
    expect(milliseconds("1700000000")).toBe(1700000000000);
    expect(milliseconds(1700000000000)).toBe(1700000000000);
    expect(dataOf({ result: 0 })).toBe(0);
    expect(dataOf({ data: null, result: "fallback" })).toBe("fallback");
    expect(parseJson('{"escaped":"a\\\"b\\\\c","large":-9007199254740993,"exponent":1e3,"fraction":1.5}')).toEqual({ escaped: 'a"b\\c', large: "-9007199254740993", exponent: 1000, fraction: 1.5 });
  });

  it("accepts all active catalog title/ID aliases and rejects missing rows", () => {
    const rows = activeLessons({ result: { on_lesson_classrooms: [
      { lesson_id: 1, classroom_id: 2, title: "title", presentation_id: 3 },
      { id: "b", lessonName: "lessonName" }, { id: "c", classroomName: "classroomName" },
      { id: "d", course_name: "courseName" }, { id: "e", name: "name" }, { id: "f" },
    ] } });
    expect(rows.map((r) => r.title)).toEqual(["title", "lessonName", "classroomName", "courseName", "name", "课堂"]);
    expect(rows[0]).toMatchObject({ id: "1", classroomId: "2", presentationId: "3" });
    expect(activeLessons([])).toEqual([]);
    expect(() => activeLessons({ data: {} })).toThrow();
  });

  it("normalizes question aliases, skips empty slides, and keeps unsupported types explicit", () => {
    const items = questions({ result: { pages: [
      {}, { problem: {} },
      { question: { problem_id: "q", problem_type: 4, content: 42, answers: [{ label: "X", value: 7 }, {}, "plain"], is_published: true, is_answered: true, start_time: 10, end_time: 12 }, slide_id: "s", image_url: "https://s3.yuketang.cn/s" },
      { question: { id: "u", type: 77, prompt: {}, options: "invalid", result: null } },
      { problem: { id: "v", type: 5, isPublished: true, result: "answer" } },
    ] } }, "lesson", "deck", new Set());
    expect(items).toHaveLength(3);
    expect(items[0]).toMatchObject({ id: "q", slideId: "s", type: "blank", prompt: "42", published: true, answered: true, startAt: 10000, endAt: 12000, publicationTimeSource: "server" });
    expect(items[0].options).toEqual([{ key: "X", text: "7" }, { key: "B", text: "" }, { key: "C", text: "plain" }]);
    expect(items[1]).toMatchObject({ type: "unknown", prompt: "", options: [], answered: false, published: false, slideId: "3" });
    expect(items[2]).toMatchObject({ type: "subjective", answered: true, answer: "answer" });
    expect(questions({}, "l", "p", new Set())).toEqual([]);
    expect(() => questions({ slides: "invalid" }, "l", "p", new Set())).toThrow();
  });

  it("collects only valid resource URLs using actual fallback names, sizes and indexes", () => {
    const result = resourcesFromSummary("lesson", {
      presentations: [{ presentation_id: "p", name: "deck" }, { id: "missing" }],
      attachments: [{ download_url: "https://s3.yuketang.cn/f", title: "file", size: 4 }, {}, { id: "f2", url: "https://s3.yuketang.cn/f2" }],
    }, { p: { result: { slides: [
      { imageUrl: "https://s3.yuketang.cn/a", index: 5, size: 10 },
      { image_url: "https://s3.yuketang.cn/b", index: 0 },
      { coverAlt: "https://s3.yuketang.cn/c" }, {},
    ] } } }, { live: [{ id: "v", url: "https://s3.yuketang.cn/v", size: 20 }, { url: 7 }] });
    expect(result.map((r) => r.kind)).toEqual(["slide", "slide", "slide", "video", "file", "file"]);
    expect(result.slice(0, 3).map((r) => r.index)).toEqual([5, 2, 3]);
    expect(result.at(-1)?.title).toBe("课程文件");
    expect(resourcesFromSummary("l", undefined, {}, undefined)).toEqual([]);
  });
});
