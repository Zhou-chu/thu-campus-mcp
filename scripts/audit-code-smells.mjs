#!/usr/bin/env node
/**
 * audit-code-smells：本批新核心模块的**项目自定义**静态可维护性门槛。
 *
 * 这个脚本只做一件事：用仓库里已经装好的 TypeScript 编译器 API（不新增依赖）
 * 把固定 scope 里的每个函数量一遍，按**事先写死**的阈值算一个可复现的分数，
 * 并给出机器可读的原始指标，供人复核公式与扣分来源。
 *
 * 明确边界（不要误读）：
 * - 这不是 SonarQube / SonarCloud 的 smell 评分，也不是任何商业工具的口径复刻。
 * - 这不是"全仓通用工具"，只在 DEFAULT_SCOPE 列出的模块上计分。
 * - 这不是覆盖率、不是测试通过率、不是人工代码审查，也不替代人工审查。
 * - 分数不能用于对外宣称"质量达标"，它只能说明：在本文件写死的口径下，
 *   scope 内有多少函数没有越过阈值。
 *
 * 阈值与公式一旦写进 THRESHOLDS / HARD_LIMITS / SCORE_FORMULA 就不要再改；
 * 为了让分数变高而放宽阈值属于伪造，本工具的设计目的正是防止这件事。
 *
 * 用法：
 *   node scripts/audit-code-smells.mjs            # 人类可读文本报告
 *   node scripts/audit-code-smells.mjs --json     # 纯 JSON（CI/留档用）
 *
 * 退出码：
 *   0  门槛通过（score >= 90 且无硬上限违规）
 *   1  门槛未通过（分数不足或有硬上限违规）
 *   2  工具本身无法得出结论（scope 缺失、语法解析失败、scope 内没有函数）
 *
 * 允许的复现开关（仅供测试与复现实验，不影响默认行为）：
 *   --root <dir>     以另一个目录作为仓库根（默认本仓库）
 *   --scope <path>   替换默认 scope，可重复；建议相对 --root
 */

import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** 仓库根：scripts/ 的上一级。 */
export const REPO_ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));

/**
 * 冻结 scope：本批新增/改写的核心模块。
 * 目录、测试、产物、第三方代码一律不计入——这里是显式的范围缺口，不是遗漏。
 */
export const DEFAULT_SCOPE = Object.freeze([
  'lib/app/cloud-workspace.mjs',
  'lib/app/workspace.mjs',
  'lib/app/workspace-http.mjs',
  'lib/app/sandbox.mjs',
  'lib/app/states.mjs',
  'lib/app/keepalive.mjs',
  'lib/madmodel/status.mjs',
  'packages/thu-cloud/src/status.ts',
  'packages/thu-cloud/src/workspace.ts',
  'packages/learnx/src/status.ts',
  'packages/hetang/src/status.ts',
]);

/** 软阈值：任一超出即该函数计为"有阈值违规"。 */
export const THRESHOLDS = Object.freeze({
  complexity: 20,
  nesting: 5,
  lines: 100,
  params: 5,
});

/** 硬上限：任一超出即使总分达标也使门槛失败。 */
export const HARD_LIMITS = Object.freeze({
  complexity: 50,
  nesting: 8,
  lines: 200,
  params: 8,
});

/** 门槛分数。 */
export const SCORE_THRESHOLD = 90;

/** 分数公式（写进报告，便于人工复算）。 */
export const SCORE_FORMULA =
  'score = round2(100 * cleanFunctions / totalFunctions)，' +
  '其中“违规函数”= 环复杂度>20 或 控制嵌套>5 或 有效代码行>100 或 形参数>5 中任意一条成立；' +
  '门槛 score >= 90 且无硬上限违规';

/** 指标定义（写进报告，避免读者自行脑补）。 */
export const METRIC_DEFINITIONS = Object.freeze({
  complexity:
    '环复杂度：基础 1；函数体内每出现 if / for / for-in / for-of / while / do / 非 default 的 case / catch / ?: / && / || / ?? 各 +1（与 ESLint complexity 同口径）；嵌套函数体不计入外层。',
  nesting:
    '控制嵌套：函数体内 if / for / for-in / for-of / while / do / switch / try 的最大语法嵌套层数（与 ESLint max-depth 同口径，catch 子句不额外加层）；嵌套函数体不计入外层。',
  lines:
    '有效代码行：函数自身（含签名，不含嵌套函数内部）中，至少含一个非注释、非 “{ } ( ) , ;” token 的不同源码行数。',
  params: '形参数：形参列表条目数（解构形参按 1 个计）。',
});

