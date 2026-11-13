import path from "node:path";
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { open, lstat, readdir, mkdir, writeFile, link, rename, unlink, rmdir } from "node:fs/promises";
import { WorkspacePaths, WorkspaceError, WORKSPACE_LIMITS as L, relativePath, inspectAbsolute, workspaceIO } from "./workspace-paths.mjs";
import { parseZip, createZip } from "./workspace-zip.mjs";
export { WorkspaceError, WORKSPACE_LIMITS } from "./workspace-paths.mjs";

function objectArgs(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new WorkspaceError("INVALID_ARGUMENTS", "操作参数必须是对象。");
  return value;
}
function integer(value, min, max, label) {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new WorkspaceError("INVALID_ARGUMENTS", `${label}超出允许范围。`);
  return value;
}
async function regularFile(absolute) {
  const info = await lstat(absolute);
  if (info.isSymbolicLink()) throw new WorkspaceError("SYMLINK_REJECTED", "不允许符号链接或目录联接。");
  if (!info.isFile()) throw new WorkspaceError("NOT_FILE", "此操作需要普通文件。");
  return info;
}
async function boundedRead(absolute, maxBytes, verify) {
  const handle = await open(absolute, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new WorkspaceError("NOT_FILE", "此操作需要普通文件。");
    if (info.size > maxBytes) throw new WorkspaceError("FILE_TOO_LARGE", "文件超过本次读取大小限额。");
    const chunks = [];
    let length = 0;
    for (;;) {
      const buffer = Buffer.alloc(Math.min(65536, maxBytes + 1 - length));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (!bytesRead) break;
      length += bytesRead;
      if (length > maxBytes) throw new WorkspaceError("FILE_TOO_LARGE", "文件超过本次读取大小限额。");
      chunks.push(buffer.subarray(0, bytesRead));
    }
    await verify();
    const current = await regularFile(absolute);
    if (current.dev !== info.dev || current.ino !== info.ino) throw new WorkspaceError("FILE_CHANGED", "读取期间文件发生替换，请重新读取。");
    return Buffer.concat(chunks, length);
  } finally { await handle.close(); }
}
/** 每会话文件能力边界；不提供进程或操作系统沙盒。 */
export class WorkspaceFiles extends WorkspacePaths {
  async list(sessionId, args = {}) {
    return workspaceIO(async () => {
      const { path: requested = "." } = objectArgs(args);
      const relative = relativePath(requested);
      const absolute = await this.resolve(sessionId, relative);
      if (!(await lstat(absolute)).isDirectory()) throw new WorkspaceError("NOT_DIRECTORY", "列目录操作需要目录路径。");
      const names = await readdir(absolute);
      if (names.length > L.maxEntries) throw new WorkspaceError("FILE_LIMIT", "目录条目数量超过安全限额。");
      const entries = [];
      for (const name of names.sort()) {
        const child = relativePath(relative === "." ? name : `${relative}/${name}`);
        const target = await this.resolve(sessionId, child);
        const info = await lstat(target);
        if (!info.isFile() && !info.isDirectory()) throw new WorkspaceError("NOT_FILE", "目录包含非普通文件条目。");
        entries.push({ name, path: child, type: info.isDirectory() ? "directory" : "file", bytes: info.isFile() ? info.size : 0 });
      }
      return { path: relative, entries };
    });
  }
  async readBytes(sessionId, requested, options = {}) {
    return workspaceIO(async () => {
      const { maxBytes = L.maxFileBytes } = objectArgs(options);
      integer(maxBytes, 1, L.maxArchiveBytes, "读取大小");
      const absolute = await this.resolve(sessionId, requested);
      await regularFile(absolute);
      return boundedRead(absolute, maxBytes, () => this.resolve(sessionId, requested));
    });
  }
  async read(sessionId, args = {}) {
    return workspaceIO(async () => {
      const { path: requested, offset = 0, maxChars = 20000, encoding = "utf-8" } = objectArgs(args);
      integer(offset, 0, Number.MAX_SAFE_INTEGER, "文字偏移"); integer(maxChars, 1, L.maxTextChars, "文字分页长度");
      if (!["utf-8", "utf8"].includes(encoding)) throw new WorkspaceError("INVALID_ENCODING", "目前只支持UTF-8文字读取。");
      const relative = relativePath(requested, { allowRoot: false });
      if (/\.(zip|pdf|docx?|xlsx?|pptx?|png|jpe?g|gif|webp|exe|dll)$/i.test(relative))
        throw new WorkspaceError("BINARY_FILE", "该文件是二进制格式，不能当作普通文字读取。");
      const bytes = await this.readBytes(sessionId, relative);
      let text;
      try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
      catch { throw new WorkspaceError("BINARY_FILE", "文件不是有效UTF-8文字，请使用二进制文件能力处理。"); }
      if (/[\x00-\x08\x0b\x0e-\x1f]/.test(text)) throw new WorkspaceError("BINARY_FILE", "文件含二进制控制数据，不能当作普通文字读取。");
      const start = Math.min(offset, text.length), end = Math.min(start + maxChars, text.length);
      return { path: relative, text: text.slice(start, end), encoding: "utf-8", offset: start, nextOffset: end < text.length ? end : null, totalChars: text.length };
    });
  }
  async #write(sessionId, args = {}, maxBytes = L.maxFileBytes) {
    return workspaceIO(async () => {
      const { path: requested, bytes, overwrite = false } = objectArgs(args);
      if (!(bytes instanceof Uint8Array) || typeof overwrite !== "boolean") throw new WorkspaceError("INVALID_ARGUMENTS", "写入内容必须是字节数据，覆盖选项必须是布尔值。");
      if (bytes.byteLength > maxBytes) throw new WorkspaceError("FILE_TOO_LARGE", "写入文件超过大小限额。");
      const data = Buffer.from(bytes);
      const relative = relativePath(requested, { allowRoot: false });
      const absolute = await this.resolve(sessionId, relative, { mustExist: false });
      const checkTarget = async () => {
        await this.resolve(sessionId, relative, { mustExist: false });
        const existing = await lstat(absolute).catch((e) => { if (e.code !== "ENOENT") throw e; return null; });
        if (existing && (!overwrite || !existing.isFile())) throw new WorkspaceError("FILE_EXISTS", "目标已存在，未覆盖原文件。");
      };
      await checkTarget();
      await inspectAbsolute(path.dirname(absolute), { createDirectories: true });
      const tempRelative = `.workspace-write-${randomUUID()}`;
      const temporary = await this.resolve(sessionId, tempRelative, { mustExist: false });
      await mkdir(temporary, { mode: 0o700 });
      const staged = path.join(temporary, "data");
      try {
        await this.resolve(sessionId, tempRelative);
        await writeFile(staged, data, { flag: "wx", mode: 0o600 });
        await this.resolve(sessionId, `${tempRelative}/data`);
        await checkTarget();
        if (overwrite) await rename(staged, absolute);
        else await link(staged, absolute);
      } finally {
        // 只清理本操作创建并重新验证过的临时文件/空目录，不递归删除用户路径。
        await this.resolve(sessionId, tempRelative);
        const exists = await lstat(staged).catch((e) => { if (e.code !== "ENOENT") throw e; return null; });
        if (exists) { await this.resolve(sessionId, `${tempRelative}/data`); await unlink(staged); }
        await rmdir(temporary);
      }
      return { path: relative, bytes: data.length };
    });
  }
  async writeBytes(sessionId, args) { return this.#write(sessionId, args); }
  async write(sessionId, args = {}) {
    return workspaceIO(async () => {
      const { path: requested, text, overwrite = false } = objectArgs(args);
      if (typeof text !== "string") throw new WorkspaceError("INVALID_ARGUMENTS", "写入文字必须是字符串。");
      if (Buffer.byteLength(text) > L.maxFileBytes) throw new WorkspaceError("FILE_TOO_LARGE", "写入文件超过大小限额。");
      return this.writeBytes(sessionId, { path: requested, bytes: Buffer.from(text), overwrite });
    });
  }
  async importFile(sessionId, args = {}, context = {}) {
    return workspaceIO(async () => {
      const { sourcePath, path: requested, overwrite = false } = objectArgs(args);
      const { approvedSourcePath } = objectArgs(context);
      if (typeof sourcePath !== "string" || !path.isAbsolute(sourcePath) || typeof approvedSourcePath !== "string" || !path.isAbsolute(approvedSourcePath) || path.resolve(sourcePath) !== path.resolve(approvedSourcePath))
        throw new WorkspaceError("IMPORT_NOT_APPROVED", "导入来源必须由调用上下文明确授权，且与来源绝对路径完全匹配。");
      await this.root(sessionId);
      const source = path.resolve(sourcePath);
      await inspectAbsolute(source);
      await regularFile(source);
      const bytes = await boundedRead(source, L.maxFileBytes, () => inspectAbsolute(source));
      return this.writeBytes(sessionId, { path: requested ?? path.basename(source), bytes, overwrite });
    });
  }
  async zip(sessionId, args = {}) {
    return workspaceIO(async () => {
      const { action, path: requested, destination, files } = objectArgs(args);
      const relative = relativePath(requested, { allowRoot: false });
      if (action === "create") {
        if (!Array.isArray(files) || !files.length || files.length > L.maxEntries) throw new WorkspaceError("INVALID_ARGUMENTS", "ZIP打包需要指定非空工作区文件列表。");
        const output = await this.resolve(sessionId, relative, { mustExist: false });
        if (await lstat(output).then(() => true, (e) => { if (e.code !== "ENOENT") throw e; return false; })) throw new WorkspaceError("FILE_EXISTS", "目标ZIP已存在，未覆盖原文件。");
        const entries = [];
        let total = 0;
        const visit = async (name) => {
          const normalized = relativePath(name);
          const absolute = await this.resolve(sessionId, normalized);
          const info = await lstat(absolute);
          if (normalized !== ".") {
            if (entries.length >= L.maxEntries || (total += info.isFile() ? info.size : 0) > L.maxTotalBytes) throw new WorkspaceError("ZIP_LIMIT", "ZIP打包条目或大小超过安全限额。");
            entries.push(info.isDirectory() ? { path: normalized, directory: true } : { path: normalized, data: await this.readBytes(sessionId, normalized) });
          }
          if (info.isDirectory()) for (const child of (await this.list(sessionId, { path: normalized })).entries) await visit(child.path);
        };
        for (const name of files) await visit(name);
        const result = await this.#write(sessionId, { path: relative, bytes: createZip(entries) }, L.maxArchiveBytes);
        return { ...result, entries: entries.length };
      }
      if (!["list", "extract"].includes(action)) throw new WorkspaceError("INVALID_ARGUMENTS", "ZIP操作只能为list、extract或create。");
      const archive = parseZip(await this.readBytes(sessionId, relative, { maxBytes: L.maxArchiveBytes }));
      if (action === "list") return { path: relative, entries: archive.entries.map(({ data, ...entry }) => entry), totalBytes: archive.totalBytes };
      const target = relativePath(destination ?? `${relative}.extracted`);
      // 先预检全部目标，再创建任何目标目录或文件；坏归档与既有文件冲突不产生半份解压。
      for (const entry of archive.entries) {
        const absolute = await this.resolve(sessionId, `${target}/${entry.path}`, { mustExist: false });
        const existing = await lstat(absolute).catch((e) => { if (e.code !== "ENOENT") throw e; return null; });
        if (existing && (!entry.directory || !existing.isDirectory())) throw new WorkspaceError("FILE_EXISTS", "解压目标已存在，未覆盖原文件。");
      }
      await inspectAbsolute(await this.resolve(sessionId, target, { mustExist: false }), { createDirectories: true });
      const written = [];
      for (const entry of archive.entries) {
        const name = relativePath(`${target}/${entry.path}`);
        if (entry.directory) await inspectAbsolute(await this.resolve(sessionId, name, { mustExist: false }), { createDirectories: true });
        else written.push(await this.writeBytes(sessionId, { path: name, bytes: entry.data }));
      }
      return { path: relative, destination: target, files: written, bytes: archive.totalBytes };
    });
  }
}
