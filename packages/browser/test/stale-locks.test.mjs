import assert from "node:assert/strict";
import { mkdtemp, mkdir, utimes, writeFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { clearStaleLocks } from "../profile.mjs";

test("clearStaleLocks: 只清掉超时的租约目录，保留进行中的", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "thu-locks-"));
  const locks = path.join(root, "locks");
  await mkdir(path.join(locks, "old-lock"), { recursive: true });
  await mkdir(path.join(locks, "live-lock"), { recursive: true });
  await writeFile(path.join(locks, "old-lock", "meta"), "x");
  const now = Date.now();
  const old = new Date(now - 61 * 60 * 1000);
  await utimes(path.join(locks, "old-lock"), old, old);

  const removed = await clearStaleLocks(root, { now, ttlMs: 10 * 60 * 1000 });
  assert.equal(removed, 1);
  assert.deepEqual((await readdir(locks)).sort(), ["live-lock"]);
});

test("clearStaleLocks: 目录不存在时安静返回 0", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "thu-locks-empty-"));
  assert.equal(await clearStaleLocks(root), 0);
});