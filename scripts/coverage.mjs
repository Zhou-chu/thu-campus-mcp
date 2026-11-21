#!/usr/bin/env node
/** Full production coverage. Collection and threshold checking are deliberately separate. */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { readdir, readFile, writeFile, mkdir, lstat } from "node:fs/promises";
import libCoverage from "istanbul-lib-coverage";
import libReport from "istanbul-lib-report";
import reports from "istanbul-reports";
import v8ToIstanbul from "v8-to-istanbul";

export const ROOT = path.resolve(fileURLToPath(new URL("../", import.meta.url)));
export const SDKS = ["hetang", "learnx", "thu-cloud"];
export const SOURCE_ROOTS = ["lib", "bin", "webui", "desktop", "packages/browser", ...SDKS.map(name => `packages/${name}/src`)];
export const TOOLING_ROOTS = ["scripts"];
export const E2E_SCRIPTS = ["e2e-web.mjs", "e2e-streaming.mjs", "e2e-workspace.mjs", "e2e-auth-workspace.mjs"];
const EXCLUDED_PARTS = new Set(["node_modules", "vendor", "runtime", ".runtime", "dist", "coverage", "test", "tests", "__tests__"]);
const EXTENSIONS = [".js", ".mjs", ".cjs", ".ts"];
export const hashSource = text => createHash("sha256").update(text).digest("hex");
const slash = value => value.replaceAll("\\", "/");
export const isMain = url => Boolean(process.argv[1]) && path.resolve(process.argv[1]) === fileURLToPath(url);

export function isProductionPath(relative, scope = SOURCE_ROOTS) {
  const name = slash(relative);
  if (path.posix.isAbsolute(name) || name.includes(":") || name.split("/").some(part => part === ".." || EXCLUDED_PARTS.has(part))) return false;
  if (!scope.some(root => name.startsWith(root + "/"))) return false;
  if (/\.(?:test|spec)\.[^.]+$/.test(name) || name.endsWith(".d.ts")) return false;
  return EXTENSIONS.some(ext => name.endsWith(ext));
}
export function relativeSource(root, filename, scope = SOURCE_ROOTS) {
  if (typeof filename !== "string" || !filename || filename.includes("\0")) return null;
  try {
    const file = filename.startsWith("file:") ? fileURLToPath(filename) : filename;
    const relative = slash(path.relative(root, path.resolve(root, file)));
    return isProductionPath(relative, scope) ? relative : null;
  } catch { return null; }
}
async function walkSources(root, relative, files, scope) {
  let entries;
  try { entries = await readdir(path.join(root, relative), { withFileTypes: true }); }
  catch (error) { if (error.code === "ENOENT") return; throw error; }
  for (const entry of entries) {
    if (EXCLUDED_PARTS.has(entry.name)) continue;
    const child = slash(path.join(relative, entry.name));
    if (entry.isSymbolicLink()) throw new Error(`SOURCE_SYMLINK:${child}`);
    if (entry.isDirectory()) await walkSources(root, child, files, scope);
    else if (entry.isFile() && isProductionPath(child, scope)) files.push(child);
  }
}
function validateScope(scope) {
  if (![SOURCE_ROOTS, TOOLING_ROOTS].some(allowed => JSON.stringify(scope) === JSON.stringify(allowed))) throw new Error("INVALID_COVERAGE_SCOPE");
}
export async function snapshotSources(root = ROOT, scope = SOURCE_ROOTS) {
  validateScope(scope);
  const files = [];
  for (const directory of scope) await walkSources(root, directory, files, scope);
  const hashes = {};
  for (const file of files.sort((a, b) => a.localeCompare(b))) hashes[file] = hashSource(await readFile(path.join(root, file), "utf8"));
  return { schema: 1, scope: [...scope], files: hashes };
}
export function sourceChanges(before, after) {
  const names = new Set([...Object.keys(before.files), ...Object.keys(after.files)]);
  return [...names].filter(name => before.files[name] !== after.files[name]).sort((a, b) => a.localeCompare(b));
}
async function v8File(root, relative, source, functions, scope = SOURCE_ROOTS) {
  const absolute = path.join(root, relative);
  const converter = v8ToIstanbul(absolute, 0, { source });
  await converter.load(); converter.applyCoverage(functions);
  const data = converter.toIstanbul();
  if (Object.keys(data).some(file => relativeSource(root, file, scope) !== relative)) throw new Error(`UNVERIFIED_SOURCE_MAP:${relative}`);
  return data;
}
export async function zeroFile(root, relative, scope = SOURCE_ROOTS) {
  const source = await readFile(path.join(root, relative), "utf8");
  return v8File(root, relative, source, [{ functionName: "(empty-report)", isBlockCoverage: true, ranges: [{ startOffset: 0, endOffset: source.length, count: 0 }] }], scope);
}
const isRecord = value => value !== null && typeof value === "object" && !Array.isArray(value);
const sameKeys = (left, right) => Object.keys(left).length === Object.keys(right).length && Object.keys(left).every(key => Object.hasOwn(right, key));
function validCounts(data) {
  if (!isRecord(data) || !["s", "f", "b", "statementMap", "fnMap", "branchMap"].every(key => isRecord(data[key]))) return false;
  if (!sameKeys(data.s, data.statementMap) || !sameKeys(data.f, data.fnMap) || !sameKeys(data.b, data.branchMap)) return false;
  if (!Object.values(data.s).every(Number.isFinite) || !Object.values(data.f).every(Number.isFinite)) return false;
  return Object.entries(data.b).every(([key, counts]) => Array.isArray(counts) && counts.every(Number.isFinite) && Array.isArray(data.branchMap[key]?.locations) && counts.length === data.branchMap[key].locations.length);
}
/**
 * v8→istanbul 转换偶尔会给出负数计数（实测见 packages/hetang/src/resources.ts 的分支 -2）。
 * 负计数不是“更多覆盖”，语义上只能当作未覆盖：这里保守钳制为 0 并记录 warning，
 * 而不是把整份文件丢弃——丢弃会让该文件全部行按未覆盖计入，反而谎报更低的覆盖率。
 * 非有限值仍属结构损坏，继续硬拒绝（见 validCounts 与 INVALID_SOURCE）。
 */
