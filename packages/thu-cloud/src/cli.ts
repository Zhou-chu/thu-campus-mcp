#!/usr/bin/env node
import { emitKeypressEvents } from "node:readline";
import { stdin, stdout } from "node:process";
import { AuthStore } from "./auth.js";
import { loadConfig } from "./config.js";
import { validateToken } from "./client.js";
import { makeDrive } from "./factory.js";
import { serve } from "./server.js";
import { runJob } from "./jobs.js";
import { CloudError, publicError } from "./types.js";

async function hidden(prompt: string): Promise<string> {
  if (!stdin.isTTY)
    throw new CloudError(
      "TTY_REQUIRED",
      "请在本机交互终端运行 auth login；非交互使用 auth import --stdin。",
    );
  stdout.write(prompt);
  emitKeypressEvents(stdin);
  stdin.setRawMode(true);
  stdin.resume();
  return new Promise((resolve, reject) => {
    let value = "";
    const stop = () => {
      stdin.setRawMode(false);
      stdin.off("keypress", handler);
      stdin.pause();
      stdout.write("\n");
    };
    const handler = (str: string, key: { name: string; ctrl: boolean }) => {
      if (key.name === "return") {
        stop();
        resolve(value.trim());
      } else if (key.ctrl && key.name === "c") {
        stop();
        reject(new CloudError("CANCELLED", "已取消。"));
      } else if (key.name === "backspace") value = value.slice(0, -1);
      else if (str && !key.ctrl) value += str;
    };
    stdin.on("keypress", handler);
  });
}
async function main() {
  const [command = "help", sub, ...args] = process.argv.slice(2);
  const config = loadConfig();
  const store = new AuthStore(config.stateDir);
  const print = (v: unknown) => stdout.write(JSON.stringify(v, null, 2) + "\n");
  if (command === "serve") {
    await serve(config);
    return;
  }
  if (command === "worker") {
    await runJob(config, sub);
    return;
  }
  if (command === "status" || command === "doctor") {
    print({
      mode: config.mock ? "mock" : "real",
      authentication: await store.status(),
      sessionValidity: "not_checked",
      node: process.version,
      stateDir: config.stateDir,
      outputDir: config.outputDir,
    });
    return;
  }
  if (command === "libraries") {
    print({ libraries: await (await makeDrive(config)).libraries() });
    return;
  }
  if (command === "install" || command === "uninstall") {
    const { installClients } = await import("./install.js");
    print(
      await installClients({
        apply: sub === "--apply" || args.includes("--apply"),
        uninstall: command === "uninstall",
      }),
    );
    return;
  }
  if (command === "auth") {
    if (sub === "status") {
      print(await store.status());
      return;
    }
    if (sub === "logout") {
      await store.clear();
      print({ configured: false });
      return;
    }
    if (sub === "browser") {
      const { browserLogin } = await import("./browser-auth.js");
      stdout.write(
        "请在新开的本机浏览器完成清华云盘登录；凭据不会进入聊天，最多等待 10 分钟。\n",
      );
      const n = args.indexOf("--channel");
      print(await browserLogin(config, n < 0 ? "msedge" : args[n + 1]));
      return;
    }
    const generation = await store.generation();
    let token: string;
    if (sub === "login")
      token = await hidden("云盘 API Token（不显示；不要输入学校密码）：");
    else if (sub === "import" && args.includes("--stdin")) {
      const parts: Buffer[] = [];
      let bytes = 0;
      for await (const chunk of stdin) {
        const b = Buffer.from(chunk);
        bytes += b.length;
        if (bytes > 2048) throw new CloudError("AUTH_FORMAT", "输入过长。");
        parts.push(b);
      }
      token = Buffer.concat(parts).toString("utf8").trim();
    } else
      throw new CloudError(
        "AUTH_USAGE",
        "可用命令：auth browser / login / import --stdin / status / logout。Token 只在本机输入，不接受命令行参数。",
      );
    const data = await validateToken(token, config);
    await store.saveIfCurrent(data, generation);
    print({
      configured: true,
      verified: true,
      mode: data.mode,
      protection: "Windows-DPAPI",
    });
    return;
  }
  stdout.write(
    "thu-cloud MCP\n\nnode dist/cli.js auth browser [--channel msedge|chrome]\nnode dist/cli.js auth login\nnode dist/cli.js auth import --stdin\nnode dist/cli.js auth status\nnode dist/cli.js auth logout\nnode dist/cli.js libraries\nnode dist/cli.js install --apply\nnode dist/cli.js uninstall --apply\nnode dist/cli.js doctor\nnode dist/cli.js serve\n\n离线模拟：THU_CLOUD_MOCK=1，使用独立的临时 THU_CLOUD_STATE_DIR。\n",
  );
}
main().catch((error) => {
  process.stderr.write(JSON.stringify(publicError(error)) + "\n");
  process.exitCode = 1;
});
