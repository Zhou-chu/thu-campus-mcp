# 托管部署：让手机不再受同网段限制

默认形态是**本机运行时**：`app serve` 只监听 `127.0.0.1`，手机必须和电脑在同一网段才能配对。

托管模式把同一个运行时暴露到能路由到的地址（公网域名、内网穿透、公司 VPN），手机与平板在任意网络下都能用。**协议、鉴权、工具语义完全不变**，变的只是监听与信任边界。

## 三种形态对照

| 形态 | 典型配置 | 适用 |
| --- | --- | --- |
| 本机（默认） | 什么都不设 | 只在自己电脑上用浏览器 / 桌面端 |
| 局域网 | `THU_CAMPUS_APP_HOST=0.0.0.0` + `THU_CAMPUS_APP_ALLOW_REMOTE=1` | 手机在家用 Wi-Fi，同一个路由器 |
| 托管 | 上面再加 `PUBLIC_URL` + `TLS_CERT/KEY`，或回环监听 + `TLS_PROXY=1` 交给反代 | 出门在外、多校区、多设备 |

## 环境变量

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `THU_CAMPUS_APP_HOST` | `127.0.0.1` | 监听地址 |
| `THU_CAMPUS_APP_PORT` | `8971` | 端口 |
| `THU_CAMPUS_APP_ALLOW_REMOTE` | 空 | `1` 表示允许「非回环 + 无固定令牌」启动，只用配对码鉴权 |
| `THU_CAMPUS_APP_TOKEN` | 空 | 固定设备令牌；设置后**关闭配对**，所有客户端共用它 |
| `THU_CAMPUS_APP_PUBLIC_URL` | 空 | 对外可达地址，配对时回给客户端；也自动进入 Host 白名单 |
| `THU_CAMPUS_APP_TLS_CERT` / `_KEY` | 空 | PEM 证书与私钥；成对提供，直出 HTTPS |
| `THU_CAMPUS_APP_TLS_PROXY` | 空 | `1` 表示由本机回环反代终止 TLS；必须同时设回环监听与 `HTTPS` 的 `PUBLIC_URL` |
| `THU_CAMPUS_APP_ALLOW_PLAINTEXT` | 空 | 仅为已在运行的明文实例保留的迁移开关；新部署不要使用 |
| `THU_CAMPUS_APP_ALLOWED_HOSTS` | 空 | 逗号分隔的额外 Host 白名单（反代转发的主机名不在 `PUBLIC_URL` 里时才需要） |
| `THU_CAMPUS_APP_ALLOWED_ORIGINS` | 空 | 逗号分隔的额外 Origin 白名单 |

安全闸门有两条，都在 `app serve` 启动阶段执行，不满足直接退出：

1. 非回环监听必须在 `THU_CAMPUS_APP_TOKEN` 与 `THU_CAMPUS_APP_ALLOW_REMOTE=1` 之间**二选一**，否则 `INSECURE_LISTEN`。
2. 托管形态（`ALLOW_REMOTE=1`、`PUBLIC_URL` 或非回环监听）必须有 TLS：本机直出证书，或回环 + `TLS_PROXY=1`，否则 `TLS_REQUIRED`。代理模式配置不完整报 `INVALID_TLS_PROXY`。

只有「本机回环 + 明文 HTTP」仍是合法形态，那是自己电脑上的浏览器与桌面端。

已在运行的明文托管实例可以临时设置 `THU_CAMPUS_APP_ALLOW_PLAINTEXT=1` 继续启动，启动日志会输出 `app-plaintext-legacy`，`/api/meta` 的 `security.https` 仍为 `false`。这个开关只为迁移期保留，不要在新部署里使用。

配对与账号写入都要求密文通道（原生 TLS、经批准的回环代理，或本机回环 HTTP），其余情况返回 `PAIRING_HTTPS_REQUIRED` / `ACCOUNT_HTTPS_REQUIRED`，不会在明文远程页面上收密码。

## 方案 A：运行时直出 HTTPS

```powershell
$env:THU_CAMPUS_APP_HOST        = '0.0.0.0'
$env:THU_CAMPUS_APP_PORT        = '443'
$env:THU_CAMPUS_APP_ALLOW_REMOTE = '1'
$env:THU_CAMPUS_APP_PUBLIC_URL  = 'https://campus.example.com'
$env:THU_CAMPUS_APP_TLS_CERT    = 'C:\certs\fullchain.pem'
$env:THU_CAMPUS_APP_TLS_KEY     = 'C:\certs\privkey.pem'
node bin/thu-campus.mjs app serve
```

