import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
const root = await mkdtemp(path.join(tmpdir(), "thu-cloud-smoke-"));
const rid = "11111111-1111-4111-8111-111111111111";
const cli = path.resolve("dist/cli.js");
async function connect(mock) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [cli, "serve"],
    env: {
      ...process.env,
      THU_CLOUD_STATE_DIR: path.join(root, mock ? "mock" : "real"),
      THU_CLOUD_OUTPUT_DIR: path.join(root, "output"),
      THU_CLOUD_MOCK: mock ? "1" : "0",
    },
    stderr: "pipe",
  });
  const client = new Client({ name: "smoke", version: "1.0" });
  await client.connect(transport);
  return client;
}
async function call(client, name, args = {}) {
  const r = await client.callTool({ name, arguments: args });
  assert(!r.isError, JSON.stringify(r.structuredContent));
  return r.structuredContent;
}
let real, mock;
try {
  real = await connect(false);
  assert.equal((await real.listTools()).tools.length, 20);
  assert.equal(
    (await call(real, "cloud_status")).authentication.configured,
    false,
  );
  assert.equal(
    (await real.callTool({ name: "cloud_list_libraries", arguments: {} }))
      .structuredContent.code,
    "AUTH_REQUIRED",
  );
  await real.close();
  real = undefined;
  mock = await connect(true);
  assert.equal((await mock.listTools()).tools.length, 20);
  assert.equal((await call(mock, "cloud_status")).mode, "mock");
  assert.equal((await call(mock, "cloud_list_libraries")).libraries[0].id, rid);
  assert(
    (
      await call(mock, "cloud_read_file", { repoId: rid, path: "/README.txt" })
    ).content.includes("模拟"),
  );
  assert.equal(
    (await call(mock, "cloud_create_directory", { repoId: rid, path: "/测试" }))
      .status,
    "complete",
  );
  const local = path.join(root, "binary.bin");
  const bytes = Buffer.from([0, 255, 13, 10, 128, 0]);
  await writeFile(local, bytes);
  const requestId = randomUUID();
  const input = {
    repoId: rid,
    path: "/测试/binary.bin",
    filePath: local,
    requestId,
  };
  const upload = await call(mock, "cloud_upload_file", input);
  assert.equal(upload.status, "complete");
  assert.equal((await call(mock, "cloud_upload_file", input)).id, upload.id);
  assert.equal(
    (await call(mock, "cloud_operation_status", { id: requestId })).status,
    "complete",
  );
  const down = await call(mock, "cloud_download_file", {
    repoId: rid,
    path: "/测试/binary.bin",
    outputDir: path.join(root, "down"),
  });
  assert.deepEqual(await readFile(down.filePath), bytes);
  assert.equal(
    (
      await call(mock, "cloud_rename_item", {
        repoId: rid,
        path: "/测试/binary.bin",
        name: "renamed.bin",
      })
    ).status,
    "complete",
  );
  assert.equal(
    (
      await call(mock, "cloud_copy_item", {
        repoId: rid,
        path: "/测试/renamed.bin",
        destinationRepoId: rid,
        destinationDirectory: "/",
      })
    ).status,
    "complete",
  );
  await call(mock, "cloud_create_directory", { repoId: rid, path: "/dest" });
  assert.equal(
    (
      await call(mock, "cloud_move_item", {
        repoId: rid,
        path: "/renamed.bin",
        destinationRepoId: rid,
        destinationDirectory: "/dest",
      })
    ).status,
    "complete",
  );
  assert.equal(
    (
      await call(mock, "cloud_create_share_link", {
        repoId: rid,
        path: "/dest/renamed.bin",
        expireDays: 1,
      })
    ).status,
    "complete",
  );
  assert(
    (await call(mock, "cloud_search", { query: "README" })).results.length > 0,
  );
  assert(
    (await call(mock, "cloud_list_directory", { repoId: rid, path: "/" }))
      .total >= 3,
  );
  const job = await call(mock, "cloud_sync", {
    repoId: rid,
    path: "/dest",
    direction: "download",
    localDir: path.join(root, "batch"),
  });
  await mock.close();
  mock = undefined;
  // The detached worker must finish even after its initiating MCP process has closed.
  mock = await connect(true);
  let status;
  for (let i = 0; i < 100; i++) {
    status = await call(mock, "cloud_sync_status", { id: job.id });
    if (!["queued", "running"].includes(status.status)) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.equal(status.status, "complete", JSON.stringify(status));
  assert.deepEqual(
    await readFile(path.join(root, "batch", "renamed.bin")),
    bytes,
  );
  console.log(
    "PASS: 20 tools; unauthenticated real mode; mock binary roundtrip, mutations, idempotency and detached sync.",
  );
} finally {
  await real?.close();
  await mock?.close();
  await rm(root, { recursive: true, force: true });
}
