import { it, expect, vi } from "vitest";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadConfig } from "../src/config.js";
import { RainClient } from "../src/client.js";
import { AnswerService, applyEvent, joinOnce } from "../src/classroom.js";
import { MockRain } from "../src/mock.js";
import { downloadLesson, runResourceJob } from "../src/resources.js";
import { RainError } from "../src/types.js";
import { archiveManifest, CloudBridge } from "../src/cloud.js";
import { digest } from "../src/storage.js";
import type { LessonData } from "../src/types.js";
async function temp(fn: (root: string) => Promise<void>) {
  const root = await mkdtemp(path.join(tmpdir(), "hetang-review-"));
  try {
    await fn(root);
  } finally {
    vi.restoreAllMocks();
    await rm(root, { recursive: true, force: true });
  }
}
function state(): LessonData {
  return {
    account: "test",
    lessonId: "9",
    lessonToken: "unit-test",
    presentationId: "8",
    resources: [],
    published: ["22"],
    questions: [
      {
        id: "22",
        lessonId: "9",
        presentationId: "8",
        slideId: "1",
        type: "single",
        prompt: "题",
        options: [{ key: "A", text: "甲" }],
        published: true,
        answered: false,
        endAt: Date.now() + 600000,
      },
    ],
  };
}
it("blocks another answer write for the same question after an unknown result even with a new request ID", () =>
  temp(async (root) => {
    const cfg = loadConfig({ stateDir: root }),
      c = new RainClient(cfg),
      s = state();
    c.identity = "test";
    c.checkAuth = async () => {};
    c.state = async () => s;
    c.refreshQuestions = async () => ({ items: s.questions });
    let writes = 0;
    c.request = async () => {
      writes++;
      throw new Error("response lost");
    };
    const service = new AnswerService(c, cfg);
    const a = await service.submit({
      lessonId: "9",
      questionId: "22",
      answer: ["A"],
    });
    const b = await service.submit({
      lessonId: "9",
      questionId: "22",
      answer: ["A"],
    });
    expect(a.status).toBe("unknown");
    expect(b.id).toBe(a.id);
    expect(writes).toBe(1);
  }));
it("rejects a freshly closed server deadline despite a future cached deadline", () =>
  temp(async (root) => {
    const cfg = loadConfig({ stateDir: root }),
      c = new RainClient(cfg);
    let s = state();
    c.identity = "test";
    c.checkAuth = async () => {};
    c.state = async () => s;
    c.updateState = async (_id, fn) => (s = fn(s));
    let writes = 0;
    c.request = async (_url, init) => {
      if (init?.method === "POST") {
        writes++;
        throw new Error("written");
      }
      return {
        code: 0,
        data: {
          slides: [
            {
              id: "1",
              problem: {
                id: "22",
                type: 1,
                body: "题",
                options: ["甲"],
                endTime: Date.now() - 1000,
              },
            },
          ],
        },
      };
    };
    const r = await new AnswerService(c, cfg).submit({
      lessonId: "9",
      questionId: "22",
      answer: ["A"],
    });
    expect(r.status).toBe("failed");
    expect(writes).toBe(0);
  }));
it("accepts scalar/object publication aliases and puts verified lessonId on every event", () => {
  for (const raw of [
    { problem: "22" },
    { problemid: "22" },
    { problem: { problemId: "22" } },
  ]) {
    const s = state();
    s.questions[0].published = false;
    s.published = [];
    const events = applyEvent(s, {
      op: "unlockproblem",
      ...raw,
      pres: "8",
      dt: Date.now(),
      limit: 30,
    });
    expect(s.questions[0].published).toBe(true);
    expect(events[0]).toMatchObject({ lessonId: "9", questionId: "22" });
  }
  for (const lessonId of ["9", "10"]) {
    const s = { ...state(), lessonId };
    expect(applyEvent(s, { op: "lessonfinished" })[0].lessonId).toBe(lessonId);
  }
});
async function downloaded(root: string) {
  const cfg = loadConfig({
      stateDir: path.join(root, "state"),
      outputDir: path.join(root, "out"),
      mock: true,
    }),
    c = new MockRain(cfg);
  const result = await downloadLesson(
    c,
    cfg,
    "lesson-1",
    { pdf: false, includeVideos: false },
    async () => true,
    async () => {},
  );
  const m = JSON.parse(await readFile(result.manifestPath, "utf8"));
  return { cfg, c, result, m, file: path.join(m.root, m.files[0].relative) };
}
it("retains downloaded manifest and original results when cloud archive is unavailable", () =>
  temp(async (root) => {
    const cfg = loadConfig({
        stateDir: path.join(root, "state"),
        outputDir: path.join(root, "out"),
        mock: true,
      }),
      c = new MockRain(cfg);
    vi.spyOn(CloudBridge.prototype, "open").mockRejectedValue(
      new RainError("CLOUD_AUTH_REQUIRED", "需要登录云盘。"),
    );
    const job: any = {
      kind: "download",
      options: {
        lessonIds: ["lesson-1"],
        pdf: false,
        includeVideos: false,
        archive: true,
      },
    };
    const result = await runResourceJob(
      c,
      cfg,
      job,
      async () => true,
      async () => {},
    );
    expect(result.status).toBe("partial");
    expect(result.results[0].manifestPath).toEqual(expect.any(String));
    expect(result.results[0].files).toBe(1);
    expect(result.results[0].archive.error.code).toBe("CLOUD_AUTH_REQUIRED");
  }));
