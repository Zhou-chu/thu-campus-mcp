import { RainError, type LessonData, type Question } from "./types.js";
import { RainClient, type RequestGate } from "./client.js";
import type { Config } from "./config.js";
import { scopedWrite } from "./scoped-write.js";
import { id, milliseconds } from "./protocol.js";
export function normalizeAnswer(q: Question, value: unknown): unknown {
  if (q.type === "unknown")
    throw new RainError("UNSUPPORTED_QUESTION", "无法识别题型，未提交。");
  if (q.type === "subjective") {
    const content = typeof value === "string" ? value : (value as any)?.content;
    if (
      typeof content !== "string" ||
      !content.trim() ||
      content.length > 20000
    )
      throw new RainError("ANSWER_FORMAT", "主观题需要非空文本。");
    return { content: content.trim(), pics: [{ pic: "" }], videos: [] };
  }
  const raw = typeof value === "string" ? [value] : value;
  if (
    !Array.isArray(raw) ||
    !raw.length ||
    raw.length > 50 ||
    raw.some((v) => typeof v !== "string" || v.length > 10000)
  )
    throw new RainError("ANSWER_FORMAT", "答案需要非空字符串数组。");
  if (q.type === "blank") return raw.map((v) => v.trim());
  const values = [...new Set(raw.map((v) => v.trim().toUpperCase()))].sort();
  if (
    (q.type === "single" && values.length !== 1) ||
    values.some((v) => !q.options.some((o) => o.key === v))
  )
    throw new RainError("ANSWER_FORMAT", "答案选项与题型或可选项不匹配。");
  return values;
}
export function applyEvent(
  state: LessonData,
  message: any,
  now = Date.now(),
  userId?: string,
) {
  const events: {
    kind: string;
    lessonId: string;
    questionId?: string;
    presentationId?: string;
    occurredAt: string;
  }[] = [];
  const emit = (kind: string, q?: string) =>
    events.push({
      kind,
      lessonId: state.lessonId,
      questionId: q,
      presentationId: state.presentationId,
      occurredAt: new Date(now).toISOString(),
    });
  const unlock = (raw: any) => {
    const p =
      raw.problem && typeof raw.problem === "object"
        ? { ...raw, ...raw.problem }
        : { ...raw, prob: raw.prob ?? raw.problem ?? raw.problemid };
    const qid = id(p.problemId ?? p.problem_id ?? p.prob ?? p.id);
    if (!qid) return;
    const pres = id(p.pres ?? p.presentationId ?? p.presentation_id);
    if (pres) state.presentationId = pres;
    if (!state.published.includes(qid)) state.published.push(qid);
    const serverStart = milliseconds(p.dt ?? p.unlockedAt);
    const prior = state.timings?.[qid];
    const startAt = serverStart ?? prior?.startAt ?? now;
    const limit = Number(p.limit);
    state.timings ||= {};
    const priorEnd = state.timings[qid]?.endAt;
    const deadline = limit > 0 ? startAt + limit * 1000 : undefined;
    const ends = [priorEnd, deadline].filter(
      (n): n is number => n !== undefined,
    );
    state.timings[qid] = {
      startAt,
      publicationTimeSource: serverStart !== undefined ? "server" : prior?.publicationTimeSource ?? "observed",
      endAt: ends.length ? Math.min(...ends) : undefined,
    };
    const q = state.questions.find((x) => x.id === qid);
    if (q) {
      q.published = true;
      Object.assign(q, state.timings[qid]);
    }
    emit("question-published", qid);
  };
  switch (String(message?.op ?? "").toLowerCase()) {
    case "hello":
    case "fetchtimeline":
      for (const p of Array.isArray(message.timeline) ? message.timeline : []) {
        if (p.type === "problem") unlock(p);
        else if (p.type === "slide") {
          const pres = id(p.pres),
            slide = id(p.sid);
          if (pres && slide) {
            state.publishedSlides ||= {};
            const slides = (state.publishedSlides[pres] ||= []);
            if (!slides.includes(slide)) slides.push(slide);
            state.presentationId = pres;
          }
        } else if (p.type === "presentation") {
          const pres = id(p.pres ?? p.presentationId ?? p.id);
          if (pres) state.presentationId = pres;
        }
      }
      if (typeof message.presentation === "string")
        state.presentationId = id(message.presentation);
      if (state.presentationId) emit("presentation");
      break;
    case "unlockproblem":
      unlock(message);
      break;
    case "problemanswered": {
      const uid = id(message.userId ?? message.userid ?? message.user_id);
      if (uid && userId && uid !== userId) break;
      const qid = id(
        message.problemId ??
          message.problem_id ??
          message.problemid ??
          message.prob,
      );
      const q = state.questions.find((x) => x.id === qid);
      if (q) {
        q.answered = true;
        q.answer = message.answer ?? message.result;
        emit("question-answered", qid);
      }
      break;
    }
    case "lockproblem":
    case "problemfinished": {
      const qid = id(message.problemId ?? message.prob);
      const q = state.questions.find((x) => x.id === qid);
      if (qid) {
        state.timings ||= {};
        state.timings[qid] = { ...state.timings[qid], endAt: now };
      }
      if (q) q.endAt = now;
      emit("question-closed", qid);
      break;
    }
    case "showpresentation":
    case "switchpresentation":
    case "sendpresentation": {
      const p = id(
        message.presentationId ??
          message.presentation_id ??
          message.pres ??
          message.presentation?.id,
      );
      if (p) state.presentationId = p;
      emit("presentation");
      break;
    }
    case "lessonfinished":
      state.finished = true;
      emit("lesson-ended");
      break;
  }
  return events;
}
export interface SubmitInput {
  lessonId: string;
  questionId: string;
  answer: unknown;
  requestId?: string;
}
export class AnswerService {
  constructor(
    private client: RainClient,
    private config: Config,
  ) {}
  async submit(input: SubmitInput, gate?: RequestGate) {
    return scopedWrite(
      this.client,
      this.config,
      "answer:" + input.lessonId + ":" + input.questionId,
      "answer",
      {
        lessonId: input.lessonId,
        questionId: input.questionId,
        answer: input.answer,
      },
      input.requestId,
      async (dispatched) => {
        let state = await this.client.state(input.lessonId);
        if (!state?.lessonToken)
          throw new RainError("JOIN_REQUIRED", "请先进入当前课堂。");
        await this.client.refreshQuestions(input.lessonId);
        state = (await this.client.state(input.lessonId))!;
        const q = state.questions.find((x) => x.id === input.questionId);
        if (!q || !q.published)
          throw new RainError("NOT_PUBLISHED", "题目尚未发布或不属于该课堂。");
        if (state.locallyLeft)
          throw new RainError("LEFT_CLASSROOM", "已离开本地课堂监听，未提交。");
        if (state.finished || (q.endAt !== undefined && Date.now() >= q.endAt))
          throw new RainError("QUESTION_CLOSED", "课堂或题目已结束，未提交。");
        if (q.answered)
          throw new RainError("ALREADY_ANSWERED", "已作答的题目不会重复提交。");
        const answer = normalizeAnswer(q, input.answer);
        const type = {
          single: 1,
          multiple: 2,
          poll: 3,
          blank: 4,
          subjective: 5,
          unknown: 0,
        }[q.type];
        await dispatched();
        await this.client.request(
          "/api/v3/lesson/problem/answer",
          {
            method: "POST",
            get body() { return JSON.stringify({
              problemId: q.id,
              problemType: type,
              dt: Date.now(),
              result: answer,
            }); },
          },
          state.lessonToken,
          state.lessonBearerToken,
          undefined,
          gate,
        );
        for (let n = 0; n < 4; n++) {
          await this.client.checkAuth();
          const updated = await this.client.state(input.lessonId);
          const actual = updated?.questions.find((x) => x.id === q.id);
          if (actual?.answered) {
            try {
              if (
                JSON.stringify(normalizeAnswer(actual, actual.answer)) ===
                JSON.stringify(answer)
              )
                return {
                  lessonId: input.lessonId,
                  questionId: q.id,
                  submitted: true,
                  verification: "answer-readback",
                };
            } catch {}
          }
          try {
            await this.client.refreshQuestions(input.lessonId);
          } catch {
            /* next read may observe websocket acknowledgment */
          }
          if (n < 3) await new Promise((r) => setTimeout(r, 500));
        }
        throw new RainError(
          "ANSWER_UNKNOWN",
          "提交已响应，但尚未回读到同一答案；请查询回执和题目，不要重发。",
          500,
        );
      },
    );
  }
}

export async function joinOnce(
  client: RainClient,
  cfg: Config,
  lessonId: string,
  requestId?: string,
) {
  return scopedWrite(
    client,
    cfg,
    "join:" + lessonId,
    "join",
    { lessonId },
    requestId,
    (dispatch) => client.join(lessonId, dispatch),
    false,
  );
}
