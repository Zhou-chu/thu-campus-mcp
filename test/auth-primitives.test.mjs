import assert from "node:assert/strict";
import test from "node:test";
import { emailAllowed, emailDomain, normalizeEmail, allowedDomains } from "../lib/auth/email.mjs";
import { hashPassword, passwordProblem, verifyPassword } from "../lib/auth/password.mjs";
import { hashToken, issueToken, sameHash, SESSION_TTL_MS } from "../lib/auth/token.mjs";
import { createAuthService, AuthError } from "../lib/auth/service.mjs";

test("邮箱规范化与清华域名白名单", () => {
  assert.equal(normalizeEmail("  Foo@Mails.Tsinghua.EDU.cn "), "foo@mails.tsinghua.edu.cn");
  for (const bad of ["", "no-at", "a@", "@b.com", "a b@c.com", "a@b", "x".repeat(70) + "@mails.tsinghua.edu.cn"]) {
    assert.equal(normalizeEmail(bad), "", bad);
  }
  assert.equal(emailDomain("Foo@Mails.Tsinghua.edu.cn"), "mails.tsinghua.edu.cn");
  assert.equal(emailAllowed("foo@mails.tsinghua.edu.cn"), true);
  assert.equal(emailAllowed("foo@tsinghua.edu.cn"), true);
  assert.equal(emailAllowed("foo@fake.tsinghua.edu.cn"), false, "子域不能冒充");
  assert.equal(emailAllowed("foo@gmail.com"), false);
  assert.deepEqual(allowedDomains({ THU_CAMPUS_AUTH_EMAIL_DOMAINS: "a.edu, B.edu " }), ["a.edu", "b.edu"]);
  assert.ok(allowedDomains({}).includes("mails.tsinghua.edu.cn"));
});

test("密码哈希：同一密码两次盐不同，错误密码与损坏串都拒绝", async () => {
  assert.match(passwordProblem("short"), /至少/);
  assert.equal(passwordProblem("long-enough-pass"), "");
  const one = await hashPassword("long-enough-pass");
  const two = await hashPassword("long-enough-pass");
  assert.match(one, /^scrypt\$16384\$8\$1\$/);
  assert.notEqual(one, two, "随机盐让相同密码的哈希不同");
  assert.equal(await verifyPassword("long-enough-pass", one), true);
  assert.equal(await verifyPassword("wrong-password", one), false);
  assert.equal(await verifyPassword("long-enough-pass", "broken"), false);
  assert.equal(await verifyPassword("long-enough-pass", "scrypt$0$0$0$AAAA$AAAA"), false);
  assert.equal(await verifyPassword("long-enough-pass", null), false);
  await assert.rejects(() => hashPassword("x".repeat(201)), /最多/);
});

test("会话令牌：明文不重复，哈希稳定，过期时间固定", () => {
  const now = new Date("2026-11-23T00:00:00.000Z");
  const a = issueToken(now);
  const b = issueToken(now);
  assert.notEqual(a.token, b.token);
  assert.equal(a.hash, hashToken(a.token));
  assert.equal(a.hash.length, 64);
  assert.equal(Date.parse(a.expiresAt) - Date.parse(a.createdAt), SESSION_TTL_MS);
  assert.equal(sameHash(a.hash, a.hash), true);
  assert.equal(sameHash(a.hash, b.hash), false);
  assert.equal(sameHash("zz", "zz"), false);
});

function memoryStores() {
  const users = [];
  const sessions = [];
  let userSeq = 0;
  let sessionSeq = 0;
  return {
    users: {
      async findByEmail(email) { return users.find(user => user.email === email) || null; },
      async findById(id) { return users.find(user => user.id === id) || null; },
      async create({ email, passwordHash, createdAt }) {
        const user = { id: "u" + ++userSeq, email, passwordHash, createdAt };
        users.push(user);
        return user;
      },
    },
    sessions: {
      async create(row) { sessions.push({ id: "s" + ++sessionSeq, ...row }); },
      async findByTokenHash(hash) { return sessions.find(row => row.tokenHash === hash) || null; },
      async revoke(hash, at) {
        const row = sessions.find(item => item.tokenHash === hash);
        if (!row) return false;
        row.revokedAt = at;
        return true;
      },
      async revokeById(userId, id, at) {
        const row = sessions.find(item => item.id === id && item.userId === userId);
        if (!row) return false;
        row.revokedAt = at;
        return true;
      },
      async listByUser(userId) { return sessions.filter(row => row.userId === userId); },
      async touch(hash, at) { const row = sessions.find(item => item.tokenHash === hash); if (row) row.lastSeenAt = at; },
    },
  };
}

