# @thu-campus/mobile-core

清华校园助手移动端（鸿蒙 / 安卓）的**平台无关共享核心**。

## 边界

| 层 | 位置 | 职责 |
| --- | --- | --- |
| 共享核心（本包） | `packages/mobile-core/` | 调用 `lib/app/server.mjs` 的公开 HTTP API、错误码映射、展示格式化。**不含任何平台 API** |
| 鸿蒙壳 | `apps/mobile-harmony/`（后续） | ArkTS / Stage 模型，hdc 部署调试，只负责 UI 与平台能力 |
| 安卓壳 | `apps/mobile-android/`（后续） | Kotlin 或 WebView 壳，adb / 卓易通调试 |
| WebUI | `webui/` | 现有网页端，保持独立 |
| 桌面 | `desktop/` | 现有桌面端，保持独立 |

约束：

- 移动端只依赖公开 HTTP API（`/api/meta`、`/api/timetable`、`/api/seat/*`、`/api/sports/*`），**不 import `lib/` 内部模块**；
- 桌面与 WebUI 不被移动端代码侵入；
- 样式与文案规范以 `UIdesign.md` 为准，移动端复用同一套语义（金额单位是分、日期用本地日历日、未核验不冒充已登录）。

## API 客户端

```ts
import { CampusClient, yuanText } from "@thu-campus/mobile-core";

const client = new CampusClient({ baseUrl: "http://127.0.0.1:8973", token: "设备令牌" });
const { libraries } = await client.seatLibraries();
const { sessions } = await client.sportsSlots("游泳", "陈明游泳馆", "2026-11-22");
console.log(yuanText(sessions[0]?.price));
```

错误统一抛 `CampusApiError`：`code` 来自服务端（如 `SEAT_CLOSED`、`SPORTS_MAINTENANCE`、`BROWSER_BUSY`），`status` 是 HTTP 状态码；网络失败为 `NETWORK_ERROR`。

## 开发

```bash
npm --prefix packages/mobile-core test
npm --prefix packages/mobile-core run typecheck
```