`/healthz` 应立即返回 `{"ok":true}`，`/api/meta` 的 `security` 段会显示 `https: true, hosted: true`。

## 方案 B：本机回环 + 反向代理终止 TLS（推荐）

运行时继续只监听 `127.0.0.1`，由 Nginx/Caddy/Tailscale Serve 负责证书。**必须**显式声明 `THU_CAMPUS_APP_TLS_PROXY=1`：只有这个开关打开，运行时才会信任回环代理发来的 `X-Forwarded-Proto`，并且要求 `Host` 与 `X-Forwarded-Host` 都等于 `PUBLIC_URL` 的主机名（含端口）。

```powershell
$env:THU_CAMPUS_APP_HOST            = '127.0.0.1'
$env:THU_CAMPUS_APP_ALLOW_REMOTE    = '1'
$env:THU_CAMPUS_APP_TLS_PROXY       = '1'
$env:THU_CAMPUS_APP_PUBLIC_URL      = 'https://campus.example.com'
node bin/thu-campus.mjs app serve
```

Nginx：

```nginx
server {
  listen 443 ssl http2;
  server_name campus.example.com;
  ssl_certificate     /etc/ssl/campus/fullchain.pem;
  ssl_certificate_key /etc/ssl/campus/privkey.pem;

  location / {
    proxy_pass http://127.0.0.1:8971;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Forwarded-Host $host;   # 运行时要核对，缺了会被当成明文
    proxy_buffering off;          # 关键：否则 SSE 会被缓冲
    proxy_read_timeout 600s;
  }
}
```

Caddy（自动带上 `X-Forwarded-Host`）：

```
campus.example.com {
  reverse_proxy 127.0.0.1:8971 {
    flush_interval -1
  }
}
```

Tailscale Serve（只有 tailnet 能访问，无需证书文件）：

```powershell
tailscale serve --bg --https=8443 http://127.0.0.1:8971
$env:THU_CAMPUS_APP_TLS_PROXY  = '1'
$env:THU_CAMPUS_APP_PUBLIC_URL = 'https://<machine>.<tailnet>.ts.net:8443'
```

`proxy_buffering off` / `flush_interval -1` 是必须的：对话是 `text/event-stream`，被缓冲就看不到流式输出。

## 开机常驻

**Windows（推荐，因为凭据是 DPAPI 绑定 Windows 用户的）**

```powershell
nssm install thu-campus-app "C:\Program Files\nodejs\node.exe" "D:\code\thu-campus-mcp\bin\thu-campus.mjs app serve"
nssm set thu-campus-app AppEnvironmentExtra THU_CAMPUS_APP_HOST=0.0.0.0
nssm set thu-campus-app AppEnvironmentExtra THU_CAMPUS_APP_ALLOW_REMOTE=1
nssm set thu-campus-app AppEnvironmentExtra THU_CAMPUS_APP_PUBLIC_URL=https://campus.example.com
nssm start thu-campus-app
```

服务必须与**当初完成校园登录的同一个 Windows 用户**运行，否则 DPAPI 解不开凭据。

**Linux（有图形会话时）**

```ini
[Unit]
Description=thu-campus app runtime
After=network-online.target

[Service]
WorkingDirectory=/opt/thu-campus-mcp
Environment=THU_CAMPUS_APP_HOST=127.0.0.1
Environment=THU_CAMPUS_APP_ALLOW_REMOTE=1
Environment=THU_CAMPUS_APP_PUBLIC_URL=https://campus.example.com
Environment=DISPLAY=:99
ExecStart=/usr/bin/node bin/thu-campus.mjs app serve
Restart=on-failure

[Install]
WantedBy=multi-user.target
```

## 运行时怎么告诉你"这台机器能不能登录"

`/api/meta` 与 `app status` 都会返回：

```json
"loginCapability": { "window": true, "reason": "desktop", "hint": "" }
```

| 场景 | window | reason |
| --- | --- | --- |
| Windows / macOS | `true` | `desktop` |
| Linux 有 `DISPLAY` 或 `WAYLAND_DISPLAY` | `true` | `display` |
| Linux 无图形会话 | `false` | `no-display`，`hint` 给出处置建议 |

