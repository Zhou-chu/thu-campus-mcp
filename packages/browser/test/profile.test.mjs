import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
test("reset refuses a preexisting profile without this tools ownership marker", async () => {
  const { resetBrowser } = await import("../index.mjs");
  const { mkdir, writeFile } = await import("node:fs/promises");
  const dir = await mkdtemp(path.join(tmpdir(), "campus-unowned-profile-"));
  try {
    await mkdir(path.join(dir, "profile"));
    await writeFile(path.join(dir, "profile", "private.txt"), "keep");
    await assert.rejects(
      resetBrowser({ stateDir: dir }),
      (e) => e.code === "BROWSER_UNOWNED_PROFILE",
    );
    assert.equal(
      await readFile(path.join(dir, "profile", "private.txt"), "utf8"),
      "keep",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test("profile lease rejects a second owner and survives reopen with encrypted session state", async () => {
  const { profileLease, saveSnapshot, readSnapshot } = await import(
    "../index.mjs"
  );
  const dir = await mkdtemp(path.join(tmpdir(), "campus-browser-test-"));
  try {
    const lease = await profileLease({ stateDir: dir });
    await assert.rejects(
      profileLease({ stateDir: dir }),
      (e) => e.code === "BROWSER_BUSY",
    );
    const state = {
      cookies: [
        {
          name: "example-session",
          value: "synthetic-browser-secret",
          domain: "example.test",
          path: "/",
          expires: -1,
          httpOnly: true,
          secure: true,
          sameSite: "Lax",
        },
      ],
      origins: [],
    };
    await saveSnapshot({ stateDir: dir }, state);
    assert(
      !(await readFile(path.join(dir, "session.dpapi"), "utf8")).includes(
        "synthetic-browser-secret",
      ),
    );
    await lease.release();
    const next = await profileLease({ stateDir: dir });
    assert.deepEqual(await readSnapshot({ stateDir: dir }), state);
    await next.release();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test("runtime manifest uses relative paths and rejects traversal", async () => {
  const { runtimeInfo } = await import("../index.mjs");
  const dir = await mkdtemp(path.join(tmpdir(), "campus-runtime-test-"));
  try {
    const { writeFile } = await import("node:fs/promises");
    await writeFile(
      path.join(dir, "browser.json"),
      JSON.stringify({
        relativeExecutable: "../outside.exe",
        revision: "1248",
      }),
    );
    await assert.rejects(
      runtimeInfo({ runtimeDir: dir }),
      (e) => e.code === "BROWSER_RUNTIME_INVALID",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
