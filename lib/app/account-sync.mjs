/**
 * 统一账号在数据库与本机 DPAPI 之间的同步。
 *
 * 数据库是账号数据的长期来源；本机 account.dpapi 只作为服务包读取的缓存，
 * 登录成功时把库里的账号回写到本机，老用户首次登录则把本机账号收进库。
 */
import { clearAccount, loadAccount, saveAccount } from "./account.mjs";
import { decryptCredential, encryptCredential, loadCredentialKey } from "./credential-cipher.mjs";

const SERVICE = "account";

function valid(account) {
  return account && typeof account.username === "string" && account.username && typeof account.password === "string" && account.password;
}

export function createAccountSync({ store, stateDir, load = loadAccount, save = saveAccount, clear = clearAccount, loadKey = loadCredentialKey, canImport = null } = {}) {
  let keyPromise = null;
  const key = () => (keyPromise ||= loadKey(stateDir));

  return {
    async loadForUser(userId) {
      if (!store || !userId) return null;
      const row = await store.repos.credentials.get(userId, SERVICE).catch(() => null);
      if (!row) return null;
      try {
        const account = decryptCredential(await key(), row);
        return valid(account) ? account : null;
      } catch {
        return null;
      }
    },
    async saveForUser(userId, account) {
      if (!store || !userId || !valid(account)) return false;
      const sealed = encryptCredential(await key(), account);
      await store.repos.credentials.put({ userId, service: SERVICE, ciphertext: sealed.ciphertext, nonce: sealed.nonce });
      return true;
    },
    async clearForUser(userId) {
      if (!store || !userId) return false;
      return store.repos.credentials.remove(userId, SERVICE);
    },
    /** 登录成功：库里有账号就写回本机；库里没有而本机有，就把本机账号收进库。 */
    async syncOnLogin(userId) {
      if (!store || !userId) return { action: "skipped" };
      const stored = await this.loadForUser(userId);
      if (stored) {
        try {
          await save(stored, stateDir);
          return { action: "restored" };
        } catch {
          return { action: "restore-failed" };
        }
      }
      const allowed = canImport
        ? await canImport(userId).catch(() => false)
        : await store.repos.users.listAll().then(users => users.length === 1 && users[0].id === userId).catch(() => false);
      if (!allowed) return { action: "none" };
      let local = null;
      try { local = await load(stateDir); } catch { local = null; }
      if (!valid(local)) return { action: "none" };
      try {
        await this.saveForUser(userId, local);
        return { action: "imported" };
      } catch {
        return { action: "import-failed" };
      }
    },
    /** 退出/清除：只清库里的账号，本机缓存由账号路由显式清。 */
    async removeForUser(userId) {
      return this.clearForUser(userId);
    },
    async clearLocal() {
      await clear(stateDir);
    },
  };
}