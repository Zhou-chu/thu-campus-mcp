# 会话手动宽度调节验收

## 功能与边界

- 桌面会话左右两侧提供44×88px拖柄，按指针位移双边居中缩放；顶栏“宽度”可用滑块精调及恢复默认。
- 默认保留原1440px外框上限与原阅读宽度。手动选择后正文、工具卡、输入区及顶栏内层同步变化，解除正文固定窄栏，而非只改变空白外框。
- 最窄640px，可用空间不足时占满；最大为侧栏之外的可用版心，不越界或横向滚动。拖动时不重新渲染会话或重启流式请求，保留草稿、用户上翻和待发消息。
- 拖柄支持方向键32px、Shift方向键128px，Home/End最窄/最宽，Enter或空格恢复默认；双击也恢复默认。Escape可撤销未完成的拖动。
- 宽度只存本浏览器localStorage中的数字，不发送后台、不读写校园文件。松开指针或滑块确认后保存；刷新恢复，存储失败在宽度控件内保留错误。非法存储值安全退回默认，不接受CSS片段。
- <900px自动响应式，隐藏桌面拖柄和宽度控件，不把手机宽度覆盖桌面偏好；恢复宽屏后沿用原偏好。设置等非会话页不受手动宽度影响。
- 后台与用户当前任务未重启。已打开的旧页面需等当前任务及待发消息处理完后刷新加载。未重打Windows便携包，未恢复暂停中的手机实机测试。

## 实测结果

Node原生V8，范围为宽度偏好、待发队列、首页动作、侧栏数据、异步反馈五个纯逻辑模块。DOM绑定通过真实浏览器交互验收，不把整套DOM前端冒充已100%单元覆盖。

| 范围 | 测试 | 行覆盖 | 分支覆盖 | 函数覆盖 |
| --- | ---: | ---: | ---: | ---: |
| 新宽度偏好模型 | 14/14 | 100.00% | 100.00% | 100.00% |
| 五个纯逻辑模块合计 | 52/52 | 100.00% | 98.87% | 100.00% |

覆盖数字读写、非法及恶意输入、存储不可用/失败与恢复、双侧拖动数学、键盘步进与边界、临时更新/最终持久化、窄屏约束不覆盖原偏好。

静态范围为主界面、宽度DOM绑定及上述五个纯模块，共237个函数，233个未越软阈、4个越软阈，硬超限0，评分98.31。使用项目自定义TypeScript AST指标，不是Sonar分数；公式为`round2(100 × 未越软阈函数 / 函数总数)`，软阈复杂度20/嵌套5/有效行100/参数5，硬上限50/8/200/8，至少90分且无硬超限。

| 真实Chromium回归 | 通过 |
| --- | ---: |
| 页面、模型与首页 | 73/73 |
| 流式、排队与新增手动宽度 | 68/68 |
| 作业、产物及审批 | 38/38 |
| 认证真值、私有范围与键盘 | 45/45 |
| 合计 | 224/224 |

新增16项操作真实鼠标与键盘，使用包含长正文、工具记录、流式工具续轮及待发消息的受控会话：

- 右柄拖动实际缩放且保持居中，长正文和工具卡随消息内层扩展，输入区和顶栏与外框同宽；不是只改CSS变量后看静态字符串。
- 左柄向外加宽、方向键与Shift步进、Home/End边界、双击及顶栏恢复默认、滑块真实键盘操作。
- 拖动保留草稿、上翻位置与待发项；上游继续增量输出且模型请求没有重启。Escape取消未完成拖动且不覆盖已保存数值。
- 刷新恢复；1280宽度临时约束、390×640隐藏桌面控件并保留偏好、回1920恢复桌面宽度；设置页不受污染。
- 深浅主题截图检查；最窄640px时模型、发送和停止仍可操作，无横向溢出；页面脚本异常0。

原预览另做只读加载与12组深浅主题/宽度检查（390/1280/1536/1920/2350/2560），首页及受控长消息无回退。所有模型、工具执行为受控夹具，没有真实计费模型或校园写入；390px为Chromium模拟视口，不是手机实机。

## 复现命令

```powershell
node --test --experimental-test-coverage --test-coverage-include=webui/chat-width.js --test-coverage-include=webui/turn-queue.js --test-coverage-include=webui/chat-home.js --test-coverage-include=webui/sidebar.js --test-coverage-include=webui/ui-feedback.js --test-coverage-lines=90 --test-coverage-branches=90 --test-coverage-functions=90 test/chat-width.test.mjs test/turn-queue.test.mjs test/chat-home.test.mjs test/sidebar.test.mjs test/ui-feedback.test.mjs
node scripts/audit-code-smells.mjs --scope webui/app.js --scope webui/chat-width.js --scope webui/chat-width-ui.js --scope webui/turn-queue.js --scope webui/chat-home.js --scope webui/ui-feedback.js --scope webui/sidebar.js --json
node scripts/e2e-streaming.mjs
node scripts/e2e-web.mjs --json
node scripts/e2e-workspace.mjs
node scripts/e2e-auth-workspace.mjs
```

截图与原始运行日志仅在忽略的本地目录，没有提交缓存、凭据、运行态或临时截图。
