import assert from "node:assert/strict";
import test from "node:test";
import { newDb } from "pg-mem";
import { createPgStore } from "../lib/store/pg.mjs";
import { createAuthRepositories } from "../lib/store/auth-repo.mjs";
import { createUserDataRepositories } from "../lib/store/user-data-repo.mjs";
import { createChangeLog } from "../lib/store/changes-repo.mjs";
import { createPgSessionStore } from "../lib/app/pg-sessions.mjs";

async function boot() {
  const db = newDb({ autoCreateForeignKeyIndices: true });
  const store = createPgStore({ pool: new (db.adapters.createPg().Pool)() });
  await store.migrate();
  const auth = createAuthRepositories(store);
  const user = await auth.users.create({ email: "chat@mails.tsinghua.edu.cn", passwordHash: "hash" });
  const repos = { ...auth, ...createUserDataRepositories(store), changes: createChangeLog(store) };
  return { store, user, repos };
}

test("数据库会话存储：两台设备看到同一份会话与消息", async () => {
  const { user, repos } = await boot();
  const deviceA = createPgSessionStore({ repos, userId: user.id });
  const deviceB = createPgSessionStore({ repos, userId: user.id });

  const created = await deviceA.create({ title: "多设备" });
  assert.equal(created.title, "多设备");
  await deviceA.append(created.id, [{ role: "user", content: "从台式机发的", at: 1 }], { title: "多设备" });
  await deviceA.append(created.id, [{ role: "assistant", content: "收到", reasoning: "思考" }]);

  const seen = await deviceB.list();
  assert.equal(seen.length, 1);
  assert.equal(seen[0].messageCount, 2);
  const full = await deviceB.get(created.id);
  assert.deepEqual(full.messages.map(item => item.role), ["user", "assistant"]);
  assert.deepEqual(full.messages[1], { role: "assistant", content: "收到", reasoning: "思考" });

  await deviceB.rename(created.id, "改自手机");
  assert.equal((await deviceA.get(created.id)).title, "改自手机");
  await assert.rejects(() => deviceB.rename(created.id, "   "), (error) => error.code === "INVALID_ARGUMENTS");
  await assert.rejects(() => deviceB.append("00000000-0000-4000-8000-000000000000", [{ role: "user", content: "x" }]), (error) => error.code === "SESSION_NOT_FOUND");

  assert.equal(await deviceB.remove(created.id), true);
  assert.equal(await deviceA.get(created.id), undefined);
  assert.equal((await deviceA.list()).length, 0);
});

test("会话写入同时产生变更日志，供另一台设备增量拉取", async () => {
  const { user, repos } = await boot();
  const device = createPgSessionStore({ repos, userId: user.id });
  const session = await device.create({ title: "同步" });
  await device.append(session.id, [{ role: "user", content: "一" }, { role: "assistant", content: "二" }]);
  await device.rename(session.id, "同步改名");
  const changes = await repos.changes.list(user.id);
  assert.deepEqual(changes.map(item => `${item.entity}/${item.op}`), [
    "chat_session/create",
    "chat_message/append",
    "chat_message/append",
    "chat_session/rename",
  ]);
  const tail = await repos.changes.list(user.id, { since: 2 });
  assert.deepEqual(tail.map(item => item.op), ["append", "rename"]);
});

test("不同用户的数据互相隔离，列表只返回自己的会话", async () => {
  const { user, repos } = await boot();
  const other = await repos.users.create({ email: "other-chat@mails.tsinghua.edu.cn", passwordHash: "hash" });
  const mine = createPgSessionStore({ repos, userId: user.id });
  const theirs = createPgSessionStore({ repos, userId: other.id });
  const session = await mine.create({ title: "我的" });
  assert.equal((await theirs.list()).length, 0);
  assert.equal(await theirs.get(session.id), undefined);
  assert.equal(await theirs.remove(session.id), false);
  assert.equal((await mine.list()).length, 1);
});