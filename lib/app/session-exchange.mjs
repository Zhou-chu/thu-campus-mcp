/**
 * 会话交换码：让浏览器/桌面端用一次性短码换取设备令牌，令牌不再出现在 URL、历史记录
 * 或 `--app=` 的进程命令行里。
 *
 * 码只保存在内存，单次使用，默认 60 秒失效；兑换动作不产生新设备，只是把调用者已有的
 * 令牌交给同一台机器上的客户端。
 */
import { randomBytes } from "node:crypto";

const CODE = /^[A-Za-z0-9_-]{24,80}$/;

export function createSessionExchange({ now = Date.now, ttlMs = 60_000 } = {}) {
  const codes = new Map();
  const prune = () => {
    const at = now();
    for (const [code, entry] of codes) if (entry.expiresAt <= at) codes.delete(code);
  };
  return {
    issue(token) {
      if (typeof token !== "string" || !token) return null;
      prune();
      const code = randomBytes(24).toString("base64url");
      const expiresAt = now() + ttlMs;
      codes.set(code, { token, expiresAt });
      return { code, expiresAt: new Date(expiresAt).toISOString(), ttlSeconds: Math.round(ttlMs / 1000) };
    },
    redeem(code) {
      if (!CODE.test(String(code || ""))) return null;
      prune();
      const entry = codes.get(code);
      codes.delete(code);
      if (!entry || entry.expiresAt <= now()) return null;
      return entry.token;
    },
    size() {
      prune();
      return codes.size;
    },
  };
}