it("does not reapprove an edited previous manifest during incremental download", () =>
  temp(async (root) => {
    const { cfg, c, result, m, file } = await downloaded(root);
    await writeFile(file, "unrelated local content");
    m.files[0].sha256 = digest("unrelated local content");
    await writeFile(result.manifestPath, JSON.stringify(m));
    await expect(
      downloadLesson(
        c,
        cfg,
        "lesson-1",
        { pdf: false, includeVideos: false },
        async () => true,
        async () => {},
      ),
    ).rejects.toThrow(/清单/);
  }));
it("does not upload content changed during cloud directory preparation", () =>
  temp(async (root) => {
    const { cfg, c, result, file } = await downloaded(root);
    vi.spyOn(CloudBridge.prototype, "mkdirs").mockImplementation(async () => {
      await writeFile(file, "changed private content");
    });
    let uploads = 0;
    vi.spyOn(CloudBridge.prototype, "upload").mockImplementation(async () => {
      uploads++;
      return { operationId: "fake", remoteId: "fake" };
    });
    const r = await archiveManifest(
      c,
      cfg,
      result.manifestPath,
      {},
      async () => true,
      async () => {},
    );
    expect(r.status).toBe("partial");
    expect(uploads).toBe(0);
  }));
it("rechecks the Hetang job guard at upload after cloud preparation", () =>
  temp(async (root) => {
    const { cfg, c, result } = await downloaded(root);
    let active = true,
      preparations = 0;
    vi.spyOn(CloudBridge.prototype, "mkdirs").mockImplementation(async () => {
      if (++preparations === 2) active = false;
    });
    let uploads = 0;
    const original = CloudBridge.prototype.upload;
    vi.spyOn(CloudBridge.prototype, "upload").mockImplementation(
      async function (this: CloudBridge, ...args) {
        uploads++;
        return original.apply(this, args);
      },
    );
    const r = await archiveManifest(
      c,
      cfg,
      result.manifestPath,
      {},
      async () => active,
      async () => {},
    );
    expect(r.status).toBe("partial");
    expect(uploads).toBe(0);
  }));

it("routes each emitted event to its verified connection lesson", () => {
  for (const lessonId of ["9", "10"]) {
    const s = { ...state(), lessonId };
    expect(applyEvent(s, { op: "lessonfinished" })[0]).toMatchObject({
      lessonId,
      kind: "lesson-ended",
    });
  }
});
it("blocks another attendance write after an unknown join under another explicit request ID", () =>
  temp(async (root) => {
    const cfg = loadConfig({ stateDir: root }),
      c = new RainClient(cfg);
    c.identity = "test";
    c.checkAuth = async () => {};
    let writes = 0;
    c.join = async (_id, dispatch) => {
      await dispatch?.();
      writes++;
      throw new Error("response lost");
    };
    const a = await joinOnce(
      c,
      cfg,
      "9",
      "11111111-1111-4111-8111-111111111111",
    );
    const b = await joinOnce(
      c,
      cfg,
      "9",
      "22222222-2222-4222-8222-222222222222",
    );
    expect(a.status).toBe("unknown");
    expect(b.id).toBe(a.id);
    expect(writes).toBe(1);
  }));
