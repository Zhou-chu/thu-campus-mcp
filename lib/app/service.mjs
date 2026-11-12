import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
const run = promisify(execFile);
export const DEFAULT_TASK = "thu-campus-app";
/**
 * 常驻方式：**当前用户的登录计划任务**，不是 Windows 服务。
 *
 * 原因很实际：校园会话与模型令牌都由 DPAPI 按「当前 Windows 用户」加密，
 * 以 SYSTEM 身份跑的服务解不开这些密文，会变成一个永远登录不上的空壳。
 * 登录任务还有个好处：不需要管理员权限，也不需要额外的服务包装器。
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
  lines.push(
    `"${nodePath}" "${entryPath}" app serve --port ${port} >> "${logFile}" 2>&1`,
  );
  lines.push("endlocal");
  return lines.join("\r\n") + "\r\n";
}
export function createTaskArgs({ name = DEFAULT_TASK, wrapperPath }) {
  return [
    "/create",
    "/tn",
    name,
    "/tr",
    `cmd.exe /c "${wrapperPath}"`,
    "/sc",
    "onlogon",
    "/rl",
    "limited",
    "/f",
  ];
}
export function queryTaskArgs(name = DEFAULT_TASK) {
  return ["/query", "/tn", name, "/fo", "CSV", "/nh"];
}
export function deleteTaskArgs(name = DEFAULT_TASK) {
  return ["/delete", "/tn", name, "/f"];
}
export function runTaskArgs(name = DEFAULT_TASK) {
  return ["/run", "/tn", name];
}
/** schtasks 的 CSV 是「位置固定、文字本地化」，所以按位置解析而不是按英文键名。 */
export function parseTaskCsv(output) {
  const line = String(output || "")
    .split(/\r?\n/)
    .map((item) => item.trim())
    .find((item) => item.length > 0);
  if (!line) return null;
  const fields = [];
  let current = "";
  let quoted = false;
  for (const char of line) {
    if (char === '"') {
      quoted = !quoted;
      continue;
    }
    if (char === "," && !quoted) {
      fields.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  fields.push(current);
  if (fields.length < 3) return null;
  const [taskName, nextRun, status] = fields;
  return { taskName, nextRun, status };
}
/* ------------------------------------------------------------------ *
 * 启动项模式：写进当前用户的「启动」文件夹。
 * 不需要管理员权限，登录即以该用户身份运行；相比计划任务更简单，
 * 也仍然满足 DPAPI 必须按当前用户解密的约束。
 * ------------------------------------------------------------------ */
export function startupDir(env = process.env) {
  const appData =
    env.APPDATA || path.join(env.USERPROFILE || "", "AppData", "Roaming");
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
export function explainTaskFailure(error) {
  const text = String(error?.message || "");
  if (/Access is denied|拒绝访问/i.test(text))
    return Object.assign(
      new Error(
        "创建计划任务被系统拒绝（需要管理员权限）。可以改用无需管理员的启动项模式：去掉 --task 重新执行 app service install。",
      ),
      { code: "SERVICE_ACCESS_DENIED" },
    );
  return error;
}
export function assertWindows() {
  if (process.platform !== "win32")
    throw Object.assign(
      new Error("计划任务常驻目前只支持 Windows；其他平台请用 systemd。"),
      { code: "UNSUPPORTED_PLATFORM" },
    );
}
export async function installService({
  name = DEFAULT_TASK,
  wrapperPath,
  content,
  exec = run,
}) {
  assertWindows();
  mkdirSync(path.dirname(wrapperPath), { recursive: true });
  writeFileSync(wrapperPath, content, { mode: 0o700 });
  await exec("schtasks.exe", createTaskArgs({ name, wrapperPath }));
  return { name, wrapperPath };
}
export async function uninstallService({ name = DEFAULT_TASK, wrapperPath, exec = run }) {
  assertWindows();
  let removed = true;
  try {
    await exec("schtasks.exe", deleteTaskArgs(name));
  } catch (e) {
    // 任务不存在时 schtasks 返回非零，这里按"已经没有了"处理。
    removed = false;
  }
  if (wrapperPath) {
    try {
      rmSync(wrapperPath);
    } catch {}
  }
  return { name, removed };
}
export async function serviceStatus({ name = DEFAULT_TASK, exec = run }) {
  assertWindows();
  try {
    const { stdout } = await exec("schtasks.exe", queryTaskArgs(name));
    const parsed = parseTaskCsv(stdout);
    return { name, installed: true, ...(parsed || {}) };
  } catch {
    return { name, installed: false };
  }
}
export async function startService({ name = DEFAULT_TASK, exec = run }) {
  assertWindows();
  await exec("schtasks.exe", runTaskArgs(name));
  return { name, started: true };
}

