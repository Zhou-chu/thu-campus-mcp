# 独立校园助手功能点

本文件是用户新增功能点的跟踪入口，明确需求、实现状态与可验收条件；不把设计要求写成已完成能力。界面规范以[UIdesign](../UIdesign.md)为准，架构与HTTP/SSE契约参见[应用设计契约](superpowers/specs/2026-11-11-campus-agent-app.md)。

| 编号 | 功能点 | 状态 |
| --- | --- | --- |
| ACCOUNT-LOGIN | 用清华学号 / 邮箱 / 用户名 + 统一身份认证密码直接登录应用，取消设备配对码前置；凭据有效性由清华官方通道判定 | **已实现（MVP）**：首屏即账号登录，校验走统一身份认证 + 网络学堂受保护页面；配对码降级为次要入口。验收见[账号登录](#account-login清华账号直接登录)与 [#158](https://github.com/Zhou-chu/thu-campus-mcp/issues/158) |
| UI-APPROVAL-CARD | 紧凑、可伸缩、处理后收起的审批卡 | 本批修复，验收见[审批卡验证](approval-card-verification.md) |
| MODEL-REASONING-EFFORT | 按模型能力选择思考强度 | **部分实现**：输入区与设置可选低/中/高并随请求发送，默认不发该参数；尚未按模型能力过滤选项 |
| SECURITY-APPROVAL-MODE | 明确、可选择且由服务端强制执行的审批模式 | **待实现**，不是现有启动开关或单次允许/拒绝 |
| TIMETABLE | 同级的“课表”视图：周视图（7 天 × 6 大节）、窄屏日程、课程详情；显示大节时间段，自定义课程可精确到 1–14 小节 | 已实现，验收见[课表验证](#timetable课表视图) |
| SPORTS-BOOKING | 清华体育场馆：运动 → 场馆 → 日期 → 场次、预约流程状态与官网预约历史 | **部分实现**：只读与流程状态已上线，下单与支付未做 |
| LIBRARY-SEAT | 图书馆座位预约：分区 → 日期/时段 → 座位 → 预约 / 取消，读取预约记录 | **可用**：多时段切换、预约、确认后取消；取消结果未知时提示核对记录而不重发。界面走查见 `scripts/e2e-seat-cancel.mjs` |
| MODEL-PROVIDERS | 第三方模型提供商：OpenAI 兼容 / Responses / Anthropic，支持导入模型与启用切换 | 已实现，验收见[模型提供商](#model-providers第三方模型提供商) |
| SCHEDULED-TASKS | 定时任务：界面创建/修改/删除，到点新建会话执行；模型也可创建 | 已实现，验收见[定时任务](#scheduled-tasks定时任务) |
| TOOL-COMPACT-MODE | 精简工具模式：用检索/调用两个入口替代 86 个工具的完整清单 | 已实现，验收见[精简工具模式](#tool-compact-mode精简工具模式) |
| TOOL-CALL-VIEW | 工具调用流程默认收进设置，可展开查看参数与结果，也保留在对话中显示的开关 | 已实现，见[工具调用展示](#tool-call-view工具调用展示) |
| DEBUG-LOG | 可选详细运行日志：默认关闭、设置即时开关、JSONL、脱敏、轮转、导出与清空 | **部分实现**：HTTP 与 MCP 工具调用已采集；浏览器步骤、定时任务、未捕获异常待扩展 |

## ACCOUNT-LOGIN：清华账号直接登录

**需求来源**：用户 2026-11-27 明确要求——“直接使用清华的学号或者邮箱或者用户名登录，密码就是清华账号的密码，不要弄什么设备配对码”。

### 规则

- 首次打开应用只出现一个表单：`学号 / 清华邮箱 / 用户名` 任选其一 + 统一身份认证密码。**不出现配对码、不要求另外注册一套本机密码。**
- 这组凭据同时用于网络学堂、清华云盘、荷塘雨课堂、图书馆座位、体育场馆；不再让用户在“服务”页重复填一次清华账号。
- 账号是否正确由**清华官方通道**判定，不以格式校验冒充：统一身份认证 `https://id.tsinghua.edu.cn` 的登录表单与 `POST /do/off/ui/auth/login/check`；登录成功后再读一个受保护接口，证明“是这组凭据对应的那个账号”。
  - 参考实现：[THU-Info](https://app.cs.tsinghua.edu.cn/) 与其开源库 [thu-info-lib](https://github.com/thu-info-community/thu-info-lib)：先取指纹/表单，再提交校验，最后用受保护接口确认会话属于该账号；不把“请求返回 200”当成登录成功。
- 失败必须分档，不能合并成一句“登录失败”：账号或密码错误 / 需要二次认证或验证码 / 账号被锁定或需年审 / 网络不可达。需要人工验证时明确要求在运行实例上完成。
- 学号、清华邮箱、用户名三种写法都必须可用（统一身份认证本身接受这三种）。
- 凭据只存 `account.dpapi`（Windows DPAPI 绑定当前用户，不写明文）；登出提供“同时清除本机凭据”。
- 设备配对码降级为迁移期可选路径：仅在显式开启固定令牌或旧客户端接入时出现，不再是新用户默认入口。

### 验收

1. 全新状态打开应用，看到的是账号密码表单而不是“连接设备”。
2. 正确凭据：一次登录后五类校园服务可用，不再二次配置。
3. 错误密码：提示来自清华官方判定，不进入应用、不缓存凭据。
4. 二次认证：给出“请在运行实例的浏览器窗口完成”的明确指引，失败后状态可重试。
5. 三种账号写法各登录一次，均成功；登出后 `account.dpapi` 与遗留明文文件都不存在。

## MODEL-PROVIDERS：第三方模型提供商

设置页「模型提供商」可以添加任意接口，三类协议：

| 类型 | 上游端点 | 说明 |
| --- | --- | --- |
| `openai` | `/models`、`/chat/completions` | OpenAI、DeepSeek、Moonshot、通义、vLLM、Ollama 等兼容端点 |
| `openai-responses` | `/models`、`/responses` | OpenAI Responses API；请求翻译成 input 项，语义事件流翻译回增量 |
| `anthropic` | `/models`、`/messages` | Claude 原生协议；`system`、`tool_use`/`tool_result`、图片均双向翻译 |

启用某个提供商后，模型路由按需切换（无需重启）：`/api/meta` 与对话都走该提供商；停用后回到 `THU_CAMPUS_APP_MODEL_ROUTE` 指定的内置路由。密钥只在本机 `model-providers.json`，HTTP 只返回掩码。

验收：`test/providers.test.mjs`（校验、持久化、模型导入）、`test/anthropic*.test.mjs`、`test/responses.test.mjs`（两套协议的双向翻译与错误映射）、`test/routes-providers.test.mjs`（路由增删改、连接测试、启用切换、chat 走对端点）。真实 8973：创建提供商返回掩码、非法地址 400、不可达地址测试返回 `PROVIDER_UNREACHABLE`、停用后 `activeId` 为空。

## SCHEDULED-TASKS：定时任务

支持三类计划：单次（本地日期时间）、每天（HH:MM）、每周（周几 + HH:MM）。计划保存在 `stateDir/schedules.json`，执行器每 20 秒检查一次，到点后新建会话并跑一轮完整对话。

- 界面：左侧「定时」页创建、启停、删除；每张卡显示频率、下次执行、上次结果与失败原因。
- 模型：`schedule_list`、`schedule_create`、`schedule_update`、`schedule_delete`，与界面共用同一份计划；创建/修改/删除标记为写工具，只读检索不会误暴露。
- 真值：只有真的收到助手正文才记为成功；模型报错时记录错误码与原因（例如 `INVALID_REQUEST：模型服务暂不可用`），单次任务执行后自动停用。

实测（生产 8973）：19:08 到点的单次任务自动新建会话「定时：到点验证5」，模型回复“定时已运行”，任务状态 succeeded，`enabled` 自动变为 false。此前同一路径曾被误记为成功（只有用户消息），已修复并补 `test/schedule-runner.test.mjs` 的静默失败用例。

## TOOL-COMPACT-MODE：精简工具模式

86 个工具的完整 Schema 约 1 万 token，每轮都随请求发送。设置页“对话模型 → 精简工具模式”打开后，模型只拿到两个入口：

- `campus_tool_search(query, limit)`：按名称/服务/描述检索**只读**工具，返回名称、服务与完整 inputSchema。
- `campus_tool_call(name, arguments)`：调用检索到的只读工具。

写入类工具不进入检索结果，直接点名也会被拒绝并提示到工具页用完整模式逐次确认，避免把写操作藏在转发层后面。实测首轮工具 Schema 约 300 token（原约 10,600）；开关保存在 `settings.json`，`/api/meta` 可回读；真实页面验证开→关→开、刷新保持、390px 无横向溢出。

验收：`test/compact-tools.test.mjs`（检索/写拒绝/透传）、`test/compact-agent.test.mjs`（runTurn 只发两个入口且检索结果可继续调用）、`.local/audit-compact-tools.mjs`（真实浏览器）。

## UI-APPROVAL-CARD：审批卡与生命周期

- 待审批默认展示工具名、具体风险和允许/拒绝，不把整个JSON当正文。完整冻结脚本与参数主动展开，参数区域有内部滚动且可纵向调整高度；窄屏不制造页面横向溢出。
- 外层可手动收起/展开；服务端确认批准或拒绝后自动收起为简短记录，按钮隐藏，不删除原风险和参数。允许执行不表示作业完成，执行状态仍从真实工具/作业接口独立显示。
- 提交中禁用两个按钮、防重复决定；只有确认接口明确返回`decided:true`才算处理成功。失败保留风险与参数、显示就地错误、恢复重试；失效/已处理回执不显示批准成功。
- 键盘可操作，有合理焦点恢复；视图重绘不丢提交中状态，确认请求绑定原会话。缩小布局不得削弱冻结脚本、目标范围或风险核对。

## MODEL-REASONING-EFFORT：思考强度选择

### 当前现状

UI没有思考强度控件；Agent请求只传model/messages/tools/stream。现有reasoning/reasoning_content是上游已提供内容的展示，不是可配置强度。底层协议允许额外字段透传，不代表具体模型支持某字段或枚举。当前模型目录不声明此能力，设置API没有对应保存字段。

### 功能与验收

1. 服务端按实际路由/模型声明支持的字段、合法值和默认行为，不能给所有模型硬塞同一套选项。能力未知或不支持时如实显示不可配置，不伪造low/medium/high选项。
2. 对话区提供带标签的真实选择入口，显示有效值；选择经白名单API校验、保存、回读，错误就地反馈并回滚。刷新模型目录不清草稿；切换到不兼容模型时清除/拒绝不兼容值，不静默谎报已生效。
3. 新一轮启动时冻结实际模型与强度，所有工具循环复用；运行中修改只影响下一轮，FIFO待发项在真正启动时取最新有效设置，不改写当前请求。
4. 用受控上游抓取请求证明字段和值真实到达；不支持时不发送，非法值被服务端拒绝，保存失败不改变有效值。思考内容显示单独验收，不用它代替强度控制。

## SECURITY-APPROVAL-MODE：审批模式选择

### 当前现状

只有启动环境配置`THU_CAMPUS_APP_REQUIRE_APPROVAL`（默认启用）和每次允许/拒绝卡，没有可持久化回读的模式设置。关闭普通确认不等于只读、安全自动审批或完整权限模式；workspace初始化、导入、运行、覆盖等仍有独立强制确认与冻结校验。

### 功能与验收

1. 先定义明确的服务端模式枚举及含义，例如“只读：拒绝写入/执行”和“标准确认：保留现有确认规则”。这些是待实现的设计语义，**不宣称当前可选，不默认新增自动允许或降低保护**；任何新增高权限模式需另行明确授权。
2. UI提供真实入口，展示后端实际支持模式、有效值和必要的风险确认；设置经严格枚举/权限校验、持久化和回读，错误回滚，不能只改前端变量或把requireApproval=false包装成完整模式。
3. 模式必须由服务端统一强制，覆盖Agent、工具直接API和workspace相关入口；readOnly注解不是拒写权限实现，不能留下换入口绕过。只读模式必须在执行前阻止写入/运行，不能执行后才报告被禁止。
4. 明确当前轮、待发项与待审批项的生效边界；运行中不得通过修改设置放宽已冻结轮次的审批要求。初始化/导入/运行/覆盖等强制确认及脚本/范围绑定不能被普通模式覆盖。
5. 受控验收：只读下写入/执行调用0次；标准模式仅明确允许后执行1次；拒绝、超时、失效、跨会话、改参、并发重复和直接API调用均不能绕过。界面模式与服务端实际有效值一致，不能出现已保存却未生效。

## 状态维护

新增功能只有真实接口接通、端到端验收通过后才能改为已实现；本批没有提供思考强度或审批模式的假控件，也未改变默认审批权限。真实SonarQube项目现已公开，入口、自动分析链路和覆盖率边界见[Sonar接入](sonarqube.md)；仍不能以本地评分替代真实分析或质量门。

## TIMETABLE：课表视图

### 当前现状

与“对话工作台”同级的独立视图，数据来自已登录的网络学堂选课接口 `timeAndLocation`（该字段是字符串数组），不另建 zhjw 认证。桌面 7 天 × 6 大节网格（清华本科每天 6 大节），今天整列有底纹与标记，重叠课程分道错开；窄屏（<1100px）切换为按天分组的日程列表。

### 功能与验收

1. 真实数据渲染：14 门课 / 16 个时段时网格与日程均正确，无横向溢出；接口不可用或未登录时如实说明，不画空格子。
2. 第 7 节及以后的时间字符串判为不成立并丢弃，不画多余行；没有上课时间的课程单独计数展示。
3. 单测覆盖解析、分页、缓存与 HTTP 鉴权；端到端覆盖“六个→七个导航标签”“空状态不画格子”。

## SPORTS-BOOKING：体育场馆预约

### 当前现状

数据来自 `sports.tsinghua.edu.cn/venue`（CAS 登录的 Vue 应用），通过持久浏览器按真实点击驱动：点“场地预约”→ 运动种类（11 项，动态读取）→ 场馆（按运动变化）→ 场馆页触发 `POST /venue/site/api/reserve/current/page` 取得场次。

### 已实现

1. `lib/app/sports.mjs`：`listSports` / `listVenues` / `listSlots`，返回时段、容量、已约人数、状态（`N` 为不可约）、状态原因与费用。
2. 三个只读路由：`/api/sports/sports`、`/api/sports/venues`、`/api/sports/slots`。
3. “体育”视图：运动 chips → 场馆 chips → 7 天日期条 → 场次行（按可约数量统计）；未登录、无场馆、当日无场次三种状态均如实显示。
4. 未登录时页面提供“打开体育登录窗口”按钮；登录窗口占着浏览器资料时返回 `BROWSER_BUSY` 并提示先关窗口。

### 未完成

1. 预约下单与支付：按“只读查询 + 确认后由官方页面完成”的方式实现，不在本应用内代下单、不经手支付凭据。
2. 会话寿命：体育登录数小时后失效，需重新登录；暂无静默续期（CAS 弹窗在无界面环境不跳转）。

## LIBRARY-SEAT：图书馆座位预约

### 当前现状

目标系统 `seat.lib.tsinghua.edu.cn`，独立登录页（非 CAS）。已将其纳入持久浏览器站点清单（`campus_browser_open` 支持 `service=seat`），登录窗口可打开。

### 功能与验收

1. 登录后读取区域、座位与时段，展示真实空位；无数据时如实说明。
2. 预约需二次确认，且只镜像官方系统的订单状态；支付/超时/取消等状态以官方返回为准。
3. 未实现前不得在界面宣称可预约。

### 实现（2026-11-19 完成）

- 读取：`GET /api.php/v3areas/<馆区>` 取分区（`seatinfo` 含 `TotalCount/UnavailableSpace`），`GET /api.php/space_time_buckets?day=&area=` 取座位与场次桶（`spaceId/spaceName/bookTimeId/beginTime/endTime/status`）。该桶接口对「时段型」与「整日型」分区都适用，是唯一入口。
- 预约：`POST /api.php/spaces/<座位id>/book`，表单 `access_token/userid/segment(=bookTimeId)/type=1/operateChannel=2`。
- 取消：`POST /api.php/profile/books/<id>`，表单 `_method=delete&id&userid&access_token&operateChannel=2`。
- 模块：`lib/app/seat.mjs`（`libraries/floors/segments/days/seats/bookings/reserve/cancel` + 纯函数归一）。
- 路由：`/api/seat/libraries|floors|segments|days|seats` 只读；写操作两步——`/api/seat/reserve/prepare` 签发绑定参数的确认令牌，`/api/seat/reserve` 必须带令牌否则 428。
- 工具：`seat_libraries/floors/segments/seats/bookings` 只读，`seat_reserve/seat_cancel` 标记 destructive，需 `/api/tool-approvals` 令牌。
- 界面：导航「图书馆」标签，馆区 → 分区 → 日期 → 座位网格 → 「预约此座位」，失败原因原样回传。

### 已真实验证

- 预约 `M1-2`（2026-11-20，segment 1634674）→ `预约成功`，座位状态由 1 变 2；随后取消 → `预约取消成功`。
- 界面在真实实例加载 4265 个座位、2723 个可约，点击座位出现确认条。
- 同一时段重复预约时服务端返回「当前用户在该时段已存在预约，不可重复预约」，界面如实展示。

### 注意

- 座位系统登录会话约 1 小时后失效，需重新用 `campus_browser_open(service="seat")` 登录；过期时接口返回 `没有登录或登录已超时`，模块抛 `SEAT_LOGIN_REQUIRED`。
- 取消有每日次数限制，测试预约后应立即取消。

### 探测记录（截至 2026-11-19）

- 页面路由：`/home/web/seat/area/<areaId>/day/<YYYY-MM-DD>`；主流程「选择楼层 → 选择区域和日期 → 选择座位」。
- 同源 JSON 接口（带 cookie 即可，无需签名）：
  - `GET /api.php/v3areas/<areaId>` → `data.list[]` 含 `areaInfo/parentInfo/childArea/seatinfo`
  - `GET /api.php/v3areadays/<areaId>` → `data.list[]` 含 `day`
- 已知区域 id：35、64、89、6、19、29、39；另有 `研讨间`、`入馆预约 /home/book/index`。
- **未解决**：座位列表与预约提交接口尚未定位——区域页主体只渲染了步骤条与日期切换，座位图可能由楼层选择后动态加载或在 iframe 内。

### 探测记录续（2026-11-19 晚）

- **座位图由 ZRender 绘制在 canvas 上**，DOM 中不存在座位元素；此前按 `[class*=seat]` 查找为空是方向错误，不是选择器问题。
- 页面脚本暴露的接口清单（同源、带 cookie、无签名）：
  - `/api.php/space_days`（需参数，缺参返回 `msg:"参数有误"`）
  - `/api.php/space_time_buckets`（返回 `data.list`，提示「获取可预约时间段」）
  - `/api.php/spaces`（返回 `data.list`，提示「获取空间预约信息」）
  - `/api.php/v3areas/<id>`、`/api.php/v3areadays/<id>`、`/api.php/users`、`/api.php/login`、`/api.php/logout`
- 参考项目 `thu-info-community/thu-info-app` 走 webvpn + 旧接口：`spaces_old`、`areas/1/tree/1`、`spaces/<id>/book`；可作参数语义与预约链路的参考，但本站点用新版 `space_*` 接口。
- **未解决**：`space_*` 的必填参数名与预约提交端点。参数由页面外部 JS 组装，需继续定位该脚本或在真实点击时抓请求。


### 时间窗与接口行为（2026-11-20 实测）

- 官网规则原文：`系统开放时间为每日的 6：00-23：00`、`可预约当日或次日的座位`。
- 时间窗外访问座位页，页面直接显示「系统开放预约时间 06:00~23:00 请在开放时间段进行预约」，且不发起任何座位请求；因此时段外读不到座位是官网行为，不是接口缺失。
- `v3areas/<馆区>` 与 `space_time_buckets?area=` 都**忽略参数**，返回全局数据（93 个分区、4265 条桶）；因此不能用它们做馆区过滤。
- 新增 `GET /api/seat/sections?library=`：在**同一浏览器会话**内批量查询 93 个分区的 `areadays`，返回可约分区与日期（一次约 1 分钟），供界面直接使用。
- `seats()` 用 `areadays` 的 segment + `spaces_old` 取座位；关闭时间窗外由 `bookingWindowOpen()` 直接拒绝，不启动浏览器。
- 预约失败原因归类为稳定错误码：`SEAT_WINDOW_CLOSED`、`SEAT_ALREADY_BOOKED`、`SEAT_TAKEN`、`SEAT_SEGMENT_INVALID`、`SEAT_LOGIN_REQUIRED`。



### 怎么用

- 自然语言（Agent）：直接说「帮我看看图书馆 11-20 有没有空位」「约 11-20 音乐馆单人欣赏区的 M1-1」。Agent 会先 `seat_sections` 找可约分区 → `seat_seats` 看空位 → 经确认后用 `seat_reserve` 提交；要撤销时说「取消我 11-20 的座位预约」，走 `seat_bookings` → `seat_cancel`。
- 网页（人类点击）：导航「图书馆」→ 选分区 → 选日期 → 点座位 → 「预约此座位」。未登录或不在开放时段时，界面会直接说明原因并给出「打开登录窗口」入口，不会假装可约。
- 时间限制：每日 **06:00–23:00**（北京时间）；登录会话约 1 小时后失效，需要重新登录。


- 自动重登：`POST /api/seat/login` / 工具 `seat_login`。`reserve` 与 `cancel` 在登录失效时会自动用浏览器已保存凭据重登一次；**重登后会先核对服务器是否已创建订单**，命中即返回 `reconciled: true` 与 `bookingId`，不再重复提交。需要人工验证码时返回 `needsManual: true`。
- 令牌来源：优先页面渲染的 `ska.access_token`（比 cookie 新），页面地址附带 `_=<timestamp>` 规避缓存导致的陈旧令牌。


- **自动重登实测（2026-11-20）**：主动登出后调用 `POST /api/seat/login`，约20秒后返回 `ok=true, alreadyLoggedIn=false, needsManual=false`，恢复的是当时的本机座位会话。凭据现应在“清华账号”统一配置，不需要再手工创建座位密码文件。
- **两条路径的预约证据**：工具层 `seat_reserve` → `ok=true, bookingId=7522862`；界面点击 → 提示「已提交预约：NF3B001」，记录 `7523614`；两条记录随后都取消成功。

### 本机凭据存储

- 统一清华账号保存在应用状态目录的 `account.dpapi`，由Windows DPAPI绑定到当前Windows用户，不以明文写盘。配置接口只接受HTTPS或本机回环连接。非Windows环境不能保存统一账号，不降级为明文。
- 从旧应用状态目录迁移时，`account.json` 优先于 `seat-credentials.json`，与旧读取顺序一致。原来生效的账号在加密写入、读回校验后才会移除应用状态目录内的旧文件。显式指定的外部 `SEAT_CREDENTIALS` 文件仍仅作旧座位入口，不由程序迁移或删除。
- 已配对设备令牌在服务端设备列表中只保存摘要；独立浏览器会话另由DPAPI保护。固定实例令牌和令牌传输不属于统一账号密码加密的范围：远程使用应启用HTTPS，泄露令牌应单独撤销或轮换。


## TOOL-CALL-VIEW：工具调用展示

对话主界面默认只显示正文与推理，不把工具调用流程堆在消息前。工具调用统一进入「设置 → 工具调用记录」，每条可展开查看参数与结果；设置中提供「在对话中显示完整工具调用卡片」开关，偏好保存在本机 localStorage。

验收：`test/webui-app-unit.test.mjs` 覆盖默认隐藏、设置中查看、开启后恢复、缺失名称/状态兜底；`scripts/e2e-web.mjs` 在真实 Chromium 中断言隐藏与设置可见，当前 105 项通过。

## DEBUG-LOG：详细运行日志

默认关闭，不创建日志文件；环境变量 `THU_CAMPUS_APP_DEBUG_LOG=1` 可在启动阶段强制开启并优先于持久化开关。设置页「详细调试日志」可即时开关、显示目录与大小、导出最近日志、清空。

- 追加到 `stateDir/logs/debug.jsonl`，单文件 10MB、最多保留 5 个文件；写入异步，失败不影响主流程。
- 采集 HTTP 请求（方法、路径、状态、耗时）与 MCP 工具调用（工具名、耗时、成功/失败、错误）。
- password/passwd/secret/cookie/authorization/token/apiKey/pairCode/sessionId 等字段统一 `[REDACTED]`；字符串超过 4KB 截断并标注原长度。
- 浏览器自动化步骤、定时任务与 `uncaughtException` 采集尚未加入，不能把当前实现当成“全链路日志”。

验收：`test/debug-log.test.mjs`（默认不写、动态开关、环境变量优先、脱敏、截断、轮转/清空、损坏配置、工具调用成功/失败）、`test/routes-settings-schedules.test.mjs`（GET/PUT/导出/清空/未注入 503）、WebUI 单测（开关、失败提示、不可用说明）。生产 8973 实测开启后 `/api/meta` 入日志、无 Cookie 泄露，关闭后停止写入，清空后 0 字节。
