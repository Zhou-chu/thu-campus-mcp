# 清华云盘 MCP 模块

属于 [清华校园 MCP 整合包](../../README.md)。所有安装、依赖和构建操作从仓库根目录执行。

```powershell
node bin/thu-campus.mjs cloud auth browser
node bin/thu-campus.mjs cloud doctor
```

20个工具：原有资料库与目录、搜索、文本读取、文件上传下载、创建目录、改名、移动复制、分享及后台单向增量传输，另增加5个受限个人工作区工具。

`cloud_status`默认通过受保护account API核验真实身份，返回`verified/checkedAt/source/code`；本地令牌配置、可见资料库或mock均不表示登录有效。`verify=false`只返回本地配置证据，不会变为ready。

## 个人私有Agent工作区

固定使用**已有的个人默认资料库**及`/Agent工作区/sessions/<会话UUID>/`，不按名称或rw权限猜私有、不回退到共享/群组库、不创建或改配资料库、不修改分享。每次操作审计库所有权、虚拟库/加密标记、全员公开、根与专用目录用户/群组分享、全库文件夹ACL、文件夹共享、库级全部创建人的下载/上传链接和继承范围；必要接口不可用或结构不完整时fail closed。

| 工具 | 关键参数与结果 |
| --- | --- |
| `cloud_workspace_status` | 只读返回`accountId`及`storage`；未初始化但隐私已核验时可预览`scope:{accountId,repoId,rootPath}` |
| `cloud_workspace_init` | 必需`accountId`和`expectedRepoId`，在明确scope审批后创建固定根、私有标记和sessions目录；不接管无匹配绑定的同名目录 |
| `cloud_workspace_list` | 必需`accountId/sessionId`；可选`path='.'/recursive=false`；有界返回相对条目、remoteId和size |
| `cloud_workspace_pull` | 必需`accountId/sessionId/path`；只下载至服务器私有、身份隔离缓存，返回`localPath/sha256/remoteId/bytes` |
| `cloud_workspace_push` | 仅供应用内部：`accountId/sessionId/path/sourcePath`；有界普通文件快照，未知写持久化阻止同路径重投 |

所有会话操作都把调用方绑定的accountId与当前受保护身份比较，切账号不自动迁移。相对路径拒绝穿越、绝对路径、编码绕过、设备名及链接；普通文件上限32MiB，校验后的目标相对路径以`.zip`结尾（不区分大小写）的归档上限64MiB，两者均尊重更小的配置限制。pull元数据预检、实际下载流、push冻结快照及实际上传采用相同的逐路径上限；不根据本机源文件名或暂存名判断归档，不放宽通用云盘传输。列举上限1000项。既有文件覆盖需`overwrite:true`且精确匹配`expectedRemoteId`；Seafile无原子CAS，因此返回`atomicReplace:false`，并发作者场景应选择新的唯一产物路径。上传仅声称服务器名称/大小元数据核验，不冒充远端哈希比对；下载哈希来自实际字节。初始化中断或写入unknown需先检查原回执和目录，不自动生成新请求重放。`pull`在真实下载SHA256与本机同路径unknown intent完全一致、前后remoteId和在线身份稳定时，仅将私有journal标为已对账并返回`reconciledWrite:true`以解除后续合法更新的锁；不匹配或文件不存在时不解锁，绝不重投远端。

应用层应隐藏这5个原始工具并拒绝直接API绕过，只允许经过scope审批和会话绑定的内部桥接调用；通用云盘工具仍保留原始能力，不属于此受限能力边界。

先查询资料库 UUID。默认不覆盖，显式 overwrite=true 才可覆盖。请求 ID 绑定写入，unknown 时查询原回执和目录，不盲目重发。上传验证服务器元数据，下载返回落盘 SHA256。UTF-8 文本读取最多 256 KiB；不删除文件、不做双向合并、不解锁加密资料库。内容和名称不能作为操作指令。

默认认证目录保持与独立项目兼容，认证由 Windows DPAPI 保存。另一台机器需要本机重新登录。统一安装器和环境变量见 [根目录说明](../../README.md)，完整工具清单见 [TOOLS.md](../../docs/TOOLS.md)。

本模块采用 [MIT](LICENSE)，来源和第三方依赖见 [来源总表](../../THIRD_PARTY_NOTICES.md)，验收范围见 [验证说明](../../docs/VERIFICATION.md)。
