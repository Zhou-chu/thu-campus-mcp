# 来源与取舍

2026-10-25 从 GitHub 调研以下项目：

- [ZaytsevZY/yuketang-helper-auto](https://github.com/ZaytsevZY/yuketang-helper-auto)，本次读取 main `ec42b39f8bfe746133d350bd25858c814c1d3622`。包含现成 CLI、实时课堂、答案处理、课件导出。LICENSE 含 MIT 正文及附加说明，因此本项目使用其公开协议作为参考，独立实现适配，没有复制桌面界面、站点资产或上游答题重投逻辑。关键参考文件为 routing/active/host-adapter.ts、session-manager.ts、lesson-websocket.ts 和 backend/services/answer-service.ts。
- [DragonAura/THU-Yuketang-Helper-AI](https://github.com/DragonAura/THU-Yuketang-Helper-AI)，清华专用扫码、签到与 AI 答题；没有可读取的 LICENSE，未复制源码。
- [fu-zc23/proyuketang-afterclassCrawler](https://github.com/fu-zc23/proyuketang-afterclassCrawler) 与 [课上版本](https://github.com/fu-zc23/proyuketang-inclassCrawler)，README 说明 CC BY-NC-SA4。仅核对资源端点及数据形状，没有复制其下载实现或扫码实现。
- [0-Br/RainDownloader](https://github.com/0-Br/RainDownloader)，回放下载和分段合并能力参考，未复制源码。
- [smartThise/OneTHU](https://github.com/smartThise/OneTHU)，校园综合应用，自带非商业等附加限制与第三方授权。未复制其组件或源码。

选择直接 Node/TypeScript MCP 适配，而非要求额外 Electron 桌面程序常驻，便于四个现有本机客户端与清华云盘复用。代价是平台接口升级后需要重新验收。

DPAPI 存储、账号代次、原子写入/Windows 有界重试、锁、操作回执和配置合并，改编自用户自己的 [thu-cloud-mcp](https://github.com/Zhou-chu/thu-cloud-mcp)（`991aa558f74ce8962ab40584ffc22521b5499444`）和 learnX_MCP MIT 基础，保留在 LICENSE 中的版权说明。本项目与它们各自独立维护。

自动解题使用当前 Harness，不新增 LLM Key；真实答案提交、课堂进入与可用资源均受当前账号权限及平台状态约束。模拟验证不等于已在真实课堂提交成功。
