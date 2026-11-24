#!/usr/bin/env node
/**
 * 旧数据迁移入口：把 stateDir 里的 JSON（settings/sessions/schedules）导入指定邮箱账号。
 *
 * 用法：
 *   node scripts/import-local.mjs --state-dir <旧状态目录> --email <账号邮箱>
 *
 * 需要 DATABASE_URL（或 --database-url）；不会删除或改写源文件，可重复执行。
 */
import { existsSync } from "node:fs";
import path from "node:path";
import { openStore } from "../lib/store/index.mjs";
import { importLocalState } from "../lib/store/import-local.mjs";
import { normalizeEmail } from "../lib/auth/email.mjs";

function usage() {
  return [
    "用法: node scripts/import-local.mjs --state-dir <旧状态目录> --email <账号邮箱> [--database-url <url>]",
    "",
    "把旧版 settings.json、sessions/*.json、schedules.json 导入指定账号。",
    "需要 DATABASE_URL 或 --database-url；源目录不会被修改，重复执行会补齐未完成的会话。",
  ].join("\n");
}

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (item === "--help" || item === "-h") return { help: true };
    if (!item.startsWith("--")) throw Object.assign(new Error(`不认识的参数：${item}`), { code: "INVALID_ARGUMENTS" });
    const key = item.slice(2);
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) throw Object.assign(new Error(`参数 ${item} 缺少值。`), { code: "INVALID_ARGUMENTS" });
    args[key] = value;
    index += 1;
  }
  return args;
}

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    console.error(usage());
    process.exit(2);
  }
  if (args.help) {
    console.log(usage());
    return;
  }
  const stateDir = args["state-dir"] ? path.resolve(args["state-dir"]) : "";
  const email = normalizeEmail(args.email || "");
  if (!stateDir || !email) {
    console.error("需要 --state-dir 与合法的清华邮箱 --email。");
    console.error(usage());
    process.exit(2);
  }
  if (!existsSync(stateDir)) {
    console.error(`状态目录不存在：${stateDir}`);
    process.exit(2);
  }
  if (args["database-url"]) process.env.DATABASE_URL = args["database-url"];
  const session = await openStore();
  if (!session) {
    console.error("没有数据库连接：请设置 DATABASE_URL 或传 --database-url。");
    process.exit(3);
  }
  try {
    const user = await session.repos.users.findByEmail(email);
    if (!user) {
      console.error(`没有找到账号 ${email}；请先用该邮箱注册，再执行导入。`);
      process.exit(4);
    }
    const report = await importLocalState({ userId: user.id, stateDir, repos: session.repos });
    console.log(JSON.stringify({ ok: true, email, stateDir, report }, null, 2));
  } catch (error) {
    console.error(`导入失败（${error.code || "IMPORT_FAILED"}）：${error.message}`);
    process.exitCode = 1;
  } finally {
    await session.close();
  }
}

main().catch(error => {
  console.error(`导入失败：${error?.message || error}`);
  process.exitCode = 1;
});