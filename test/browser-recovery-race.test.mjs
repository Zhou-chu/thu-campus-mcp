import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { AuthStore } from "../packages/thu-cloud/dist/auth.js";
test("logout after recovery validation is rejected before starting browser", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "campus-recovery-logout-"));
  const original = {
    state: process.env.THU_CLOUD_STATE_DIR,
    runtime: process.env.THU_BROWSER_RUNTIME_DIR,
  };
  try {
    process.env.THU_CLOUD_STATE_DIR = path.join(dir, "auth");
    process.env.THU_BROWSER_RUNTIME_DIR = path.join(dir, "missing-runtime");
    const store = new AuthStore(process.env.THU_CLOUD_STATE_DIR);
    await store.save({
      account: "A",
      token: "synthetic-token",
      mode: "account",
    });
    const guard = {
      accountId: (await store.status()).accountId,
      epoch: await store.generation(),
      version: await store.version(),
    };
    await store.clear();
    const { loginService } = await import("../lib/browser.mjs");
    await assert.rejects(
      loginService("cloud", { headless: true, guard }),
      (e) => e.code === "AUTH_CHANGED",
    );
    assert.equal(await store.load(), undefined);
  } finally {
    if (original.state === undefined) delete process.env.THU_CLOUD_STATE_DIR;
    else process.env.THU_CLOUD_STATE_DIR = original.state;
    if (original.runtime === undefined)
      delete process.env.THU_BROWSER_RUNTIME_DIR;
    else process.env.THU_BROWSER_RUNTIME_DIR = original.runtime;
    await rm(dir, { recursive: true, force: true });
  }
});
test("a different browser target returns explicit busy instead of reusing wrong login", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "campus-browser-target-")),
    prior = process.env.THU_BROWSER_STATE_DIR;
  try {
    process.env.THU_BROWSER_STATE_DIR = dir;
    await mkdir(path.join(dir, "jobs"));
    const id = "11111111-1111-4111-8111-111111111111";
    await writeFile(
      path.join(dir, "jobs", id + ".json"),
      JSON.stringify({
        id,
        action: "login",
        service: "learnx",
        account: "A",
        status: "running",
        pid: process.pid,
        updatedAt: new Date().toISOString(),
      }),
    );
    const { startBrowserJob } = await import("../lib/browser.mjs");
    const r = await startBrowserJob("login", "cloud");
    assert.equal(r.status, "busy");
    assert.equal(r.reused, false);
    assert.equal(r.requiresClose, true);
  } finally {
    if (prior === undefined) delete process.env.THU_BROWSER_STATE_DIR;
    else process.env.THU_BROWSER_STATE_DIR = prior;
    await rm(dir, { recursive: true, force: true });
  }
});
