import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { newDb } from "pg-mem";
import { createPgStore } from "../lib/store/pg.mjs";
import { createAuthRepositories } from "../lib/store/auth-repo.mjs";
import { createUserDataRepositories } from "../lib/store/user-data-repo.mjs";
import { importLocalState } from "../lib/store/import-local.mjs";

async function boot(t) {
  const dir = await mkdtemp(path.join(tmpdir(), "campus-import-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const db = newDb({ autoCreateForeignKeyIndices: true });
  const store = createPgStore({ pool: new (db.adapters.createPg().Pool)() });
  await store.migrate();
  const user = await createAuthRepositories(store).users.create({ email: "import@mails.tsinghua.edu.cn", passwordHash: "hash" });
  return { dir, user, repos: createUserDataRepositories(store) };
}

test("导入本机 JSON：设置、会话与消息、定时任务", async t => {
  const { dir, user, repos } = await boot(t);
  await writeFile(path.join(dir, "settings.json"), JSON.stringify({ modelName: "qwen", reasoningEffort: "high", compactTools: true }));
  await mkdir(path.join(dir, "sessions"));
  await writeFile(path.join(dir, "sessions", "s-1.json"), JSON.stringify({
    id: "s-1", title: "旧会话", createdAt: "2026-11-01T00:00:00.000Z",
    messages: [
      { role: "user", content: "你好", createdAt: "2026-11-01T00:00:01.000Z" },
      { role: "assistant", content: "在", reasoning: "思考", createdAt: "2026-11-01T00:00:02.000Z" },
      { bad: true },
    ],
  }));
  await writeFile(path.join(dir, "schedules.json"), JSON.stringify({ tasks: [
    { id: "t-1", title: "晨报", prompt: "总结", kind: "daily", time: "08:00", enabled: true, lastRunAt: "2026-11-02T00:00:00.000Z", lastStatus: "ok" },
    { id: "t-2", title: "周末", prompt: "回顾", kind: "weekly", time: "09:00", days: [6, 7], enabled: false },
  ] }));

  const report = await importLocalState({ userId: user.id, stateDir: dir, repos });
  assert.deepEqual({ ...report, warnings: undefined }, { settings: 3, sessions: 1, messages: 2, schedules: 2, skippedSessions: 0, repairedSessions: 0, warnings: undefined });
  assert.equal(await repos.settings.get(user.id, "theme"), undefined);
  assert.equal(await repos.settings.get(user.id, "modelName"), "qwen");
  const session = await repos.chat.getSession(user.id, "s-1");
  assert.equal(session.title, "旧会话");
  const messages = await repos.chat.listMessages("s-1");
  assert.deepEqual(messages.map(item => item.role), ["user", "assistant"]);
  assert.deepEqual(messages[1].content, { content: "在", reasoning: "思考" });
  const tasks = await repos.schedules.list(user.id);
  assert.equal(tasks.length, 2);
  const weekly = tasks.find(item => item.id === "t-2");
  assert.deepEqual(weekly.spec, { time: "09:00", days: [6, 7] });
  assert.equal(weekly.enabled, false);
  assert.equal((await repos.schedules.get(user.id, "t-1")).lastStatus, "ok");
});

test("重复导入不产生副本，缺目录也能完成并提示凭据未导入", async t => {
  const { dir, user, repos } = await boot(t);
  const first = await importLocalState({ userId: user.id, stateDir: dir, repos });
  assert.equal(first.sessions, 0);
  assert.ok(first.warnings.some(item => /DPAPI/.test(item)));

  await mkdir(path.join(dir, "sessions"));
  await writeFile(path.join(dir, "sessions", "s-2.json"), JSON.stringify({ id: "s-2", title: "一次", messages: [{ role: "user", content: "x" }] }));
  await importLocalState({ userId: user.id, stateDir: dir, repos });
  const second = await importLocalState({ userId: user.id, stateDir: dir, repos });
  assert.equal(second.skippedSessions, 1);
  assert.equal((await repos.chat.listSessions(user.id)).length, 1);
  assert.equal((await repos.chat.listMessages("s-2")).length, 1);
  await assert.rejects(() => importLocalState({ stateDir: dir, repos }), (error) => error.code === "IMPORT_NO_USER");
  await assert.rejects(() => importLocalState({ userId: user.id, repos }), (error) => error.code === "IMPORT_NO_STATE_DIR");
});

test("导入中途失败后重跑补齐剩余消息，不重复也不丢", async t => {
  const { dir, user, repos } = await boot(t);
  await mkdir(path.join(dir, "sessions"));
  await writeFile(path.join(dir, "sessions", "s-half.json"), JSON.stringify({
    id: "s-half", title: "半完成", createdAt: "2026-11-01T00:00:00.000Z",
    messages: [{ role: "user", content: "一" }, { role: "assistant", content: "二" }],
  }));
  const original = repos.chat.appendMessage;
  let calls = 0;
  repos.chat.appendMessage = async input => {
    calls += 1;
    if (calls === 2) throw Object.assign(new Error("注入失败"), { code: "INJECTED" });
    return original(input);
  };
  await assert.rejects(() => importLocalState({ userId: user.id, stateDir: dir, repos }), (error) => error.code === "INJECTED");
  assert.equal((await repos.chat.listMessages("s-half")).length, 1, "失败时留下可修复的半完成会话");

  repos.chat.appendMessage = original;
  const retry = await importLocalState({ userId: user.id, stateDir: dir, repos });
  assert.equal(retry.repairedSessions, 1);
  assert.equal(retry.messages, 1);
  assert.equal(retry.skippedSessions, 0);
  assert.equal((await repos.chat.listMessages("s-half")).length, 2, "重跑补齐第二条消息");

  const third = await importLocalState({ userId: user.id, stateDir: dir, repos });
  assert.equal(third.skippedSessions, 1);
  assert.equal(third.messages, 0);
  assert.equal((await repos.chat.listMessages("s-half")).length, 2, "再次重跑不重复");
});

test("坏 JSON 明确报错而不是静默跳过", async t => {
  const { dir, user, repos } = await boot(t);
  await writeFile(path.join(dir, "settings.json"), "{not json");
  await assert.rejects(() => importLocalState({ userId: user.id, stateDir: dir, repos }), (error) => error.code === "IMPORT_UNREADABLE");
});