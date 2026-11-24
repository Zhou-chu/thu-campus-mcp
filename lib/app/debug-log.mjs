/**
 * 可选详细运行日志：默认关闭；开启后按 JSON Lines 写入 stateDir/logs，
 * 统一脱敏并按大小轮转。关闭时 log() 只做一次布尔判断。
 */
import path from "node:path";
import { appendFile, mkdir, readdir, readFile, stat, truncate, unlink, writeFile } from "node:fs/promises";

const MAX_BYTES = 10 * 1024 * 1024;
const KEEP = 5;
const MAX_FIELD = 4096;
const SECRET_KEY = /pass(word|wd)?|secret|cookie|authorization|token|api[-_]?key|paircode|sessionid/i;

const redact = (value, depth = 0) => {
  if (depth > 4) return "[TRUNCATED_DEPTH]";
  if (typeof value === "string") return value.length > MAX_FIELD ? value.slice(0, MAX_FIELD) + `…[${value.length} chars]` : value;
  if (Array.isArray(value)) return value.slice(0, 50).map(item => redact(item, depth + 1));
  if (value && typeof value === "object") {
    const out = {};
    for (const [key, item] of Object.entries(value).slice(0, 80)) out[key] = SECRET_KEY.test(key) ? "[REDACTED]" : redact(item, depth + 1);
    return out;
  }
  return value;
};

export function createDebugLog({ stateDir, env = process.env, now = () => new Date(), maxBytes = MAX_BYTES, keep = KEEP } = {}) {
  const dir = path.join(stateDir || ".", "logs");
  const configFile = path.join(stateDir || ".", "debug-log.json");
  const forced = env.THU_CAMPUS_APP_DEBUG_LOG === "1";
  let enabled = forced;
  let tail = Promise.resolve();
  let loaded = false;

  const load = async () => {
    if (loaded) return;
    loaded = true;
    try {
      const saved = JSON.parse(await readFile(configFile, "utf8"));
      if (!forced && typeof saved?.enabled === "boolean") enabled = saved.enabled;
    } catch { /* 未配置时按环境变量/默认关闭 */ }
  };

  const currentFile = () => path.join(dir, "debug.jsonl");
  const rotate = async () => {
    try {
      const info = await stat(currentFile());
      if (info.size < maxBytes) return;
      for (let index = keep - 1; index >= 1; index -= 1) {
        await unlink(`${currentFile()}.${index}`).catch(() => {});
        await readFile(`${currentFile()}.${index - 1}`).then(data => writeFile(`${currentFile()}.${index}`, data)).catch(() => {});
      }
      await readFile(currentFile()).then(data => writeFile(`${currentFile()}.1`, data)).catch(() => {});
      await truncate(currentFile(), 0);
    } catch { /* 文件不存在或轮转失败不阻塞业务 */ }
  };

  const write = async line => {
    try {
      await mkdir(dir, { recursive: true });
      await rotate();
      await appendFile(currentFile(), line + "\n", "utf8");
    } catch { /* 日志写入失败不得影响主流程 */ }
  };

  return {
    get enabled() { return enabled; },
    async setEnabled(value) {
      enabled = value === true;
      await mkdir(stateDir || ".", { recursive: true }).catch(() => {});
      await writeFile(configFile, JSON.stringify({ enabled }), "utf8").catch(() => {});
      return enabled;
    },
    async load() { await load(); },
    log({ level = "info", module, event, durationMs, data, error } = {}) {
      if (!enabled) return;
      const record = {
        timestamp: now().toISOString(),
        level,
        module: String(module || "app").slice(0, 64),
        event: String(event || "event").slice(0, 120),
        ...(Number.isFinite(durationMs) ? { durationMs } : {}),
        ...(data === undefined ? {} : { data: redact(data) }),
        ...(error === undefined ? {} : { error: redact(error instanceof Error ? { name: error.name, message: error.message, stack: error.stack, code: error.code } : error) }),
      };
      const line = JSON.stringify(record);
      tail = tail.then(() => write(line));
    },
    async status() {
      await load();
      const files = [];
      try {
        for (const name of await readdir(dir)) {
          if (!name.startsWith("debug.jsonl")) continue;
          const info = await stat(path.join(dir, name));
          files.push({ name, size: info.size });
        }
      } catch { /* 还没有日志目录 */ }
      return { enabled, dir, files, totalBytes: files.reduce((sum, file) => sum + file.size, 0) };
    },
    async readRecent(max = 512 * 1024) {
      await load();
      try {
        const info = await stat(currentFile());
        const start = Math.max(0, info.size - max);
        const handle = await readFile(currentFile());
        return handle.subarray(start).toString("utf8");
      } catch { return ""; }
    },
    async clear() {
      for (let index = 0; index < keep; index += 1) {
        const file = index === 0 ? currentFile() : `${currentFile()}.${index}`;
        await truncate(file, 0).catch(() => {});
      }
    },
    /** 测试用：等待排队写入完成。 */
    async flush() { await tail; },
  };
}