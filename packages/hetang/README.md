# 荷塘雨课堂 MCP 模块

属于 [清华校园 MCP 整合包](../../README.md)。所有安装、依赖和构建操作从仓库根目录执行。

```powershell
node bin/thu-campus.mjs hetang auth browser
node bin/thu-campus.mjs hetang doctor
```

18 个工具：课程、历史/活跃课堂、限定范围自动进入、实时事件、已发布题目与图像、提交答案、资源下载、PDF 和清华云盘归档。

解题由当前 Harness 模型完成，无需另配 Key；Harness 必须保持运行。后台只维护连接和指定范围自动进入，最长 8 小时。不补投已截止题；unknown 答案或签到有持久写入屏障，更换请求 ID 也不会盲目重投。

资源下载保留登记清单，云盘失败不丢失已下载结果；归档只上传清单内经过 SHA256 校验的文件，使用私有快照，默认进入个人库的 /荷塘雨课堂。包内云盘程序为 packages/thu-cloud/dist/cli.js。仅有共享文件计数时尚不展开附件；无活跃课堂时不能把模拟测试说成真实答题验收。

默认认证目录保持与独立项目兼容，认证由 Windows DPAPI 保存。另一台机器需要本机重新登录。统一安装器和环境变量见 [根目录说明](../../README.md)，完整工具清单见 [TOOLS.md](../../docs/TOOLS.md)。

本模块采用 [MIT](LICENSE)，来源和第三方依赖见 [来源总表](../../THIRD_PARTY_NOTICES.md)，验收范围见 [验证说明](../../docs/VERIFICATION.md)。
