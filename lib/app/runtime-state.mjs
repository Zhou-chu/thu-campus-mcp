import path from "node:path";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
/**
 * 运行时实例信息：让 `app invite` / `app status` 知道正在跑的那一个实例到底监听在哪，
 * 而不是只会读环境变量猜测。文件仅当前用户可读，不含令牌或凭据。
 */
const FILE = "runtime.json";
export function runtimeFile(stateDir) {
  return path.join(stateDir, FILE);
}
export function writeRuntime(stateDir, info) {
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(runtimeFile(stateDir), JSON.stringify(info, null, 2), {
    mode: 0o600,
  });
  return info;
}
export function readRuntime(stateDir) {
  try {
    const parsed = JSON.parse(readFileSync(runtimeFile(stateDir), "utf8"));
    if (!parsed || !Number.isInteger(parsed.port) || !parsed.pid) return null;
    return parsed;
  } catch {
    return null;
  }
}
export function clearRuntime(stateDir) {
  try {
    rmSync(runtimeFile(stateDir));
  } catch {}
}