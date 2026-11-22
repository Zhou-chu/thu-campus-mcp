import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

test("rotateDesktopToken 改写桌面配置并保留端口，旧值不再出现", async () => {
  const { rotateDesktopToken } = await import("../launcher.mjs");
  const dir = await mkdtemp(path.join(tmpdir(), "desktop-rotate-"));
  const file = path.join(dir, "desktop.json");
  try {
    await writeFile(file, JSON.stringify({ port: 8971, token: "old-token-value", createdAt: "2026-11-01T00:00:00.000Z" }));
    const result = await rotateDesktopToken({ dir });
    assert.equal(result.rotated, true);
    assert.equal(result.file, file);
    assert.notEqual(result.token, "old-token-value");
    const saved = JSON.parse(await readFile(file, "utf8"));
    assert.equal(saved.port, 8971);
    assert.equal(saved.token, result.token);
    assert.equal(saved.createdAt, "2026-11-01T00:00:00.000Z");
    assert.equal(typeof saved.rotatedAt, "string");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("没有桌面配置时只给新值，不假装已经轮换", async () => {
  const { rotateDesktopToken } = await import("../launcher.mjs");
  const dir = await mkdtemp(path.join(tmpdir(), "desktop-rotate-empty-"));
  const previous = process.env.THU_CAMPUS_APP_TOKEN;
  try {
    delete process.env.THU_CAMPUS_APP_TOKEN;
    const none = await rotateDesktopToken({ dir });
    assert.equal(none.rotated, false);
    assert.match(none.reason, /桌面配置/);
    assert.ok(none.token.length >= 32);

    process.env.THU_CAMPUS_APP_TOKEN = "fixture-env-token";
    const env = await rotateDesktopToken({ dir });
    assert.equal(env.rotated, false);
    assert.match(env.reason, /环境变量/);
  } finally {
    if (previous === undefined) delete process.env.THU_CAMPUS_APP_TOKEN;
    else process.env.THU_CAMPUS_APP_TOKEN = previous;
    await rm(dir, { recursive: true, force: true });
  }
});