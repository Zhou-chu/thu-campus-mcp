# 清华校园独立 Agent 应用 · 设计契约

日期：2026-11-11　状态：冻结（并行开发基线）

## 1. 目标

在现有 `thu-campus-mcp`（51 个校园 MCP 工具 + madmodel 模型服务）之上增加一层**本地 Agent App Runtime**，让同一套能力以四种形态发布：

| 形态 | 入口 | 说明 |
| --- | --- | --- |
| WebUI | `thu-campus app` → 浏览器打开 `http://127.0.0.1:8971` | 自带静态前端，无需联网、无构建步骤 |
| Windows 桌面 | `desktop/thu-campus-desktop.cmd` | 启动运行时并复用包内 Chromium 以应用窗口打开，不引入 Electron |
| Android APP | `mobile/android` | WebView 外壳 + 局域网配对 |
| HarmonyOS APP | `mobile/harmony` | ArkWeb 外壳 + 局域网配对 |

**一键联通**：用户在主机上用自己的清华账号完成一次登录（复用既有 `campus_browser_login` 与 madmodel SSO），运行时生成一次性配对码；各客户端扫码/输码后获得设备令牌，共享同一份校园登录态与模型通道。

**模型自主闭环**：模型默认走 madmodel（清华统一认证直连，`lib/madmodel/*`），不强制要求外部模型 API Key；`openai-compatible` 外部路由为可选覆盖。

## 2. 非目标

- 不在 Android/HarmonyOS 内重写校园协议。校园服务依赖 Node 运行时与 Playwright 持久浏览器，四端统一作为运行时的**前端**。
- 不引入 Electron / Tauri / 前端框架 / 打包器。WebUI 是纯静态文件，桌面窗口复用已锁定的 Chromium。
- 不实现 `/v1/responses`、音频、嵌入、图片生成端点；不托管第三方账号。
- 不自动注册开机自启、不上传任何数据到项目方服务器。

## 3. 进程模型

单个 `node bin/thu-campus.mjs app serve` 进程内：

```
Runtime
├── ToolHost        spawn learnx/cloud/hetang 的 stdio MCP 子进程（复用 lib/services.mjs）
├── ModelRoute      madmodel（默认）| openai-compatible（可选覆盖）
├── AgentLoop       tool-calling 循环，SSE 输出
├── SessionStore    ~/.thu-campus-mcp/app/sessions/*.json
├── PairingStore    ~/.thu-campus-mcp/app/devices.json（DPAPI 加密）
└── HttpServer      /api/* + 静态 WebUI + SSE
```

端口默认 `8971`（madmodel 服务占 `8765`）。状态目录 `~/.thu-campus-mcp/app`。

## 4. 命令

```powershell
node bin/thu-campus.mjs app serve [--port 8971] [--host 127.0.0.1] [--open]
node bin/thu-campus.mjs app invite            # 生成配对码与局域网地址
node bin/thu-campus.mjs app devices [--revoke <id>]
node bin/thu-campus.mjs app status            # 脱敏状态，不联网
```

环境变量：

| 变量 | 默认 | 作用 |
| --- | --- | --- |
| `THU_CAMPUS_APP_PORT` | `8971` | HTTP 端口 |
| `THU_CAMPUS_APP_HOST` | `127.0.0.1` | 监听地址；非回环必须显式授权（见 §10） |
| `THU_CAMPUS_APP_STATE_DIR` | `~/.thu-campus-mcp/app` | 会话/设备/设置 |
| `THU_CAMPUS_APP_TOKEN` | 空 | 固定设备令牌，设置后禁用配对流程 |
| `THU_CAMPUS_APP_MODEL_ROUTE` | `madmodel` | `madmodel` 或 `openai` |
| `THU_CAMPUS_APP_MODEL_BASE_URL` | 空 | `openai` 路由的 Base URL |
| `THU_CAMPUS_APP_MODEL_API_KEY` | 空 | `openai` 路由的密钥 |
| `THU_CAMPUS_APP_MODEL_NAME` | 自动 | 首选模型名 |
| `THU_CAMPUS_APP_MAX_STEPS` | `12` | 单轮 agent 最大工具步数 |

