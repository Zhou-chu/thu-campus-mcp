#!/usr/bin/env node
import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import {
  service,
  services,
  modulePath,
  serviceEnvironment,
  clientConfig,
} from "../lib/services.mjs";
const help = `清华校园 MCP 1.1：统一入口与独立持久浏览器\n\nnode bin/thu-campus.mjs serve\nnode bin/thu-campus.mjs install --unified [--apply]\nnode bin/thu-campus.mjs config --unified\nnode bin/thu-campus.mjs browser install|status|open|login|close|restore|reset\nnode bin/thu-campus.mjs <learnx|cloud|hetang> <服务命令>\n\n首次安装：npm run setup\n示例：node bin/thu-campus.mjs browser login learnx --account 学号\n密码和验证码只在本机独立浏览器输入；解题使用当前 Harness 模型。\n`;
async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (!command || ["help", "--help", "-h"].includes(command)) {
    process.stdout.write(help);
    return;
  }
  if (command === "serve") {
    const { serveGateway } = await import("../lib/gateway.mjs");
    await serveGateway();
    return;
  }
  if (command === "browser") {
    const [action = "status", target = "all", ...flags] = args;
    const browser = await import("@thu-campus/browser");
    const broker = await import("../lib/browser.mjs");
    let out;
    if (action === "install") out = await browser.installRuntime();
    else if (action === "status") out = await broker.browserOverview();
    else if (action === "worker") {
      await broker.runBrowserJob(target);
      return;
    } else if (action === "close") out = await broker.closeBrowserJobs();
    else if (action === "restore") {
      const names =
        target === "all" ? services.map((s) => s.name) : [service(target).name];
      const restored = {};
      for (const n of names) restored[n] = await broker.restoreService(n);
      out = { restored, at: new Date().toISOString() };
    } else if (action === "reset") {
      if (!args.includes("--confirm"))
        throw Object.assign(
          new Error(
            "清除浏览器资料需要 browser reset --confirm；不会删除 MCP 登录存储。",
          ),
          { code: "USAGE" },
        );
      out = await browser.resetBrowser();
    } else if (action === "open" || action === "login") {
      if (!(await browser.runtimeInfo()).installed)
        await browser.installRuntime();
      const n = flags.indexOf("--account");
      out = await broker.startBrowserJob(
        action,
        target,
        n < 0 ? undefined : flags[n + 1],
      );
    } else
      throw Object.assign(
        new Error("可用 browser install/status/open/login/close/restore/reset。"),
        { code: "USAGE" },
      );
    process.stdout.write(JSON.stringify(out, null, 2) + "\n");
    return;
  }
  if (command === "config") {
    const config = args.includes("--unified")
      ? await (await import("../lib/unified-install.mjs")).unifiedConfig()
      : await clientConfig();
    process.stdout.write(JSON.stringify(config, null, 2) + "\n");
    return;
  }
  if (command === "install" || command === "uninstall") {
    if (args.some((a) => !["--apply", "--unified"].includes(a)))
      throw Object.assign(
        new Error("安装命令支持 --unified、--apply；不加 --apply 只预览。"),
        { code: "USAGE" },
      );
    const install = args.includes("--unified")
      ? (await import("../lib/unified-install.mjs")).installUnified
      : (await import("../lib/install.mjs")).installBundle;
    process.stdout.write(
      JSON.stringify(
        await install({
          apply: args.includes("--apply"),
          uninstall: command === "uninstall",
        }),
        null,
        2,
      ) + "\n",
    );
    return;
  }
  const selected = service(command),
    target = modulePath(selected);
  await access(target).catch(() => {
    throw Object.assign(
      new Error("模块尚未构建，请先执行 npm ci 和 npm run build。"),
      { code: "BUILD_REQUIRED" },
    );
  });
  const child = spawn(
    process.execPath,
    [target, ...(args.length ? args : ["help"])],
    { stdio: "inherit", windowsHide: true, env: serviceEnvironment() },
  );
  const forward = (signal) => {
    if (!child.killed) child.kill(signal);
  };
  const interrupt = () => forward("SIGINT"),
    terminate = () => forward("SIGTERM");
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", terminate);
  const result = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve(code ?? (signal ? 1 : 0)));
  });
  process.off("SIGINT", interrupt);
  process.off("SIGTERM", terminate);
  process.exitCode = result;
}
main().catch((error) => {
  const code = error.code || "BUNDLE_ERROR";
  const message =
    code === "ERR_MODULE_NOT_FOUND"
      ? "模块尚未构建，请先执行 npm ci 和 npm run build。"
      : error.message;
  process.stderr.write(JSON.stringify({ code, message }) + "\n");
  process.exitCode = ["UNKNOWN_SERVICE", "USAGE"].includes(code) ? 2 : 1;
});
