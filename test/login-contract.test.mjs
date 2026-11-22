import assert from "node:assert/strict";
import test from "node:test";
import { loginFailure, loginStatusOf, loginSuccess, settleLogin } from "../lib/app/login-contract.mjs";

test("login status table keeps one meaning per class of failure", () => {
  assert.equal(loginStatusOf("INVALID_ARGUMENTS"), 400);
  assert.equal(loginStatusOf("ARGUMENT_REQUIRED"), 400);
  assert.equal(loginStatusOf("ACCOUNT_NOT_CONFIGURED"), 409);
  assert.equal(loginStatusOf("CAS_CAPTCHA_REQUIRED"), 409);
  assert.equal(loginStatusOf("AUTH_CHANGED"), 409);
  assert.equal(loginStatusOf("SEAT_LOGIN_REQUIRED"), 409);
  assert.equal(loginStatusOf("SPORTS_MANUAL_VERIFICATION"), 409);
  assert.equal(loginStatusOf("SPORTS_THROTTLED"), 429);
  assert.equal(loginStatusOf("BROWSER_BUSY"), 503);
  assert.equal(loginStatusOf("SPORTS_MAINTENANCE"), 503);
  assert.equal(loginStatusOf("LEARNX_LOGIN_UNCONFIRMED"), 502);
  assert.equal(loginStatusOf("SOMETHING_NEW"), 502);
});

test("login failures share a body shape and never echo an unsafe code", () => {
  const expected = loginFailure("seat", { code: "SEAT_CLOSED", message: "  未开放  " });
  assert.deepEqual(expected, { status: 409, body: { ok: false, error: { code: "SEAT_CLOSED", message: "未开放", service: "seat" } } });
  const unsafe = loginFailure("learnx", { code: "bad code<script>", message: "x".repeat(500) });
  assert.equal(unsafe.status, 502);
  assert.equal(unsafe.body.error.code, "LOGIN_FAILED");
  assert.equal(unsafe.body.error.message.length, 300);
  const silent = loginFailure("sports", {});
  assert.deepEqual(silent.body.error, { code: "LOGIN_FAILED", message: "登录未完成，请稍后重试。", service: "sports" });
});

test("success and service-reported failure settle into the same envelope", () => {
  assert.deepEqual(loginSuccess("sports", { alreadyLoggedIn: true }), {
    status: 200,
    body: { ok: true, service: "sports", alreadyLoggedIn: true },
  });
  assert.equal(settleLogin("seat", { ok: true, alreadyLoggedIn: false }).status, 200);
  assert.deepEqual(settleLogin("seat", { ok: false, code: "SEAT_CLOSED", message: "未开放" }).body.error, {
    code: "SEAT_CLOSED", message: "未开放", service: "seat",
  });
});