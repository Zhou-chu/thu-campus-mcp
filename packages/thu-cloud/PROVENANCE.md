# 来源与接口依据

本项目独立实现 Seafile REST 适配层；没有复制第三方 MCP 项目的源代码。

本项目的 Windows DPAPI 存储、原子写入/文件锁、客户端配置合并和后台进程基础，改编自用户自己的 MIT 项目 [Zhou-chu/learnX_MCP](https://github.com/Zhou-chu/learnX_MCP)，参考提交 `8d9fcd39f74743583223f754d5d278e6135df094`。相关源文件包括 auth、storage、install、jobs；保留 MIT 许可。认证模型与端点为清华云盘重新实现，没有复用网络学堂会话。

接口依据为 [Seafile 官方 Web API 文档](https://plus.seafile.com/published/web-api/home.md)、[官方 OpenAPI](https://github.com/haiwen/seafile-open-api)、[Seahub 服务端实现](https://github.com/haiwen/seahub)，包括完整目录数组、`Authorization: Token`、`ret-json=1` 上传回执、via-repo-token 范围接口以及同步批量移动/复制接口。参考代码仅用于核对接口语义，没有拷贝其实现。

2026-10-24 无认证探测清华云盘 `/api2/server-info/` 返回 Seafile `11.0.21`、seafile-pro 与 file-search 特性；学校实际可用权限仍须账号验收。

调研过 [fenixstarlord/seafile-mcp-server](https://github.com/fenixstarlord/seafile-mcp-server)、[virtUOS/seafile-mcp](https://github.com/virtUOS/seafile-mcp)、[class-undefined/thufs](https://github.com/class-undefined/thufs) 等项目。前两者在调研时没有可直接复用的完整许可证文本，因此只参考能力范围和文档；本项目采用自己的直接 REST 适配与 DPAPI 存储。

第三方 npm 依赖按各自许可证使用，精确版本固定在 package-lock.json。
