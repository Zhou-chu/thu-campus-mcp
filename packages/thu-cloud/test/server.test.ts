import { it, expect, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createServer } from "../src/server.js";
import { loadConfig } from "../src/config.js";
it("discovers cloud tools without login and returns a safe authentication error", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "cloud-server-"));
  const server = await createServer(
    loadConfig({ stateDir: root, mock: false }),
  );
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "1" });
  try {
    await server.connect(a);
    await client.connect(b);
    const tools = (await client.listTools()).tools;
    expect(tools.length).toBe(20);
    expect(
      tools.find((t) => t.name === "cloud_upload_file")?.annotations
        ?.destructiveHint,
    ).toBe(true);
    expect(JSON.stringify(tools)).not.toMatch(
      /"(?:apiToken|authorization|cookie)"/i,
    );
    const result = await client.callTool({
      name: "cloud_list_libraries",
      arguments: {},
    });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({ code: "AUTH_REQUIRED" });
    const status = await client.callTool({
      name: "cloud_status",
      arguments: {},
    });
    expect(status.structuredContent).toMatchObject({
      authentication: { configured: false },
      mode: "real",
    });
  } finally {
    await client.close();
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});

it("keeps a rename collision race unknown instead of confirming an unrelated target", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "cloud-race-"));
  const cfg = loadConfig({ stateDir: path.join(root, "state"), mock: true });
  const { MockDrive, MOCK_REPO } = await import("../src/mock.js");
  const { TransferService } = await import("../src/transfer.js");
  const fs = await import("node:fs/promises");
  const d = new MockDrive(cfg);
  const f = path.join(root, "file");
  await fs.writeFile(f, "source");
  await new TransferService(d, cfg).upload({
    repoId: MOCK_REPO,
    path: "/old.txt",
    filePath: f,
  });
  const original = MockDrive.prototype.rename;
  vi.spyOn(MockDrive.prototype, "rename").mockImplementation(async function (
    this: InstanceType<typeof MockDrive>,
    id,
    p,
    name,
  ) {
    await original.call(this, id, p, "renamed (1).txt");
    await fs.writeFile(f, "unrelated");
    await new TransferService(this, cfg).upload({
      repoId: id,
      path: "/renamed.txt",
      filePath: f,
    });
    return { path: "/renamed (1).txt" };
  });
  const server = await createServer(cfg);
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "race-test", version: "1" });
  try {
    await server.connect(a);
    await client.connect(b);
    const r = await client.callTool({
      name: "cloud_rename_item",
      arguments: { repoId: MOCK_REPO, path: "/old.txt", name: "renamed.txt" },
    });
    expect(r.structuredContent).toMatchObject({ status: "unknown" });
  } finally {
    vi.restoreAllMocks();
    await client.close();
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});
