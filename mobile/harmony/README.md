# HarmonyOS 客户端

瘦客户端：配对后由 ArkWeb 加载电脑上运行时的 WebUI，校园登录与模型调用都发生在主机侧。

**当前状态：本机已真实构建通过，产出未签名 HAP（44.6 KB）。** 未在真机或模拟器上安装运行。

## 已通过的构建

```
> hvigor Finished :entry:default@CompileArkTS... after 5 s 89 ms
> hvigor Finished :entry:default@PackageHap... after 1 s 331 ms
> hvigor WARN: Will skip sign 'hos_hap'. No signingConfigs profile is configured in current project.
> hvigor BUILD SUCCESSFUL in 12 s 272 ms
```

产物：`entry/build/default/outputs/default/entry-default-unsigned.hap`（ZIP 头 `50 4B 03 04` 校验通过）。

## 环境（本机实测值）

| 组件 | 版本 / 路径 |
| --- | --- |
| DevEco Studio | 6.0（`C:\Program Files\Huawei\DevEco Studio`） |
| HarmonyOS SDK | `sdk/default/openharmony`，API **22**，`6.0.2.130` |
| hvigor / hvigor-ohos-plugin | `6.22.3` |
| JBR | OpenJDK 21.0.8 |
| 产物 API | `compatibleSdkVersion: "6.0.2(22)"` |

## 构建步骤（照抄可复现）

**关键坑一：hvigor 不支持含空格的路径。** 它自举 pnpm 时会把 `C:\Program Files\nodejs\npm.cmd` 拼进命令，直接失败并给出含糊的 `00308002`。用目录联接消掉空格：

```cmd
mklink /J D:\deveco "C:\Program Files\Huawei\DevEco Studio"
mklink /J D:\nodejs "C:\Program Files\nodejs"
```

**关键坑二：hvigor 默认走 npmjs 源，国内常常装不上 pnpm。** 手工把它要的依赖装进它期望的目录：

```powershell
cd D:\hvigor-home\wrapper\tools   # 里面已有 package.json：{"dependencies":{"pnpm":"10.27.0"}}
D:\nodejs\npm.cmd install --registry https://registry.npmmirror.com
```

**关键坑三：`NODE_OPTIONS` 里的 `--use-system-ca` 会让 DevEco 自带的 node 直接报错。**

然后：

```powershell
$env:NODE_OPTIONS      = ""
$env:PATH              = "D:\nodejs;" + $env:PATH
$env:NODE_HOME         = "D:\nodejs"
$env:HVIGOR_USER_HOME  = "D:\hvigor-home"
$env:DEVECO_SDK_HOME   = "D:\deveco\sdk"

cd mobile/harmony
& "D:\deveco\tools\hvigor\bin\hvigorw.bat" assembleHap `
    --mode module -p product=default -p buildMode=debug --no-daemon
```

或用 DevEco Studio 直接打开 `mobile/harmony` 构建（IDE 会自动处理上面三项）。

## 签名说明

构建成功但**未签名**：`build-profile.json5` 的 `signingConfigs` 为空数组。真机安装需要：

1. 在 DevEco Studio 里 `File → Project Structure → Signing Configs` 勾选自动签名（需登录华为开发者账号）；
2. 或手工生成 `.p12` + `.cer` + `.p7b` 写入 `signingConfigs`。

本仓库不包含任何签名证书。

## ArkTS 严格模式踩到的坑

`hvigor` 的 ArkTS 编译器比 TypeScript 严得多，第一版代码被拒：

- `arkts-no-untyped-obj-literals`：禁止无类型对象字面量。`JSON.stringify({ code, deviceName })` 与 `header: { 'Content-Type': … }` 都必须改成**声明过的接口**或 API 自带的 options 类型。
- `preferences.getPreferencesSync(context, { name })` 的字面量要显式标注为 `preferences.Options`。
- `http` 的 header 直接用 JSON 字符串 `'{"Content-Type":"application/json"}'` 最省事。

编译通过后仍有 15 条 WARN，主要是 `Function may throw exceptions`（`preferences` 调用未包 try/catch）与 `getContext` 已废弃。它们不阻塞构建，但真机验收前建议改用 `this.getUIContext()` 并把偏好读写包进 try/catch。

## 未验证

- **未安装到真机或模拟器**：没有签名证书，也没有启动模拟器。
- **未验证 ArkWeb 渲染真实 WebUI**：需要主机先 `app serve` 并与手机同网段。
- 深链 `thucampus://pair?base=…&code=…` 已打通：`module.json5` 声明 skills，`EntryAbility.onCreate/onNewIntent` 把 `want.uri` 写进 `AppStorage`，`Index.aboutToAppear` 取出并预填配对表单。仅编译验证，未在真机上点开链接实测。

## 目录

```
AppScope/app.json5                             应用级配置（bundleName / 版本 / 图标）
build-profile.json5                            产物 API 22、signingConfigs 空
entry/src/main/module.json5                    权限、深链 skills、入口 Ability
entry/src/main/ets/entryability/EntryAbility.ets
entry/src/main/ets/pages/Index.ets             配对表单 + Web 组件 + 401 回退
entry/src/main/resources/base/…                中文文案、图标、页面清单
```
