import { test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { root } from "../lib/services.mjs";
test("one MCP entry forwards all47 tools, browser lifecycle and rain prompt", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "campus-gateway-"));
  const client = new Client({ name: "gateway-test", version: "1" });
  try {
    const env = {
      ...process.env,
      THU_CAMPUS_MOCK: "1",
      THU_BROWSER_STATE_DIR: path.join(dir, "browser"),
      THU_BROWSER_RUNTIME_DIR: path.join(dir, "runtime"),
    };
    for (const prefix of ["LEARNX", "THU_CLOUD", "HETANG"])
      Object.assign(env, {
        [prefix + "_MOCK"]: "1",
        [prefix + "_STATE_DIR"]: path.join(dir, prefix),
        [prefix + "_OUTPUT_DIR"]: path.join(dir, "output", prefix),
      });
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [path.join(root, "bin/thu-campus.mjs"), "serve"],
        env,
        stderr: "pipe",
      }),
    );
    const tools = (await client.listTools()).tools;
    assert.equal(tools.length, 53);
    assert.equal(new Set(tools.map((t) => t.name)).size, 53);
    assert(tools.some((t) => t.name === "madmodel_status"));
    assert(tools.some((t) => t.name === "madmodel_models"));
    const courses = await client.callTool({
      name: "learn_list_courses",
      arguments: {},
    });
    assert.equal(JSON.parse(courses.content[0].text).total, 2);
    const cloud = await client.callTool({
      name: "cloud_status",
      arguments: {},
    });
    assert.equal(cloud.structuredContent.mode, "mock");
    const rain = await client.callTool({
      name: "rain_list_courses",
      arguments: {},
    });
    assert.equal(rain.structuredContent.courses.length, 1);
    const browser = await client.callTool({
      name: "campus_browser_status",
      arguments: {},
    });
    assert.equal(browser.structuredContent.runtime.installed, false);
    assert(
      (await client.listPrompts()).prompts.some(
        (p) => p.name === "attend_and_answer",
      ),
    );
  } finally {
    await client.close();
    await rm(dir, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 200,
    });
  }
});
test("recovery retries one read only and never replays writes or unknown outcomes", async () => {
  const { invokeWithRecovery } = await import("../lib/gateway.mjs");
  for (const readOnly of [true, false]) {
    let calls = 0,
      recoveries = 0;
    const result = await invokeWithRecovery(
      { annotations: { readOnlyHint: readOnly } },
      async () => {
        calls++;
        return calls === 1
          ? {
              isError: true,
              content: [{ type: "text", text: '{"code":"AUTH_REQUIRED"}' }],
            }
          : { content: [{ type: "text", text: "{}" }] };
      },
      async () => {
        recoveries++;
        return true;
      },
    );
    assert.equal(calls, readOnly ? 2 : 1);
    assert.equal(recoveries, readOnly ? 1 : 0);
    assert.equal(Boolean(result.isError), !readOnly);
  }
  let calls = 0;
  await invokeWithRecovery(
    { annotations: { readOnlyHint: true } },
    async () => {
      calls++;
      return {
        isError: true,
        structuredContent: { code: "WRITE_UNKNOWN" },
        content: [],
      };
    },
    async () => {
      throw new Error("must not restore");
    },
  );
  assert.equal(calls, 1);
});
