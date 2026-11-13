# Agent工作区与真正隔离执行

独立应用在校园MCP之外提供九项`workspace_*`工具。仅在Agent应用中组合，不给统一校园MCP增加宿主机shell。

## 实际闭环

1. 校园工具定位或下载附件；路径回执不等于已经读过内容。
2. `workspace_import`由用户确认单个绝对源路径，再复制到当前会话工作区。
3. `workspace_zip`列条目/安全解压；`workspace_read`分页读UTF-8文本、CSV、JSON和ipynb源码。PDF/Office/其他二进制不能假读，交给容器脚本与对应库解析。
4. `workspace_write`写脚本；`workspace_run`展示完整冻结脚本、镜像ID与工作区作用域，经确认后提交后台作业。
5. `workspace_job`长轮询核实退出状态、退出码和输出，修正实际错误；`running`不等于计算完成。
6. `workspace_list`核对实际报告/图表/代码文件；`workspace_zip`打包。回复使用回执中的`downloadUrl`，浏览器带设备鉴权下载，不在URL中携带令牌。
7. 校园提交仍需独立确认。不自动执行截图或文档里的任务指令，不重投unknown写入。

## 镜像准备（应用所有者操作）

先安装并启动支持Linux容器的Docker。没有Docker或本地镜像时，工具明确返回`SANDBOX_UNAVAILABLE`，绝不回退宿主机Python/Node。

在包含[Dockerfile](<../sandbox/Dockerfile>)、[固定依赖](<../sandbox/requirements.txt>)和[受限构建上下文](<../.dockerignore>)的源码/便携目录执行：

```powershell
docker build -f sandbox/Dockerfile -t thu-campus-sandbox-python:1.4.0 .
docker pull node:24-bookworm-slim
```

镜像准备可以联网。运行器只检查本地镜像并冻结实际image ID，执行期不自动pull/build或联网安装依赖。Python镜像用uv创建并管理`/opt/venv`，无Conda；预装NumPy、SciPy、pandas、sklearn、matplotlib、ReportLab、pypdf、notebook与Office处理库及中文字体。缺少其他库时应明确报告，由应用所有者审查后扩展镜像，不能回退宿主机安装。

可由启动环境指定`THU_CAMPUS_APP_SANDBOX_PYTHON_IMAGE`与`THU_CAMPUS_APP_SANDBOX_NODE_IMAGE`。这不是模型参数或设备API开关。

## 执行边界

- 每次只挂当前会话工作区到`/workspace`；作业可信账本在挂载范围之外，不挂宿主根目录、校园状态、Docker socket或凭据目录。
- 固定Python/Node入口，无shell拼接；参数只传脚本，不能变Docker开关。不把宿主环境变量整体传入容器。
- 禁网络、容器根目录只读、非root、丢弃capabilities、no-new-privileges，限制CPU/内存/PID/tmpfs与执行时间。
- 主脚本使用审批时冻结的字节，不在确认后重读可变源码。工作区中的数据及被脚本显式加载的其他模块仍是输入，不承诺冻结整个工作区。
- 后台运行与对话停止不同：使用作业卡的“停止运行”精确取消该容器；删除会话或退出运行时也回收自有作业，不操作其他Docker容器。
- 运行时重启或回执不明确不能标成功；恢复时检查并处理自有遗留容器。Docker本身仍是安全边界的一部分，不宣称能抵御内核或Docker漏洞。
- Linux应用须用非root用户运行，以同UID/GID读取私有工作区；不为容器放宽整个目录权限。Windows使用非root容器用户。

本机附件导入会把被确认文件交给模型/脚本，必须认真核对来源；不要使用公开演示令牌部署能导入本地文件的应用。设备令牌具有相应操作权限，应使用强令牌与HTTPS。

## 文件约束

工作区路径检查只是文件操作边界，不是OS沙盒。拒绝越界、链接/junction、默认覆盖；ZIP先校验所有条目和目标，拒绝ZipSlip、坏CRC、链接及资源超限。仅支持ASCII或UTF-8 ZIP名；ZIP64、加密及分卷明确报不支持。预检后的磁盘/I/O故障可能留下本次已发布文件，但不删除原有文件。

单文件写入32MiB、归档/累计解压64MiB、最多1000条目、解压率上限100。文本分页返回`nextOffset`；这些是资源与协议边界，不是工具迭代轮数上限。

## 验证

```powershell
npm run e2e:workspace  # 真实HTTP/Chromium，受控任务样本
npm run e2e:sandbox   # 必须本地镜像就绪，真实Docker计算/PDF/ZIP与隔离限制
```

两组均不调用计费模型，不触碰真实校园数据或执行真实提交。手机实机验收仍暂停。范围覆盖率与全仓覆盖率需分别报告；不以通过率代替覆盖率，不虚构code smell评分。
