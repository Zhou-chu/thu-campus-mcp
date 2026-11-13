# 真正隔离的代码作业

SandboxRunner只使用Linux Docker容器，无宿主Python/Node回退。运行器不会build、pull或联网安装依赖；缺少Docker/Linux daemon/本地镜像时prepare抛出`SANDBOX_UNAVAILABLE`。

## 镜像准备（管理员显式操作，可联网）

从仓库根目录构建Python科学库镜像：

```powershell
docker build -f sandbox/Dockerfile -t thu-campus-sandbox-python:1.4.0 .
docker pull node:24-bookworm-slim
```

Python镜像基于官方CPython，通过固定版本uv创建`/opt/venv`；直接依赖在requirements.txt固定版本，预装Noto中文字体。无Conda。Node使用独立官方镜像。本地tag只在prepare阶段解析，执行按批准的不可变`sha256:imageId`，即使tag随后变化也不切换镜像。

## 接口与批准

```js
const runner = new SandboxRunner({ files, stateDir: '/private/app-state/sandbox-jobs' });
const args = { runtime: 'python', scriptPath: 'analysis.py', args: [], timeoutSeconds: 120 };
const prepared = await runner.prepare(sessionId, args);
// 完整展示prepared.approvalArgs并取得真实用户批准；不能让模型自行构造approved。
const job = await runner.run(sessionId, args, { prepared, approved: true });
await runner.get(sessionId, job.jobId);
await runner.stop(sessionId, job.jobId);
await runner.stopSession(sessionId); // 删除会话前调用
await runner.close();
```

`prepare`读取完整有效UTF-8，冻结code、sha256、imageId、会话与参数。`run`只接受同实例原对象（不能JSON克隆），批准一次性消费；修改主文件不会改变执行内容。job立即返回，后台执行；`get`根据专用标签核验精确容器后读取真实日志，成功/失败根据容器最终退出状态确认，客户端退出不等于容器停止；stdin错误不允许成功。

每会话挂载root由WorkspaceFiles提供，必须为会话UUID根。只挂该root到`/workspace`。冻结副本写入root唯一隐藏文件用于留档，**真正执行的主脚本通过受控stdin传输，不再读取副本**，避免文件修改与命令行长度限制。Python入口`/opt/venv/bin/python -u -`；Node入口`/usr/local/bin/node --input-type=module -`（`.mjs`）或`--input-type=commonjs -`（`.js/.cjs`）。cwd与主模块相对导入基点均为`/workspace`，`__file__`/主模块标识为stdin而不是原脚本名。工作区依赖/输入文件仍是授权可变数据；不承诺冻结传递依赖。脚本不支持交互stdin。

## 隔离与限制

- `docker create --interactive --pull never`固定隔离配置，取得精确ID后`docker start --attach --interactive`传入冻结代码；所有CLI调用`shell:false`。
- 非root：Windows为65532:65532；Linux使用宿主非0 UID/GID以读取0600文件，Linux宿主root明确不可用，不放宽整个工作区权限。
- 禁网、只读容器根、drop ALL capabilities、no-new-privileges、禁共享IPC。
- 内存与内存+swap均1024MiB，CPU1核，pids128，nofile256，`/tmp`为64MiB有界tmpfs（noexec/nosuid/nodev）。
- OMP/OpenBLAS/MKL/NumExpr固定2线程。仅传明确固定环境值，不注入宿主密钥或环境。
- 默认120秒、最多3600秒；超时/stop/close先核验名称、scope/owner/session/job专用labels及精确ID，然后`docker rm --force <ID>`停止并删除真正容器，再收回附加客户端。
- stdout/stderr各保留前64KiB（可配置至1MiB），超过标记truncated；Docker日志使用local driver，1MiB单文件。
- 单会话挂载为可读写，脚本可修改该会话所有数据。该实现不提供绑定目录磁盘配额；运行大型作业前应由部署方配置宿主磁盘限额。

## 状态与恢复

`stateDir`必须位于会话root之外，永不挂载进容器。每个stateDir仅允许一个活跃runner，由宿主生命周期管理。作业账本原子替换、0600，父目录0700。默认目录为工作区baseDir同级sandbox-jobs，生产应显式传入应用私有目录。

启动首次操作会恢复账本：终态保持，running/cleanupPending只操作经过完整身份核验的精确作业容器并标记interrupted，不猜测成功。daemon不可达或身份不匹配时保留interrupted+待清理状态，绝不操作未知容器；之后可对该job重试stop或由下一实例恢复。不执行全局prune/按前缀批量删除，也不枚举操作无账本容器。

## 范围mock测试

```powershell
node --test --experimental-test-coverage --test-coverage-include=lib/app/sandbox.mjs --test-coverage-lines=90 --test-coverage-branches=90 --test-coverage-functions=90 test/app-sandbox.test.mjs
```

只模拟Docker命令和流，覆盖批准、隔离参数、真实状态/日志、stdin、超时、取消、跨会话拒绝、持久化与重启；不启动真实容器、不接触校园数据。真实隔离验收由Lead另行运行。
