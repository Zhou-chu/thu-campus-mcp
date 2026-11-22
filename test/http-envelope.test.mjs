import assert from "node:assert/strict";
import test from "node:test";
import { envelopeProblems, errorEnvelope, successEnvelope } from "../lib/app/http-envelope.mjs";

test("envelope helpers produce one shape and clamp unsafe input", () => {
  assert.deepEqual(successEnvelope({ tools: [] }), { ok: true, tools: [] });
  assert.deepEqual(errorEnvelope("NOT_FOUND", " 不存在 "), { ok: false, error: { code: "NOT_FOUND", message: "不存在" } });
  const unsafe = errorEnvelope("not a code<script>", "");
  assert.equal(unsafe.error.code, "APP_ERROR");
  assert.equal(unsafe.error.message, "请求处理失败。");
  assert.equal(errorEnvelope("X", "y".repeat(1000)).error.message.length, 400);
  assert.deepEqual(errorEnvelope("BROWSER_BUSY", "忙", { service: "seat" }).error, { code: "BROWSER_BUSY", message: "忙", service: "seat" });
});

test("envelopeProblems accepts exactly the documented contract", () => {
  assert.deepEqual(envelopeProblems({ ok: true, tools: [] }), []);
  assert.deepEqual(envelopeProblems({ ok: false, error: { code: "AUTH_REQUIRED", message: "请先配对" } }), []);
  assert.deepEqual(envelopeProblems({ ok: false, error: { code: "LOGIN_FAILED", message: "失败", service: "sports" } }), []);
  for (const [body, expected] of [
    [null, "not-an-object"],
    [[], "not-an-object"],
    [{}, "missing-ok"],
    [{ ok: false }, "missing-error"],
    [{ ok: false, error: { message: "x" } }, "bad-error-code"],
    [{ ok: false, error: { code: "XX" } }, "missing-error-message"],
    [{ ok: false, error: { code: "XX", message: "m", service: "" } }, "bad-error-service"],
    [{ ok: true, error: { code: "X", message: "m" } }, "success-with-error"],
  ]) {
    assert.deepEqual(envelopeProblems(body), [expected], JSON.stringify(body));
  }
});