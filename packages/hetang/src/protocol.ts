import {
  RainError,
  type Lesson,
  type Question,
  type Resource,
} from "./types.js";
import { digest } from "./storage.js";
export function parseJson(text: string): any {
  let out = "";
  for (let i = 0; i < text.length; ) {
    if (text[i] === '"') {
      let j = i + 1;
      for (; j < text.length; j++) {
        if (text[j] === "\\") {
          j++;
          continue;
        }
        if (text[j] === '"') {
          j++;
          break;
        }
      }
      out += text.slice(i, j);
      i = j;
      continue;
    }
    const number = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(
      text.slice(i),
    );
    if (number) {
      const s = number[0];
      out +=
        /^-?\d+$/.test(s) && !Number.isSafeInteger(Number(s))
          ? JSON.stringify(s)
          : s;
      i += s.length;
    } else out += text[i++];
  }
  return JSON.parse(out);
}
export function identifier(value: unknown): string {
  if (typeof value === "number" && !Number.isSafeInteger(value))
    throw new RainError("UNSAFE_ID", "收到不精确的长 ID，未继续请求。");
  if (!["string", "number"].includes(typeof value) || !String(value))
    throw new RainError("INVALID_ID", "缺少稳定 ID。");
  return String(value);
}
export function id(value: unknown): string | undefined {
  return value === undefined || value === null || value === ""
    ? undefined
    : identifier(value);
}
export function dataOf(v: any) {
  return v?.data ?? v?.result ?? v;
}
export function milliseconds(v: unknown): number | undefined {
  if (v === undefined || v === null || v === "") return;
  const n = Number(v);
  return Number.isFinite(n) ? (n < 1e11 ? n * 1000 : n) : undefined;
}
export function activeLessons(v: any): Lesson[] {
  const d = dataOf(v);
  const rows = Array.isArray(d)
    ? d
    : (d?.onLessonClassrooms ?? d?.on_lesson_classrooms);
  if (!Array.isArray(rows))
    throw new RainError("INVALID_RESPONSE", "无法识别正在上课的课堂列表。");
  return rows.map((x: any) => ({
    id: identifier(x.lessonId ?? x.lesson_id ?? x.id),
    classroomId: id(x.classroomId ?? x.classroom_id) || "",
    title: String(
      x.title ??
        x.lessonName ??
        x.classroomName ??
        x.course_name ??
        x.name ??
        "课堂",
    ),
    presentationId: id(x.presentationId ?? x.presentation_id),
    status: "active",
  }));
}
function plain(v: unknown): string {
  return typeof v === "string" || typeof v === "number" ? String(v) : "";
}
export function questions(
  v: any,
  lessonId: string,
  presentationId: string,
  published: Set<string>,
): Question[] {
  const d = dataOf(v);
  const slides = d?.slides ?? d?.pages ?? [];
  if (!Array.isArray(slides))
    throw new RainError("INVALID_RESPONSE", "无法识别课堂课件。");
  return slides.flatMap((s: any, index: number) => {
    const p = s.problem ?? s.question;
    if (!p) return [];
    const qid = id(p.problemId ?? p.problem_id ?? p.id);
    if (!qid) return [];
    const type =
      (
        {
          1: "single",
          2: "multiple",
          3: "poll",
          4: "blank",
          5: "subjective",
        } as any
      )[Number(p.problemType ?? p.problem_type ?? p.type)] ?? "unknown";
    const options = p.options ?? p.answers ?? [];
    return [
      {
        id: qid,
        lessonId,
        presentationId,
        slideId: id(s.id ?? s.slide_id) || String(index),
        type,
        prompt: plain(p.prompt ?? p.content ?? p.body),
        options: Array.isArray(options)
          ? options.map((o: any, n: number) => ({
              key:
                typeof o === "object"
                  ? plain(o.key ?? o.label) || String.fromCharCode(65 + n)
                  : String.fromCharCode(65 + n),
              text:
                typeof o === "object"
                  ? plain(o.content ?? o.text ?? o.value)
                  : plain(o),
            }))
          : [],
        published:
          published.has(qid) ||
          p.isPublished === true ||
          p.is_published === true,
        answered:
          p.isAnswered === true ||
          p.is_answered === true ||
          (p.result !== undefined && p.result !== null),
        answer: p.result,
        startAt: milliseconds(p.startTime ?? p.start_time),
        publicationTimeSource: milliseconds(p.startTime ?? p.start_time) !== undefined ? "server" : undefined,
        endAt: milliseconds(p.endTime ?? p.end_time),
        imageUrl: s.imageUrl ?? s.cover ?? s.coverAlt ?? s.image_url,
      } as Question,
    ];
  });
}
export function resourcesFromSummary(
  lessonId: string,
  summary: any,
  presentations: Record<string, any>,
  replay: any,
): Resource[] {
  const rows: Resource[] = [];
  for (const p of summary?.presentations ?? []) {
    const pid = identifier(p.id ?? p.presentation_id);
    const slides = dataOf(presentations[pid])?.slides ?? [];
    for (const [index, s] of slides.entries()) {
      const url = s.cover ?? s.imageUrl ?? s.image_url ?? s.coverAlt;
      if (typeof url !== "string") continue;
      rows.push({
        id: digest(`${lessonId}:slide:${pid}:${id(s.id) || index}`).slice(
          0,
          24,
        ),
        lessonId,
        kind: "slide",
        title: String(p.title ?? p.name ?? "课件"),
        url,
        presentationId: pid,
        index:
          Number.isSafeInteger(s.index) && s.index > 0 ? s.index : index + 1,
        size: typeof s.size === "number" ? s.size : undefined,
      });
    }
  }
  for (const [index, v] of (replay?.live ?? []).entries()) {
    if (typeof v.url === "string")
      rows.push({
        id: digest(`${lessonId}:video:${v.id ?? index}`).slice(0, 24),
        lessonId,
        kind: "video",
        title: "课堂回放",
        url: v.url,
        index: index + 1,
        size: typeof v.size === "number" ? v.size : undefined,
      });
  }
  for (const [index, f] of (
    summary?.files ??
    summary?.attachments ??
    []
  ).entries()) {
    if (typeof (f.url ?? f.download_url) === "string")
      rows.push({
        id: digest(`${lessonId}:file:${f.id ?? index}`).slice(0, 24),
        lessonId,
        kind: "file",
        title: String(f.name ?? f.title ?? "课程文件"),
        url: f.url ?? f.download_url,
        index: index + 1,
        size: f.size,
      });
  }
  return rows;
}
