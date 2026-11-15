import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { EventEmitter } from "node:events";
import { mkdtemp, mkdir, readFile, writeFile, readdir, rm } from "node:fs/promises";
import {
  ROOT, SOURCE_ROOTS, E2E_SCRIPTS, isProductionPath, relativeSource, snapshotSources, sourceChanges,
  hashSource, zeroFile, convertBrowserRecord, combineCoverage, writeReports, checkThreshold,
  coverageMain, collectCoverage, nativeCoverageArgs, localCli, npmCli, runNode,
} from "../scripts/coverage.mjs";
import { nativePlan, nativeMain, nativeTestFiles, snapshotNativeUnit } from "../scripts/coverage-native.mjs";
import { webSourceForUrl, saveBrowserEntries, instrumentChromium, installBrowserCoverage } from "../scripts/coverage-browser.mjs";

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), "campus-coverage-fixture-"));
  assert.equal(path.isAbsolute(root), true); assert.match(path.basename(root), /^campus-coverage-fixture-/);
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
async function put(root, relative, text) {
  const file = path.join(root, relative); await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, text); return file;
}
function browserRecord(file, source, count = 1) {
  return { file, source, hash: hashSource(source), functions: [{ functionName: "", isBlockCoverage: true, ranges: [{ startOffset: 0, endOffset: source.length, count }] }] };
}
async function hit(root, file) {
  const data = await zeroFile(root, file);
  for (const value of Object.values(data)) { delete value.all; for (const key of Object.keys(value.s)) value.s[key] = 1; }
  return data;
}

