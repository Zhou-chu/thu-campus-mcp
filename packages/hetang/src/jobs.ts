import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { projectRoot, type Config } from "./config.js";
import { atomicJson, readJson, withLock, digest } from "./storage.js";
import { RainError, publicError } from "./types.js";
import { makeClient } from "./factory.js";
import type { RainClient } from "./client.js";
import { connectLesson } from "./live.js";
import { joinOnce } from "./classroom.js";
export type JobKind = "monitor" | "download" | "archive" | "scheduled-answer";
export interface Job {
  id: string;
  kind: JobKind;
  accountId: string;
  generation: string;
  options: any;
  status:
    | "queued"
    | "running"
    | "complete"
    | "partial"
    | "failed"
    | "stopped"
    | "interrupted"
    | "unknown";
  createdAt: string;
  updatedAt: string;
  pid?: number;
  stop?: boolean;
  events: { seq: number; data: unknown }[];
  cursor: number;
  result?: any;
  error?: unknown;
}
function file(cfg: Config, id: string) {
  if (!/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(id))
    throw new RainError("INVALID_ID", "任务 ID 无效。");
  return path.join(cfg.stateDir, "jobs", id + ".json");
}
export function stableId(value: string) {
  const h = digest(value);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}
export async function startJob(
  cfg: Config,
  kind: JobKind,
  options: any,
  lease?: { accountId: string; generation: string },
  fixedId?: string,
) {
  const c = await makeClient(cfg);
  await c.checkAuth();
  if (
    lease &&
    (c.identity !== lease.accountId ||
      (await c.generation()) !== lease.generation)
  )
    throw new RainError("AUTH_CHANGED", "创建任务时登录已改变。");
  const now = new Date().toISOString();
  const job: Job = {
    id: fixedId || randomUUID(),
    kind,
    accountId: c.identity,
    generation: await c.generation(),
    options,
    status: "queued",
    createdAt: now,
    updatedAt: now,
    events: [],
    cursor: 0,
  };
  await atomicJson(file(cfg, job.id), job);
  const child = spawn(
    process.execPath,
    [path.join(projectRoot, "dist/cli.js"), "worker", job.id],
    {
      detached: true,
      windowsHide: true,
      stdio: "ignore",
      env: {
        ...process.env,
        HETANG_STATE_DIR: cfg.stateDir,
        HETANG_OUTPUT_DIR: cfg.outputDir,
        HETANG_MOCK: cfg.mock ? "1" : "0",
        HETANG_CLOUD_CLI: cfg.cloudCli,
      },
    },
  );
  child.once("error", () => {
    void atomicJson(file(cfg, job.id), {
      ...job,
      status: "failed",
      error: { code: "WORKER_START", message: "后台进程启动失败。" },
    });
  });
  child.unref();
  return { id: job.id, status: "queued" };
}
export async function getJob(cfg: Config, id: string) {
  const job = await readJson<Job>(file(cfg, id));
  if (!job) throw new RainError("NOT_FOUND", "找不到任务。");
  if (
    job.kind === "scheduled-answer" &&
    job.status === "queued" &&
    !job.pid &&
    Date.now() - Date.parse(job.createdAt) > 60000
  )
    return { ...job, status: "interrupted" as const };
  if (["running", "queued"].includes(job.status) && job.pid) {
    try {
      process.kill(job.pid, 0);
    } catch {
      return { ...job, status: "interrupted" as const };
    }
  }
  return job;
}
export async function stopJob(cfg: Config, id: string) {
  return withLock(path.join(cfg.stateDir, "job-record-locks", id), async () => {
    const job = await getJob(cfg, id);
    job.stop = true;
    await atomicJson(file(cfg, id), job);
    return {
      id,
      stopRequested: true,
      ...(job.kind === "scheduled-answer"
        ? { mayHaveDispatched: job.result?.intentAt !== undefined }
        : {}),
    };
  });
}
export async function runJob(cfg: Config, id: string) {
  await withLock(path.join(cfg.stateDir, "job-worker-locks", id), async () => {
    const job = await getJob(cfg, id);
    if (job.status !== "queued") return;
    job.pid = process.pid;
    job.status = "running";
    const client = await makeClient(
      job.kind === "scheduled-answer"
        ? { ...cfg, timeoutMs: Math.min(cfg.timeoutMs, 5000) }
        : cfg,
    );
    const save = () =>
      withLock(path.join(cfg.stateDir, "job-record-locks", id), async () => {
        const latest = await readJson<Job>(file(cfg, id));
        if (latest?.stop) job.stop = true;
        job.updatedAt = new Date().toISOString();
        await atomicJson(file(cfg, id), job);
      });
    const check = async () => {
      await client.checkAuth();
      if (
        client.identity !== job.accountId ||
        (await client.generation()) !== job.generation
      )
        throw new RainError("AUTH_CHANGED", "账号或登录代次已改变，任务停止。");
      const latest = await readJson<Job>(file(cfg, id));
      if (latest?.stop) job.stop = true;
      return !job.stop;
    };
    const progress = async (data: unknown) => {
      job.events.push({ seq: ++job.cursor, data });
      job.events = job.events.slice(-500);
      await save();
    };
    await save();
    try {
      if (!(await check())) {
        job.status = "stopped";
        if (job.kind === "scheduled-answer")
          job.result = { phase: "cancelled", dispatched: false };
        await save();
        return;
      }
      if (job.kind === "scheduled-answer") {
        const { runPreparedAnswer } = await import("./prepared.js");
        const outcome = await runPreparedAnswer(client, cfg, job, {
          check,
          progress,
          checkpoint: async (result) => {
            job.result = result;
            await save();
          },
          commitDispatch: (result) =>
            withLock(
              path.join(cfg.stateDir, "job-record-locks", id),
              async () => {
                const latest = await readJson<Job>(file(cfg, id));
                if (latest?.stop)
                  throw new RainError(
                    "SCHEDULE_CANCELLED",
                    "任务已取消。",
                    400,
                  );
                job.result = result;
                job.updatedAt = new Date().toISOString();
                await atomicJson(file(cfg, id), job);
              },
            ),
        });
        job.result = outcome.result;
        job.status = outcome.status;
      } else if (job.kind === "monitor") {
        const sockets = new Map<
          string,
          Awaited<ReturnType<typeof connectLesson>>
        >();
        const until =
          Date.now() +
          Math.min(480, Math.max(1, job.options.durationMinutes ?? 120)) *
            60000;
        const poll =
          Math.max(15, Math.min(120, job.options.pollSeconds ?? 30)) * 1000;
        try {
          while (Date.now() < until && (await check())) {
            const lessons = await client.active();
            for (const lesson of lessons) {
              if (
                (job.options.lessonIds?.length &&
                  !job.options.lessonIds.includes(lesson.id)) ||
                (job.options.classroomIds?.length &&
                  !job.options.classroomIds.includes(lesson.classroomId))
              )
                continue;
              const existing = sockets.get(lesson.id);
              if (existing?.open) continue;
              if (existing) {
                await existing.close();
                sockets.delete(lesson.id);
              }
              let state = await client.state(lesson.id);
              if (state?.finished || state?.locallyLeft) continue;
              if (!state?.lessonToken) {
                if (!job.options.autoJoin) continue;
                const receipt = await joinOnce(client, cfg, lesson.id);
                await progress({
                  kind: "join-result",
                  lessonId: lesson.id,
                  status: receipt.status,
                  operationId: receipt.id,
                });
                if (receipt.status !== "complete") continue;
                state = await client.state(lesson.id);
              }
              if (cfg.mock) {
                await progress({
                  kind: "question-published",
                  lessonId: lesson.id,
                  questionId: "question-1",
                });
                sockets.set(lesson.id, { open: true, close: async () => {} });
              } else
                sockets.set(
                  lesson.id,
                  await connectLesson(client, lesson.id, progress),
                );
            }
            for (
              let elapsed = 0;
              elapsed < poll && Date.now() < until;
              elapsed += 1000
            ) {
              if (!(await check())) break;
              await new Promise((r) => setTimeout(r, 1000));
            }
          }
        } finally {
          await Promise.allSettled([...sockets.values()].map((s) => s.close()));
        }
        job.status = job.stop ? "stopped" : "complete";
        job.result = {
          reason: job.stop ? "requested-stop" : "duration-finished",
        };
      } else {
        const { runResourceJob } = await import("./resources.js");
        job.result = await runResourceJob(client, cfg, job, check, progress);
        job.status = job.result.status;
      }
    } catch (error) {
      job.status =
        job.kind === "scheduled-answer" && job.result?.intentAt !== undefined
          ? "unknown"
          : "failed";
      job.error = publicError(error);
    }
    await save();
  });
}
export async function waitEvents(
  cfg: Config,
  id: string,
  after = 0,
  seconds = 30,
) {
  const end = Date.now() + Math.min(50, Math.max(1, seconds)) * 1000;
  while (true) {
    const j = await getJob(cfg, id);
    const events = j.events.filter((e) => e.seq > after);
    if (
      events.length ||
      !["queued", "running"].includes(j.status) ||
      Date.now() >= end
    )
      return {
        id,
        status: j.status,
        cursor: j.cursor,
        events,
        eventsTruncated: j.events.length > 0 && after < j.events[0].seq - 1,
      };
    await new Promise((r) => setTimeout(r, 500));
  }
}

export async function startMonitor(
  client: RainClient,
  cfg: Config,
  options: any,
) {
  await client.checkAuth();
  const generation = await client.generation();
  const key = digest(
    JSON.stringify([
      generation,
      [...(options.lessonIds || [])].sort(),
      [...(options.classroomIds || [])].sort(),
      Boolean(options.autoJoin),
    ]),
  );
  const catalog = path.join(cfg.stateDir, "monitor-catalog", key + ".json");
  return withLock(catalog + ".lock", async () => {
    const old = await readJson<{ id: string }>(catalog);
    if (old) {
      const j = await getJob(cfg, old.id).catch(() => undefined);
      if (
        j &&
        ["queued", "running"].includes(j.status) &&
        !j.stop &&
        j.accountId === client.identity
      )
        return { id: j.id, status: j.status, reused: true };
    }
    const job = await startJob(cfg, "monitor", options, {
      accountId: client.identity,
      generation,
    });
    await atomicJson(catalog, { id: job.id });
    return job;
  });
}
