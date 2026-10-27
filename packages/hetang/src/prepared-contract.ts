import { randomInt } from "node:crypto";
import { digest } from "./storage.js";
import { RainError, type Question } from "./types.js";
export interface AnswerWindow {
  publishedAt: number;
  targetAt: number;
  latestSendAt: number;
  delayMs: number;
}
export function questionContentFingerprint(q: Question) {
  let image = q.imageUrl || "";
  if (image) {
    const u = new URL(image);
    image = u.origin + u.pathname;
  }
  return digest(
    JSON.stringify([
      q.lessonId,
      q.presentationId,
      q.id,
      q.slideId,
      q.type,
      q.prompt.replace(/\s+/g, " ").trim(),
      q.options,
      image,
    ]),
  );
}
export function questionSnapshotFingerprint(
  q: Question,
  accountId: string,
  generation: string,
) {
  return digest(
    JSON.stringify([accountId, generation, questionContentFingerprint(q)]),
  );
}
export function selectAnswerTime(
  q: Question,
  now: number,
  expiresAt: number,
  random: (min: number, max: number) => number = randomInt,
): AnswerWindow {
  if (
    q.publicationTimeSource !== "server" ||
    !Number.isSafeInteger(q.startAt) ||
    q.startAt! > now + 1000
  )
    throw new RainError(
      "PUBLICATION_TIME_REQUIRED",
      "缺少可信的平台发布时间，未安排提交。",
      400,
    );
  const start = q.startAt!,
    lower = Math.ceil(Math.max(20000, now - start)),
    upper = Math.ceil(
      Math.min(40000, (q.endAt ?? Infinity) - start, expiresAt - start),
    );
  if (lower >= upper)
    throw new RainError(
      "ANSWER_WINDOW_UNAVAILABLE",
      "20–40秒与有效截止时间没有可用交集。",
      400,
    );
  const delayMs = random(lower, upper);
  if (!Number.isSafeInteger(delayMs) || delayMs < lower || delayMs >= upper)
    throw new RainError("INVALID_SCHEDULE", "随机目标不在有效窗口中。", 400);
  return {
    publishedAt: start,
    targetAt: start + delayMs,
    latestSendAt: start + upper,
    delayMs,
  };
}
export function assertPreparedQuestion(
  contentFingerprint: string,
  q: Question,
  window: AnswerWindow,
  now: number,
) {
  if (questionContentFingerprint(q) !== contentFingerprint)
    throw new RainError(
      "QUESTION_CHANGED",
      "题目或选项已变化，预设答案未发送。",
      400,
    );
  if (!q.published) throw new RainError("NOT_PUBLISHED", "题目尚未发布。", 400);
  if (q.answered)
    throw new RainError("ALREADY_ANSWERED", "题目已作答，未重复提交。", 400);
  if (q.publicationTimeSource !== "server" || q.startAt !== window.publishedAt)
    throw new RainError(
      "PUBLICATION_CHANGED",
      "平台发布时间已变化，未重新计时提交。",
      400,
    );
  if (
    now < window.targetAt ||
    now < window.publishedAt + 20000 ||
    now >= window.latestSendAt ||
    now >= window.publishedAt + 40000 ||
    (q.endAt !== undefined && now >= q.endAt)
  )
    throw new RainError(
      "ANSWER_WINDOW_UNAVAILABLE",
      "已离开允许的提交时间窗口。",
      400,
    );
}
