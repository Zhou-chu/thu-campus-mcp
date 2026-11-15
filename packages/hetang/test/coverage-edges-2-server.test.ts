import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "../src/server.js";
import { MockRain } from "../src/mock.js";
import { loadConfig, type Config } from "../src/config.js";
import { RainError } from "../src/types.js";

const boundaries = vi.hoisted(() => ({
  getJob: vi.fn(), startJob: vi.fn(), startMonitor: vi.fn(), stopJob: vi.fn(),
  waitEvents: vi.fn(), downloadResource: vi.fn(), captureClassroom: vi.fn(), scheduleAnswer: vi.fn(),
}));
vi.mock("../src/jobs.js", async (original) => ({
  ...await original<typeof import("../src/jobs.js")>(),
  getJob: boundaries.getJob, startJob: boundaries.startJob,
  startMonitor: boundaries.startMonitor, stopJob: boundaries.stopJob, waitEvents: boundaries.waitEvents,
}));
vi.mock("../src/resources.js", async (original) => ({
  ...await original<typeof import("../src/resources.js")>(), downloadResource: boundaries.downloadResource,
}));
vi.mock("../src/capture.js", () => ({ captureClassroom: boundaries.captureClassroom }));
vi.mock("../src/scheduled.js", () => ({ scheduleAnswer: boundaries.scheduleAnswer }));

const QA_ROOT = fileURLToPath(new URL("../../../.local/qa-temp/", import.meta.url));
const JOB_ID = "11111111-2222-4333-8444-555555555555";
let root: string;
let cfg: Config;
let mock: MockRain;
let server: Awaited<ReturnType<typeof createServer>>;
let client: Client;
const job = (changes: Record<string, unknown> = {}) => ({
  id: JOB_ID, kind: "monitor", accountId: "mock-student", generation: "mock-generation",
  options: { lessonIds: ["lesson-1"] }, status: "complete", events: [], cursor: 0, ...changes,
});
const call = (name: string, args: Record<string, unknown> = {}) => client.callTool({ name, arguments: args });
const data = (r: Awaited<ReturnType<typeof call>>) => r.structuredContent as any;

