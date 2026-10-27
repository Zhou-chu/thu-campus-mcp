import assert from "node:assert/strict";
import { mkdtemp, rm, readdir } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { MockRain } from "../dist/mock.js";
import { loadConfig } from "../dist/config.js";
const root = await mkdtemp(path.join(tmpdir(), "rain-prepared-stdio-"));
const cfg = loadConfig({
  stateDir: root,
  mock: true,
  outputDir: path.join(root, "output"),
});
const mock = new MockRain(cfg),
  clients = [],
  jobs = [];
async function connect() {
  const c = new Client({ name: "prepared-smoke", version: "1" });
  await c.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [path.resolve("dist/cli.js"), "serve"],
      env: {
        ...process.env,
        HETANG_MOCK: "1",
        HETANG_STATE_DIR: root,
        HETANG_OUTPUT_DIR: cfg.outputDir,
      },
      stderr: "pipe",
    }),
  );
  clients.push(c);
  return c;
}
async function call(c, name, args) {
  const r = await c.callTool({ name, arguments: args });
  assert(!r.isError, JSON.stringify(r.structuredContent));
  return r.structuredContent;
}
async function terminal(c, id) {
  const until = Date.now() + 60000;
  while (Date.now() < until) {
    const j = await call(c, "rain_job_status", { jobId: id });
    if (!["queued", "running"].includes(j.status)) return j;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("Prepared worker failed to finish within60seconds");
}
try {
  await mock.join("lesson-1");
  await mock.updateState("lesson-1", (s) => {
    s.questions[0].published = false;
    s.questions.push({
      ...structuredClone(s.questions[0]),
      id: "cancel-question",
    });
    s.published = [];
    return s;
  });
  const c = await connect();
  const questions = (
    await call(c, "rain_questions", {
      lessonId: "lesson-1",
      includeUnpublished: true,
    })
  ).items;
  const input = (q) => ({
    lessonId: "lesson-1",
    questionId: q.id,
    questionFingerprint: q.questionFingerprint,
    answer: ["B"],
    requestId: randomUUID(),
    durationMinutes: 1,
  });
  const pending = input(questions[0]),
    scheduled = await call(c, "rain_schedule_answer", pending);
  jobs.push(scheduled.id);
  assert.equal(
    (await call(c, "rain_schedule_answer", pending)).id,
    scheduled.id,
  );
  const cancel = await call(c, "rain_schedule_answer", input(questions[1]));
  jobs.push(cancel.id);
  assert.equal(
    (await call(c, "rain_stop_job", { jobId: cancel.id })).mayHaveDispatched,
    false,
  );
  await c.close(); // Worker must survive its registering MCP process exiting.
  const other = await connect(),
    job = await terminal(other, scheduled.id);
  assert.equal(job.status, "complete", JSON.stringify(job));
  assert.equal(job.result.phase, "submitted");
  assert(
    job.result.dispatchElapsedMs >= 20000 &&
      job.result.dispatchElapsedMs < 40000,
    JSON.stringify(job.result),
  );
  assert.equal(job.result.receipt.id, scheduled.submissionRequestId);
  assert.equal(job.result.receipt.status, "complete");
  const stopped = await terminal(other, cancel.id);
  assert.equal(stopped.status, "stopped");
  assert.equal(
    (await mock.state("lesson-1")).questions.find(
      (q) => q.id === "cancel-question",
    ).answered,
    false,
  );
  assert.equal(
    (await readdir(path.join(root, "operations"))).filter((n) =>
      n.endsWith(".json"),
    ).length,
    1,
  );
  console.log(
    `PASS: prepared stdio registration/dedup/disconnect/cancel; one verified dispatch at ${(job.result.dispatchElapsedMs / 1000).toFixed(3)}s.`,
  );
} finally {
  // Signal any worker before removing its temporary state, including assertion failures.
  const { stopJob, getJob } = await import("../dist/jobs.js");
  for (const id of jobs) await stopJob(cfg, id).catch(() => {});
  for (let n = 0; n < 40; n++) {
    const states = await Promise.all(
      jobs.map((id) => getJob(cfg, id).catch(() => undefined)),
    );
    if (states.every((j) => !j || !["queued", "running"].includes(j.status)))
      break;
    await new Promise((r) => setTimeout(r, 250));
  }
  await Promise.allSettled(clients.map((c) => c.close()));
  await rm(root, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 200,
  });
}
