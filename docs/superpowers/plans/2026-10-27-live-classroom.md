# 实时课堂修复与未发布题预览

用户已授权直接开发及私有推送，无需逐步确认。沿用隔离工作树 codex/live-classroom，基于 main 94b5f45。

## 设计

- 只针对用户授权的当前课堂读取和下载，不提交答案。
- 官方学生端 checkin 请求包含 source:1；响应 set-auth 是 HTTP bearer，data.lessonToken 用于 WebSocket。请求局部捕获 bearer，保存在原 DPAPI 课堂记录内，避免并发串课。
- hello/fetchtimeline 恢复已有发布记录和已展示页面，保留更早的关闭时间。直播课件按已发布页面快照下载，课后接口未就绪须明确报错。
- 用户后续明确需要未发布问题/投票：给 rain_questions / rain_question_image 添加 includeUnpublished，默认 false。只预览当前学生端已下发课件；题目保留 published 标记，未发布题不输出 answer。提交路径的 NOT_PUBLISHED 校验不变。
- 不增加第三方依赖；不导入开源项目的受限实现、隐藏答案或个人会话到仓库。

## 实现与验证

- [x] 对 source 缺失、跨进程 bearer、hello 重放和直播资源过滤分别复现 RED，最小修改后 GREEN。
- [x] 独立审查发现截止时间被重放延长、并发串用 bearer；补两项 RED/GREEN 回归。
- [x] 用户追加预览范围：真实 MCP 测试默认过滤、显式预览去除答案、未发布题拒绝提交，RED/GREEN。
- [x] 当前账号真实读到3题（2已发布、1未发布），原图3张、习题PDF3页；已发布课件图片14张、课件PDF14页，下载清单哈希校验通过。
- [x] 最终类型/构建/148项测试/来源许可审计与 smoke。
- [x] 保留 Windows Node22/24、无凭据端到端及便携包 CI 工作流。

发布流程：采用用户已授权的 main 快进、统一入口实测及私有推送；最终远端结果以准确提交的 Actions 为准。

## 完整性

题目范围为当前已加载课件。多课件切换后的历史题完整性尚需额外现场验证；后续教师新增/修改的内容不在当前文件快照内。原始课堂内容及个人验证输出只保存在用户本地输出目录。
