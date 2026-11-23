/**
 * PostgreSQL 访问层：连接池、事务与迁移。
 *
 * 生产用 `pg.Pool` + DATABASE_URL；测试可以注入 pg-mem 的 Pool，
 * 两者共用同一份 SQL，避免“测试通过、线上 SQL 不通”。
 */
import pg from "pg";
import { MIGRATIONS } from "./schema.mjs";

export class StoreError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "StoreError";
    this.code = code;
  }
}

/** 从环境变量读取连接配置；没有配置时返回 null，让调用方决定是否降级。 */
export function databaseConfig(env = process.env) {
  const connectionString = String(env.DATABASE_URL || env.THU_CAMPUS_DATABASE_URL || "").trim();
  if (!connectionString) return null;
  if (!/^postgres(?:ql)?:\/\//i.test(connectionString)) {
    throw new StoreError("INVALID_DATABASE_URL", "DATABASE_URL 必须是 postgres:// 连接串。");
  }
  const sslMode = String(env.DATABASE_SSL || "").toLowerCase();
  return {
    connectionString,
    max: Number(env.DATABASE_POOL_MAX) > 0 ? Number(env.DATABASE_POOL_MAX) : 10,
    connectionTimeoutMillis: Number(env.DATABASE_CONNECT_TIMEOUT_MS) > 0 ? Number(env.DATABASE_CONNECT_TIMEOUT_MS) : 15000,
    ssl: sslMode === "require" ? { rejectUnauthorized: false } : undefined,
  };
}

/** 包一层：统一把驱动错误转成可读的 StoreError，不泄露 SQL 细节。 */
function wrapError(error) {
  if (error instanceof StoreError) return error;
  const detail = `${error?.code || ""} ${error?.message || ""}`;
  const code = error?.code === "23505" || /duplicate key|unique constraint/i.test(detail)
    ? "CONFLICT"
    : error?.code === "23503" || /foreign key/i.test(detail)
      ? "FOREIGN_KEY"
      : "DATABASE_ERROR";
  const message = code === "CONFLICT" ? "该记录已存在。" : code === "FOREIGN_KEY" ? "关联记录不存在。" : "数据库操作失败。";
  const wrapped = new StoreError(code, message);
  wrapped.cause = error;
  return wrapped;
}

export function createPgStore({ config = databaseConfig(), pool, now = () => new Date() } = {}) {
  const owned = !pool;
  const client = pool || new pg.Pool(config || {});
  const store = {
    pool: client,
    now,
    async query(text, params = []) {
      try {
        return await client.query(text, params);
      } catch (error) {
        throw wrapError(error);
      }
    },
    /** 事务：回调拿到同一连接，抛错整体回滚。 */
    async transaction(fn) {
      const connection = await client.connect();
      try {
        await connection.query("begin");
        const result = await fn({
          async query(text, params = []) {
            try {
              return await connection.query(text, params);
            } catch (error) {
              throw wrapError(error);
            }
          },
        });
        await connection.query("commit");
        return result;
      } catch (error) {
        await connection.query("rollback").catch(() => {});
        throw wrapError(error);
      } finally {
        connection.release();
      }
    },
    /** 幂等迁移：按版本顺序执行，已应用的跳过。 */
    async migrate() {
      let applied = new Set();
      let exists = false;
      try {
        const probe = await store.query("select 1 from information_schema.tables where table_schema = 'public' and table_name = 'schema_migrations'");
        exists = probe.rows.length > 0;
      } catch { exists = false; }
      if (exists) {
        applied = new Set((await store.query("select version from schema_migrations")).rows.map(row => Number(row.version)));
      } else {
        // 第一次启动：迁移表还不存在，建表后再读。
        await store.query("create table if not exists schema_migrations (version integer primary key, applied_at timestamptz not null)");
      }
      const done = [];
      for (const migration of MIGRATIONS) {
        if (applied.has(migration.version)) continue;
        await store.transaction(async tx => {
          for (const statement of migration.statements) await tx.query(statement);
          await tx.query("insert into schema_migrations (version, applied_at) values ($1, $2)", [migration.version, now().toISOString()]);
        });
        done.push(migration.version);
      }
      return done;
    },
    async close() {
      if (owned) await client.end().catch(() => {});
    },
    async healthy() {
      try {
        await store.query("select 1");
        return true;
      } catch {
        return false;
      }
    },
  };
  return store;
}

/** 结果行到应用字段的常见换算（pg 返回 Date，应用统一用 ISO 字符串）。 */
export function iso(value) {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString();
  return String(value);
}