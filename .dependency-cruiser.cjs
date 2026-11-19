/** 结构健康门禁：禁止循环依赖，孤立模块只提示。 */
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
  ],
  options: {
    doNotFollow: { path: "node_modules" },
    tsPreCompilationDeps: true,
    exclude: { path: "(^|/)(node_modules|dist|coverage|\\.local|\\.cache)/" },
  },
};