`window:false` 时**不要**指望能完成首次校园登录：`campus_browser_login` 会尝试打开可见窗口并失败。已经存在的会话仍然可以无界面续登（`browser restore --headless`、`madmodel login --headless`），运行时会在到期前自动续期。

### 无图形主机的首次登录：只有一条可行路径

`loginCapability.window === false` 时，必须在别处完成**首次**登录。实际可用的做法只有一种：临时给这台机器一个虚拟显示，然后把一次性验证码交给本人。

```bash
# Linux：临时虚拟显示 + 只开放给本机的 VNC
Xvfb :99 -screen 0 1280x800x24 &
export DISPLAY=:99
x11vnc -display :99 -localhost -nopw -forever &   # 再用 SSH 隧道访问 5900
node bin/thu-campus.mjs browser login learnx --account <你的学号>
# 本人在 TUNNEL 里完成登录后，杀掉 Xvfb/x11vnc，会话已落到持久浏览器工作区
```

之后就可以纯无界面续登。注意两点：**不能把 Windows 上的 DPAPI 凭据拷到 Linux**（必然解不开）；**不能把验证码当作可自动化环节**。

## 部署前必须知道的三件事

1. **鲜登是人工步骤，且要看得见浏览器。** 网络学堂/云盘/雨课堂的首次登录、以及学校要求验证码或多因素认证时，需要在**有图形界面**的环境里弹出独立 Chromium 由本人完成。纯无头的云主机无法完成首次登录；`browser restore --headless` 与 `madmodel login --headless` 只在**已有有效会话**时能续登。
2. **凭据不能跨机器搬。** 会话与浏览器快照都由 Windows DPAPI 按当前用户加密，换机器/换用户无法解密。托管到新机器就等于重新登录一次。
3. **手机端是瘦客户端，托管只是换了个可达地址。** 配对码、设备令牌、401 回退的行为与局域网完全一致；手机本身仍然不执行任何校园协议。

## 安全清单

- [ ] 公网必须 HTTPS；托管形态缺 TLS 时**启动即失败**（`TLS_REQUIRED`），不再是警告。
- [ ] 反代终止 TLS 时设 `THU_CAMPUS_APP_TLS_PROXY=1`，并确认反代会覆盖 `Host`/`X-Forwarded-Host`/`X-Forwarded-Proto`；直接访问后端端口伪造这些头不会生效。
- [ ] 不要长期开着 `THU_CAMPUS_APP_TOKEN` 又对外暴露——它是单一共享令牌，泄露即全丢；日常用配对码 + 设备吊销。
- [ ] 定期 `node bin/thu-campus.mjs app devices` 检查已配对设备，可疑的 `--revoke <id>`。
- [ ] 反代不要加缓存（尤其 `/api/chat`），不要在 `/api/*` 上做路径重写。
- [ ] 只开放 443；`8971` 不要直接对公网。
- [ ] 日志里不要出现令牌：启动器与运行时都已做脱敏，排查问题时仍然先看 `desktop.log` 的脱敏形态。




## Tailscale 证书与续期

Tailscale 可以为 tailnet 内的机器签发被公共信任的证书（Let's Encrypt），不需要自己维护 CA：

```powershell
tailscale cert --cert-file .local/tls/campus.crt --key-file .local/tls/campus.key desktop-uq2emap.tailf544a4.ts.net
$env:THU_CAMPUS_APP_TLS_CERT = "D:\path\campus.crt"
$env:THU_CAMPUS_APP_TLS_KEY = "D:\path\campus.key"
$env:THU_CAMPUS_APP_PUBLIC_URL = "https://desktop-uq2emap.tailf544a4.ts.net:8973"
```

设置 TLS 后同一端口只接受 HTTPS：明文请求不会被处理，也不再需要 `THU_CAMPUS_APP_ALLOW_PLAINTEXT`。证书有效期约 90 天，到期前重新执行 `tailscale cert` 覆盖两个文件并重启运行时；也可以放进计划任务每月续期一次。浏览器与 Node 客户端都会按系统信任链校验，不需要 `--insecure`。

配对与会话码兑换要求密文通道：HTTPS 下远程客户端可以正常换码；明文远程仍会得到 `PAIRING_HTTPS_REQUIRED`，这是刻意保留的拒绝，不是缺陷。
