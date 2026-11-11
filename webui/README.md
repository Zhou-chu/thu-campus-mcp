# 独立 Agent 应用 WebUI

纯静态、无构建步骤、无框架、无 CDN 的前端。它由 `node bin/thu-campus.mjs app serve` 直接托管，同一份文件也用于 Windows 桌面窗口、Android 与 HarmonyOS 的 WebView 外壳。

## 启动

```powershell
npm run build                       # 首次或改过 packages/* 之后
node bin/thu-campus.mjs app serve   # 默认 http://127.0.0.1:8971
```

控制台会打印一次性 6 位配对码。首次打开页面、或换了浏览器时，在配对页填入该码即可。也可用：

```powershell
node bin/thu-campus.mjs app serve --port 8971 --open
```

## 界面

| 标签 | 作用 |
| --- | --- |
| 对话 | 流式对话；工具调用显示为卡片（参数、状态、结果可折叠）；可中断本轮 |
| 会话 | 历史会话列表，可继续或删除 |
| 服务 | 网络学堂 / 云盘 / 雨课堂 / MadModel 的登录态，可直接触发本机浏览器登录并轮询任务 |
| 工具 | 53 个校园工具的搜索与表单化调用，只读与写入类目标记区分 |
| 设置 | 模型名、最大工具步数、生成配对码给其它设备、清除本地令牌 |

## 令牌与安全

- 令牌来源优先级：`localStorage` → URL 片段 `#token=` → 查询串 `?token=`，读到后立即 `history.replaceState` 抹掉。
- 页面带 CSP：只允许本源的脚本与样式，禁止内联脚本、外部资源与框架嵌入。
- 课程、作业、文件正文属不可信数据：界面只做文本渲染，最小 markdown 也只识别围栏代码、行内代码与粗体，任何接口字符串都不会进入 `innerHTML`。
- Service Worker 只缓存静态资源，`/api/*` 一律实时请求，不进缓存。

## 文件

| 文件 | 说明 |
| --- | --- |
| `index.html` | 外壳、配对页、导航 |
| `app.js` | 全部界面逻辑（视图、SSE 解析、工具表单） |
| `styles.css` | 移动优先、暗色适配、44px 触控目标 |
| `manifest.webmanifest` / `sw.js` | 可安装 PWA |
| `icons/icon.svg` | 图标 |

## 自测

```powershell
node --check webui/app.js
node --check webui/sw.js
```

真实联调：启动运行时后打开页面，配对 → 发一条消息（未登录模型时会给出明确错误而不是白屏）→ 「工具」里调用 `learn_status` → 「设置」生成配对码。