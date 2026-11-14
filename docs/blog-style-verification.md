# 木漏博客审美对齐：首批验收

## 参照与取舍

用户本人指定[个人博客源码](https://github.com/Zhou-chu/Zhou-chu.github.io)为首要审美参照。公开API确认默认分支main；实际博客在[木漏](https://gm-2.zhou-chu.workers.dev/)，GitHub Pages当前呈现仓库说明页，不能误作正式视觉样本。

只读核对了博客globals、forest-timber、theme-mono、widgets、motion的最终覆盖顺序，以及阅读宽度/主题控制组件。通过自有Chromium实际打开正式首页，并操作墨白/深色控制检查稳定截图；主题模式截图使用减少动态，时长与缓动数值来自源码核验，不冒称静态截图能测量动效。

迁移：
- 柔和墨白与明度分层、衬线标题字重和更紧凑的字面关系。复用校园既有语义令牌，保留大屏可读字阶、低对比扩散与必要的轻玻璃，不引入外部字体、摄影资源或装饰依赖。
- 160/220/380ms动效词汇、统一缓动、80ms轻按压与弹性释放；快捷图标的2px反馈、菜单展开与焦点恢复；空会话静态内容短入场及60ms错峰。
- 新动效独立于业务执行。活动消息、工具卡、待发队列、风险确认不做反复入场，不做逐字假流式，不延迟停止/发送，不为宽度添加滞后过渡。减少动态时关闭位移、入场与回弹，但保留真实状态和焦点。

不迁移：摄影背景、木柜、无限飘叶/圆盘/背景运动、装饰英文眉标、博客小号元信息及整页主题快照。自然风与墨白材质并非同一套，不把博客墨白无模糊误称Liquid Glass。博客仓库、正式内容与账号配置未修改。

## 本批实测

| 项目 | 结果与范围 |
| --- | --- |
| Node原生V8 | 五个既有纯逻辑模块52/52；行100.00%、分支98.87%、函数100.00% |
| 真实Chromium浏览器 | 页面/模型73、流式/排队/宽度/新动效75、作业产物38、认证私有范围45，共231/231 |
| 新增7项浏览器检查 | 活动消息/工具/输入不被入场遮挡；静态空会话令牌；真实hover、mouse down按压；菜单短入场；Escape关闭回焦；减少动态无入场、回弹、悬停位移 |
| 原预览只读检查 | 深浅主题×390/1280/1536/1920/2350/2560，共12组；另验长消息、菜单与可编辑草稿，页面异常0 |
| 本地自定义AST指标 | 7个前端JS模块237函数，233未越软阈，4越软阈，硬超限0；98.31分 |
| 真实SonarQube | **未执行**：尚缺现有项目入口/扫描配置，用户未提供项目链接。上述本地指标不能代替SonarQube，也不宣称审查修复闭环完成 |

覆盖范围不包含整套DOM或CSS；CSS动效由真实浏览器操作与computed style核验，不虚构其V8覆盖率。AST口径为`round2(100×未越软阈函数/函数总数)`；软阈复杂度20/嵌套5/有效行100/参数5，硬上限50/8/200/8，要求至少90且无硬超限。本批未修改业务模块。

受控模型与工具夹具完成回归，没有真实计费模型或校园写入。390px为模拟视口，不是暂停中的手机实机测试。截图、参考站点快照与运行日志留在忽略的本地目录，没有提交；未重启后台、未强刷用户工作会话，未重打Windows便携包。现有页面需等任务和待发队列处理完后刷新加载。

## 复现

```powershell
node --test --experimental-test-coverage --test-coverage-include=webui/chat-width.js --test-coverage-include=webui/turn-queue.js --test-coverage-include=webui/chat-home.js --test-coverage-include=webui/sidebar.js --test-coverage-include=webui/ui-feedback.js --test-coverage-lines=90 --test-coverage-branches=90 --test-coverage-functions=90 test/chat-width.test.mjs test/turn-queue.test.mjs test/chat-home.test.mjs test/sidebar.test.mjs test/ui-feedback.test.mjs
node scripts/audit-code-smells.mjs --scope webui/app.js --scope webui/chat-width.js --scope webui/chat-width-ui.js --scope webui/turn-queue.js --scope webui/chat-home.js --scope webui/ui-feedback.js --scope webui/sidebar.js --json
node scripts/e2e-streaming.mjs
node scripts/e2e-web.mjs --json
node scripts/e2e-workspace.mjs
node scripts/e2e-auth-workspace.mjs
```