/**
 * 纯结构 token：只承载括号/分隔符形式的行，不计入"有效代码行"。
 * 这里存的是 **SyntaxKind 名字**，比较时走 kindIs() 的数值比较。
 */
const STRUCTURAL_TOKEN_NAMES = [
  'OpenBraceToken',
  'CloseBraceToken',
  'OpenParenToken',
  'CloseParenToken',
  'CommaToken',
  'SemicolonToken',
  'EndOfFileToken',
];

/** 计入环复杂度的节点种类。 */
const COMPLEXITY_KINDS = [
  'IfStatement',
  'ConditionalExpression',
  'ForStatement',
  'ForInStatement',
  'ForOfStatement',
  'WhileStatement',
  'DoStatement',
  'CatchClause',
];

/** 计入环复杂度的二元逻辑运算符 token 种类。 */
const COMPLEXITY_OPERATORS = [
  'AmpersandAmpersandToken',
  'BarBarToken',
  'QuestionQuestionToken',
];

/** 计入控制嵌套的节点种类（与 ESLint max-depth 一致）。 */
const DEPTH_KINDS = [
  'IfStatement',
  'ForStatement',
  'ForInStatement',
  'ForOfStatement',
  'WhileStatement',
  'DoStatement',
  'SwitchStatement',
  'TryStatement',
];

/** 会被单独计量、因此不计入外层函数的节点种类。 */
const FUNCTION_KINDS = [
  'FunctionDeclaration',
  'FunctionExpression',
  'ArrowFunction',
  'MethodDeclaration',
  'Constructor',
  'GetAccessor',
  'SetAccessor',
];

/**
 * 按 SyntaxKind 的**数值**判断节点种类。
 *
 * 不要改成 `ts.SyntaxKind[node.kind]` 反查名字：TS 枚举里
 * FirstPunctuation / FirstAssignment / FirstStatement 这类别名与真实种类同值
 * 且声明在后，反查会拿到别名（"{" 会变成 "FirstPunctuation"），
 * 用别名去比对白名单必然漏判，指标就会算错。
 *
 * @param {any} ts
 * @param {any} node
 * @param {string} name SyntaxKind 规范名
 * @returns {boolean}
 */
function kindIs(ts, node, name) {
  const kind = ts.SyntaxKind[name];
  return kind !== undefined && node?.kind === kind;
}

/** 节点是否是白名单中的任一种类。 */
function kindIn(ts, node, names) {
  return names.some((name) => kindIs(ts, node, name));
}

/** 工具自身失败（区别于"门槛未通过"）。 */
export class AuditError extends Error {
  /**
   * @param {string} code 稳定的机器可读错误码
   * @param {string} message 中文说明
   */
  constructor(code, message) {
    super(message);
    this.name = 'AuditError';
    this.code = code;
  }
}

/**
 * 加载仓库里已有的 TypeScript（不新增依赖）。
 * 默认从 packages/thu-cloud 的解析作用域取，因为它在本�� workspace 里声明了 typescript。
 * @param {(id: string) => any} [requireImpl] 便于测试替换
 * @returns {any}
 */
export function loadTypeScript(
  requireImpl = createRequire(new URL('../packages/thu-cloud/package.json', import.meta.url)),
) {
  try {
    return requireImpl('typescript');
  } catch (error) {
    throw new AuditError(
      'TYPESCRIPT_MISSING',
      `无法加载仓库内已声明的 typescript，请先 npm ci：${error?.message || error}`,
    );
  }
}

/**
 * 该节点是不是需要独立计量的函数（含函数声明/表达式/箭头/方法/构造/访问器）。
 * @param {any} ts
 * @param {any} node
 * @returns {string | null} 命中的 SyntaxKind 名，否则 null
 */
export function functionKindName(ts, node) {
  if (!node) return null;
  for (const name of FUNCTION_KINDS) if (kindIs(ts, node, name)) return name;
  return null;
}

