/**
 * 会话令牌：随机 32 字节，客户端拿明文，服务端只存 SHA-256。
 * 登出与撤销只需把哈希标记为撤销，明文永远不落库。
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

export const SESSION_TTL_MS = 30 * 24 * 3600_000;

export function hashToken(token) {
  return createHash("sha256").update(String(token ?? "")).digest("hex");
}

export function issueToken(now = new Date()) {
  const token = randomBytes(32).toString("base64url");
  return {
    token,
    hash: hashToken(token),
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + SESSION_TTL_MS).toISOString(),
  };
}

/** 两个十六进制哈希是否相等（长度不同直接 false，避免 timingSafeEqual 抛错）。 */
export function sameHash(a, b) {
  const left = Buffer.from(String(a ?? ""), "hex");
  const right = Buffer.from(String(b ?? ""), "hex");
  return left.length > 0 && left.length === right.length && timingSafeEqual(left, right);
}