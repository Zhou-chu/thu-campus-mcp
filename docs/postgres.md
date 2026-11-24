# PostgreSQL 存储与备份

实例把账号、会话、消息、定时任务、设置、课表覆盖层、统一账号密文、模型提供商与 GitLab 配置写入 PostgreSQL。没有配置 `DATABASE_URL` 时仍退回本机 JSON/DPAPI 文件，行为与升级前一致。

## 连接

```powershell
$env:DATABASE_URL = 'postgres://postgres@127.0.0.1:5434/postgres'
node bin/thu-campus.mjs app serve
```

启动时自动执行 `schema_migrations` 中的迁移（当前 v1–v4），可重复执行；迁移只新增表/索引/列，不删旧数据。启动失败会在日志里给出 `APP_DATABASE_FAILED`，先确认数据库可连接。

## 加密密钥

服务端密文（统一账号、模型提供商密钥、GitLab 令牌）使用 AES-256-GCM，密钥来自：

- `THU_CAMPUS_CREDENTIAL_KEY`（32 字节 base64，优先级最高），或
- 状态目录下的 `credential.key`（首次写入时自动生成，权限 600）。

**换机器或重装时必须同时迁移 `credential.key`（或设置同一个环境变量）**；只搬数据库会无法解密旧密文。本机 `account.dpapi` 只是服务包读取的缓存，登录时会从库里回写。

## 备份

```powershell
# 自定义格式，单文件、可压缩、可选择性恢复
& 'D:\code\thu-campus-mcp\.local\pgsql\pgsql\bin\pg_dump.exe' -h 127.0.0.1 -p 5434 -U postgres -Fc -f .local\backup\campus-$(Get-Date -Format yyyyMMdd-HHmm).dump postgres
```

备份内容不含 `credential.key`；两者要分开保存、同批次恢复。不要用 `pg_dump` 输出覆盖正在使用的数据目录。

## 恢复

```powershell
# 停掉应用，避免写入
& '...\pg_restore.exe' -h 127.0.0.1 -p 5434 -U postgres --clean --if-exists -d postgres .local\backup\campus-20261124-0200.dump
```

恢复后启动应用，检查 `/api/auth/config`、登录与 `/api/sessions`。旧版本数据用随仓库发布的导入入口：

```powershell
node scripts/import-local.mjs --help
node scripts/import-local.mjs --state-dir <旧状态目录> --email <账号邮箱>
```

需要 `DATABASE_URL` 或 `--database-url`；账号必须已经注册。只导入 `settings.json`、`sessions/*.json`、`schedules.json`，源目录不改动；重复执行幂等，导入中断后重跑会补齐缺失消息而不是整条跳过。DPAPI 凭据需单独在本机解密后重新配置。

## 迁移与回滚

- 迁移在启动时自动执行，失败时进程退出且不改旧文件。
- 回滚：停应用、恢复备份的数据库文件、把 `DATABASE_URL` 留空可临时回到文件存储；文件存储中的旧数据仍在原状态目录，未被删除。
- 生产数据目录默认 `.local/pgdata-real`（Windows 便携版 PostgreSQL 16.4，端口 5434），随登录启动脚本 `thu-campus-postgres.cmd` 拉起。