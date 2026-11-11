# Android 客户端

**它是运行时的瘦客户端，不是独立实现。** 网络学堂、清华云盘、荷塘雨课堂依赖 Node 运行时与 Playwright 持久浏览器，无法在 Android 上重写；这里只做三件事：

1. 用 6 位配对码（或 `thucampus://pair?...` 深链）连上你电脑上的运行时；
2. 把设备令牌用 Android Keystore 的 AES-256-GCM 加密后存进 SharedPreferences；
3. 用 WebView 加载运行时提供的同一套 WebUI，登录态与桌面端完全共享。

## 结构

```
app/src/main/
├── AndroidManifest.xml          # INTERNET、深链 thucampus://pair、明文网络配置
├── java/cn/edu/tsinghua/campusapp/
│   ├── MainActivity.kt          # WebView 外壳 + 配对流程 + 401 回退
│   └── PairStore.kt             # Keystore AES-GCM 令牌存储
└── res/
    ├── layout/activity_main.xml # WebView + 配对面板（同一 Activity 切换）
    ├── values/strings.xml       # 全中文文案
    ├── xml/network_security_config.xml
    └── drawable/ic_launcher.xml
```

## 构建

需要 JDK 17+、Android SDK Platform 35 与 Build-Tools 35。用 Android Studio 打开 `mobile/android`，或：

```powershell
cd mobile/android
# 首次：生成 wrapper（用本机已装的 Gradle 7.2+ 即可）
gradle wrapper --gradle-version 8.9
.\gradlew.bat assembleDebug
```

产物在 `app/build/outputs/apk/debug/app-debug.apk`。

## 本仓库未验证的部分（如实说明）

本开发机只有 Android SDK 的 `platform-tools`，**没有 `platforms/`、`build-tools/`、`cmdline-tools`**，因此：

- **没有实际编译过，也没有产物 APK。** 上面的命令是按工程结构编写的标准流程。
- 需要你在一台装了完整 SDK 的机器或 Android Studio 上首次构建验证。
- 已做的人工核对：Manifest 引用的资源都存在（`@drawable/ic_launcher`、`@xml/network_security_config`、`@layout/activity_main`、`@string/*` 全部定义在 `strings.xml`）；两个 Kotlin 文件的 import 与类名一致；`build.gradle.kts` 声明的 `proguard-rules.pro` 已存在。

## 安全取舍

- **明文 HTTP 是刻意开放的**：运行时在局域网内、以 `http://192.168.x.x:8971` 提供，没有可信证书。`network_security_config.xml` 只放开 cleartext，不降低其它 TLS 策略。若把运行时部署到公网，必须改成 HTTPS 并收窄为单一域名。
- 令牌走 URL 片段（`#token=`）传给 WebView，不进入查询串与服务端访问日志；WebUI 读到后立刻抹掉并转存 `localStorage`。
- `allowBackup="false"`：令牌不应随系统备份迁移到别的设备。
- Keystore 密钥不可导出；清应用数据或换机后必须重新配对，这是预期行为。
- WebView 只允许加载配对时记录的主机，其它链接交给系统浏览器。

## 排错

| 现象 | 处理 |
| --- | --- |
| 配对后一直 `NETWORK` | 手机与电脑不在同一网段，或被电脑防火墙拦截；确认 `lanUrls` 里的地址 |
| 401 后回到配对页 | 令牌被吊销或运行时状态目录被清空，重新配对即可 |
| 页面空白 | 电脑上的 `app serve` 已停止；重开后用同一配对令牌即可 |