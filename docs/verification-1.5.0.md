# 1.5.0认证真值与私有云盘工作区验收

日期：2026-11-14（Asia/Tokyo）。本记录不包含账号、资料库ID、令牌或真实课程资料。

## 结果与范围

- 配置、账号、Cookie/Token存在和浏览器打开不再构成就绪证据。就绪必须有受保护只读接口的核验、来源与时间；网络未知、未核验、明确失效、未登录、模拟分开呈现。状态工具不隐式登录、扫码、进入课堂或调用计费模型。
- 真实持久雨课堂会话已通过受保护接口核验：没有重新扫码不等于没有登录。修复的是无证据也显示就绪，不强制废弃有效旧会话。
- 默认在个人默认资料库固定`/Agent工作区`，不选共享库或公开权限兜底。创建前核验所有权、资料库类型、祖先分享、ACL和公开/下载/上传链接；完整确认绑定账号摘要、资料库及根目录。
- 账号绑定缓存；凭据、绑定与journal不挂进容器。计算与保存独立，pending/failed/unconfirmed不能宣称云端已保存；冲突保留双方，未知写入只读核验，不盲重投。
- 发现并修复集成边界：未初始化新账号不能读取旧账号缓存；首次空缓存列目录能发现云端文件；远端删除、畸形或不完整列表不能被记为同步成功；重启回收不自动上传，回收未确认时不能同步。
- 首次真实小样本暴露真实Seafile对不存在父目录返回404，而Fake返回空列表。仅私有push前置info接纳`CloudError + NOT_FOUND + status404`；认证、网络、403/500及无404的同名错误仍失败，expectedRemoteId检查不放宽。已用生产Client链和真实404式假服务回归。

## 整批与实际操作

`npm run check`：工作区类型检查、构建、全部包测试、436项根测试、5项桌面测试、206条锁定依赖许可证、源码及历史审计、固定范围静态门禁通过。云盘包本轮38项Vitest与46项Node测试通过；没有跳过。

| 实际验收 | 结果 |
| --- | --- |
| 基础Chromium | 60/60；1920、2560、1536、1280、390宽布局与字号、390×640短屏、深色、键盘及控制台 |
| 认证/工作区/流式受控浏览器 | 45+38+28项通过，是真HTTP与Chromium，不是真校园提交 |
| 真Docker闭环 | 12/12；科学计算、实际PDF/ZIP、Node相对导入、非root、禁网、只读根、不传宿主秘密、精确停止与鉴权下载 |
| 原预览部署 | 原8971进程更新至1.5.0，7/7原会话ID保留；实际1920/390宽无横向溢出、页面异常为0 |
| 真实认证状态 | 云盘/雨课堂/MadModel均有受保护证据；网络学堂接口返回UPSTREAM_PROTOCOL，保持unknown，不声称已登录 |
| 真实私有云盘 | 限定默认个人库与固定根初始化成功，分享权限复核仍私有 |
| 真实持久化 | 新验收会话142字节合成文本实际上传，独立全新缓存下载恢复，SHA-256一致，来源cloud-pull且verified |
| 初次失败处理 | 首次缺失父目录404发生在intent/文件发送之前；确认未发送后修复，再执行首个样本上传，没有清除或绕过未知写入锁 |
| 禁止范围 | 0次计费模型调用、0次课堂/作业提交；未删除或迁移旧工作区，未恢复手机实机测试 |

## 实测覆盖率

工具：Node24原生V8测试覆盖率；按表中明确范围汇总，三个维度均以90%为门槛。不是测试通过率，不宣称全仓或每个历史文件都达到90%。

| 声明范围 | 行% | 分支% | 函数% |
| --- | ---: | ---: | ---: |
| 认证9模块：states、keepalive、MadModel的status/auth/client/mcp/server、learnx/hetang编译status | 95.51 | 93.04 | 91.25 |
| workspace/workspace-http/sandbox组合 | 99.67 | 96.77 | 98.13 |
| CloudWorkspaceFiles | 100.00 | 95.82 | 100.00 |
| 云盘编译status/workspace（46项原生测试） | 100.00 | 97.82 | 100.00 |
| 前端[workspace.js](<../webui/workspace.js>) | 100.00 | 99.01 | 95.83 |
| 静态指标工具自身（37项合成测试） | 100.00 | 93.94 | 100.00 |

组合覆盖率复现：

```powershell
node --test --experimental-test-coverage --test-coverage-lines=90 --test-coverage-branches=90 --test-coverage-functions=90 --test-coverage-include=lib/app/workspace.mjs --test-coverage-include=lib/app/workspace-http.mjs --test-coverage-include=lib/app/sandbox.mjs test/app-workspace.test.mjs test/app-workspace-storage.test.mjs test/app-workspace-http.test.mjs test/app-sandbox.test.mjs
node --test --experimental-test-coverage --test-coverage-lines=90 --test-coverage-branches=90 --test-coverage-functions=90 --test-coverage-include=lib/app/cloud-workspace.mjs test/app-cloud-workspace.test.mjs
node --test --experimental-test-coverage --test-coverage-lines=90 --test-coverage-branches=90 --test-coverage-functions=90 --test-coverage-include=packages/thu-cloud/dist/status.js --test-coverage-include=packages/thu-cloud/dist/workspace.js packages/thu-cloud/test/workspace-storage.test.mjs
```

## 静态指标

工具为项目自定的TypeScript AST函数指标，不是SonarQube/SonarCloud，不是全仓质量认证，也不证明正确性。阈值与范围在计量前固定，未按结果降低或缩窄；现已接入`npm run check`。

- 公式：`round2(100 × cleanFunctions / totalFunctions)`；合格表示环复杂度≤20、控制嵌套≤5、有效代码行≤100、形参数≤5四项同时满足。
- 硬上限分别为50/8/200/8；门禁要求≥90分且无硬上限违规。
- 固定11模块：app的cloud-workspace、workspace、workspace-http、sandbox、states、keepalive，MadModel/status，云盘status/workspace，网络学堂status，雨课堂status。
- 实测：272函数，265合格、7函数超软阈值、0硬上限违规，**97.43分**。不把软阈违规隐藏为零smell。
- 复现：`npm run audit:smells`或`node scripts/audit-code-smells.mjs --json`，输出完整范围、公式、指标与行号。

## 保留的边界

Seafile没有原子CAS；expectedRemoteId只是写前检查。主脚本冻结，模块/数据仍是可变输入。容器不等于防内核漏洞。缓存下载、历史和日志属于已配对设备的本机授权历史，不是SSO多租户隔离或最新云端证据。旧本地数据不自动上传，迁移要显式确认。已有其他MCP客户端须重建连接加载新后端；未强制重启共享连接或手机测试。
