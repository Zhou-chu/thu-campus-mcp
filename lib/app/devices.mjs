import path from "node:path";
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { atomic, directory, dpapi } from "../../packages/browser/core.mjs";
const TOKEN_PREFIX = "tc1_";
const TOUCH_INTERVAL_MS = 300000;
function hashToken(token) {
  return createHash("sha256").update(String(token)).digest("hex");
}
function sameHash(actual, expected) {
  const a = Buffer.from(String(actual), "hex"),
    b = Buffer.from(String(expected), "hex");
  return a.length === b.length && a.length > 0 && timingSafeEqual(a, b);
}
export function newToken() {
  return TOKEN_PREFIX + randomBytes(32).toString("base64url");
}
/**
 * 设备令牌库：磁盘上只保存 sha256 摘要，明文令牌只在签发时返回一次。
 * 与 madmodel 一致，落盘内容受当前 Windows 用户的 DPAPI 保护。
 */
export class DeviceStore {
  constructor(stateDir, { encrypt = dpapi } = {}) {
    this.file = path.join(stateDir, "devices.dpapi");
    this.stateDir = stateDir;
    this.encrypt = encrypt;
    this.devices = [];
    this.loaded = false;
    this.touched = new Map();
    this.writing = null;
  }
  async load() {
    if (this.loaded) return this;
    await directory(this.stateDir);
    const encrypted = await readFile(this.file).catch((e) => {
      if (e.code === "ENOENT") return null;
      throw e;
    });
    if (!encrypted) {
      this.devices = [];
      this.loaded = true;
      return this;
    }
    const plain = JSON.parse(
      (await this.encrypt(encrypted, true)).toString("utf8"),
    );
    this.devices = Array.isArray(plain?.devices) ? plain.devices : [];
    this.loaded = true;
    return this;
  }
  async save() {
    if (this.writing) await this.writing;
    this.writing = (async () => {
      try {
        const bytes = Buffer.from(
          JSON.stringify({ devices: this.devices, at: new Date().toISOString() }),
        );
        await atomic(this.file, await this.encrypt(bytes));
      } finally {
        this.writing = null;
      }
    })();
    await this.writing;
  }
  async list() {
    await this.load();
    return this.devices.map(({ id, name, platform, createdAt, lastUsedAt }) => ({
      id,
      name,
      platform,
      createdAt,
      lastUsedAt: lastUsedAt || null,
    }));
  }
  async count() {
    await this.load();
    return this.devices.length;
  }
  async issue({ name, platform }) {
    await this.load();
    const token = newToken();
    const record = {
      id: randomUUID(),
      name: String(name || "未命名设备").slice(0, 64),
      platform: String(platform || "webui").slice(0, 24),
      hash: hashToken(token),
      createdAt: new Date().toISOString(),
      lastUsedAt: null,
    };
    this.devices = [...this.devices.filter((d) => d.name !== record.name || d.platform !== record.platform), record];
    await this.save();
    return { id: record.id, token, name: record.name, platform: record.platform };
  }
  async verify(token) {
    if (typeof token !== "string" || !token.startsWith(TOKEN_PREFIX)) return null;
    await this.load();
    const digest = hashToken(token);
    const device = this.devices.find((d) => sameHash(digest, d.hash));
    if (!device) return null;
    const now = Date.now();
    const last = this.touched.get(device.id) || 0;
    if (now - last > TOUCH_INTERVAL_MS) {
      this.touched.set(device.id, now);
      device.lastUsedAt = new Date(now).toISOString();
      await this.save().catch(() => {});
    }
    return { id: device.id, name: device.name, platform: device.platform };
  }
  async revoke(id) {
    await this.load();
    const before = this.devices.length;
    this.devices = this.devices.filter((d) => d.id !== id);
    if (this.devices.length === before) return false;
    this.touched.delete(id);
    await this.save();
    return true;
  }
}