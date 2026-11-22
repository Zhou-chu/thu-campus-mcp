#!/usr/bin/env node
/**
 * 分层依赖门禁。
 *
 * `depcruise --ignore-known` 在有已知基线时不会因为“新违规”返回非零（实测：即使基线为空、
 * 存在违规也返回 0），所以这里显式解析它的输出：已知的循环/不可解析仍由基线记录，
 * 但任何命中分层规则的新依赖都会让本脚本失败。
 */
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(fileURLToPath(new URL("../", import.meta.url)));
export const LAYERS = [
  "app-not-to-webui",
  "core-not-to-webui",
  "webui-not-to-runtime",
  "packages-not-to-app",
  "browser-package-standalone",
];

export function layeredViolations(stdout) {
  const lines = String(stdout || "").split(/\r?\n/);
  return lines.filter(line => LAYERS.some(name => line.includes(`error ${name}:`) || line.includes(`warn ${name}:`)));
}

export async function checkLayers({ root = ROOT, run = spawn } = {}) {
  const cli = path.join(root, "node_modules/dependency-cruiser/bin/dependency-cruiser.mjs");
  const config = path.join(root, ".dependency-cruiser.cjs");
  const result = await new Promise((resolve, reject) => {
    const child = run(process.execPath, [cli, "--config", config, "--ignore-known", "--output-type", "err", "lib", "packages", "webui"], { cwd: root, windowsHide: true });
    let stdout = "", stderr = "";
    child.stdout?.on("data", chunk => { stdout += chunk; });
    child.stderr?.on("data", chunk => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", code => resolve({ code: code ?? 1, stdout, stderr }));
  });
  const violations = layeredViolations(result.stdout);
  if (result.code !== 0 && !violations.length) {
    return { ok: false, code: result.code, violations, detail: (result.stderr || result.stdout).trim().slice(0, 1200) };
  }
  if (violations.length) return { ok: false, code: 1, violations, detail: violations.join("\n") };
  return { ok: true, code: 0, violations: [], detail: "" };
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const result = await checkLayers();
  if (!result.ok) {
    process.stderr.write(`分层依赖检查失败：\n${result.detail || result.violations.join("\n")}\n`);
    process.exitCode = 1;
  } else {
    process.stdout.write(`分层依赖检查通过（${LAYERS.length} 条规则）\n`);
  }
}