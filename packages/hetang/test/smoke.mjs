import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
const root = await mkdtemp(path.join(tmpdir(), "hetang-smoke-"));
const clients = [];
let monitorId;
async function connect(mock) {
  const c = new Client({ name: "smoke", version: "1" });
  await c.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [path.resolve("dist/cli.js"), "serve"],
      env: {
        ...process.env,
        HETANG_STATE_DIR: path.join(root, mock ? "mock" : "real"),
        HETANG_OUTPUT_DIR: path.join(root, "output"),
        HETANG_MOCK: mock ? "1" : "0",
      },
      stderr: "pipe",
    }),
  );
  clients.push(c);
  return c;
}
async function call(c, name, args = {}) {
  const r = await c.callTool({ name, arguments: args });
  assert(!r.isError, JSON.stringify(r.structuredContent));
  return r.structuredContent;
}
try {
  const real = await connect(false);
  assert.equal((await real.listTools()).tools.length, 19);
  assert.equal(
    (await call(real, "rain_status")).authentication.configured,
    false,
  );
  assert.equal(
    (await real.callTool({ name: "rain_list_courses", arguments: {} }))
      .structuredContent.code,
    "AUTH_REQUIRED",
  );
  await real.close();
  const c = await connect(true);
  assert.equal((await call(c, "rain_list_courses")).courses.length, 1);
  assert.equal((await call(c, "rain_active_classrooms")).lessons.length, 1);
  const joined = await call(c, "rain_join_classroom", {
    lessonId: "lesson-1",
    durationMinutes: 1,
  });
  assert.equal(joined.receipt.status, "complete");
  monitorId = joined.monitor.id;
  const event = await call(c, "rain_wait_events", {
    jobId: monitorId,
    timeoutSeconds: 10,
  });
  assert(event.events.some((e) => e.data.kind === "question-published"));
  const questions = await call(c, "rain_questions", { lessonId: "lesson-1" });
  assert.equal(questions.items[0].id, "question-1");
  assert(!JSON.stringify(questions).includes("mock-local-token"));
  const requestId = randomUUID();
  const input = {
    lessonId: "lesson-1",
    questionId: "question-1",
    answer: ["B"],
    requestId,
  };
  const receipt = await call(c, "rain_submit_answer", input);
  assert.equal(receipt.status, "complete");
  assert.equal((await call(c, "rain_submit_answer", input)).id, requestId);
  assert.equal(
    (await call(c, "rain_operation_status", { id: requestId })).status,
    "complete",
  );
  const resources = await call(c, "rain_list_resources", {
    lessonId: "lesson-1",
  });
  assert.equal(resources.total, 1);
  assert(!JSON.stringify(resources).includes("https://"));
  const download = await call(c, "rain_download_resources", {
    lessonIds: ["lesson-1"],
    classroomId: "course-1",
    includeVideos: false,
    archive: true,
  });
  await c.close();
  const second = await connect(true);
  let job;
  for (let n = 0; n < 120; n++) {
    job = await call(second, "rain_job_status", { jobId: download.id });
    if (!["queued", "running"].includes(job.status)) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.equal(job.status, "complete", JSON.stringify(job));
  const result = job.result.results[0];
  assert.equal(result.files, 2);
  assert.equal(result.archive.uploaded, 2);
  const manifest = JSON.parse(await readFile(result.manifestPath, "utf8"));
  assert.equal(manifest.files.length, 2);
  assert(manifest.files.some((f) => f.kind === "pdf"));
  await call(second, "rain_stop_job", { jobId: monitorId });
  console.log(
    "PASS: 19 stdio tools, real unauthenticated mode, mock join/events/answer readback/idempotency, detached download/PDF/cloud archive.",
  );
} finally {
  if (monitorId) {
    const c = clients.at(-1);
    try {
      await call(c, "rain_stop_job", { jobId: monitorId });
    } catch {}
    await new Promise((r) => setTimeout(r, 1200));
  }
  await Promise.allSettled(clients.map((c) => c.close()));
  await rm(root, { recursive: true, force: true });
}