test("全生产范围包含八个根，排除的仅为构建/第三方/测试与声明", async t => {
  const root = await fixture(t);
  const wanted = SOURCE_ROOTS.map((directory, index) => `${directory}/entry${index}.${directory.endsWith("/src") ? "ts" : "mjs"}`);
  for (const file of wanted) await put(root, file, "export const value = 1;\n");
  for (const file of ["runtime/x.mjs", "lib/vendor/x.js", "lib/runtime/x.js", "webui/node_modules/x.js", "desktop/test/x.test.mjs", "packages/browser/test/x.mjs", "packages/learnx/dist/x.js", "packages/hetang/src/x.d.ts", "packages/thu-cloud/src/x.test.ts", "scripts/e2e-web.mjs"]) { await put(root, file, "fixture"); assert.equal(isProductionPath(file), false); }
  const manifest = await snapshotSources(root); assert.deepEqual(Object.keys(manifest.files), wanted.sort());
  assert.equal(relativeSource(root, pathToFileURL(path.join(root, wanted[0])).href), wanted[0]);
  assert.equal(relativeSource(root, path.resolve(root, "../outside.mjs")), null); assert.equal(relativeSource(root, "\0"), null);
  assert.equal(isProductionPath("lib/../private.js"), false); assert.equal(isProductionPath("C:/private.js"), false);
  assert.equal(sourceChanges(manifest, manifest).length, 0);
});
test("原生+三Vitest+浏览器可合并；未执行生产代码始终保留0，不引入dist SF", async t => {
  const root = await fixture(t), source = "export const browserValue = 1;\n";
  for (const file of ["lib/used.mjs", "lib/never.mjs", "desktop/launcher.mjs", "packages/browser/index.mjs", ...["hetang", "learnx", "thu-cloud"].map(name => `packages/${name}/src/index.ts`)]) await put(root, file, "export const value = 1;\n");
  await put(root, "webui/app.js", source); await put(root, "webui/sw.js", "const unusedWorker = 1;\n");
  const manifest = await snapshotSources(root), inputs = [{ label: "native", data: await hit(root, "lib/used.mjs") }];
  for (const name of ["hetang", "learnx", "thu-cloud"]) inputs.push({ label: name, data: await hit(root, `packages/${name}/src/index.ts`) });
  const result = await combineCoverage({ root, manifest, inputs, browser: [browserRecord("webui/app.js", source)] });
  assert.deepEqual(result.errors, []); assert.equal(result.map.files().length, Object.keys(manifest.files).length);
  assert.equal(result.map.fileCoverageFor(path.join(root, "lib/never.mjs")).toSummary().lines.covered, 0);
  assert.equal(result.map.fileCoverageFor(path.join(root, "webui/sw.js")).toSummary().lines.covered, 0);
  assert.equal(result.map.fileCoverageFor(path.join(root, "webui/app.js")).toSummary().lines.pct, 100);
  const summary = await writeReports(root, result, { collectionComplete: true });
  await writeReports(root, result, { collectionComplete: true }, "unit");
  const lcov = await readFile(path.join(root, "coverage/lcov.info"), "utf8");
  const paths = [...lcov.matchAll(/^SF:(.+)$/gm)].map(match => match[1]); assert.deepEqual(paths.sort(), Object.keys(manifest.files).sort());
  assert.ok(paths.every(file => !file.includes("\\") && !file.includes(":") && !file.includes("dist/") && !file.startsWith("/")));
  const json = JSON.parse(await readFile(path.join(root, "coverage/coverage-final.json"), "utf8")); assert.deepEqual(Object.keys(json).sort(), paths.sort());
  assert.ok((await readFile(path.join(root, "coverage/html/index.html"), "utf8")).includes("coverage"));
  assert.ok(checkThreshold(summary, 90).includes("lines")); assert.equal(await coverageMain(["--check", "90"], root), 1);
  assert.equal(await readFile(path.join(root, "coverage/lcov.info"), "utf8"), lcov);
  assert.equal(await coverageMain(["--check", "0"], root), 0);
});
test("完整真实AST映射不混入empty-report函数或逐行statement", async t => {
  const root = await fixture(t), file = "lib/ast.mjs";
  await put(root, file, "export function only() {\n  return 1;\n}\n");
  const absolute = path.join(root, file), loc = { start: { line: 2, column: 2 }, end: { line: 2, column: 11 } };
  const ast = { path: absolute, statementMap: { 0: loc }, s: { 0: 1 }, fnMap: { 0: { name: "only", decl: loc, loc, line: 1 } }, f: { 0: 1 }, branchMap: {}, b: {} };
  const result = await combineCoverage({ root, manifest: await snapshotSources(root), inputs: [{ label: "real-ast-fixture", data: { [absolute]: ast } }] });
  const actual = result.map.fileCoverageFor(absolute).toJSON();
  assert.deepEqual(actual.statementMap, ast.statementMap); assert.deepEqual(actual.fnMap, ast.fnMap); assert.deepEqual(actual.s, ast.s); assert.deepEqual(actual.f, ast.f);
  assert.ok(!JSON.stringify(actual).includes("empty-report"));
});
test("源码改变使旧hits失效，浏览器旧SW字节和损坏range不会套新文件", async t => {
  const root = await fixture(t), source = "export const value = 1;\n";
  await put(root, "webui/app.js", source); const manifest = await snapshotSources(root);
  for (const record of [{ ...browserRecord("webui/app.js", source), source: "old sw source" }, { ...browserRecord("webui/app.js", source), functions: [{ ranges: [{ startOffset: -1, endOffset: 5, count: 1 }] }] }, browserRecord("lib/outside.mjs", source)]) await assert.rejects(convertBrowserRecord(root, manifest, record));
  const bad = await combineCoverage({ root, manifest, browser: [{ ...browserRecord("webui/app.js", source), hash: "bad" }] }); assert.equal(bad.errors.length, 1); assert.equal(bad.map.getCoverageSummary().lines.covered, 0);
  await put(root, "webui/app.js", source + "export const changed = 2;\n");
  const stale = await combineCoverage({ root, manifest, inputs: [{ label: "old", data: await hit(root, "webui/app.js") }] });
  assert.match(stale.errors[0], /SOURCE_CHANGED/); assert.equal(stale.map.getCoverageSummary().lines.covered, 0);
});
test("非法JSON映射、负计数、外部与dist路径不污染生产报告", async t => {
  const root = await fixture(t); await put(root, "lib/a.mjs", "export const value = 1;\n"); const manifest = await snapshotSources(root), sample = await hit(root, "lib/a.mjs"), data = Object.values(sample)[0];
  const result = await combineCoverage({ root, manifest, inputs: [
    { label: "invalid", data: [] }, { label: "paths", data: { "packages/learnx/dist/a.js": data, "node_modules/a.js": data } },
    { label: "negative", data: { "lib/a.mjs": { ...data, path: "lib/a.mjs", s: { 0: -1 } } } },
    { label: "nonfinite", data: { "lib/a.mjs": { ...data, path: "lib/a.mjs", s: { 0: NaN } } } },
    { label: "mismatch", data: { "lib/a.mjs": { ...data, path: "lib/b.mjs" } } },
  ] });
  assert.ok(result.errors.some(error => error.startsWith("UNMAPPED_DIST"))); assert.ok(result.errors.some(error => error.startsWith("INVALID_REPORT"))); assert.ok(result.errors.some(error => error.startsWith("INVALID_SOURCE"))); assert.equal(result.map.getCoverageSummary().lines.covered, 0);
  // 负计数只作未覆盖处理：保守钳制为 0 并显式记录，绝不因单个转换器产物丢弃整份文件（那会谎报更低覆盖）。
  assert.ok(result.warnings.some(warning => warning.startsWith("NEGATIVE_COUNT_CLAMPED:negative:lib/a.mjs")));
  assert.deepEqual(result.map.fileCoverageFor(path.join(root, "lib/a.mjs")).toJSON().s, { 0: 0 });
  for (const threshold of [NaN, Infinity, -1, 101]) assert.throws(() => checkThreshold({}, threshold));
  await assert.rejects(coverageMain(["--skip-e2e"], root));
});
test("两个phase保守处理负计数但不修改共享原始报告", async t => {
  const root = await fixture(t), file = "lib/a.mjs";
  await put(root, file, "export const value = 1;\n");
  const manifest = await snapshotSources(root), data = await hit(root, file);
  const entry = Object.values(data)[0];
  entry.b = { 0: [-2] };
  entry.branchMap = { 0: { type: "branch", line: 1, loc: { start: { line: 1, column: 0 }, end: { line: 1, column: 23 } }, locations: [{ start: { line: 1, column: 0 }, end: { line: 1, column: 23 } }] } };
  const raw = structuredClone(data);
  const inputs = [{ label: "vitest:fixture", data }];
  const unit = await combineCoverage({ root, manifest, inputs });
  const combined = await combineCoverage({ root, manifest, inputs });
  assert.deepEqual(data, raw);
  assert.deepEqual(unit.errors, []);
  assert.deepEqual(combined.errors, []);
  assert.deepEqual(unit.warnings, ["NEGATIVE_COUNT_CLAMPED:vitest:fixture:lib/a.mjs:1"]);
  assert.deepEqual(combined.warnings, unit.warnings);
  for (const result of [unit, combined]) {
    assert.deepEqual(result.map.fileCoverageFor(path.join(root, file)).toJSON().b, { 0: [0] });
    assert.equal(result.map.getCoverageSummary().branches.covered, 0);
  }
});

