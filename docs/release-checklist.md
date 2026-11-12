# 发布清单

一份可以照着执行的清单。**每一项都标注了本仓库是否已经真实通过**，没跑过的写"未验证"，不写"应该可以"。

## 1. 源码与运行时

```powershell
npm ci
npm run build
npm run check            # typecheck + build + 全部单测 + 许可证 + 源码审计
npm run app:smoke        # 真实起进程：配对、元信息、53 工具、一次工具调用
```

| 检查 | 本机状态 |
| --- | --- |
| `npm run check` | ✅ 通过（含 app 运行时/保活/托管模式单测） |
| `npm run app:smoke` | ✅ 通过 |
| 源码审计 0 findings | ✅ |

## 2. 四端产物

```powershell
npm run verify:clients   # 现状报告：缺产物只告警
npm run verify:release   # 发布门禁：缺任一产物即失败
```

| 产物 | 生成命令 | 本机状态 |
| --- | --- | --- |
| WebUI | 无需构建（静态文件） | ✅ 语法与 PWA 清单校验通过 |
| Windows 桌面 | 无需构建（`desktop/launcher.mjs`） | ✅ 单测通过、窗口已实测开启与清理 |
| Android APK | `cd mobile/android; .\gradlew.bat assembleRelease` | ✅ 2.42 MB，v2 签名验证通过 |
| HarmonyOS HAP | 见 [mobile/harmony/README](../mobile/harmony/README.md) | ✅ 编译通过（未签名），**未上真机** |

## 3. 打包

```powershell
npm run bundle            # 源码 ZIP（git archive HEAD）
npm run bundle:prepared   # Windows 便携 ZIP；需要先 browser install
node scripts/verify-prepared.mjs
```

便携包现在**显式断言**包含 `webui/`、`desktop/`、`lib/app/server.mjs`——缺任何一个直接失败，避免"发出去的包只能当 MCP 用"。

| 检查 | 状态 |
| --- | --- |
| 便携包含独立应用前端与桌面壳 | ✅ 脚本断言；CI 每次跑 |
| 便携包含 Chromium 与 node.exe | ✅ 既有流程 |
| `verify-prepared.mjs` | ✅ 既有 |

## 4. 真机 / 跨机验收（未完成）

| 项目 | 是否需要 | 状态 |
| --- | --- | --- |
| Android 装到真机，验证 WebView 加载与配对 | 必须 | ❌ 未做（无设备/模拟器） |
| HarmonyOS 装到真机，验证 ArkWeb 与深链 | 必须 | ❌ 未做（`hdc list targets` 为空，无签名证书） |
| iOS | 可选 | ❌ 未开始 |
| 另一台电脑浏览器配对 | 建议 | ✅ 本机多端口实测过等价路径 |

发布前请务必把上面两个 ❌ 补掉；本仓库的 README 也按此口径描述——只声明"编译通过"，不声明"可用"。

## 5. 已知阻塞与风险

1. **首次校园登录需要图形界面**：`loginCapability.window === false` 的主机无法完成首次登录，只能用 Xvfb/VNC 临时提供显示（见 [托管部署](app-hosting.md)）。
2. **凭据不可跨机器迁移**：会话与浏览器快照由 Windows DPAPI 按当前用户加密。
3. **签名材料不入库**：Android release 的 `keystore.properties` 与本机密钥都在 `.gitignore` 内；换机器要重新生成并妥善保管。
4. **CI 的 Android job 未在本地观察过**：私有仓库，本地只能验证等价的手工命令。

## 6. 提交前

```powershell
git status --porcelain     # 必须为空
npm run check              # 最后一次全量
npm run verify:release
git push origin main
```

提交信息用简洁中文祈使句；一批相关改动一个提交，不要为每个小改动单独开提交或审查轮次。