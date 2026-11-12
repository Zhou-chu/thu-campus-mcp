import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { userInfo } from "node:os";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
const run = promisify(execFile);
export const DEFAULT_TASK = "thu-campus-app";
/**
 * 常驻方式：**当前用户的登录计划任务**，或退而求其次的「启动」文件夹。
 *
 * 为什么不用 Windows 系统服务：校园会话与模型令牌都由 DPAPI 按当前用户加密，
 * 以 SYSTEM 身份跑的服务解不开这些密文，会变成永远登录不上的空壳。
 *
 * 为什么不用 schtasks.exe：普通权限下 `schtasks /sc onlogon` 会直接
 * `ERROR: Access is denied.`；而 Task Scheduler COM（Register-ScheduledTask）
 * 在无管理员权限时可以为当前用户注册登录任务——已在本机实测通过。
 */
export function wrapperContent({
  nodePath,
  entryPath,
  port,
  host = "",
  stateDir,
  logFile,
  extraEnv = {},
}) {
  const lines = ["@echo off", "setlocal"];
  // 状态目录可能还不存在（首次安装）；缺了会让日志重定向直接失败。
  lines.push(`if not exist "${stateDir}" mkdir "${stateDir}" >nul 2>&1`);
  lines.push(`set "THU_CAMPUS_APP_STATE_DIR=${stateDir}"`);
  lines.push(`set "THU_CAMPUS_APP_PORT=${port}"`);
  if (host) lines.push(`set "THU_CAMPUS_APP_HOST=${host}"`);
  for (const [key, value] of Object.entries(extraEnv))
    if (value !== undefined && value !== null && value !== "")
      lines.push(`set "${key}=${value}"`);
  lines.push(`echo [%DATE% %TIME%] start >> "${logFile}"`);
  lines.push(`"${nodePath}" "${entryPath}" app serve --port ${port} >> "${logFile}" 2>&1`);
  lines.push("endlocal");
  return lines.join("\r\n") + "\r\n";
}
/** 转义 PowerShell 单引号字符串。 */
function psString(value) {
  return "'" + String(value).replace(/'/g, "''") + "'";
}
export function currentUser(env = process.env) {
  const domain = env.USERDOMAIN || ".";
  const name = env.USERNAME || userInfo().username;
  return `${domain}\\${name}`;
}
export function taskScripts({ name = DEFAULT_TASK, wrapperPath, user }) {
  const who = psString(user || currentUser());
  const task = psString(name);

  return {
    install: [
      "$ErrorActionPreference = 'Stop'",
      `$action = New-ScheduledTaskAction -Execute 'cmd.exe' -Argument '/c "${wrapperPath}"'`,
      `$trigger = New-ScheduledTaskTrigger -AtLogOn -User ${who}`,
      `$principal = New-ScheduledTaskPrincipal -UserId ${who} -LogonType Interactive -RunLevel Limited`,
      `Register-ScheduledTask -TaskName ${task} -Action $action -Trigger $trigger -Principal $principal -Force | Out-Null`,
      `Write-Output '{"installed":true}'`,
    ].join("\n"),
    status: [
      "$ErrorActionPreference = 'SilentlyContinue'",
      `$t = Get-ScheduledTask -TaskName ${task}`,
      "if (-not $t) { Write-Output '{\"installed\":false}'; exit 0 }",
      `$i = Get-ScheduledTaskInfo -TaskName ${task}`,
      "$o = @{ installed = $true; state = $t.State.ToString(); lastRun = $(if ($i.LastRunTime) { $i.LastRunTime.ToString('o') } else { $null }); nextRun = $(if ($i.NextRunTime) { $i.NextRunTime.ToString('o') } else { $null }); lastResult = $i.LastTaskResult }",
      "Write-Output ($o | ConvertTo-Json -Compress)",
    ].join("\n"),
    uninstall: [
      "$ErrorActionPreference = 'SilentlyContinue'",
      `$t = Get-ScheduledTask -TaskName ${task}`,
      "if (-not $t) { Write-Output '{\"removed\":false}'; exit 0 }",
      `Unregister-ScheduledTask -TaskName ${task} -Confirm:$false`,
      "Write-Output '{\"removed\":true}'",
    ].join("\n"),
    start: [
      "$ErrorActionPreference = 'Stop'",
      `Start-ScheduledTask -TaskName ${task}`,
      `Write-Output '{"started":true}'`,
    ].join("\n"),
  };
}
export function encodePowerShell(script) {
  return Buffer.from(String(script), "utf16le").toString("base64");
}
export function powershellArgs(script) {
  return ["-NoProfile", "-NonInteractive", "-EncodedCommand", encodePowerShell(script)];
}
export function parseTaskJson(stdout) {
  const text = String(stdout || "").trim();
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end < start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}
export function explainFailure(error) {
  const text = String(error?.message || "");
  if (/Access is denied|拒绝访问/i.test(text))
    return Object.assign(
      new Error("注册计划任务被系统拒绝。可改用启动项模式：app service install --startup。"),
      { code: "SERVICE_ACCESS_DENIED" },
    );
  return error;
}
export function assertWindows() {
  if (process.platform !== "win32")
    throw Object.assign(new Error("常驻安装目前只支持 Windows；其他平台请用 systemd。"), {
      code: "UNSUPPORTED_PLATFORM",
    });
}
async function ps(script, exec) {
  const { stdout } = await exec("powershell.exe", powershellArgs(script));
  return stdout;
}
export async function installTask({ name = DEFAULT_TASK, wrapperPath, content, user, exec = run }) {
  assertWindows();
  mkdirSync(path.dirname(wrapperPath), { recursive: true });
  writeFileSync(wrapperPath, content, { mode: 0o700 });
  const stdout = await ps(taskScripts({ name, wrapperPath, user }).install, exec);
  return { name, wrapperPath, result: parseTaskJson(stdout) };
}
export async function uninstallTask({ name = DEFAULT_TASK, wrapperPath, exec = run }) {
  assertWindows();
  const stdout = await ps(taskScripts({ name, wrapperPath }).uninstall, exec);
  if (wrapperPath) {
    try {
      rmSync(wrapperPath);
    } catch {}
  }
  return { name, removed: !!parseTaskJson(stdout)?.removed };
}
export async function taskStatus({ name = DEFAULT_TASK, exec = run }) {
  assertWindows();
  try {
    const parsed = parseTaskJson(await ps(taskScripts({ name }).status, exec));
    return { name, installed: !!parsed?.installed, ...(parsed || {}) };
  } catch (e) {
    return { name, installed: false, error: e?.code || "TASK_QUERY_FAILED" };
  }
}
export async function startTask({ name = DEFAULT_TASK, exec = run }) {
  assertWindows();
  const parsed = parseTaskJson(await ps(taskScripts({ name }).start, exec));
  return { name, started: !!parsed?.started };
}
/* ---------------- 启动文件夹（备选，零权限依赖） ---------------- */
export function startupDir(env = process.env) {
  const appData = env.APPDATA || path.join(env.USERPROFILE || "", "AppData", "Roaming");
  return path.join(appData, "Microsoft", "Windows", "Start Menu", "Programs", "Startup");
}
export function startupEntryPath(env = process.env) {
  return path.join(startupDir(env), "thu-campus-app.cmd");
}
export function installStartup({ entryPath, content }) {
  assertWindows();
  mkdirSync(path.dirname(entryPath), { recursive: true });
  writeFileSync(entryPath, content, { mode: 0o700 });
  return { entryPath };
}
export function uninstallStartup({ entryPath }) {
  assertWindows();
  if (!existsSync(entryPath)) return { entryPath, removed: false };
  rmSync(entryPath, { force: true });
  return { entryPath, removed: true };
}
export function startupStatus({ entryPath }) {
  return { entryPath, installed: existsSync(entryPath) };
}

