import { existsSync } from "node:fs";
import path from "node:path";

/**
 * 固定、非当前用户可随意改写的可执行目录集合。
 * 子进程（git/tar）只在这组目录里解析，避免 PATH 被工作区或临时目录劫持。
 */
function windowsDirs(env) {
  const root = env.SystemRoot || env.SYSTEMROOT || "C:\\Windows";
  const programFiles = [env.ProgramFiles, env["ProgramFiles(x86)"]]
    .filter((value) => typeof value === "string" && path.win32.isAbsolute(value));
  return [
    ...programFiles.map((base) => path.win32.join(base, "Git", "cmd")),
    ...programFiles.map((base) => path.win32.join(base, "Git", "bin")),
    path.win32.join(root, "System32"),
    path.win32.join(root, "System32", "WindowsPowerShell", "v1.0"),
    root,
  ];
}

function posixDirs() {
  return ["/usr/local/bin", "/usr/bin", "/bin", "/usr/local/sbin", "/usr/sbin", "/sbin"];
}

/** 去重后的绝对目录列表；不含 cwd、临时目录或继承来的 PATH 片段。 */
export function trustedPath(env = process.env) {
  const dirs = [path.dirname(process.execPath), ...(process.platform === "win32" ? windowsDirs(env) : posixDirs())];
  const seen = new Set();
  const output = [];
  for (const dir of dirs) {
    if (typeof dir !== "string" || !path.isAbsolute(dir)) continue;
    const key = process.platform === "win32" ? dir.toLowerCase() : dir;
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(dir);
  }
  return output;
}

/** 在继承环境的基础上把 PATH 换成固定目录；其余变量保持不变。 */
export function trustedEnv(extra = {}, env = process.env) {
  const result = { ...env, ...extra };
  for (const key of Object.keys(result)) {
    if (key.toLowerCase() === "path") delete result[key];
  }
  result.PATH = trustedPath(env).join(path.delimiter);
  return result;
}

/** 只在受信任目录里找可执行文件；找不到时返回原名，让固定 PATH 继续解析。 */
export function resolveExecutable(name, { env = process.env, exists = existsSync } = {}) {
  if (typeof name !== "string" || !name) return name;
  const hasExtension = /\.[A-Za-z0-9]+$/.test(name);
  const extensions = process.platform === "win32"
    ? (env.PATHEXT || ".EXE;.CMD;.BAT;.COM").split(";").filter(Boolean)
    : [""];
  for (const dir of trustedPath(env)) {
    const candidates = hasExtension ? [name] : [name, ...extensions.map((extension) => name + extension.toLowerCase())];
    for (const candidate of candidates) {
      const absolute = path.join(dir, candidate);
      if (exists(absolute)) return absolute;
    }
  }
  return name;
}