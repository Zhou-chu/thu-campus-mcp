# MadModel 接入设计

目标：复用校园独立 Chromium 登录 MadModel，向下游提供 OpenAI Chat Completions HTTP 服务，自动检查和刷新登录状态。

选择：在 lib/madmodel 下实现独立 ESM 模块，复用 @thu-campus/browser 和网络学堂的已保存凭据点击逻辑；不增加第三方依赖，不改写客户端安装配置。另建浏览器资料会失去现有 SSO；直接暴露学校令牌会使下游承担续期，因此采用本机代理。

已确认：GET /model-api/auth-login 返回 data:true 可验证 Bearer；统一认证回调 /authLogin 将 token 存于 localStorage.user；令牌有效期 5 小时；POST /v1/chat/completions 是站点正式接口；GET /v1/models 实际返回 HTML，模型目录须从站点当前前端 modelList 获取。

行为：默认监听 127.0.0.1:8765；支持 GET /v1/models、POST /v1/chat/completions（JSON/SSE）、GET /health、GET /auth/status。默认每 5 分钟检查、到期前 15 分钟刷新；启动立即检查；失败退避；并发续登合并；关闭服务取消任务。收到明确 401 可在尚未向下游发送内容前续登并重试一次；网络错误、5xx 和流开始后不重放生成请求。保留工具调用、图片、reasoning 和扩展字段。

认证：Windows DPAPI 原子保存 token 和账户绑定；日志/状态不返回 token、Cookie、ticket、密码；只检查浏览器密码是否非空；最多提交 2 次，验证码需本人。账号变化拒绝；持久化注销标记及版本检查阻止在途登录复活会话。支持独立状态目录。监听非回环地址必须配置下游 API key，任何情况下都不转发下游 key 给学校。

验收：离线自动测试覆盖认证过期、并发、注销竞态、定时刷新、HTTP 鉴权、错误、流式透传、取消；全项目 check；真实网页登录、验证、刷新、模型列表以及 JSON/SSE 小请求。客户端配置保持原样。
