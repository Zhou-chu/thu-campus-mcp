#!/usr/bin/env node
/**
 * Windows 桌面外壳：启动本地运行时，再用包内 Chromium 以「应用窗口」打开界面。
 * 不引入 Electron / Tauri / WebView2：窗口就是项目自己锁定版本的 Chromium。
 */
import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir, readFile, writeFile, chmod } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import lockfile from "proper-lockfile";
const here = path.dirname(fileURLToPath(import.meta.url));
export const root = path.dirname(here);
export const stateDir = path.join(homedir(), ".thu-campus-mcp/app");
export const configFile = path.join(stateDir, "desktop.json");
export const lockFile = path.join(stateDir, "desktop.lock");
export const logFile = path.join(stateDir, "desktop.log");
export function buildLaunchArgs({ port, token, profileDir }) {
  return [
    `--app=http://127.0.0.1:${port}/#token=${encodeURIComponent(token)}`,
    `--user-data-dir=${profileDir}`,
    "--window-size=1180,820",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-features=Translate,MediaRouter",
    "--disable-sync",
    "--disable-background-networking",
  ];
}
export async function ensureConfig({ dir = stateDir, port = Number(process.env.THU_CAMPUS_APP_PORT) || 8971 } = {}) {
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, "desktop.json");
  let existing;
  try {
    existing = JSON.parse(await readFile(file, "utf8"));
  } catch {
    existing = null;
  }
  if (existing?.token && Number.isInteger(existing.port)) return { ...existing, file, created: false };
  const config = { port, token: randomBytes(32).toString("base64url"), createdAt: new Date().toISOString() };
  await writeFile(file, JSON.stringify(config, null, 2), { mode: 0o600 });
  await chmod(file, 0o600).catch(() => {});
  return { ...config, file, created: true };
}
export async function waitForHealth({ url, timeoutMs = 30000, intervalMs = 250, fetchImpl = fetch } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last = "";
  while (Date.now() < deadline) {
    try {
      const response = await fetchImpl(url, { signal: AbortSignal.timeout(2000) });
      if (response.ok) {
        const body = await response.json().catch(() => ({}));
        if (body?.ok) return body;
        last = "健康检查返回异常";
      } else last = `HTTP ${response.status}`;
    } catch (e) {
      last = e?.name === "TimeoutError" ? "健康检查超时" : "运行时尚未就绪";
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw Object.assign(new Error(`等待运行时就绪超时：${last}`), { code: "APP_NOT_READY" });
}
export function redact(text, token) {
  const value = String(text ?? "");
  if (!token) return value;
  return value.split(token).join("[令牌已隐藏]");
}
function line(message) {
  process.stdout.write(message + "\n");
}
async function main() {
  const config = await ensureConfig();
  let release;
  try {
    release = await lockfile.lock(stateDir, { stale: 60000, retries: 0, lockfilePath: lockFile });
  } catch {
    line("桌面端已在运行，本次不重复启动。");
    return;
  }
  let runtime = null;
  let window = null;
  let closing = false;
  const cleanup = async (reason) => {
    if (closing) return;
    closing = true;
    if (reason) line(`退出：${reason}`);
    if (window && window.exitCode === null) window.kill();
    if (runtime && runtime.exitCode === null) {
      runtime.kill("SIGTERM");
      const deadline = Date.now() + 5000;
      while (runtime.exitCode === null && Date.now() < deadline)
        await new Promise((resolve) => setTimeout(resolve, 100));
      if (runtime.exitCode === null) runtime.kill("SIGKILL");
    }
    await release?.().catch(() => {});
  };
  process.on("SIGINT", () => void cleanup("SIGINT").then(() => process.exit(0)));
  process.on("SIGTERM", () => void cleanup("SIGTERM").then(() => process.exit(0)));
  try {
    const browser = await import("@thu-campus/browser");
    const info = await browser.runtimeInfo();
    if (!info?.installed) {
      line("缺少独立 Chromium 内核。请先运行：node bin/thu-campus.mjs browser install");
      await cleanup();
      process.exitCode = 3;
      return;
    }
    await mkdir(stateDir, { recursive: true });
    const log = createWriteStream(logFile, { flags: "a" });
    runtime = spawn(
      process.execPath,
      [path.join(root, "bin/thu-campus.mjs"), "app", "serve", "--port", String(config.port)],
      {
        cwd: root,
        env: { ...process.env, THU_CAMPUS_APP_TOKEN: config.token },
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      },
    );
    runtime.stdout.on("data", (chunk) => log.write(redact(chunk.toString(), config.token)));
    runtime.stderr.on("data", (chunk) => log.write(redact(chunk.toString(), config.token)));
    runtime.once("exit", (code) => {
      log.write(`[launcher] runtime exited code=${code}\n`);
      if (!closing) void cleanup("运行时已退出").then(() => (process.exitCode = code ?? 1));
    });
    await waitForHealth({ url: `http://127.0.0.1:${config.port}/healthz` });
    line(`运行时已就绪：http://127.0.0.1:${config.port}`);
    window = spawn(info.executablePath, buildLaunchArgs({
      port: config.port,
      token: config.token,
      profileDir: path.join(stateDir, "desktop-profile"),
    }), { stdio: "ignore", windowsHide: false });
    line("桌面窗口已打开。关闭窗口即退出应用。");
    window.once("exit", () => void cleanup("窗口已关闭").then(() => process.exit(0)));
  } catch (e) {
    line(`启动失败：${e?.message || e}`);
    await cleanup();
    process.exitCode = e?.code === "APP_NOT_READY" ? 2 : 1;
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(async (e) => {
    line(`启动失败：${e?.message || e}`);
    process.exitCode = 1;
  });
}