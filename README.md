# 清华校园 MCP 整合包

[![CI](https://github.com/Zhou-chu/thu-campus-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/Zhou-chu/thu-campus-mcp/actions/workflows/ci.yml)

将网络学堂、清华云盘、荷塘雨课堂放在一个可独立克隆、安装和验证的 npm workspace 仓库中。统一命令入口，保留三个 stdio 服务及各自认证，共 **46 个工具**。适配 Claude Code、Codex、Antigravity 和 DeepSeek Harness；解题由当前 Harness 模型完成，无需额外模型 API Key。

| 服务 | 注册名 / 命令 | 工具数 | 主要能力 |
| --- | --- | --- | --- |
| 网络学堂 | `learnx` | 13 | 本学期课程与专栏同步、查询作业、准备及提交作业 |
| 清华云盘 | `thu-cloud` / `cloud` | 15 | 列库、浏览、搜索、读写文件、移动复制、单向增量传输 |
| 荷塘雨课堂 | `hetang` | 18 | 课程与历史课堂、限定范围自动进入、已发布题目与答题提交、课件与回放下载、云盘归档 |

## 安装与构建

需要 **Windows、Node.js 22 或 24、npm、Microsoft Edge**。真实登录使用 Windows DPAPI，凭据只能由保存它的 Windows 用户解密。CI 在 Windows 两个 Node 版本上运行。

```powershell
git clone https://github.com/Zhou-chu/thu-campus-mcp.git
cd thu-campus-mcp
npm ci
npm run build
node bin/thu-campus.mjs --help
```

这是私有仓库，需要拥有访问权限。无需另外克隆旧项目、安装 Electron 或启动旧项目目录中的程序。根目录只有一份锁文件；不要在子包单独执行 npm install。发行附件 `thu-campus-mcp-source.zip` 同样需要 `npm ci` 和构建。

## 本机登录

按需分别登录，三者使用独立会话。账号和学校选择在本机终端或 Edge 中完成，不向聊天发送 Cookie、密码或 Token。

```powershell
node bin/thu-campus.mjs learnx auth browser
node bin/thu-campus.mjs cloud auth browser
node bin/thu-campus.mjs hetang auth browser

node bin/thu-campus.mjs learnx doctor
node bin/thu-campus.mjs cloud doctor
node bin/thu-campus.mjs hetang doctor
```

默认继续使用 `~/.learnx-mcp`、`~/.thu-cloud-mcp`、`~/.hetang-mcp`。在同一 Windows 用户上可复用已有登录，不会把认证文件复制到仓库。`doctor` 的本地已配置状态不代表在线会话仍有效，可用服务的 status/查询工具验证。另一个 Windows 用户或另一台机器需要重新登录。

## 四客户端配置

```powershell
node bin/thu-campus.mjs install           # 全部服务预览
node bin/thu-campus.mjs install --apply   # 全部预检后，备份并合并
node bin/thu-campus.mjs config            # 导出 JSON 配置示例，不含凭据
```

安装器维护 Claude Code 的 `~/.claude.json`、Codex 的 `~/.codex/config.toml`、Antigravity 的 `~/.gemini/config/mcp_config.json`，并在旧 IDE 配置和 DeepSeek Harness 目录已存在时维护它们。Harness 默认探测 `D:/DeepSeekHarness/home`，可以用 `DSH_HOME` 指定。服务注册名保持 `learnx`、`thu-cloud`、`hetang`，工具名也保持不变。

所有服务先预检；普通配置冲突不会写入任何目标。应用过程逐文件加锁、比对和备份，不是跨文件事务；并发修改或磁盘故障可能需要根据输出检查已处理的文件。已有会话可能需要重载 MCP 或新建会话。

**已有旧仓库注册时**，安装器会报告 `INSTALL_CONFLICT`，保护原配置。本次仓库整合不会自动迁移本机已有注册。决定迁移时，先停止旧的后台任务，在旧仓库运行对应的 `node dist/cli.js uninstall --apply`，再在整合包运行安装命令。不要在卸载后删除原认证目录。三次卸载均只移除各自服务注册，其他 MCP 不变。也可参照 `config` 输出手动修改三项的命令路径。

卸载整合包注册使用 `node bin/thu-campus.mjs uninstall --apply`，只移除属于本整合包路径的三项注册。

## 常见用法

- “把本学期网络学堂课程更新到 `D:\网络学堂`，每门课程按公告、作业、文件等专栏分类，并报告抓取不完整的内容。”
- “列出尚未提交的作业和截止时间；把我指定的文件提交到指定作业。”
- “列出荷塘雨课堂当前课堂，监控我指定的课程并自动进入，用当前模型读取已发布题目、解题、提交和核对回执。”
- “把选定雨课堂的课件下载到 `D:\荷塘雨课堂`，生成 PDF，并归档到清华云盘的‘荷塘雨课堂’文件夹。”

自动答题要求当前 Harness 保持运行并持续调用工具；后台监控不会另行调用模型。自动进入需要指定课程或课堂范围，单次最长 8 小时。平台未发布或已经截止的题不会补投。结果不明的提交保留 `unknown`，查询原回执和服务器状态，不能更换请求 ID 盲目重发。已有作业或文件的覆盖需要明确授权。

雨课堂默认调用包内 `packages/thu-cloud/dist/cli.js`。归档只接收已登记的下载清单，校验文件哈希，并默认选择明确属于个人的可写资料库，在 `/荷塘雨课堂/课程/课堂/` 下保存；不会自动选择共享资料库兜底。云盘不可用时保留本地下载和清单，登录后可继续归档。

## 目录与配置

```text
bin/thu-campus.mjs        统一命令入口
lib/                     命令、配置与安装协调
packages/learnx/         网络学堂，含固定版本 thu-learn-lib
packages/thu-cloud/      云盘 REST MCP
packages/hetang/         雨课堂 MCP，默认连接包内云盘
docs/                    开源来源、依赖清单、源提交与验证记录
test/                    整合入口与搬迁验证
```

| 服务 | 认证目录变量 | 下载目录变量 |
| --- | --- | --- |
| learnx | `LEARNX_STATE_DIR` | `LEARNX_OUTPUT_DIR` |
| cloud | `THU_CLOUD_STATE_DIR` | `THU_CLOUD_OUTPUT_DIR` |
| hetang | `HETANG_STATE_DIR` | `HETANG_OUTPUT_DIR` |

网络学堂和云盘默认下载到各子包的 `downloads`，雨课堂默认 `D:/荷塘雨课堂`。可用 `HETANG_CLOUD_CLI` 显式指定其他兼容云盘构建。`*_MOCK=1` 才启用离线模拟；安装器始终写入真实模式。移动仓库后应重新构建并更新客户端路径，认证默认目录保持不变。

模块行为及限制见：[网络学堂](packages/learnx/README.md)、[云盘](packages/thu-cloud/README.md)、[雨课堂](packages/hetang/README.md)；完整工具及必填参数见 [TOOLS.md](docs/TOOLS.md)。安装及目录以本页为准。

## 开源来源与许可

网络学堂直接依赖并随包包含 MIT 的 [thu-learn-lib](https://github.com/robertying/thu-learn-lib)，版本与 [learnX](https://github.com/robertying/learnX) 对齐。云盘独立实现 Seafile REST；雨课堂独立实现公开课堂协议。没有捆绑来源许可不明或带非商业限制的第三方应用代码。

完整说明见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)，精确 npm 版本和许可见 [DEPENDENCIES.md](docs/DEPENDENCIES.md)。本项目及三个模块保留各自 MIT 许可，第三方依赖遵循各自许可；不能把协议参考项目说成实际运行依赖。

## 开发与 CI

```powershell
npm run check          # 类型、构建、全部单测、许可清单与源代码审计
npm run smoke          # 三个服务独立端到端 + 搬迁后的统一入口
npm run licenses       # 依赖变更后更新清单
npm run bundle         # 打包当前 Git 提交的源代码及 SHA256
```

CI 不使用学校账号，不提交真实作业、不进入真实课堂、不上传真实云盘数据。真实服务曾分别验收过课程同步、个人作业提交及课件/云盘归档；当前没有活跃雨课堂，真实进课堂与答题仍待课堂验证。回放和附件受平台实际返回内容限制，仅有共享文件计数时尚不展开附件。网络学堂讨论/答疑的细节仍标注部分验收。详见 [验证说明](docs/VERIFICATION.md)。
