# 开源来源、实际依赖与协议参考

本清单区分实际随包分发的源代码、通过 npm 安装的运行时、仅核对接口的项目和未采用的调研项目。整合包自己的协调代码采用 [MIT](LICENSE)，不会替代各依赖的许可证。

## 1. 随包源代码

| 来源 | 固定源提交 | 用法 | 许可及保留位置 |
| --- | --- | --- | --- |
| [Zhou-chu/learnX_MCP](https://github.com/Zhou-chu/learnX_MCP) | `8d9fcd39f74743583223f754d5d278e6135df094` | 整体导入网络学堂 MCP 的已提交运行代码与测试 | [模块 MIT](packages/learnx/LICENSE) |
| [Zhou-chu/thu-cloud-mcp](https://github.com/Zhou-chu/thu-cloud-mcp) | `991aa558f74ce8962ab40584ffc22521b5499444` | 整体导入清华云盘 MCP 的已提交运行代码与测试 | [模块 MIT](packages/thu-cloud/LICENSE) |
| 本机 hetang-mcp | `6d365e4951a8e2f755111cdcb47edd2dad33f3d1` | 导入独立实现的雨课堂 MCP；整合后将默认云盘 CLI 改为包内相对路径 | [模块 MIT](packages/hetang/LICENSE) |
| [robertying/thu-learn-lib](https://github.com/robertying/thu-learn-lib/tree/1b79b984f34a6f1ca0532beaf59abac55db7f52c) | `1b79b984f34a6f1ca0532beaf59abac55db7f52c`，4.0.0 | **实际网络学堂运行依赖**，包含原始 TypeScript、编译 ESM 与声明；运行代码未修改，包元数据裁剪开发构建项 | [Harry Chen MIT](packages/learnx/vendor/thu-learn-lib/LICENSE)、[来源记录](packages/learnx/vendor/thu-learn-lib/PROVENANCE.md) |

`thu-learn-lib` 与 [robertying/learnX](https://github.com/robertying/learnX/tree/e6d81fbeb619b0837263688839b8e01c5c664ebe) 当时锁文件中的版本对齐。learnX 是方案和版本来源，**没有复制或打包 React Native 应用代码，也不要求安装该 App**。本整合包不是 learnX 官方发行。

[source-snapshots.json](docs/source-snapshots.json) 保存三份来源的原始文件 SHA256，供审计导入来源；整合变更在同文件单独列出。仅导入代码、测试、说明与许可；没有复制原 Git 历史、登录凭据、课程文件或个人验收记录。

## 2. npm 运行与构建依赖

根 [package-lock.json](package-lock.json) 固定完整依赖树；[DEPENDENCIES.md](docs/DEPENDENCIES.md) 和 [JSON 清单](docs/dependency-licenses.json) 包括传递依赖、开发依赖及不同平台的可选依赖。依赖由 `npm ci` 下载，各 npm 包随附自己的许可文件，源代码整合包不重新打包 node_modules。

| 依赖项目 | 实际作用 | 主要许可 |
| --- | --- | --- |
| [modelcontextprotocol/typescript-sdk](https://github.com/modelcontextprotocol/typescript-sdk) | 三个服务的 MCP stdio、工具、客户端桥接 | MIT |
| [microsoft/playwright](https://github.com/microsoft/playwright)（playwright-core） | 本机 Edge 登录、雨课堂页面截图；不随包下载浏览器 | Apache-2.0 |
| [Hopding/pdf-lib](https://github.com/Hopding/pdf-lib) | 课件图片生成 PDF | MIT |
| [cheeriojs/cheerio](https://github.com/cheeriojs/cheerio)、[fb55/entities](https://github.com/fb55/entities) | 网络学堂 HTML 解析和实体解码 | MIT / BSD-2-Clause |
| [mixmark-io/turndown](https://github.com/mixmark-io/turndown) | HTML 转 Markdown | MIT |
| [salesforce/tough-cookie](https://github.com/salesforce/tough-cookie)、[valeriangalliat/fetch-cookie](https://github.com/valeriangalliat/fetch-cookie) | 网络学堂 Cookie 容器与请求 | BSD-3-Clause / Unlicense |
| [dankogai/js-base64](https://github.com/dankogai/js-base64)、[unjs/node-fetch-native](https://github.com/unjs/node-fetch-native)、[JuneAndGreen/sm-crypto](https://github.com/JuneAndGreen/sm-crypto) | thu-learn-lib 的编码、请求及学校认证加密依赖 | BSD-3-Clause / MIT / MIT |
| [moxystudio/node-proper-lockfile](https://github.com/moxystudio/node-proper-lockfile) | 跨进程锁 | MIT |
| [squirrelchat/smol-toml](https://github.com/squirrelchat/smol-toml) | 客户端 TOML 读取与合并 | BSD-3-Clause |
| [colinhacks/zod](https://github.com/colinhacks/zod) | MCP 工具参数校验 | MIT |
| [microsoft/TypeScript](https://github.com/microsoft/TypeScript)、[vitest-dev/vitest](https://github.com/vitest-dev/vitest)、[prettier/prettier](https://github.com/prettier/prettier)、[DefinitelyTyped](https://github.com/DefinitelyTyped/DefinitelyTyped) | 构建、测试、格式化及声明，开发阶段使用 | Apache-2.0 / MIT / MIT / MIT |

表中的许可是主要直接包的声明；完整版本、复合许可和传递包以生成清单及包内 LICENSE 为准。含 MPL-2.0 的可选构建工具条目属于开发依赖，也保留在完整清单中。

## 3. 协议/文档参考：没有复制其实现

| 参考项目 | 核对内容 | 处理方式 |
| --- | --- | --- |
| [haiwen/seafile-open-api](https://github.com/haiwen/seafile-open-api)、[Seafile 官方 Web API](https://plus.seafile.com/published/web-api/home.md)、[haiwen/seahub](https://github.com/haiwen/seahub) | 云盘 REST、上传回执、目录、令牌范围、移动复制语义 | 独立实现 REST 适配，不打包 Seafile/Seahub 服务端代码 |
| [ZaytsevZY/yuketang-helper-auto](https://github.com/ZaytsevZY/yuketang-helper-auto/tree/ec42b39f8bfe746133d350bd25858c814c1d3622) | 实时课堂 WebSocket、进入课堂、已发布题与提交、资源端点 | LICENSE 有 MIT 正文及附加说明、版权归属声明；只参考协议，未复制源码、桌面 UI 或答题重投逻辑 |
| [fu-zc23/proyuketang-afterclassCrawler](https://github.com/fu-zc23/proyuketang-afterclassCrawler)、[inclassCrawler](https://github.com/fu-zc23/proyuketang-inclassCrawler) | 课后课件和回放接口数据形状 | README 标注 CC BY-NC-SA 4.0；未复制其代码和扫码实现 |
| [0-Br/RainDownloader](https://github.com/0-Br/RainDownloader) | 回放原始分段能力 | 未复制代码或合并实现 |

## 4. 调研过但未作为依赖的项目

- [DragonAura/THU-Yuketang-Helper-AI](https://github.com/DragonAura/THU-Yuketang-Helper-AI)：清华扫码及自动答题能力调研，当时没有可读取的完整 LICENSE，未复制。
- [smartThise/OneTHU](https://github.com/smartThise/OneTHU)：校园应用能力调研，有非商业等附加限制，未复制。
- [fenixstarlord/seafile-mcp-server](https://github.com/fenixstarlord/seafile-mcp-server)、[virtUOS/seafile-mcp](https://github.com/virtUOS/seafile-mcp)、[class-undefined/thufs](https://github.com/class-undefined/thufs)：云盘能力范围调研，没有作为运行依赖。前两者在原调研时未取得可直接复用的完整许可文本。

更细的历史依据保留在 [云盘来源](packages/thu-cloud/PROVENANCE.md)、[雨课堂来源](packages/hetang/PROVENANCE.md)。未复制的项目不因被链接而被授予本仓库 MIT 许可。

## 5. CI 基础设施

GitHub Actions 使用官方 [actions/checkout](https://github.com/actions/checkout)、[actions/setup-node](https://github.com/actions/setup-node)、[actions/upload-artifact](https://github.com/actions/upload-artifact)，工作流固定到已核对的提交 SHA。它们只在 CI 运行，不是本机 MCP 的运行依赖。Windows、Edge、Node、Claude Code、Codex、Antigravity、DeepSeek Harness 和当前模型是宿主环境，不随源代码包分发。