## 5. HTTP API（冻结）

除标注外均需 `Authorization: Bearer <device-token>`。所有响应 `Content-Type: application/json; charset=utf-8`，且带 `Cache-Control: no-store`。失败统一为：

```json
{ "ok": false, "error": { "code": "AUTH_REQUIRED", "message": "人类可读的中文说明" } }
```

成功统一为 `{ "ok": true, ...payload }`。

| 方法 | 路径 | 认证 | 说明 |
| --- | --- | --- | --- |
| GET | `/healthz` | 否 | `{ ok, version, uptimeMs }` |
| GET | `/api/meta` | 是 | 版本、主机名、账号绑定（脱敏）、模型目录、四服务登录态 |
| POST | `/api/pair/redeem` | 否（凭配对码） | 用配对码换设备令牌 |
| POST | `/api/pair/invite` | 是 | 生成新的一次性配对码 |
| GET | `/api/devices` | 是 | 已配对设备列表（脱敏） |
| DELETE | `/api/devices/:id` | 是 | 吊销设备 |
| GET | `/api/tools` | 是 | 51 个校园工具 + madmodel 工具的名称/描述/JSON Schema |
| POST | `/api/tools/:name` | 是 | 直接调用单个工具，body 即工具参数 |
| GET | `/api/sessions` | 是 | 会话摘要列表 |
| GET | `/api/sessions/:id` | 是 | 单会话完整消息 |
| DELETE | `/api/sessions/:id` | 是 | 删除会话 |
| POST | `/api/chat` | 是 | 发起一轮对话，返回 `text/event-stream` |
| POST | `/api/chat/:id/abort` | 是 | 取消进行中的一轮 |
| GET | `/api/auth/status` | 是 | 各服务登录态与最近任务 |
| POST | `/api/auth/login` | 是 | `{ service }`，后台启动浏览器登录，返回 `{ jobId }` |
| GET | `/api/jobs/:id` | 是 | 后台任务状态 |
| GET | `/api/settings` | 是 | 运行时设置 |
| PUT | `/api/settings` | 是 | 更新设置（白名单字段） |
| GET | `/` 及静态资源 | 否 | WebUI |

### 5.1 `/api/meta` 响应

```json
{
  "ok": true,
  "version": "1.3.0",
  "hostname": "DESKTOP-XXX",
  "account": { "bound": true, "masked": "2023****1234" },
  "model": { "route": "madmodel", "name": "deepseek-v3", "available": true },
  "models": [{ "id": "deepseek-v3", "label": "DeepSeek V3" }],
  "services": {
    "learnx": { "state": "ready" },
    "cloud": { "state": "ready" },
    "hetang": { "state": "login-required" },
    "madmodel": { "state": "ready" }
  },
  "pairing": { "enabled": true, "deviceCount": 2 },
  "lanUrls": ["http://192.168.1.23:8971"]
}
```

`services.*.state` 取值：`ready` | `login-required` | `expired` | `unknown`。不得返回 Cookie、Token、密码、登录 ticket。

### 5.2 `POST /api/chat` 请求

```json
{ "sessionId": "可选，缺省新建", "text": "把本学期课程更新到 D:\\网络学堂", "model": "可选" }
```

### 5.3 SSE 事件（冻结）

每条 `event: <name>`，`data:` 为单行 JSON。

| event | data | 说明 |
| --- | --- | --- |
| `ready` | `{ sessionId, model }` | 本轮开始 |
| `token` | `{ text }` | 助手文本增量 |
| `reasoning` | `{ text }` | 推理增量（可选） |
| `tool` | `{ phase, name, args?, ok?, result?, error? }` | `phase` 为 `start` / `end` |
| `message` | `{ role, content, toolCalls? }` | 一条完整消息落库 |
| `notice` | `{ code, message }` | 非致命提示（如模型降级） |
| `error` | `{ code, message }` | 本轮失败，随后 `done` |
| `done` | `{ sessionId, steps, usage?, aborted? }` | 本轮结束 |

客户端必须容忍未知事件名并忽略。

## 6. 配对

