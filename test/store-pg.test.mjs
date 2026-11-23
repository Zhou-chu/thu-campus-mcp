import assert from "node:assert/strict";
import test from "node:test";
import { newDb } from "pg-mem";
import { createPgStore, databaseConfig, iso, StoreError } from "../lib/store/pg.mjs";
import { createAuthRepositories } from "../lib/store/auth-repo.mjs";
import { openStore } from "../lib/store/index.mjs";

function memoryPool() {
  const db = newDb({ autoCreateForeignKeyIndices: true });
  const adapter = db.adapters.createPg();
  return new adapter.Pool();
}

async function freshStore() {
  const store = createPgStore({ pool: memoryPool() });
  await store.migrate();
  return store;
}

test("连接配置：只接受 postgres 连接串，缺失返回 null", () => {
  assert.equal(databaseConfig({}), null);
  assert.equal(databaseConfig({ THU_CAMPUS_DATABASE_URL: "postgres://u@h/db" }).connectionString, "postgres://u@h/db");
  assert.equal(databaseConfig({ DATABASE_URL: "postgresql://u@h/db" }).max, 10);
  assert.equal(databaseConfig({ DATABASE_URL: "postgres://u@h/db", DATABASE_POOL_MAX: "3", DATABASE_CONNECT_TIMEOUT_MS: "5000" }).max, 3);
  assert.deepEqual(databaseConfig({ DATABASE_URL: "postgres://u@h/db", DATABASE_SSL: "require" }).ssl, { rejectUnauthorized: false });
  assert.throws(() => databaseConfig({ DATABASE_URL: "mysql://u@h/db" }), (error) => error.code === "INVALID_DATABASE_URL");
  assert.equal(iso(null), null);
  assert.equal(iso(new Date("2026-11-23T00:00:00.000Z")), "2026-11-23T00:00:00.000Z");
  assert.equal(iso("x"), "x");
});

test("迁移幂等，健康检查可用，SQL 错误转成可读错误", async () => {
  const store = createPgStore({ pool: memoryPool() });
  assert.deepEqual(await store.migrate(), [1, 2, 3]);
  assert.deepEqual(await store.migrate(), []);
  assert.equal(await store.healthy(), true);
  await assert.rejects(() => store.query("select * from missing_table"), (error) => error instanceof StoreError && error.code === "DATABASE_ERROR");
  await store.close();
});

test("账号仓库：注册、登录、会话撤销与设备管理跑在真实 SQL 上", async () => {
  const pool = memoryPool();
  const store = createPgStore({ pool, now: () => new Date("2026-11-23T00:00:00.000Z") });
  await store.migrate();
  const { auth, repos } = await openStore({ pool, now: () => new Date("2026-11-23T00:00:00.000Z") });

  const registered = await auth.register({ email: "Foo@mails.tsinghua.edu.cn", password: "long-enough-pass", device: { label: "台式机", platform: "windows" } });
  assert.equal(registered.user.email, "foo@mails.tsinghua.edu.cn");
  assert.ok(registered.token);

  const authed = await auth.authenticate(registered.token);
  assert.equal(authed.user.email, "foo@mails.tsinghua.edu.cn");
  const sessions = await auth.listSessions(registered.user.id);
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].device, "台式机");
  assert.ok(sessions[0].lastSeenAt, "鉴权会刷新最近使用时间");

  const logged = await auth.login({ email: "foo@mails.tsinghua.edu.cn", password: "long-enough-pass" });
  assert.equal((await auth.listSessions(registered.user.id)).length, 2);
  assert.equal(await auth.logout(logged.token), true);
  assert.equal(await auth.authenticate(logged.token), null);

  const all = await auth.listSessions(registered.user.id);
  const active = all.find(item => !item.revoked);
  assert.equal(await auth.revokeSession(registered.user.id, active.id), true);
  assert.equal(await auth.authenticate(registered.token), null);

  await assert.rejects(() => repos.users.create({ email: "foo@mails.tsinghua.edu.cn", passwordHash: "x" }), (error) => error.code === "CONFLICT");
  await assert.rejects(() => repos.sessions.create({ userId: "missing", tokenHash: "h", createdAt: "2026-11-23T00:00:00.000Z", expiresAt: "2026-12-23T00:00:00.000Z" }), (error) => error.code === "FOREIGN_KEY");

  const device = await repos.devices.register({ userId: registered.user.id, name: "手机", platform: "android" });
  assert.equal((await repos.devices.listByUser(registered.user.id))[0].name, "手机");
  assert.equal(await repos.devices.touch(device.id, "2026-11-24T00:00:00.000Z"), true);
  assert.equal(await repos.devices.revoke(registered.user.id, device.id), true);
  assert.equal(await repos.devices.revoke("other", device.id), false);

  assert.equal(await repos.sessions.deleteExpired("2027-01-01T00:00:00.000Z"), 2, "过期会话可清理");
  await store.close();
});

test("没有 DATABASE_URL 时明确返回 null，连接串非法直接报错", async () => {
  assert.equal(await openStore({ env: {} }), null);
  await assert.rejects(() => openStore({ env: { DATABASE_URL: "not-a-url" } }), (error) => error.code === "INVALID_DATABASE_URL");
});