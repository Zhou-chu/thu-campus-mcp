/**
 * audit-source 的检测规则与其路径判定。
 * 拆成纯模块只为了可测试与消除有歧义的顶层 alternation；检测范围与原实现保持一致。
 */

export const AUDIT_RULES = Object.freeze([
  ["private-key", /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/],
  ["github-token", /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})\b/],
  ["model-key", /\bsk-(?:proj-|ant-)?[A-Za-z0-9_-]{32,}/],
  ["session-cookie", /\b(?:JSESSIONID|CASTGC|TGC)=[A-Za-z0-9._-]{24,}/],
]);

export const PRIVATE_GENERATED_PATH_RULE = "private-or-generated-path";

/** 与生产仓库无关的私有/生成目录：任何层级出现即命中（原正则带 /i，这里同样忽略大小写）。 */
const PRIVATE_DIRECTORIES = Object.freeze(["node_modules", "dist", "downloads", ".runtime", ".local", ".superpowers"]);

/**
 * 原实现的正则语义：目录名按路径段匹配；`.env` 必须是完整文件段或以 `.env.` 开头；
 * `.dpapi` 作为扩展名结尾。这里用线性判定替代顶层 alternation，命中范围不变。
 */
export function isPrivateOrGeneratedPath(name) {
  if (typeof name !== "string" || !name) return false;
  const normalized = name.replaceAll("\\", "/").toLowerCase();
  const segments = normalized.split("/");
  if (segments.some((part) => PRIVATE_DIRECTORIES.includes(part))) return true;
  if (segments.some((part) => part === ".env" || part.startsWith(".env."))) return true;
  return normalized.endsWith(".dpapi");
}

/** 返回命中规则名（保持 AUDIT_RULES 声明顺序），供 audit-source 汇总。 */
export function scanText(text) {
  const findings = [];
  for (const [rule, regex] of AUDIT_RULES) if (regex.test(text)) findings.push(rule);
  return findings;
}