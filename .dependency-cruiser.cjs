/** 结构健康门禁：禁止循环依赖、约束分层方向，孤立模块只提示。 */
module.exports = {
  forbidden: [
    {
      name: "no-circular",
      severity: "error",
      comment: "循环依赖会让加载顺序与测试变得不可预测。",
      from: {},
      to: { circular: true },
    },
    {
      name: "no-orphans",
      severity: "warn",
      comment: "没有被任何模块引用的文件，通常是死代码或漏挂的入口。",
      from: { orphan: true, pathNot: ["\\.d\\.ts$"] },
      to: {},
    },
    {
      name: "not-to-unresolvable",
      severity: "error",
      comment: "引用了无法解析的模块。",
      from: {},
      to: { couldNotResolve: true },
    },
    {
      name: "app-not-to-webui",
      severity: "error",
      comment: "运行时后端不能依赖浏览器界面代码；界面只通过 HTTP 契约与运行时通信。",
      from: { path: "^lib/app/" },
      to: { path: "^webui/" },
    },
    {
      name: "core-not-to-webui",
      severity: "error",
      comment: "lib 核心（网关、服务装配、浏览器）不依赖 webui。",
      from: { path: "^lib/(?!app/)" },
      to: { path: "^webui/" },
    },
    {
      name: "webui-not-to-runtime",
      severity: "error",
      comment: "webui 是纯浏览器代码，不能直接 import Node 侧运行时或服务源码。",
      from: { path: "^webui/" },
      to: { path: "^(lib/|packages/[^/]+/src/)" },
    },
    {
      name: "packages-not-to-app",
      severity: "error",
      comment: "服务 SDK 不得反向依赖独立应用与界面；依赖方向只能是 app → packages。",
      from: { path: "^packages/[^/]+/src/" },
      to: { path: "^(lib/|webui/|packages/app/)" },
    },
    {
      name: "browser-package-standalone",
      severity: "error",
      comment: "浏览器包是共享底层，不能依赖其它服务包或应用层。",
      from: { path: "^packages/browser/" },
      to: { path: "^(lib/|webui/|packages/(?!browser/))" },
    },
  ],
  options: {
    doNotFollow: { path: "node_modules" },
    tsPreCompilationDeps: true,
    exclude: { path: "(^|/)(node_modules|dist|coverage|\\.local|\\.cache)/" },
  },
};