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
│   ├── PairStore.kt             # Keystore AES-GCM 令牌存储
│   ├── HostPolicy.kt            # 地址与请求白名单（纯 JVM，无 Android 依赖）
│   └── RuntimeHub.kt            # Android 适配层：Uri → HostPolicy，零判定逻辑
└── res/
    ├── layout/activity_main.xml # WebView + 配对面板（同一 Activity 切换）
    ├── values/strings.xml       # 全中文文案
    ├── xml/network_security_config.xml
    └── drawable/ic_launcher.xml
app/src/test/java/.../HostPolicyTest.kt    # 29 个 hermetic JUnit 用例
app/gradle.lockfile              # 依赖版本锁（含 junit，143 条 / 11 个 configuration）
gradle/verification-metadata.xml # 构件 sha256 校验和（309 个组件 / 544 条）
```

## 构建

需要 JDK 17+（AGP 8.7 不支持 Java 8）、Android SDK Platform 35 与 Build-Tools 35。用 Android Studio 打开 `mobile/android`，或：

```powershell
cd mobile/android
.\gradlew.bat assembleDebug        # 首次会自动下载 Gradle 8.9 与依赖
```

产物在 `app/build/outputs/apk/debug/app-debug.apk`。本机验证时用的是 SDK 自带的 Gradle 8.9（`D:\Android\gradle\gradle-8.9`）+ DevEco 自带 JBR 21；wrapper 的 8.9 分发包若未缓存，首次会自行下载约 130 MB。

### 依赖锁定与校验和

两条防线都是真实生成、且在构建里强制生效的：

| 文件 | 作用 |
| --- | --- |
| `app/gradle.lockfile` | 固定每个 configuration 解析出的精确版本（143 条 / 11 个 configuration，含 junit） |
| `gradle/verification-metadata.xml` | 固定每个构件的 sha256（309 个组件 / 544 条校验和） |

升级或新增依赖必须显式重写锁，并 review diff：

```powershell
.\gradlew.bat :app:testDebugUnitTest assembleDebug assembleRelease --write-locks --write-verification-metadata sha256
```

锁或哈希对不上时构建会直接失败，两类真实报错：

```
> Did not resolve 'androidx.appcompat:appcompat:9.9.9' which is part of the dependency lock state
> Dependency verification failed for configuration ':app:releaseRuntimeClasspath'
  One artifact failed verification: activity-1.7.0.aar (androidx.activity:activity:1.7.0)
```

注意：`:app:dependencies` 报告任务不做锁校验，只有真实构建任务（`assemble*`/`compile*`）才会拦截。

## 本机实测（2026-11-14 复核）

```
gradlew :app:testDebugUnitTest :app:assembleDebug :app:assembleRelease --write-locks --write-verification-metadata sha256
BUILD SUCCESSFUL in 1m 57s
82 actionable tasks: 16 executed, 66 up-to-date
```

随后**不带** `--write-*` 再跑一次同样三个任务：`BUILD SUCCESSFUL in 1m 33s`，说明锁与校验和已处于强制校验状态（junit 也是走这条路径真实进锁的）。

| 项 | 值 |
| --- | --- |
| 单测 | **29 个用例 / 0 失败**（`HostPolicyTest`） |
| debug APK | 3.32 MB |
| release APK | 0.65 MB（开 R8 前是 2.42 MB） |
| R8 | `mapping.txt` 2.46 MB；457/511 个类被重命名为短名 |
| release APK SHA-256 | `9EAAED61E494806362D1BCA1A7B7BF725F22AA6EFB297F09C23A9226EAD688C3`（每次构建会变，仅用于核对本次产物） |
| 签名 | `apksigner verify` 通过，`CN=thu-campus app`，证书 SHA-256 `bb68743c84477bc1ed7876d35d29509eeb79da81ab38026af0e28a618117e0a0` |
| 编译后的 manifest | `usesCleartextTraffic=false`、`networkSecurityConfig=@0x7f0f0000`（aapt2 从 APK 读出） |
| 工具链 | Gradle 8.9 + JBR 21.0.8 + `platforms;android-35` + `build-tools;35.0.0` |

SDK 位于 `D:\Android`（cmdline-tools + platform 35 + build-tools 34/35）。`local.properties` 指向本机 SDK，已在 `.gitignore` 中，不随仓库分发。

## 签名 release 包

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
apksigner.bat verify --print-certs app\build\outputs\apk\release\app-release.apk
```

`app/build.gradle.kts` 只在 `keystore.properties` 存在时启用 release 签名；缺该文件时 release 仍可编译（未签名），便于在干净环境跑通。该证书只是为了在本机验证签名链路，**不要用于正式分发**——发布前请自己生成并妥善保管密钥，keystore 丢失后无法升级同包名应用。

## 单测（hermetic，不需要设备）

