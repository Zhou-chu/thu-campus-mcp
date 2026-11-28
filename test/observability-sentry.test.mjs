import assert from "node:assert/strict";
import { test } from "node:test";
import { createSentry, parseDsn, scrubMessage } from "../lib/observability/sentry.mjs";

test("Sentry：未配置 DSN 时完全不发请求", async () => {
  let calls = 0;
  const sentry = createSentry({ dsn: "", fetchImpl: async () => { calls += 1; return { ok: true }; } });
  assert.equal(sentry.enabled, false);
  const result = await sentry.capture(new Error("boom"));
  assert.equal(result.code, "SENTRY_DISABLED");
  assert.equal(calls, 0);
});

test("Sentry：脱敏去掉令牌、学号、邮箱、查询串与路径", () => {
  const raw = "登录失败 https://id.tsinghua.edu.cn/x?ticket=SECRET 账号 2024010419 邮箱 a.b@mails.tsinghua.edu.cn token=tc1_abcdefghijkl D:\\code\\secret\\file.js";
  const cleaned = scrubMessage(raw);
  assert.ok(!cleaned.includes("SECRET"));
  assert.ok(!cleaned.includes("2024010419"));
  assert.ok(!cleaned.includes("a.b@mails.tsinghua.edu.cn"));
  assert.ok(!cleaned.includes("tc1_abcdefghijkl"));
  assert.ok(!cleaned.includes("D:\\code"));
  assert.ok(cleaned.length <= 500);
});

test("Sentry：Envelope 内容与鉴权头正确，且同类错误一分钟内只发一次", async () => {
  const calls = [];
  const sentry = createSentry({
    dsn: "https://publickey@o1.ingest.sentry.io/42",
    release: "v1",
    environment: "test",
    fetchImpl: async (url, options) => { calls.push({ url, options }); return { ok: true }; },
    now: () => Date.parse("2026-11-29T00:00:00.000Z"),
  });
  assert.equal(sentry.enabled, true);
  const first = await sentry.capture(Object.assign(new Error("请求失败 token=tc1_secretsecret"), { name: "TypeError" }), { tags: { code: "APP_ERROR" } });
  assert.equal(first.ok, true);
  assert.equal(calls.length, 1);
  const url = String(calls[0].url);
  assert.match(url, /^https:\/\/o1\.ingest\.sentry\.io\/42\/envelope\/$/);
  assert.match(calls[0].options.headers["x-sentry-auth"], /sentry_key=publickey/);
  const lines = calls[0].options.body.split("\n");
  assert.equal(lines.length, 3);
  const event = JSON.parse(lines[2]);
  assert.equal(event.exception.values[0].type, "TypeError");
  assert.ok(!JSON.stringify(event).includes("tc1_secretsecret"));
  assert.equal(event.tags.code, "APP_ERROR");
  assert.equal(event.release, "v1");

  const second = await sentry.capture(Object.assign(new Error("请求失败 token=tc1_secretsecret"), { name: "TypeError" }));
  assert.equal(second.code, "SENTRY_DEDUPED");
  assert.equal(calls.length, 1);
});

test("Sentry：上报失败不影响调用方", async () => {
  const sentry = createSentry({ dsn: "https://k@o1.ingest.sentry.io/1", fetchImpl: async () => { throw new Error("network"); } });
  const result = await sentry.capture(new Error("x"));
  assert.equal(result.code, "SENTRY_UNREACHABLE");
  assert.equal(parseDsn("not a dsn"), null);
  assert.equal(parseDsn(""), null);
});
