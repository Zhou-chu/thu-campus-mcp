import path from "node:path";
import { randomInt } from "node:crypto";
import { AuthStore } from "./auth.js";
import type { Config } from "./config.js";
import type { RainClient } from "./client.js";
import type { Job } from "./jobs.js";
import { AnswerService } from "./classroom.js";
import { connectLesson } from "./live.js";
import { RainError, publicError, type Question } from "./types.js";
import { assertPreparedQuestion, questionContentFingerprint, selectAnswerTime, type AnswerWindow } from "./prepared-contract.js";

export interface PreparedAnswerData {
  account: string;
  generation: string;
  lessonId: string;
  questionId: string;
  answer: unknown;
  contentFingerprint: string;
  questionFingerprint: string;
  expiresAt: number;
  submissionRequestId: string;
}
export function preparedVault(cfg: Config, id: string) {
  if (!/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(id))
    throw new RainError("INVALID_ID", "任务 ID 无效。");
  return new AuthStore<PreparedAnswerData>(path.join(cfg.stateDir, "prepared-answers", id));
}
interface Hooks {
  check(): Promise<boolean>;
  checkpoint(result: any): Promise<void>;
  progress(event: unknown): Promise<void>;
  commitDispatch(result: any): Promise<void>;
}
interface Dependencies {
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  randomInt: (min: number, max: number) => number;
  connect: typeof connectLesson;
}
/** This worker executes one already solved answer. It never invokes a model. */
export async function runPreparedAnswer(client: RainClient, cfg: Config, job: Job, hooks: Hooks, overrides: Partial<Dependencies> = {}) {
  const deps: Dependencies = { now: Date.now, sleep: ms => new Promise(r => setTimeout(r, ms)), randomInt, connect: connectLesson, ...overrides };
  let result: any = { ...job.result }, socket: Awaited<ReturnType<typeof connectLesson>> | undefined;
  let dispatchAt: number | undefined, gateFailure: unknown;
  const finish = (phase: string, status: Job["status"] = "complete", extra: any = {}) => ({ status, result: { ...result, ...extra, phase, finishedAt: deps.now() } });
  if (result.intentAt !== undefined || ["submitting", "unknown"].includes(result.phase))
    return finish("unknown", "unknown", { reason: "interrupted-dispatch-intent", automaticRetry: false });
  if (result.phase === "submitted") return finish("submitted");
  try {
    const data = await preparedVault(cfg, job.id).load();
    if (!data || data.account !== job.accountId || data.generation !== job.generation || data.lessonId !== job.options.lessonId || data.questionId !== job.options.questionId)
      throw new RainError("AUTH_CHANGED", "预设答案与当前任务绑定不一致。", 400);
    result = { ...result, submissionRequestId: data.submissionRequestId, expiresAt: data.expiresAt };
    const check = async () => {
      if (!(await hooks.check())) throw new RainError("SCHEDULE_CANCELLED", "任务已取消。", 400);
      await client.checkAuth();
      if (client.identity !== data.account || await client.generation() !== data.generation)
        throw new RainError("AUTH_CHANGED", "登录已变化，任务停止。", 400);
    };
    const question = async () => {
      await check();
      const state = await client.state(data.lessonId);
      if (!state?.lessonToken || state.locallyLeft || state.finished)
        throw new RainError("CLASSROOM_ENDED", "已离开课堂或课堂已结束。", 400);
      const q = state.questions.find(q => q.id === data.questionId);
      if (!q || questionContentFingerprint(q) !== data.contentFingerprint)
        throw new RainError("QUESTION_CHANGED", "题目已变化，未发送预设答案。", 400);
      if (q.answered) throw new RainError("ALREADY_ANSWERED", "题目已作答。", 400);
      return q;
    };
    let q = await question();
    if (deps.now() >= data.expiresAt) return finish("expired");
    await hooks.checkpoint(result = { ...result, phase: "waiting-publication" });
    const connect = async () => {
      if (cfg.mock && !overrides.connect) {
        await client.updateState(data.lessonId, s => {
          const target = s!.questions.find(q => q.id === data.questionId)!;
          if (!target.published) Object.assign(target, { published: true, startAt: deps.now(), publicationTimeSource: "server", endAt: deps.now() + 120000 });
          return s!;
        });
        return { open: true, close: async () => {} };
      }
      return deps.connect(client, data.lessonId, hooks.progress);
    };
    let nextPoll = 0, nextConnect = 0, nextActive = 0;
    while (true) {
      q = await question();
      if (deps.now() >= data.expiresAt) return finish("expired");
      if (q.published) break;
      if (deps.now() >= nextConnect && !socket?.open) {
        await socket?.close();
        try { socket = await connect(); } catch (e) {
          if (e instanceof RainError && /^AUTH_/.test(e.code)) throw e;
        }
        nextConnect = deps.now() + 5000;
      }
      if (deps.now() >= nextActive) {
        if (!(await client.active()).some(l => l.id === data.lessonId)) return finish("classroom-ended");
        nextActive = deps.now() + 30000;
      }
      if (deps.now() >= nextPoll) {
        await client.refreshQuestions(data.lessonId);
        nextPoll = deps.now() + 5000;
      }
      await deps.sleep(Math.min(500, Math.max(1, data.expiresAt - deps.now())));
    }
    const window: AnswerWindow = result.window || selectAnswerTime(q, deps.now(), data.expiresAt, deps.randomInt);
    result = { ...result, phase: "scheduled", window };
    await hooks.checkpoint(result);
    await hooks.progress({ kind: "answer-scheduled", lessonId: data.lessonId, questionId: data.questionId, targetAt: window.targetAt, delayMs: window.delayMs });
    while (deps.now() < window.targetAt - 2000) {
      q = await question();
      if (deps.now() >= nextPoll) { await client.refreshQuestions(data.lessonId); nextPoll = deps.now() + 5000; }
      await deps.sleep(Math.min(500, Math.max(1, window.targetAt - 2000 - deps.now())));
    }
    const receipt = await new AnswerService(client, cfg).submit({ lessonId: data.lessonId, questionId: data.questionId, answer: data.answer, requestId: data.submissionRequestId }, {
      beforeSend: async () => {
        try {
          while (deps.now() < window.targetAt) {
            await check();
            await deps.sleep(Math.min(100, window.targetAt - deps.now()));
          }
          await client.refreshQuestions(data.lessonId);
          if (!(await client.active()).some(l => l.id === data.lessonId)) throw new RainError("CLASSROOM_ENDED", "课堂已结束。", 400);
          q = await question();
          assertPreparedQuestion(data.contentFingerprint, q, window, deps.now());
          result = { ...result, phase: "submitting", intentAt: deps.now() };
          await hooks.commitDispatch(result);
        } catch (e) { gateFailure = e; throw e; }
      },
      assertNow: () => {
        try {
          assertPreparedQuestion(data.contentFingerprint, q, window, deps.now());
          dispatchAt = deps.now();
          result = { ...result, dispatchAt, dispatchElapsedMs: dispatchAt - window.publishedAt };
        } catch (e) { gateFailure = e; throw e; }
      },
    });
    if (gateFailure) throw gateFailure;
    if (dispatchAt === undefined) {
      if (receipt.id !== data.submissionRequestId || receipt.status === "complete")
        return finish("already-answered", "complete", { existingOperationId: receipt.id });
      if (receipt.status === "unknown") return finish("unknown", "unknown", { receipt, automaticRetry: false });
      throw new RainError((receipt.error as any)?.code || "PREPARATION_FAILED", (receipt.error as any)?.message || "提交前检查未通过。", 400);
    }
    return receipt.status === "complete"
      ? finish("submitted", "complete", { receipt })
      : finish("unknown", "unknown", { receipt, automaticRetry: false });
  } catch (e) {
    if (dispatchAt !== undefined) return finish("unknown", "unknown", { error: publicError(e), automaticRetry: false });
    const phases: Record<string, string> = { SCHEDULE_CANCELLED: "cancelled", AUTH_CHANGED: "auth-changed", AUTH_REQUIRED: "auth-changed", QUESTION_CHANGED: "question-changed", ALREADY_ANSWERED: "already-answered", CLASSROOM_ENDED: "classroom-ended", QUESTION_CLOSED: "missed-window", ANSWER_WINDOW_UNAVAILABLE: "missed-window", PUBLICATION_TIME_REQUIRED: "publication-time-unavailable", PUBLICATION_CHANGED: "publication-changed", NOT_PUBLISHED: "publication-changed", LEFT_CLASSROOM: "classroom-ended" };
    const phase = e instanceof RainError ? phases[e.code] : undefined;
    return finish(phase || "failed", phase === "cancelled" ? "stopped" : phase ? "complete" : "failed", { error: publicError(e), dispatched: false });
  } finally { await socket?.close(); }
}
