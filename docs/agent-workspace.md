# Agent工作区与真正隔离执行

独立应用默认使用清华云盘**个人默认资料库的全私有目录**作为持久硬盘，本地仅为容器执行缓存。应用组合11项`workspace_*`能力；MCP另有5项受限云盘存储能力，应用不把这些内部工具直接交给模型或手动HTTP入口。

## 初始化与真实登录

1. `workspace_status`查询认证、私有范围及本地容器；状态查询不创建真实云盘目录。
2. `workspace_initialize`先在线核验当前账号、个人默认库、目标祖先分享、公开/下载/上传链接、用户/组文件夹权限；不能按名称或`rw`猜私有，无法核验则阻止，不选共享库兜底。
3. 确认卡绑定真实账号摘要、精确资料库ID、固定根目录`/Agent工作区`，说明只新增该根、`.thu-campus-agent.json`私有标记和`sessions`父目录。不创建新资料库、不接管无绑定的同名目录、不修改既有分享。
4. 经过确认且回执核实后，会话只在`/Agent工作区/sessions/<UUID>/`读写。每次操作核验账号和私有范围，换账号不自动迁移旧会话或上传其缓存。

服务“已登录”只认受保护只读接口的`verified`、核验来源和时间。配置/账号/Cookie/Token存在、浏览器已打开、HTTP200登录页面均不是认证证据。已有持久会话若在线有效可复用；检查状态不触发扫码、隐式登录、进入课堂或付费模型调用。网络无法核验与明确会话失效分开显示，模拟也不显示真实已登录。

## 实际闭环

1. 校园工具定位/下载附件；找到路径不等于读过内容。
2. `workspace_import`确认**一个精确绝对源路径**后导入当前会话，并同步至授权私有目录。
3. `workspace_zip`有界列出/安全解压；`workspace_read`分页读UTF-8文本、CSV、JSON和ipynb。PDF/Office/二进制交给容器脚本，不假读。
4. `workspace_write`写代码并持久保存；`workspace_run`在审批前恢复有界云端输入，展示完整冻结主脚本、镜像ID、缓存作用域和云盘保存范围，确认后提交后台作业。
5. `workspace_job`长轮询真实退出、退出码、日志与**独立的云盘同步状态**。容器终态触发同步；同会话仍有作业运行则等待。`succeeded`不等于`storage.synced`，查询HTTP不触发上传。
6. 同步失败保留本地结果并显示原因；`workspace_sync`显式重试或先只读对账。普通文件写入本地成功但云盘未确认时返回`storage.unconfirmed`，不能称云端已保存。
7. `workspace_list`核实实际报告/图表/代码，再打ZIP；回复使用回执`downloadUrl`。设备带鉴权下载当前缓存副本，不公开分享、不把令牌放URL。离线缓存不是最新云端，回执单独标明。
8. 校园提交仍须独立确认。文档/网页任务文字不授予执行或提交权限，unknown写入不盲目重投。

云端revision变化与本地未保存内容冲突时保留双方、明确报错，不自动覆盖。服务端Seafile不提供上传原子CAS：`expectedRemoteId`只是写前检查，不能保证完全消除外部并发覆盖竞态；产物宜使用新唯一路径。未知写入先下载稳定版本对账，内容SHA-256一致才能在本地记为已确认，不重传；不同或不存在则保留未知状态。默认不做远端删除、自动合并或旧本地工作区批量迁移。

## 显式本地模式

只有应用所有者在启动环境设置`THU_CAMPUS_APP_WORKSPACE_STORAGE=local`才使用原本地工作区；默认`cloud`。UI明确显示本地模式，云盘未登录、未初始化或不可核验不会静默回退。旧本地数据不因升级被删除或自动上传；查看旧工作区可由所有者显式启用本地模式，或逐个确认精确源路径导入，不自动认定它属于当前云盘账号。

私有绑定和文件journal位于应用状态目录，**不在任何容器挂载中**。账号绑定约束云盘操作与执行，不把共享运行时伪装成SSO多租户系统：已配对设备仍可读取其获授权的历史对话、日志和当前SID本机缓存下载；这些纯本地读取不证明当前云端身份或最新版本。运行时重启不能靠旧记录伪造同步成功：未再次核验的作业保存状态保持未确认，必要时显式同步。

## 镜像准备（应用所有者操作）

安装并启动支持Linux容器的Docker。缺Docker/本地镜像时明确`SANDBOX_UNAVAILABLE`，绝不回退宿主机Python/Node。在含[Dockerfile](<../sandbox/Dockerfile>)、[固定依赖](<../sandbox/requirements.txt>)和[受限构建上下文](<../.dockerignore>)的目录执行：

```powershell
docker build -f sandbox/Dockerfile -t thu-campus-sandbox-python:1.4.0 .
docker pull node:24-bookworm-slim
```

镜像准备可以联网，执行期只检查/冻结本地image ID，不自动pull/build/装包。Python镜像用uv管理`/opt/venv`，无Conda；预装NumPy、SciPy、pandas、sklearn、matplotlib、ReportLab、pypdf、notebook/Office库及中文字体。额外依赖由所有者审查后扩镜像，不能回退宿主安装。镜像可由`THU_CAMPUS_APP_SANDBOX_PYTHON_IMAGE`/`THU_CAMPUS_APP_SANDBOX_NODE_IMAGE`指定，不是模型参数。

## 执行与文件边界

- 只挂当前账号/会话缓存到`/workspace`；可信账本、云盘绑定、凭据、宿主根和Docker socket均不挂入。
- 固定Python/Node入口、无shell拼接、不转发整个宿主环境；禁网、根只读、非root、cap-drop ALL、no-new-privileges，并限制CPU/内存/PID/tmpfs/时间。
- 主脚本使用审批时冻结字节；数据和被显式加载模块仍是可变输入，不承诺冻结整个工作区。内部冻结临时主脚本不上传云盘。
- 对话停止不是容器停止；作业卡精确取消。删除会话/退出运行时回收自有容器，云盘离线不妨碍该回收；不碰其他容器。
- 重启或不明确回执不能标成功。Docker/宿主内核仍是边界，非root容器不等于能抵御内核漏洞。
- Linux以非root应用用户运行，同UID/GID读取私有文件；不放宽整个目录权限。Windows用非root容器用户。
- 路径边界不代替OS隔离：拒绝越界、链接/junction；ZIP先校验全部条目和目标，拒绝ZipSlip、坏CRC、链接及超限。仅ASCII/UTF-8名，不支持ZIP64、加密或分卷；预检后I/O失败可能留下本次新文件，不删除原有数据。
- 单文件32MiB、归档/累计解压64MiB、最多1000条、解压率100；云盘同步另有累计64MiB预算。文本分页`nextOffset`是资源边界，不是Agent迭代次数上限。

本机附件会交给模型/脚本，请核对来源。设备令牌有操作权限，部署须强令牌与HTTPS，不用公开演示令牌。

## 验证

```powershell
npm run e2e:web
npm run e2e:workspace
npm run e2e:auth-workspace # 真HTTP/Chromium+受控认证/同步失败样本
npm run e2e:sandbox        # 真Docker科学计算/PDF/ZIP与隔离约束
```

受控回归不调用计费模型，不执行真实课堂/作业提交。真实云盘初始化/小样本读写必须另行限定私有范围并记录回执，不与模拟测试混称。手机实机仍暂停；覆盖率、静态评分的工具/口径/范围单独报告，不以通过率替代覆盖率。
