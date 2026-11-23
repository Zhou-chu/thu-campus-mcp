/**
 * 服务端凭据加密：AES-256-GCM，密钥来自环境变量或状态目录下的 credential.key。
 * 仅用于写入 PostgreSQL 的密文；本机 DPAPI 文件仍是服务包读取的缓存。
 */
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";

export async function loadCredentialKey(stateDir) {
  const env = process.env.THU_CAMPUS_CREDENTIAL_KEY;
  if (env) {
    const key = Buffer.from(env, "base64");
    if (key.length !== 32) throw Object.assign(new Error("THU_CAMPUS_CREDENTIAL_KEY 必须是 32 字节的 base64。"), { code: "CREDENTIAL_KEY_INVALID" });
    return key;
  }
  const file = path.join(stateDir, "credential.key");
  try {
    const key = Buffer.from((await readFile(file, "utf8")).trim(), "base64");
    if (key.length === 32) return key;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const key = randomBytes(32);
  await mkdir(stateDir, { recursive: true });
  await writeFile(file, key.toString("base64") + "\n", { mode: 0o600 });
  return key;
}

export function encryptCredential(key, value) {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
  return { ciphertext: Buffer.concat([ciphertext, cipher.getAuthTag()]).toString("base64"), nonce: nonce.toString("base64") };
}

export function decryptCredential(key, { ciphertext, nonce }) {
  const raw = Buffer.from(String(ciphertext || ""), "base64");
  if (raw.length < 17) throw Object.assign(new Error("凭据密文不完整。"), { code: "CREDENTIAL_INVALID" });
  const token = Buffer.from(String(nonce || ""), "base64");
  const decipher = createDecipheriv("aes-256-gcm", key, token);
  decipher.setAuthTag(raw.subarray(raw.length - 16));
  const plain = Buffer.concat([decipher.update(raw.subarray(0, raw.length - 16)), decipher.final()]);
  return JSON.parse(plain.toString("utf8"));
}