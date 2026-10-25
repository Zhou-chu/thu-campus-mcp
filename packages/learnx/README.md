# 网络学堂 MCP 模块

属于 [清华校园 MCP 整合包](../../README.md)。所有安装、依赖和构建操作从仓库根目录执行。

```powershell
node bin/thu-campus.mjs learnx auth browser
node bin/thu-campus.mjs learnx doctor
```

13 个工具：学期、课程、内容查询，按学期与课程增量归档，作业要求与提交状态，准备与提交作业。

支持公告、作业、文件、讨论、答疑、问卷等专栏；讨论/答疑详情仍标注部分验收。提交准备记录 15 分钟有效，绑定账号、目标、正文和本地文件 SHA256。文件或服务器状态改变会拒绝旧记录。已有提交覆盖需明确授权；仅支持可识别的个人在线作业。上传结果不明时保留 unknown，不重复上传。通用提交回执只验证服务器元数据。

实际运行依赖 [thu-learn-lib](vendor/thu-learn-lib/PROVENANCE.md)，已保留原版运行库与 MIT。

默认认证目录保持与独立项目兼容，认证由 Windows DPAPI 保存。另一台机器需要本机重新登录。统一安装器和环境变量见 [根目录说明](../../README.md)，完整工具清单见 [TOOLS.md](../../docs/TOOLS.md)。

本模块采用 [MIT](LICENSE)，来源和第三方依赖见 [来源总表](../../THIRD_PARTY_NOTICES.md)，验收范围见 [验证说明](../../docs/VERIFICATION.md)。
