import assert from "node:assert/strict";
import test from "node:test";

/**
 * 桌面启动器现在用一次性会话码代替 URL 里的令牌。
 * 这里守住参数形状：URL 不含 token，只有短码，且窗口参数不变。
 */

test("launch args use a one-time session code instead of the token", async () => {
  const { buildLaunchArgs } = await import("../launcher.mjs");
  const args = buildLaunchArgs({ port: 8975, sessionCode: "abc_DEF-123456789012345678", profileDir: "C:/tmp/profile" });
  assert.equal(args[0], "--app=http://127.0.0.1:8975/?session=abc_DEF-123456789012345678");
  assert.ok(!args[0].includes("token="), "URL 不能带令牌");
  assert.ok(args[0].includes("/?session="), "会话码用查询串而不是片段，便于日志里也能看出是短码");
  assert.ok(args.includes("--user-data-dir=C:/tmp/profile"));
});

test("exchange failure falls back to the explicit token link and stays visible", async () => {
  const { buildLaunchArgs, describeExchangeFailure } = await import("../launcher.mjs");
  const fallback = buildLaunchArgs({ port: 8975, token: "tc1_fixture", profileDir: "C:/tmp/profile" });
  assert.match(fallback[0], /#token=tc1_fixture$/);
  assert.match(describeExchangeFailure(new Error("boom")), /会话码|令牌/);
  assert.match(describeExchangeFailure({ code: "APP_NOT_READY" }), /运行时|会话码|令牌/);
});