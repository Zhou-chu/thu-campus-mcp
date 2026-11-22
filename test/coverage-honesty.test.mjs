import assert from "node:assert/strict";
import test from "node:test";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

/** 覆盖率注释会让人误以为危险路径被“豁免”，而本仓库的自定义合并管线并不执行这些指令。 */
async function offenders(directory) {
  const found = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (["node_modules", "dist", "coverage", ".local"].includes(entry.name)) continue;
      found.push(...await offenders(target));
    } else if (/\.(mjs|js|ts)$/.test(entry.name)) {
      const text = await readFile(target, "utf8");
      if (/c8 ignore/.test(text)) found.push(target.replaceAll("\\", "/"));
    }
  }
  return found;
}

test("生产代码不再用覆盖率注释隐藏不可达声明", async () => {
  const found = [
    ...await offenders("lib"),
    ...await offenders("packages"),
    ...await offenders("webui"),
  ];
  assert.deepEqual(found, [], "不要用 c8 ignore 掩盖路径；改为可注入依赖并补测试");
});

test("危险浏览器路径所在模块确实计入覆盖率报告", async t => {
  // 普通 npm test 不生成覆盖率报告；报告由 npm run test:coverage 产出。
  let raw;
  try { raw = await readFile("coverage/unit/coverage-final.json", "utf8"); }
  catch { t.skip("尚未生成覆盖率报告：先运行 npm run test:coverage"); return; }
  const report = JSON.parse(raw);
  for (const file of ["lib/app/seat.mjs", "lib/app/sports.mjs"]) {
    const data = report[file];
    assert.ok(data, `${file} 必须出现在覆盖率报告里`);
    const covered = Object.values(data.s).filter(hits => hits > 0).length;
    assert.ok(covered > 0, `${file} 至少要有真实执行到的语句`);
    assert.ok(Object.keys(data.s).length > 100, `${file} 的语句数应与源码规模相符`);
  }
});