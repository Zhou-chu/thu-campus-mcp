import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { createRequire } from "node:module";
import { LAYERS, layeredViolations } from "../scripts/check-layers.mjs";

const run = promisify(execFile);
const require = createRequire(import.meta.url);
const cli = path.resolve("node_modules/dependency-cruiser/bin/dependency-cruiser.mjs");
const configPath = path.resolve(".dependency-cruiser.cjs");
const config = require(configPath);

/** 用临时工程触发真实 depcruise，证明分层规则会拦住反向依赖。 */
async function cruise(files) {
  const dir = await mkdtemp(path.join(tmpdir(), "campus-layers-"));
  try {
    for (const [relative, content] of Object.entries(files)) {
      const target = path.join(dir, relative);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, content);
    }
    const ignored = path.join(dir, ".dependency-cruiser-known-violations.json");
    await writeFile(ignored, "[]");
    // depcruise --ignore-known 的退出码不可靠（实测有违规也返回 0），门禁以脚本解析结果为准。
    const result = await run(process.execPath, [cli, "--config", configPath, "--ignore-known", "--output-type", "err", "."], { cwd: dir, timeout: 60000 }).catch(error => ({ stdout: String(error.stdout || error.stderr || "") }));
    const output = String(result.stdout || "");
    const violations = layeredViolations(output);
    return { code: violations.length ? 1 : 0, output, violations };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("layering rules exist for every boundary the architecture promises", () => {
  assert.deepEqual(LAYERS.sort(), ["app-not-to-webui", "browser-package-standalone", "core-not-to-webui", "packages-not-to-app", "webui-not-to-runtime"]);
  const names = new Set(config.forbidden.map(rule => rule.name));
  for (const name of ["app-not-to-webui", "core-not-to-webui", "webui-not-to-runtime", "packages-not-to-app", "browser-package-standalone"]) {
    assert.ok(names.has(name), `缺少分层规则 ${name}`);
    const rule = config.forbidden.find(item => item.name === name);
    assert.equal(rule.severity, "error");
    assert.ok(rule.from.path, `${name} 必须有 from.path`);
    assert.ok(rule.to.path, `${name} 必须有 to.path`);
  }
  // 循环依赖与不可解析仍然是最基础的错误级门禁。
  for (const name of ["no-circular", "not-to-unresolvable"]) {
    assert.equal(config.forbidden.find(rule => rule.name === name)?.severity, "error");
  }
});

test("real depcruise rejects a backend→webui import and a package→app import", async () => {
  const backend = await cruise({
    "lib/app/server.mjs": 'export { app } from "../../webui/app.js";\n',
    "webui/app.js": "export const app = 1;\n",
  });
  assert.equal(backend.code, 1, "后端引用界面必须被拒绝");
  assert.match(backend.output, /app-not-to-webui/);
  assert.deepEqual(backend.violations.length, 1);

  const pkg = await cruise({
    "packages/learnx/src/auth.ts": 'export const x = 1;\n',
    "lib/app/server.mjs": 'export const server = 1;\n',
    "packages/learnx/src/index.ts": 'import { server } from "../../../lib/app/server.mjs";\nexport const y = server;\n',
  });
  assert.equal(pkg.code, 1, "服务包反向依赖应用必须被拒绝");
  assert.match(pkg.output, /packages-not-to-app/);

  const browser = await cruise({
    "packages/browser/index.mjs": 'export const u = 1;\n',
    "lib/util.mjs": "export const u = 2;\n",
    "packages/browser/use.mjs": 'import { u } from "../../lib/util.mjs";\nexport const v = u;\n',
  });
  assert.equal(browser.code, 1, "浏览器底层包不能依赖应用层");
  assert.match(browser.output, /browser-package-standalone/);

  const clean = await cruise({
    "lib/app/server.mjs": 'import { root } from "../../lib/root.mjs";\nexport const server = root;\n',
    "lib/root.mjs": "export const root = 1;\n",
  });
  assert.equal(clean.code, 0, `合法方向必须通过：${clean.output.slice(0, 300)}`);
});