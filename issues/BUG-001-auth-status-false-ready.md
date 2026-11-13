# BUG-001: [服务登录态] — 检查未核验回执 — 显示“已就绪”

- **Reporter:** 用户报告，lead整理
- **Date:** 2026-11-14（Asia/Tokyo）
- **Severity:** High
- **Reproducibility:** 归一化最小样本Always；用户真实页面观察一次，在线认证真值另行只读核对

---

## Summary

用户报告雨课堂在实际未成功扫码进入时显示“已就绪”。在1.4.0中，以明确标记为未验证的状态回执作为输入，也可稳定得到ready；其他服务的同类回执需要一起核对。

## Expected Behavior

“已登录/已就绪”应对应受保护接口核验成功的实际认证状态，而不是仅存在本地配置、账号字段、Cookie/Token或已打开登录窗口。未验证、网络无法核验、明确未登录和已过期应分别表达。已有持久会话若在线有效，可以复用，不要求每次重新扫码。

## Actual Behavior

用户观察雨课堂未完成实际登录时，服务列表仍显示“已就绪”。独立最小复现中，`sessionValidity: "unverified"`或`"unknown"`与配置字段同时存在时得到ready；仅账号占位也得到ready。测试未读取凭据、未清除登录资料、未触发扫码。

## Reproduction Steps

**Prerequisites:** 版本1.4.0，提交`f972905`，Node.js≥22；无需学校账号或真实凭据即可运行最小复现。

1. 检出该版本，进入仓库根目录。
2. 执行下述Node命令，保持状态对象原样。
3. 观察三项结果都为ready。
4. 页面层复现由用户报告：打开独立应用“服务”页，在雨课堂没有实际完成登录时观察其状态标签。不要通过注销、删除凭据或进入真实课堂来重现。

### Minimal Reproduction

```powershell
node --input-type=module -e 'import {stateOf} from "./lib/app/states.mjs"; for (const x of [{configured:true,sessionValidity:"unverified"},{authentication:{configured:true},sessionValidity:"unknown"},{account:"<REDACTED>"}]) console.log(JSON.stringify(x)+" => "+stateOf(x));'
```

## Environment

### Toolkit & Agent

| Detail | Value |
| --- | --- |
| SATK Version | N/A：非SATK项目 |
| Application | thu-campus-mcp1.4.0，main@f972905 |
| Agent / Client | DeepSeek Harness Web GUI，lead |
| Agent Workspace Root | 仓库根目录（Windows本地） |
| MCP Server Mode | 本机持久校园MCP；应用另组合工作区工具 |
| Available MCP Tools | 统一校园MCP53项；本问题涉及learn_status、cloud_status、rain_status、madmodel_status、campus_browser_status、campus_browser_login。复现只使用本地stateOf，不调用写入工具。 |

### Skills

Skills · 24　⊘0　▶1　✗N/A（本项目无SATK清单）

**DSH AI音频** · 6（均有描述，未调用）
- dsh-audiogen-music、dsh-audiogen-sfx、dsh-audiogen-tts、dsh-audiogen-voice-cast、dsh-audiogen-voice-design、dsh-audiogen-voice-management

**其他可用技能** · 18（均有描述）
- ▶filing-bug-reports
- author-modeladvisor-checks、authoring-simulink-inputs、building-architecture-models、building-simulink-models、configuring-block-policy、create-sdi-run、curating-library-kg、diagnose-windows-sandbox-acl、generate-requirement-drafts、gtep-grid-planning、inject-faults、ip-purity-check、komorebi-blog-sync、manage-safety-analysis、matlab-access-datafeed、matlab-add-awgn、reading-documents

### Skill Conflict Analysis

N/A — 本任务仅调用一项技能，无相关技能正文冲突。

### MATLAB

N/A — 与MATLAB/Simulink无关，未启动或查询MATLAB。

### Platform

| Detail | Value |
| --- | --- |
| OS | Windows（process.platform=win32） |
| Architecture | x64 |
| Node | v24.19.0 |
| UI observation | 用户真实页面报告；报告时未提供本缺陷截图 |

## Error Output

无异常抛出；以下为修复前命令的原样输出，账号仅为合成占位符：

```text
{"configured":true,"sessionValidity":"unverified"} => ready
{"authentication":{"configured":true},"sessionValidity":"unknown"} => ready
{"account":"<REDACTED>"} => ready
```

## Visual Evidence

本次用户未附该问题截图，不用其他任务截图冒充证据。修复验收将使用受控未验证/失效/网络失败回执进行浏览器操作，真实在线核验另行记录。

## Impact

- 范围：服务登录状态归一化及依赖它的界面/保活判断。
- 后果：用户可能把未验证的配置当成可用认证，错误判断是否需要登录；“无法联网”也可能被掩盖。
- 临时绕过：明确调用可用的只读在线认证验证，不以界面旧标签证明登录；不以本次没有扫码单独推断已有持久会话失效。
- 不涉及：本报告不证明课程/云盘/课堂业务写入成功，也未执行任何真实提交。

## Related Files

| File | Relevance |
| --- | --- |
| [states.mjs](<../lib/app/states.mjs>) | 状态归一化与四服务探测 |
| [keepalive.mjs](<../lib/app/keepalive.mjs>) | 保活依赖服务状态 |
| [雨课堂服务](<../packages/hetang/src/server.ts>) | rain_status回执 |
| [网络学堂服务](<../packages/learnx/src/server.ts>) | learn_status回执 |
| [云盘服务](<../packages/thu-cloud/src/server.ts>) | cloud_status回执 |
| [WebUI](<../webui/app.js>) | 服务状态标签 |

## Notes

本报告区分用户观察与认证证据，不规定实现方案。后续只读核查确认：旧运行时四项ready均缺少verified/source/checkedAt；Learn与Mad旧回执只有配置摘要，无法证明登录。已有雨课堂保存会话通过受保护basic-info，云盘通过受保护account接口，二者当时有效；所以“本次未扫码”不能证明雨课堂已登出，缺陷是未核验回执也能被归一化为ready。核查未注销、清凭据、进入课堂或调用付费chat。个人云盘Agent工作区属于本批另一项需求，不合并为同一个缺陷。
