# 覆盖率与真实站点探针

本文说明 `npm run coverage:check` 的口径，以及 issue #68 之后对 `c8 ignore` 的约束。

## 分成两个计量范围

| 范围 | 内容 | 门槛 | 报告位置 |
| --- | --- | --- | --- |
| 应用 | `lib/`、`bin/`、`webui/`、`desktop/`、`packages/browser` | 90%（lines/statements/branches/functions） | `coverage/unit/`、`coverage/` |
| 业务包 | `packages/{hetang,learnx,thu-cloud}/src` | 各自 90% | `coverage/packages/<name>/` |

业务包由各自 vitest 套件计量。把它们合并进应用报告会因两套插桩（v8 与 vitest）重复计数，这一点在 #62 的服务化之后必须分开，否则数字既不可信也不可复现。

## `c8 ignore` 规则

`scripts/audit-ignores.mjs` 在 `npm run coverage:check` 与 `npm run check` 里执行，规则：

1. 单文件被排除的行数不得超过 **15%**；
2. 单个排除块不得超过 **40 行**——只允许包住零散、无法替身的外部调用，不许整段流程；
3. 每条 `c8 ignore start` 必须写“——原因”，没有说明直接失败；
4. `start` 与 `stop` 必须成对出现。

达到这组规则的方式不是调大阈值，而是把判断逻辑与副作用分开：

- `lib/app/seat.mjs` 拆出 `createSeatApi({ openBrowser, withLock, casFill, probe, createReadSession, readCredentials, now })`，浏览器只通过这一层进入；`test/seat-api-fakes.test.mjs` 用假页面覆盖登录跳转、CAS 表单成功/失败/验证码、休息时段、预约提交与对账、取消与重试。
- `lib/app/sports.mjs` 把 `reserveOutcome`、`reserveRequest` 移到排除块外，纯参数校验与请求体构造由单测覆盖。

`lib/app/seat.mjs` 现在没有任何 `c8 ignore`；`lib/app/sports.mjs` 只剩两小块（页面内 `fetch`、真实下单），合计 53/557 ≈ 9.5%。

## 真实站点探针（需要真实会话，手动触发）

替身测试只能保证“按我们理解的形状处理”。真实站点是否仍按这个形状返回，需要手动跑一次：

```powershell
$env:BASE_URL = "https://desktop-uq2emap.tailf544a4.ts.net:8973"
$env:TOKEN = "<设备令牌>"
node scripts/live-read-probe.mjs
```

探针只做只读检查：`/api/meta`、`/api/tools`、座位馆区、体育项目与场景、`learn_status`/`rain_status`（`verify=false`）。它不发预约、不下单、不改设置；令牌只从环境变量读取，输出不含令牌。CI 不运行它，因为它需要真实账号会话与可用的本机实例。

预约/取消这类写入路径的真实验证仍然要求用户明确授权后在真实页面手动完成；探针刻意不覆盖它们。