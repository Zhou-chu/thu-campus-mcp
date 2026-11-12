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
.\gradlew.bat assembleDebug        # 首次会自动下载 Gradle 8.9 与依赖
```

产物在 `app/build/outputs/apk/debug/app-debug.apk`。

## 已通过的构建（本机实测）

```
> Task :app:compileDebugKotlin
> Task :app:packageDebug
> Task :app:assembleDebug
BUILD SUCCESSFUL in 4m 7s
```

| 项 | 值 |
| --- | --- |
| 产物 | `app/build/outputs/apk/debug/app-debug.apk` |
| 大小 | 3.06 MB |
| 包名（aapt2 读出） | `cn.edu.tsinghua.campusapp` |
| ZIP 头 | `50 4B 03 04` |
| JDK | DevEco 自带 JBR 21（AGP 8.7 支持 17–21） |
| Gradle | 8.9（wrapper 已随仓库提交，无需另装） |
| SDK | cmdline-tools 12.0 + `platforms;android-35` + `build-tools;35.0.0` |

本机原来是「只有 `platform-tools`」的裸 SDK，编译链是临时自举的：下载 `commandlinetools-win-11076708` 解压到 `D:\Android\cmdline-tools\latest`，接受许可后装 platform 35 与 build-tools 35，再用 `D:\Android\gradle-8.9` 构建。`local.properties` 指向本机 SDK，已在 `.gitignore` 中，不随仓库分发。

## 签名 release 包（本机已实测通过）

debug 包用的是 Android 默认调试签名，只能自己装。正式发布要自己的密钥：

```powershell
# 1) 生成密钥（放在仓库外或 .local/，绝不提交）
keytool -genkeypair -v -keystore .local/android-signing/release.jks `
  -alias thu-campus -keyalg RSA -keysize 4096 -validity 3650 `
  -storepass <口令> -keypass <口令> -dname "CN=你的名字, O=personal, L=Beijing, C=CN"

# 2) 在本目录写 keystore.properties（已被 .gitignore 排除）
#    storeFile=<jks 绝对路径，反斜杠要写两次>
#    storePassword=<口令>
#    keyAlias=thu-campus
#    keyPassword=<口令>

# 3) 构建并校验
.\gradlew.bat assembleRelease
$env:JAVA_HOME='<JDK17+>'
apksigner.bat verify --print-certs --verbose app\build\outputs\apk\release\app-release.apk
```

`app/build.gradle.kts` 只在 `keystore.properties` 存在时启用 release 签名；缺该文件时 release 仍可编译（未签名），便于在干净环境跑通。

本机实测结果：

```
BUILD SUCCESSFUL in 1m 46s
app-release.apk  2.42 MB
Verifies
Verified using v2 scheme (APK Signature Scheme v2): true
Signer #1 certificate DN: CN=thu-campus app, OU=personal, O=personal, L=Beijing, ST=Beijing, C=CN
Signer #1 key algorithm: RSA / 4096 bits
Signer #1 certificate SHA-256 digest: bb68743c84477bc1ed7876d35d29509eeb79da81ab38026af0e28a618117e0a0
app-release.apk SHA-256: 700EA1CA2E532D58D61D23E2541A9B685600CD048AF3DEB46A78E535551FEA4D
package: name='cn.edu.tsinghua.campusapp' versionName='1.3.0'
```

该证书只是为了在本机验证签名链路，**不要用于正式分发**——发布前请自己生成并妥善保管密钥，keystore 丢失后无法升级同包名应用。

## 仍未验证

- **没有装到真机或模拟器上运行过**：只验证到「编译通过 + APK 结构正确」。
- 未验证 WebView 实际加载 WebUI 后的交互（需要主机 `app serve` 且与手机同网段）。
- debug 包用 Android 默认调试签名；正式发布需要自己的 keystore。

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
