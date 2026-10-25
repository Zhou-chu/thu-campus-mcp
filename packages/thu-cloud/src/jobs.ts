import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { atomicJson, readJson, withLock } from "./storage.js";
import { projectRoot, type Config } from "./config.js";
import { makeDrive } from "./factory.js";
import { SyncService, type SyncInput } from "./sync.js";
import { CloudError, publicError } from "./types.js";
interface Job {
  id: string;
  status:
    | "queued"
    | "running"
    | "complete"
    | "partial"
    | "failed"
    | "interrupted";
  pid?: number;
  createdAt: string;
  updatedAt: string;
  options: SyncInput;
  progress?: unknown;
  result?: unknown;
  error?: unknown;
}
function jobFile(config: Config, id: string) {
  if (!/^[a-f0-9-]{36}$/.test(id))
    throw new CloudError("INVALID_ID", "任务 ID 无效。");
  return path.join(config.stateDir, "jobs", id + ".json");
}
export async function startJob(config: Config, options: SyncInput) {
  const id = randomUUID();
  const now = new Date().toISOString();
  const job: Job = {
    id,
    status: "queued",
    createdAt: now,
    updatedAt: now,
    options,
  };
  await atomicJson(jobFile(config, id), job);
  const child = spawn(
    process.execPath,
    [path.join(projectRoot, "dist", "cli.js"), "worker", id],
    {
      detached: true,
      windowsHide: true,
      stdio: "ignore",
      env: {
        ...process.env,
        THU_CLOUD_STATE_DIR: config.stateDir,
        THU_CLOUD_OUTPUT_DIR: config.outputDir,
        THU_CLOUD_MOCK: config.mock ? "1" : "0",
      },
    },
  );
  // The worker writes its own PID; never race it by replacing the queued record here.
  child.once("error", async () => {
    await atomicJson(jobFile(config, id), {
      ...job,
      status: "failed",
      error: { code: "WORKER_START", message: "后台同步进程启动失败。" },
    });
  });
  child.unref();
  return {
    id,
    status: "queued",
    message: "后台任务已创建；调用 cloud_sync_status 查询。",
  };
}
export async function getJob(config: Config, id: string): Promise<Job> {
  const job = await readJson<Job>(jobFile(config, id));
  if (!job) throw new CloudError("NOT_FOUND", "找不到同步任务。");
  if ((job.status === "running" || job.status === "queued") && job.pid) {
    try {
      process.kill(job.pid, 0);
    } catch {
      return {
        ...job,
        status: "interrupted",
        error: {
          code: "WORKER_STOPPED",
          message: "后台进程已停止，已完成的归档仍保留，可重新同步。",
        },
      };
    }
  }
  return job;
}
export async function runJob(config: Config, id: string) {
  return withLock(path.join(config.stateDir, "job-locks", id), async () => {
    const job = await getJob(config, id);
    if (job.status !== "queued") return;
    const save = async () => {
      job.updatedAt = new Date().toISOString();
      await atomicJson(jobFile(config, id), job);
    };
    job.pid = process.pid;
    job.status = "running";
    await save();
    try {
      const result = await new SyncService(await makeDrive(config), config).run(
        job.options,
        async (progress) => {
          job.progress = progress;
          await save();
        },
      );
      job.result = result;
      job.status = result.status;
    } catch (error) {
      job.status = "failed";
      job.error = publicError(error);
    }
    await save();
  });
}
