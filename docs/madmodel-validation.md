# MadModel 验证记录 · 2026-11-10

上游代码已从私有仓库同步至 `855b8a0`，开发分支为 `codex/madmodel-service`。同步前工作区无未提交改动。

## 自动验证

- `npm run check` 通过：类型检查、构建、201 项测试（浏览器 3、雨课堂 59、网络学堂 61、云盘 38、统一入口 40）、206 项依赖许可证清单检查和源码/历史敏感信息审计。
- `npm run smoke` 通过：独立浏览器持久状态与原生关闭恢复、三个校园模块的 stdio/后台任务，以及含中文和空格的迁移路径。
- 28 项 MadModel 测试包含 JWT 元数据、动态模型目录、请求验证、DPAPI CAS、账号绑定、并发登录、注销竞态、提前续期、失败退避、迟到 401、force 与普通校验交错、JSON/SSE、下游断线取消、鉴权、跨站/Host 检查、HTML 200 拒绝、周期检查和关闭。
- 新功能及审查发现的回归均先观察失败，再修复至通过。独立审查发现两项重要问题（force 意图丢失、校验失败绕过退避）及一项 CLI HTML 200 问题，均已修复并有回归测试。

## 真实站点验证

- 独立 Chromium 复用当前用户浏览器资料，完成清华统一认证；在线 `/model-api/auth-login` 校验成功。
- 强制续登成功，令牌到期时间更新。发现并修复登录跳转后等待已消失表单的问题；未读取或保存密码。
- 当前模型目录读取成功：`DeepSeek-V4.1-Flash`、`qwen3.8-27b`、`DeepSeek-R1-W8A8`。上游 `/v1/models` 返回 HTML，本地目录由实际前端配置提供。
- `DeepSeek-V4.1-Flash` 正式接口非流式请求返回 `MADMODEL_OK`。
- 常驻本机 HTTP 服务：`/health` 返回 200，`/v1/models` 返回模型列表；JSON 请求返回 `MADMODEL_JSON_OK`；SSE 请求返回 `MADMODEL_STREAM_OK` 和 `[DONE]`。
- 已安装的官方 Python OpenAI SDK 成功读取模型目录并流式返回 `SDK_OK`，请求使用占位下游 Key `local`，无学校令牌传给 SDK。
- 用短检查间隔启动临时真实服务，确认在线验证时间在连续周期推进，关闭后结束检查；没有向模型发送保活请求。
- 后台脚本的启动、停止、重复启动和状态查询通过。重复启动保持同一 PID。

## 交付边界

- 本机服务默认 `127.0.0.1:8765`，默认每 5 分钟检查，到期前 15 分钟刷新；依据实际 token `exp`，而非网页陈述的固定 5 小时。
- 后台服务随当前用户进程运行；未注册 Windows 开机任务。重启 Windows 后运行 `tools/madmodel-service.cmd start`。
- 实际生成验证使用 DeepSeek-V4.1-Flash；其他两个模型已确认出现在真实目录中，能力由上游提供。
- 支持 Chat Completions，不实现 Responses、音频、嵌入、图片生成端点。
- 未执行 `install --unified --apply`，未修改其他客户端注册配置，未推送或合并远端。
