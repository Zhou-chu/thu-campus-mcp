import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { installUnified } from "../lib/unified-install.mjs";
test("reinstall preserves disabled unified Harness and custom timeout", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "campus-unified-disabled-"));
  try {
    const home = path.join(dir, "home"),
      harnessHome = path.join(dir, "harness");
    await mkdir(home);
    await mkdir(harnessHome);
    await installUnified({ apply: true, home, harnessHome });
    const file = path.join(harnessHome, "@wingsky-1/dsh-mcp-manager/mcp.json");
    const data = JSON.parse(await readFile(file, "utf8"));
    data.servers[0].enabled = false;
    data.servers[0].toolCallTimeoutMs = 300000;
    await writeFile(file, JSON.stringify(data));
    await installUnified({ apply: true, home, harnessHome });
    const after = JSON.parse(await readFile(file, "utf8")).servers[0];
    assert.equal(after.enabled, false);
    assert.equal(after.toolCallTimeoutMs, 300000);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
