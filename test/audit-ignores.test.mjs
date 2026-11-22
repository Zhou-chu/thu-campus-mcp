import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { auditIgnores, MAX_RATIO, MAX_BLOCK_LINES } from "../scripts/audit-ignores.mjs";

async function fixture(files) {
  const root = await mkdtemp(path.join(tmpdir(), "ignore-audit-"));
  for (const [relative, body] of Object.entries(files)) {
    const target = path.join(root, relative);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, body);
  }
  return root;
}

test("小范围且带原因的排除可以通过", async () => {
  const root = await fixture({
    "lib/small.mjs": Array.from({ length: 40 }, (_, i) => i === 10 ? "/* c8 ignore start —— 真实浏览器调用 */" : i === 12 ? "/* c8 ignore stop */" : "export const value = 1;").join("\n"),
  });
  try {
    const result = await auditIgnores(root);
    assert.deepEqual(result.findings, []);
    assert.equal(result.stats.length, 1);
    assert.ok(result.stats[0].ratio <= MAX_RATIO);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("超过比例、整段包裹与缺少原因都会被指出", async () => {
  const body = ["export const a = 1;", "/* c8 ignore start */", ...Array.from({ length: MAX_BLOCK_LINES + 5 }, () => "const hidden = 1;"), "/* c8 ignore stop */"].join("\n");
  const wide = Array.from({ length: 20 }, (_, i) => i === 1 ? "/* c8 ignore start —— 外部调用 */" : i === 18 ? "/* c8 ignore stop */" : "export const value = 1;").join("\n");
  const root = await fixture({ "lib/big.mjs": body, "lib/wide.mjs": wide });
  try {
    const { findings } = await auditIgnores(root);
    assert.ok(findings.some(f => f.file === "lib/big.mjs" && f.rule === "ignore-without-reason"));
    assert.ok(findings.some(f => f.file === "lib/big.mjs" && f.rule === "ignore-block-too-large"));
    assert.ok(findings.some(f => f.file === "lib/big.mjs" && f.rule === "ignore-ratio-too-high"));
    assert.equal(findings.some(f => f.file === "lib/wide.mjs" && f.rule === "ignore-ratio-too-high"), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("缺少 stop 或多余 stop 都算错误", async () => {
  const root = await fixture({
    "lib/unclosed.mjs": ["/* c8 ignore start —— 外部调用 */", "const x = 1;", "export const y = 2;"].join("\n"),
    "lib/extra.mjs": ["export const z = 1;", "/* c8 ignore stop */"].join("\n"),
  });
  try {
    const { findings } = await auditIgnores(root);
    assert.ok(findings.some(f => f.file === "lib/unclosed.mjs" && f.rule === "ignore-start-without-stop"));
    assert.ok(findings.some(f => f.file === "lib/extra.mjs" && f.rule === "ignore-stop-without-start"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("仓库当前没有超限排除，seat 不再被整段排除", async () => {
  const result = await auditIgnores(path.resolve(import.meta.dirname, ".."));
  assert.deepEqual(result.findings, []);
  assert.ok(!result.stats.some(entry => entry.file === "lib/app/seat.mjs"), "seat.mjs 不应再出现在排除统计里");
  for (const entry of result.stats) assert.ok(entry.ratio <= MAX_RATIO, entry.file);
});