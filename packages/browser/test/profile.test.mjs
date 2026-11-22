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
test("browser checkpoint retains only previously saved, unvisited origins absent from its export", async () => {
  const { preserveUnvisitedOrigins } = await import("../profile.mjs");
  const seat = { origin: "https://seat.lib.tsinghua.edu.cn", localStorage: [{ name: "area", value: "35" }] };
  const other = { origin: "https://www.sports.tsinghua.edu.cn", localStorage: [{ name: "token", value: "fixture-only" }] };
  const oldSeat = { ...seat, localStorage: [{ name: "area", value: "22" }] };
  const current = { cookies: [], origins: [seat] };
  const previous = { cookies: [{ name: "old-cookie" }], origins: [oldSeat, other] };
  assert.deepEqual(preserveUnvisitedOrigins(current, previous, new Set([seat.origin])), { cookies: [], origins: [seat, other] });
  assert.equal(preserveUnvisitedOrigins(current, previous, new Set([other.origin])), current);
  assert.equal(preserveUnvisitedOrigins(current, undefined, new Set()), current);
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