test("浏览器只保存本机已核对的webui源码，不持久化URL/token；缺源码与旧版本留错误", async t => {
  const root = await fixture(t), source = "const browserValue = 1;\n";
  await put(root, "webui/app.js", source); const manifest = await snapshotSources(root), directory = path.join(root, "browser");
  const entry = { url: "http://127.0.0.1:1234/app.js?token=fixture-private#secret", source, functions: browserRecord("webui/app.js", source).functions };
  const saved = await saveBrowserEntries([entry, { ...entry, url: "https://foreign.invalid/app.js" }, { ...entry, source: "stale" }, { ...entry, source: undefined }], { root, manifest, directory });
  assert.equal(saved.records, 1); assert.equal(saved.errors.length, 2);
  const text = await readFile(path.join(directory, (await readdir(directory))[0]), "utf8"); assert.ok(!text.includes("fixture-private")); assert.ok(!text.includes("127.0.0.1"));
  for (const url of ["file:///tmp/app.js", "https://foreign.invalid/app.js", "http://localhost/%2e%2e%2fprivate.js", "not-a-url", "http://user:pass@localhost/app.js"]) assert.equal(webSourceForUrl(url), null);
  assert.equal(webSourceForUrl("http://localhost/webui/app.js?v=1"), "webui/app.js");
  await assert.rejects(installBrowserCoverage({}));
});
function fakeChromium(events, { failStart = false, failStop = false } = {}) {
  const context = new EventEmitter(), browser = {}, pages = [];
  const newPage = async () => {
    const page = new EventEmitter(); page.context = () => context;
    page.coverage = { startJSCoverage: async options => { events.push("start"); assert.equal(options.resetOnNavigation, false); await Promise.resolve(); if (failStart) throw new Error("fixture"); }, stopJSCoverage: async () => { events.push("stop"); if (failStop) throw new Error("fixture"); return []; } };
    page.close = async () => { events.push("page-close"); page.emit("close"); }; pages.push(page); context.emit("page", page); return page;
  };
  context.pages = () => pages; context.newPage = newPage; context.close = async () => { events.push("context-close"); };
  browser.contexts = () => [context]; browser.newContext = async () => context; browser.newPage = newPage; browser.close = async () => { events.push("browser-close"); };
  return { chromium: { launch: async () => browser, launchPersistentContext: async () => context }, context };
}
test("hook在newPage返回前await采集，并在page/context/browser关闭前flush且不重复stop", async () => {
  for (const close of ["page", "context", "browser"]) {
    const events = [], problems = [], { chromium } = fakeChromium(events);
    instrumentChromium(chromium, { save: async () => { events.push("save"); return { errors: [] }; }, problem: code => problems.push(code) });
    const browser = await chromium.launch(), context = await browser.newContext(), page = await browser.newPage();
    assert.deepEqual(events, ["start"]); events.push("newPage-returned");
    await (close === "page" ? page : close === "context" ? context : browser).close();
    assert.ok(events.indexOf("save") < events.indexOf(close + "-close")); await browser.close(); assert.equal(events.filter(event => event === "stop").length, 1); assert.deepEqual(problems, []);
  }
  const events = [], { chromium } = fakeChromium(events); instrumentChromium(chromium, { save: async () => ({ errors: [] }) });
  const context = await chromium.launchPersistentContext(); await context.newPage(); await context.close(); assert.ok(events.includes("stop"));
});
test("hook采集错误不阻止原始关闭，但留下明确失败", async () => {
  for (const options of [{ failStart: true }, { failStop: true }, {}]) {
    const events = [], problems = [], { chromium } = fakeChromium(events, options);
    instrumentChromium(chromium, { save: async () => ({ errors: ["BROWSER_SOURCE_MISMATCH:webui/app.js"] }), problem: code => problems.push(code) });
    const browser = await chromium.launch(); await browser.newPage(); await browser.close(); assert.ok(events.includes("browser-close")); assert.equal(problems.length, 1);
  }
});
test("原生计划覆盖四组测试和四个E2E，NODE_V8_COVERAGE跨子进程原样保留", async t => {
  const root = await fixture(t);
  for (const file of ["test/root.test.mjs", "test/coverage.test.mjs", "desktop/test/desktop.test.mjs", "packages/browser/test/browser.test.mjs", "packages/thu-cloud/test/workspace-storage.test.mjs", "packages/browser/test/manual-close.mjs"]) await put(root, file, "// fixture");
  const runDirectory = path.join(root, "coverage-run"); await mkdir(runDirectory);
  const env = { NODE_V8_COVERAGE: path.join(runDirectory, "native/raw"), CAMPUS_COVERAGE_RUN_DIR: runDirectory, CAMPUS_COVERAGE_MANIFEST: path.join(runDirectory, "manifest.json") };
  await put(runDirectory, "native/raw/unit.json", "{}");
  const plan = await nativePlan(root, env); assert.equal(plan.length, 5); assert.equal((await nativeTestFiles(root)).length, 5);
  assert.ok(plan[0].args.includes("--test")); assert.ok(!plan[0].args.some(arg => arg.includes("manual-close")));
  assert.deepEqual(plan.slice(1).map(stage => path.basename(stage.args.at(-1))), E2E_SCRIPTS); assert.ok(plan.every(stage => stage.env.NODE_V8_COVERAGE === env.NODE_V8_COVERAGE)); assert.ok(plan.slice(1).every(stage => stage.args.includes("--import")));
  assert.ok(!JSON.stringify(plan).includes("e2e-sandbox")); await assert.rejects(nativePlan(root, {}));
  const calls = []; assert.equal(await nativeMain(root, env, async args => { calls.push(args); if (calls.length === 3) await put(runDirectory, "native/raw/e2e.json", "{}"); return { code: calls.length === 2 ? 1 : 0 }; }), 1); assert.equal(calls.length, 6);
  assert.equal(calls[1][1], "report"); assert.ok(calls[1].includes("--clean=false"));
  assert.deepEqual(await readdir(path.join(runDirectory, "unit/raw")), ["unit.json"]); assert.ok((await readdir(env.NODE_V8_COVERAGE)).includes("e2e.json"));
  const c8 = nativeCoverageArgs(ROOT, runDirectory); assert.equal(c8.filter(arg => arg === "--clean=true").length, 1); assert.ok(c8.includes("--all=false")); assert.ok(path.isAbsolute(c8[0])); assert.ok(c8.includes(process.execPath));
  assert.ok(path.isAbsolute(localCli(ROOT, "vitest", "vitest.mjs"))); assert.ok(path.isAbsolute(npmCli()));
});
test("spawn始终是绝对Node与inherit stdio，不使用shell/PATH，并记录退出/信号/错误", async () => {
  for (const outcome of [{ code: 0 }, { code: null, signal: "SIGTERM" }, { error: "ENOENT" }]) {
    const result = await runNode([path.join(ROOT, "fixture.mjs")], { spawnImpl: (file, args, options) => {
      assert.equal(file, process.execPath); assert.equal(options.shell, false); assert.equal(options.stdio, "inherit");
      const child = new EventEmitter(); queueMicrotask(() => outcome.error ? child.emit("error", Object.assign(new Error("fixture"), { code: outcome.error })) : child.emit("exit", outcome.code, outcome.signal)); return child;
    } }); assert.equal(result.code, outcome.code === 0 ? 0 : 1);
  }
});
test("完整汇总顺序可用fake runner窄测，单c8且不会合并旧run；报告先于90%失败落盘", async t => {
  const root = await fixture(t), source = "const value = 1;\n";
  await put(root, "lib/untested.mjs", source); await put(root, "webui/app.js", source);
  await put(root, "coverage/vitest/hetang/coverage-final.json", "old report must not be loaded");
  const calls = [];
  const run = async (args, options) => {
    calls.push(args);
    const reportArg = args.find(arg => arg.startsWith("--coverage.reportsDirectory="));
    if (reportArg) { const directory = reportArg.split("=")[1]; await mkdir(directory, { recursive: true }); await writeFile(path.join(directory, "coverage-final.json"), "{}"); }
    const native = args.find(arg => arg.startsWith("--reports-dir="));
    if (native) {
      const directory = native.split("=")[1]; await mkdir(directory, { recursive: true }); await writeFile(path.join(directory, "coverage-final.json"), JSON.stringify(await hit(root, "lib/untested.mjs")));
      const runDirectory = options.env.CAMPUS_COVERAGE_RUN_DIR;
      await put(runDirectory, "unit/native/coverage-final.json", "{}");
      await put(runDirectory, "native-stages.json", JSON.stringify(["node-tests", "unit-report", ...E2E_SCRIPTS].map(name => ({ name, code: 0 }))));
      assert.equal(options.env.TEMP, path.join(runDirectory, "tmp")); assert.equal(options.env.TMP, options.env.TEMP);
      const browser = path.join(runDirectory, "browser"); await mkdir(browser); await writeFile(path.join(browser, "fixture.json"), JSON.stringify({ records: [browserRecord("webui/app.js", source)], errors: [] }));
    }
    return { code: 0 };
  };
  const code = await collectCoverage(root, { run, resolveCli: (_root, name) => path.join(root, name + ".mjs"), resolveNpm: () => path.join(root, "npm-cli.js") });
  assert.equal(code, 0); assert.equal(calls.length, 5); assert.equal(calls.filter(args => args.some(arg => arg.startsWith("--reports-dir="))).length, 1);
  assert.deepEqual(calls[0].slice(1), ["run", "build", "--workspaces"]); assert.equal(await coverageMain(["--check", "90"], root), 1);
  assert.ok((await readFile(path.join(root, "coverage/lcov.info"), "utf8")).includes("SF:lib/untested.mjs"));
  const metadata = JSON.parse(await readFile(path.join(root, "coverage/coverage-manifest.json"), "utf8")); assert.equal(metadata.collectionComplete, true);
  const unitSummary = JSON.parse(await readFile(path.join(root, "coverage/unit/coverage-summary.json"), "utf8"));
  const combinedSummary = JSON.parse(await readFile(path.join(root, "coverage/coverage-summary.json"), "utf8"));
  assert.equal(unitSummary.total.lines.covered, 0); assert.equal(combinedSummary.total.lines.pct, 100);
  assert.equal(JSON.parse(await readFile(path.join(root, "coverage/unit/coverage-manifest.json"), "utf8")).collectionComplete, true);
});
test("本地c8实际tiny fixture验证一次采集、unit快照report与TS重映射，不运行项目套件", async t => {
  const root = await fixture(t), runDirectory = path.join(root, "coverage-run"); await mkdir(runDirectory);
  await put(root, "package.json", '{"type":"module"}'); await put(runDirectory, "c8-config.json", "{}");
  await put(root, "lib/example.mjs", "export const example = 1;\n");
  await put(root, "packages/learnx/src/example.ts", "export const value: number = 1;\n");
  await put(root, "packages/learnx/dist/example.js", "export const value = 1;\n//# sourceMappingURL=example.js.map\n");
  await put(root, "packages/learnx/dist/example.js.map", JSON.stringify({ version: 3, file: "example.js", sources: ["../src/example.ts"], sourcesContent: ["export const value: number = 1;\n"], names: [], mappings: "AAAA" }));
  await put(root, "scripts/coverage-native.mjs", 'import "../lib/example.mjs"; import "../packages/learnx/dist/example.js";\n');
  const cli = localCli(ROOT, "c8", "bin/c8.js");
  assert.equal((await runNode(nativeCoverageArgs(root, runDirectory, cli), { cwd: root })).code, 0);
  const combined = JSON.parse(await readFile(path.join(runDirectory, "native/coverage-final.json"), "utf8"));
  const files = Object.keys(combined).map(file => relativeSource(root, file)); assert.ok(files.includes("lib/example.mjs")); assert.ok(files.includes("packages/learnx/src/example.ts")); assert.ok(files.every(Boolean));
  const env = { ...process.env, NODE_V8_COVERAGE: path.join(runDirectory, "native/raw"), CAMPUS_COVERAGE_RUN_DIR: runDirectory };
  assert.equal((await snapshotNativeUnit(root, env)).code, 0);
  const snapshot = JSON.parse(await readFile(path.join(runDirectory, "unit/snapshot.json"), "utf8")); assert.equal(snapshot.beforeE2E, true); assert.ok(snapshot.files.length > 0);
  assert.deepEqual(Object.keys(JSON.parse(await readFile(path.join(runDirectory, "unit/native/coverage-final.json"), "utf8"))).sort(), Object.keys(combined).sort());
});
test("构建/测试失败仍输出全分母LCOV，缺报告不能伪装采集完整", async t => {
  const root = await fixture(t); await put(root, "lib/untested.mjs", "const value = 1;\n");
  let calls = 0;
  assert.equal(await collectCoverage(root, { run: async () => { calls++; return { code: 1 }; }, resolveCli: (_root, name) => path.join(root, name + ".mjs"), resolveNpm: () => path.join(root, "npm-cli.js") }), 1);
  assert.equal(calls, 4); const metadata = JSON.parse(await readFile(path.join(root, "coverage/coverage-manifest.json"), "utf8")); assert.equal(metadata.collectionComplete, false); assert.ok(metadata.errors.includes("BUILD_FAILED_NATIVE_SKIPPED"));
  assert.ok((await readFile(path.join(root, "coverage/lcov.info"), "utf8")).includes("DA:1,0")); assert.equal(await coverageMain(["--check", "0"], root), 1);
});
