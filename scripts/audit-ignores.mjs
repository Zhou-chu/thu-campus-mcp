#!/usr/bin/env node
/**
 * c8 排除区审计：覆盖率不能靠 /* c8 ignore *\/ 把风险代码藏起来。
 *
 * 规则（issue #68）：
 * 1. 单文件被排除的行数不得超过 15%；
 * 2. 单个排除块不得超过 40 行——只允许包住零散的外部调用，不许整段流程；
 * 3. 每个 `c8 ignore start` 必须带“——原因”，没有说明就失败。
 */
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

export const MAX_RATIO = 0.15;
export const MAX_BLOCK_LINES = 40;
const ROOTS = ["lib", "webui", "bin", "desktop", "packages/browser"];

async function walk(directory, files) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) await walk(target, files);
    else if (/\.(?:mjs|cjs|js)$/.test(entry.name)) files.push(target);
  }
}

/** 返回每个文件的排除统计与违规原因。 */
export async function auditIgnores(root) {
  const files = [];
  for (const relative of ROOTS) {
    try { await walk(path.join(root, relative), files); } catch { /* 根目录可缺省 */ }
  }
  const findings = [];
  const stats = [];
  for (const file of files) {
    const text = await readFile(file, "utf8");
    const name = path.relative(root, file).split(path.sep).join("/");
    const total = text.split("\n").length;
    let ignored = 0;
    let open = null;
    text.split("\n").forEach((line, index) => {
      if (line.includes("c8 ignore start")) {
        if (!/——\s*\S/.test(line)) findings.push({ file: name, rule: "ignore-without-reason", line: index + 1 });
        open = { line: index + 1, count: 0 };
        return;
      }
      if (line.includes("c8 ignore stop")) {
        if (!open) findings.push({ file: name, rule: "ignore-stop-without-start", line: index + 1 });
        else if (open.count > MAX_BLOCK_LINES) findings.push({ file: name, rule: "ignore-block-too-large", line: open.line, lines: open.count });
        open = null;
        return;
      }
      if (open) { open.count += 1; ignored += 1; }
    });
    if (open) findings.push({ file: name, rule: "ignore-start-without-stop", line: open.line });
    if (!ignored) continue;
    const ratio = ignored / total;
    stats.push({ file: name, total, ignored, ratio });
    if (ratio > MAX_RATIO) findings.push({ file: name, rule: "ignore-ratio-too-high", ratio: Number(ratio.toFixed(4)), ignored, total });
  }
  return { findings, stats: stats.sort((a, b) => b.ratio - a.ratio) };
}

const isMain = process.argv[1] && import.meta.url === new URL("file://" + path.resolve(process.argv[1]).replaceAll("\\", "/")).href;
if (isMain) {
  const root = path.resolve(import.meta.dirname, "..");
  const result = await auditIgnores(root);
  console.log(JSON.stringify({ ...result, maxRatio: MAX_RATIO, maxBlockLines: MAX_BLOCK_LINES }, null, 2));
  if (result.findings.length) process.exitCode = 1;
}