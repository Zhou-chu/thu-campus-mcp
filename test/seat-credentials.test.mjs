import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * 真实凭据读取曾经在 5bfe573 之后抛 ReferenceError（defaultAccountDir 未导入），
 * 所有座位登录直接 500。这里不注入替身，直接跑生产实现。
 */
test("座位凭据：缺省实现不抛 ReferenceError，无账号时返回 null", async t => {
  const dir = await mkdtemp(path.join(tmpdir(), "seat-cred-"));
  const previous = { stateDir: process.env.THU_CAMPUS_APP_STATE_DIR, credentials: process.env.SEAT_CREDENTIALS };
  process.env.THU_CAMPUS_APP_STATE_DIR = dir;
  delete process.env.SEAT_CREDENTIALS;
  t.after(async () => {
    if (previous.stateDir === undefined) delete process.env.THU_CAMPUS_APP_STATE_DIR;
    else process.env.THU_CAMPUS_APP_STATE_DIR = previous.stateDir;
    if (previous.credentials === undefined) delete process.env.SEAT_CREDENTIALS;
    else process.env.SEAT_CREDENTIALS = previous.credentials;
    await rm(dir, { recursive: true, force: true });
  });

  const { readCredentials } = await import("../lib/app/seat.mjs");
  assert.equal(await readCredentials(), null, "没有统一账号也没有旧文件时应返回 null，而不是抛错");
});

test("座位凭据：兼容显式指定的旧文件，坏文件不抛错", async t => {
  const dir = await mkdtemp(path.join(tmpdir(), "seat-cred-file-"));
  // 凭据文件放在状态目录之外：状态目录同名的 seat-credentials.json 属于旧数据迁移路径，会先被 loadAccount 接管。
  const fileDir = await mkdtemp(path.join(tmpdir(), "seat-cred-external-"));
  const previous = { stateDir: process.env.THU_CAMPUS_APP_STATE_DIR, credentials: process.env.SEAT_CREDENTIALS };
  process.env.THU_CAMPUS_APP_STATE_DIR = dir;
  t.after(async () => {
    if (previous.stateDir === undefined) delete process.env.THU_CAMPUS_APP_STATE_DIR;
    else process.env.THU_CAMPUS_APP_STATE_DIR = previous.stateDir;
    if (previous.credentials === undefined) delete process.env.SEAT_CREDENTIALS;
    else process.env.SEAT_CREDENTIALS = previous.credentials;
    await rm(dir, { recursive: true, force: true });
    await rm(fileDir, { recursive: true, force: true });
  });
  const { readCredentials } = await import("../lib/app/seat.mjs");

  const file = path.join(fileDir, "seat-credentials.json");
  await writeFile(file, JSON.stringify({ username: "2024000000", password: "fixture-pass" }));
  process.env.SEAT_CREDENTIALS = file;
  assert.deepEqual(await readCredentials(), { username: "2024000000", password: "fixture-pass" });

  await writeFile(file, "{not json");
  assert.equal(await readCredentials(), null, "坏文件按未配置处理，不能把异常抛给登录流程");

  await writeFile(file, JSON.stringify({ username: "", password: "" }));
  assert.equal(await readCredentials(), null, "字段为空时同样视为未配置");
});