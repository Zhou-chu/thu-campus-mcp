/**
 * 按登录用户读取/保存界面与模型偏好（设置、模型名、思考强度、精简工具）。
 *
 * 未登录（设备令牌模式）时继续用进程内的 overrides；登录后写 user_settings，
 * 多设备共用同一份偏好。
 */
import { currentUserId } from "./request-context.mjs";

const KEYS = new Set(["modelName", "reasoningEffort", "compactTools"]);

export function mergeSettings(base, entries) {
  const out = { ...base };
  for (const entry of entries || []) {
    if (!KEYS.has(entry.key)) continue;
    if (entry.key === "compactTools") out.compactTools = entry.value === true;
    else if (typeof entry.value === "string") out[entry.key] = entry.value;
  }
  return out;
}

export function createUserSettings({ store, base }) {
  async function userId() {
    try { return currentUserId(); } catch { return null; }
  }
  return {
    async load() {
      const id = await userId();
      if (!store || !id) return { ...base };
      try {
        return mergeSettings(base, await store.repos.settings.list(id));
      } catch {
        return { ...base };
      }
    },
    /** 只接受已知键；未登录时返回 false，由调用方退回文件存储。 */
    async save(patch) {
      const id = await userId();
      if (!store || !id) return false;
      const writes = [];
      if (typeof patch.modelName === "string") writes.push(["modelName", patch.modelName.slice(0, 200)]);
      if (patch.compactTools !== undefined) writes.push(["compactTools", patch.compactTools === true]);
      if (typeof patch.reasoningEffort === "string") writes.push(["reasoningEffort", patch.reasoningEffort]);
      for (const [key, value] of writes) {
        await store.repos.settings.set(id, key, value);
        try {
          await store.repos.changes.append({ userId: id, entity: "settings", entityId: key, op: "set", payload: { value } });
        } catch {
          // 变更日志失败不回滚用户设置。
        }
      }
      return writes.length > 0;
    },
  };
}