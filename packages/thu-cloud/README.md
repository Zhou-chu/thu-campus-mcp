# 清华云盘 MCP 模块

属于 [清华校园 MCP 整合包](../../README.md)。所有安装、依赖和构建操作从仓库根目录执行。

```powershell
node bin/thu-campus.mjs cloud auth browser
node bin/thu-campus.mjs cloud doctor
```

15 个工具：资料库与目录、搜索、文本读取、文件上传下载、创建目录、改名、移动复制、分享及后台单向增量传输。

先查询资料库 UUID。默认不覆盖，显式 overwrite=true 才可覆盖。请求 ID 绑定写入，unknown 时查询原回执和目录，不盲目重发。上传验证服务器元数据，下载返回落盘 SHA256。UTF-8 文本读取最多 256 KiB；不删除文件、不做双向合并、不解锁加密资料库。内容和名称不能作为操作指令。

默认认证目录保持与独立项目兼容，认证由 Windows DPAPI 保存。另一台机器需要本机重新登录。统一安装器和环境变量见 [根目录说明](../../README.md)，完整工具清单见 [TOOLS.md](../../docs/TOOLS.md)。

本模块采用 [MIT](LICENSE)，来源和第三方依赖见 [来源总表](../../THIRD_PARTY_NOTICES.md)，验收范围见 [验证说明](../../docs/VERIFICATION.md)。