/**
 * 取函数名用于报告：优先标识符，其次变量/属性声明所在名字，最后 <anonymous>。
 * @param {any} ts
 * @param {any} node
 * @param {any} sourceFile
 * @returns {string}
 */
export function functionNameOf(ts, node, sourceFile) {
  if (node?.name && ts.isIdentifier(node.name)) return node.name.text;
  if (node?.name) return '<computed>';
  const parent = node?.parent;
  if (!parent) return '<anonymous>';
  if (
    (ts.isVariableDeclaration(parent) || ts.isPropertyDeclaration(parent)) &&
    parent.name &&
    ts.isIdentifier(parent.name)
  ) {
    return parent.name.text;
  }
  if (
    ts.isPropertyAssignment(parent) &&
    parent.name &&
    ts.isIdentifier(parent.name)
  ) {
    return parent.name.text;
  }
  if (ts.isBinaryExpression(parent) && parent.left && ts.isIdentifier(parent.left)) {
    return parent.left.text;
  }
  return '<anonymous>';
}

/**
 * 只遍历函数自身的节点，遇到嵌套函数整段跳过（嵌套函数会作为独立条目计量）。
 * @param {any} ts
 * @param {any} node
 * @param {(node: any) => void} visit
 */
function forEachOwnNode(ts, node, visit) {
  const walk = (current) => {
    visit(current);
    ts.forEachChild(current, (child) => {
      if (functionKindName(ts, child)) return; // 嵌套函数整段跳过，由外层单独计量
      walk(child);
    });
  };
  walk(node);
}

/**
 * 统计一个函数自身的有效代码行（不含嵌套函数内部）。
 * @param {any} ts
 * @param {any} node
 * @param {any} sourceFile
 * @returns {number}
 */
export function effectiveLineCount(ts, node, sourceFile) {
  const lines = new Set();
  forEachOwnNode(ts, node, (current) => {
    for (const leaf of current.getChildren(sourceFile)) {
      if (leaf.getChildCount(sourceFile) !== 0) continue;
      // SyntaxList 是"无子节点的列表容器"，不是 token，不能当代码行内容。
      if (kindIs(ts, leaf, 'SyntaxList')) continue;
      if (kindIn(ts, leaf, STRUCTURAL_TOKEN_NAMES)) continue;
      const { line } = sourceFile.getLineAndCharacterOfPosition(
        leaf.getStart(sourceFile),
      );
      lines.add(line);
    }
  });
  return lines.size;
}

/**
 * 在函数自身范围内统计环复杂度增量与控制嵌套深度。
 * @param {any} ts
 * @param {any} node
 * @returns {{ complexity: number, nesting: number }}
 */
export function complexityAndNesting(ts, node) {
  let complexity = 0;
  let nesting = 0;
  const walk = (current, depth) => {
    if (kindIn(ts, current, COMPLEXITY_KINDS)) complexity += 1;
    if (kindIs(ts, current, 'CaseClause') && current.expression) complexity += 1;
    if (kindIs(ts, current, 'BinaryExpression')) {
      const operator = current.operatorToken?.kind;
      if (
        COMPLEXITY_OPERATORS.some((name) => operator === ts.SyntaxKind[name])
      ) {
        complexity += 1;
      }
    }
    let nextDepth = depth;
    if (kindIn(ts, current, DEPTH_KINDS)) {
      nextDepth = depth + 1;
      if (nextDepth > nesting) nesting = nextDepth;
    }
    ts.forEachChild(current, (child) => {
      if (functionKindName(ts, child)) return; // 嵌套函数体不计入外层
      walk(child, nextDepth);
    });
  };
  // 函数体本身不构成一层；嵌套深度从内部开始累计。
  const body = node.body;
  if (body) {
    if (ts.isBlock(body)) {
      ts.forEachChild(body, (child) => {
        if (functionKindName(ts, child)) return;
        walk(child, 0);
      });
    } else {
      walk(body, 0);
    }
  }
  return { complexity: complexity + 1, nesting };
}

/**
 * 量一个函数。
 * @param {any} ts
 * @param {any} node
 * @param {any} sourceFile
 * @param {string} fileName
 * @returns {object | null} 无函数体的声明（重载/抽象）返回 null
 */