- 配对码：6 位数字，有效期 5 分钟，一次性。
- `POST /api/pair/redeem` body `{ code, deviceName, platform }`，`platform` ∈ `webui` | `desktop` | `android` | `harmony`。
- 成功返回 `{ ok: true, token, deviceId, baseUrl, meta }`；令牌写入客户端本地安全存储（桌面/移动端）。
- 设备记录只保存 `id`、名称、平台、创建时间、最近使用时间与令牌摘要，不保存明文令牌。
- 吊销即刻生效（内存缓存 + 磁盘一致性）。

## 7. 模型路由

统一接口：

```js
route.models()            // → [{ id, label }]
route.chat({ model, messages, tools, stream, signal })  // → Response
```

- `madmodel`：包装 `MadModelClient`（`lib/madmodel/client.mjs`），SSO 失效时按既有规则续期、仅 401 重试一次。
- `openai`：任意 OpenAI 兼容 Base URL，使用 `THU_CAMPUS_APP_MODEL_API_KEY`。
- 两个路由都只在服务端持有密钥，绝不下发到客户端。

Agent 循环：`system prompt → 用户消息 → 模型（带 tools）→ 若 tool_calls 则执行并回填 → 重复`，最多 `MAX_STEPS` 步，超限以 `notice` 提示并输出当前结果。工具执行失败作为 `role: "tool"` 的结果返回给模型，不中断循环；只有模型调用失败才 `error`。

## 8. 写作用域（并行开发防冲突）

| 目录/文件 | 归属 |
| --- | --- |
| `lib/app/**`、`bin/thu-campus.mjs`、`package.json`、`.gitignore`、`test/app-*.test.mjs`、`docs/**`、`scripts/app-*.mjs` | Lead（`feat/app-core`） |
| `webui/**` | `feat/app-webui` |
| `desktop/**` | `feat/app-desktop` |
| `mobile/**` | `feat/app-mobile` |

各分支**只允许**改动自己那一行对应的目录；需要共享文件改动时向 Lead 报告，不自行修改。

## 9. 各端验收

| 端 | 必须做到 | 允许的诚实缺口 |
| --- | --- | --- |
| core | `npm test` 全绿；`app serve` 可启动；SSE 全事件覆盖；配对/吊销/令牌校验有测试 | — |
| WebUI | 静态文件、无构建步骤；移动优先响应式；配对页、对话页（流式 token + 工具卡片）、服务状态、工具面板；PWA manifest + service worker | 不使用框架 |
| 桌面 | `.cmd` 一键启动运行时 + Chromium 应用窗口；单实例；退出即停；无 Electron | 不做出安装器（MSI） |
| Android | 可审的 Gradle 工程：WebView 外壳、配对界面、令牌安全存储、返回键行为、明文 HTTP 内网白名单说明 | 本机无 SDK platforms，无法出 APK，必须如实说明 |
| HarmonyOS | ArkTS Stage 工程：ArkWeb 外壳、配对界面、令牌存储；能本地编译则附构建证据 | 无签名证书则只能出未签名 HAP |

## 10. 安全约束

- 默认只监听回环。监听非回环地址时，必须设置 `THU_CAMPUS_APP_HOST` 且同时要求设备令牌；首次启动在 stdout 打印一次性配对码，不写入日志文件。
- 拒绝浏览器跨站请求：校验 `Origin`，非本机来源且无 Bearer 时返回 403；校验 `Host` 防 DNS rebinding。
- 不返回、不落盘明文令牌与校园凭据；DPAPI 加密沿用 `lib/madmodel/auth.mjs` 的既有机制。
- 工具调用沿用既有权限语义：写入类操作在对话中需用户明确授权；本层不额外放宽。

## 11. 发布物

| 产物 | 生成方式 |
| --- | --- |
| 源码 ZIP | 既有 `npm run bundle` |
| Windows 便携 ZIP | 既有 `npm run bundle:prepared`，新增 `desktop/`、`webui/` |
| Android APK | CI 不产出，文档说明用 Android Studio 构建 |
| HarmonyOS HAP | CI 不产出，文档说明用 DevEco 构建 |