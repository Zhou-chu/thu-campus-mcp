import assert from "node:assert/strict";
import { test } from "node:test";
import { scrubMessage } from "../lib/observability/scrub.mjs";
import { createAppSentry } from "../lib/observability/sentry-node.mjs";
import { resolveWebDsn } from "../lib/observability/web-dsn.mjs";

test("Sentry 脱敏：去掉令牌、学号、邮箱、查询串与本地路径", () => {
  const raw = "登录失败 https://id.tsinghua.edu.cn/x?ticket=SECRET 账号 2024010419 邮箱 a.b@mails.tsinghua.edu.cn token=tc1_abcdefghijkl D:\\code\\secret\\file.js";
  const cleaned = scrubMessage(raw);
  assert.ok(!cleaned.includes("SECRET"));
  assert.ok(!cleaned.includes("2024010419"));
  assert.ok(!cleaned.includes("a.b@mails.tsinghua.edu.cn"));
  assert.ok(!cleaned.includes("tc1_abcdefghijkl"));
  assert.ok(!cleaned.includes("D:\\code"));
  assert.ok(cleaned.length <= 500);
});

test("Sentry 未配置 DSN 时完全不初始化", async () => {
  const sentry = createAppSentry({ version: "v1", host: "127.0.0.1", env: {} });
  assert.equal(sentry.enabled, false);
  const result = await sentry.capture(new Error("boom"));
  assert.equal(result.code, "SENTRY_DISABLED");
});

test("前端 DSN 解析：缺省为空，合法时给出 ingest 源与环境", () => {
  assert.equal(resolveWebDsn({ env: {}, host: "127.0.0.1" }), null);
  assert.equal(resolveWebDsn({ env: { SENTRY_WEB_DSN: "not-a-dsn" }, host: "127.0.0.1" }), null);
  const parsed = resolveWebDsn({ env: { SENTRY_WEB_DSN: "https://k@o1.ingest.de.sentry.io/42" }, host: "0.0.0.0" });
  assert.equal(parsed.origin, "https://o1.ingest.de.sentry.io");
  assert.equal(parsed.environment, "production");
  assert.equal(resolveWebDsn({ env: { SENTRY_WEB_DSN: "https://k@o1.ingest.de.sentry.io/42", SENTRY_ENVIRONMENT: "local" }, host: "0.0.0.0" }).environment, "local");
});
