# 独立校园助手功能点

本文件是用户新增功能点的跟踪入口，明确需求、实现状态与可验收条件；不把设计要求写成已完成能力。界面规范以[UIdesign](../UIdesign.md)为准，架构与HTTP/SSE契约参见[应用设计契约](superpowers/specs/2026-11-11-campus-agent-app.md)。

| 编号 | 功能点 | 状态 |
| --- | --- | --- |
| UI-APPROVAL-CARD | 紧凑、可伸缩、处理后收起的审批卡 | 本批修复，验收见[审批卡验证](approval-card-verification.md) |
| MODEL-REASONING-EFFORT | 按模型能力选择思考强度 | **待实现**，不是现有思考文本展示 |
| SECURITY-APPROVAL-MODE | 明确、可选择且由服务端强制执行的审批模式 | **待实现**，不是现有启动开关或单次允许/拒绝 |
| TIMETABLE | 同级的“课表”视图：周视图（7 天 × 6 大节）、窄屏日程、课程详情 | 已实现，验收见[课表验证](#timetable课表视图) |
| SPORTS-BOOKING | 清华体育场馆预约：运动 → 场馆 → 日期 → 场次，一键登录 | **部分实现**：只读链路已上线，下单与支付未做 |
| LIBRARY-SEAT | 图书馆座位预约：分区 → 座位 → 预约 / 取消 | **可用**：读取、预约、取消、界面与工具均已打通 |

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