function clampNegativeCounts(data) {
  let clamped = 0;
  const fix = value => { if (value < 0) { clamped++; return 0; } return value; };
  for (const key of Object.keys(data.s || {})) data.s[key] = fix(data.s[key]);
  for (const key of Object.keys(data.f || {})) data.f[key] = fix(data.f[key]);
  for (const key of Object.keys(data.b || {})) data.b[key] = data.b[key].map(fix);
  return clamped;
}
function mergeInput(map, root, manifest, input, errors, ignored, warnings) {
  if (!isRecord(input) || !isRecord(input.data)) { errors.push(`INVALID_REPORT:${input?.label || "unknown"}`); return; }
  for (const [filename, data] of Object.entries(input.data)) {
    const relative = relativeSource(root, filename, manifest.scope);
    if (!relative) {
      ignored.count++;
      if (/(?:^|[\\/])dist[\\/]/.test(filename)) errors.push(`UNMAPPED_DIST:${input.label}`);
      continue;
    }
    if (!Object.hasOwn(manifest.files, relative) || relativeSource(root, data?.path, manifest.scope) !== relative || !validCounts(data)) { errors.push(`INVALID_SOURCE:${input.label}:${relative}`); continue; }
    // unit 与 combined 共用原始输入；不得原地修正计数，否则后一阶段会漏记告警。
    const normalized = structuredClone(data);
    const clamped = clampNegativeCounts(normalized);
    if (clamped) warnings.push(`NEGATIVE_COUNT_CLAMPED:${input.label}:${relative}:${clamped}`);
    try { map.addFileCoverage({ ...normalized, path: path.join(root, relative) }); }
    catch { errors.push(`INVALID_COVERAGE:${input.label}:${relative}`); }
  }
}
export async function convertBrowserRecord(root, manifest, record) {
  const relative = record.file;
  if (typeof relative !== "string" || !relative.startsWith("webui/") || !isProductionPath(relative) || !Object.hasOwn(manifest.files, relative)) throw new Error("INVALID_BROWSER_SOURCE");
  if (typeof record.source !== "string" || hashSource(record.source) !== record.hash || manifest.files[relative] !== record.hash) throw new Error(`BROWSER_SOURCE_MISMATCH:${relative}`);
  if (hashSource(await readFile(path.join(root, relative), "utf8")) !== record.hash) throw new Error(`SOURCE_CHANGED:${relative}`);
  if (!record.functions?.length || !validV8Functions(record.functions, record.source.length)) throw new Error(`INVALID_BROWSER_RANGES:${relative}`);
  return v8File(root, relative, record.source, record.functions);
}
/** Untouched production sources remain zero. Stale source versions invalidate all hits. */
export async function combineCoverage({ root = ROOT, manifest, inputs = [], browser = [], scope = SOURCE_ROOTS }) {
  const current = await snapshotSources(root, scope), errors = [], warnings = [], ignored = { count: 0 }, map = libCoverage.createCoverageMap({});
  if (JSON.stringify(manifest.scope) !== JSON.stringify(current.scope)) errors.push("SOURCE_SCOPE_MISMATCH");
  const changed = sourceChanges(manifest, current);
  if (changed.length) errors.push(...changed.map(file => `SOURCE_CHANGED:${file}`));
  if (!errors.length) {
    for (const input of inputs) mergeInput(map, root, current, input, errors, ignored, warnings);
    for (const record of browser) {
      try { map.merge(await convertBrowserRecord(root, current, record)); }
      catch (error) { errors.push(error.message); }
    }
  }
  for (const relative of Object.keys(current.files)) if (!map.files().includes(path.join(root, relative))) map.merge(await zeroFile(root, relative, scope));
  return { map, manifest: current, errors, warnings, ignoredInputFiles: ignored.count };
}
export function checkThreshold(summary, threshold = 90) {
  if (!Number.isFinite(threshold) || threshold < 0 || threshold > 100) throw new Error("Threshold must be 0..100");
  return ["lines", "statements", "branches", "functions"].filter(metric => !summary?.total?.[metric] || !Number.isFinite(summary.total[metric].pct) || summary.total[metric].pct < threshold);
}
async function ensureOutput(root) {
  const directory = path.join(root, "coverage");
  try { if ((await lstat(directory)).isSymbolicLink()) throw new Error("COVERAGE_DIRECTORY_SYMLINK"); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  await mkdir(directory, { recursive: true }); return directory;
}
/** LCOV is emitted before any gate. SF paths must be real repository-relative sources. */
export async function writeReports(root, result, metadata = {}, phase = "") {
  if (!["", "unit", "tooling", "tooling/unit"].includes(phase)) throw new Error("INVALID_REPORT_PHASE");
  const scope = phase.startsWith("tooling") ? TOOLING_ROOTS : SOURCE_ROOTS;
  if (JSON.stringify(result.manifest.scope) !== JSON.stringify(scope)) throw new Error("REPORT_SCOPE_MISMATCH");
  const output = await ensureOutput(root), directory = phase ? path.join(output, phase) : output;
  await mkdir(directory, { recursive: true });
  const context = libReport.createContext({ dir: directory, coverageMap: result.map, sourceFinder: file => readFileSync(path.resolve(root, file), "utf8") });
  reports.create("lcovonly", { projectRoot: root }).execute(context);
  const lcov = (await readFile(path.join(directory, "lcov.info"), "utf8")).replace(/^SF:(.*)$/gm, (_, file) => {
    const relative = slash(file);
    if (!Object.hasOwn(result.manifest.files, relative) || !isProductionPath(relative, scope)) throw new Error("INVALID_LCOV_SOURCE");
    return `SF:${relative}`;
  });
  await writeFile(path.join(directory, "lcov.info"), lcov);
  const data = {}, summary = { total: result.map.getCoverageSummary().toJSON() };
  for (const filename of result.map.files().sort((a, b) => a.localeCompare(b))) {
    const relative = relativeSource(root, filename, scope), coverage = result.map.fileCoverageFor(filename);
    data[relative] = { ...coverage.toJSON(), path: relative }; summary[relative] = coverage.toSummary().toJSON();
  }
  await writeFile(path.join(directory, "coverage-final.json"), JSON.stringify(data));
  await writeFile(path.join(directory, "coverage-summary.json"), JSON.stringify(summary, null, 2));
  const reportHashes = {};
  for (const file of ["lcov.info", "coverage-final.json", "coverage-summary.json"]) reportHashes[file] = hashSource(await readFile(path.join(directory, file), "utf8"));
  await writeFile(path.join(directory, "coverage-manifest.json"), JSON.stringify({ ...metadata, ...result.manifest, reportHashes, errors: result.errors, warnings: result.warnings, ignoredInputFiles: result.ignoredInputFiles }, null, 2));
  reports.create("html", { subdir: "html" }).execute(context);
  return summary;
}
export function localCli(root, name, filename) {
  const require = createRequire(path.join(root, "package.json"));
  return path.join(path.dirname(require.resolve(`${name}/package.json`)), filename);
}
export function npmCli(env = process.env) {
  const candidates = [env.npm_execpath, path.join(path.dirname(process.execPath), "node_modules/npm/bin/npm-cli.js"), path.resolve(path.dirname(process.execPath), "../lib/node_modules/npm/bin/npm-cli.js")];
  for (const file of candidates) {
    if (!file || !path.isAbsolute(file)) continue;
    try { if (/^npm-cli\.[cm]?js$/.test(path.basename(file)) && readFileSync(file, "utf8").length) return file; } catch { /* next explicit local candidate */ }
  }
  throw new Error("LOCAL_NPM_CLI_UNAVAILABLE");
}
export async function runNode(args, { cwd = ROOT, env = process.env, spawnImpl = spawn } = {}) {
  return new Promise(resolve => {
    const child = spawnImpl(process.execPath, args, { cwd, env, shell: false, stdio: "inherit" });
    child.once("error", error => resolve({ code: 1, error: /^[A-Z_]+$/.test(error.code || "") ? error.code : "SPAWN_FAILED" }));
    child.once("exit", (code, signal) => resolve({ code: code ?? 1, ...(signal ? { signal } : {}) }));
  });
}
export function nativeCoverageArgs(root, runDirectory, cli = localCli(root, "c8", "bin/c8.js")) {
  const args = [cli, `--config=${path.join(runDirectory, "c8-config.json")}`, "--all=true", "--clean=true", "--merge-async", "--exclude-after-remap", "--reporter=json", `--reports-dir=${path.join(runDirectory, "native")}`, `--temp-directory=${path.join(runDirectory, "native/raw")}`];
  for (const directory of SOURCE_ROOTS) {
    args.push(`--src=${path.join(root, directory)}`);
    for (const ext of EXTENSIONS) args.push(`--include=${directory}/**/*${ext}`);
  }
  for (const part of EXCLUDED_PARTS) args.push(`--exclude=**/${part}/**`);
  args.push("--exclude=**/*.test.*", "--exclude=**/*.spec.*", "--exclude=**/*.d.ts");
  for (const ext of EXTENSIONS) args.push(`--extension=${ext}`);
  return [...args, "--", process.execPath, "--enable-source-maps", path.join(root, "scripts/coverage-native.mjs")];
}
async function readInput(file, label, errors) {
  try { return { label, data: JSON.parse(await readFile(file, "utf8")) }; }
  catch { errors.push(`MISSING_OR_INVALID_REPORT:${label}`); return { label, data: {} }; }
}
async function readBrowserRecords(directory, errors) {
  let names;
  try { names = await readdir(directory); } catch (error) { if (error.code === "ENOENT") { errors.push("MISSING_BROWSER_REPORTS"); return []; } throw error; }
  const records = [];
  for (const name of names.filter(name => name.endsWith(".json")).sort((a, b) => a.localeCompare(b))) {
    try {
      const payload = JSON.parse(await readFile(path.join(directory, name), "utf8"));
      if (!Array.isArray(payload.records) || payload.records.some(record => !isRecord(record)) || !Array.isArray(payload.errors) || payload.errors.some(error => typeof error !== "string")) throw new Error("format");
      records.push(...payload.records); errors.push(...payload.errors);
    } catch { errors.push("INVALID_BROWSER_REPORT"); }
  }
  if (!records.length) errors.push("NO_BROWSER_SCRIPTS_COLLECTED");
  return records;
}
export function unitCoverageArgs(root, runDirectory, cli = localCli(root, "c8", "bin/c8.js")) {
  const native = nativeCoverageArgs(root, runDirectory, cli);
  const options = native.slice(1, native.indexOf("--")).map(arg => {
    if (arg === "--clean=true") return "--clean=false";
    if (arg.startsWith("--reports-dir=")) return `--reports-dir=${path.join(runDirectory, "unit/native")}`;
    if (arg.startsWith("--temp-directory=")) return `--temp-directory=${path.join(runDirectory, "unit/raw")}`;
    return arg;
  });
  return [cli, "report", ...options];
}
export function toolingCoverageArgs(root, runDirectory, phase, cli = localCli(root, "c8", "bin/c8.js")) {
  if (!["unit", "combined"].includes(phase)) throw new Error("INVALID_TOOLING_PHASE");
  const args = unitCoverageArgs(root, runDirectory, cli).filter(arg => !arg.startsWith("--src=") && !arg.startsWith("--include="));
  return args.map(arg => {
    if (arg.startsWith("--reports-dir=")) return `--reports-dir=${path.join(runDirectory, "tooling", phase)}`;
    if (arg.startsWith("--temp-directory=")) return `--temp-directory=${path.join(runDirectory, phase === "unit" ? "unit/raw" : "native/raw")}`;
    return arg;
  }).concat(`--src=${path.join(root, "scripts")}`, ...EXTENSIONS.map(ext => `--include=scripts/**/*${ext}`));
}
function validV8Functions(functions, limit = Infinity) {
  return Array.isArray(functions) && functions.every(fn => isRecord(fn) && Array.isArray(fn.ranges) && fn.ranges.length > 0 && fn.ranges.every(range => isRecord(range) && Number.isSafeInteger(range.startOffset) && Number.isSafeInteger(range.endOffset) && range.startOffset >= 0 && range.endOffset >= range.startOffset && range.endOffset <= limit && Number.isFinite(range.count) && range.count >= 0));
}
export async function rawInventory(directory) {
  const files = {};
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) throw new Error("INVALID_RAW_ENTRY");
    const text = await readFile(path.join(directory, entry.name), "utf8"), payload = JSON.parse(text);
    if (!Array.isArray(payload?.result) || !payload.result.length || payload.result.some(script => !isRecord(script) || typeof script.url !== "string" || !validV8Functions(script.functions))) throw new Error("INVALID_RAW_REPORT");
    files[entry.name] = hashSource(text);
  }
  if (!Object.keys(files).length) throw new Error("EMPTY_RAW_REPORTS");
  return files;
}
export async function collectToolingCoverage(root, runDirectory, manifest, { run = runNode, cli = localCli(root, "c8", "bin/c8.js"), env = process.env, stages = [] } = {}) {
  const errors = [], raw = {};
  for (const phase of ["unit", "combined"]) {
    try { raw[phase] = await rawInventory(path.join(runDirectory, phase === "unit" ? "unit/raw" : "native/raw")); }
    catch { errors.push(`INVALID_TOOLING_RAW:${phase}`); }
  }
  try {
    const snapshot = JSON.parse(await readFile(path.join(runDirectory, "unit/snapshot.json"), "utf8"));
    if (snapshot.beforeE2E !== true || !Array.isArray(snapshot.files) || !isRecord(snapshot.hashes) || !raw.unit || !raw.combined || !sameKeys(snapshot.hashes, raw.unit) || snapshot.files.length !== Object.keys(raw.unit).length || new Set(snapshot.files).size !== snapshot.files.length || snapshot.files.some(file => !Object.hasOwn(raw.unit, file)) || Object.keys(raw.unit).some(file => snapshot.hashes[file] !== raw.unit[file] || raw.combined[file] !== raw.unit[file])) throw new Error("snapshot");
  } catch { errors.push("INVALID_TOOLING_UNIT_SNAPSHOT"); }
  const results = {};
  for (const phase of ["unit", "combined"]) {
    const phaseErrors = [...errors];
    if (!phaseErrors.length) {
      const stage = { name: `tooling-report:${phase}`, ...await run(toolingCoverageArgs(root, runDirectory, phase, cli), { cwd: root, env }) };
      stages.push(stage);
      if (stage.code !== 0) phaseErrors.push(`STAGE_FAILED:${stage.name}`);
    }
    const input = await readInput(path.join(runDirectory, "tooling", phase, "coverage-final.json"), `tooling:${phase}`, phaseErrors);
    if (isRecord(input.data)) {
      if (!Object.keys(input.data).length) phaseErrors.push(`EMPTY_TOOLING_REPORT:${phase}`);
      if (Object.keys(input.data).some(file => !relativeSource(root, file, TOOLING_ROOTS))) phaseErrors.push(`INVALID_TOOLING_REPORT_SOURCE:${phase}`);
    }
    const result = await combineCoverage({ root, manifest, scope: TOOLING_ROOTS, inputs: [input] });
    result.errors.push(...phaseErrors);
    results[phase] = result;
  }
  return { ...results, raw };
}
export async function verifyReports(root, phase) {
  if (!["unit", "combined", "tooling", "tooling/unit"].includes(phase)) throw new Error("INVALID_REPORT_PHASE");
  try {
    const scope = phase.startsWith("tooling") ? TOOLING_ROOTS : SOURCE_ROOTS;
    const current = await snapshotSources(root, scope), directory = path.join(root, "coverage", phase === "combined" ? "" : phase);
    const metadata = JSON.parse(await readFile(path.join(directory, "coverage-manifest.json"), "utf8"));
    if (!Object.keys(current.files).length || metadata.schema !== 1 || metadata.collectionComplete !== true || !Array.isArray(metadata.errors) || metadata.errors.length || JSON.stringify(metadata.scope) !== JSON.stringify(scope) || sourceChanges(metadata, current).length) throw new Error("collection/source-integrity");
    const contents = {};
    for (const file of ["lcov.info", "coverage-final.json", "coverage-summary.json"]) {
      contents[file] = await readFile(path.join(directory, file), "utf8");
      if (metadata.reportHashes?.[file] !== hashSource(contents[file])) throw new Error("report-hash-integrity");
    }
    const data = JSON.parse(contents["coverage-final.json"]), summary = JSON.parse(contents["coverage-summary.json"]);
    if (!isRecord(data) || !sameKeys(data, current.files) || !isRecord(summary) || !sameKeys(Object.fromEntries(Object.entries(summary).filter(([key]) => key !== "total")), current.files) || Object.entries(data).some(([file, value]) => value?.path !== file || !validCounts(value))) throw new Error("report-source-integrity");
    const paths = [...contents["lcov.info"].matchAll(/^SF:(.+)$/gm)].map(match => match[1]);
    if (paths.length !== Object.keys(current.files).length || new Set(paths).size !== paths.length || paths.some(file => !Object.hasOwn(current.files, file))) throw new Error("lcov-source-integrity");
    const map = libCoverage.createCoverageMap(data), actual = { total: map.getCoverageSummary().toJSON() };
    for (const file of map.files()) actual[file] = map.fileCoverageFor(file).toSummary().toJSON();
    if (JSON.stringify(actual.total) !== JSON.stringify(summary.total) || map.files().some(file => JSON.stringify(actual[file]) !== JSON.stringify(summary[file]))) throw new Error("summary-integrity");
    return [];
  } catch (error) { return [`${phase}:${error.message}`]; }
}
async function nativeStages(runDirectory, errors) {
  try {
    const stages = JSON.parse(await readFile(path.join(runDirectory, "native-stages.json"), "utf8"));
    const names = ["node-tests", "unit-report", ...E2E_SCRIPTS];
    if (!Array.isArray(stages) || stages.length !== names.length || stages.some(stage => !isRecord(stage) || !names.includes(stage.name) || !Number.isInteger(stage.code) || stage.code < 0) || new Set(stages.map(stage => stage.name)).size !== names.length) throw new Error("format");
    return stages;
  } catch { errors.push("MISSING_OR_INVALID_NATIVE_STAGES"); return []; }
}
export async function collectCoverage(root, { run = runNode, resolveCli = localCli, resolveNpm = npmCli } = {}) {
  const output = await ensureOutput(root), runDirectory = path.join(output, ".runs", randomUUID());
  const temporary = path.join(runDirectory, "tmp"); await mkdir(temporary, { recursive: true });
  const env = { ...process.env, TEMP: temporary, TMP: temporary, TMPDIR: temporary, npm_config_cache: path.join(runDirectory, "npm-cache"), npm_config_update_notifier: "false", CAMPUS_COVERAGE_ROOT: root, CAMPUS_COVERAGE_RUN_DIR: runDirectory, CAMPUS_COVERAGE_MANIFEST: path.join(runDirectory, "source-manifest.json") };
  const manifest = await snapshotSources(root), toolingManifest = await snapshotSources(root, TOOLING_ROOTS), stages = [], errors = [], unitErrors = [];
  await writeFile(env.CAMPUS_COVERAGE_MANIFEST, JSON.stringify(manifest));
  await writeFile(path.join(runDirectory, "tooling-source-manifest.json"), JSON.stringify(toolingManifest)); await writeFile(path.join(runDirectory, "c8-config.json"), "{}");
  const build = await run([resolveNpm(), "run", "build", "--workspaces"], { cwd: root, env }); stages.push({ name: "build", ...build });
  const cli = resolveCli(root, "vitest", "vitest.mjs");
  for (const sdk of SDKS) stages.push({ name: `vitest:${sdk}`, ...await run([cli, "run", "--coverage", `--coverage.reportsDirectory=${path.join(runDirectory, "vitest", sdk)}`], { cwd: path.join(root, "packages", sdk), env }) });
  if (build.code === 0) stages.push({ name: "native+e2e", ...await run(nativeCoverageArgs(root, runDirectory, resolveCli(root, "c8", "bin/c8.js")), { cwd: root, env }) });
  else unitErrors.push("BUILD_FAILED_NATIVE_SKIPPED");
  const phaseStages = await nativeStages(runDirectory, unitErrors);
  for (const name of ["node-tests", "unit-report"]) if (phaseStages.find(stage => stage.name === name)?.code !== 0) unitErrors.push(`STAGE_FAILED:${name}`);
  unitErrors.push(...stages.filter(stage => stage.name !== "native+e2e" && stage.code !== 0).map(stage => `STAGE_FAILED:${stage.name}`));
  const sdkInputs = [];
  for (const sdk of SDKS) sdkInputs.push(await readInput(path.join(runDirectory, "vitest", sdk, "coverage-final.json"), `vitest:${sdk}`, unitErrors));
  const unitInput = await readInput(path.join(runDirectory, "unit/native/coverage-final.json"), "native-unit", unitErrors);
  const unit = await combineCoverage({ root, manifest, inputs: [unitInput, ...sdkInputs] }); unit.errors.push(...unitErrors);
  const combinedInput = await readInput(path.join(runDirectory, "native/coverage-final.json"), "native+e2e", errors);
  const browser = await readBrowserRecords(path.join(runDirectory, "browser"), errors);
  const combined = await combineCoverage({ root, manifest, inputs: [combinedInput, ...sdkInputs], browser });
  combined.errors.push(...unit.errors, ...errors, ...[...stages, ...phaseStages].filter(stage => stage.code !== 0).map(stage => `STAGE_FAILED:${stage.name}`));
  const tooling = await collectToolingCoverage(root, runDirectory, toolingManifest, { run, cli: resolveCli(root, "c8", "bin/c8.js"), env, stages });
  const toolingStageErrors = [...stages, ...phaseStages].filter(stage => stage.code !== 0).map(stage => `STAGE_FAILED:${stage.name}`);
  for (const result of [tooling.unit, tooling.combined]) result.errors.push(...unitErrors, ...toolingStageErrors);
  const metadata = { scopeLabel: "runtime-sdk; not whole Sonar sources (scripts/deployment tooling excluded)", run: slash(path.relative(root, runDirectory)), stages, nativeStages: phaseStages, createdAt: new Date().toISOString() };
  const unitSummary = await writeReports(root, unit, { ...metadata, phase: "unit", collectionComplete: unit.errors.length === 0 }, "unit");
  const combinedSummary = await writeReports(root, combined, { ...metadata, phase: "combined", browserRecords: browser.length, unitSummary: unitSummary.total, collectionComplete: combined.errors.length === 0 });
  const toolingMetadata = { ...metadata, scopeLabel: "scripts tooling; independent of runtime-sdk 90% gates", raw: tooling.raw };
  await writeReports(root, tooling.unit, { ...toolingMetadata, phase: "tooling/unit", collectionComplete: tooling.unit.errors.length === 0 }, "tooling/unit");
  const toolingSummary = await writeReports(root, tooling.combined, { ...toolingMetadata, phase: "tooling", collectionComplete: tooling.combined.errors.length === 0 }, "tooling");
  const collectionErrors = [...combined.errors, ...tooling.unit.errors, ...tooling.combined.errors];
  console.log(JSON.stringify({ scope: metadata.scopeLabel, files: combined.map.files().length, unit: unitSummary.total, combined: combinedSummary.total, tooling: toolingSummary.total, errors: collectionErrors }, null, 2));
  return collectionErrors.length ? 1 : 0;
}
export async function coverageMain(args = process.argv.slice(2), root = ROOT) {
  if (!args.length) return collectCoverage(root);
  if (args.length === 1 && args[0] === "--verify-reports") {
    const failed = [];
    for (const phase of ["unit", "combined", "tooling/unit", "tooling"]) failed.push(...await verifyReports(root, phase));
    console.log(JSON.stringify({ reportIntegrity: failed.length === 0, failed }, null, 2));
    return failed.length ? 1 : 0;
  }
  if (args.length !== 2 || args[0] !== "--check" || !/^\d+(?:\.\d+)?$/.test(args[1])) throw new Error("Usage: coverage.mjs [--check 90 | --verify-reports]");
  const threshold = Number(args[1]), failed = [], summaries = {};
  for (const phase of ["unit", "combined"]) {
    const directory = path.join(root, "coverage", phase === "unit" ? "unit" : "");
    const summary = JSON.parse(await readFile(path.join(directory, "coverage-summary.json"), "utf8"));
    summaries[phase] = summary.total; failed.push(...checkThreshold(summary, threshold).map(metric => `${phase}:${metric}`));
    failed.push(...await verifyReports(root, phase));
  }
  console.log(JSON.stringify({ threshold, scope: "runtime-sdk (not whole Sonar)", ...summaries, failed }, null, 2));
  return failed.length ? 1 : 0;
}
if (isMain(import.meta.url)) coverageMain().then(code => { process.exitCode = code; }).catch(error => { console.error(`Coverage failed: ${error.message}`); process.exitCode = 1; });
