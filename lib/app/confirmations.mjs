import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/** 稳定序列化：同一组参数必须得到同一绑定串，键顺序不影响判定。 */
const compareKey = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
export function canonicalJson(value) {
  if (Array.isArray(value)) return "[" + value.map(canonicalJson).join(",") + "]";
  if (value && typeof value === "object")
    return "{" + Object.keys(value).sort(compareKey).map(key => JSON.stringify(key) + ":" + canonicalJson(value[key])).join(",") + "}";
  return JSON.stringify(value ?? null);
}

/**
 * 一次性确认凭证：写入类工具与应用内提交都必须先领取，再在真正执行时消费。
 * 凭证与作用域、参数绑定，单次使用，过期即失效；内存态，重启后全部作废。
 */
export function createConfirmations({ ttlMs = 10 * 60_000, now = () => Date.now(), limit = 500 } = {}) {
  const issued = new Map();
  const digest = value => createHash("sha256").update(value).digest("hex");
  function prune() {
    const at = now();
    for (const [token, record] of issued) if (record.expiresAt <= at) issued.delete(token);
    while (issued.size > limit) issued.delete(issued.keys().next().value);
  }
  return {
    issue(scope, binding) {
      prune();
      const token = randomBytes(24).toString("hex");
      const expiresAt = now() + ttlMs;
      issued.set(token, { scope, binding: digest(binding), expiresAt });
      return { token, expiresAt: new Date(expiresAt).toISOString() };
    },
    /** 消费后才失效：校验失败不能把别人的有效凭证删掉。 */
    consume(token, scope, binding) {
      if (typeof token !== "string" || !/^[a-f0-9]{48}$/.test(token)) return false;
      prune();
      const record = issued.get(token);
      if (!record || record.scope !== scope || record.expiresAt <= now()) return false;
      const expected = Buffer.from(record.binding, "hex");
      const actual = Buffer.from(digest(binding), "hex");
      if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return false;
      issued.delete(token);
      return true;
    },
    clear() { issued.clear(); },
  };
}