import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";

const script = path.resolve(import.meta.dirname, "..", "scripts", "import-local.mjs");
const run = (args, env = {}) => spawnSync(process.execPath, [script, ...args], { encoding: "utf8", env: { ...process.env, DATABASE_URL: "", ...env } });

test("导入 CLI 有可执行入口并说明用法", () => {
  const help = run(["--help"]);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /--state-dir/);
  assert.match(help.stdout, /--email/);
});

test("导入 CLI 对缺参数、坏目录与无数据库给出明确退出码", async (t) => {
  const missing = run([]);
  assert.equal(missing.status, 2);
  assert.match(missing.stderr, /需要 --state-dir/);

  const dir = await mkdtemp(path.join(tmpdir(), "campus-import-cli-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const noDir = run(["--state-dir", path.join(dir, "missing"), "--email", "x@mails.tsinghua.edu.cn"]);
  assert.equal(noDir.status, 2);
  assert.match(noDir.stderr, /状态目录不存在/);

  const noDb = run(["--state-dir", dir, "--email", "x@mails.tsinghua.edu.cn"]);
  assert.equal(noDb.status, 3);
  assert.match(noDb.stderr, /没有数据库连接/);
});
