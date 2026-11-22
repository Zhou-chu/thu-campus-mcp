/**
 * 移动端共享协议：会话码交换、配对与错误文案的单一来源。
 *
 * 安卓与鸿蒙壳不复制这些字符串：`scripts/build-mobile-core.mjs` 从这里生成两端常量文件，
 * 测试会核对生成结果与仓库里的文件一致，避免两端悄悄漂移。
 */
import { readFileSync } from "node:fs";

export const SPEC_PATH = new URL("./spec.json", import.meta.url);

export function loadSpec() {
  return JSON.parse(readFileSync(SPEC_PATH, "utf8"));
}

function trimBase(base) {
  const value = String(base ?? "").trim();
  if (!/^https?:\/\//i.test(value)) throw new Error("运行时地址必须是 http(s)");
  return value.replace(/\/+$/, "");
}

/** 首选的打开方式：一次性会话码，令牌只出现在 POST 请求体里。 */
export function buildSessionUrl(base, code) {
  const value = String(code ?? "").trim();
  if (!value) throw new Error("会话码不能为空");
  return trimBase(base) + "/?" + loadSpec().session.redeemQuery + "=" + encodeURIComponent(value);
}

/** 兼容回退：旧版运行时不支持会话码时才使用，令牌进入 URL 片段。 */
export function buildFallbackUrl(base, token) {
  const value = String(token ?? "").trim();
  if (!value) throw new Error("令牌不能为空");
  return trimBase(base) + "/#" + loadSpec().session.fallbackFragment + "=" + encodeURIComponent(value);
}

/** 解析配对接口返回：只接受非空 token 与 http(s) base。 */
export function parsePairResult(body) {
  const spec = loadSpec();
  const ok = body?.ok === true;
  if (!ok) return { ok: false, message: body?.error?.message || spec.copy.pairingFailed };
  const token = String(body.token ?? "").trim();
  if (!token) return { ok: false, message: spec.copy.pairingFailed };
  const base = String(body.baseUrl ?? "").trim();
  return { ok: true, token, baseUrl: /^https?:\/\//i.test(base) ? base.replace(/\/+$/, "") : "" };
}

/** 把 spec 生成两端的常量源码；顺序固定，便于逐字比对。 */
export function renderKotlin(spec = loadSpec()) {
  const s = spec.session;
  return [
    "// 由 scripts/build-mobile-core.mjs 从 packages/mobile-core/spec.json 生成，请勿手改。",
    "package cn.edu.tsinghua.campusapp",
    "",
    "object MobileCore {",
    `    const val EXCHANGE_PATH = "${s.exchangePath}"`,
    `    const val REDEEM_QUERY = "${s.redeemQuery}"`,
    `    const val FALLBACK_FRAGMENT = "${s.fallbackFragment}"`,
    `    const val PAIRING_PATH = "${s.pairingPath}"`,
    `    const val HEALTH_PATH = "${s.healthPath}"`,
    `    const val META_PATH = "${s.metaPath}"`,
    `    const val BASE_KEY = "${spec.storage.baseKey}"`,
    `    const val TOKEN_KEY = "${spec.storage.tokenKey}"`,
    `    const val COPY_FALLBACK = "${spec.copy.sessionCodeFallback}"`,
    `    const val COPY_PAIRING_FAILED = "${spec.copy.pairingFailed}"`,
    `    const val COPY_TOKEN_REJECTED = "${spec.copy.tokenRejected}"`,
    `    const val COPY_UNREACHABLE = "${spec.copy.runtimeUnreachable}"`,
    "}",
    "",
  ].join("\n");
}

export function renderArkTs(spec = loadSpec()) {
  const s = spec.session;
  return [
    "// 由 scripts/build-mobile-core.mjs 从 packages/mobile-core/spec.json 生成，请勿手改。",
    "export class MobileCore {",
    `  static readonly EXCHANGE_PATH: string = '${s.exchangePath}';`,
    `  static readonly REDEEM_QUERY: string = '${s.redeemQuery}';`,
    `  static readonly FALLBACK_FRAGMENT: string = '${s.fallbackFragment}';`,
    `  static readonly PAIRING_PATH: string = '${s.pairingPath}';`,
    `  static readonly HEALTH_PATH: string = '${s.healthPath}';`,
    `  static readonly META_PATH: string = '${s.metaPath}';`,
    `  static readonly BASE_KEY: string = '${spec.storage.baseKey}';`,
    `  static readonly TOKEN_KEY: string = '${spec.storage.tokenKey}';`,
    `  static readonly COPY_FALLBACK: string = '${spec.copy.sessionCodeFallback}';`,
    `  static readonly COPY_PAIRING_FAILED: string = '${spec.copy.pairingFailed}';`,
    `  static readonly COPY_TOKEN_REJECTED: string = '${spec.copy.tokenRejected}';`,
    `  static readonly COPY_UNREACHABLE: string = '${spec.copy.runtimeUnreachable}';`,
    "}",
    "",
  ].join("\n");
}

export const GENERATED = {
  "apps/mobile-android/app/src/main/java/cn/edu/tsinghua/campusapp/MobileCore.kt": renderKotlin,
  "apps/mobile-harmony/entry/src/main/ets/common/MobileCore.ets": renderArkTs,
};