import path from "node:path";
import { RainClient } from "./client.js";
import type { Config } from "./config.js";
import { readJson, atomicJson, withLock } from "./storage.js";
import { RainError, type LessonData, type Resource } from "./types.js";
export class MockRain extends RainClient {
  override identity = "mock-student";
  constructor(cfg: Config) {
    super(cfg);
  }
  override async checkAuth() {}
  override async generation() {
    return "mock-generation";
  }
  private get file() {
    return path.join(this.config.stateDir, "mock-state.json");
  }
  override async user() {
    return { id: "mock-student", name: "离线模拟用户" };
  }
  override async courses() {
    return [{ id: "course-1", name: "离线模拟课程", role: 2, term: "mock" }];
  }
  override async active() {
    return [
      {
        id: "lesson-1",
        classroomId: "course-1",
        title: "离线模拟课堂",
        status: "active" as const,
        presentationId: "deck-1",
      },
    ];
  }
  override async lessons(classroomId: string) {
    return {
      items: [
        {
          id: "lesson-1",
          classroomId,
          title: "离线模拟课堂",
          status: "ended" as const,
        },
      ],
      complete: true,
    };
  }
  override async state(lessonId: string) {
    return ((await readJson<Record<string, LessonData>>(this.file)) || {})[
      lessonId
    ];
  }
  override async updateState(
    lessonId: string,
    fn: (s: LessonData | undefined) => LessonData,
  ) {
    return withLock(this.file + ".lock", async () => {
      const all = (await readJson<Record<string, LessonData>>(this.file)) || {};
      const next = fn(all[lessonId]);
      all[lessonId] = next;
      await atomicJson(this.file, all);
      return next;
    });
  }
  override async saveState(s: LessonData) {
    await this.updateState(s.lessonId, () => s);
  }
  override async join(lessonId: string, beforeWrite?: () => Promise<void>) {
    if (lessonId !== "lesson-1")
      throw new RainError("NOT_ACTIVE", "模拟课堂不存在。");
    const old = await this.state(lessonId);
    if (old?.lessonToken)
      return { lessonId, joined: true, alreadyJoined: true };
    await beforeWrite?.();
    await this.saveState({
      account: this.identity,
      lessonId,
      lessonToken: "mock-local-token",
      expiresAt: null,
      presentationId: "deck-1",
      published: ["question-1"],
      questions: [
        {
          id: "question-1",
          lessonId,
          presentationId: "deck-1",
          slideId: "slide-1",
          type: "single",
          prompt: "2 + 2 等于多少？",
          options: [
            { key: "A", text: "3" },
            { key: "B", text: "4" },
          ],
          published: true,
          answered: false,
        },
      ],
      resources: [],
    });
    return { lessonId, joined: true };
  }
  override async refreshQuestions(lessonId: string) {
    const s = await this.state(lessonId);
    if (!s?.lessonToken)
      throw new RainError("JOIN_REQUIRED", "请先进入模拟课堂。");
    return { items: s.questions };
  }
  override async request(
    endpoint: string,
    init: RequestInit = {},
  ): Promise<any> {
    if (endpoint !== "/api/v3/lesson/problem/answer")
      throw new RainError("MOCK_NETWORK", "模拟模式禁止真实请求。");
    const body = JSON.parse(String(init.body));
    await this.updateState("lesson-1", (old) => {
      const s = old!;
      const q = s.questions.find((q) => q.id === body.problemId);
      if (!q) throw new RainError("NOT_FOUND", "模拟题目不存在。");
      q.answered = true;
      q.answer = body.result;
      return s;
    });
    return { code: 0, data: { accepted: true } };
  }
  override async collectResources(lessonId: string) {
    const resources: Resource[] = [
      {
        id: "mock-slide-1",
        lessonId,
        kind: "slide",
        title: "模拟课件",
        url: "https://content.xuetangx.com/mock/slide.png",
        presentationId: "deck-1",
        index: 1,
      },
    ];
    await this.updateState(lessonId, (old) => ({
      ...(old || {
        account: this.identity,
        lessonId,
        questions: [],
        published: [],
      }),
      resources,
    }));
    return { title: "离线模拟课堂", resources, replayUnavailable: false };
  }
}
