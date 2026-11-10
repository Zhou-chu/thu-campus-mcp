# MadModel 模型服务

服务使用 `https://madmodel.cs.tsinghua.edu.cn/v1/chat/completions`，通过站点的清华统一认证登录。学校令牌保存在当前 Windows 用户的 DPAPI 加密文件中，下游只连接本机 HTTP 服务。实现不读取或保存密码；只有浏览器自己的密码管理器可以自动填充学校登录表单。验证码和多因素验证仍须本人完成。

## 启动和管理

```powershell
node bin/thu-campus.mjs madmodel login            # 首次登录或验证码处理
node bin/thu-campus.mjs madmodel login --headless # 已有浏览器资料时无界面登录
node bin/thu-campus.mjs madmodel status           # 脱敏本地状态，不联网
node bin/thu-campus.mjs madmodel check            # 在线检查，必要时续期
node bin/thu-campus.mjs madmodel refresh          # 强制走一次统一认证
node bin/thu-campus.mjs madmodel models           # 当前站点模型目录
node bin/thu-campus.mjs madmodel serve            # 前台服务，Ctrl+C 退出
.\tools\madmodel-service.cmd start               # 当前用户后台启动
.\tools\madmodel-service.cmd status
.\tools\madmodel-service.cmd stop
node bin/thu-campus.mjs madmodel logout          # 停止后续自动恢复
```

后台启动脚本也支持便携包的 `.runtime/node.exe`，日志位于 `.local/madmodel-service/`。`start` 幂等，不会重复启动本脚本管理的进程；`stop` 校验进程路径、启动时间和命令行后才结束进程。脚本不注册开机任务；每次重新登录 Windows 后运行 `start`。定时检查和续期由常驻服务内部执行，不依赖客户端保持 MCP 对话。

退出学校网页与 `logout` 相互独立；`logout` 会持久保存禁止自动恢复的标记，并使进行中的旧登录结果失效。之后须显式 `login`。账号切换不会静默覆盖原绑定；独立使用其他账号时需独立的状态/浏览器资料目录及对应的网络学堂账号绑定。

已有统一 MCP 还支持 `campus_browser_login` / `campus_browser_open` 的 `service: "madmodel"`，以及 `madmodel_status`、`madmodel_models` 两个只读工具。`browser restore all` 包括已经配置的 MadModel。无需重新安装 MCP 或更改其他客户端配置。

## 下游连接

- Base URL：`http://127.0.0.1:8765/v1`
- API Key：默认回环模式可填任意占位字符串，如 `local`；启用 `MADMODEL_API_KEY` 后须填写它。
- 模型名：通过 `GET /v1/models` 查询。当前目录从站点前端 `modelList` 提取，内存缓存 1 小时；上游 `/v1/models` 目前返回 HTML。

```python
from openai import OpenAI

client = OpenAI(base_url="http://127.0.0.1:8765/v1", api_key="local", max_retries=0)
models = client.models.list()
response = client.chat.completions.create(
    model=models.data[0].id,
    messages=[{"role": "user", "content": "你好"}],
    stream=False,
)
print(response.choices[0].message.content)

for chunk in client.chat.completions.create(
    model=models.data[0].id,
    messages=[{"role": "user", "content": "用一句话解释牛顿第二定律"}],
    stream=True,
):
    if chunk.choices:
        print(chunk.choices[0].delta.content or "", end="")
```

图片、工具调用、`reasoning_effort`、`chat_template_kwargs` 等字段原样透传，具体支持情况由所选模型决定。对话内容发送至学校 MadModel；不会自动读入其他校园工具的课程资料。这里提供 Chat Completions，不实现 `/v1/responses`、音频、嵌入或图片生成端点。

## 配置

| 环境变量 | 默认值 | 作用 |
| --- | --- | --- |
| `MADMODEL_HOST` | `127.0.0.1` | 监听地址；非回环必须配置下游 Key |
| `MADMODEL_PORT` | `8765` | HTTP 端口 |
| `MADMODEL_API_KEY` | 空 | 下游 Bearer Key，与学校令牌独立 |
| `MADMODEL_STATE_DIR` | `~/.thu-campus-mcp/madmodel` | DPAPI 会话与注销标记目录 |
| `MADMODEL_CHECK_INTERVAL_MS` | `300000` | 定时检查间隔，毫秒 |
| `MADMODEL_REFRESH_AHEAD_MS` | `900000` | 到期前多久续登，毫秒 |
| `MADMODEL_TIMEOUT_MS` | `300000` | 单个上游生成请求的总超时，毫秒 |
| `MADMODEL_LOGIN_TIMEOUT_MS` | `60000` | 无界面登录超时，毫秒 |
| `MADMODEL_MAX_BODY_BYTES` | `20971520` | 请求体上限，默认 20 MiB |
| `THU_BROWSER_STATE_DIR` | 项目浏览器默认目录 | 与其他校园服务共用的持久浏览器资料 |
| `THU_CAMPUS_AUTOFILL_LOGIN` | `1` | 设为 `0` 禁用保存凭据自动提交 |

`GET /health` 返回服务及认证健康状态，未配置、过期或最近校验失败时 HTTP 503；`GET /auth/status` 返回脱敏认证状态。启用 Key 时这些端点也需要 Bearer。服务拒绝浏览器跨站请求，面向 SDK、CLI 和服务端程序；不直接提供浏览器 CORS 接入。跨机器使用时应在受控网络中配置鉴权和 TLS 入口。

学校页面说明令牌有效期为 5 小时，但实际签发策略可能变化。程序依据令牌 `exp`，并用 `/model-api/auth-login` 在线验证；不会把 HTTP 200 的登录网页当作成功。并发请求合并同一次续登；恢复失败至少等待 60 秒再尝试，定时检查在下一周期继续。

仅在上游明确返回 401 且还未向下游发送内容时，恢复同一账号并重试一次。网络错误、403、5xx、已开始的流和结果不明的请求不自动重放。下游断开后取消对应上游请求。模型服务停止后停止定时检查并取消在途操作。

`BROWSER_BUSY` 表示其他校园任务正在用同一个浏览器；关闭该窗口后等待下一检查周期，或运行 `check`。`VERIFICATION_REQUIRED` / `BROWSER_LOGIN_REQUIRED` 时运行 `login` 在本机完成学校验证。任何状态和日志都不会返回学校 token、Cookie、密码或登录 ticket。
