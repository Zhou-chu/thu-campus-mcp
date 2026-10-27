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
it("previews already delivered unpublished questions only when requested, omits answers, and still refuses submission", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "hetang-preview-")),
    cfg = loadConfig({ stateDir: root, mock: true });
  const { MockRain } = await import("../src/mock.js"),
    mock = new MockRain(cfg);
  await mock.join("lesson-1");
  await mock.updateState("lesson-1", (s) => {
    s!.questions.push({
      ...s!.questions[0],
      id: "draft-question",
      prompt: "unpublished body",
      published: false,
      answer: ["hidden-must-not-return"],
    });
    return s!;
  });
  const server = await createServer(cfg),
    [a, b] = InMemoryTransport.createLinkedPair(),
    client = new Client({ name: "preview-test", version: "1" });
  try {
    await server.connect(a);
    await client.connect(b);
    const ordinary = await client.callTool({
      name: "rain_questions",
      arguments: { lessonId: "lesson-1" },
    });
    expect((ordinary.structuredContent as any).items).toHaveLength(1);
    const preview = await client.callTool({
      name: "rain_questions",
      arguments: { lessonId: "lesson-1", includeUnpublished: true },
    });
    const items = (preview.structuredContent as any).items;
    expect(items).toHaveLength(2);
    expect(items.find((q: any) => q.id === "draft-question")).toMatchObject({
      published: false,
      prompt: "unpublished body",
    });
    expect(JSON.stringify(preview)).not.toContain("hidden-must-not-return");
    const submit = await client.callTool({
      name: "rain_submit_answer",
      arguments: {
        lessonId: "lesson-1",
        questionId: "draft-question",
        answer: ["A"],
      },
    });
    expect(JSON.stringify(submit)).toContain("NOT_PUBLISHED");
  } finally {
    await client.close();
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});
