import { inflateRawSync } from "node:zlib";
import { WorkspaceError, WORKSPACE_LIMITS as L, relativePath } from "./workspace-paths.mjs";

const crcTable = Uint32Array.from({ length: 256 }, (_, value) => {
  let crc = value;
  for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  return crc >>> 0;
});
export function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = crcTable[(crc ^ byte) & 255] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
function invalid(message = "ZIP目录、条目或校验数据损坏。") { throw new WorkspaceError("ZIP_INVALID", message); }
function unsupported(message = "此ZIP使用了不支持的格式。") { throw new WorkspaceError("ZIP_UNSUPPORTED", message); }
function bounded(bytes, offset, size, end = bytes.length) {
  if (offset < 0 || size < 0 || offset + size > end) invalid();
}
function extras(bytes, offset, length) {
  const end = offset + length;
  bounded(bytes, offset, length);
  while (offset < end) {
    bounded(bytes, offset, 4, end);
    const id = bytes.readUInt16LE(offset), size = bytes.readUInt16LE(offset + 2);
    if (id === 1) unsupported("不支持ZIP64归档。");
    offset += 4;
    bounded(bytes, offset, size, end);
    offset += size;
  }
}
function nameText(bytes, flags) {
  if (!(flags & 0x800) && bytes.some((byte) => byte > 127)) unsupported("ZIP非ASCII文件名必须使用UTF-8标记。");
  try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { invalid("ZIP文件名不是有效UTF-8文本。"); }
}
function checkEntries(entries) {
  if (entries.length > L.maxEntries) throw new WorkspaceError("ZIP_LIMIT", "ZIP条目数量超过安全限额。");
  const paths = new Map();
  let total = 0;
  for (const entry of entries) {
    const key = entry.path.toLowerCase();
    if (paths.has(key)) invalid("ZIP包含重名或大小写冲突的条目。");
    paths.set(key, entry);
    if (entry.bytes > L.maxFileBytes || (total += entry.bytes) > L.maxTotalBytes)
      throw new WorkspaceError("ZIP_LIMIT", "ZIP解压大小超过安全限额。");
  }
  for (const key of paths.keys()) {
    const parts = key.split("/");
    parts.pop();
    while (parts.length) {
      const parent = paths.get(parts.join("/"));
      if (parent && !parent.directory) invalid("ZIP文件与目录路径冲突。");
      parts.pop();
    }
  }
  return total;
}
/** 完整验证中央目录、本地头、资源界限和CRC后才向调用方返回数据。 */
export function parseZip(input) {
  const bytes = Buffer.isBuffer(input) ? input : Buffer.from(input);
  if (bytes.length > L.maxArchiveBytes) throw new WorkspaceError("ZIP_LIMIT", "ZIP文件超过读取大小限额。");
  let end = -1;
  for (let offset = bytes.length - 22; offset >= Math.max(0, bytes.length - 65557); offset--) {
    if (bytes.readUInt32LE(offset) === 0x06054b50 && offset + 22 + bytes.readUInt16LE(offset + 20) === bytes.length) { end = offset; break; }
  }
  if (end < 0) invalid("找不到完整ZIP结束目录。");
  const count = bytes.readUInt16LE(end + 10), directorySize = bytes.readUInt32LE(end + 12), directoryOffset = bytes.readUInt32LE(end + 16);
  if (count === 0xffff || directorySize === 0xffffffff || directoryOffset === 0xffffffff) unsupported("不支持ZIP64归档。");
  if (bytes.readUInt16LE(end + 4) || bytes.readUInt16LE(end + 6) || bytes.readUInt16LE(end + 8) !== count) unsupported("不支持分卷ZIP归档。");
  if (count > L.maxEntries) throw new WorkspaceError("ZIP_LIMIT", "ZIP条目数量超过安全限额。");
  if (directoryOffset + directorySize !== end) invalid();
  const entries = [];
  const intervals = [];
  let cursor = directoryOffset;
  let declaredTotal = 0;
  for (let index = 0; index < count; index++) {
    bounded(bytes, cursor, 46, end);
    if (bytes.readUInt32LE(cursor) !== 0x02014b50) invalid();
    const flags = bytes.readUInt16LE(cursor + 8), method = bytes.readUInt16LE(cursor + 10);
    const crc = bytes.readUInt32LE(cursor + 16), compressedBytes = bytes.readUInt32LE(cursor + 20), size = bytes.readUInt32LE(cursor + 24);
    const nameLength = bytes.readUInt16LE(cursor + 28), extraLength = bytes.readUInt16LE(cursor + 30), commentLength = bytes.readUInt16LE(cursor + 32);
    const external = bytes.readUInt32LE(cursor + 38), local = bytes.readUInt32LE(cursor + 42);
    if (flags & ~0x80e || ![0, 8].includes(method) || bytes.readUInt16LE(cursor + 34)) unsupported("不支持加密、分卷或该压缩方法的ZIP。");
    if (bytes.readUInt16LE(cursor + 6) >= 45 || [compressedBytes, size, local].includes(0xffffffff)) unsupported("不支持ZIP64归档。");
    const mode = (external >>> 16) & 0xf000;
    if (mode && mode !== 0x8000 && mode !== 0x4000) throw new WorkspaceError("ZIP_LINK_REJECTED", "ZIP包含链接或非普通文件条目。");
    bounded(bytes, cursor + 46, nameLength + extraLength + commentLength, end);
    const nameBytes = bytes.subarray(cursor + 46, cursor + 46 + nameLength);
    const name = nameText(nameBytes, flags);
    const directory = /[\\/]$/.test(name) || mode === 0x4000 || !!(external & 0x10);
    const safePath = relativePath(name, { allowRoot: false });
    extras(bytes, cursor + 46 + nameLength, extraLength);
    if (size > L.maxFileBytes || (compressedBytes ? size / compressedBytes > L.maxCompressionRatio : size !== 0))
      throw new WorkspaceError("ZIP_LIMIT", "ZIP单文件大小或解压率超过安全限额。");
    if (directory && size !== 0) invalid("ZIP目录条目不能含文件内容。");
    if ((declaredTotal += size) > L.maxTotalBytes) throw new WorkspaceError("ZIP_LIMIT", "ZIP累计解压大小超过安全限额。");
    bounded(bytes, local, 30, directoryOffset);
    if (bytes.readUInt32LE(local) !== 0x04034b50 || bytes.readUInt16LE(local + 6) !== flags || bytes.readUInt16LE(local + 8) !== method) invalid();
    if (bytes.readUInt16LE(local + 4) >= 45) unsupported("不支持ZIP64归档。");
    const localNameLength = bytes.readUInt16LE(local + 26), localExtraLength = bytes.readUInt16LE(local + 28);
    bounded(bytes, local + 30, localNameLength + localExtraLength, directoryOffset);
    if (!bytes.subarray(local + 30, local + 30 + localNameLength).equals(nameBytes)) invalid("ZIP本地头与目录名称不一致。");
    extras(bytes, local + 30 + localNameLength, localExtraLength);
    const start = local + 30 + localNameLength + localExtraLength;
    bounded(bytes, start, compressedBytes, directoryOffset);
    let last = start + compressedBytes;
    if (flags & 8) {
      bounded(bytes, last, 12, directoryOffset);
      if (bytes.readUInt32LE(last) === 0x08074b50) { last += 4; bounded(bytes, last, 12, directoryOffset); }
      if (bytes.readUInt32LE(last) !== crc || bytes.readUInt32LE(last + 4) !== compressedBytes || bytes.readUInt32LE(last + 8) !== size) invalid();
      last += 12;
    } else if (bytes.readUInt32LE(local + 14) !== crc || bytes.readUInt32LE(local + 18) !== compressedBytes || bytes.readUInt32LE(local + 22) !== size) invalid();
    intervals.push([local, last]);
    let data;
    try {
      data = method === 0 ? bytes.subarray(start, start + compressedBytes) : inflateRawSync(bytes.subarray(start, start + compressedBytes), { maxOutputLength: Math.max(1, size + 1) });
    } catch { invalid("ZIP压缩内容损坏或超出声明大小。"); }
    if (data.length !== size || crc32(data) !== crc) invalid("ZIP条目长度或CRC校验失败。");
    entries.push({ path: safePath, directory, bytes: size, compressedBytes, data });
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  if (cursor !== end) invalid();
  intervals.sort((a, b) => a[0] - b[0]);
  for (let index = 1; index < intervals.length; index++) if (intervals[index][0] < intervals[index - 1][1]) invalid("ZIP条目数据区重叠。");
  return { entries, totalBytes: checkEntries(entries) };
}
/** 使用标准store方法生成ZIP，避免生成自身超出解压率限制的高压缩归档。 */
export function createZip(input) {
  const entries = input.map((entry) => ({ ...entry, path: relativePath(entry.path, { allowRoot: false }), bytes: entry.directory ? 0 : entry.data.length }));
  checkEntries(entries);
  const localParts = [], directoryParts = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.path + (entry.directory ? "/" : ""));
    const data = entry.directory ? Buffer.alloc(0) : Buffer.from(entry.data);
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50);
    local.writeUInt16LE(20, 4); local.writeUInt16LE(0x800, 6);
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50);
    central.writeUInt16LE(0x314, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(0x800, 8);
    central.writeUInt32LE(crc, 16); central.writeUInt32LE(data.length, 20); central.writeUInt32LE(data.length, 24); central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(((entry.directory ? 0x41ed : 0x81a4) * 65536 + (entry.directory ? 0x10 : 0)) >>> 0, 38); central.writeUInt32LE(offset, 42);
    localParts.push(local, name, data); directoryParts.push(central, name);
    offset += local.length + name.length + data.length;
  }
  const directorySize = directoryParts.reduce((sum, part) => sum + part.length, 0);
  if (offset + directorySize + 22 > L.maxArchiveBytes) throw new WorkspaceError("ZIP_LIMIT", "生成的ZIP超过大小限额。");
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(directorySize, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...localParts, ...directoryParts, end]);
}
