/**
 * 邮箱账号规则：清华邮箱域名白名单 + 规范化。
 *
 * 注册限定清华邮箱（用户 2026-11-23 的决定）；不发验证邮件，因此域名校验是
 * 唯一一道“看起来像本校用户”的门槛，必须严格按完整域名匹配。
 */
export const DEFAULT_EMAIL_DOMAINS = ["mails.tsinghua.edu.cn", "mail.tsinghua.edu.cn", "tsinghua.edu.cn"];

/** 允许用环境变量覆盖白名单（逗号分隔），便于测试与其它部署。 */
export function allowedDomains(env = process.env) {
  const raw = String(env.THU_CAMPUS_AUTH_EMAIL_DOMAINS ?? "").trim();
  const list = raw
    ? raw.split(",").map(item => item.trim().toLowerCase()).filter(Boolean)
    : DEFAULT_EMAIL_DOMAINS;
  return [...new Set(list)];
}

/** 规范化：去空白、转小写；形状不合法返回空串。 */
export function normalizeEmail(input) {
  const value = String(input ?? "").trim().toLowerCase();
  if (!value || value.length > 254) return "";
  // 不用可能回溯的整串正则：逐段检查 @、本地部分与域名标签。
  const at = value.indexOf("@");
  if (at <= 0 || at !== value.lastIndexOf("@")) return "";
  const local = value.slice(0, at);
  const domain = value.slice(at + 1);
  if (!local || local.length > 64 || /[^a-z0-9._%+-]/.test(local)) return "";
  if (!domain || domain.length > 253 || /\s/.test(domain)) return "";
  const labels = domain.split(".");
  if (labels.length < 2 || labels.some(label => !label || label.length > 63 || /[^a-z0-9-]/.test(label))) return "";
  return value;
}

export function emailDomain(email) {
  const value = normalizeEmail(email);
  return value ? value.slice(value.indexOf("@") + 1) : "";
}

/** 完整域名匹配（不接受子域冒充，例如 x@fake.tsinghua.edu.cn 不通过）。 */
export function emailAllowed(email, domains = allowedDomains()) {
  const domain = emailDomain(email);
  return Boolean(domain) && domains.includes(domain);
}