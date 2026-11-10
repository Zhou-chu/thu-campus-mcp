import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
const protocol = await import("../lib/madmodel/protocol.mjs");
const auth = await import("../lib/madmodel/auth.mjs");
const { parseToken, discoverModels, validateCompletion } = protocol;
const { SessionManager, SessionStore } = auth;
const token = (account = "student", expires = Date.now() + 3600000) =>
  "header." +
  Buffer.from(
    JSON.stringify({
      zjh: account,
      exp: Math.floor(expires / 1000),
      iat: Math.floor(Date.now() / 1000),
    }),
  ).toString("base64url") +
  ".signature";
const session = () => ({ token: token(), ...parseToken(token()) });
class MemoryStore {
  value;
  revision = 0;
  async load() {
    return { revision: String(this.revision), data: this.value };
  }
  async save(data, revision) {
    if (revision !== String(this.revision))
      throw Object.assign(new Error("changed"), { code: "AUTH_CHANGED" });
    this.value = data;
    this.revision++;
    return data;
  }
}
function setup(options = {}) {
  const store = new MemoryStore();
  let logins = 0,
    verifies = 0;
  const manager = new SessionManager({
    store,
    login: async ({ previous }) => {
      logins++;
      return session();
    },
    verify: async () => {
      verifies++;
      return true;
    },
    ...options,
  });
  return { manager, store, counts: () => ({ logins, verifies }) };
}
test("JWT metadata binds the account and rejects malformed or expired-format tokens", () => {
  assert.equal(typeof parseToken, "function");
  const data = parseToken(token());
  assert.equal(data.account, "student");
  assert(data.expiresAt > Date.now());
  assert.throws(() => parseToken("not-a-token"));
  assert.throws(() =>
    parseToken(
      "h." + Buffer.from('{"exp":"tomorrow"}').toString("base64url") + ".s",
    ),
  );
});
test("model discovery reads current frontend catalog without evaluating scripts", () => {
  assert.equal(typeof discoverModels, "function");
  const script =
    'const X={modelList:[{value:"Model-A",supportImage:!0,effortOptions:["low","high"]},{value:"Model-B",supportImage:!1}]}';
  const result = discoverModels(script);
  assert.deepEqual(
    result.map((x) => x.id),
    ["Model-A", "Model-B"],
  );
  assert.throws(() => discoverModels("<html>not a catalog</html>"));
});
test("completion validator preserves multimodal and tool fields but rejects malformed envelopes", () => {
  assert.equal(typeof validateCompletion, "function");
  const body = {
    model: "A",
    messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    tools: [{ type: "function", function: { name: "f" } }],
    stream: true,
    reasoning_effort: "high",
  };
  assert.equal(validateCompletion(body), body);
  for (const value of [
    null,
    [],
    {},
    { model: "a", messages: [] },
    { model: "a", messages: [{}] },
    { model: "a", messages: [{ role: "user", content: "hi" }], stream: "yes" },
  ])
    assert.throws(() => validateCompletion(value));
});
test("concurrent cold calls merge into one login and a fresh session avoids browser work", async () => {
  assert.equal(typeof SessionManager, "function");
  const { manager, counts } = setup();
  await Promise.all(Array.from({ length: 12 }, () => manager.ensure()));
  assert.equal(counts().logins, 1);
  assert.equal((await manager.status()).configured, true);
  await manager.ensure();
  assert.equal(counts().logins, 1);
  assert(!JSON.stringify(await manager.status()).includes("signature"));
});
test("expired and revoked sessions refresh; periodic verification never invokes a model", async () => {
  assert.equal(typeof SessionManager, "function");
  let valid = true;
  const { manager, store, counts } = setup({ verify: async () => valid });
  await manager.ensure();
  store.value = { ...store.value, expiresAt: Date.now() - 1 };
  await manager.ensure();
  assert.equal(counts().logins, 2);
  valid = false;
  await manager.check();
  assert.equal(counts().logins, 3);
});
test("a token nearing expiry triggers renewal before request forwarding", async () => {
  assert.equal(typeof SessionManager, "function");
  const { manager, store, counts } = setup();
  await manager.ensure();
  store.value.expiresAt = Date.now() + 1000;
  await manager.ensure();
  assert.equal(counts().logins, 2);
});
test("late 401 responses reuse a replacement session instead of forcing another login", async () => {
  const { manager, counts } = setup();
  const original = await manager.ensure();
  const renewed = { ...session(), token: token() + "-renewed" };
  manager.login = async () => renewed;
  await manager.ensure({ force: true, rejectedToken: original.token });
  await manager.ensure({ force: true, rejectedToken: original.token });
  assert.equal(counts().logins, 1);
  let extra = 0;
  manager.login = async () => {
    extra++;
    return renewed;
  };
  await manager.ensure({ force: true, rejectedToken: original.token });
  assert.equal(extra, 0);
});
test("force renewal joining an ordinary verification still performs one login", async () => {
  for (const rejected of [true, false]) {
    const { manager, counts } = setup();
    const original = await manager.ensure();
    let release;
    manager.verify = () => new Promise((r) => (release = r));
    const check = manager.ensure({ verify: true });
    await new Promise((r) => setImmediate(r));
    const renew = manager.ensure({
      force: true,
      ...(rejected ? { rejectedToken: original.token } : {}),
    });
    release(true);
    await Promise.all([check, renew]);
    assert.equal(counts().logins, 2);
  }
});
test("one cancelled waiter does not cancel shared login for another caller", async () => {
  const { manager } = setup();
  let finish;
  const gate = new Promise((r) => (finish = r));
  manager.login = async () => {
    await gate;
    return session();
  };
  const control = new AbortController();
  const first = manager.ensure({ signal: control.signal });
  const second = manager.ensure();
  control.abort();
  await assert.rejects(first);
  finish();
  assert((await second).token);
});
test("logout wins over in-flight login and persists a disabled session", async () => {
  assert.equal(typeof SessionManager, "function");
  let finish;
  const pending = new Promise((r) => (finish = r));
  const { manager } = setup({
    login: async () => {
      await pending;
      return session();
    },
  });
  const login = manager.ensure();
  await new Promise((r) => setImmediate(r));
  await manager.logout();
  finish();
  await assert.rejects(login, { code: "AUTH_CHANGED" });
  await assert.rejects(manager.ensure(), { code: "AUTH_REQUIRED" });
  assert.equal((await manager.status()).configured, false);
});
test("a different browser account never overwrites the binding", async () => {
  assert.equal(typeof SessionManager, "function");
  const { manager, store } = setup({
    login: async () => ({
      token: token("other"),
      ...parseToken(token("other")),
    }),
  });
  store.value = session();
  await assert.rejects(manager.ensure({ force: true }), {
    code: "BROWSER_ACCOUNT_MISMATCH",
  });
  assert.equal(store.value.account, "student");
});
test("failed recovery is rate limited and caller cancellation is observed", async () => {
  assert.equal(typeof SessionManager, "function");
  let attempts = 0;
  const { manager } = setup({
    login: async () => {
      attempts++;
      throw Object.assign(new Error("login"), {
        code: "BROWSER_LOGIN_REQUIRED",
      });
    },
  });
  await assert.rejects(manager.ensure());
  await assert.rejects(manager.ensure());
  assert.equal(attempts, 1);
  const c = new AbortController();
  c.abort();
  await assert.rejects(manager.ensure({ signal: c.signal }));
});
test("verification transport and protocol failures are sanitized and rate limited", async () => {
  for (const failure of [
    new TypeError("private token must not leak"),
    Object.assign(new Error("private ticket"), { code: "UPSTREAM_PROTOCOL" }),
  ]) {
    const { manager, counts } = setup();
    await manager.ensure();
    let attempts = 0;
    manager.verify = async () => {
      attempts++;
      throw failure;
    };
    await assert.rejects(manager.check());
    await assert.rejects(manager.check());
    assert.equal(attempts, 1);
    const status = await manager.status();
    assert(status.lastError);
    assert(status.nextRetryAt);
    assert(!JSON.stringify(status).includes("private"));
    assert.equal(counts().logins, 1);
  }
});
test("DPAPI store uses CAS revisions and keeps credentials out of plaintext files", async () => {
  assert.equal(typeof SessionStore, "function");
  const dir = await mkdtemp(path.join(tmpdir(), "madmodel-auth-"));
  try {
    const store = new SessionStore(dir);
    const first = await store.load();
    await store.save(session(), first.revision);
    const loaded = await store.load();
    assert.equal(loaded.data.account, "student");
    await assert.rejects(store.save(session(), first.revision), {
      code: "AUTH_CHANGED",
    });
    const { readFile } = await import("node:fs/promises");
    assert(
      !(await readFile(path.join(dir, "auth.dpapi"))).includes(
        Buffer.from("signature"),
      ),
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
