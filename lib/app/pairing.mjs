import { randomInt } from "node:crypto";
import path from "node:path";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
const TTL_MS = 300000;
const MAX_CODES = 8;
const MAX_FAILURES = 30;
const FAILURE_WINDOW_MS = 300000;
const INVITE_FILE = "pairing-invite.json";
/**
 * 预生成邀请码：服务以守护进程运行时控制台不可见，允许在任意终端生成一个
 * 5 分钟有效的一次性码，由运行中的服务在兑换时读取。文件仅当前用户可读，
 * 内容等价于启动时打印到控制台的短时代码，不含长期凭据。
 */
export function invitePath(stateDir) {
  return path.join(stateDir, INVITE_FILE);
}
export function writeInvite(stateDir, { code, expiresAt }) {
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(invitePath(stateDir), JSON.stringify({ code, expiresAt }), {
    mode: 0o600,
  });
  return { code, expiresAt };
}
export function readInvite(stateDir, now = Date.now()) {
  try {
    const parsed = JSON.parse(readFileSync(invitePath(stateDir), "utf8"));
    if (!parsed?.code || !parsed?.expiresAt || parsed.expiresAt <= now) return null;
    return parsed;
  } catch {
    return null;
  }
}
export function clearInvite(stateDir) {
  try {
    rmSync(invitePath(stateDir));
  } catch {}
}
export class PairingError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}
/**
 * 一次性配对码：6 位数字、5 分钟有效、最多同时存在 8 个。
 * 失败次数受限，避免 6 位空间被批量试探。
 */
export class PairingCodes {
  constructor({ ttlMs = TTL_MS, now = () => Date.now() } = {}) {
    this.ttlMs = ttlMs;
    this.now = now;
    this.codes = new Map();
    this.failures = [];
  }
  prune() {
    const now = this.now();
    for (const [code, entry] of this.codes)
      if (entry.expiresAt <= now) this.codes.delete(code);
    this.failures = this.failures.filter((t) => now - t < FAILURE_WINDOW_MS);
    return now;
  }
  issue() {
    const now = this.prune();
    if (this.codes.size >= MAX_CODES) {
      const oldest = [...this.codes.entries()].sort(
        (a, b) => a[1].expiresAt - b[1].expiresAt,
      )[0];
      if (oldest) this.codes.delete(oldest[0]);
    }
    let code;
    do {
      code = String(randomInt(0, 1000000)).padStart(6, "0");
    } while (this.codes.has(code));
    const expiresAt = now + this.ttlMs;
    this.codes.set(code, { expiresAt, attempts: 0 });
    return { code, expiresAt: new Date(expiresAt).toISOString(), ttlSeconds: Math.round(this.ttlMs / 1000) };
  }
  consume(code) {
    const now = this.prune();
    if (this.failures.length >= MAX_FAILURES)
      throw new PairingError(
        "PAIRING_LOCKED",
        "配对尝试过于频繁，请稍后再试。",
      );
    const value = String(code || "").trim();
    if (!/^\d{6}$/.test(value))
      throw new PairingError("PAIRING_INVALID", "配对码必须是 6 位数字。");
    const entry = this.codes.get(value);
    if (!entry || entry.expiresAt <= now) {
      this.codes.delete(value);
      this.failures.push(now);
      throw new PairingError("PAIRING_EXPIRED", "配对码无效或已过期。");
    }
    if (entry.attempts >= 5) {
      this.codes.delete(value);
      throw new PairingError("PAIRING_EXPIRED", "配对码无效或已过期。");
    }
    entry.attempts += 1;
    this.codes.delete(value);
    return true;
  }
  get active() {
    this.prune();
    return this.codes.size;
  }
}
