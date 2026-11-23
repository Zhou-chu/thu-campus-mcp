/**
 * 存储入口：有 DATABASE_URL 时连 PostgreSQL，没有时返回 null（迁移期仍可用
 * 现有的本机文件存储）。调用方拿到 null 必须显式降级，不能假装库可用。
 */
import { createPgStore, databaseConfig, StoreError } from "./pg.mjs";
import { createAuthRepositories } from "./auth-repo.mjs";
import { createAuthService } from "../auth/service.mjs";

export { StoreError };

export async function openStore({ env = process.env, pool, config, now } = {}) {
  const resolved = config === undefined ? databaseConfig(env) : config;
  if (!resolved && !pool) return null;
  const store = createPgStore({ config: resolved, pool, now });
  const migrations = await store.migrate();
  const repos = createAuthRepositories(store);
  return {
    store,
    repos,
    migrations,
    auth: createAuthService({ users: repos.users, sessions: repos.sessions, now }),
    async close() {
      await store.close();
    },
  };
}