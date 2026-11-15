# SonarQube Cloud：公开项目接入

## 2026-11-15 第二轮远端结果：374d071

[CI 43691394033](https://github.com/Zhou-chu/thu-campus-mcp/actions/runs/43691394033)的Node 22、Node 24和Android全部成功。Windows上传前、Linux下载后的四套严格报告校验均通过，两个LCOV真实消费。不可变覆盖产物ID为14152058777，SHA256为6465c01fa9f6dd6a6efc53bdd16481a02047c65b167afb99a8aa7197fcc6bd31。

Sonar analysis `e375726e-4890-480b-ad43-f39e38aa6c8c`精确匹配374d071，可靠性/安全/可维护性均A、重复1.3%、热点100%；质量门只因新覆盖35.3%失败。分析恢复到382文件，但SDK测试被算进未覆盖生产行。37个开放CODE_SMELL均在HostPolicyTest.kt，且[规则API](https://sonarcloud.io/api/rules/show?organization=zhou-chu&key=kotlin:S1313)确认kotlin:S1313只适用MAIN；未批量改37项状态。

根因为项目另开了`sonar.scanner.autoconfig.enabled=true`，不是已关闭的Automatic Analysis。[官方CLI文档](https://docs.sonarsource.com/sonarqube-cloud/analyzing-source-code/scanners/sonarscanner-cli#automatic-configuration-scope-and-fine-tuning)明确该Beta忽略显式source/test分类参数，并允许既有项目关闭它。第三批仅修正分类：项目UI与版本化配置均关闭，API回读两个自动开关均false；sources/tests全仓候选，按测试模式划分TEST，保留产物排除、两个LCOV、原门禁与基线。配置回归3/3通过；未变生产源码的原覆盖门禁、完整性和来源审计仍通过。正确TEST角色、37项自然复算及覆盖必须经下一实扫确认，不能以设置已保存代替成功。

该run不可变产物的真实unit行/语句/函数/分支为92.78% / 90.71% / 92.20% / 90.52%，combined为93.14% / 91.03% / 92.26% / 91.55%，原115文件八项门禁均过。新增19文件tooling的unit行为39.26%、combined行为77.22%，仍如实低于90%。产物报告哈希及Istanbul重算摘要另经本地回读验证，未修改CI正式字节校验。

跨环境下载对照还发现本地4个旧文件共7处零散CRLF；仅LF规范化后的字节与CI源哈希精确相同，Git属性为eol=lf且工作区干净。正式CI仍校验真实checkout字节，未改哈希算法或放宽验证。

## 2026-11-15 首轮CI实扫证据（第一轮留档）

- 提交 `943e20e624b680da8482f5c5d7da4b8877f4d42d`，对应 [CI run 43688282359](https://github.com/Zhou-chu/thu-campus-mcp/actions/runs/43688282359)，Sonar analysis `82a3b79a-c03a-4f9a-9adc-9353bea5306d` 的 revision 精确匹配。Automatic analysis 已关闭；CI确实读取同一run的combined LCOV，未报路径解析失败。
- Node 24全job成功，包括覆盖门禁、4个真实浏览器E2E、smoke、源码/预备便携包与搬迁校验。远端unit行/语句/函数/分支为92.78% / 90.71% / 92.20% / 90.51%，combined为93.14% / 91.03% / 92.26% / 91.54%，两套完整且errors为空。
- workflow整体失败：Node 22普通测试入口中浏览器夹具原路径与规范路径比较失败；Android严格依赖校验缺JUnit BOM 5.9.2/5.9.3的.module记录；Sonar质量门失败（新可靠性D、安全B、新覆盖65.3%）。本地修正必须经下一提交的CI复验，不把这些失败写成通过。
- Sonar实际指标：整体覆盖85.9%，CODE_SMELL=0、可维护性A（非数值评分）；11个BUG，安全问题另逐项复核。自定义smell评分仍单独注明工具、固定模块范围与公式，不冒充Sonar分数。
- **范围警告**：扫描器明确说新analysis scope UX忽略`sonar.sources`、`sonar.tests`和`sonar.test.inclusions`；因此首轮配置中的测试排除造成了分析遗漏。下一批必须去掉测试排除、恢复测试分析，并确认实际索引后再比较问题闭合数量。不能用首轮计数缩小当作全范围闭合。
- 下一批另从同次真实V8 raw生成工具脚本LCOV，不缩runtime+SDK原两阶段范围、不放宽90%门禁、不调整Sonar质量门或Previous version基线。

### 第二批本地整批复验（2026-11-15，待对应提交远端复扫）

`test:coverage`、原`coverage:check 90`、新增`--verify-reports`均退出0。四套manifest完整、errors为空，unit/combined仍各保留一个V8负计数保守归零警告；tooling无警告。

| 阶段与明确范围 | 行 | 语句 | 函数 | 分支 |
| --- | --- | --- | --- | --- |
| unit，原115个runtime+SDK文件 | 92.83% | 90.76% | 92.26% | 90.58% |
| combined，同115文件 | 93.20% | 91.08% | 92.32% | 91.61% |
| tooling/unit，额外19个scripts文件 | 39.26% | 39.26% | 86.13% | 88.33% |
| tooling，额外19文件单元+真实E2E | 77.22% | 77.22% | 86.97% | 88.65% |

原八项90%门禁全部通过；新增tooling报告不冒充90%，未执行脚本保留零覆盖分母，不拿三脚本99.81%的窄测替代19文件结果。四套报告校验源码、LCOV全清单、raw快照/子集与机器报告哈希，且重新计算摘要一致。类型、264项许可、395文件/845历史对象来源审计通过；固定11模块自定义smell实测97.44，无硬违规。

下方接入准备及本地历史记录保留作审计；其中“未实扫”等历史描述不代表本节已发生的CI结果。

## 已核实的实际配置

| 项目 | 值 |
| --- | --- |
| 服务及区域 | SonarQube Cloud EU，https://sonarcloud.io |
| GitHub仓库 | https://github.com/Zhou-chu/thu-campus-mcp ，public |
| Sonar组织键 | `zhou-chu` |
| Sonar项目键 | `Zhou-chu_thu-campus-mcp` |
| Sonar项目可见性 | **public**，已用不带登录态的API验证 |
| 分析链路 | 2026-11-15 已关闭 Automatic analysis，并回读开关为 false；改为可信 main CI 分析 |
| CI 扫描 | `.github/workflows/ci.yml` 的 `sonar` job，仅 main；令牌存 Actions Secret `SONAR_TOKEN`。本批提交后以对应 run/analysis 实测，不提前报通过 |
| 质量结果入口 | https://sonarcloud.io/dashboard?id=Zhou-chu_thu-campus-mcp&branch=main |

此前GitHub仓库虽然已公开，但Sonar项目仍是private，后台报告因组织私有项目50,000 LOC上限被拒收。2026-11-14已仅将本Sonar项目切换为public；未改其他项目、套餐、质量门、new-code定义或源码排除。公开项目不占私有LOC额度，不能继续把这次阻塞当成公开项目的50k限制。

## 分析与验收

1. main提交后由 CI 的 `SonarQube Cloud / main` job 分析；旧 GitHub App 自动分析已关闭。不得把已取消的旧检查、仅报告上传成功或本地AST评分当成当前提交通过质量门。
2. 核对最近分析的revision与待验收提交一致，再读取该analysis的质量门和真实issues。质量门失败就按真实问题分批修复、提交复扫，不为变绿裁剪源码、扩大排除或重置new-code基线。
3. 旧 Automatic analysis 不提供测试覆盖率。CI 现在上传 combined LCOV，unit LCOV 独立用于门禁；只有真实 analysis 消费成功后才算远端接入完成。历史各批“单批纯模块 V8 覆盖率”与 runtime+SDK 全范围不可比，不得当整体达标证据。
4. 2026-11-15 已在 Analysis method 关闭 Automatic analysis 并回读确认。`SONAR_TOKEN` 只存 GitHub Actions Secret，不入仓库、日志或聊天；登记有效期为 30 天、2026-12-14 到期，过期须在后台轮换并同步更新 Secret（本文件不记录令牌值、前缀或长度）。
5. 本仓库为公开项目，匿名API可以查询项目、分析与质量结果；修改设置仍需有权限的本人登录。公开状态变化必须回读验证，不以GitHub可见性替代Sonar可见性。

## 不带令牌的核对入口

- [项目元数据与public状态](https://sonarcloud.io/api/components/show?component=Zhou-chu_thu-campus-mcp)
- [最近分析及revision](https://sonarcloud.io/api/project_analyses/search?project=Zhou-chu_thu-campus-mcp&ps=1)
- [当前质量门](https://sonarcloud.io/api/qualitygates/project_status?projectKey=Zhou-chu_thu-campus-mcp)
- [真实问题列表](https://sonarcloud.io/project/issues?id=Zhou-chu_thu-campus-mcp)

“可访问/配置成功”和“当前源码质量门通过”分别验收；首次结果尚未产生时不能报通过。

## 2026-11-14 首扫基线（历史；代码已改，远端未复扫）

- 后台任务`AaHZoK5mgdnaIrRUmS1-`为SUCCESS；analysis为`c6a7769c-cfc3-498d-9648-4d6880dba68b`，revision精确对应`5ae6d8ba4bdc0d70535e81949125514c874b0a5d`。
- 绑定默认Sonar way，新代码定义Previous version保持原值；[该analysis的质量门](https://sonarcloud.io/api/qualitygates/project_status?analysisId=c6a7769c-cfc3-498d-9648-4d6880dba68b)返回NONE、没有判定条件，**不是通过**。

| 首扫指标 | 实测 |
| --- | --- |
| 有效源码行/文件 | 37,691 / 231 |
| Sonar报告Bug | 4 |
| Sonar报告漏洞 | 25 |
| Sonar报告Code Smell | 34 |
| 开放问题合计 | 63；经典严重级别含2 BLOCKER、4 CRITICAL |
| 重复行密度 | 3.5% |
| 可靠性/安全/可维护性评级 | D / E / A |
| 覆盖率 | 无数据；未上传LCOV，不写成0%或100% |

优先复核Sonar标记的两项会话路径遍历流（[sessions.mjs:34](../lib/app/sessions.mjs#L34)、[sessions.mjs:101](../lib/app/sessions.mjs#L101)），再核实弱哈希的实际安全语义（[protocol.mjs:5](../lib/madmodel/protocol.mjs#L5)）及三处排序比较规则（[classroom.ts:28](../packages/hetang/src/classroom.ts#L28)、[jobs.ts:361–362](../packages/hetang/src/jobs.ts#L361-L362)）。这些是**扫描器发现，不等于已人工确认可利用**；不能未检查输入校验/调用链就批量忽略，也不能机械改排序或哈希造成业务行为变化。

上表是**首扫当时**的结果，只能当历史基线读：

- 该 analysis 的 revision 是 `5ae6d8b`，与当前工作树不是同一份代码；之后已有一批代码侧整改被冻结在工作树里，但**没有 push、没有触发远端复扫**，所以上面 63 条不能再说成“当前未修复问题数”，也不能反过来说成“已全部修复”。
- 要更新这张表，只能等新提交在 Sonar 上产生新 analysis，再按 `revision` 精确对应着读质量门与 issues；不得用本地静态评分、本地测试通过或“只差签名/只差网络”之类推断替代。
- 本次仍未完成 CI 覆盖率接入的**远端**部分（见下两节）。

## main 专用 CI 分析（已写入，未实扫）

`.github/workflows/ci.yml` 的 `sonar` job：

- 触发：`needs: verify`，仅 `refs/heads/main` 且 `push` 或 `workflow_dispatch`；PR 不跑，避免未合入代码污染 main 基线。
- 权限：job 级只有 `contents: read` 与 `actions: read`；`SONAR_TOKEN` 只注入扫描那一个 step 的 `env`，不进入 checkout、构建或任何日志。
- 流程：`npm ci --ignore-scripts`（不下载浏览器）→ 下载同一提交的 `sonar-lcov` 产物到 `coverage` → 校验 `coverage` 与 `coverage/unit` 两个目录的 `collectionComplete` 为真、`errors` 为空、`lcov.info` 含 `SF:` → `SonarSource/sonarqube-scan-action`（固定 commit SHA）带 `-Dsonar.qualitygate.wait=true`、超时 300 秒。
- 为什么先验完整性：采集侧一旦不完整，这一步直接抛错，扫描不执行。半截报告不会变成“覆盖率低”，更不会变成“通过”。

分析范围与覆盖率范围是两件事，不许混说：

| 口径 | 范围 |
| --- | --- |
| Sonar 分析 | [sonar-project.properties](../sonar-project.properties)：`sonar.sources=.` 加排除项 `**/node_modules/**`、`**/dist/**`、`**/.local/**`、`coverage/**`、`**/build/**`、`**/.gradle/**` 以及测试目录/测试文件；测试另由 `sonar.tests` 列出 `test`、`desktop/test`、`packages/*/test`。源码与测试不重叠（同一文件不能既当源码又当测试），但两边都仍被分析：基线里 `scripts/` 有 15 条、`test/` 有 1 条真实发现，所以没有把有问题的目录整段排除 |
| 覆盖率 | `scripts/coverage.mjs` 的 8 个源码根：`lib`、`bin`、`webui`、`desktop`、`packages/browser`、`packages/{hetang,learnx,thu-cloud}/src`。`scripts/`、HTML/CSS、`mobile/` 原生平台工程都不在内 —— 这是范围缺口，不是“全仓覆盖率” |

- 源码映射：3 个 SDK 的 `tsconfig.json` 都是 `"sourceMap": true`；native 侧用 `--enable-source-maps`，经 `v8-to-istanbul` 转换后用 `UNVERIFIED_SOURCE_MAP` 校验每个文件必须映回同一仓库相对路径；浏览器侧用源码哈希比对（`BROWSER_SOURCE_MISMATCH`、`SOURCE_CHANGED`）。对不上就报错，不静默丢弃。
- 两个 phase 各自过 4 项 90：`npm run coverage:check`（`node scripts/coverage.mjs --check 90`）对 unit 与 combined 分别校验 lines / statements / branches / functions，并要求 manifest 完整、源码哈希未变、每个源码文件都出现在 summary 里。
- 本地复现（不跑 Sonar）：`npm run test:coverage` 生成两套报告（会真开浏览器跑 E2E）；`npm run coverage:check` 只读已有报告做门槛判定，采集不完整时会报 `<phase>:collection/source-integrity` 这类键。本地不执行 Sonar 扫描——扫描令牌只存在 Actions Secret 里，本地既没有也不该有。
- 为什么 Sonar 只消费 combined：`sonar.javascript.lcov.reportPaths=coverage/lcov.info` 指向 combined（unit + 真实浏览器 E2E 的并集，覆盖面更大）。unit 那份 LCOV 用来在 CI 里独立判 90% 单元覆盖率门槛，两者口径分开写在这里，避免把“CI 验证了两个目录完整性”误读成“Sonar 消费了两份报告”。
- **待远端复核**：本批已关闭 Automatic analysis；拿到本批提交的 workflow run、新 analysis revision 与质量门回读之前，不能写“CI 扫描已通过”。
- 本地无法预演扫描：扫描令牌只在 Actions Secret 里，本地既不持有也不该持有，因此 `sonar-project.properties` 的索引结果只能由真实 CI run 验证；本机已验证的只是“两个报告目录完整、`collectionComplete` 为真、LCOV 含 `SF:`”。

## 2026-11-15 统一覆盖率实测

本机分批补测并运行 `npm run test:coverage`，两套 report 都产出 LCOV、summary 与 HTML。下面前两轮为历史留档，最终验收结果见本节末。

第一轮（修复前留档，`collectionComplete: false`）：`node-tests` 退出码 1，3 个设计守卫用例失败 —— CSS 六色硬编码、`--chat-width` fallback、meta theme 旧期待；该轮数字为 unit 行 66.38%、combined 行 77.07%，四项全部低于 90。

第二轮（守卫修好、并补了一批定向单测后）：两个 manifest 都是 `collectionComplete: true`、`errors: []`，`npm run test:coverage` 退出码 0。

| 指标 | unit（`coverage/unit/`） | combined（`coverage/`） |
| --- | --- | --- |
| 生产源码文件 | 115 | 115 |
| 行 | 15,727 / 17,549 = **89.61%** | 15,800 / 17,549 = **90.03%** |
| 语句 | 17,178 / 19,940 = 86.14% | 17,251 / 19,940 = 86.51% |
| 函数 | 1,404 / 1,655 = 84.83% | 1,405 / 1,654 = 84.94% |
| 分支 | 8,244 / 10,123 = 81.43% | 8,524 / 10,249 = 83.16% |

- 第二轮结论：`coverage:check 90` **不通过**。门槛要求 unit 与 combined 各自的 lines/statements/functions/branches 四项都 ≥90；该轮 unit 只有行项接近，不能把该轮写成“覆盖率达标”。
- 历史两轮源码状态与采集器均有变化，不能仅凭某一文件的负计数归因整个分母差异。`resources.ts` 的 703 个物理行与 269 个含语句行属于不同计数口径，二者不同不证明 source map 路径错误。当前报告以 manifest 的源码散列和实际覆盖映射为准；未命中文件仍保守补 0。
- 负计数处理规则（本轮明确写入采集器）：v8→istanbul 转换偶尔产出负计数（实测该文件分支 `-2`）。负计数在语义上只能是“未覆盖”，因此保守钳制为 0 并在 manifest 的 `warnings` 里逐条记录 `NEGATIVE_COUNT_CLAMPED:<label>:<file>:<count>` 供复核；非有限值（NaN/Infinity）仍按结构损坏硬拒绝。绝不因为一个转换器产物丢弃整份文件——那会让整文件按未覆盖计入，反而谎报更低的覆盖率。
- 同轮正常项：3 个 SDK 的 vitest、全部原生测试与 4 个真实浏览器 E2E 均通过（含 `e2e-web` 用 `http://evil.invalid` 验证旧 `Authorization` 不会发往换址目标）。
- 分母口径：8 个源码根下的全部生产源码，未命中文件由 `zeroFile` 补 0；没有为拉高百分比删分母、缩 scope 或加排除。这两个百分比与 Sonar 项目覆盖率不同口径（Sonar 分析面更大，且当前仍无覆盖率数据）。

### 最终整批验收（2026-11-15 15:58，Asia/Tokyo）

生产源码仍为 115 个文件，没有缩小统计范围。两套 manifest 均 `collectionComplete: true`、`errors: []`；构建、3 个 SDK 全量 Vitest、原生单测与 4 个浏览器 E2E 所有阶段退出码均为 0。`npm run coverage:check` 按原阈值退出 0，`failed: []`。

| 指标 | unit | combined |
| --- | --- | --- |
| 行 | 16,293 / 17,550 = **92.83%** | 16,357 / 17,550 = **93.20%** |
| 语句 | 18,100 / 19,941 = **90.76%** | 18,164 / 19,941 = **91.08%** |
| 函数 | 1,527 / 1,655 = **92.26%** | 1,527 / 1,654 = **92.32%** |
| 分支 | 9,272 / 10,236 = **90.58%** | 9,466 / 10,333 = **91.60%** |

- 两份 manifest 均保留同一条 `NEGATIVE_COUNT_CLAMPED:vitest:hetang:packages/hetang/src/resources.ts:1` 警告。归并前克隆输入，不会因先生成 unit 而改动 shared raw、吞掉 combined 警告；回归验证原始负数未被修改，两 phase 均把它按未覆盖计。
- 前端新增原子连接记录不与残余旧令牌拼接，回归覆盖新 base/旧 token、显式同目标 URL、损坏记录回退等；审批超时测试用可控时钟，避免 Node 22 因生产定时器 `unref` 取消测试。最终 HTTP/前端/审批/采集器分组 71/71 通过。
- 自定义 smell：固定 11 个模块、272 个函数，265 个无阈值违规，`round2(100*265/272)=97.43`，无硬上限违规；这不是 Sonar 评分，也不是全仓评分。许可 264 项和 npm audit 0 漏洞均已实测。
- 浏览器实际验证：桌面 1707×876、窄屏 398×806 均无横向溢出；模拟审批从待审批到允许并返回工具完成回执，未调用真实校园、云盘或计费模型。
- 鸿蒙设备已由 SSH/HDC 连接，但未签名 HAP 的安装被 `9568320: no signature file` 拒绝，用户暂缓开发签名，不能写成实机运行通过；见 [Harmony 工程说明](../mobile/harmony/README.md)。

## 误报与忽略的证据要求

把 Sonar 标记当“已确认缺陷”，或反过来批量标记“误报/不予修复”，都需要逐项证据，不能靠一句结论：

- 每条要关闭的问题，记录文件与行、触发条件的实际输入校验、调用链是否可达、以及证明不可达的代码位置或测试。
- 弱哈希、排序比较这类，先确认它在系统里的真实安全/业务语义，再决定改法；不能为了让 issue 消失做机械替换。
- 不通过扩大 `sonar.exclusions`、重置 new-code 基线、改质量门或降低阈值来变绿。
- 本轮处于“代码整改已冻结、远端未复扫”的中间态：任何一条都不应写成“已修复”，只能写“已改，待新 analysis 复核”。

### 已按证据转为 False positive 的 5 条（远端已生效）

远端匿名接口回读确认这 5 条 `issueStatus=FALSE_POSITIVE`，逐条理由见 `.local/sonar-review-log-20261115.json`（不进仓库）：

| key | 规则 | 位置 | 判定依据（摘要） |
| --- | --- | --- | --- |
| `AaHZoLQ5SajQlY95-QkX` | jssecurity:S2083 | `lib/app/sessions.mjs:34` | 所有文件 sink 都过 `SessionStore.file()` 的完整 canonical UUID 白名单；stateDir 是可信本地配置；28 类非法输入与 HTTP 404 有回归 |
| `AaHZoLQ5SajQlY95-QkY` | jssecurity:S2083 | `lib/app/sessions.mjs:101` | 删除走同一 UUID 守卫且在 `rm` 前校验，非递归单文件 |
| `AaHZoLQySajQlY95-QkV` | javascript:S4790 | `lib/madmodel/protocol.mjs:5` | MD5 只对固定字面量求摘要作为 SSO 路由标识，不用于口令/认证/完整性 |
| `AaHZoLQ2SajQlY95-QkW` | javascript:S5332 | `lib/madmodel/server.mjs:107` | 仅把 `req.headers.host` 拼串做同源判定，不发网络请求、不落配置 |
| `AaHZoLPuSajQlY95-Qjv` | typescript:S1313 | `packages/hetang/src/resources.ts:472` | `8.8.8.8` 只在 `HETANG_MOCK=1` 离线模拟分支作假 `resolve()` 结果交给 SSRF 守卫，同分支 fetcher 是内存 PNG，不做 DNS 也不出站；生产分支仍执行真实公网校验 |

其余开放项属于代码已改、待新 analysis 复算的发现，不作误报处理，也不以本地结果替代 Sonar 判定。

### 2026-11-15 首轮CI后的四项独立复核

以下每一项均在Sonar UI单独附评论、单独改状态，并经不带令牌的公开API回读为`RESOLVED / FALSE-POSITIVE`；未改规则、质量门或排除项。

| issue key | 规则 | 独立证据 |
| --- | --- | --- |
| `AaHeDZRq07pFJPuue4ZF` | javascript:S5332 | `e2e-web.mjs:478`是`.invalid`保留域名的Playwright路由模式，不是生产传输；479–482在导航前安装全量内存fulfill，没有continue或出站。CI 43688282359真实浏览器验证旧Authorization不泄漏。 |
| `AaHeDZRq07pFJPuue4ZG` | javascript:S5332 | 483行HTTP字面量经encodeURIComponent作为本地测试URL的query输入，不是直接导航；目标请求由前述路由拦截。485–490断言无旧令牌并返回配对页。 |
| `AaHeDZSC07pFJPuue4ZH` | jssecurity:S8475 | 固定键存储版本化JSON而非HTML或代码；URL限http(s)、无userinfo/query/hash/控制字符，令牌限长度和可打印ASCII；读取再校验。完整base绑定、目标改变清旧令牌、新记录不与旧字段混拼，单次setItem保持原子性。 |
| `AaHZoLQuSajQlY95-QkS` | jssecurity:S8476 | `buildApiUrl`限制单斜杠相对API路径，拒绝协议相对、反斜杠、父目录及编码点；base经URL校验，凭据绑定完整目标且不随换址，fetch明确credentials:omit。远程运行时是显式配对功能，真实E2E已验证注入新目标不收到旧Authorization。 |

这些状态处置只说明逐条误报复核完成，不代表整批源码质量门通过；恢复测试分析后的实际发现仍须处理。

## 官方依据

- [Free/OSS方案与私有LOC额度](https://docs.sonarsource.com/sonarqube-cloud/administering-sonarcloud/managing-subscription/subscription-plans)
- [区域选择](https://docs.sonarsource.com/sonarqube-cloud/getting-started/choosing-your-region)
- [Automatic analysis与限制](https://docs.sonarsource.com/sonarqube-cloud/analyzing-source-code/automatic-analysis)
- [JS/TS的LCOV覆盖率接入](https://docs.sonarsource.com/sonarqube-cloud/analyzing-source-code/test-coverage/javascript-typescript-test-coverage)
