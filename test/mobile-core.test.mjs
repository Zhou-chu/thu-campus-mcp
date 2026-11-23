import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { GENERATED, buildFallbackUrl, buildSessionUrl, loadSpec, parsePairResult, renderArkTs, renderKotlin } from "../packages/mobile-core/index.mjs";

test("会话码 URL 与回退 URL 都不把令牌放进 query", () => {
  const spec = loadSpec();
  const session = buildSessionUrl("https://host:8973/", "abc_DEF-123");
  assert.equal(session, `https://host:8973/?${spec.session.redeemQuery}=abc_DEF-123`);
  assert.ok(!session.includes("#"));
  const fallback = buildFallbackUrl("http://127.0.0.1:8971", "tc1_secret");
  assert.equal(fallback, `http://127.0.0.1:8971/#${spec.session.fallbackFragment}=tc1_secret`);
  for (const bad of [[undefined, "x"], ["ftp://x", "x"], ["https://x", ""]]) {
    assert.throws(() => buildSessionUrl(...bad), /地址|会话码/);
  }
  assert.throws(() => buildFallbackUrl("https://x", ""), /令牌/);
});

test("配对结果解析：只接受真实 token，错误给出可读文案", () => {
  const spec = loadSpec();
  const ok = parsePairResult({ ok: true, token: "tc1_abc", baseUrl: "https://host:8973/" });
  assert.deepEqual(ok, { ok: true, token: "tc1_abc", baseUrl: "https://host:8973" });
  assert.equal(parsePairResult({ ok: false, error: { message: "配对码过期" } }).message, "配对码过期");
  assert.equal(parsePairResult({ ok: false }).message, spec.copy.pairingFailed);
  assert.equal(parsePairResult({ ok: true, token: "" }).ok, false);
  assert.equal(parsePairResult({ ok: true, token: "t", baseUrl: "not-a-url" }).baseUrl, "");
});

test("生成的 Kotlin/ArkTS 常量与 spec 一致，且仓库里的文件没有漂移", async () => {
  const spec = loadSpec();
  for (const [needle, source] of [
    [spec.session.exchangePath, renderKotlin(spec)],
    [spec.session.redeemQuery, renderKotlin(spec)],
    [spec.copy.sessionCodeFallback, renderKotlin(spec)],
    [spec.session.exchangePath, renderArkTs(spec)],
  ]) {
    assert.ok(source.includes(needle), `生成结果缺少 ${needle}`);
  }
  assert.match(renderKotlin(spec), /object MobileCore/);
  assert.match(renderArkTs(spec), /export class MobileCore/);

  for (const [relative, render] of Object.entries(GENERATED)) {
    const committed = await readFile(relative, "utf8");
    assert.equal(committed, render(), `${relative} 与 spec 不一致，请运行 npm run mobile:core`);
  }
});

test("移动端工程已按 apps/ 拆分，旧 mobile/ 目录不再存在", async () => {
  const spec = loadSpec();
  assert.ok(spec.version >= 1);
  await assert.rejects(() => readFile("mobile/README.md", "utf8"), /ENOENT/);
  for (const path of ["apps/mobile-android/build.gradle.kts", "apps/mobile-harmony/build-profile.json5", "apps/README.md"]) {
    await readFile(path, "utf8");
  }
});