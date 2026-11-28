/**
 * Sentry 上报前的统一脱敏：去掉查询串、令牌、学号、邮箱与本地绝对路径。
 * 服务端与前端（webui/sentry-client.js）使用同一套规则。
 */

const TOKEN_LIKE = /(bearer\s+[A-Za-z0-9._~+/=-]{8,}|tc1_[A-Za-z0-9._-]{8,}|glpat-[A-Za-z0-9_-]{8,}|[A-Za-z0-9_-]{32,})/gi;
const STUDENT_ID = /\b(19|20)\d{2}\d{6,10}\b/g;
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const QUERY = /\?[^\s"')]+/g;

/** 把消息洗净：去掉令牌、学号、邮箱、查询串与本地绝对路径。 */
export function scrubMessage(value) {
  return String(value ?? "")
    .replace(QUERY, "")
    .replace(TOKEN_LIKE, "[redacted]")
    .replace(STUDENT_ID, "[student-id]")
    .replace(EMAIL, "[email]")
    .replace(/[A-Za-z]:\\[^\s"')]+/g, "[path]")
    .replace(/\/[\w.-]+\/[\w./-]{8,}/g, "[path]")
    .slice(0, 500);
}
