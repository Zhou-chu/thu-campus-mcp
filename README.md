# 清华校园 MCP · 独立浏览器与独立 Agent 应用

[![CI](https://github.com/Zhou-chu/thu-campus-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/Zhou-chu/thu-campus-mcp/actions/workflows/ci.yml)

在 Claude Code、Codex、Antigravity 或 DeepSeek Harness 中，用自然语言操作**网络学堂、清华云盘、荷塘雨课堂、MadModel**。配置一个 `thu-campus` MCP，即可使用 47 个校园工具、4 个浏览器工具和 2 个 MadModel 工具，共 **53 个工具**（原工具名称保留）。

项目内置独立的 Chromium 运行时管理和持久浏览器工作区。首次完成本机登录后，后续启动复用 Cookie、localStorage 与 IndexedDB；API 会话过期时，统一入口优先尝试从已绑定的浏览器恢复同一账号。**默认不依赖 Edge、Chrome 或额外 Electron 程序。**

程序可以移动、复制和升级；登录资料按 Windows 用户独立保存。每位新使用者需要完成自己的首次学校登录。学校撤销会话、要求验证码/多因素认证时，仍须在本机浏览器正常完成验证。

## 独立应用：不接 Harness 也能用

除 MCP 形态外，项目自带一个**本地 Agent 应用运行时**，把同样的 53 个工具、同一个持久浏览器和 MadModel 模型通道包装成独立应用：

```powershell
node bin/thu-campus.mjs app serve            # 默认 http://127.0.0.1:8971
```

| 形态 | 入口 | 说明 |
| --- | --- | --- |
| WebUI | `app serve` 后打开页面 | 自带对话、会话、服务、工具、设置五个界面，可安装为 PWA |
| Windows 桌面 | `desktop\thu-campus-desktop.cmd` | 启动运行时并用包内 Chromium 以应用窗口打开，不引入 Electron |
| Android | `mobile/android` | WebView 瘦客户端，配对后共享同一份登录态 |
| HarmonyOS | `mobile/harmony` | ArkWeb 瘦客户端，同上 |

**一键联通**：在电脑上用清华账号登录一次（`campus_browser_login` 或 MadModel 登录），运行时打印一次性 6 位配对码；手机、平板、另一台电脑输码配对后共享同一份会话。设备令牌只存 sha256 摘要 + DPAPI 加密，可随时在「设置」里吊销。

**模型自主闭环**：对话默认走 MadModel（清华统一认证直连，`app serve` 内置模型路由），不需要外部模型 API Key；`THU_CAMPUS_APP_MODEL_ROUTE=openai` 时才改接任意 OpenAI 兼容端点。

运行时的 HTTP/SSE 契约见 [设计契约](docs/superpowers/specs/2026-11-11-campus-agent-app.md)，实施计划见 [实施计划](docs/superpowers/plans/2026-11-11-campus-agent-app.md)。

默认只监听本机。想在任意网络下用手机接入时，见 [托管部署](docs/app-hosting.md)：`THU_CAMPUS_APP_ALLOW_REMOTE=1` + `PUBLIC_URL`，推荐让 Nginx/Caddy 终止 TLS（`proxy_buffering off` 是必须的）。

```powershell
node bin/thu-campus.mjs app status           # 脱敏状态，不联网
node bin/thu-campus.mjs app devices          # 已配对设备
node bin/thu-campus.mjs app invite           # 设置固定令牌后可在运行中生成配对码
npm run app:smoke                            # 真实启动运行时跑一遍配对与工具调用
npm run verify:clients                       # 核对四端：静态资源、启动器、APK/HAP 结构与大小
```

## 能做什么

| 模块       | 工具数 | 功能                                                                            |
| ---------- | -----: | ------------------------------------------------------------------------------- |
| 网络学堂   |     13 | 学期和课程查询；公告、作业、文件等专栏增量归档；查询及提交个人在线作业          |
| 清华云盘   |     15 | 资料库、目录、搜索、读写文件、移动复制、分享与单向增量传输                      |
| 荷塘雨课堂 |     19 | 课程与课堂、限定范围自动进入、题目预览、预设答案定时提交、课件/PDF/回放下载及云盘归档 |
| 独立浏览器 |      4 | 查看状态、打开窗口、登录/复用登录、关闭并保留会话                               |
| MadModel   |      2 | 登录状态与模型目录；另提供自动续登的 OpenAI 兼容 HTTP 服务                       |

解题由当前 Harness 的模型完成，不另外索要模型 API Key。已有课程、作业和文件内容都作为外部数据处理，不作为额外操作授权。覆盖已有提交或云盘文件仍需明确授权。

### MadModel 模型服务

复用同一独立 Chromium 和清华统一认证，不需要向 MCP 或下游提供学校密码、Cookie 或令牌。

```powershell
node bin/thu-campus.mjs madmodel login
node bin/thu-campus.mjs madmodel serve
# 或后台启动：
.\tools\madmodel-service.cmd start
```

下游 Base URL 为 `http://127.0.0.1:8765/v1`，支持 `/models` 和 `/chat/completions` 的 JSON/SSE。默认每 5 分钟在线检查登录，在令牌到期前 15 分钟续登；启动后立即检查。设置 `MADMODEL_API_KEY` 可为下游启用独立鉴权，非回环监听时必须设置。详见 [MadModel 接入说明](docs/madmodel.md)。已安装的统一 MCP 重载即可出现新工具，无需重新运行安装器。

## 推荐安装：Windows 便携包

支持 **Windows x64**。在本私有仓库的 [Actions](https://github.com/Zhou-chu/thu-campus-mcp/actions/workflows/ci.yml) 中，选择最新成功运行，下载产物 **`thu-campus-mcp-windows-x64`**；解开 Actions 外层 ZIP，再解开其中的 `thu-campus-mcp-windows-x64.zip`。

便携包包含：Node.js、生产依赖、已构建的三个服务、统一入口和独立 Chromium。无需另外安装 Node、npm 或系统浏览器。包内没有任何使用者的账号、Cookie、下载资料或浏览器配置。

1. 解压到一个准备长期保留的目录，例如 `D:\Tools\thu-campus-mcp`。
2. 在该目录运行 `install-clients.cmd`，备份并写入本机客户端配置。
3. 重载客户端的 MCP 或新建会话，确认出现 `thu-campus`。
4. 首次使用时，按下面“首次登录”操作，在弹出的独立浏览器中完成学校登录。

目录不要求固定为示例路径。初始化完成后，平时直接使用客户端，无须再运行安装脚本。Chromium 是完整浏览器内核，首次下载约 200 MiB；三个服务共用一份内核和一套浏览器工作区。

### 源码安装

需要 Windows、Node.js 22/24 和 npm。所有依赖统一在仓库根目录安装：

```powershell
git clone https://github.com/Zhou-chu/thu-campus-mcp.git
cd thu-campus-mcp
npm run setup
node bin/thu-campus.mjs install --unified --apply
```

`setup` 依次完成 `npm ci`、构建、下载固定版本的独立浏览器。内核放在项目的 `.runtime/browsers`，不进入 Git。下载失败可再次执行：

```powershell
node bin/thu-campus.mjs browser install
```

下载使用 Playwright 官方发行源，版本与锁定的 Playwright 配套。网络需要代理时，在当前终端设置 `HTTPS_PROXY` 后重新下载，例如 `$env:HTTPS_PROXY='http://127.0.0.1:7890'`。这只影响当前终端；端口按自己的代理配置填写。安装完成后使用浏览器不再需要下载内核。

## 一次 MCP 配置

推荐使用安装器，它同时支持 Claude Code、Codex、Antigravity 新旧配置及已安装的 DeepSeek Harness。安装前可先预览：

```powershell
node bin/thu-campus.mjs install --unified
node bin/thu-campus.mjs install --unified --apply
```

安装器保留现有认证目录和下载目录，备份配置，保留其他 MCP。属于当前整合包的 `learnx`、`thu-cloud`、`hetang` 三项注册会合并为一项 `thu-campus`；原来的 46 个工具名保持不变。遇到其他来源的同名服务、禁用状态或不兼容的单独工具策略时会停止，不自动改变策略。写入逐文件处理，磁盘故障或并发编辑时依据输出及备份检查已处理文件。

| 客户端             | 默认配置位置                                                                                    |
| ------------------ | ----------------------------------------------------------------------------------------------- |
| Claude Code        | `~/.claude.json`                                                                                |
| Codex              | `~/.codex/config.toml`                                                                          |
| Antigravity        | `~/.gemini/config/mcp_config.json`                                                              |
| Antigravity 旧 IDE | 已存在时同时更新 `~/.gemini/antigravity/mcp_config.json`                                        |
| DeepSeek Harness   | `$DSH_HOME/@wingsky-1/dsh-mcp-manager/mcp.json`；默认探测 `D:/DeepSeekHarness/home` 或 `~/.dsh` |

也可以复制一个 stdio 配置。便携包示例：

```json
{
  "mcpServers": {
    "thu-campus": {
      "command": "D:\\Tools\\thu-campus-mcp\\.runtime\\node.exe",
      "args": ["D:\\Tools\\thu-campus-mcp\\bin\\thu-campus.mjs", "serve"]
    }
  }
}
```

源码安装时将 `command` 改为本机 Node 路径。使用 `node bin/thu-campus.mjs config --unified` 可以生成当前机器的实际 JSON；Codex 使用对应的 `[mcp_servers.thu-campus]` TOML 表。不要配置远程调试端口，不需要另设浏览器服务端口。

## 首次登录

可以直接对 Harness 说：

> 打开独立浏览器，为我登录网络学堂。我的学号是……。不要让我把密码或 Cookie 发到聊天中。

Harness 调用 `campus_browser_login` 后立即得到后台任务 ID。你在本机窗口完成密码、扫码、学校选择或多因素验证；工具在线验证成功后保存 MCP 会话并关闭窗口。用 `campus_browser_status` 查看任务是否 `complete`；MCP 对话连接中断不会关闭后台登录窗口。

首次网络学堂需要一个学号作为本地账号绑定；已有绑定时可省略。雨课堂和云盘的账号由服务器验证结果取得。也可在终端操作：

```powershell
# 源码安装使用 node；便携包可将 node 换成 .\.runtime\node.exe
node bin/thu-campus.mjs browser login learnx --account 你的学号
node bin/thu-campus.mjs browser login cloud
node bin/thu-campus.mjs browser login hetang
node bin/thu-campus.mjs browser status
```

已有三个 API 登录状态的老用户无需删除或搬运认证文件。网络学堂与雨课堂会尝试把自己已有的 Cookie 带入空的独立浏览器工作区，减少重新验证；是否能直接恢复取决于学校会话是否仍有效。首次迁移完成一次浏览器登录后，后续使用相同工作区。

### 日常登录复用

网络学堂会在会话过期后依次点击“重新登录”和学校统一认证入口，并等待独立浏览器自动填充已保存的账号与密码。MCP 只检查输入框是否已填入，不读取或另存密码；统一认证页每次恢复最多提交 2 次，出现验证码则交给本人完成。用环境变量 `THU_CAMPUS_AUTOFILL_LOGIN=0` 可关闭此流程。无界面恢复最多等待 45 秒，仅重试只读请求；写入操作不会自动重投。学校可随时要求重新验证，浏览器的密码保存依赖当前系统用户，不能直接跨电脑复制原生加密文件。

统一入口会按以下顺序处理：

1. 优先直接使用已保存的服务会话，正常调用不启动浏览器。
2. **只读操作**返回认证过期，且已有相匹配的浏览器绑定时，短暂启动无界面 Chromium，尝试恢复同一账号。
3. 恢复成功后，仅重试该只读操作一次；失败则返回登录要求，使用 `campus_browser_login` 重新打开窗口。

自动恢复不会跨账号替换认证，不会在已注销的空认证存储中重新登录，也不会重发提交作业、答题、上传、分享等写入请求。`unknown` 仍须查询原操作回执。浏览器正在被另一个窗口使用时，先关闭该窗口再执行登录/恢复。

## 浏览器窗口与会话管理

| MCP 工具                | 用途                                                         |
| ----------------------- | ------------------------------------------------------------ |
| `campus_browser_status` | 内核、资料目录、占用情况、最近后台任务及错误代码；不返回凭据 |
| `campus_browser_open`   | 打开一个或全部校园站点，复用独立工作区；返回任务 ID          |
| `campus_browser_login`  | 登录指定服务并验证、写入对应 MCP 会话；返回任务 ID           |
| `campus_browser_close`  | 请求关闭工具打开的窗口并保留资料；不注销学校账号             |

`open` 用于查看网页；需要把网页登录同步到 MCP 时用 `login`。同一工作区一次只允许一个浏览器进程，多个 Harness 共用它。已有 `open` 窗口时，先 `close`，等状态不再占用，再 `login`。后台任务显示 `downloading` 时正在准备内核。

```powershell
node bin/thu-campus.mjs browser open all
node bin/thu-campus.mjs browser close
node bin/thu-campus.mjs browser status
```

关闭窗口、退出客户端或升级代码都不会主动删除浏览器资料。建议用 `campus_browser_close` / `browser close` 关闭，它会先保存最新的会话快照。直接点击窗口关闭按钮或强制结束浏览器时，原生资料仍保留，但最近的会话型 Cookie 可能来不及保存；此时暂停自动恢复，使用 `browser login` 正常验证。旧快照不会覆盖原生浏览器中更新的 Cookie、localStorage 或 IndexedDB。Cookie、localStorage、IndexedDB 保存在持久工作区，并有当前 Windows 用户 DPAPI 保护的额外状态快照；原生 Chromium 资料目录按浏览器自身格式保存，不应共享。

### 退出与切换账号

`browser close` 只是关闭窗口。彻底退出 MCP 会话，分别执行：

```powershell
node bin/thu-campus.mjs learnx auth logout
node bin/thu-campus.mjs cloud auth logout
node bin/thu-campus.mjs hetang auth logout
```

需要清除浏览器里的 SSO、Cookie 和本机浏览器绑定时，先关闭窗口，再执行：

```powershell
node bin/thu-campus.mjs browser reset --confirm
```

`reset` 仅清理本工具管理的浏览器工作区，不删除课程资料和三个服务的 API 认证存储；要完全换账号，应同时执行对应的 `auth logout`，然后重新登录。注销/切换账号后，已启动任务不能把旧认证恢复回来。

## 自然语言使用示例

- “把本学期网络学堂课程更新到 `D:\网络学堂`，每门课程按公告、作业、文件等专栏分类，报告不完整内容。”
- “列出尚未提交的作业和截止时间，把我指定的文件提交到指定作业。”
- “监控我指定的雨课堂课程并自动进入，用当前模型读取已发布题目、解题、提交和核对回执。”
- “把选定课堂的课件下载到 `D:\荷塘雨课堂`，生成 PDF，并归档到清华云盘的‘荷塘雨课堂’文件夹。”

持续读取新题并解题要求当前 Harness 保持运行；已经通过 `rain_schedule_answer` 登记的固定答案由独立后台任务执行，关闭 Harness 后仍可等待发布和提交。后台监控不另行调用模型。监控需要课程/课堂范围，最长 8 小时。不补投已关闭题目，不能保证任意题目答对。实时课堂资源仅包含老师当前已发布页面的快照，不代表整堂课已结束或包含后续题目；课后汇总尚未就绪时会明确报错。 `rain_questions` 与 `rain_question_image` 可显式传入 `includeUnpublished: true`，预览当前学生端已下发课件内的未发布题目/投票及原图；返回发布标记，不返回未发布题的答案。未下发的课件不在范围内，提交接口仍拒绝未发布题。多份课件切换时，历史习题的完整性仍需额外现场验证。课件归档只上传本服务登记清单内校验过的文件，默认不覆盖，不自动选共享资料库兜底。

## 可迁移性、升级和资料位置

| 内容                         | 默认位置                    | 迁移说明                                                   |
| ---------------------------- | --------------------------- | ---------------------------------------------------------- |
| 代码、Node、依赖、浏览器内核 | 安装目录；内核在 `.runtime` | 便携包可整目录复制；路径变化后更新这一项 MCP 配置          |
| 持久浏览器和额外加密快照     | `~/.thu-campus-mcp/browser` | 同一 Windows 用户升级/换安装目录时继续使用；不要随程序分发 |
| 网络学堂会话                 | `~/.learnx-mcp`             | 保留原目录                                                 |
| 云盘会话                     | `~/.thu-cloud-mcp`          | 保留原目录                                                 |
| 雨课堂会话                   | `~/.hetang-mcp`             | 保留原目录                                                 |
| 下载资料                     | 各模块配置的输出目录        | 安装迁移保留已有配置；升级前不要覆盖个人输出目录           |

升级便携包时，关闭独立浏览器，解压新版到新目录，再运行新版 `install-clients.cmd` 或更新配置里的程序路径。已有注册指向另一安装目录时，安装器会保护它并报告冲突，可在旧目录执行 `uninstall --unified --apply` 后安装新版。源码升级使用 `git pull`、`npm ci`、`npm run build`、`browser install`；浏览器版本按锁文件更新，用户资料目录保留。

可用 `THU_BROWSER_STATE_DIR` 自定义浏览器资料目录，用 `THU_BROWSER_RUNTIME_DIR` 自定义内核目录。默认内核路径相对安装目录解析，移动项目不需要保留原电脑的绝对路径。`LEARNX_STATE_DIR`、`THU_CLOUD_STATE_DIR`、`HETANG_STATE_DIR` 及相应 `*_OUTPUT_DIR` 继续有效。自定义路径应选择自己的私有目录。

DPAPI 绑定 Windows 用户，不能把加密快照直接复制给另一台机器或另一个人当作登录凭据。其他人使用同一程序包时，登录自己的账号一次，之后保留自己的工作区。服务器撤销会话或学校要求重新验证时，程序无法承诺永久免验证。

## 预先解题，发布后随机等待20–40秒提交

可以直接对四个客户端中的任一个说：

> 在我授权的这节课中，读取当前课件的未发布题及原图。先解答我指定的第53页题目，再登记预设答案：老师发布后随机等待20–40秒提交一次。告诉我任务ID和最终回执；题目变化或错过窗口就停止，不要重投。

页码用于帮助模型找到题目，登记始终使用平台返回的 `lessonId`、`questionId`，不能猜测ID。

1. 查询 `rain_active_classrooms`，确认范围并使用 `rain_join_classroom` 进入课堂。
2. 调用 `rain_questions({lessonId, includeUnpublished:true})`，必要时调用 `rain_question_image({lessonId, questionId, includeUnpublished:true})`。只预览学生端已经下发的课件；模型根据题干、选项和原图解答，不读取隐藏答案。
3. 保存解题所依据的 `questionFingerprint`，调用 `rain_schedule_answer`。指纹绑定账号、登录代次和题目内容（含原图URL路径，忽略临时签名）；题目或图片已变更时重新读取并解题，不能把旧答案配上新指纹。
4. 保存返回的任务 `id`，使用 `rain_job_status({jobId:id})` 查询；`rain_wait_events` 可增量取事件，`rain_stop_job` 可请求取消。

工具参数示例（ID和指纹必须替换为读取结果）：

```json
{
  "lessonId": "平台返回的课堂ID",
  "questionId": "平台返回的题目ID",
  "questionFingerprint": "读取题目或原图返回的64位十六进制指纹",
  "answer": ["B"],
  "durationMinutes": 120,
  "requestId": "调用方生成并保存的UUID"
}
```

`durationMinutes` 默认120，范围1–480，从登记开始计时。`requestId` 可省略；传入后相同请求复用同一任务，不覆盖既有任务。单选、多选和投票使用选项字母数组，填空使用字符串数组，主观题使用 `{"content":"解答文本"}`。不同预设答案不能覆盖正在等待的任务，需先取消。返回的 **`id` 是后台任务ID**，**`submissionRequestId` 是独立答题操作ID**，后者用于 `rain_operation_status({id:submissionRequestId})`；发布前可能尚无该操作记录。

| `result.phase` / 状态 | 含义及处理 |
| --- | --- |
| `waiting-publication` | 已保存固定答案，等待该题发布；不会提前提交 |
| `scheduled` | 已选定并持久保存随机目标，`window` 含发布时间、目标、最晚派发时间；重连不重新抽签 |
| `submitting` | 派发意图已落盘；取消不能保证撤回 |
| `submitted` | 一次派发且同一答案回读确认；`dispatchElapsedMs` 是相对平台发布时间的本机派发毫秒数，并非服务器收件耗时 |
| `cancelled` / `expired` / `classroom-ended` / `already-answered` | 取消、任务到期、课堂结束或已有答题，不再提交 |
| `question-changed` / `publication-changed` / `publication-time-unavailable` / `missed-window` | 题目或发布时间变化、无可信平台时间、关闭过早或错过窗口；说明原因并停止 |
| `unknown` / 顶层 `interrupted` | 结果未确认或进程中断。只查原任务、回执及题目，不自动恢复或重新登记来补投 |

随机时间取**平台发布后20秒至40秒之前**与题目截止、任务到期的有效交集；晚发现时只在剩余交集中选择一次，没有交集就跳过。WebSocket 实时事件配合只读轮询，重复事件不重置计时。派发前再次检查账号、题目、课堂、取消标记和截止；耗时过长或电脑休眠后错过窗口不会补交。最终同步时间检查位于网络请求前，正文 `dt` 使用真实派发时间。

电脑必须保持运行、时钟准确、网络和学校会话有效。此任务不依赖 Codex heartbeat，不需要额外模型Key；它只执行登记的固定答案，不在后台生成新答案，也不保证答案正确。关闭客户端可以继续执行；退出系统、重启、结束 Node 进程会中断任务，程序不自动恢复可能已派发的写入。取消返回 `mayHaveDispatched:false` 表示取消先于派发意图；`true` 表示可能已派发，应查看原回执，不能视为撤回成功。

预设答案保存在当前 Windows 用户 DPAPI 保护的雨课堂状态目录；通用任务JSON不存题干、答案和登录凭据。不要把个人状态目录加入 Git 或分发给其他人。若平台原地替换同一路径的图片字节，URL指纹无法单独识别这种变化。本版端到端测试使用模拟题验证真实20–40秒计时，不自动在真实课堂试投答案。

## 常见问题

| 现象 / 错误                                    | 处理                                                              |
| ---------------------------------------------- | ----------------------------------------------------------------- |
| `BROWSER_NOT_INSTALLED`                        | 源码安装运行 `browser install`；便携包检查是否完整解压 `.runtime` |
| 下载失败                                       | 检查网络/代理后重试；可直接使用带内核的便携包                     |
| `BROWSER_BUSY` / `requiresClose`               | 关闭现有独立窗口，或请求 `campus_browser_close`，等任务停止后重试 |
| `AUTH_REQUIRED` / `BROWSER_LOGIN_REQUIRED`     | 请求 `campus_browser_login`，在本机窗口完成验证                   |
| `BROWSER_ACCOUNT_MISMATCH`                     | 浏览器与 MCP 账号不一致，先按账号切换流程处理                     |
| `AUTH_CHANGED`                                 | 登录期间发生注销/切换，旧登录未保存；按当前账号重新操作           |
| `INSTALL_CONFLICT` / `INSTALL_POLICY_CONFLICT` | 检查旧路径或服务策略，不手动删除其他 MCP；可继续使用分服务模式    |
| 工具未出现                                     | 重载 MCP 或新建客户端会话；检查 `thu-campus` 的路径和启用状态     |

不需要增加“保持在线”定时请求，不模拟学习时长或伪造验证码。与身份验证有关的输入仅在本机终端/浏览器处理，README、日志和 CI 产物中均不应包含登录资料。

## 开源来源与开发

[开源来源和许可总表](THIRD_PARTY_NOTICES.md) 区分实际分发代码、npm 运行依赖和仅作协议参考的项目；[精确依赖清单](docs/DEPENDENCIES.md) 与根锁文件对应。网络学堂包含 MIT 的 thu-learn-lib；云盘和雨课堂为独立协议适配。便携包另附匹配 Node.js 的 LICENSE 与浏览器的第三方许可页面。

```powershell
npm run check           # 类型、构建、单测、依赖许可和来源/密钥审计
npm run smoke           # 三个服务、统一入口、真实独立 Chromium 持久化测试
npm run bundle          # 仅源代码 ZIP
npm run bundle:prepared # Windows 便携 ZIP；需先构建并安装内核
```

CI 在 Windows Node 22/24 上检查，不使用学校账号，不进入真实课堂、不提交真实作业、不写真实云盘。独立浏览器的 Cookie、localStorage、IndexedDB 关闭重开测试使用本地模拟站点。真实雨课堂进入/答题仍受活跃课堂与授权范围限制；回放和附件以平台返回为准。详情见 [验证说明](docs/VERIFICATION.md)。

兼容分服务模式：不加 `--unified` 的 `install` / `config` 仍保留原有三个注册；模块命令 `learnx`、`cloud`、`hetang` 仍可单独调用。统一入口才提供集中浏览器工具及自动恢复。原工具参考见 [TOOLS.md](docs/TOOLS.md)。

浏览器持久化机制使用 Playwright 的 [Persistent Context](https://playwright.dev/docs/api/class-browsertype#browser-type-launch-persistent-context) 和 [Storage State](https://playwright.dev/docs/api/class-browsercontext#browser-context-storage-state)；独立内核由其[官方浏览器安装器](https://playwright.dev/docs/browsers)准备。


