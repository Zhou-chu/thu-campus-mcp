import assert from "node:assert/strict";
import { test } from "node:test";
import { loginWithUnifiedAccount, UnifiedLoginError } from "../lib/app/unified-login.mjs";
import { LearnxAccountLoginError } from "../lib/app/learnx-login.mjs";

test("统一登录：persist=false 只验证不落盘，commit 才保存", async () => {
  const saved = [];
  const login = async ({ credentials }) => ({ ok: true, username: credentials.username });
  const result = await loginWithUnifiedAccount({
    account: "2024000000",
    password: "secret-pass",
    stateDir: "fixture",
    login,
    save: async (account, stateDir) => { saved.push({ account, stateDir }); },
    persist: false,
  });
  assert.equal(result.ok, true);
  assert.equal(result.username, "2024000000");
  assert.equal(saved.length, 0, "验证阶段不能先写盘");
  assert.equal(typeof result.commit, "function");
  await result.commit();
  assert.deepEqual(saved, [{ account: { username: "2024000000", password: "secret-pass" }, stateDir: "fixture" }]);
});

test("统一登录：参数与凭据错误不会被当成成功", async () => {
  await assert.rejects(() => loginWithUnifiedAccount({ account: "", password: "x" }), (error) => error instanceof UnifiedLoginError && error.code === "ACCOUNT_REQUIRED");
  await assert.rejects(() => loginWithUnifiedAccount({ account: "u", password: "x" }), (error) => error.code === "PASSWORD_REQUIRED");
  await assert.rejects(
    () => loginWithUnifiedAccount({ account: "u", password: "long-enough", login: async () => { throw new LearnxAccountLoginError("CAS_CAPTCHA_REQUIRED", "需要验证码"); } }),
    (error) => error.code === "CAS_CAPTCHA_REQUIRED" && error.status === 409,
  );
});