test("注册、登录、鉴权与登出的完整状态机", async () => {
  const stores = memoryStores();
  const auth = createAuthService({ ...stores, now: () => new Date("2026-11-23T00:00:00.000Z") });

  const registered = await auth.register({ email: "Foo@mails.tsinghua.edu.cn", password: "long-enough-pass", device: { label: "台式机", platform: "windows" } });
  assert.equal(registered.user.email, "foo@mails.tsinghua.edu.cn");
  assert.ok(registered.token);

  const authed = await auth.authenticate(registered.token);
  assert.equal(authed.user.email, "foo@mails.tsinghua.edu.cn");
  assert.equal((await auth.authenticate("not-a-token")), null);

  await assert.rejects(() => auth.register({ email: "foo@mails.tsinghua.edu.cn", password: "long-enough-pass" }), (error) => error.code === "EMAIL_TAKEN");
  await assert.rejects(() => auth.register({ email: "foo@gmail.com", password: "long-enough-pass" }), (error) => error.code === "EMAIL_DOMAIN_NOT_ALLOWED");
  await assert.rejects(() => auth.register({ email: "bad", password: "long-enough-pass" }), (error) => error.code === "INVALID_EMAIL");
  await assert.rejects(() => auth.register({ email: "bar@mails.tsinghua.edu.cn", password: "short" }), (error) => error.code === "WEAK_PASSWORD");

  const logged = await auth.login({ email: "FOO@mails.tsinghua.edu.cn", password: "long-enough-pass" });
  assert.ok(logged.token);
  await assert.rejects(() => auth.login({ email: "foo@mails.tsinghua.edu.cn", password: "wrong-password" }), (error) => error.code === "INVALID_CREDENTIALS");
  await assert.rejects(() => auth.login({ email: "nobody@mails.tsinghua.edu.cn", password: "long-enough-pass" }), (error) => error.code === "INVALID_CREDENTIALS");

  const list = await auth.listSessions(registered.user.id);
  assert.equal(list.length, 2);
  assert.equal(list[0].device, "台式机");
  assert.equal(await auth.revokeSession(registered.user.id, list[0].id), true);
  assert.equal((await auth.authenticate(registered.token)), null, "被撤销的会话立即失效");
  assert.equal(await auth.revokeSession("other-user", list[1].id), false);

  assert.equal(await auth.logout(logged.token), true);
  assert.equal(await auth.logout("missing"), false);
  assert.equal(await auth.authenticate(logged.token), null);
});

test("过期会话、停用账号与缺失存储参数都按规则拒绝", async () => {
  const stores = memoryStores();
  let now = new Date("2026-11-23T00:00:00.000Z");
  const auth = createAuthService({ ...stores, now: () => now });
  const registered = await auth.register({ email: "baz@mails.tsinghua.edu.cn", password: "long-enough-pass" });
  now = new Date("2027-01-01T00:00:00.000Z");
  assert.equal(await auth.authenticate(registered.token), null, "超过 TTL");

  const stores2 = memoryStores();
  const auth2 = createAuthService({ ...stores2 });
  const user = await auth2.register({ email: "qux@mails.tsinghua.edu.cn", password: "long-enough-pass" });
  const users = await stores2.users.findById(user.user.id);
  users.disabledAt = "2026-11-23T00:00:00.000Z";
  assert.equal(await auth2.authenticate(user.token), null, "停用账号不能继续用旧会话");
  await assert.rejects(() => auth2.login({ email: "qux@mails.tsinghua.edu.cn", password: "long-enough-pass" }), (error) => error.code === "ACCOUNT_DISABLED");

  assert.throws(() => createAuthService({}), TypeError);
  assert.ok(new AuthError("X", "y") instanceof Error);
});
test("边界形状：空配置、坏参数、空令牌与列表缺字段", async () => {
  assert.deepEqual(allowedDomains({ THU_CAMPUS_AUTH_EMAIL_DOMAINS: "  " }), allowedDomains({}));
  assert.equal(normalizeEmail("a@b..c"), "");
  assert.equal(normalizeEmail("x".repeat(65) + "@mails.tsinghua.edu.cn"), "");
  assert.equal(emailDomain("bad"), "");
  assert.equal(emailAllowed("bad"), false);
  assert.equal(await verifyPassword("long-enough-pass", "scrypt$1$8$1$AAAA$AAAA"), false, "非法 scrypt 参数返回 false");
  assert.equal(hashToken(""), hashToken(""));
  assert.equal(sameHash("zz", "zz"), false);
  assert.equal(sameHash("", ""), false);

  const stores = memoryStores();
  const auth = createAuthService({ ...stores });
  assert.equal(await auth.authenticate(""), null);
  assert.equal(await auth.authenticate(undefined), null);
  assert.equal(await auth.logout(""), false);
  const registered = await auth.register({ email: "edge@mails.tsinghua.edu.cn", password: "long-enough-pass" });
  const list = await auth.listSessions(registered.user.id);
  assert.equal(list[0].device, "");
  assert.equal(list[0].lastSeenAt, null);
  assert.equal(await auth.revokeSession(registered.user.id, "missing-session"), false);
});
