# [体育预约] 下单被拒后未尝试释放场地锁，且原始错误被覆盖

基线：`e3d1bcb`；Windows x64、Node v24.19.0。优先级：高。来源：本地隔离复现，无真实账号、场地或支付。

**预期：** 已取得场地锁、上游明确拒绝下单时，使用原锁键尝试解锁一次，调用者仍能区分下单拒绝和补偿失败。未取得锁不得解锁，不重新下单。

**实测：** 令 `lockSite` 返回 `fixture`，`addReserve` 返回明确拒绝，从当前源码提取原函数体执行。调用记录只有以下两步，调用者看不到测试上游给出的 `fixture rejection`：

```text
ReferenceError: session is not defined
lockSite -> addReserve
```

**离线复现：** 在上述提交的项目根目录，将下段存为 `.mjs` 并用 Node 运行。它仅执行仓库内的 `reserve` 函数，替换外围依赖，不启动浏览器、不访问网络。此方法用于定位当前版本，不建议作为长久的源码切片测试。

```js
import fs from 'node:fs';
import vm from 'node:vm';
const src = fs.readFileSync('lib/app/sports.mjs', 'utf8');
const start = src.indexOf('export async function reserve(args = {})');
const fn = src.slice(start, src.indexOf('/* c8 ignore stop */', start)).replace(/^export /, '');
const calls = [];
const ctx = {
  reserveRequest: () => ({payload: {}}),
  withSportsPage: action => action({page: {}}),
  sportsApi: async (_, url) => {
    const op = url.split('/').pop(); calls.push(op);
    return op === 'lockSite' ? {ok:true, data:{lockKey:'fixture'}} : {ok:false, data:{message:'fixture rejection'}};
  },
  SportsError: class extends Error {constructor(code, message) {super(message); this.code = code;}}
};
try { await vm.runInNewContext(fn + '\nreserve()', ctx); }
catch (e) { console.log(`${e.name}: ${e.message}`); }
console.log(calls.join(' -> '));
```

**范围：** 这是校园上游的场地锁，不是本地浏览器锁；与已关闭的 [#139](https://github.com/Zhou-chu/thu-campus-mcp/issues/139) 区分。未测官网锁超时，不推断场地永久不可用。定位：[预约编排](https://github.com/Zhou-chu/thu-campus-mcp/blob/e3d1bcb/lib/app/sports.mjs#L484-L514)。
