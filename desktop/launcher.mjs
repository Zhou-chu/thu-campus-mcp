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
/** 端口、令牌与会话码来自配置/网络响应；进入命令行前先按形状校验，拒绝被拼接的额外参数。 */
export function sanitizeLaunchInput({ port, token = "", sessionCode = "" }) {
  const number = Number(port);
  if (!Number.isInteger(number) || number < 1 || number > 65535) throw Object.assign(new Error("端口不合法。"), { code: "INVALID_ARGUMENTS" });
  const code = typeof sessionCode === "string" ? sessionCode.trim() : "";
  if (code && !/^[A-Za-z0-9_-]{8,256}$/.test(code)) throw Object.assign(new Error("会话码不合法。"), { code: "INVALID_ARGUMENTS" });
  const deviceToken = typeof token === "string" ? token.trim() : "";
  if (!code && !/^[\x20-\x7e]{1,512}$/.test(deviceToken)) throw Object.assign(new Error("设备令牌不合法。"), { code: "INVALID_ARGUMENTS" });
  return { port: number, token: deviceToken, sessionCode: code };
}
export function buildLaunchArgs(input) {
  const { port, token, sessionCode } = sanitizeLaunchInput(input);
  const { profileDir } = input;
  // 优先用一次性会话码：令牌不进入 URL、浏览器历史或 --app= 的命令行。
  const target = sessionCode
    ? `http://127.0.0.1:${port}/?session=${encodeURIComponent(sessionCode)}`
    : `http://127.0.0.1:${port}/#token=${encodeURIComponent(token)}`;
  return [
    `--app=${target}`,
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
export function describeExchangeFailure(error) {
  if (error?.code === "APP_NOT_READY") return "运行时就绪前无法签发会话码，已改用令牌链接；请检查运行时是否正常。";
  return "会话码签发失败，已改用令牌链接；如担心令牌暴露，请关闭窗口后重启应用。";
}
export async function requestSessionCode({ port, token, fetchImpl = fetch } = {}) {
  const response = await fetchImpl(`http://127.0.0.1:${port}/api/session/exchange`, {
    method: "POST",
    headers: { authorization: "Bearer " + token, "content-type": "application/json" },
    body: "{}",
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) throw Object.assign(new Error(`HTTP ${response.status}`), { code: "EXCHANGE_FAILED" });
  const body = await response.json().catch(() => ({}));
  const code = typeof body?.code === "string" ? body.code : "";
  if (!body?.ok || !code) throw Object.assign(new Error("会话码缺失"), { code: "EXCHANGE_FAILED" });
  return code;
}
/**
 * 轮换桌面配置里的本机令牌。没有配置时返回一个新值供环境变量部署使用。
 * 返回的 token 用于一次性展示，调用方负责不落日志。
 */
export async function rotateDesktopToken({ dir = stateDir } = {}) {
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, "desktop.json");
  let existing = null;
  try {
    existing = JSON.parse(await readFile(file, "utf8"));
  } catch {
    existing = null;
  }
  const token = randomBytes(32).toString("base64url");
  if (!existing && !process.env.THU_CAMPUS_APP_TOKEN) {
    return { rotated: false, reason: "没有桌面配置，也没有固定令牌", token };
  }
  if (!existing) {
    return { rotated: false, reason: "固定令牌来自环境变量，服务端无法安全改写", token };
  }
  const next = { ...existing, token, rotatedAt: new Date().toISOString() };
  await writeFile(file, JSON.stringify(next, null, 2), { mode: 0o600 });
  await chmod(file, 0o600).catch(() => {});
  return { rotated: true, file, token };
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
    let sessionCode = "";
    try {
      sessionCode = await requestSessionCode({ port: config.port, token: config.token });
    } catch (error) {
      line(describeExchangeFailure(error));
    }
    window = spawn(info.executablePath, buildLaunchArgs({
      port: config.port,
      token: config.token,
      sessionCode,
      profileDir: path.join(stateDir, "desktop-profile"),
    }), { stdio: "ignore", windowsHide: false });
    if (sessionCode) line("已使用一次性会话码打开窗口（URL 不含令牌）。");
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