/**
 * 极小的 Sentry 上报：只用 Envelope HTTP 接口，不引入 SDK 依赖。
 *
 * 设计约束：
 *  - 未配置 DSN 时**完全不联网**（enabled=false），也不会产生任何外部请求；
 *  - 只上报“错误类型 + 归一化后的消息 + 错误码 + 版本”，绝不带账号、Cookie、
 *    请求参数、页面内容或文件路径中的人员信息；
 *  - 上报失败只能被忽略，不能影响业务请求。
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

export function parseDsn(dsn) {
  const value = String(dsn || "").trim();
  if (!value) return null;
  try {
    const url = new URL(value);
    const segments = url.pathname.split("/").filter(Boolean);
    const projectId = segments.pop();
    const publicKey = url.username;
    if (!publicKey || !projectId) return null;
    return { envelopeUrl: `${url.protocol}//${url.host}${url.pathname.replace(/\/$/, "")}/envelope/`, publicKey, projectId };
  } catch {
    return null;
  }
}

export function createSentry({
  dsn = process.env.SENTRY_DSN || "",
  release = "",
  environment = process.env.SENTRY_ENVIRONMENT || "production",
  serverName = "",
  fetchImpl = fetch,
  now = () => Date.now(),
  sampleRate = 1,
} = {}) {
  const parsed = parseDsn(dsn);
  const enabled = Boolean(parsed);
  const seen = new Map();
  const capture = async (error, { tags = {}, level = "error", extra = {} } = {}) => {
    if (!parsed) return { ok: false, code: "SENTRY_DISABLED" };
    if (sampleRate < 1 && Math.random() > sampleRate) return { ok: false, code: "SENTRY_SAMPLED_OUT" };
    const type = typeof error?.name === "string" && /^[A-Za-z]{1,40}$/.test(error.name) ? error.name : "Error";
    const message = scrubMessage(error?.message || error);
    // 同一类错误一分钟内只上报一次：避免故障风暴把配额打光。
    const key = type + ":" + message;
    const stamp = now();
    if (seen.has(key) && stamp - seen.get(key) < 60_000) return { ok: false, code: "SENTRY_DEDUPED" };
    seen.set(key, stamp);
    if (seen.size > 200) seen.delete(seen.keys().next().value);
    const eventId = Array.from({ length: 32 }, () => "0123456789abcdef"[Math.floor(Math.random() * 16)]).join("");
    const event = {
      event_id: eventId,
      timestamp: new Date(stamp).toISOString(),
      platform: "node",
      level,
      release: release || undefined,
      environment,
      server_name: serverName || undefined,
      tags: { ...tags, runtime: "thu-campus-mcp" },
      exception: { values: [{ type, value: message }] },
      extra,
    };
    const envelope = [
      JSON.stringify({ event_id: eventId, sent_at: new Date(stamp).toISOString(), dsn }),
      JSON.stringify({ type: "event" }),
      JSON.stringify(event),
    ].join("\n");
    try {
      const response = await fetchImpl(parsed.envelopeUrl, {
        method: "POST",
        headers: {
          "content-type": "application/x-sentry-envelope",
          "x-sentry-auth": `Sentry sentry_version=7, sentry_key=${parsed.publicKey}, sentry_client=thu-campus-mcp/1.0`,
        },
        body: envelope,
        signal: AbortSignal.timeout(5000),
      });
      return { ok: response.ok, code: response.ok ? "SENTRY_SENT" : "SENTRY_REJECTED", eventId };
    } catch {
      return { ok: false, code: "SENTRY_UNREACHABLE" };
    }
  };
  return { enabled, capture, scrub: scrubMessage };
}