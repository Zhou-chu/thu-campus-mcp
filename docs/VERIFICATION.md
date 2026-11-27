# 验证记录

日期：2026-10-25。CI 使用独立临时目录和模拟数据。下述 1.1 的额外真实会话测试使用隔离的加密认证副本，只做登录验证及学期读取，不提交作业、进入课堂或写入云盘。

## 1.2 预设答案与定时提交（2026-10-27）

- 新增 `rain_schedule_answer`，雨课堂19工具，统一入口51工具；原工具名和四客户端配置入口保持兼容。没有新增 npm 依赖。
- 题目/原图读取返回账号、登录代次与内容绑定指纹；登记保存 DPAPI 加密载荷。测试覆盖旧快照、换号、已发布题拒绝登记、并发复用、不同答案冲突和UUID碰撞。
- 注入时钟的单元测试覆盖随机窗口与短截止交集、平台时间来源、重复事件/持久目标不重抽、题目修改、取消、课堂结束、未发布到期、认证变化、检查超时、落盘后时钟跳变、unknown不重试及其他手工请求回执不冒充本任务成功。
- 真实 stdio + 独立 Node 后台模拟测试：登记连接关闭后仍派发一次，首次本地记录为发布后32.812秒，答案B回读一致；另一道取消任务没有作答，只产生一份操作记录。该场景纳入两个 Node CI 的 smoke，每次目标由系统随机数新选。
- 此功能开发没有在学校课堂创建新的作答任务，也未向真实题目提交答案。此前P53临时任务因课堂结束且未发布而停止，没有提交；不能将该临时任务当作正式功能的真实写入验收。
- 独立审查复现并修复两项竞争：登记后启动前的取消不再被初始化覆盖；派发意图落盘后重新读取账号/课堂/题目，防止等待期间注销、改题或课堂结束后继续发送。四项回归均观察先失败再通过。
- 首次1.2 CI的两组功能测试均通过，来源审计因本地CRLF哈希与Git规范化LF不一致而失败；修正唯一受影响的雨课堂package.json来源哈希，保留原字节审计和全部检查，按修复后的精确提交重新运行CI。
- 本版检查包含类型/构建、172项单测、206条许可、来源/历史密钥审计、所有 smoke 与便携包搬迁验证；远端结果以对应提交的 [CI](https://github.com/Zhou-chu/thu-campus-mcp/actions/workflows/ci.yml) 为准，学校凭据不进入 CI 或产物。

## 2026-10-27 实时课堂与未发布题预览

- 现场官方学生页面证据确认 checkin 必须有 source:1；响应 set-auth 和 WebSocket lessonToken 各自承担不同会话用途。HTTP bearer 仅保存在原有 DPAPI 课堂记录中。
- source、跨进程 bearer、hello 历史快照、直播课件过滤、重放不延长已关闭期限、并发 checkin 不串用 bearer 均有先失败再通过的回归。
- 新增只读 includeUnpublished 显式选项：默认仅已发布，预览保留发布标记并删除未发布题答案；提交未发布题仍返回 NOT_PUBLISHED。模拟测试和当前账号3张题目原图实测通过。
- 当前已下发课件实测含3题：2已发布、1未发布；已发布课件14页图片合成14页PDF，全部15个课件清单文件SHA256核验通过；另导出3题Markdown/JSON、3张原图和3页习题PDF。个人课堂内容仅留本机，未导入仓库。本次未提交答案或写入云盘。
- 本地148项测试通过（浏览器3、雨课堂35、网络学堂60、云盘38、统一入口12），类型/构建、206条许可、来源审计和全部 smoke 通过。
- 预览范围为当前学生端已下发、已加载的课件；不证明教师未来新增课件或多份课件切换后的历史习题完整性。课堂尚未结束时，资源 scope 为 published-live-snapshot，不冒充课后完整资源。

## 1.1 独立浏览器与统一入口

- 本地检查通过 141 项测试：浏览器 3、网络学堂 60、云盘 38、雨课堂 28、统一入口及安装 12；类型、构建、206 条依赖许可与来源审计通过。
- 实际下载项目内 Chromium revision1248 / Chrome for Testing156.0.8078.4，默认登录与课堂截图已不依赖系统 Edge。
- 真实独立浏览器访问本地模拟站点，关闭重开后保留 session-only Cookie、localStorage、IndexedDB，并验证快照加密和互斥使用。
- 统一 stdio 握手发现 50 个工具，原 46 个工具、返回数据和雨课堂 Prompt 正常转发。安装测试覆盖5处配置，认证/输出路径保留、其他设置保留、重复安装、未知所有者阻止写入。
- 使用当前用户的加密认证副本，在独立 Chromium 中成功验证网络学堂和雨课堂登录，原三个认证文件未改变。
- 将隔离副本的网络学堂 API Cookie 清空并写入无效 CSRF，再经统一 MCP 查询学期，成功从保留的浏览器会话无界面恢复；查询成功、无效 CSRF 已替换、账号保持一致。
- 此结果证明可复用和恢复有效浏览器会话，不证明学校强制过期后永远无需验证。云盘首次网页登录仍需按其正常学校登录流程完成；真实课堂写入限制不变。

额外回归覆盖注销与恢复竞争、旧客户端直接替换认证文件、重复安装保留 Harness 禁用/超时设置、不同浏览器目标返回占用；真实内核另测程序关闭和浏览器直接关闭时不回退新状态。

已生成 Windows x64 便携 ZIP，完成包内状态/许可审计。将完整 ZIP 解压到含中文和空格的不同路径，PATH 排除系统 Node；使用包内 Node 发现 50 个工具，并用包内 Chromium 完成 Cookie、localStorage、IndexedDB 及直接关闭回归测试。该搬迁验证同时纳入 Node 24 CI。远端结果以对应提交及 Actions 产物为准，使用者浏览器资料始终不进入分发。

实现提交 `fc0dd5b67edd9197df41d0936fb5560cb81e986e` 的 [CI](https://github.com/Zhou-chu/thu-campus-mcp/actions/runs/40168924652) 已全部成功：Windows Node 22/24，Node 24 另完成便携 ZIP 构建、搬迁验证及上传。四个本机客户端的5处配置已合为一个 `thu-campus`，逐配置 stdio 握手均发现50工具，网络学堂学期、云盘资料库和雨课堂课程只读查询均成功；DeepSeek Harness 3199 热重连显示 connected、50工具。重复安装不再产生配置改动。网络学堂和雨课堂已在新的用户持久浏览器中复用验证；云盘原API会话正常，新浏览器需要首次网页登录。

## 来源项目的验收范围

- learnX MCP：提交 `8d9fcd3`，53 项测试；历史真实验收包含课程同步、一次个人在线作业单次上传与状态回读及附件回下载哈希核验。
- thu-cloud MCP：提交 `991aa55`，38 项测试；历史真实验收包括云盘上传、下载及哈希核验。
- hetang MCP：提交 `6d365e4`，28 项测试；历史真实验收读到 35 门课程，60 张图片加 3 份 PDF 共 63 个文件成功归档云盘，另有修复后 3 文件上传及回下载哈希核验。

这是来源项目的验收，不替代每台机器、每个账号在当前平台版本上的验证。原始账号验收数据和资源没有导入本仓库。

## 整合包验证范围

- 单一 npm workspace 锁文件，三个模块的类型检查、构建和全部单测。
- 根 CLI 在仓库外调用、未知服务错误、真实模式配置导出、包内相对云盘路径。
- 三模块安装全预检；后一个模块冲突时前面的模块不写配置。
- 独立审查发现的自定义云盘认证目录遗漏已修复：配置导出、三服务统一安装及雨课堂单模块安装均保存云盘目录，回归先失败再通过。
- 原模块完整 stdio smoke，以及搬迁到含空格/中文路径后的统一入口握手，共 46 个工具。搬迁 smoke 共享已安装依赖；GitHub CI 干净检出及 `npm ci` 验证自包含安装。
- 来源文件哈希、npm 许可清单、源码及已提交 Git 历史的密钥模式扫描。
- Windows Node 22/24 GitHub Actions，生成源代码 ZIP 与 SHA256。最终结果以对应提交的 Actions 页面为准。

首次 CI 中 Node 24 通过，Node 22 在网络学堂后台同步 smoke 失败。Windows 并发读取状态文件的本机复现返回 `EPERM` / `rename`；网络学堂原有原子写入没有重试。现增加仅针对 Windows 共享冲突的有界本地 rename 重试，3 项回归验证短暂冲突恢复、其他错误不重试及永久失败保留旧文件。该重试不会重放任何学校或云盘请求。

## 整合包实测结果

实现提交 `1f856cf9f03e38d8b0200e868588010357686b45` 的 [GitHub CI](https://github.com/Zhou-chu/thu-campus-mcp/actions/runs/40161473837) 已完成：Windows Node 22 与 Node 24 两个 job 全部成功，包含干净安装、检查、端到端、源代码打包及产物上传。

检查共 **127 项测试**：网络学堂 56、云盘 38、雨课堂 28、整合入口 5。类型检查、构建、206 条依赖许可记录与源码/历史密钥扫描均通过；端到端验证 46 个工具。CI 产物分别包含源码 ZIP 和 SHA256 文件，私有仓库权限已核对为 PRIVATE。

文档提交之后的最新状态以 [CI 工作流](https://github.com/Zhou-chu/thu-campus-mcp/actions/workflows/ci.yml) 为准。旧失败运行保留，修复后的提交不通过重跑旧代码来掩盖问题。

## SonarQube 与统一覆盖率接线（2026-11-15）

- CI 新增 main 专用 `sonar` job（`needs: verify`，仅 `refs/heads/main` 的 `push` 或 `workflow_dispatch`），令牌只存 GitHub Actions Secret，且只注入扫描那一个 step；job 权限只有 `contents: read`、`actions: read`。本批切换 Sonar 侧 Automatic analysis 为关闭，待对应提交的真实 CI 分析复核，不将本地测试或旧 analysis 当作新扫描结果。机制与入口见 [SonarQube 接入](sonarqube.md)。
- 覆盖率改为一次运行产出两套报告：`coverage/unit/`（Node `node:test` 单测快照 + 3 个 SDK 的 vitest）与 `coverage/`（再叠加 4 个真实浏览器 E2E 与 `webui` 浏览器侧命中）。两套都按 8 个源码根统计，未被命中的生产文件由 `zeroFile` 补 0，没有删分母；`npm run coverage:check` 对两套分别校验 lines / statements / branches / functions ≥ 90。
- 首轮实测（本机 `npm run test:coverage`）：unit 115 个文件、行 11,359/17,112 = 66.38%、语句 64.09%、函数 70.79%、分支 72.45%；combined 行 13,189/17,112 = 77.07%、语句 73.59%、函数 71.64%、分支 74.59%。**四项全部低于 90%，门槛未达成**，两套 manifest 均为 `collectionComplete: false`。
- 不完整的原因：`test/design-guardrails.test.mjs` 有 3 个设计守卫用例失败，分别是 CSS 六色硬编码、`--chat-width` fallback、metaTheme 旧期待；因此这批产物会被 CI 的完整性校验拒绝，不会进入 Sonar 扫描。本轮源码冻结，修守卫与新补单测放另一批，首轮数字按原样留档，不用重跑结果替换。
- 同轮通过项：3 个 SDK 的 vitest 共 178 项通过；4 个真实浏览器 E2E 全过（`e2e-web`、`e2e-streaming`、`e2e-workspace`、`e2e-auth-workspace`），其中 `e2e-web` 用 `http://evil.invalid` 验证页面不会把旧 `Authorization` 发往外部地址。
- 静态检查（本机，不是 Sonar 口径）：源码审计 373 个文件、738 个历史 blob，findings 为空；项目自定义 smell 门槛固定在 11 个模块、272 个函数，其中 265 个函数无阈值违规、评分 97.43、无硬上限违规。两者都只覆盖各自写死的范围，不替代 SonarQube 评分或人工审查。
- 历史各批的单批模块 V8 覆盖率（审批卡 60/60、侧栏 52/52 等）口径为单批纯逻辑模块，与本次 runtime+SDK 全范围**不可比**，不作为整体覆盖率或达标证据。
- 依赖：许可记录 264 条（[dependency-licenses.json](dependency-licenses.json)）；依赖审计由维护者执行并报告 0 漏洞，本文档未复跑该项网络审计。

## 移动端（Android 已构建，HarmonyOS 不在 CI 门禁内）

- Android 纯 JVM 单测 29 个用例 / 0 失败（`HostPolicyTest`，不联网、不做 DNS 解析、不需要模拟器），debug 与 release 构建均真实通过，release 包 `apksigner verify` 通过；证据与产物尺寸见 [Android 工程说明](../mobile/android/README.md)。**未做真机验证**，手机实机验收仍暂停。
- CI 的 `android` job 跑 `:app:testDebugUnitTest :app:assembleDebug`，远端结果未取；发布门禁 `verify-clients --strict --require webui,desktop,android,runtime` 不含 HarmonyOS，因为 CI 无 DevEco 工具链，四端中的 HarmonyOS 只能在本机验证。

## 2026-11-15 最终补测批（本机）

- `test:coverage` 与原 `coverage:check 90` 均退出 0。unit：行 92.83%、语句 90.76%、函数 92.26%、分支 90.58%；combined：93.20% / 91.08% / 92.32% / 91.60%。统计范围仍为 115 个 runtime+SDK 文件，不等于 Sonar 全源码范围。
- 两套 manifest 完整、errors 为空，均保留 resources.ts 的一个 V8 负计数保守归零警告。归并不修改原始共享输入；构建、SDK 全量、原生单测、4 个真实浏览器 E2E 全部阶段退出 0。
- HTTP/前端/审批时钟/采集器分组 71/71 通过；`typecheck`、264 条许可、来源审计、`npm audit`（0 漏洞）通过。固定 11 核心模块的自定义 smell 为 97.43（265/272，无硬违规），不是 Sonar 评分。
- 隔离模拟预览的桌面 1707×876 与窄屏 398×806 无横向溢出；审批从待审批到允许并得到模拟工具完成回执。不接真实账号、不调用计费模型。
- 鸿蒙手机通过笔记本 SSH/HDC 已连接，但安装未签名包返回 `9568320: no signature file`；用户暂缓开发签名，因此尚无应用运行验收。详见 [Harmony 工程说明](../mobile/harmony/README.md)。
- Sonar Automatic analysis 已关闭；本地通过不等于远端 CI 或 Sonar 通过，本批提交后的结果以精确 revision 为准。

## 2026-11-15 CI实扫与第二批整改

- [CI 43688282359](https://github.com/Zhou-chu/thu-campus-mcp/actions/runs/43688282359)对应943e20e；Node 24全job通过（含原90%门禁、4个真实浏览器E2E、smoke与便携包搬迁验证）。该run的整体结论仍是failure，不写成CI已通过。
- Node 22失败集中于浏览器测试夹具的原路径/realpath比较；现夹具使用仓库QA目录及精确规范路径，普通浏览器/CLI入口复测退出0；后端排序及关闭通知分组31/31通过。未运行真实PowerShell、Chromium或外部校园请求。
- Android缺JUnit BOM 5.9.2/5.9.3的.module校验，已按Maven Central原文件、官方SHA256及缓存三方核对后精确补齐。隔离Gradle缓存严格模式debug构建与强制刷新classpath解析均退出0；单测当次为UP-TO-DATE，不冒称29例重新运行。锁文件未变。
- 首轮Sonar analysis `82a3b79a-c03a-4f9a-9adc-9353bea5306d`精确匹配943e20e，LCOV被真实导入，整体覆盖85.9%、新代码65.3%，CODE_SMELL为0、可维护性A。质量门因新可靠性/安全/覆盖而红；四条误报已分别留证并回读。
- 扫描器忽略旧sources/tests/test.inclusions参数，首轮测试排除造成分析遗漏。第二批恢复测试分析、额外生成19个scripts文件的真实tooling LCOV；原115个runtime+SDK文件的unit/combined范围及四指标90%阈值不变。测试分类及恢复后的发现必须由下一次实扫确认。
- 四套报告均加入源码/报告哈希、LCOV清单、结构和重新计算摘要校验；tooling的unit raw快照带逐文件哈希并验证为combined raw的未修改子集。采集器两文件窄测22/22通过；仅三个采集脚本的c8窄测行/语句99.81%、函数98.21%、分支91.52%，不能当19脚本或115文件整体验收。

### 第二轮远端结果与第三轮分类修正

374d071的CI 43691394033中Node 22、Node 24、Android全部成功，上传前及Linux下载后的严格报告校验通过。Sonar analysis e375726e-4890-480b-ad43-f39e38aa6c8c精确匹配该提交，可靠性/安全/可维护性均A；质量门仅新覆盖35.3%失败。382文件均索引、两LCOV均消费，但测试误计生产覆盖；37个CODE_SMELL全部来自HostPolicyTest中的IP策略输入，规则API确认S1313只适用MAIN。

已找到独立于Automatic Analysis的Scanner automatic configuration Beta：项目值原为true，官方文档证实它会忽略显式测试分类。第三批在项目UI和版本化配置关闭该项，公开API回读两项自动开关均false；sources/tests全仓候选，按测试模式分MAIN/TEST，测试仍接受TEST规则分析。新增配置防回退测试；不新增测试/覆盖排除、不改规则门禁或基线。实际角色和37项复算仍待下一精确提交实扫，不以保存设置冒充修复成功。

## 当前限制

真实认证只支持 Windows DPAPI，新机器需要本机登录。CI 不包含学校凭据。

没有活跃雨课堂用于真实课堂进入或答案提交，相关路径只有协议与模拟验证。后台监控不调用模型；持续解新题需要 Harness 保持运行，已登记的固定答案任务可独立执行。历史验收课堂没有可用回放，真实回放/附件下载受返回与权限限制；只返回共享文件计数时不展开附件。

网络学堂讨论/答疑详情仍报告部分验收；组作业、离线作业等不在通用提交路径中。上传通用回执仅验证服务器元数据，不代表远端文件字节校验。

原本机三个独立项目保留；安装遇到不同路径的同名服务会停止。配置写入逐文件处理，不承诺跨文件事务。

## 2026-11-28 issue 收尾批次（#160–#174）

- 关闭 #156–#169、#172、#173 等一批 issue；#167/#170/#171/#174/#166 仍开放（需要真实账号或真实校园验收）。
- 浏览器任务：跨进程租约（`browser-lease.json`）覆盖 worker、座位会话、体育读取、体育预约窗口与 MadModel 登录窗口；`GET /api/jobs` 可查排队位置、`POST /api/jobs/<id>/cancel` 可取消；`reapInterruptedJobs()` 把死进程任务落盘为 `interrupted` 并释放租约。
- 统一登录：`POST /api/account/login` 一次编排 learnx/seat/sports/cloud/hetang/madmodel，逐服务归因（`ready/needs-manual/busy/unavailable/not-configured/queued/timeout/failed`），单服务 120 秒超时，界面按状态渲染并跟随 worker 任务进度（刷新后仍可续跟）。
- 身份代际：账号变更/清除时递增代际并回收校园站点 Cookie 与网络学堂授权；契约见 `docs/identity-lifecycle.md`。
- 座位链路 HTTP 化：规则、CAS 登录（SM2）、只读查询、预约、取消全部走普通 HTTP，浏览器只在无法建立会话时回退。真实 CAS 校验：不存在的账号返回官方「您的用户名或密码不正确，请重试！」，0.2 秒、无浏览器。
- 门禁（最终）：全量单测 **1149 项**通过；分层规则 5 条通过；真实 Chromium `e2e:seat-cancel` 18 项、`e2e:session-journey` **39 项**、`e2e:auth-services` 13 项通过；`packages/thu-cloud` 260 项、`packages/hetang` 365 项包内测试通过。
- 部署实例 `a3a5c62`：`/healthz` 200、`/api/seat/rules` 200（3.6 秒，真实规则）；真实设备令牌走查服务页 7 行正常、无控制台异常、420px 无溢出。
- **未冒充验证**：#171 的成功登录路径、#174 的预约窗口闪退原因、#166 的真实账号总验收，都需要用户本人操作；仓库内只有失败路径与夹具证据。

## 2026-11-25 上游 issue 批次与运行日志

- 关闭 #136–#141：默认账号目录回退、CAS 二次验证提前识别、座位 bookings 注入与多时段、体育预约锁/token/窗口回收、工具调用移入设置、可选调试日志。
- 门禁：`npm run test:bundle` 通过；单测行 94.41%、分支 90.11%；smells 门槛通过；真实 Chromium `e2e:web` 105 项、`e2e:workspace`、`e2e:auth-workspace`、`e2e:stream`、`e2e:auth-services` 7 项均通过。
- main `4536c9f` 的 CI（Node 22/24、Android、Sonar）全绿；生产 8973 已部署并 `/healthz` 200。
- 生产复测：`GET /api/seat/bookings` 返回 503 `SEAT_CLOSED`（不再是注入缺失的 500）；取消接口未带确认时 428；体育预约历史返回真实场馆/时间/状态；调试日志开启后 `/api/meta` 入日志、无 Cookie 泄露，关闭后停止写入，清空后 0 字节。
- 未冒充验证：#137 没有全新设备账号，未做真实二次验证；#139 未执行真实下单（会计费）；#141 仅覆盖 HTTP 与 MCP 工具调用，浏览器步骤、定时任务与未捕获异常未采集。
