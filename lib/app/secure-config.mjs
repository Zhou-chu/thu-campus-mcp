/**
 * 实例级加密配置：模型提供商与 GitLab 凭据。
 *
 * 数据库存在时密文写 app_config；没有数据库或未配置密钥时退回本机文件，
 * 行为与升级前一致。
 */
import { decryptCredential, encryptCredential, loadCredentialKey } from "./credential-cipher.mjs";

export function createSecureConfig({ store, stateDir }) {
  let keyPromise = null;
  const key = () => (keyPromise ||= loadCredentialKey(stateDir));

  return {
    async get(name) {
      if (!store) return null;
      const row = await store.repos.config.get(name).catch(() => null);
      if (!row) return null;
      try {
        return decryptCredential(await key(), row);
      } catch {
        return null;
      }
    },
    async put(name, value) {
      if (!store) return false;
      const sealed = encryptCredential(await key(), value);
      await store.repos.config.put(name, sealed);
      return true;
    },
    async remove(name) {
      if (!store) return false;
      return store.repos.config.remove(name);
    },
  };
}