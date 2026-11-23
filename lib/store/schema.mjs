/**
 * PostgreSQL 表结构（迁移版本 1）。
 *
 * 只放与身份、用户数据有关的表；每张表的 id 由应用生成（crypto.randomUUID），
 * 不依赖数据库扩展，pg-mem 测试与真实 PostgreSQL 行为一致。
 */
export const MIGRATIONS = [
  {
    version: 1,
    statements: [
      `create table if not exists users (
         id text primary key,
         email text not null unique,
         password_hash text not null,
         email_verified boolean not null default false,
         created_at timestamptz not null,
         disabled_at timestamptz
       )`,
      `create table if not exists sessions (
         id text primary key,
         user_id text not null references users(id) on delete cascade,
         token_hash text not null unique,
         created_at timestamptz not null,
         expires_at timestamptz not null,
         last_seen_at timestamptz,
         revoked_at timestamptz,
         device_label text,
         platform text
       )`,
      `create index if not exists sessions_user_idx on sessions(user_id)`,
      `create index if not exists sessions_expiry_idx on sessions(expires_at)`,
      `create table if not exists devices (
         id text primary key,
         user_id text not null references users(id) on delete cascade,
         name text not null,
         platform text,
         created_at timestamptz not null,
         last_seen_at timestamptz,
         revoked_at timestamptz
       )`,
      `create index if not exists devices_user_idx on devices(user_id)`,
      `create table if not exists user_settings (
         user_id text not null references users(id) on delete cascade,
         key text not null,
         value jsonb not null,
         updated_at timestamptz not null,
         primary key (user_id, key)
       )`,
      `create table if not exists chat_sessions (
         id text primary key,
         user_id text not null references users(id) on delete cascade,
         title text not null,
         created_at timestamptz not null,
         updated_at timestamptz not null,
         archived boolean not null default false
       )`,
      `create index if not exists chat_sessions_user_idx on chat_sessions(user_id, updated_at)`,
      `create table if not exists chat_messages (
         id text primary key,
         session_id text not null references chat_sessions(id) on delete cascade,
         role text not null,
         content jsonb not null,
         created_at timestamptz not null,
         seq bigint not null
       )`,
      `create index if not exists chat_messages_session_idx on chat_messages(session_id, seq)`,
      `create table if not exists schedules (
         id text primary key,
         user_id text not null references users(id) on delete cascade,
         title text not null,
         prompt text not null,
         kind text not null,
         spec jsonb not null,
         enabled boolean not null default true,
         last_run_at timestamptz,
         last_status text,
         last_error text,
         created_at timestamptz not null,
         updated_at timestamptz not null
       )`,
      `create index if not exists schedules_user_idx on schedules(user_id, updated_at)`,
      `create table if not exists service_credentials (
         user_id text not null references users(id) on delete cascade,
         service text not null,
         ciphertext text not null,
         nonce text not null,
         updated_at timestamptz not null,
         primary key (user_id, service)
       )`,
    ],
  },
];