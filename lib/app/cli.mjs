import path from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { readFile as readFileBytes } from "node:fs/promises";
import { appConfig, lanUrls, isLoopback, packageVersion, publicBase, loginCapability } from "./settings.mjs";
import { DeviceStore } from "./devices.mjs";
import { PairingCodes, writeInvite } from "./pairing.mjs";
import { writeRuntime, readRuntime, clearRuntime } from "./runtime-state.mjs";
import { createServiceProbe } from "./states.mjs";
import { createKeepAlive } from "./keepalive.mjs";
import {
  DEFAULT_TASK,
  wrapperContent,
  installTask,
  uninstallTask,
  taskStatus,
  startTask,
  startupEntryPath,
  installStartup,
  uninstallStartup,
  startupStatus,
  wrapperMismatch,
  readWrapperPort,
  explainFailure,
} from "./service.mjs";
import { spawn as spawnChild } from "node:child_process";
import { SessionStore } from "./sessions.mjs";
import { createModelRoute, assertPortFree } from "./model.mjs";
import { ToolHost } from "./host.mjs";
import { createWorkspaceHost } from "./workspace.mjs";
import { createAppServer } from "./server.mjs";
const help = `清华校园独立应用：本地运行时与四端接入

node bin/thu-campus.mjs app serve [--port 8971] [--host 127.0.0.1] [--open]
node bin/thu-campus.mjs app invite [--json]
node bin/thu-campus.mjs app devices [--revoke <id>]
node bin/thu-campus.mjs app status
node bin/thu-campus.mjs app service install|start|status|uninstall

app serve 启动本机运行时，提供 WebUI 与 /api/*；浏览器、桌面端、Android、
HarmonyOS 通过一次性配对码接入同一份登录态。模型默认走 madmodel。
密码与验证码只在本机浏览器输入；令牌与设备摘要保存在当前 Windows 用户的 DPAPI 文件。
`;
function line(message) {
  process.stdout.write(message + "\n");
}
function parseFlags(args) {
  const flags = {};
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (!arg.startsWith("--")) continue;
    const name = arg.slice(2);
    const next = args[i + 1];
    if (next === undefined || next.startsWith("--")) flags[name] = true;
    else {
      flags[name] = next;
      i += 1;
    }
  }
  return flags;
}
function applyFlags(config, flags) {
  if (flags.port !== undefined) {
    const port = Number(flags.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535)
      throw Object.assign(new Error("--port 必须是 1–65535 的整数。"), { code: "USAGE" });
    config.port = port;
  }
  if (typeof flags.host === "string") {
    config.host = flags.host;
    if (!isLoopback(flags.host) && !config.token)
      throw Object.assign(
        new Error("监听非回环地址必须设置 THU_CAMPUS_APP_TOKEN。"),
        { code: "INSECURE_LISTEN" },
      );
  }
  return config;
}
async function serve(config, flags) {
  const free = await assertPortFree(config.port, config.host);
  if (!free.free)
    throw Object.assign(
      new Error(
        free.code === "APP_PORT_BUSY"
          ? `端口 ${config.port} 已被占用，请关闭已有运行时或换 --port。`
          : `无法监听端口 ${config.port}：${free.code}。`,
      ),
      { code: free.code === "APP_PORT_BUSY" ? "APP_PORT_BUSY" : "APP_PORT_ERROR" },
    );
  let host;
  try {
    host = createWorkspaceHost({ host: await ToolHost.start(), stateDir: config.stateDir, pythonImage: config.sandboxPythonImage, nodeImage: config.sandboxNodeImage });
  } catch (e) {
    throw Object.assign(
      new Error(
        e?.code === "ERR_MODULE_NOT_FOUND" || /MODULE_NOT_FOUND/.test(e?.message || "")
          ? "校园服务尚未构建，请先执行 npm ci 与 npm run build。"
          : "无法启动校园工具主机，请检查模块构建与登录状态。",
      ),
      { code: "APP_HOST_FAILED" },
    );
  }
  let tls = null;
  if (config.tlsCert) {
    try {
      tls = {
        cert: await readFileBytes(config.tlsCert),
        key: await readFileBytes(config.tlsKey),
      };
    } catch {
      await host.close();
      throw Object.assign(
        new Error("无法读取 TLS 证书或私钥，请检查 THU_CAMPUS_APP_TLS_CERT/KEY 路径。"),
        { code: "TLS_UNREADABLE" },
      );
    }
    if (!tls.cert.length || !tls.key.length) {
      await host.close();
      throw Object.assign(new Error("TLS 证书或私钥为空。"), { code: "TLS_UNREADABLE" });
    }
  } else if (!isLoopback(config.host)) {
    process.stderr.write(
      JSON.stringify({
        event: "app-insecure-remote",
        message:
          "正在以明文 HTTP 监听非回环地址。托管部署应配置 THU_CAMPUS_APP_TLS_CERT/KEY，或在前置反向代理终止 TLS。",
      }) + "\n",
    );
  }
  const keepAlive = createKeepAlive({
    probe: createServiceProbe(host),
    restore: (service) =>
      new Promise((resolve) => {
        const child = spawnChild(
          process.execPath,
          [path.join(config.root, "bin/thu-campus.mjs"), "browser", "restore", service],
          { env: process.env, windowsHide: true, stdio: "ignore" },
        );
        child.once("error", () => resolve({ ok: false, code: "RESTORE_FAILED" }));
        child.once("exit", (code) =>
          resolve(code === 0 ? { ok: true } : { ok: false, code: "RESTORE_FAILED" }),
        );
      }),
    intervalMs: config.keepAliveMinutes * 60000,
    restoreExpired: config.keepAliveRestore,
    logger: (event, detail) =>
      process.stderr.write(JSON.stringify({ at: new Date().toISOString(), event, ...detail }) + "\n"),
  });
  const devices = new DeviceStore(config.stateDir);
  const pairing = new PairingCodes();
  const sessions = new SessionStore(config.stateDir);
  const route = createModelRoute(config);
  const version = await packageVersion();
  const app = createAppServer({
    config,
    host,
    route,
    devices,
    pairing,
    sessions,
    version,
    tls,
    keepAlive,
    logger: (event, detail) =>
      process.stderr.write(
        JSON.stringify({ at: new Date().toISOString(), event, ...detail }) + "\n",
      ),
  });
  let url;
  try {
    url = await app.listen();
  } catch (e) {
    await host.close();
    throw Object.assign(
      new Error(
        e?.code === "EADDRINUSE"
          ? `端口 ${config.port} 已被占用。`
          : `监听失败：${e?.code || e?.message || "UNKNOWN"}。`,
      ),
      { code: "APP_LISTEN_FAILED" },
    );
  }
  writeRuntime(config.stateDir, {
    host: config.host,
    port: config.port,
    publicUrl: publicBase(config),
    pid: process.pid,
    version,
    startedAt: new Date().toISOString(),
  });
  line(
    JSON.stringify(
      {
        ok: true,
        event: "app-started",
        url,
        publicUrl: publicBase(config),
        https: !!config.tlsCert,
        hosted: !isLoopback(config.host) || !!config.publicUrl,
        version,
        modelRoute: config.modelRoute,
        pairingEnabled: !config.token,
        lanUrls: isLoopback(config.host) ? lanUrls(config.port) : [],
        stateDir: config.stateDir,
        webui: path.join(config.root, "webui"),
      },
      null,
      2,
    ),
  );
  if (!config.token) {
    const issued = pairing.issue();
    line(`首次配对码：${issued.code}（${issued.ttlSeconds} 秒内有效，一次性）`);
    if (!isLoopback(config.host) || lanUrls(config.port).length)
      for (const lan of lanUrls(config.port)) line(`局域网地址：${lan}`);
  }
  keepAlive.start();
  const first = await keepAlive.runOnce("startup").catch(() => null);
  if (first?.actions?.length)
    line(JSON.stringify({ event: "keepalive-startup", actions: first.actions }));
  if (flags.open) {
    const { spawn } = await import("node:child_process");
    const opener =
      process.platform === "win32"
        ? ["cmd", ["/c", "start", "", url]]
        : process.platform === "darwin"
          ? ["open", [url]]
          : ["xdg-open", [url]];
    spawn(opener[0], opener[1], { detached: true, stdio: "ignore" }).unref();
  }
  const shutdown = async (signal) => {
    line(JSON.stringify({ ok: true, event: "app-stopping", signal }));
    keepAlive.stop();
    clearRuntime(config.stateDir);
    await app.close().catch(() => {});
    await host.close().catch(() => {});
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  return new Promise(() => {});
}
async function invite(config, flags) {
  if (config.token) {
    const headers = { Authorization: "Bearer " + config.token };
    const body = await fetch(`http://${config.host}:${config.port}/api/pair/invite`, {
      method: "POST",
      headers,
    }).catch(() => null);
    if (!body?.ok) {
      line(
        JSON.stringify(
          {
            ok: false,
            error: {
              code: "APP_NOT_RUNNING",
              message: "运行时未启动或需要设备令牌；先运行 app serve。",
            },
          },
          null,
          2,
        ),
      );
      process.exitCode = 1;
      return;
    }
    const data = await body.json();
    line(JSON.stringify(data, null, 2));
    return;
  }
  // 未设置固定令牌：写一个 5 分钟一次性码，由运行中的 app serve 在兑换时读取。
  const running = readRuntime(config.stateDir);
  const probeHost = running?.host === "0.0.0.0" ? "127.0.0.1" : running?.host || config.host;
  const probePort = running?.port || config.port;
  const code = String(Math.floor(Math.random() * 1000000)).padStart(6, "0");
  const expiresAt = Date.now() + 300000;
  writeInvite(config.stateDir, { code, expiresAt });
  const health = await fetch(`http://${probeHost}:${probePort}/healthz`, {
    signal: AbortSignal.timeout(3000),
  })
    .then((r) => r.ok)
    .catch(() => false);
  line(
    JSON.stringify(
      {
        ok: true,
        code,
        expiresAt: new Date(expiresAt).toISOString(),
        ttlSeconds: 300,
        runtimeReachable: health,
        runtime: running ? { pid: running.pid, host: running.host, port: running.port } : null,
        lanUrls: [
          ...(running?.publicUrl ? [running.publicUrl] : []),
          ...laneFor(config, probePort),
        ].filter((value, index, all) => all.indexOf(value) === index),
        note: health
          ? "5 分钟内、一次性；在手机或另一台设备上兑换。"
          : "运行时当前不可达；该码在 app serve 起来后、到期前仍然有效。",
      },
      null,
      2,
    ),
  );
}
async function devicesCommand(config, flags) {
  const store = new DeviceStore(config.stateDir);
  if (flags.revoke)
    return line(
      JSON.stringify(
        { ok: await store.revoke(String(flags.revoke)) },
        null,
        2,
      ),
    );
  return line(JSON.stringify({ ok: true, devices: await store.list() }, null, 2));
}
async function serviceCommand(config, flags, args) {
  const sub = args[0] || "status";
  const name = process.env.THU_CAMPUS_APP_TASK || DEFAULT_TASK;
  const wrapperPath = path.join(config.stateDir, "service-run.cmd");
  const logFile = path.join(config.stateDir, "service.log");
  const port = Number(flags.port) || config.port;
  const host = flags.host || config.host;
  const content = wrapperContent({
    nodePath: process.execPath,
    entryPath: path.join(config.root, "bin/thu-campus.mjs"),
    port,
    host,
    stateDir: config.stateDir,
    logFile,
    extraEnv: {
      THU_CAMPUS_APP_PUBLIC_URL: config.publicUrl,
      THU_CAMPUS_APP_TLS_CERT: config.tlsCert,
      THU_CAMPUS_APP_TLS_KEY: config.tlsKey,
      THU_CAMPUS_APP_ALLOW_REMOTE: config.allowRemote ? "1" : "",
      THU_CAMPUS_APP_KEEPALIVE_MINUTES: String(config.keepAliveMinutes),
    },
  });
  if (sub === "install") {
    if (flags.startup === true) {
      const entryPath = startupEntryPath();
      installStartup({ entryPath, content });
      return line(
        JSON.stringify(
          {
            ok: true,
            event: "service-installed",
            mode: "startup-folder",
            entryPath,
            logFile,
            note: "放进当前用户的「启动」文件夹，登录即运行。",
          },
          null,
          2,
        ),
      );
    }
    let result;
    try {
      result = await installTask({ name, wrapperPath, content });
    } catch (e) {
      const mapped = explainFailure(e);
      if (mapped.code === "SERVICE_ACCESS_DENIED")
        return line(
          JSON.stringify(
            { ok: false, error: { code: mapped.code, message: mapped.message } },
            null,
            2,
          ),
        );
      throw mapped;
    }
    return line(
      JSON.stringify(
        {
          ok: true,
          event: "service-installed",
          mode: "scheduled-task",
          task: name,
          wrapperPath: result.wrapperPath,
          logFile,
          port,
          host,
          note:
            Number(flags.port) || flags.host
              ? "当前用户的登录计划任务。注意：--port/--host 只对本次安装生效，不会写回配置，因此 status 会把它显示为与配置不一致。"
              : "当前用户的登录计划任务，不需要管理员权限；可用 app service start 立即启动。",
        },
        null,
        2,
      ),
    );
  }
  if (sub === "start") {
    const result = await startTask({ name });
    return line(JSON.stringify({ ok: true, ...result }, null, 2));
  }
  if (sub === "uninstall") {
    const entryPath = startupEntryPath();
    const startupRemoved = uninstallStartup({ entryPath }).removed;
    const taskRemoved = (await uninstallTask({ name, wrapperPath }).catch(() => ({ removed: false }))).removed;
    return line(
      JSON.stringify(
        { ok: true, startupRemoved, taskRemoved, wrapperPath: existsSync(wrapperPath) ? wrapperPath : null, logFile },
        null,
        2,
      ),
    );
  }
  if (sub === "status") {
    const entryPath = startupEntryPath();
    const startup = startupStatus({ entryPath });
    const task = await taskStatus({ name });
    const expectedPort = config.port;
    let wrapper = null;
    if (existsSync(wrapperPath)) {
      const current = readFileSync(wrapperPath, "utf8");
      const desired = wrapperContent({
        nodePath: process.execPath,
        entryPath: path.join(config.root, "bin/thu-campus.mjs"),
        port: expectedPort,
        host: config.host,
        stateDir: config.stateDir,
        logFile,
        extraEnv: {
          THU_CAMPUS_APP_PUBLIC_URL: config.publicUrl,
          THU_CAMPUS_APP_TLS_CERT: config.tlsCert,
          THU_CAMPUS_APP_TLS_KEY: config.tlsKey,
          THU_CAMPUS_APP_ALLOW_REMOTE: config.allowRemote ? "1" : "",
          THU_CAMPUS_APP_KEEPALIVE_MINUTES: String(config.keepAliveMinutes),
        },
      });
      wrapper = {
        path: wrapperPath,
        port: readWrapperPort(current),
        expectedPort,
        drift: wrapperMismatch(current, desired),
      };
    }
    return line(
      JSON.stringify(
        {
          ok: true,
          installed: startup.installed || task.installed,
          startup,
          task,
          wrapper,
          wrapperPath: existsSync(wrapperPath) ? wrapperPath : null,
          logFile,
          hint: wrapper?.drift ? "包装脚本与当前配置不一致：重新执行 app service install 即可同步。" : null,
        },
        null,
        2,
      ),
    );
  }
  throw Object.assign(new Error("可用 app service：install、start、status、uninstall。"), {
    code: "USAGE",
  });
}
async function status(config) {
  const store = new DeviceStore(config.stateDir);
  const model =
    config.modelRoute === "openai"
      ? { route: "openai", available: !!config.modelBaseUrl }
      : await createModelRoute(config)
          .status()
          .catch(() => ({ route: "madmodel", available: false }));
  line(
    JSON.stringify(
      {
        ok: true,
        version: await packageVersion(),
        host: config.host,
        port: config.port,
        stateDir: config.stateDir,
        modelRoute: config.modelRoute,
        model,
        loginCapability: loginCapability(),
        pairingEnabled: !config.token,
        running: readRuntime(config.stateDir),
        devices: await store.list().catch(() => []),
        lanUrls: laneFor(config),
      },
      null,
      2,
    ),
  );
}
function laneFor(config, port = config.port) {
  return isLoopback(config.host) ? lanUrls(port) : [];
}
export async function appCommand(argv = []) {
  const [action, ...rest] = argv;
  if (!action || ["help", "--help", "-h"].includes(action)) {
    process.stdout.write(help);
    return;
  }
  const flags = parseFlags(rest);
  const config = applyFlags(appConfig(), flags);
  if (action === "serve") return serve(config, flags);
  if (action === "invite") return invite(config, flags);
  if (action === "devices") return devicesCommand(config, flags);
  if (action === "status") return status(config);
  if (action === "service") return serviceCommand(config, flags, rest.filter((item) => !item.startsWith("--")));
  throw Object.assign(
    new Error("可用 app 子命令：serve、invite、devices、status。"),
    { code: "USAGE" },
  );
}










