/**
 * scripts/audit-code-smells.mjs 的纯合成单测。
 *
 * 原则：
 * - 全部用**合成源码字符串**断言，不读项目业务文件，不对当前业务打分。
 * - 断言的是手算过的数字，不是"跑出来是几就是几"，这样公式才可复现。
 * - 不启动浏览器、不联网、不调用任何校园服务或模型。
 */

import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  AuditError,
  DEFAULT_SCOPE,
  HARD_LIMITS,
  METRIC_DEFINITIONS,
  SCORE_FORMULA,
  SCORE_THRESHOLD,
  THRESHOLDS,
  auditSource,
  collectFunctions,
  functionKindName,
  hardLimitReasons,
  loadTypeScript,
  main,
  measureFunction,
  parseModule,
  round2,
  scoreFunctions,
  violationReasons,
} from '../scripts/audit-code-smells.mjs';

const ts = loadTypeScript();
const scriptPath = fileURLToPath(
  new URL('../scripts/audit-code-smells.mjs', import.meta.url),
);

/** 把一段合成源码量成函数指标数组。 */
function measure(source, fileName = 'fixture.mjs') {
  const sourceFile = parseModule(ts, fileName, source);
  return collectFunctions(ts, sourceFile, fileName);
}

/** 建一个临时目录，写完文件后返回目录与清理函数。 */
async function fixtureDir(files) {
  const dir = await mkdtemp(path.join(tmpdir(), 'thu-smell-'));
  for (const [name, text] of Object.entries(files)) {
    await writeFile(path.join(dir, name), text, 'utf8');
  }
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

/** 固定时间戳，保证报告可逐字节比较。 */
const fixedNow = () => '2026-01-01T00:00:00.000Z';

// ---------------------------------------------------------------- 指标：简单

test('简单函数：复杂度 1、嵌套 0、形参按条目计', () => {
  const { functions } = measure('export function simple(a) { return a + 1; }\n');
  assert.equal(functions.length, 1);
  const [simple] = functions;
  assert.equal(simple.kind, 'FunctionDeclaration');
  assert.equal(simple.complexity, 1);
  assert.equal(simple.nesting, 0);
  assert.equal(simple.lines, 1);
  assert.equal(simple.params, 1);
  assert.equal(simple.line, 1);
});

test('箭头函数与对象方法都被识别为函数并独立计量', () => {
  const { functions } = measure(
    ['export const arrow = (a) => a * 2;', 'export const obj = { run(x) { return x; } };', ''].join('\n'),
  );
  const kinds = functions.map((item) => item.kind).sort();
  assert.deepEqual(kinds, ['ArrowFunction', 'MethodDeclaration']);
  const names = functions.map((item) => item.name).sort();
  assert.deepEqual(names, ['arrow', 'run']);
});

test('functionKindName 只认函数类节点', () => {
  const sourceFile = parseModule(ts, 'fixture.mjs', 'function f() { return 1; }\nconst x = 1;\n');
  const found = [];
  const visit = (node) => {
    if (functionKindName(ts, node)) found.push(functionKindName(ts, node));
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  assert.deepEqual(found, ['FunctionDeclaration']);
});

// -------------------------------------------------------------- 指标：复杂度

test('复杂度按手算口径累加：if/&&/for/while/catch/?: 各 1', () => {
  const source = [
    'export function branchy(a, b) {',
    '  if (a && b) { return 1; }',
    '  for (let i = 0; i < 3; i += 1) { if (i) { while (b) { break; } } }',
    '  try { return a ? 1 : 2; } catch { return 3; }',
    '}',
    '',
  ].join('\n');
  const { functions } = measure(source);
  const [branchy] = functions;
  // 1 基础 + if1 + &&1 + for1 + if1 + while1 + catch1 + ?:1 = 8
  assert.equal(branchy.complexity, 8);
  assert.equal(branchy.params, 2);
});

test('switch 只对非 default 的 case 计复杂度和嵌套', () => {
  const source = [
    'export function pick(value) {',
    '  switch (value) {',
    '    case 1: return "a";',
    '    case 2: return "b";',
    '    default: return "c";',
    '  }',
    '}',
    '',
  ].join('\n');
  const { functions } = measure(source);
  const [pick] = functions;
  // 1 + two cases（default 不计）= 3；switch 算 1 层嵌套
  assert.equal(pick.complexity, 3);
  assert.equal(pick.nesting, 1);
});

// ---------------------------------------------------------------- 指标：嵌套

test('控制嵌套层数与 try/catch 不额外加层', () => {
  const source = [
    'export function deep(a) {',
    '  try {',
    '    if (a) {',
    '      for (;;) {',
    '        while (a) { break; }',
    '      }',
    '    }',
    '  } catch (error) {',
    '    if (error) { return 1; }',
    '  }',
    '}',
    '',
  ].join('\n');
  const { functions } = measure(source);
  const [deep] = functions;
  // try(1) → if(2) → for(3) → while(4)；catch 里的 if 仍在 try 的下一层：2
  assert.equal(deep.nesting, 4);
});

test('else-if 链按 ESLint max-depth 口径逐层累加', () => {
  const source = [
    'export function chain(a) {',
    '  if (a === 1) { return 1; }',
    '  else if (a === 2) { return 2; }',
    '  else if (a === 3) { return 3; }',
    '  return 0;',
    '}',
    '',
  ].join('\n');
  const { functions } = measure(source);
  assert.equal(functions[0].nesting, 3);
  assert.equal(functions[0].complexity, 4);
});

// ------------------------------------------------- 指标：嵌套函数独立计量

test('嵌套函数独立计数：外层复杂度不含内层，内层单独出现', () => {
  const source = [
    'export function outer(x) {',
    '  const inner = (y) => {',
    '    if (y) { if (y > 1) { return 2; } }',
    '    return 1;',
    '  };',
    '  return inner(x);',
    '}',
    '',
  ].join('\n');
  const { functions } = measure(source);
  assert.equal(functions.length, 2);
  const outer = functions.find((item) => item.name === 'outer');
  const inner = functions.find((item) => item.name === 'inner');
  assert.equal(outer.complexity, 1, '外层的复杂度不应含内层的两个 if');
  assert.equal(outer.nesting, 0, '外层的嵌套不应含内层的 if');
  assert.equal(inner.complexity, 3);
  assert.equal(inner.nesting, 2);
});

test('外层有效行不含内层函数体', () => {
  const innerBody = Array.from({ length: 60 }, (_, index) => `    total += ${index};`).join('\n');
  const source = [
    'export function outer() {',
    '  const inner = () => {',
    '    let total = 0;',
    innerBody,
    '    return total;',
    '  };',
    '  return inner();',
    '}',
    '',
  ].join('\n');
  const { functions } = measure(source);
  const outer = functions.find((item) => item.name === 'outer');
  assert.ok(outer.lines < 10, `外层有效行应远小于 60，实际 ${outer.lines}`);
  assert.ok(functions.find((item) => item.name === 'inner').lines > 60);
});

// ---------------------------------------------------------------- 指标：行数

test('注释与空行不计入有效代码行，纯括号行也不计', () => {
  const source = [
    'export function spaced() {',
    '  // 这是注释',
    '  const a = 1;',
    '',
    '  /* 多行注释',
    '     仍然不计 */',
    '  {',
    '  }',
    '  return a;',
    '}',
    '',
  ].join('\n');
  const { functions } = measure(source);
  // 计入：函数签名行、const 行、return 行 = 3；注释行、空行、纯 { } 行不计
  assert.equal(functions[0].lines, 3);
});

test('长函数有效行可越过阈值：120 行', () => {
  const body = Array.from({ length: 120 }, (_, index) => `  const v${index} = ${index};`).join('\n');
  const source = `export function long() {\n${body}\n  return 0;\n}\n`;
  const { functions } = measure(source);
  const [long] = functions;
  assert.equal(long.lines, 122); // 签名 1 + 120 + return 1
  assert.deepEqual(violationReasons(long), ['lines=122>100']);
});

// ------------------------------------------------------------ 形参阈值边界

test('形参阈值边界：等于阈值不算违规，超出才算；硬上限同理', () => {
  const make = (count) =>
    `export function f(${Array.from({ length: count }, (_, index) => `p${index}`).join(', ')}) { return 1; }\n`;
  assert.deepEqual(violationReasons(measure(make(5)).functions[0]), []);
  assert.deepEqual(violationReasons(measure(make(6)).functions[0]), ['params=6>5']);
  assert.deepEqual(hardLimitReasons(measure(make(8)).functions[0]), []);
  assert.deepEqual(hardLimitReasons(measure(make(9)).functions[0]), ['params=9>8']);
});

// -------------------------------------------------------------- 分数与门槛

test('阈值常量与任务约定一致，且未为了凑分被放宽', () => {
  assert.deepEqual({ ...THRESHOLDS }, { complexity: 20, nesting: 5, lines: 100, params: 5 });
  assert.deepEqual({ ...HARD_LIMITS }, { complexity: 50, nesting: 8, lines: 200, params: 8 });
  assert.equal(SCORE_THRESHOLD, 90);
  assert.match(SCORE_FORMULA, /100 \* cleanFunctions \/ totalFunctions/);
  assert.equal(METRIC_DEFINITIONS.params.includes('形参列表条目数'), true);
});

test('分数公式：10 个函数 1 个违规 = 90.00，刚好达标', () => {
  const clean = Array.from({ length: 9 }, () => ({ complexity: 1, nesting: 0, lines: 1, params: 1 }));
  const dirty = { complexity: 21, nesting: 0, lines: 1, params: 1 };
  const scored = scoreFunctions([...clean, dirty]);
  assert.equal(scored.score, 90);
  assert.equal(scored.passScore, true);
  assert.equal(scored.pass, true);
  assert.equal(scored.counts.functions, 10);
  assert.equal(scored.counts.clean, 9);
  assert.equal(scored.counts.violating, 1);
  assert.deepEqual(scored.violations[0].reasons, ['complexity=21>20']);
});

test('分数公式不是永远通过：10 个函数 2 个违规 = 80.00 未达标', () => {
  const clean = Array.from({ length: 8 }, () => ({ complexity: 1, nesting: 0, lines: 1, params: 1 }));
  const dirty = { complexity: 21, nesting: 0, lines: 1, params: 1 };
  const scored = scoreFunctions([...clean, dirty, dirty]);
  assert.equal(scored.score, 80);
  assert.equal(scored.passScore, false);
  assert.equal(scored.pass, false);
});

test('分数保留 2 位小数：3 个函数 1 个违规 = 66.67', () => {
  const clean = { complexity: 1, nesting: 0, lines: 1, params: 1 };
  const scored = scoreFunctions([clean, clean, { complexity: 30, nesting: 0, lines: 1, params: 1 }]);
  assert.equal(scored.score, round2(200 / 3));
  assert.equal(scored.score, 66.67);
});

test('全部违规时为 0 分，空集合不给分（避免凭空 100 分）', () => {
  const dirty = { complexity: 99, nesting: 9, lines: 999, params: 9 };
  assert.equal(scoreFunctions([dirty, dirty]).score, 0);
  const empty = scoreFunctions([]);
  assert.equal(empty.score, null);
  assert.equal(empty.passScore, false);
  assert.equal(empty.pass, false);
});

test('硬上限不可被高总分抵消：11 个函数 1 个复杂度 51 仍失败', () => {
  const clean = Array.from({ length: 10 }, () => ({ complexity: 1, nesting: 0, lines: 1, params: 1 }));
  const overHard = { complexity: 51, nesting: 0, lines: 1, params: 1 };
  const scored = scoreFunctions([...clean, overHard]);
  assert.equal(scored.score, round2((100 * 10) / 11));
  assert.equal(scored.score, 90.91);
  assert.equal(scored.passScore, true, '总分确实过了 90');
  assert.equal(scored.pass, false, '但硬上限违规必须让门槛失败');
  assert.equal(scored.hardFails.length, 1);
  assert.deepEqual(scored.hardFails[0].reasons, ['complexity=51>50']);
});

test('四类硬上限都能单独触发失败', () => {
  const cases = [
    { complexity: 51, nesting: 0, lines: 1, params: 1 },
    { complexity: 1, nesting: 9, lines: 1, params: 1 },
    { complexity: 1, nesting: 0, lines: 201, params: 1 },
    { complexity: 1, nesting: 0, lines: 1, params: 9 },
  ];
  for (const metrics of cases) {
    const scored = scoreFunctions([metrics]);
    assert.equal(scored.pass, false);
    assert.equal(scored.hardFails.length, 1);
  }
});

// ------------------------------------------------------------ 解析错误处理

test('语法错误硬失败并带行号，不静默跳过', () => {
  assert.throws(
    () => parseModule(ts, 'broken.mjs', 'export function f( {\n  return 1;\n}\n'),
    (error) => {
      assert.ok(error instanceof AuditError);
      assert.equal(error.code, 'SYNTAX_ERROR');
      assert.match(error.message, /broken\.mjs:\d+:\d+/);
      return true;
    },
  );
});

test('TypeScript 文件按 TS 语法解析（接口 + 泛型）', () => {
  const source = [
    'export interface Row { id: string }',
    'export function pick<T extends Row>(rows: T[], id: string): T | undefined {',
    '  return rows.find((row) => row.id === id);',
    '}',
    '',
  ].join('\n');
  const { functions } = measure(source, 'fixture.ts');
  assert.equal(functions.length, 2); // pick + 箭头回调
  const pick = functions.find((item) => item.name === 'pick');
  assert.equal(pick.kind, 'FunctionDeclaration');
  assert.equal(pick.nesting, 0);
});

test('无函数体的声明不参与计量，并计入范围缺口', async () => {
  const { dir, cleanup } = await fixtureDir({
    'overloads.ts': [
      'export function f(a: string): string;',
      'export function f(a: number): number;',
      'export function f(a: any): any { return a; }',
      '',
    ].join('\n'),
  });
  try {
    const report = auditSource({ root: dir, files: ['overloads.ts'], ts, now: fixedNow });
    assert.equal(report.counts.functions, 1);
    assert.equal(report.scopeGaps.excludedNoBodyFunctions, 2);
  } finally {
    await cleanup();
  }
});

// ------------------------------------------------------------- auditSource

test('缺 scope 文件明确报错，不静默跳过', async () => {
  const { dir, cleanup } = await fixtureDir({ 'ok.mjs': 'export function f() { return 1; }\n' });
  try {
    assert.throws(
      () => auditSource({ root: dir, files: ['ok.mjs', 'missing.mjs'], ts, now: fixedNow }),
      (error) => {
        assert.equal(error.code, 'SCOPE_MISSING');
        assert.match(error.message, /missing\.mjs/);
        return true;
      },
    );
  } finally {
    await cleanup();
  }
});

test('空 scope 与零函数 scope 都拒绝给分', async () => {
  assert.throws(
    () => auditSource({ files: [], ts, now: fixedNow }),
    (error) => error.code === 'SCOPE_EMPTY',
  );
  const { dir, cleanup } = await fixtureDir({ 'empty.mjs': 'export const x = 1;\n' });
  try {
    assert.throws(
      () => auditSource({ root: dir, files: ['empty.mjs'], ts, now: fixedNow }),
      (error) => error.code === 'NO_FUNCTIONS',
    );
  } finally {
    await cleanup();
  }
});

test('报告包含公式、阈值、scope、原始指标与免责声明', async () => {
  const { dir, cleanup } = await fixtureDir({
    'good.mjs': 'export function a(x) { return x; }\nexport function b(y) { return y; }\n',
  });
  try {
    const report = auditSource({ root: dir, files: ['good.mjs'], ts, now: fixedNow });
    assert.equal(report.tool, 'audit-code-smells');
    assert.equal(report.generatedAt, '2026-01-01T00:00:00.000Z');
    assert.equal(report.score, 100);
    assert.equal(report.pass, true);
    assert.equal(report.formula, SCORE_FORMULA);
    assert.deepEqual(report.thresholds, { ...THRESHOLDS });
    assert.deepEqual(report.hardLimits, { ...HARD_LIMITS });
    assert.equal(report.scoreThreshold, 90);
    assert.deepEqual(report.scope.map((item) => item.path), ['good.mjs']);
    assert.equal(report.functions.length, 2);
    assert.ok(report.disclaimer.some((line) => line.includes('NOT Sonar')));
    assert.ok(report.disclaimer.some((line) => line.includes('NOT 覆盖率')));
  } finally {
    await cleanup();
  }
});

test('同一输入两次打分完全一致（可复现）', async () => {
  const { dir, cleanup } = await fixtureDir({
    'mix.mjs': [
      'export function a(x) { return x; }',
      'export function b(x) { if (x) { for (;;) { if (x) { while (x) { break; } } } } return x; }',
      '',
    ].join('\n'),
  });
  try {
    const options = { root: dir, files: ['mix.mjs'], ts, now: fixedNow };
    const first = JSON.stringify(auditSource(options));
    const second = JSON.stringify(auditSource(options));
    assert.equal(first, second);
  } finally {
    await cleanup();
  }
});

test('语法错误会让整次打分失败，而不是漏掉该文件', async () => {
  const { dir, cleanup } = await fixtureDir({
    'good.mjs': 'export function a(x) { return x; }\n',
    'bad.mjs': 'export function b( {\n',
  });
  try {
    assert.throws(
      () => auditSource({ root: dir, files: ['good.mjs', 'bad.mjs'], ts, now: fixedNow }),
      (error) => error.code === 'SYNTAX_ERROR',
    );
  } finally {
    await cleanup();
  }
});

test('loadTypeScript 缺依赖时给出可执行的中文错误', () => {
  assert.throws(
    () => loadTypeScript(() => {
      throw new Error('Cannot find module typescript');
    }),
    (error) => {
      assert.equal(error.code, 'TYPESCRIPT_MISSING');
      assert.match(error.message, /npm ci/);
      return true;
    },
  );
});

// ------------------------------------------------------------------- CLI

test('CLI：全绿 scope 退出 0 并输出可直接解析的报告', async () => {
  const { dir, cleanup } = await fixtureDir({
    'good.mjs': 'export function a(x) { return x; }\n',
  });
  try {
    const result = spawnSync(
      process.execPath,
      [scriptPath, '--root', dir, '--scope', 'good.mjs', '--json'],
      { encoding: 'utf8' },
    );
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.score, 100);
    assert.equal(report.pass, true);
    assert.deepEqual(report.scope.map((item) => item.path), ['good.mjs']);
  } finally {
    await cleanup();
  }
});

test('CLI：越硬上限时退出 1（总分高也不放过）', async () => {
  // 11 个函数，其中一个复杂度 51：score 90.91 但硬上限失败
  const many = Array.from({ length: 10 }, (_, index) => `export function ok${index}(a) { return a; }`);
  const hot = `export function hot(a) {\n${Array.from({ length: 51 }, (_, index) => `  if (a === ${index}) { a += 1; }`).join('\n')}\n  return a;\n}\n`;
  const { dir, cleanup } = await fixtureDir({ 'mix.mjs': `${many.join('\n')}\n${hot}` });
  try {
    const result = spawnSync(
      process.execPath,
      [scriptPath, '--root', dir, '--scope', 'mix.mjs', '--json'],
      { encoding: 'utf8' },
    );
    assert.equal(result.status, 1, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.passScore, true);
    assert.equal(report.pass, false);
    assert.equal(report.hardFails.length, 1);
  } finally {
    await cleanup();
  }
});

test('CLI：scope 缺失退出 2 并说明原因', async () => {
  const { dir, cleanup } = await fixtureDir({});
  try {
    const result = spawnSync(
      process.execPath,
      [scriptPath, '--root', dir, '--scope', 'nope.mjs'],
      { encoding: 'utf8' },
    );
    assert.equal(result.status, 2);
    assert.match(result.stderr, /SCOPE_MISSING/);
    assert.match(result.stderr, /nope\.mjs/);
  } finally {
    await cleanup();
  }
});

test('CLI：语法错误退出 2，未知参数退出 2，--help 退出 0', async () => {
  const { dir, cleanup } = await fixtureDir({ 'bad.mjs': 'export function f( {\n' });
  try {
    const broken = spawnSync(
      process.execPath,
      [scriptPath, '--root', dir, '--scope', 'bad.mjs'],
      { encoding: 'utf8' },
    );
    assert.equal(broken.status, 2);
    assert.match(broken.stderr, /SYNTAX_ERROR/);

    const unknown = spawnSync(process.execPath, [scriptPath, '--nope'], { encoding: 'utf8' });
    assert.equal(unknown.status, 2);
    assert.match(unknown.stderr, /未知参数/);

    const help = spawnSync(process.execPath, [scriptPath, '--help'], { encoding: 'utf8' });
    assert.equal(help.status, 0);
    assert.match(help.stdout, /audit-code-smells/);
  } finally {
    await cleanup();
  }
});

test('CLI 默认 scope 是冻结清单，且每条都是相对仓库根的核心模块', () => {
  assert.ok(DEFAULT_SCOPE.includes('lib/app/workspace.mjs'));
  assert.ok(DEFAULT_SCOPE.includes('lib/app/sandbox.mjs'));
  assert.ok(DEFAULT_SCOPE.includes('packages/thu-cloud/src/status.ts'));
  assert.ok(!DEFAULT_SCOPE.some((item) => item.startsWith('test/')), '测试不计入 scope');
  assert.ok(!DEFAULT_SCOPE.some((item) => item.includes('dist/')), '产物不计入 scope');
  assert.ok(!DEFAULT_SCOPE.some((item) => item.includes('node_modules')), '第三方不计入 scope');
});

test('main() 可直接调用并返回退出码（CLI 守卫不依赖进程参数）', async () => {
  const { dir, cleanup } = await fixtureDir({
    'good.mjs': 'export function a(x) { return x; }\n',
  });
  try {
    const chunks = [];
    const code = main(['--root', dir, '--scope', 'good.mjs'], {
      stdout: (text) => chunks.push(text),
      stderr: (text) => chunks.push(text),
    });
    assert.equal(code, 0);
    assert.match(chunks.join('\n'), /静态可维护性门槛/);
  } finally {
    await cleanup();
  }
});

test('文本报告含全部必需字段：阈值、公式、违规路径行号、原始指标', async () => {
  const source = [
    'export function fine(x) { return x; }',
    `export function big(x) {\n${Array.from({ length: 120 }, (_, index) => `  const v${index} = ${index};`).join('\n')}\n  return x;\n}`,
    '',
  ].join('\n');
  const { dir, cleanup } = await fixtureDir({ 'mix.mjs': source });
  try {
    const chunks = [];
    main(['--root', dir, '--scope', 'mix.mjs'], {
      stdout: (text) => chunks.push(text),
      stderr: (text) => chunks.push(text),
    });
    const text = chunks.join('\n');
    assert.match(text, /NOT SonarQube/);
    assert.match(text, /门槛：score >= 90 且无硬上限违规/);
    assert.match(text, /mix\.mjs:\d+ big（FunctionDeclaration）lines=122>100/);
    assert.match(text, /【原始指标】/);
  } finally {
    await cleanup();
  }
});

test('函数命名回退：属性赋值、成员赋值与计算属性名都能给出稳定名字', () => {
  const source = [
    'export const holder = { run: (x) => x };',
    'export let assigned;',
    'assigned = function () { return 1; };',
    'export class Computed { [key]() { return 1; } }',
    '',
  ].join('\n');
  const { functions } = measure(source);
  const names = functions.map((item) => item.name).sort();
  assert.deepEqual(names, ['<computed>', 'assigned', 'run']);
});

test('文本报告在硬上限违规时单列明细，不把失败藏进总分', async () => {
  const hot = `export function hot(a) {\n${Array.from(
    { length: 51 },
    (_, index) => `  if (a === ${index}) { a += 1; }`,
  ).join('\n')}\n  return a;\n}\n`;
  const { dir, cleanup } = await fixtureDir({ 'hot.mjs': hot });
  try {
    const chunks = [];
    const code = main(['--root', dir, '--scope', 'hot.mjs'], {
      stdout: (text) => chunks.push(text),
      stderr: (text) => chunks.push(text),
    });
    assert.equal(code, 1);
    const text = chunks.join('\n');
    assert.match(text, /【硬上限违规明细（任一即失败）】/);
    assert.match(text, /hot\.mjs:1 hot（FunctionDeclaration）complexity=52>50/);
  } finally {
    await cleanup();
  }
});