export function measureFunction(ts, node, sourceFile, fileName) {
  if (!node.body) return null;
  const { complexity, nesting } = complexityAndNesting(ts, node);
  const start = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
  const end = sourceFile.getLineAndCharacterOfPosition(node.getEnd());
  return {
    file: fileName,
    name: functionNameOf(ts, node, sourceFile),
    kind: functionKindName(ts, node),
    line: start.line + 1,
    endLine: end.line + 1,
    complexity,
    nesting,
    lines: effectiveLineCount(ts, node, sourceFile),
    params: node.parameters?.length ?? 0,
  };
}

/**
 * 解析单个源码文件，语法错误硬失败。
 * @param {any} ts
 * @param {string} fileName
 * @param {string} text
 * @returns {any} SourceFile
 */
export function parseModule(ts, fileName, text) {
  const scriptKind = /\.[cm]?tsx?$/i.test(fileName)
    ? /\.tsx$/i.test(fileName)
      ? ts.ScriptKind.TSX
      : ts.ScriptKind.TS
    : ts.ScriptKind.JS;
  const sourceFile = ts.createSourceFile(
    fileName,
    text,
    ts.ScriptTarget.Latest,
    true,
    scriptKind,
  );
  const diagnostics = sourceFile.parseDiagnostics || [];
  if (diagnostics.length) {
    const first = diagnostics[0];
    const { line, character } = sourceFile.getLineAndCharacterOfPosition(
      first.start ?? 0,
    );
    const detail =
      typeof ts.flattenDiagnosticMessageText === 'function'
        ? ts.flattenDiagnosticMessageText(first.messageText, ' ')
        : String(first.messageText);
    throw new AuditError(
      'SYNTAX_ERROR',
      `语法解析失败 ${fileName}:${line + 1}:${character + 1}：${detail}`,
    );
  }
  return sourceFile;
}

/**
 * 收集一个文件里所有函数（含嵌套函数，各自独立计量）。
 * @param {any} ts
 * @param {any} sourceFile
 * @param {string} fileName
 * @returns {object[]}
 */
