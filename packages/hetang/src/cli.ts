#!/usr/bin/env node
import { stdout } from "node:process";
import { loadConfig } from "./config.js";
import { AuthStore } from "./auth.js";
import { serve } from "./server.js";
import { runJob } from "./jobs.js";
import { makeClient } from "./factory.js";
import { publicError } from "./types.js";
async function main() {
  const [cmd = "help", sub, ...args] = process.argv.slice(2),
    cfg = loadConfig(),
    store = new AuthStore(cfg.stateDir);
  const print = (v: unknown) => stdout.write(JSON.stringify(v, null, 2) + "\n");
  if (cmd === "serve") {
    await serve(cfg);
    return;
  }
  if (cmd === "worker") {
    await runJob(cfg, sub);
    return;
  }
  if (cmd === "auth") {
    if (sub === "browser") {
      const { browserLogin } = await import("./browser-auth.js");
      print(
        await browserLogin(
          cfg,
          args.includes("--chrome") ? "chrome" : "msedge",
        ),
      );
      return;
    }
    if (sub === "status") {
      print(await store.status());
      return;
    }
    if (sub === "logout") {
      await store.clear();
      print({ configured: false });
      return;
    }
  }
  if (cmd === "doctor" || cmd === "status") {
    print({
      mode: cfg.mock ? "mock" : "real",
      authentication: await store.status(),
      outputDir: cfg.outputDir,
      cloudCli: cfg.cloudCli,
      node: process.version,
    });
    return;
  }
  if (cmd === "courses") {
    print({ courses: await (await makeClient(cfg)).courses() });
    return;
  }
  if (cmd === "install" || cmd === "uninstall") {
    const { installClients } = await import("./install.js");
    print(
      await installClients({
        apply: sub === "--apply" || args.includes("--apply"),
        uninstall: cmd === "uninstall",
      }),
    );
    return;
  }
  stdout.write(
    "荷塘雨课堂 MCP\n\nnode dist/cli.js auth browser\nnode dist/cli.js auth status\nnode dist/cli.js auth logout\nnode dist/cli.js courses\nnode dist/cli.js doctor\nnode dist/cli.js install --apply\nnode dist/cli.js serve\n\n答题由当前 Harness 模型完成，无需另配 API Key。\n",
  );
}
main().catch((e) => {
  process.stderr.write(JSON.stringify(publicError(e)) + "\n");
  process.exitCode = 1;
});
