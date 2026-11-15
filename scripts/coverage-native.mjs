#!/usr/bin/env node
/** One collector under c8. Unit reporting reads a snapshot; original raw survives E2E. */
import path from "node:path";
import { pathToFileURL } from "node:url";
import { readdir, readFile, writeFile, stat, mkdir, copyFile } from "node:fs/promises";
import { ROOT, E2E_SCRIPTS, hashSource, isMain, runNode, unitCoverageArgs, localCli } from "./coverage.mjs";

export async function nativeTestFiles(root = ROOT) {
  const files = [];
  for (const directory of ["test", "desktop/test", "packages/browser/test"]) {
    const matches = (await readdir(path.join(root, directory))).filter(name => name.endsWith(".test.mjs")).sort((a, b) => a.localeCompare(b));
    if (!matches.length) throw new Error(`EMPTY_NATIVE_TEST_SUITE:${directory}`);
    files.push(...matches.map(name => path.join(root, directory, name)));
  }
  const cloud = path.join(root, "packages/thu-cloud/test/workspace-storage.test.mjs");
  if (!(await stat(cloud)).isFile()) throw new Error("MISSING_CLOUD_WORKSPACE_TEST");
  return [...new Set([...files, cloud])];
}
export async function nativePlan(root = ROOT, env = process.env) {
  if (!env.NODE_V8_COVERAGE || !env.CAMPUS_COVERAGE_RUN_DIR || !env.CAMPUS_COVERAGE_MANIFEST) throw new Error("C8_COVERAGE_ENV_REQUIRED");
  const common = { ...env, NODE_V8_COVERAGE: env.NODE_V8_COVERAGE };
  const plans = [{ name: "node-tests", args: ["--enable-source-maps", "--test", ...await nativeTestFiles(root)], env: common }];
  const hook = pathToFileURL(path.join(root, "scripts/coverage-browser.mjs")).href;
  for (const script of E2E_SCRIPTS) plans.push({ name: script, args: ["--enable-source-maps", "--import", hook, path.join(root, "scripts", script)], env: { ...common, CAMPUS_COVERAGE_BROWSER: "1", CAMPUS_COVERAGE_ROOT: root, CAMPUS_COVERAGE_BROWSER_DIR: path.join(env.CAMPUS_COVERAGE_RUN_DIR, "browser") } });
  return plans;
}
export async function snapshotNativeUnit(root, env, runner = runNode) {
  const runDirectory = env.CAMPUS_COVERAGE_RUN_DIR, raw = path.resolve(env.NODE_V8_COVERAGE);
  if (raw !== path.join(runDirectory, "native/raw")) throw new Error("C8_RAW_DIRECTORY_MISMATCH");
  const snapshot = path.join(runDirectory, "unit/raw"); await mkdir(snapshot, { recursive: true });
  const files = (await readdir(raw, { withFileTypes: true })).filter(entry => entry.isFile()).map(entry => entry.name).sort((a, b) => a.localeCompare(b));
  const hashes = {};
  for (const file of files) {
    await copyFile(path.join(raw, file), path.join(snapshot, file));
    hashes[file] = hashSource(await readFile(path.join(snapshot, file), "utf8"));
  }
  await writeFile(path.join(runDirectory, "unit/snapshot.json"), JSON.stringify({ beforeE2E: true, files, hashes }));
  return runner(unitCoverageArgs(root, runDirectory, localCli(ROOT, "c8", "bin/c8.js")), { cwd: root, env });
}
export async function nativeMain(root = process.env.CAMPUS_COVERAGE_ROOT || ROOT, env = process.env, runner = runNode) {
  const results = [];
  for (const stage of await nativePlan(root, env)) {
    console.log(`\n[coverage] ${stage.name}`);
    results.push({ name: stage.name, ...await runner(stage.args, { cwd: root, env: stage.env }) });
    if (stage.name === "node-tests") {
      try { results.push({ name: "unit-report", ...await snapshotNativeUnit(root, env, runner) }); }
      catch { results.push({ name: "unit-report", code: 1, error: "UNIT_SNAPSHOT_FAILED" }); }
    }
  }
  await writeFile(path.join(env.CAMPUS_COVERAGE_RUN_DIR, "native-stages.json"), JSON.stringify(results, null, 2));
  return results.some(result => result.code !== 0) ? 1 : 0;
}
if (isMain(import.meta.url)) nativeMain().then(code => { process.exitCode = code; }).catch(error => { console.error(`Native coverage failed: ${error.message}`); process.exitCode = 1; });