export function collectFunctions(ts, sourceFile, fileName) {
  const functions = [];
  let excludedNoBody = 0;
  const visit = (node) => {
    if (functionKindName(ts, node)) {
      const measured = measureFunction(ts, node, sourceFile, fileName);
      if (measured) functions.push(measured);
      else excludedNoBody += 1;
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return { functions, excludedNoBody };
}

/** 四舍五入到 2 位小数（固定公式的一部分，不要内联改口径）。 */
export function round2(value) {
  return Math.round(value * 100) / 100;
}

/**
 * 判定一个函数的违规项。
 * @param {object} metrics
 * @param {{complexity:number,nesting:number,lines:number,params:number}} thresholds
 * @returns {string[]} 违规原因，空数组表示无违规
 */
export function violationReasons(metrics, thresholds = THRESHOLDS) {
  const reasons = [];
  for (const key of ['complexity', 'nesting', 'lines', 'params']) {
    if (metrics[key] > thresholds[key]) {
      reasons.push(`${key}=${metrics[key]}>${thresholds[key]}`);
    }
  }
  return reasons;
}

/**
 * 判定一个函数是否越过硬上限。
 * @param {object} metrics
 * @param {{complexity:number,nesting:number,lines:number,params:number}} hardLimits
 * @returns {string[]}
 */
export function hardLimitReasons(metrics, hardLimits = HARD_LIMITS) {
  const reasons = [];
  for (const key of ['complexity', 'nesting', 'lines', 'params']) {
    if (metrics[key] > hardLimits[key]) {
      reasons.push(`${key}=${metrics[key]}>${hardLimits[key]}`);
    }
  }
  return reasons;
}

/**
 * 纯计分：输入函数指标数组，输出分数与违规清单。
 * @param {object[]} functions
 * @param {object} [options]
 * @returns {object}
 */
export function scoreFunctions(
  functions,
  { thresholds = THRESHOLDS, hardLimits = HARD_LIMITS, scoreThreshold = SCORE_THRESHOLD } = {},
) {
  const violations = [];
  const hardFails = [];
  let clean = 0;
  for (const metrics of functions) {
    const reasons = violationReasons(metrics, thresholds);
    if (reasons.length) violations.push({ ...metrics, reasons });
    else clean += 1;
    const hard = hardLimitReasons(metrics, hardLimits);
    if (hard.length) hardFails.push({ ...metrics, reasons: hard });
  }
  const total = functions.length;
  const score = total === 0 ? null : round2((100 * clean) / total);
  return {
    counts: {
      functions: total,
      clean,
      violating: violations.length,
      hardFailing: hardFails.length,
    },
    score,
    passScore: score !== null && score >= scoreThreshold,
    pass: score !== null && score >= scoreThreshold && hardFails.length === 0,
    violations,
    hardFails,
  };
}

/**
 * 读取并计量一批文件。缺文件/语法错误一律硬失败，绝不静默 skip。
 * @param {object} options
 * @param {string[]} [options.files] 相对 root 的路径列表
 * @param {string} [options.root]
 * @param {(relativePath: string) => string} [options.readText]
 * @param {any} [options.ts]
 * @param {() => string} [options.now]
 * @returns {object} 报告
 */
export function auditSource({
  files = DEFAULT_SCOPE,
  root = REPO_ROOT,
  readText = (relativePath) => readFileSync(path.join(root, relativePath), 'utf8'),
  ts = loadTypeScript(),
  now = () => new Date().toISOString(),
} = {}) {
  if (!files.length) {
    throw new AuditError('SCOPE_EMPTY', 'scope 为空，拒绝给出分数。');
  }
  const entries = [];
  const allFunctions = [];
  let excludedNoBody = 0;
  for (const relativePath of files) {
    let text;
    try {
      text = readText(relativePath);
    } catch (error) {
      throw new AuditError(
        'SCOPE_MISSING',
        `scope 文件缺失或不可读：${relativePath}（${error?.code || error?.message || error}）；scope 必须完整，不做静默跳过。`,
      );
    }
    const sourceFile = parseModule(ts, relativePath, text);
    const { functions, excludedNoBody: excluded } = collectFunctions(
      ts,
      sourceFile,
      relativePath,
    );
    for (const metrics of functions) allFunctions.push(metrics);
    excludedNoBody += excluded;
    entries.push({
      path: relativePath,
      bytes: Buffer.byteLength(text, 'utf8'),
      functions: functions.length,
    });
  }
  if (allFunctions.length === 0) {
    throw new AuditError(
      'NO_FUNCTIONS',
      'scope 内没有可计量的函数，拒绝给出分数（避免用空集合伪造 100 分）。',
    );
  }
  const scored = scoreFunctions(allFunctions);
  return {
    tool: 'audit-code-smells',
    version: 1,
    generatedAt: now(),
    disclaimer: [
      'NOT SonarQube/SonarCloud：本分数是本项目自定的函数可维护性指标，不是商业工具评分。',
      'NOT 全仓通用 smell 认证：只在下面的固定 scope 上计分，scope 外代码未评估。',
      'NOT 覆盖率、NOT 测试通过率、NOT 人工审查结论；它不证明代码正确，也不替代 review。',
      '阈值与公式事先写死，不随结果调整；要提高分数只能改代码。',
    ],
    formula: SCORE_FORMULA,
    metricDefinitions: METRIC_DEFINITIONS,
    thresholds: { ...THRESHOLDS },
    hardLimits: { ...HARD_LIMITS },
    scoreThreshold: SCORE_THRESHOLD,
    scope: entries,
    scopeGaps: {
      note: '目录、测试、构建产物、第三方依赖、scope 外历史模块均不计入。',
      excludedNoBodyFunctions: excludedNoBody,
      excludedNoBodyNote: '无函数体的声明（TS 重载/抽象方法）不参与计量。',
    },
    counts: scored.counts,
    score: scored.score,
    pass: scored.pass,
    passScore: scored.passScore,
    violations: scored.violations,
    hardFails: scored.hardFails,
    functions: allFunctions,
  };
}

/**
 * 文本报告（确定顺序，不含随机内容）。
 * @param {object} report
 * @returns {string}
 */
export function formatReport(report) {
  const lines = [];
  lines.push('清华校园 · 本批核心模块静态可维护性门槛（项目自定义口径）');
  lines.push(`生成时间：${report.generatedAt}`);
  lines.push('');
  lines.push('【边界声明】');
  for (const item of report.disclaimer) lines.push(`- ${item}`);
  lines.push('');
  lines.push('【固定口径】');
  lines.push(`- 公式：${report.formula}`);
  lines.push(
    `- 软阈值：复杂度>${report.thresholds.complexity}、控制嵌套>${report.thresholds.nesting}、有效行>${report.thresholds.lines}、形参>${report.thresholds.params}`,
  );
  lines.push(
    `- 硬上限：复杂度>${report.hardLimits.complexity}、控制嵌套>${report.hardLimits.nesting}、有效行>${report.hardLimits.lines}、形参>${report.hardLimits.params}`,
  );
  lines.push(`- 门槛：score >= ${report.scoreThreshold} 且无硬上限违规`);
  for (const [key, definition] of Object.entries(report.metricDefinitions)) {
    lines.push(`- ${key}：${definition}`);
  }
  lines.push('');
  lines.push('【scope】');
  for (const entry of report.scope) {
    lines.push(`- ${entry.path}：${entry.functions} 个函数，${entry.bytes} 字节`);
  }
  lines.push(`- （范围缺口）${report.scopeGaps.note}`);
  lines.push(`- （范围缺口）${report.scopeGaps.excludedNoBodyNote}`);
  lines.push('');
  lines.push('【结果】');
  lines.push(
    `- 函数总数 ${report.counts.functions}，无违规 ${report.counts.clean}，有阈值违规 ${report.counts.violating}，越硬上限 ${report.counts.hardFailing}`,
  );
  lines.push(
    `- score = ${report.score === null ? 'n/a' : report.score.toFixed(2)}（门槛 ${report.scoreThreshold}：${report.passScore ? '达成' : '未达成'}）`,
  );
  lines.push(`- 门槛结论：${report.pass ? '通过' : '未通过'}`);
  if (report.violations.length) {
    lines.push('');
    lines.push('【阈值违规明细】');
    for (const item of report.violations) {
      lines.push(
        `- ${item.file}:${item.line} ${item.name}（${item.kind}）${item.reasons.join('，')}`,
      );
    }
  }
  if (report.hardFails.length) {
    lines.push('');
    lines.push('【硬上限违规明细（任一即失败）】');
    for (const item of report.hardFails) {
      lines.push(
        `- ${item.file}:${item.line} ${item.name}（${item.kind}）${item.reasons.join('，')}`,
      );
    }
  }
  lines.push('');
  lines.push('【原始指标】');
  lines.push('文件:行 函数 种类 复杂度 嵌套 有效行 形参');
  for (const item of report.functions) {
    lines.push(
      `${item.file}:${item.line} ${item.name} ${item.kind} ${item.complexity} ${item.nesting} ${item.lines} ${item.params}`,
    );
  }
  return lines.join('\n');
}

/**
 * CLI 入口。
 * @param {string[]} argv
 * @param {object} [io]
 * @returns {number} 退出码
 */
export function main(argv = process.argv.slice(2), io = {}) {
  const out = io.stdout || ((text) => process.stdout.write(text + '\n'));
  const err = io.stderr || ((text) => process.stderr.write(text + '\n'));
  let root = REPO_ROOT;
  let json = false;
  const files = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--json') {
      json = true;
    } else if (arg === '--root') {
      root = path.resolve(argv[(index += 1)] ?? '');
    } else if (arg === '--scope') {
      files.push(argv[(index += 1)] ?? '');
    } else if (arg === '--help' || arg === '-h') {
      out(
        'node scripts/audit-code-smells.mjs [--json] [--root <dir>] [--scope <path>]...',
      );
      return 0;
    } else {
      err(`未知参数：${arg}（可用 --json、--root、--scope、--help）`);
      return 2;
    }
  }
  let report;
  try {
    report = auditSource({
      root,
      ...(files.length ? { files } : {}),
      readText: (relativePath) => readFileSync(path.resolve(root, relativePath), 'utf8'),
    });
  } catch (error) {
    if (error instanceof AuditError) {
      err(`[${error.code}] ${error.message}`);
      return 2;
    }
    throw error;
  }
  out(json ? JSON.stringify(report, null, 2) : formatReport(report));
  return report.pass ? 0 : 1;
}

const invokedDirectly =
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (invokedDirectly) {
  process.exitCode = main();
}