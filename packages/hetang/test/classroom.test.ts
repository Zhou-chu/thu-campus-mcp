import { it, expect } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  applyEvent,
  normalizeAnswer,
  AnswerService,
} from "../src/classroom.js";
import { loadConfig } from "../src/config.js";
import { RainClient } from "../src/client.js";
import type { LessonData, Question } from "../src/types.js";
const q: Question = {
  id: "22",
  lessonId: "9",
  presentationId: "8",
  slideId: "1",
  type: "single",
  prompt: "题目",
  options: [
    { key: "A", text: "甲" },
    { key: "B", text: "乙" },
  ],
  published: false,
  answered: false,
};
it("binds publish/deadline/answer events to stable IDs and ignores another user answer", () => {
  const s: LessonData = {
    account: "test",
    lessonId: "9",
    questions: [{ ...q }],
    resources: [],
    published: [],
  };
  applyEvent(
    s,
    {
      op: "unlockproblem",
      problem: { prob: "22", pres: "8", dt: 1700000000, limit: 30 },
    },
    1700000000000,
    "self",
  );
  expect(s.questions[0]).toMatchObject({
    published: true,
    endAt: 1700000030000,
  });
  applyEvent(
    s,
    { op: "problemanswered", problemId: "22", userid: "other", answer: ["A"] },
    1700000001000,
    "self",
  );
  expect(s.questions[0].answered).toBe(false);
  applyEvent(
    s,
    { op: "problemanswered", problemId: "22", userid: "self", answer: ["A"] },
    1700000002000,
    "self",
  );
  expect(s.questions[0]).toMatchObject({ answered: true, answer: ["A"] });
});
it("retains a publish deadline that arrives before its presentation is fetched", () => {
  const s: LessonData = {
    account: "test",
    lessonId: "9",
    questions: [],
    resources: [],
    published: [],
  };
  applyEvent(
    s,
    { op: "unlockproblem", prob: "22", pres: "8", dt: 1700000000, limit: 30 },
    1700000000000,
    "self",
  );
  expect(s.timings?.["22"]).toMatchObject({
    startAt: 1700000000000,
    endAt: 1700000030000,
  });
});
it("validates question answer type, uniqueness and available option keys", () => {
  expect(normalizeAnswer({ ...q, published: true }, ["a"])).toEqual(["A"]);
  expect(() => normalizeAnswer(q, ["A", "B"])).toThrow();
  expect(() => normalizeAnswer(q, ["Z"])).toThrow();
  expect(
    normalizeAnswer({ ...q, type: "subjective" }, { content: "结论" }),
  ).toEqual({ content: "结论", pics: [{ pic: "" }], videos: [] });
});
it("does not replay an uncertain answer and refuses closed or already answered questions", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "hetang-answer-"));
  const cfg = loadConfig({ stateDir: root });
  const c = new RainClient(cfg);
  c.identity = "test";
  c.checkAuth = async () => {};
  const state: LessonData = {
    account: "test",
    lessonId: "9",
    lessonToken: "unit-test-token",
    questions: [{ ...q, published: true }],
    resources: [],
    published: ["22"],
  };
  c.state = async () => state;
  c.refreshQuestions = async () => ({ items: state.questions });
  let writes = 0;
  c.request = async () => {
    writes++;
    throw new Error("response lost");
  };
  try {
    const svc = new AnswerService(c, cfg);
    const input = {
      lessonId: "9",
      questionId: "22",
      answer: ["A"],
      requestId: "11111111-1111-4111-8111-111111111111",
    };
    expect((await svc.submit(input)).status).toBe("unknown");
    expect((await svc.submit(input)).status).toBe("unknown");
    expect(writes).toBe(1);
    state.questions[0].id = "closed-question";
    state.questions[0].endAt = Date.now() - 1;
    expect(
      (
        await svc.submit({
          ...input,
          questionId: "closed-question",
          requestId: "22222222-2222-4222-8222-222222222222",
        })
      ).status,
    ).toBe("failed");
    state.questions[0].id = "answered-question";
    state.questions[0].endAt = undefined;
    state.questions[0].answered = true;
    expect(
      (
        await svc.submit({
          ...input,
          questionId: "answered-question",
          requestId: "33333333-3333-4333-8333-333333333333",
        })
      ).status,
    ).toBe("failed");
    expect(writes).toBe(1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
it("replays a hello snapshot without missing earlier questions or published slide IDs", () => {
  const state: LessonData = {
    account: "test",
    lessonId: "lesson",
    questions: [],
    published: [],
    resources: [],
  };
  const events = applyEvent(
    state,
    {
      op: "hello",
      presentation: "deck",
      timeline: [
        { type: "slide", pres: "deck", sid: "s12", si: 12, dt: 1700000000000 },
        {
          type: "problem",
          pres: "deck",
          prob: "q12",
          dt: 1700000000000,
          limit: 120,
        },
      ],
    },
    1700000400000,
  );
  expect(state.presentationId).toBe("deck");
  expect(state.published).toEqual(["q12"]);
  expect(state.timings?.q12.endAt).toBe(1700000120000);
  expect((state as any).publishedSlides).toEqual({ deck: ["s12"] });
  expect(events.some((e) => e.kind === "presentation")).toBe(true);
});
it("never extends a recorded close deadline when hello replays an earlier publication", () => {
  const start = 1700000000000,
    state: LessonData = {
      account: "test",
      lessonId: "lesson",
      questions: [{ ...q }],
      published: [],
      resources: [],
    };
  applyEvent(
    state,
    { op: "unlockproblem", prob: "22", pres: "8", dt: start, limit: 300 },
    start,
  );
  applyEvent(state, { op: "lockproblem", prob: "22" }, start + 60000);
  applyEvent(
    state,
    {
      op: "hello",
      presentation: "8",
      timeline: [
        { type: "problem", prob: "22", pres: "8", dt: start, limit: 300 },
      ],
    },
    start + 120000,
  );
  expect(state.timings?.["22"].endAt).toBe(start + 60000);
  expect(state.questions[0].endAt).toBe(start + 60000);
});