`HostPolicy` 是纯 JVM 类（只用 `java.net.URI`），地址与请求白名单由 JUnit 覆盖：不联网、不做 DNS 解析、不需要模拟器或真机。

```powershell
.\gradlew.bat :app:testDebugUnitTest
```

覆盖：https 放行任意主机、http 公网拒绝、环回与 IPv6 环回、RFC1918 边界（172.15 / 172.32 / 192.169）、链路本地、Tailscale CGNAT 边界（100.63 / 100.128）与 `*.ts.net`、非 http(s) 协议、空串与无 scheme、userinfo 混淆、十六进制主机、尾点 FQDN、非法端口，以及同源判定（不同 host / 端口 / scheme、默认端口归一、`data:`/`blob:`/`about:`/`javascript:` 放行、`file:`/`content:` 拒绝）。

## 仍未验证

- **没有装到真机或模拟器上运行过**：只到「单测通过 + 编译通过 + APK 结构正确 + 签名有效」。
- WebView 真实加载 WebUI 后的交互未验证（需要主机 `app serve` 且手机同网段或同在 tailnet）；`shouldInterceptRequest` 的主框架/子资源拦截因此只有单测层面的保证。
- 依赖锁定覆盖的是本次构建解析到的 configuration；将来新增 flavor/测试变体时需要重跑 `--write-locks`。

## 安全边界：明文为什么在平台层放宽，控制为什么在应用层

先明确**没有**做的事：不是靠「manifest 写 `usesCleartextTraffic="false"` + NSC 全局 `true`」让扫描器闭嘴。这两项在本应用里恰好互相抵消（API 24+ 只要存在 NSC，manifest 属性就被忽略），所以真正的边界必须落在代码里，并且对每一条出网请求生效：

| 层 | 作用 | 说明 |
| --- | --- | --- |
| `network_security_config.xml` | 放开 cleartext | NSC 的 `domain` 只能写死域名，**表达不了 192.168.0.0/16**；要让用户手填任意内网 IP，平台层就只能整体放开，这是已知代价 |
| `usesCleartextTraffic="false"` | 兜底声明 | 只对「没有 NSC 的场景」有意义，用来固定平台默认值；本应用 `minSdk=24`，因此**不把它当主要防线** |
| `HostPolicy.checkBase()` | 配对前 | `https` 任意主机；`http` 只允许环回、RFC1918、169.254/16、Tailscale 100.64/10、`*.ts.net`、mDNS/单标签主机名 |
| `shouldOverrideUrlLoading` | 主框架导航 | 非配对同源不加载；`http(s)` 外链交给系统浏览器，其余 scheme 直接忽略 |
| `shouldInterceptRequest` | **子资源请求** | XHR / fetch / SSE / img / script 不在同源内直接返回空响应——这是 `shouldOverrideUrlLoading` 覆盖不到的那一半 |

不经过网络的 `data:`/`blob:`/`about:`/`javascript:` 放行，`file:`/`content:` 拒绝。

残余风险如实记录：平台层仍允许到任意主机的 cleartext，**如果应用层判定被绕过**（例如将来新增了不经过上述两个回调的加载通道），明文就不再受网段限制；公网部署必须改 https。同源放行也意味着「配对主机本身」是可信边界，运行时装在电脑上被攻陷不在本应用防护范围内。

## 其它取舍

- release 开启 R8 混淆与压缩（`isMinifyEnabled = true`）：`MainActivity` 因是 manifest 组件被默认规则保留原名，其余类被重命名；`proguard-rules.pro` 只保留 `@JavascriptInterface` 与行号信息。
- 令牌走 URL 片段（`#token=`）传给 WebView，不进入查询串与服务端访问日志；WebUI 读到后立刻抹掉并转存 `localStorage`。
- `allowBackup="false"`：令牌不应随系统备份迁移到别的设备。
- Keystore 密钥不可导出；清应用数据或换机后必须重新配对，这是预期行为。

## 排错

| 现象 | 处理 |
| --- | --- |
| 构建报 `Did not resolve ... which is part of the dependency lock state` | 依赖变了。用 `--write-locks` 重写锁并 review diff，不要手改锁文件 |
| 构建报 `Dependency verification failed` | 有新构件或换源了。用 `--write-verification-metadata sha256` 重写并核对该构件来源 |
| 配对提示「明文 http 只允许内网或 Tailscale 地址」 | 填内网地址（192.168/10/172.16-31）、`100.64-127.x.x`、`*.ts.net`，或给运行时配上 https |
| 配对后一直 `NETWORK` | 手机与电脑不在同一网段/tailnet，或被电脑防火墙拦截；确认 `/api/meta` 里的 `lanUrls` |
| 401 后回到配对页 | 令牌被吊销或运行时状态目录被清空，重新配对即可 |
| 页面空白 | 电脑上的 `app serve` 已停止；重开后用同一配对令牌即可 |