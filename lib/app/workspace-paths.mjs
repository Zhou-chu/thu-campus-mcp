import path from "node:path";
import { lstat, mkdir } from "node:fs/promises";
import { validSessionId } from "./sessions.mjs";

export class WorkspaceError extends Error {
  constructor(code, message) { super(message); this.name = "WorkspaceError"; this.code = code; }
}
export const WORKSPACE_LIMITS = Object.freeze({
  maxFileBytes: 32 * 1024 * 1024,
  maxArchiveBytes: 64 * 1024 * 1024,
  maxTotalBytes: 64 * 1024 * 1024,
  maxEntries: 1000,
  maxCompressionRatio: 100,
  maxTextChars: 200000,
});
export async function workspaceIO(action) {
  try { return await action(); }
  catch (error) {
    if (error instanceof WorkspaceError) throw error;
    const errors = {
      ENOENT: ["FILE_NOT_FOUND", "工作区文件或目录不存在。"],
      EEXIST: ["FILE_EXISTS", "目标已存在，未覆盖原文件。"],
      ENOTDIR: ["NOT_DIRECTORY", "路径中的某一项不是目录。"],
      EISDIR: ["NOT_FILE", "此操作需要普通文件，不能使用目录。"],
      ELOOP: ["SYMLINK_REJECTED", "不允许符号链接或目录联接。"],
      EACCES: ["FILE_ACCESS_DENIED", "没有访问该文件的权限。"],
      EPERM: ["FILE_ACCESS_DENIED", "系统拒绝访问该文件。"],
    };
    throw new WorkspaceError(...(errors[error?.code] || ["WORKSPACE_IO", "工作区文件操作失败。"]));
  }
}
/** 同时采用Windows路径约束，避免在不同宿主上生成可越界的文件名。 */
export function relativePath(value, { allowRoot = true } = {}) {
  if (typeof value !== "string" || !value || value.length > 1024 || path.isAbsolute(value) || path.win32.isAbsolute(value))
    throw new WorkspaceError("INVALID_PATH", "必须提供工作区内的相对路径。");
  const parts = value.replaceAll("\\", "/").split("/");
  const clean = [];
  for (const part of parts) {
    if (part === "..") throw new WorkspaceError("PATH_ESCAPE", "不允许使用上级目录或跨会话路径。");
    if (!part || part === ".") continue;
    if (/[<>:"|?*\x00-\x1f]/.test(part) || /[. ]$/.test(part) || /^(con|prn|aux|nul|conin\$|conout\$|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(part))
      throw new WorkspaceError("INVALID_PATH", "文件名含不安全字符或系统保留名称。");
    clean.push(part);
  }
  if (!clean.length && !allowRoot) throw new WorkspaceError("INVALID_PATH", "此操作需要文件或子目录路径。");
  return clean.join("/") || ".";
}
/** 检查每一级既有路径，拒绝符号链接及Windows junction；这不是进程隔离沙盒。 */
export async function inspectAbsolute(absolute, { mustExist = true, createDirectories = false } = {}) {
  const root = path.parse(absolute).root;
  let current = root;
  const parts = path.relative(root, absolute).split(path.sep).filter(Boolean);
  for (let index = 0; index < parts.length; index++) {
    current = path.join(current, parts[index]);
    let info;
    try { info = await lstat(current); }
    catch (error) {
      if (error.code !== "ENOENT") throw error;
      if (createDirectories) {
        await mkdir(current).catch((e) => { if (e.code !== "EEXIST") throw e; });
        info = await lstat(current);
      } else if (!mustExist) return null;
      else throw error;
    }
    if (info.isSymbolicLink()) throw new WorkspaceError("SYMLINK_REJECTED", "不允许符号链接或目录联接。");
    if ((index < parts.length - 1 || createDirectories) && !info.isDirectory())
      throw new WorkspaceError("NOT_DIRECTORY", "路径中的某一项不是目录。");
    if (index === parts.length - 1) return info;
  }
  return lstat(root);
}
export class WorkspacePaths {
  constructor(options = {}) {
    const { baseDir } = options || {};
    if (typeof baseDir !== "string" || !baseDir) throw new WorkspaceError("INVALID_ARGUMENTS", "必须配置工作区根目录。");
    this.baseDir = path.resolve(baseDir);
  }
  async root(sessionId) {
    return workspaceIO(async () => {
      if (!validSessionId(sessionId)) throw new WorkspaceError("INVALID_SESSION", "会话ID不合法。");
      const root = path.join(this.baseDir, sessionId);
      await inspectAbsolute(root, { createDirectories: true });
      return root;
    });
  }
  async resolve(sessionId, relative, { mustExist = true } = {}) {
    return workspaceIO(async () => {
      const safe = relativePath(relative);
      const root = await this.root(sessionId);
      const absolute = path.resolve(root, safe);
      const difference = path.relative(root, absolute);
      if (difference === ".." || difference.startsWith(`..${path.sep}`) || path.isAbsolute(difference)) throw new WorkspaceError("PATH_ESCAPE", "路径超出当前会话工作区。");
      await inspectAbsolute(absolute, { mustExist });
      return absolute;
    });
  }
}
