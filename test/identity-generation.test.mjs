import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { accountGeneration, clearAccount, loadAccount, saveAccount } from "../lib/app/account.mjs";
import { resetCampusSessions } from "../lib/app/session-reset.mjs";

const dir = async t => {
  const value = await mkdtemp(path.join(tmpdir(), "identity-"));
  t.after(() => rm(value, { recursive: true, force: true }));
  return value;
};

test("身份代际：只有凭据变化才递增，重复保存不换代", async t => {
  const value = await dir(t);
  assert.equal(await accountGeneration(value), 0);
  const first = await saveAccount({ username: "2024000000", password: "pass-one" }, value);
  assert.equal(first.changed, true);
  assert.equal(first.generation, 1);

  const same = await saveAccount({ username: "2024000000", password: "pass-one" }, value);
  assert.equal(same.changed, false);
  assert.equal(same.generation, 1, "同一组凭据不应让会话失效");

  const changed = await saveAccount({ username: "2024000001", password: "pass-two" }, value);
  assert.equal(changed.changed, true);
  assert.equal(changed.generation, 2);
  assert.equal((await loadAccount(value)).username, "2024000001");

  const cleared = await clearAccount(value);
  assert.equal(cleared.generation, 3);
  assert.equal(await accountGeneration(value), 3);
  assert.equal(await loadAccount(value), null);
});

test("身份变更回收：只清校园站点会话，保留其它 Cookie 与来源", async () => {
  const state = {
    cookies: [
      { domain: "seat.lib.tsinghua.edu.cn", name: "access_token", value: "a" },
      { domain: ".www.sports.tsinghua.edu.cn", name: "token", value: "b" },
      { domain: "git.tsinghua.edu.cn", name: "_gitlab_session", value: "c" },
      { domain: "example.com", name: "keep", value: "d" },
    ],
    origins: [
      { origin: "https://seat.lib.tsinghua.edu.cn", localStorage: [] },
      { origin: "https://learn.tsinghua.edu.cn", localStorage: [] },
      { origin: "https://git.tsinghua.edu.cn", localStorage: [] },
    ],
  };
  let saved = null;
  let learnxCleared = 0;
  const result = await resetCampusSessions({
    snapshot: async () => state,
    save: async (_options, next) => { saved = next; },
    clearLearnx: async () => { learnxCleared += 1; },
  });
  assert.equal(result.cookies, 2);
  assert.equal(result.origins, 2);
  assert.deepEqual(saved.cookies.map(cookie => cookie.name), ["_gitlab_session", "keep"]);
  assert.deepEqual(saved.origins.map(origin => origin.origin), ["https://git.tsinghua.edu.cn"]);
  assert.equal(learnxCleared, 1);
});

test("身份变更回收：没有快照时不写盘，但仍清网络学堂授权", async () => {
  let saved = 0;
  let learnxCleared = 0;
  const result = await resetCampusSessions({
    snapshot: async () => null,
    save: async () => { saved += 1; },
    clearLearnx: async () => { learnxCleared += 1; },
  });
  assert.equal(result.cleared, true);
  assert.equal(saved, 0);
  assert.equal(learnxCleared, 1);
});
