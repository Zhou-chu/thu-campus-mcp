import path from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import {
  mkdir,
  readFile,
  writeFile,
  rename,
  rm,
  lstat,
  realpath,
} from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
export class BrowserError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}
export async function authGuard(store, expected = {}) {
  const epoch = expected.epoch ?? (await store.generation());
  const version =
    expected.version !== undefined
      ? expected.version
      : ((await store.version()) ?? null);
  if (
    (await store.generation()) !== epoch ||
    ((await store.version()) ?? null) !== version
  )
    throw new BrowserError("AUTH_CHANGED", "认证已注销或变化，未恢复旧会话。");
  return { epoch, version };
}
function findRoot() {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (;;) {
    const manifest = path.join(dir, "package.json");
    if (existsSync(manifest)) {
      try {
        if (
          JSON.parse(readFileSync(manifest, "utf8")).name === "thu-campus-mcp"
        )
          return dir;
      } catch {}
    }
    const parent = path.dirname(dir);
    if (parent === dir)
      throw new BrowserError("BROWSER_BUNDLE_ROOT", "找不到统一 MCP 根目录。");
    dir = parent;
  }
}
export const bundleRoot = findRoot();
export function browserConfig(options = {}) {
  return {
    stateDir: path.resolve(
      options.stateDir ||
        process.env.THU_BROWSER_STATE_DIR ||
        path.join(homedir(), ".thu-campus-mcp/browser"),
    ),
    runtimeDir: path.resolve(
      options.runtimeDir ||
        process.env.THU_BROWSER_RUNTIME_DIR ||
        path.join(bundleRoot, ".runtime/browsers"),
    ),
  };
}
export async function directory(target) {
  await mkdir(target, { recursive: true });
  if ((await lstat(target)).isSymbolicLink())
    throw new BrowserError(
      "BROWSER_UNSAFE_PATH",
      "浏览器工作目录不能是符号链接。",
    );
  return target;
}
export function inside(base, target) {
  const r = path.relative(base, target);
  return r !== "" && !r.startsWith("..") && !path.isAbsolute(r);
}
export async function readJson(file) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch (e) {
    if (e.code === "ENOENT") return;
    throw e;
  }
}
export async function atomic(file, bytes) {
  await directory(path.dirname(file));
  const temp = file + "." + randomUUID() + ".tmp";
  try {
    await writeFile(temp, bytes, { mode: 0o600 });
    for (let i = 0; ; i++) {
      try {
        await rename(temp, file);
        break;
      } catch (e) {
        if (
          process.platform !== "win32" ||
          !["EPERM", "EACCES", "EBUSY"].includes(e.code) ||
          i >= 19
        )
          throw e;
        await new Promise((r) => setTimeout(r, Math.min(10 * 2 ** i, 200)));
      }
    }
  } finally {
    await rm(temp, { force: true });
  }
}
/** Windows 自带 PowerShell 相对 %SystemRoot% 的固定位置。 */
const WINDOWS_POWERSHELL = path.join(
  "System32",
  "WindowsPowerShell",
  "v1.0",
  "powershell.exe",
);
/**
 * 把"系统自带的可执行文件"解析成固定的绝对路径。
 *
 * 为什么不直接 spawn("powershell.exe")：命令名交给 PATH 解析时，
 * 当前用户可写目录（安装器、用户 bin、临时目录）里同名的 .exe 会被优先执行，
 * 等于让本地任意程序劫持我们启动的进程（Sonar javascript/typescript:S4036）。
 * 这里只接受 %SystemRoot% 下的相对路径，并且解析真实路径后仍必须落在系统目录内，
 * 防止 .. 穿越与符号链接逃逸；不存在就明确报错，不回退到 PATH。
 *
 * @param {string} relative 相对 %SystemRoot% 的路径
 * @param {{ root?: string, platform?: string }} [options] 便于测试注入
 * @returns {Promise<string>} 已验证的绝对路径
 */
export async function systemExecutable(
  relative,
  { root = process.env.SystemRoot, platform = process.platform } = {},
) {
  if (platform !== "win32")
    throw new BrowserError(
      "EXEC_PLATFORM",
      "系统可执行文件解析仅用于 Windows。",
    );
  if (!root || !path.isAbsolute(root))
    throw new BrowserError("EXEC_ROOT", "无法确定 Windows 系统目录。");
  const base = path.resolve(root);
  const target = path.resolve(base, relative);
  if (!inside(base, target))
    throw new BrowserError("EXEC_UNSAFE", "系统可执行文件路径超出系统目录。");
  let realBase, realTarget;
  try {
    realBase = await realpath(base);
    realTarget = await realpath(target);
  } catch {
    throw new BrowserError(
      "EXEC_MISSING",
      `系统可执行文件不存在：${relative}`,
    );
  }
  if (!inside(realBase, realTarget))
    throw new BrowserError("EXEC_UNSAFE", "系统可执行文件真实路径超出系统目录。");
  return realTarget;
}
export function dpapi(bytes, decrypt = false) {
  if (process.platform !== "win32")
    throw new BrowserError(
      "AUTH_PLATFORM",
      "持久登录加密需要 Windows 当前用户。",
    );
  return systemExecutable(WINDOWS_POWERSHELL).then(
    (executable) =>
      new Promise((resolve, reject) => {
        const script = `Add-Type -AssemblyName System.Security; $b=[Convert]::FromBase64String([Console]::In.ReadToEnd()); $v=[System.Security.Cryptography.ProtectedData]::${decrypt ? "Unprotect" : "Protect"}($b,$null,[System.Security.Cryptography.DataProtectionScope]::CurrentUser); [Console]::Out.Write([Convert]::ToBase64String($v))`;
        const child = spawn(
          executable,
          ["-NoProfile", "-NonInteractive", "-Command", script],
          { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] },
        );
        let out = "";
        child.stdout.on("data", (b) => (out += b));
        child.stderr.resume();
        child.once("error", () =>
          reject(
            new BrowserError("BROWSER_STATE_CRYPTO", "无法启动本机加密组件。"),
          ),
        );
        child.once("close", (code) =>
          code === 0
            ? resolve(Buffer.from(out.trim(), "base64"))
            : reject(
                new BrowserError(
                  "BROWSER_STATE_CRYPTO",
                  "无法解密浏览器状态，请使用原 Windows 用户或重新登录。",
                ),
              ),
        );
        child.stdin.on("error", () => {});
        child.stdin.end(Buffer.from(bytes).toString("base64"));
      }),
  );
}
