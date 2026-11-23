/**
 * 密码哈希：Node 内置 scrypt，随机盐，结果自带参数版本。
 *
 * 存储格式：`scrypt$N$r$p$saltBase64$hashBase64`。参数写在串里，
 * 以后调高成本不需要迁移旧数据（校验按存的那份参数走）。
 */
import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const scrypt = promisify(scryptCallback);
export const MIN_PASSWORD_LENGTH = 10;
export const MAX_PASSWORD_LENGTH = 200;
const DEFAULTS = { N: 16384, r: 8, p: 1, keyLength: 32 };

/** 只做“能不能当密码用”的形状检查，不替用户决定复杂度。 */
export function passwordProblem(password) {
  const value = String(password ?? "");
  if (value.length < MIN_PASSWORD_LENGTH) return `密码至少 ${MIN_PASSWORD_LENGTH} 位。`;
  if (value.length > MAX_PASSWORD_LENGTH) return `密码最多 ${MAX_PASSWORD_LENGTH} 位。`;
  return "";
}

export async function hashPassword(password, options = {}) {
  const problem = passwordProblem(password);
  if (problem) throw Object.assign(new Error(problem), { code: "WEAK_PASSWORD" });
  const { N, r, p, keyLength } = { ...DEFAULTS, ...options };
  const salt = randomBytes(16);
  const derived = await scrypt(String(password), salt, keyLength, { N, r, p, maxmem: 64 * 1024 * 1024 });
  return `scrypt$${N}$${r}$${p}$${salt.toString("base64")}$${derived.toString("base64")}`;
}

export async function verifyPassword(password, stored) {
  const parts = String(stored ?? "").split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const [, N, r, p, saltText, hashText] = parts;
  const params = { N: Number(N), r: Number(r), p: Number(p) };
  if (![params.N, params.r, params.p].every(value => Number.isInteger(value) && value > 0)) return false;
  let salt, expected;
  try {
    salt = Buffer.from(saltText, "base64");
    expected = Buffer.from(hashText, "base64");
  } catch {
    return false;
  }
  if (!salt.length || !expected.length) return false;
  let actual;
  try {
    actual = await scrypt(String(password ?? ""), salt, expected.length, { ...params, maxmem: 64 * 1024 * 1024 });
  } catch {
    return false;
  }
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}