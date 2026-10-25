import { it, expect } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createServer } from "../src/server.js";
import { loadConfig } from "../src/config.js";
it("discovers tools without authentication and distinguishes read-only and write effects", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "hetang-mcp-"));
  const server = await createServer(
    loadConfig({ stateDir: root, mock: false }),
  );
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "1" });
  try {
    await server.connect(a);
    await client.connect(b);
    const tools = (await client.listTools()).tools;
    expect(tools.length).toBeGreaterThanOrEqual(17);
    expect(
      tools.find((t) => t.name === "rain_submit_answer")?.annotations
        ?.readOnlyHint,
    ).toBe(false);
    const r = await client.callTool({
      name: "rain_list_courses",
      arguments: {},
    });
    expect(r.isError).toBe(true);
    expect(r.structuredContent).toMatchObject({ code: "AUTH_REQUIRED" });
  } finally {
    await client.close();
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});
