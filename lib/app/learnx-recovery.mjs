import { createHash } from "node:crypto";
import { loadAccount } from "./account.mjs";
import { loginLearnxWithAccount } from "./learnx-login.mjs";

const failures = {
  CAS_CAPTCHA_REQUIRED: "学校统一身份认证要求人工验证。请到“服务”页完成网络学堂登录。",
  BROWSER_ACCOUNT_MISMATCH: "统一账号与原网络学堂账号不同，未自动换号。请在“服务”页手动登录。",
  AUTH_CHANGED: "恢复期间账号配置已变化；请重新读取或手动登录。",
  ACCOUNT_STORAGE: "本机统一账号无法解密，请使用原Windows用户或重新配置。",
};
const delayFor = outcome => outcome?.ok ? 5000 : outcome?.error?.code === "CAS_CAPTCHA_REQUIRED" ? 120000 : 30000;

/** One coordinator per MCP gateway. Automatic recovery must not change the account of a read. */
export function createLearnxRecovery({ stateDir, restoreSnapshot, readAccount = loadAccount, login = loginLearnxWithAccount, now = Date.now } = {}) {
  let inFlight, previous;
  async function run() {
    try {
      const account = stateDir ? await readAccount(stateDir) : null;
      const expectedAccountId = account && createHash("sha256").update(account.username).digest("hex").slice(0, 16);
      if (await restoreSnapshot(expectedAccountId || undefined)) return { ok: true };
      if (!account) return false;
      const verified = await login({ stateDir, sameAccountOnly: true, expectedAccount: account });
      return verified?.ok === true ? { ok: true } : false;
    } catch (error) {
      const code = error?.code;
      return Object.hasOwn(failures, code) ? { error: { code, message: failures[code] } } : false;
    }
  }
  return () => {
    if (inFlight) return inFlight;
    if (previous && now() - previous.at < delayFor(previous.outcome)) return Promise.resolve(previous.outcome);
    inFlight = run().then(outcome => {
      previous = { outcome, at: now() };
      return outcome;
    }).finally(() => { inFlight = undefined; });
    return inFlight;
  };
}