beforeEach(async () => {
  vi.clearAllMocks();
  await mkdir(QA_ROOT, { recursive: true });
  root = await mkdtemp(path.join(QA_ROOT, "hetang-server-edges-"));
  for (const key of ["TEMP", "TMP", "TMPDIR"]) vi.stubEnv(key, QA_ROOT);
  cfg = loadConfig({ stateDir: root, outputDir: path.join(root, "out"), mock: true });
  mock = new MockRain(cfg);
  boundaries.getJob.mockResolvedValue(job());
  boundaries.startJob.mockResolvedValue({ id: JOB_ID, status: "queued" });
  boundaries.startMonitor.mockResolvedValue({ id: JOB_ID, status: "queued" });
  boundaries.stopJob.mockResolvedValue({ id: JOB_ID, stopRequested: true });
  boundaries.waitEvents.mockResolvedValue({ id: JOB_ID, cursor: 3, events: [] });
  boundaries.captureClassroom.mockResolvedValue({ filePath: "synthetic" });
  boundaries.scheduleAnswer.mockResolvedValue({ id: JOB_ID, status: "queued" });
  server = await createServer(cfg);
  client = new Client({ name: "coverage-boundaries", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  await client.connect(b);
});

afterEach(async () => {
  await client?.close();
  await server?.close();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  // Delete only the exact mkdtemp directory owned by this test.
  if (root) {
    expect(path.dirname(root)).toBe(path.resolve(QA_ROOT));
    expect(path.basename(root)).toMatch(/^hetang-server-edges-/);
    await rm(root, { recursive: true, force: true });
  }
});

describe("MCP registered read tools and prompt", () => {
  it("runs public catalog handlers against real MockRain and expands the prompt", async () => {
    expect(data(await call("rain_status", { verify: false }))).toBeDefined();
    expect(data(await call("rain_list_courses")).courses[0].id).toBe("course-1");
    expect(data(await call("rain_list_lessons", { classroomId: "course-1" }))).toMatchObject({ complete: true });
    expect(data(await call("rain_active_classrooms")).lessons[0].id).toBe("lesson-1");
    expect((await client.listPrompts()).prompts[0].name).toBe("attend_and_answer");
    const prompt = await client.getPrompt({ name: "attend_and_answer", arguments: { lessonId: "authorized-lesson" } });
    expect(JSON.stringify(prompt)).toContain("authorized-lesson");
    expect(JSON.stringify(prompt)).toContain("unknown");
  });

  it("reads cached questions without refresh, never leaks unpublished answers or URLs", async () => {
    expect(data(await call("rain_questions", { lessonId: "absent", refresh: false })).items).toEqual([]);
    await mock.join("lesson-1");
    await mock.updateState("lesson-1", (s) => {
      s!.questions[0].answer = ["B"];
      s!.questions[0].imageUrl = "https://s3.yuketang.cn/image?token=secret";
      s!.questions.push({ ...s!.questions[0], id: "draft", published: false, answer: ["do-not-return"] });
      return s!;
    });
    const ordinary = data(await call("rain_questions", { lessonId: "lesson-1", refresh: false }));
    expect(ordinary.items).toHaveLength(1);
    expect(ordinary.items[0]).toMatchObject({ answer: ["B"], hasImage: true });
    const preview = data(await call("rain_questions", { lessonId: "lesson-1", includeUnpublished: true, refresh: false }));
    expect(preview.items[1]).not.toHaveProperty("answer");
    expect(preview.items[1].questionFingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(preview)).not.toMatch(/do-not-return|s3.yuketang|secret/);
  });

  it("paginates resources, strips URLs and supports explicit live scope", async () => {
    const resources = [0, 1, 2].map((n) => ({ id: `r-${n}`, kind: "slide", index: n + 1, url: "https://s3.yuketang.cn/secret" }));
    const spy = vi.spyOn(MockRain.prototype, "collectResources").mockResolvedValue({
      title: "deck", resources, replayUnavailable: true, scope: "published-live-snapshot",
    } as any);
    const first = data(await call("rain_list_resources", { lessonId: "lesson-1", limit: 2 }));
    expect(first).toMatchObject({ total: 3, nextOffset: 2, scope: "published-live-snapshot" });
    expect(first.items).toHaveLength(2);
    expect(first.items[0]).not.toHaveProperty("url");
    spy.mockResolvedValue({ title: "deck", resources, replayUnavailable: false } as any);
    const last = data(await call("rain_list_resources", { lessonId: "lesson-1", offset: 2, limit: 2 }));
    expect(last.scope).toBe("lesson-summary");
    expect(last).not.toHaveProperty("nextOffset");
    expect(last.items).toHaveLength(1);
  });

  it("returns public errors rather than raw dependency details and wraps primitive results", async () => {
    boundaries.captureClassroom.mockRejectedValueOnce(new Error("password=must-not-leak"));
    const error = await call("rain_capture_classroom", { lessonId: "lesson-1" });
    expect(error.isError).toBe(true);
    expect(data(error).code).toBe("OPERATION_FAILED");
    expect(JSON.stringify(error)).not.toContain("must-not-leak");
    boundaries.captureClassroom.mockResolvedValueOnce("snapshot");
    expect(data(await call("rain_capture_classroom", { lessonId: "lesson-1" }))).toEqual({ result: "snapshot" });
    boundaries.captureClassroom.mockResolvedValueOnce(["one"]);
    expect(data(await call("rain_capture_classroom", { lessonId: "lesson-1" }))).toEqual({ result: ["one"] });
  });
});

describe("MCP state-changing tool boundaries", () => {
  it("joins a real mock classroom, starts only a scoped monitor, and leaves locally", async () => {
    const joined = data(await call("rain_join_classroom", { lessonId: "lesson-1", durationMinutes: 3 }));
    expect(joined.receipt.status).toBe("complete");
    expect(boundaries.startMonitor).toHaveBeenCalledWith(expect.any(MockRain), cfg, {
      lessonIds: ["lesson-1"], autoJoin: false, durationMinutes: 3, pollSeconds: 15,
    });
    expect((await mock.state("lesson-1"))?.locallyLeft).toBe(false);
    expect(data(await call("rain_leave_classroom", { lessonId: "lesson-1", monitorJobId: JOB_ID }))).toEqual({ left: true, lessonId: "lesson-1" });
    expect((await mock.state("lesson-1"))?.locallyLeft).toBe(true);
  });

  it("does not start a monitor after a non-complete join receipt", async () => {
    vi.spyOn(MockRain.prototype, "join").mockRejectedValue(new RainError("NOT_ACTIVE", "not active"));
    const result = data(await call("rain_join_classroom", { lessonId: "lesson-1" }));
    expect(result.receipt.status).not.toBe("complete");
    expect(boundaries.startMonitor).not.toHaveBeenCalled();
  });

  it.each([
    ["wrong kind", { kind: "download" }, "SCOPE_MISMATCH"],
    ["wrong scope", { options: { lessonIds: ["other"] } }, "SCOPE_MISMATCH"],
    ["missing scope", { options: {} }, "SCOPE_MISMATCH"],
    ["missing state", {}, "NOT_FOUND"],
  ])("rejects leaving: %s", async (_label, changes, code) => {
    boundaries.getJob.mockResolvedValue(job(changes));
    expect(data(await call("rain_leave_classroom", { lessonId: "lesson-1", monitorJobId: JOB_ID })).code).toBe(code);
  });

  it("submits via real AnswerService and reads the scoped operation receipt", async () => {
    await mock.join("lesson-1");
    const submitted = data(await call("rain_submit_answer", {
      lessonId: "lesson-1", questionId: "question-1", answer: ["B"], requestId: JOB_ID,
    }));
    expect(submitted.status).toBe("complete");
    expect(data(await call("rain_operation_status", { id: JOB_ID })).status).toBe("complete");
    expect((await mock.state("lesson-1"))?.questions[0].answered).toBe(true);
  });

  it("passes validated scheduling and monitor options to the worker boundary", async () => {
    const args = { lessonId: "lesson-1", questionId: "question-1", questionFingerprint: "a".repeat(64), answer: { content: "answer" } };
    expect(data(await call("rain_schedule_answer", args)).id).toBe(JOB_ID);
    expect(boundaries.scheduleAnswer).toHaveBeenCalledWith(expect.any(MockRain), cfg, expect.objectContaining({ ...args, durationMinutes: 120 }));
    await call("rain_monitor_classrooms", { lessonIds: ["lesson-1"], autoJoin: false });
    expect(boundaries.startMonitor).toHaveBeenCalledWith(expect.any(MockRain), cfg, {
      lessonIds: ["lesson-1"], classroomIds: [], autoJoin: false, durationMinutes: 120, pollSeconds: 30,
    });
  });

  it("authorizes download course membership and preserves the auth lease", async () => {
    const input = { lessonIds: ["lesson-1"], classroomId: "course-1", outputDir: path.join(root, "downloads") };
    expect(data(await call("rain_download_resources", input)).id).toBe(JOB_ID);
    expect(boundaries.startJob).toHaveBeenCalledWith(cfg, "download", expect.objectContaining({ ...input, courseName: "离线模拟课程" }), { accountId: "mock-student", generation: "mock-generation" });
    await call("rain_download_resources", { lessonIds: ["lesson-1"] });
    expect(boundaries.startJob).toHaveBeenLastCalledWith(cfg, "download", expect.objectContaining({ courseName: undefined }), expect.anything());
    boundaries.startJob.mockClear();
    expect(data(await call("rain_download_resources", { lessonIds: ["lesson-1"], classroomId: "not-my-course" })).code).toBe("NOT_FOUND");
    expect(boundaries.startJob).not.toHaveBeenCalled();
  });
});

describe("MCP job ownership, readiness and archive scope", () => {
  it.each(["rain_job_status", "rain_stop_job", "rain_wait_events"])("checks ownership before %s", async (name) => {
    boundaries.getJob.mockResolvedValue(job({ accountId: "another-account" }));
    const rejected = await call(name, { jobId: JOB_ID });
    expect(rejected.isError).toBe(true);
    expect(data(rejected).code).toBe("NOT_FOUND");
    expect(boundaries.stopJob).not.toHaveBeenCalled();
    expect(boundaries.waitEvents).not.toHaveBeenCalled();
  });

  it("rejects scheduled jobs from an old generation and accepts a current generation", async () => {
    boundaries.getJob.mockResolvedValue(job({ kind: "scheduled-answer", generation: "old" }));
    expect(data(await call("rain_job_status", { jobId: JOB_ID })).code).toBe("AUTH_CHANGED");
    boundaries.getJob.mockResolvedValue(job({ kind: "scheduled-answer" }));
    expect(data(await call("rain_job_status", { jobId: JOB_ID })).kind).toBe("scheduled-answer");
    expect(data(await call("rain_stop_job", { jobId: JOB_ID })).stopRequested).toBe(true);
    expect(data(await call("rain_wait_events", { jobId: JOB_ID, after: 2, timeoutSeconds: 1 })).cursor).toBe(3);
    expect(boundaries.waitEvents).toHaveBeenCalledWith(cfg, JOB_ID, 2, 1);
  });

  it.each([
    ["wrong kind", { kind: "monitor" }, "JOB_NOT_READY"],
    ["running download", { kind: "download", status: "running" }, "JOB_NOT_READY"],
    ["no result", { kind: "download" }, "ARCHIVE_SCOPE"],
    ["no manifest", { kind: "download", result: { results: [{}] } }, "ARCHIVE_SCOPE"],
    ["multiple manifests", { kind: "download", result: { results: [{ manifestPath: "a" }, { manifestPath: "b" }] } }, "ARCHIVE_SCOPE"],
  ])("rejects unsafe archive scope: %s", async (_label, changes, code) => {
    boundaries.getJob.mockResolvedValue(job(changes));
    expect(data(await call("rain_archive_resources", { downloadJobId: JOB_ID })).code).toBe(code);
    expect(boundaries.startJob).not.toHaveBeenCalled();
  });

  it.each(["complete", "partial"])("archives a single manifest from a %s download", async (status) => {
    const manifestPath = path.join(root, "manifest.json");
    boundaries.getJob.mockResolvedValue(job({ kind: "download", status, result: { results: [{}, { manifestPath }] } }));
    expect(data(await call("rain_archive_resources", { downloadJobId: JOB_ID })).status).toBe("queued");
    expect(boundaries.startJob).toHaveBeenCalledWith(cfg, "archive", { manifestPath, cloudRepoId: undefined, cloudRoot: "/荷塘雨课堂" }, { accountId: "mock-student", generation: "mock-generation" });
  });
});

describe("MCP question-image cache", () => {
  it("rejects a missing, unpublished or image-less question without downloading", async () => {
    expect(data(await call("rain_question_image", { lessonId: "lesson-1", questionId: "question-1" })).code).toBe("NO_IMAGE");
    await mock.join("lesson-1");
    expect(data(await call("rain_question_image", { lessonId: "lesson-1", questionId: "question-1" })).code).toBe("NO_IMAGE");
    await mock.updateState("lesson-1", (s) => { s!.questions[0].imageUrl = "https://s3.yuketang.cn/a"; s!.questions[0].published = false; return s!; });
    expect(data(await call("rain_question_image", { lessonId: "lesson-1", questionId: "question-1" })).code).toBe("NO_IMAGE");
    expect(boundaries.downloadResource).not.toHaveBeenCalled();
  });

  it.each([
    ["PNG", Buffer.from([0x89, 0x50, 0x4e, 0x47]), "image/png"],
    ["JPEG", Buffer.from([0xff, 0xd8, 0xff]), "image/jpeg"],
    ["WebP", Buffer.from("RIFF0000WEBPdata"), "image/webp"],
  ])("downloads %s once and serves a cached MCP image", async (_label, bytes, mimeType) => {
    await mock.join("lesson-1");
    await mock.updateState("lesson-1", (s) => { s!.questions[0].imageUrl = "https://s3.yuketang.cn/a?token=hidden"; s!.questions[0].published = false; return s!; });
    boundaries.downloadResource.mockImplementation(async (_resource, file, options, keepRunning) => {
      expect(options.maxBytes).toBe(8 * 1024 ** 2);
      expect(await keepRunning()).toBe(true);
      await writeFile(file, bytes);
    });
    const input = { lessonId: "lesson-1", questionId: "question-1", includeUnpublished: true };
    const first = await call("rain_question_image", input);
    expect(first.isError).not.toBe(true);
    expect(first.content).toContainEqual({ type: "image", data: bytes.toString("base64"), mimeType });
    expect(data(first).questionFingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(await readFile(data(first).filePath)).toEqual(bytes);
    expect(JSON.stringify(first)).not.toContain("token=hidden");
    expect((await call("rain_question_image", input)).isError).not.toBe(true);
    expect(boundaries.downloadResource).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["invalid bytes", Buffer.from("not an image"), "INVALID_IMAGE"],
    ["oversized", Buffer.alloc(8 * 1024 ** 2 + 1, 0x89), "IMAGE_LIMIT"],
  ])("rejects %s", async (_label, bytes, code) => {
    await mock.join("lesson-1");
    await mock.updateState("lesson-1", (s) => { s!.questions[0].imageUrl = "https://s3.yuketang.cn/a"; return s!; });
    boundaries.downloadResource.mockImplementation(async (_r, file) => { await writeFile(file, bytes); });
    expect(data(await call("rain_question_image", { lessonId: "lesson-1", questionId: "question-1" })).code).toBe(code);
  });
});

describe("MCP schemas reject invalid inputs before dependencies", () => {
  it.each([
    ["rain_list_lessons", { classroomId: "../escape" }],
    ["rain_list_lessons", { classroomId: "x", maxPages: 51 }],
    ["rain_join_classroom", { lessonId: "x", durationMinutes: 0 }],
    ["rain_join_classroom", { lessonId: "x", requestId: "not-uuid" }],
    ["rain_list_resources", { lessonId: "x", offset: -1 }],
    ["rain_list_resources", { lessonId: "x", limit: 501 }],
    ["rain_wait_events", { jobId: JOB_ID, timeoutSeconds: 51 }],
    ["rain_download_resources", { lessonIds: [] }],
    ["rain_download_resources", { lessonIds: ["x"], outputDir: "relative" }],
    ["rain_submit_answer", { lessonId: "x", questionId: "q", answer: [] }],
    ["rain_schedule_answer", { lessonId: "x", questionId: "q", answer: ["A"], questionFingerprint: "bad" }],
  ])("rejects malformed input for %s", async (name, input) => {
    const result = await call(name, input);
    expect(result.isError).toBe(true);
    expect(boundaries.startJob).not.toHaveBeenCalled();
    expect(boundaries.startMonitor).not.toHaveBeenCalled();
    expect(boundaries.scheduleAnswer).not.toHaveBeenCalled();
  });
});
