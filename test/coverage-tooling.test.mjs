import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { mkdir, mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import {
  ROOT, SOURCE_ROOTS, TOOLING_ROOTS, snapshotSources, zeroFile, combineCoverage,
  writeReports, verifyReports, toolingCoverageArgs, collectToolingCoverage, rawInventory, hashSource,
} from "../scripts/coverage.mjs";

async function fixture(t) {
  const parent = path.join(ROOT, ".local/qa-temp"); await mkdir(parent, { recursive: true });
  const root = await mkdtemp(path.join(parent, "coverage-tooling-"));
  assert.ok(root.startsWith(parent + path.sep));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
async function put(root, relative, text) {
  const file = path.join(root, relative); await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, text); return file;
}
async function toolingFixture(t) {
  const root = await fixture(t);
  await put(root, "scripts/a.mjs", "export function value() { return 1; }\n");
  await put(root, "scripts/z.mjs", "export const untouched = 1;\n");
  await put(root, "lib/runtime.mjs", "export const runtime = 1;\n");
  const manifest = await snapshotSources(root, TOOLING_ROOTS);
  const data = await zeroFile(root, "scripts/a.mjs", TOOLING_ROOTS);
  const entry = Object.values(data)[0]; delete entry.all;
  for (const map of [entry.s, entry.f]) for (const key of Object.keys(map)) map[key] = 1;
  for (const key of Object.keys(entry.b)) entry.b[key] = entry.b[key].map(() => 1);
  return { root, manifest, data };
}
async function rawFixture(root) {
  const runDirectory = path.join(root, "coverage/.runs/fixture");
  const raw = JSON.stringify({ result: [{ url: "file:///fixture.mjs", functions: [] }] });
  for (const directory of ["unit/raw", "native/raw"]) await put(runDirectory, `${directory}/raw.json`, raw);
  await put(runDirectory, "unit/snapshot.json", JSON.stringify({ beforeE2E: true, files: ["raw.json"], hashes: { "raw.json": hashSource(raw) } }));
  return runDirectory;
}

test("tooling独立完整分母、manifest哈希与原runtime scope互不污染", async t => {
  const { root, manifest, data } = await toolingFixture(t);
  await put(root, "scripts/ignored.test.mjs", "fixture");
  await put(root, "scripts/nested/ignored.d.ts", "fixture");
  const runtime = await snapshotSources(root);
  assert.deepEqual(runtime.scope, SOURCE_ROOTS); assert.deepEqual(Object.keys(runtime.files), ["lib/runtime.mjs"]);
  assert.deepEqual(Object.keys(manifest.files), ["scripts/a.mjs", "scripts/z.mjs"]);
  assert.equal(manifest.files["scripts/a.mjs"], hashSource(await readFile(path.join(root, "scripts/a.mjs"), "utf8")));
  const result = await combineCoverage({ root, manifest, scope: TOOLING_ROOTS, inputs: [{ label: "tooling", data }] });
  assert.deepEqual(result.errors, []); assert.equal(result.map.files().length, 2);
  assert.equal(result.map.fileCoverageFor(path.join(root, "scripts/z.mjs")).toSummary().lines.covered, 0);
  assert.equal(result.map.fileCoverageFor(path.join(root, "scripts/a.mjs")).toSummary().lines.pct, 100);
  await writeReports(root, result, { collectionComplete: true }, "tooling");
  await writeReports(root, result, { collectionComplete: true }, "tooling/unit");
  assert.deepEqual(await verifyReports(root, "tooling"), []);
  assert.deepEqual(await verifyReports(root, "tooling/unit"), []);
  await assert.rejects(writeReports(root, result), /REPORT_SCOPE_MISMATCH/);
  await assert.rejects(writeReports(root, result, {}, "../outside"), /INVALID_REPORT_PHASE/);
  await assert.rejects(snapshotSources(root, ["lib"]), /INVALID_COVERAGE_SCOPE/);
  await assert.rejects(verifyReports(root, "other"), /INVALID_REPORT_PHASE/);
  const wrong = await combineCoverage({ root, manifest, inputs: [{ label: "wrong-scope", data }] });
  assert.ok(wrong.errors.includes("SOURCE_SCOPE_MISMATCH"));
});

test("tooling严格拒绝非法结构，负计数保守归零且两个阶段不改共享输入", async t => {
  const { root, manifest, data } = await toolingFixture(t), file = "scripts/a.mjs", entry = Object.values(data)[0];
  entry.s[Object.keys(entry.s)[0]] = -3;
  entry.f[Object.keys(entry.f)[0]] = -2;
  const branch = Object.keys(entry.b)[0]; if (branch) entry.b[branch][0] = -1;
  const raw = structuredClone(data), input = { label: "negative", data };
  for (let index = 0; index < 2; index++) {
    const result = await combineCoverage({ root, manifest, scope: TOOLING_ROOTS, inputs: [input] });
    assert.deepEqual(result.errors, []); assert.ok(result.warnings[0].startsWith(`NEGATIVE_COUNT_CLAMPED:negative:${file}:`));
    assert.equal(result.map.fileCoverageFor(path.join(root, file)).toJSON().s[Object.keys(entry.s)[0]], 0);
  }
  assert.deepEqual(data, raw);
  for (const bad of [null, [], { ...entry, s: null }, { ...entry, s: { unknown: 1 } }, { ...entry, s: { ...entry.s, 0: Infinity } }, { ...entry, b: { 0: "bad" } }, { ...entry, f: [] }, { ...entry, path: "scripts/z.mjs" }]) {
    const result = await combineCoverage({ root, manifest, scope: TOOLING_ROOTS, inputs: [{ label: "corrupt", data: { [file]: bad } }] });
    assert.ok(result.errors.some(error => error.startsWith("INVALID_SOURCE")));
  }
  const invalid = await combineCoverage({ root, manifest, scope: TOOLING_ROOTS, inputs: [null, { label: "bad", data: [] }] });
  assert.equal(invalid.errors.length, 2);
  await put(root, file, "export const changed = true;\n");
  const stale = await combineCoverage({ root, manifest, scope: TOOLING_ROOTS, inputs: [input] });
  assert.ok(stale.errors.includes(`SOURCE_CHANGED:${file}`)); assert.equal(stale.map.getCoverageSummary().lines.covered, 0);
});

test("tooling报告只转换同次unit/raw与native/raw，不清理或重跑套件", async t => {
  const { root, manifest, data } = await toolingFixture(t), runDirectory = await rawFixture(root), calls = [], stages = [];
  const cli = path.join(root, "c8.mjs");
  const result = await collectToolingCoverage(root, runDirectory, manifest, { cli, stages, run: async args => {
    calls.push(args);
    const directory = args.find(arg => arg.startsWith("--reports-dir=")).slice("--reports-dir=".length);
    await put(directory, "coverage-final.json", JSON.stringify(data)); return { code: 0 };
  } });
  assert.equal(calls.length, 2); assert.equal(stages.length, 2);
  for (const phase of ["unit", "combined"]) {
    assert.deepEqual(result[phase].errors, []);
    const args = toolingCoverageArgs(root, runDirectory, phase, cli);
    assert.equal(args[1], "report"); assert.ok(args.includes("--clean=false")); assert.ok(args.includes("--all=true"), "覆盖率固定分母：统计全部生产源码");
    assert.ok(args.includes(`--temp-directory=${path.join(runDirectory, phase === "unit" ? "unit/raw" : "native/raw")}`));
    assert.ok(args.includes("--include=scripts/**/*.mjs")); assert.ok(!args.some(arg => arg.includes("--include=lib/")));
    assert.equal(args.includes("--"), false);
  }
  assert.deepEqual(result.raw.unit, result.raw.combined);
  assert.throws(() => toolingCoverageArgs(root, runDirectory, "other", cli), /INVALID_TOOLING_PHASE/);
});

test("tooling损坏raw、快照哈希与report失败绝不标成完整", async t => {
  const { root, manifest, data } = await toolingFixture(t), runDirectory = await rawFixture(root), cli = path.join(root, "c8.mjs");
  await put(runDirectory, "native/raw/raw.json", JSON.stringify({ result: [] }));
  await assert.rejects(rawInventory(path.join(runDirectory, "native/raw")), /INVALID_RAW_REPORT/);
  let calls = 0;
  const invalid = await collectToolingCoverage(root, runDirectory, manifest, { cli, run: async () => { calls++; return { code: 0 }; } });
  assert.equal(calls, 0); assert.ok(invalid.combined.errors.includes("INVALID_TOOLING_RAW:combined"));
  await rawFixture(root);
  await put(runDirectory, "unit/snapshot.json", JSON.stringify({ beforeE2E: true, files: ["raw.json"], hashes: { "raw.json": "wrong" } }));
  const stale = await collectToolingCoverage(root, runDirectory, manifest, { cli });
  assert.ok(stale.unit.errors.includes("INVALID_TOOLING_UNIT_SNAPSHOT"));
  await rawFixture(root);
  const failed = await collectToolingCoverage(root, runDirectory, manifest, { cli, run: async args => {
    const directory = args.find(arg => arg.startsWith("--reports-dir=")).slice("--reports-dir=".length);
    await put(directory, "coverage-final.json", JSON.stringify(data)); return { code: 7 };
  } });
  assert.ok(failed.unit.errors.includes("STAGE_FAILED:tooling-report:unit"));
  assert.ok(failed.combined.errors.includes("STAGE_FAILED:tooling-report:combined"));
  await put(runDirectory, "native/raw/extra.txt", "bad");
  await assert.rejects(rawInventory(path.join(runDirectory, "native/raw")), /INVALID_RAW_ENTRY/);
  await mkdir(path.join(root, "empty")); await assert.rejects(rawInventory(path.join(root, "empty")), /EMPTY_RAW_REPORTS/);
});

test("原始V8非法范围与tooling损坏report必须拒绝", async t => {
  const { root, manifest } = await toolingFixture(t), runDirectory = await rawFixture(root), cli = path.join(root, "c8.mjs");
  for (const functions of [null, [null], [{ ranges: [] }], [{ ranges: [{ startOffset: -1, endOffset: 1, count: 1 }] }], [{ ranges: [{ startOffset: 0, endOffset: 1, count: -1 }] }]]) {
    await put(runDirectory, "native/raw/raw.json", JSON.stringify({ result: [{ url: "file:///fixture.mjs", functions }] }));
    await assert.rejects(rawInventory(path.join(runDirectory, "native/raw")), /INVALID_RAW_REPORT/);
  }
  await rawFixture(root);
  for (const [text, error] of [["broken-json", "MISSING_OR_INVALID_REPORT"], ["{}", "EMPTY_TOOLING_REPORT"], ["[]", "INVALID_REPORT"], [JSON.stringify({ "lib/runtime.mjs": {} }), "INVALID_TOOLING_REPORT_SOURCE"]]) {
    const result = await collectToolingCoverage(root, runDirectory, manifest, { cli, run: async args => {
      const directory = args.find(arg => arg.startsWith("--reports-dir=")).slice("--reports-dir=".length);
      await put(directory, "coverage-final.json", text); return { code: 0 };
    } });
    for (const phase of ["unit", "combined"]) assert.ok(result[phase].errors.some(value => value.startsWith(error)));
  }
});

test("下载校验严拒缺页、损坏LCOV、错误scope与旧源码", async t => {
  const { root, manifest, data } = await toolingFixture(t);
  const result = await combineCoverage({ root, manifest, scope: TOOLING_ROOTS, inputs: [{ label: "actual", data }] });
  const directory = path.join(root, "coverage/tooling");
  const reset = () => writeReports(root, result, { collectionComplete: true }, "tooling");
  await reset(); assert.deepEqual(await verifyReports(root, "tooling"), []);
  await put(directory, "lcov.info", "SF:scripts/a.mjs\nend_of_record\n");
  assert.match((await verifyReports(root, "tooling"))[0], /report-hash-integrity/);
  await reset();
  const metadataPath = path.join(directory, "coverage-manifest.json");
  let metadata = JSON.parse(await readFile(metadataPath, "utf8"));
  const summary = JSON.parse(await readFile(path.join(directory, "coverage-summary.json"), "utf8")); delete summary["scripts/z.mjs"];
  const text = JSON.stringify(summary); await put(directory, "coverage-summary.json", text);
  metadata.reportHashes["coverage-summary.json"] = hashSource(text); await writeFile(metadataPath, JSON.stringify(metadata));
  assert.match((await verifyReports(root, "tooling"))[0], /report-source-integrity/);
  await reset(); metadata = JSON.parse(await readFile(metadataPath, "utf8")); metadata.scope = SOURCE_ROOTS;
  await writeFile(metadataPath, JSON.stringify(metadata)); assert.match((await verifyReports(root, "tooling"))[0], /source-integrity/);
  await reset(); await put(root, "scripts/z.mjs", "export const changed = 2;\n");
  assert.match((await verifyReports(root, "tooling"))[0], /source-integrity/);
  assert.equal((await verifyReports(root, "unit")).length, 1);
});
