import assert from "node:assert/strict";
import test from "node:test";
import { newDb } from "pg-mem";
import { createPgStore } from "../lib/store/pg.mjs";
import { createAuthRepositories } from "../lib/store/auth-repo.mjs";
import { createChangeLog } from "../lib/store/changes-repo.mjs";

async function boot() {
  const db = newDb({ autoCreateForeignKeyIndices: true });
  const store = createPgStore({ pool: new (db.adapters.createPg().Pool)() });
  const migrations = await store.migrate();
  const user = await createAuthRepositories(store).users.create({ email: "sync@mails.tsinghua.edu.cn", passwordHash: "hash" });
  const other = await createAuthRepositories(store).users.create({ email: "sync2@mails.tsinghua.edu.cn", passwordHash: "hash" });
  return { store, user, other, changes: createChangeLog(store), migrations };
}

test("变更日志按用户单调递增、可分页拉取", async () => {
  const { changes, user, other, migrations } = await boot();
  assert.deepEqual(migrations, [1, 2, 3]);
  assert.equal(await changes.latest(user.id), 0);
  const first = await changes.append({ userId: user.id, entity: "chat_session", entityId: "s1", op: "create", payload: { title: "新对话" } });
  const second = await changes.append({ userId: user.id, entity: "chat_message", entityId: "m1", op: "append", payload: { role: "user" } });
  const otherFirst = await changes.append({ userId: other.id, entity: "chat_session", entityId: "x", op: "create" });
  assert.equal(first.seq, 1);
  assert.equal(second.seq, 2);
  assert.equal(otherFirst.seq, 1, "每个用户独立计数");
  assert.equal(await changes.latest(user.id), 2);
  assert.deepEqual((await changes.list(user.id)).map(item => item.seq), [1, 2]);
  assert.deepEqual((await changes.list(user.id, { since: 1 })).map(item => item.entityId), ["m1"]);
  assert.deepEqual((await changes.list(user.id, { since: 0, limit: 1 })).map(item => item.seq), [1]);
  assert.equal((await changes.list(other.id)).length, 1);
  assert.deepEqual(first.payload, { title: "新对话" });
  assert.equal(first.createdAt.endsWith("Z"), true);
});

test("删除用户级联清理变更日志", async () => {
  const { changes, user, store } = await boot();
  await changes.append({ userId: user.id, entity: "settings", entityId: "theme", op: "set", payload: { value: "dark" } });
  await store.query("delete from users where id = $1", [user.id]);
  assert.equal((await changes.list(user.id)).length, 0);
});
