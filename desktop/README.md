# Windows 桌面端

双击 `thu-campus-desktop.cmd` 即可。启动器会：

1. 读取 `~/.thu-campus-mcp/app/desktop.json`（首次自动生成 256 位设备令牌，权限 600）；
2. 以 `THU_CAMPUS_APP_TOKEN` 启动运行时 `node bin/thu-campus.mjs app serve`，日志写到 `~/.thu-campus-mcp/app/desktop.log`（令牌脱敏）；
3. 轮询 `/healthz` 直到就绪（30 秒超时）；
4. 用**包内 Chromium** 以 `--app=` 应用窗口打开 `http://127.0.0.1:8971/#token=…`；
5. 窗口关闭后停掉运行时并释放单实例锁。

## 为什么不用 Electron

项目要求「默认不依赖 Edge、Chrome 或额外 Electron 程序」。Chromium 内核本来就随包分发（`browser install`，用于校园登录），桌面窗口复用它，便携包体积不增加，也不需要 WebView2 运行时。

## 文件

| 文件 | 说明 |
| --- | --- |
| `launcher.mjs` | 启动器；纯逻辑（配置、参数、健康检查、脱敏）可单测 |
| `thu-campus-desktop.cmd` | Windows 双击入口，优先用便携包的 `.runtime\node.exe` |
| `test/launcher.test.mjs` | `node --test`，不启动任何窗口 |

## 已知限制

- 没有安装内核时不会自动下载 200 MiB，而是提示先运行 `node bin/thu-campus.mjs browser install`（退出码 3）。
- 单实例通过 `~/.thu-campus-mcp/app/desktop.lock` 保证；同时开两个会直接提示「已在运行」。
- 不做 MSI 安装器；发布形态是便携 ZIP 解压即用。令牌绑定当前 Windows 用户，换机器需重新配对。
- 手动强制结束启动器（任务管理器）可能留下运行时进程，正常关闭窗口不会。

## 排错

| 现象 | 处理 |
| --- | --- |
| 退出码 3 | 缺 Chromium 内核，运行 `browser install` |
| 退出码 2 | 运行时 30 秒内没就绪，看 `desktop.log`；常见是 `npm run build` 没跑 |
| 提示「桌面端已在运行」 | 已有窗口；先关掉旧窗口 |
| 窗口空白 | 运行时已停止；关闭窗口重开，或看 `desktop.log` |