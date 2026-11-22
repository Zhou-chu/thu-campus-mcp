import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createLearnxRecovery } from "../lib/app/learnx-recovery.mjs";
import { invokeWithRecovery } from "../lib/gateway.mjs";

const read = { name: "learn_list_semesters", annotations: { readOnlyHint: true } };
const expired = { isError: true, structuredContent: { code: "AUTH_EXPIRED" } };
const account = { username: "fixture-user", password: "fixture-only" };

test("LearnX: validates account for legacy recovery and retries each expired read once after a shared login", async () => {
  let attempts = 0, snapshots = 0;
  const expectedId = createHash("sha256").update(account.username).digest("hex").slice(0, 16);
  const restore = createLearnxRecovery({ stateDir: "fixture", readAccount: async () => account,
    restoreSnapshot: async id => { snapshots++; assert.equal(id, expectedId); return false; },
    login: async args => { attempts++; assert.deepEqual(args, { stateDir: "fixture", sameAccountOnly: true, expectedAccount: account }); return { ok: true }; } });
  const work = () => {
    let calls = 0;
    return invokeWithRecovery(read, async () => ++calls === 1 ? expired : { ok: true, calls }, restore);
  };
  assert.deepEqual(await Promise.all([work(), work(), work()]), [{ ok: true, calls: 2 }, { ok: true, calls: 2 }, { ok: true, calls: 2 }]);
  assert.equal(attempts, 1);
  assert.equal(snapshots, 1);
});

test("LearnX: returns manual challenge without replay, cooldown prevents repeated CAS submission", async () => {
  let now = 0, submits = 0, calls = 0;
  const restore = createLearnxRecovery({ stateDir: "fixture", now: () => now, readAccount: async () => account,
    restoreSnapshot: async () => false,
    login: async () => { submits++; throw Object.assign(new Error("upstream diagnostic fixture"), { code: "CAS_CAPTCHA_REQUIRED" }); } });
  const run = tool => invokeWithRecovery(tool, async () => { calls++; return expired; }, restore);
  for (const name of ["learn_status", "learn_submit_assignment"]) {
    assert.equal(await run({ name, annotations: { readOnlyHint: name.endsWith("_status") } }), expired);
  }
  assert.equal(submits, 0);
  for (let i = 0; i < 2; i++) {
    const result = await run(read);
    assert.equal(result.structuredContent.code, "CAS_CAPTCHA_REQUIRED");
    assert.doesNotMatch(JSON.stringify(result), /upstream diagnostic fixture/);
  }
  assert.equal(calls, 4);
  assert.equal(submits, 1);
  now += 120001;
  await run(read);
  assert.equal(submits, 2);
});

test("LearnX: restores a verified legacy snapshot without submitting CAS credentials", async () => {
  const restore = createLearnxRecovery({ stateDir: "fixture", readAccount: async () => null,
    restoreSnapshot: async id => { assert.equal(id, undefined); return true; },
    login: async () => assert.fail("snapshot was enough") });
  assert.deepEqual(await restore(), { ok: true });
});

test("LearnX: preserves auth error on unknown failure and surfaces account mismatch", async () => {
  for (const code of ["UPSTREAM_UNKNOWN", "BROWSER_ACCOUNT_MISMATCH", "AUTH_CHANGED", "ACCOUNT_STORAGE"]) {
    const restore = createLearnxRecovery({ stateDir: "fixture", readAccount: async () => account,
      restoreSnapshot: async () => false, login: async () => { throw Object.assign(new Error("fixture"), { code }); } });
    const result = await invokeWithRecovery(read, async () => expired, restore);
    assert.equal(result.structuredContent.code, code === "UPSTREAM_UNKNOWN" ? "AUTH_EXPIRED" : code);
  }
});
