#!/usr/bin/env node
/**
 * 把 packages/mobile-core/spec.json 生成安卓与鸿蒙两端常量文件。
 * --check 只比对不写盘，CI 用它防止两端常量漂移。
 */
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { GENERATED } from "../packages/mobile-core/index.mjs";

const check = process.argv.includes("--check");
let changed = 0;

for (const [relative, render] of Object.entries(GENERATED)) {
  const target = path.resolve(relative);
  const content = render();
  const existing = await import("node:fs/promises").then(fs => fs.readFile(target, "utf8").catch(() => null));
  if (existing === content) continue;
  changed += 1;
  if (check) {
    console.error(`[mobile-core] 需要重新生成：${relative}`);
    continue;
  }
  await writeFile(target, content);
  console.log(`[mobile-core] 已写入 ${relative}`);
}

if (check && changed) {
  console.error("[mobile-core] 运行 npm run mobile:core 重新生成");
  process.exit(1);
}
if (check) console.log("[mobile-core] 两端常量与 spec 一致");
else if (!changed) console.log("[mobile-core] 已是最新");