import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { newDb } from "pg-mem";
import { createPgStore } from "../lib/store/pg.mjs";
import { createAuthRepositories } from "../lib/store/auth-repo.mjs";
import { createUserDataRepositories } from "../lib/store/user-data-repo.mjs";
import { createChangeLog } from "../lib/store/changes-repo.mjs";
import { createTimetableRouter } from "../lib/app/timetable-router.mjs";
import { runWithUser } from "../lib/app/request-context.mjs";
import { createLocalTimetable } from "../lib/app/timetable-local.mjs";

async function boot(t) {
  const dir = await mkdtemp(path.join(tmpdir(), "campus-timetable-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const db = newDb({ autoCreateForeignKeyIndices: true });
  const store = createPgStore({ pool: new (db.adapters.createPg().Pool)() });
  await store.migrate();
  const auth = createAuthRepositories(store);
  const user = await auth.users.create({ email: "tt@mails.tsinghua.edu.cn", passwordHash: "hash" });
  const other = await auth.users.create({ email: "tt2@mails.tsinghua.edu.cn", passwordHash: "hash" });
  const repos = { ...auth, ...createUserDataRepositories(store), changes: createChangeLog(store) };
  const fileStore = createLocalTimetable(path.join(dir, "timetable-local.json"));
  return { store, repos, user, other, fileStore };
}

test("课表覆盖层按用户存库：自定义课程与隐藏时段都隔离", async t => {
  const { repos, user, other, fileStore } = await boot(t);
  const mine = createTimetableRouter({ store: { repos }, fileStore, userId: () => user.id });
  const theirs = createTimetableRouter({ store: { repos }, fileStore, userId: () => other.id });

  const added = await mine.add({ name: "自选课", day: 2, from: 3, to: 4, location: "六教" });
  assert.equal(added.ok, true);
  const snap = await mine.snapshot();
  assert.equal(snap.custom.length, 1);
  assert.equal(snap.custom[0].name, "自选课");
  assert.equal((await theirs.snapshot()).custom.length, 0);

  assert.equal((await mine.hide({ courseId: "official-1", day: 2, from: 3 })).ok, true);
  assert.equal((await mine.snapshot()).hidden.length, 1);
  assert.equal((await theirs.snapshot()).hidden.length, 0);
  assert.equal((await theirs.remove(added.course.id)).ok, false);
  assert.equal((await mine.remove(added.course.id)).ok, true);
  assert.equal((await mine.snapshot()).custom.length, 0);
  assert.equal((await mine.unhide({ courseId: "official-1", day: 2, from: 3 })).changed, true);

  const changes = await repos.changes.list(user.id);
  assert.ok(changes.some(item => item.entity === "timetable"), "课表变更进入同步日志");
});

test("未登录时继续使用本机文件", async t => {
  const { repos, fileStore } = await boot(t);
  const router = createTimetableRouter({ store: { repos }, fileStore, userId: () => null });
  assert.equal((await router.add({ name: "本地课", day: 1, from: 1, to: 2 })).ok, true);
  const snap = await router.snapshot();
  assert.equal(snap.custom.length, 1);
  assert.equal(snap.custom[0].name, "本地课");
});

test("运行在用户上下文里时按当前用户读取", async t => {
  const { repos, user, fileStore } = await boot(t);
  const router = createTimetableRouter({ store: { repos }, fileStore });
  await runWithUser(user.id, async () => {
    const result = await router.add({ name: "上下文课", day: 3, from: 2, to: 2 });
    assert.equal(result.ok, true);
    assert.equal((await router.snapshot()).custom[0].name, "上下文课");
  });
});