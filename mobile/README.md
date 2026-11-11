# 移动端：Android 与 HarmonyOS

两端的定位相同：**运行时的瘦客户端**。

## 为什么手机端不能独立运行

网络学堂、清华云盘、荷塘雨课堂的会话都依赖：

- Node 运行时（`packages/*/dist`，TypeScript 编译产物）；
- Playwright 驱动的持久 Chromium 工作区（Cookie / localStorage / IndexedDB 快照、DPAPI 加密状态）；
- 与 madmodel 共享的同一套 SSO。

在 ArkTS / Kotlin 里重新实现这三层既不现实也不安全。因此手机端只做「配对 + 令牌存储 + WebView 加载运行时的 WebUI」，校园登录与模型调用都发生在你自己的电脑上。

## 一键联通的完整链路

```
电脑：node bin/thu-campus.mjs app serve
        └─ 控制台打印 6 位配对码（5 分钟、一次性）
                │
   手机：输入配对码 / 打开 thucampus://pair?base=…&code=…
        └─ POST {base}/api/pair/redeem { code, deviceName, platform }
                └─ 得到设备令牌（服务端只存 sha256 摘要）
                        └─ 加载 {base}/#token=<token>
                                └─ 与桌面端、浏览器共享同一份登录态
```

配对成功后，你在电脑上完成的那次清华登录对四个端同时生效；模型通道（madmodel）也一样，不需要在手机上再登录一次。

## 目录

| 目录 | 内容 | 状态 |
| --- | --- | --- |
| `android/` | Kotlin + WebView + Keystore AES-GCM 令牌 | **已在本机真实构建通过**，产出 `app-debug.apk`（3.06 MB，包名 `cn.edu.tsinghua.campusapp`），未上真机 |
| `harmony/` | ArkTS Stage + ArkWeb + preferences | **已在本机真实构建通过**，产出未签名 HAP（44.6 KB），未上真机 |

两端的 `README.md` 里分别写了构建步骤、真实缺口与排错。

## 共同的安全取舍

- **明文 HTTP**：运行时在局域网、以 `http://` 提供，没有可信证书。Android 用 `network_security_config.xml` 放开 cleartext；HarmonyOS 侧需要在部署时显式配置网络策略。公网部署必须换成 HTTPS。
- **令牌走 URL 片段**：`#token=` 不进入查询串、不进服务端访问日志；WebUI 读到后立刻抹掉并转存 `localStorage`。
- **令牌本地加密**：Android 用 Android Keystore 的 AES-256-GCM；HarmonyOS 用应用沙箱内的 preferences。两者都不随系统备份迁移。
- **401 即回退**：令牌被吊销后，两端都会清本地令牌并回到配对页，不会静默重试。

## 已知能力边界

- 手机必须与电脑在同一网段（或能路由到 `lanUrls` 中的地址），不能脱离主机独立使用。
- 拍照扫码配对尚未实现：当前用「手动输 6 位码」与「深链 `thucampus://pair`」。扫码需要额外的相机权限与 ZXing/ScanKit 依赖，属于后续增量。
- iOS 未纳入本轮：它与 Android 同属「WebView 外壳 + 配对」，可复用同一套 WebUI 与 API。