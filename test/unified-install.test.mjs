import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { root } from "../lib/services.mjs";
test("single-entry migration preserves auth/output paths and unrelated settings in all client formats", async () => {
  const { installUnified } = await import("../lib/unified-install.mjs");
  const dir = await mkdtemp(path.join(tmpdir(), "campus-unified-install-"));
  try {
    const home = path.join(dir, "home"),
      harnessHome = path.join(dir, "harness");
    await mkdir(path.join(home, ".codex"), { recursive: true });
    await mkdir(path.join(home, ".gemini/antigravity"), { recursive: true });
    await mkdir(harnessHome);
    const { installBundle } = await import("../lib/install.mjs");
    await writeFile(
      path.join(home, ".claude.json"),
      JSON.stringify({
        theme: "keep",
        mcpServers: { other: { command: "untouched" } },
      }),
    );
    await writeFile(
      path.join(home, ".codex/config.toml"),
      '# user comment\nmodel="keep"\n',
    );
    await writeFile(
      path.join(home, ".gemini/antigravity/mcp_config.json"),
      "{}",
    );
    await installBundle({
      apply: true,
      home,
      harnessHome,
      stateRoot: path.join(dir, "auth"),
    });
    const beforeUninstall = await readFile(
      path.join(home, ".codex/config.toml"),
      "utf8",
    );
    await installUnified({ apply: true, uninstall: true, home, harnessHome });
    assert.equal(
      await readFile(path.join(home, ".codex/config.toml"), "utf8"),
      beforeUninstall,
    );
    const report = await installUnified({ apply: true, home, harnessHome });
    assert.equal(report.clients.length, 5);
    const data = JSON.parse(
      await readFile(path.join(home, ".claude.json"), "utf8"),
    );
    assert.deepEqual(Object.keys(data.mcpServers).sort(), [
      "other",
      "thu-campus",
    ]);
    assert.equal(data.theme, "keep");
    const entry = data.mcpServers["thu-campus"];
    assert.equal(entry.args[0], path.join(root, "bin/thu-campus.mjs"));
    assert.equal(entry.env.LEARNX_STATE_DIR, path.join(dir, "auth/learnx"));
    assert.equal(
      entry.env.THU_CLOUD_STATE_DIR,
      path.join(dir, "auth/thu-cloud"),
    );
    assert(entry.env.THU_BROWSER_STATE_DIR);
    assert(
      (await readFile(path.join(home, ".codex/config.toml"), "utf8")).includes(
        "# user comment",
      ),
    );
    assert(
      (await installUnified({ apply: true, home, harnessHome })).clients.every(
        (c) => !c.changed,
      ),
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test("unknown service owner blocks every configuration write before backup/apply", async () => {
  const { installUnified } = await import("../lib/unified-install.mjs");
  const dir = await mkdtemp(path.join(tmpdir(), "campus-unified-foreign-"));
  try {
    const file = path.join(dir, ".claude.json"),
      text = JSON.stringify({
        mcpServers: {
          learnx: { command: "foreign", args: ["D:/unknown/cli.js", "serve"] },
        },
      });
    await writeFile(file, text);
    await assert.rejects(
      installUnified({
        apply: true,
        home: dir,
        harnessHome: path.join(dir, "absent"),
      }),
      (e) => e.code === "INSTALL_CONFLICT",
    );
    assert.equal(await readFile(file, "utf8"), text);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
