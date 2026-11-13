import path from "node:path";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import lockfile from "proper-lockfile";
import { atomic, directory, dpapi } from "../../packages/browser/core.mjs";
import { error, safeFailure } from "./protocol.mjs";
import { readSessionStatus } from "./status.mjs";
export class SessionStore {
  constructor(stateDir) {
    this.stateDir = stateDir;
    this.file = path.join(stateDir, "auth.dpapi");
  }
  async load() {
    let bytes;
    try {
      bytes = await readFile(this.file);
    } catch (e) {
      if (e.code === "ENOENT") return { revision: null, data: undefined };
      throw e;
    }
    return {
      revision: createHash("sha256").update(bytes).digest("hex"),
      data: JSON.parse((await dpapi(bytes, true)).toString("utf8")),
    };
  }
  async save(data, revision) {
    const encrypted = await dpapi(Buffer.from(JSON.stringify(data)));
    await directory(this.stateDir);
    const release = await lockfile.lock(this.stateDir, {
      retries: { retries: 20, minTimeout: 25, maxTimeout: 100 },
    });
    try {
      if ((await this.load()).revision !== revision)
        throw error("AUTH_CHANGED", "认证已变化，未覆盖会话。", 409);
      await atomic(this.file, encrypted);
    } finally {
      await release();
    }
    return data;
  }
}
function waiting(promise, signal) {
  signal?.throwIfAborted();
  if (!signal) return promise;
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    promise
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", abort));
  });
}
export class SessionManager {
  constructor({
    store,
    login,
    verify,
    refreshAheadMs = 900000,
    checkIntervalMs = 300000,
    cooldownMs = 60000,
    signal,
  }) {
    Object.assign(this, {
      store,
      login,
      verify,
      refreshAheadMs,
      checkIntervalMs,
      cooldownMs,
      signal,
    });
    this.verifiedAt = 0;
    this.retryAt = 0;
    this.lastError = null;
    this.pending = null;
    this.renewals = 0;
  }
  async ensure(options = {}) {
    options.signal?.throwIfAborted();
    this.signal?.throwIfAborted();
    const joining = !!this.pending,
      renewals = this.renewals;
    if (!this.pending) {
      this.pending = this.run(options).finally(() => {
        this.pending = null;
      });
    }
    const result = await waiting(this.pending, options.signal);
    // Retain force intent when joining a read-only check. A shared renewal
    // satisfies it even if the issuer returns the same token.
    if (
      options.force &&
      joining &&
      this.renewals === renewals &&
      (!options.rejectedToken || result.token === options.rejectedToken)
    )
      return this.ensure(options);
    return result;
  }
  async run({
    force = false,
    verify = false,
    interactive = false,
    headless = true,
    rejectedToken,
  } = {}) {
    const initial = await this.store.load(),
      previous = initial.data;
    if (previous?.disabled && !interactive)
      throw error("AUTH_REQUIRED", "MadModel 已注销。", 401);
    if (Date.now() < this.retryAt && !interactive)
      throw error("AUTH_COOLDOWN", "稍后再试。", 503);
    try {
      const fresh =
        previous?.token &&
        previous.expiresAt > Date.now() + this.refreshAheadMs &&
        !previous.disabled;
      // A late 401 may refer to a token another caller already replaced.
      if (fresh && force && rejectedToken && previous.token !== rejectedToken)
        return previous;
      if (fresh && !force) {
        if (!verify && Date.now() - this.verifiedAt < this.checkIntervalMs)
          return previous;
        if (await this.verify(previous.token, this.signal)) {
          this.verifiedAt = Date.now();
          this.lastError = null;
          return previous;
        }
      }
      const next = await this.login({
        previous,
        force: force || !!previous?.token,
        headless,
        signal: this.signal,
        interactive,
      });
      this.signal?.throwIfAborted();
      if (previous?.accountId && next.accountId !== previous.accountId)
        throw error("BROWSER_ACCOUNT_MISMATCH", "浏览器账号不匹配。", 409);
      if (!next.token || next.expiresAt <= Date.now())
        throw error("AUTH_EXPIRED", "新令牌已过期。", 401);
      await this.store.save(
        { ...next, disabled: false, savedAt: Date.now() },
        initial.revision,
      );
      this.renewals++;
      this.verifiedAt = Date.now();
      this.retryAt = 0;
      this.lastError = null;
      return next;
    } catch (e) {
      this.retryAt = Date.now() + this.cooldownMs;
      this.lastError = safeFailure(e);
      throw e;
    }
  }
  async check() {
    await this.ensure({ verify: true });
    // check已有显式校验/恢复流程，不再隐式发起第二次校验；诊断不冒充ready。
    return this.status({ verify: false });
  }
  async status({ verify = true } = {}) {
    return readSessionStatus({ store: this.store, verify: this.verify, signal: this.signal,
      verifySession: verify, verifiedAt: this.verifiedAt, retryAt: this.retryAt,
      refreshing: !!this.pending, lastError: this.lastError });
  }
  async logout() {
    // CAS retry makes logout win even if a concurrent login completes first.
    for (let i = 0; i < 10; i++) {
      const current = await this.store.load();
      try {
        await this.store.save(
          {
            disabled: true,
            accountId: current.data?.accountId,
            account: current.data?.account,
          },
          current.revision,
        );
        return { configured: false, disabled: true };
      } catch (e) {
        if (e.code !== "AUTH_CHANGED") throw e;
      }
    }
    throw error("AUTH_CHANGED", "并发认证变化，请重试注销。", 409);
  }
}
