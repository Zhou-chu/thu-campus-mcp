import path from "node:path";
import { randomUUID } from "node:crypto";
import type { Config } from "./config.js";
import type { RainClient } from "./client.js";
import { normalizeAnswer } from "./classroom.js";
import { RainError } from "./types.js";
import { atomicJson, digest, readJson, withLock } from "./storage.js";
import { getJob, startJob, type Job } from "./jobs.js";
import { preparedVault } from "./prepared.js";
import {
  questionContentFingerprint,
  questionSnapshotFingerprint,
} from "./prepared-contract.js";
export { preparedVault } from "./prepared.js";
export interface ScheduleInput {
  lessonId: string;
  questionId: string;
  questionFingerprint: string;
  answer: unknown;
  durationMinutes?: number;
  requestId?: string;
}
export async function scheduleAnswer(
  client: RainClient,
  cfg: Config,
  input: ScheduleInput,
  deps = { start: startJob },
) {
  const id = input.requestId || randomUUID();
  preparedVault(cfg, id); // Validate before using an ID in any local path.
  return withLock(
    path.join(cfg.stateDir, "prepared-id-locks", id),
    async () => {
      await client.checkAuth();
      const generation = await client.generation(),
        accountId = client.identity;
      const key = digest(
        JSON.stringify([
          accountId,
          generation,
          input.lessonId,
          input.questionId,
        ]),
      );
      return withLock(
        path.join(cfg.stateDir, "prepared-scope-locks", key),
        async () => {
          const durationMinutes = input.durationMinutes ?? 120;
          if (
            !Number.isInteger(durationMinutes) ||
            durationMinutes < 1 ||
            durationMinutes > 480
          )
            throw new RainError(
              "INVALID_DURATION",
              "任务时限必须为1–480分钟。",
              400,
            );
          const binding = digest(
            JSON.stringify([
              accountId,
              generation,
              input.lessonId,
              input.questionId,
              input.questionFingerprint,
              input.answer,
              durationMinutes,
            ]),
          );
          const explicit = await readJson<Job>(
            path.join(cfg.stateDir, "jobs", id + ".json"),
          );
          if (
            explicit &&
            (explicit.kind !== "scheduled-answer" ||
              explicit.options.preparationHash !== binding)
          )
            throw new RainError(
              "REQUEST_CONFLICT",
              "任务 ID 已绑定其他请求。",
              400,
            );
          const catalog = path.join(
            cfg.stateDir,
            "prepared-catalog",
            key + ".json",
          );
          const old =
            explicit ||
            (await (async () => {
              const entry = await readJson<{ id: string }>(catalog);
              return entry
                ? getJob(cfg, entry.id).catch(() => undefined)
                : undefined;
            })());
          if (old) {
            const barrier =
              old.status === "interrupted" ||
              old.status === "unknown" ||
              old.result?.intentAt !== undefined ||
              old.result?.phase === "submitted";
            const pending =
              ["queued", "running"].includes(old.status) && !old.stop;
            if (explicit || barrier || pending) {
              if (pending && old.options.preparationHash !== binding)
                throw new RainError(
                  "PREPARED_CONFLICT",
                  "该题已有不同预设答案，请先取消原任务。",
                  400,
                );
              return {
                id: old.id,
                status: old.status,
                reused: true,
                submissionRequestId: old.options.submissionRequestId,
              };
            }
          }
          await client.refreshQuestions(input.lessonId);
          const state = await client.state(input.lessonId);
          if (
            !state?.lessonToken ||
            state.finished ||
            state.locallyLeft ||
            !(await client.active()).some((l) => l.id === input.lessonId)
          )
            throw new RainError(
              "JOIN_REQUIRED",
              "只能为已经进入的当前课堂登记预设答案。",
              400,
            );
          const q = state.questions.find((q) => q.id === input.questionId);
          if (
            !q ||
            questionSnapshotFingerprint(q, accountId, generation) !==
              input.questionFingerprint
          )
            throw new RainError(
              "QUESTION_CHANGED",
              "题目快照或登录已变化，请重新读取题目并解答。",
              400,
            );
          if (q.published || q.answered)
            throw new RainError(
              "PREPARE_DRAFT_ONLY",
              "只接受尚未发布、尚未作答的题目。",
              400,
            );
          const answer = normalizeAnswer(q, input.answer),
            submissionRequestId = randomUUID();
          await client.checkAuth();
          if (
            client.identity !== accountId ||
            (await client.generation()) !== generation
          )
            throw new RainError("AUTH_CHANGED", "登记期间登录已变化。", 400);
          await preparedVault(cfg, id).save({
            account: accountId,
            generation,
            lessonId: q.lessonId,
            questionId: q.id,
            answer,
            contentFingerprint: questionContentFingerprint(q),
            questionFingerprint: input.questionFingerprint,
            expiresAt: Date.now() + durationMinutes * 60000,
            submissionRequestId,
          });
          const options = {
            lessonId: q.lessonId,
            questionId: q.id,
            submissionRequestId,
            preparationHash: binding,
          };
          const now = new Date().toISOString();
          // Publish a reservation before launching. A crash cannot create an unindexed worker.
          await atomicJson(path.join(cfg.stateDir, "jobs", id + ".json"), {
            id,
            kind: "scheduled-answer",
            accountId,
            generation,
            options,
            status: "queued",
            createdAt: now,
            updatedAt: now,
            events: [],
            cursor: 0,
          });
          await atomicJson(catalog, { id });
          const job = await deps.start(
            cfg,
            "scheduled-answer",
            options,
            { accountId, generation },
            id,
          );
          return { ...job, submissionRequestId };
        },
      );
    },
  );
}
