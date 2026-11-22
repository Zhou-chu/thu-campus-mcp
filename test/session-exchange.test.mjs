import assert from "node:assert/strict";
import test from "node:test";
import { createSessionExchange } from "../lib/app/session-exchange.mjs";

test("会话码只用一次、按注入时钟过期", () => {
  let now = 1000;
  const exchange = createSessionExchange({ now: () => now, ttlMs: 60_000 });
  const issued = exchange.issue("tc1_secret_token");
  assert.match(issued.code, /^[A-Za-z0-9_-]{24,80}$/);
  assert.equal(issued.ttlSeconds, 60);
  assert.equal(exchange.size(), 1);
  assert.equal(exchange.redeem(issued.code), "tc1_secret_token");
  assert.equal(exchange.redeem(issued.code), null, "同一个码不能兑换两次");
  assert.equal(exchange.size(), 0);

  const other = exchange.issue("tc1_second");
  now += 60_001;
  assert.equal(exchange.redeem(other.code), null, "过期后拒绝");
  assert.equal(exchange.size(), 0, "过期码会被清理");
});

test("会话码拒绝非法输入与空令牌", () => {
  const exchange = createSessionExchange({ now: () => 0 });
  for (const code of [null, undefined, "", "short", "x".repeat(200), "has space in code"]) {
    assert.equal(exchange.redeem(code), null, `拒绝 ${JSON.stringify(code)}`);
  }
  assert.equal(exchange.issue(""), null);
  assert.equal(exchange.issue(undefined), null);
});

test("并发兑换只有第一个成功", async () => {
  const exchange = createSessionExchange({ now: () => 5 });
  const { code } = exchange.issue("tc1_race");
  const results = await Promise.all([1, 2, 3].map(async () => exchange.redeem(code)));
  assert.equal(results.filter(Boolean).length, 1);
});