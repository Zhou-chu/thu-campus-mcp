import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { tmpdir } from "node:os";
import { mkdtemp, mkdir, writeFile, readdir, rm, symlink, rmdir } from "node:fs/promises";
import { deflateRawSync } from "node:zlib";
import { WorkspaceFiles, WorkspaceError, WORKSPACE_LIMITS as L } from "../lib/app/workspace-files.mjs";
import { relativePath, inspectAbsolute, workspaceIO } from "../lib/app/workspace-paths.mjs";
import { createZip, parseZip, crc32 } from "../lib/app/workspace-zip.mjs";
const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
async function fixture(t) {
  const directory = await mkdtemp(path.join(tmpdir(), "campus-workspace-test-"));
  assert.equal(path.isAbsolute(directory), true);
  assert.match(path.basename(directory), /^campus-workspace-test-/);
  t.after(() => rm(directory, { recursive: true, force: true }));
  return { directory, files: new WorkspaceFiles({ baseDir: path.join(directory, "workspaces") }) };
}
const rejects = (action, code) => assert.rejects(action, (e) => e instanceof WorkspaceError && e.code === code && /[\u4e00-\u9fff]/.test(e.message));
function rawZip(entries, { comment = "" } = {}) {
  let offset = 0;
  const localParts = [], directoryParts = [];
  for (const item of entries) {
    const name = Buffer.isBuffer(item.name) ? item.name : Buffer.from(item.name);
    const data = Buffer.from(item.text ?? "hello");
    const method = item.method ?? 0, flags = item.flags ?? 0x800;
    const compressed = method === 8 ? deflateRawSync(data) : data;
    const extra = item.extra || Buffer.alloc(0), localExtra = item.localExtra || Buffer.alloc(0);
    const local = Buffer.alloc(30), central = Buffer.alloc(46);
    const crc = crc32(data), descriptor = !!(flags & 8);
    local.writeUInt32LE(0x04034b50); local.writeUInt16LE(item.localVersion ?? 20, 4); local.writeUInt16LE(flags, 6); local.writeUInt16LE(method, 8);
    if (!descriptor) { local.writeUInt32LE(crc, 14); local.writeUInt32LE(compressed.length, 18); local.writeUInt32LE(data.length, 22); }
    local.writeUInt16LE(name.length, 26); local.writeUInt16LE(localExtra.length, 28);
    const tail = Buffer.alloc(descriptor ? (item.unsignedDescriptor ? 12 : 16) : 0);
    if (descriptor) {
      const position = item.unsignedDescriptor ? 0 : 4;
      if (position) tail.writeUInt32LE(0x08074b50);
      tail.writeUInt32LE(crc, position); tail.writeUInt32LE(compressed.length, position + 4); tail.writeUInt32LE(data.length, position + 8);
    }
    central.writeUInt32LE(0x02014b50); central.writeUInt16LE(0x314, 4); central.writeUInt16LE(item.version ?? 20, 6); central.writeUInt16LE(flags, 8); central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc, 16); central.writeUInt32LE(compressed.length, 20); central.writeUInt32LE(data.length, 24); central.writeUInt16LE(name.length, 28); central.writeUInt16LE(extra.length, 30);
    central.writeUInt32LE(item.external ?? ((item.name?.endsWith?.("/") ? 0x41ed : 0x81a4) * 65536) >>> 0, 38); central.writeUInt32LE(offset, 42);
    localParts.push(local, name, localExtra, compressed, tail); directoryParts.push(central, name, extra);
    offset += local.length + name.length + localExtra.length + compressed.length + tail.length;
  }
  const directory = Buffer.concat(directoryParts), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16); end.writeUInt16LE(Buffer.byteLength(comment), 20);
  return Buffer.concat([...localParts, directory, end, Buffer.from(comment)]);
}
const positions = (bytes) => ({ end: bytes.length - 22, central: bytes.readUInt32LE(bytes.length - 6) });
const mutated = (apply) => { const bytes = rawZip([{ name: "a.txt" }]); apply(bytes, positions(bytes)); return bytes; };

test("会话根目录与文字/字节读写保持隔离、分页和显式覆盖", async (t) => {
  const { files } = await fixture(t);
  const root = await files.root(A);
  assert.equal(path.isAbsolute(root), true);
  assert.equal(root, await files.root(A));
  assert.notEqual(root, await files.root(B));
  assert.deepEqual(await files.list(A), { path: ".", entries: [] });
  assert.deepEqual(await files.write(A, { path: "notes/中文.txt", text: "你好world\n尾部" }), { path: "notes/中文.txt", bytes: Buffer.byteLength("你好world\n尾部") });
  const first = await files.read(A, { path: "notes/中文.txt", maxChars: 3 });
  assert.deepEqual(first, { path: "notes/中文.txt", text: "你好w", encoding: "utf-8", offset: 0, nextOffset: 3, totalChars: 10 });
  const rest = await files.read(A, { path: first.path, offset: first.nextOffset, maxChars: 100, encoding: "utf8" });
  assert.equal(rest.text, "orld\n尾部"); assert.equal(rest.nextOffset, null);
  assert.equal((await files.read(A, { path: first.path, offset: 999 })).offset, 10);
  assert.equal((await files.list(A)).entries[0].type, "directory");
  assert.equal((await files.list(A, { path: "notes" })).entries[0].bytes, first.totalChars + 8);
  await rejects(() => files.readBytes(B, first.path), "FILE_NOT_FOUND");
  await rejects(() => files.write(A, { path: first.path, text: "no" }), "FILE_EXISTS");
  assert.equal((await files.read(A, { path: first.path })).text, "你好world\n尾部");
  await files.write(A, { path: first.path, text: "覆盖", overwrite: true });
  assert.equal((await files.read(A, { path: first.path })).text, "覆盖");
  await files.writeBytes(A, { path: "bytes.dat", bytes: new Uint8Array([1, 2, 3]) });
  assert.deepEqual(await files.readBytes(A, "bytes.dat"), Buffer.from([1, 2, 3]));
  await rejects(() => files.read(A, { path: "bytes.dat" }), "BINARY_FILE");
  assert.ok(!(await readdir(root)).some((name) => name.startsWith(".workspace-write-")));
});

test("JSON/ipynb/CSV以真实UTF-8原文读取，不假读二进制或未知编码", async (t) => {
  const { files } = await fixture(t);
  for (const [name, text] of [["data.json", '{"x":1}'], ["work.ipynb", '{"cells":[{"cell_type":"code","source":["print(1)"]}]}'], ["table.csv", "姓名,得分\n甲,99"]]) {
    await files.write(A, { path: name, text });
    assert.equal((await files.read(A, { path: name })).text, text);
  }
  await files.writeBytes(A, { path: "invalid.dat", bytes: Buffer.from([255, 254]) });
  await rejects(() => files.read(A, { path: "invalid.dat" }), "BINARY_FILE");
  await files.write(A, { path: "fake.pdf", text: "%PDF-" });
  await rejects(() => files.read(A, { path: "fake.pdf" }), "BINARY_FILE");
  await rejects(() => files.read(A, { path: "data.json", encoding: "gbk" }), "INVALID_ENCODING");
  await rejects(() => files.read(A, { path: "data.json", offset: -1 }), "INVALID_ARGUMENTS");
  await rejects(() => files.read(A, { path: "data.json", maxChars: L.maxTextChars + 1 }), "INVALID_ARGUMENTS");
  await rejects(() => files.readBytes(A, "data.json", { maxBytes: 1 }), "FILE_TOO_LARGE");
  await rejects(() => files.readBytes(A, "data.json", { maxBytes: Infinity }), "INVALID_ARGUMENTS");
  await rejects(() => files.write(A, { path: "a", text: 1 }), "INVALID_ARGUMENTS");
  await rejects(() => files.writeBytes(A, { path: "a", bytes: [] }), "INVALID_ARGUMENTS");
  await rejects(() => files.writeBytes(A, { path: "a", bytes: Buffer.alloc(0), overwrite: "yes" }), "INVALID_ARGUMENTS");
  await rejects(() => files.writeBytes(A, { path: "huge", bytes: Buffer.alloc(L.maxFileBytes + 1) }), "FILE_TOO_LARGE");
  await rejects(() => files.readBytes(A, "."), "NOT_FILE");
  await rejects(() => files.list(A, { path: "data.json" }), "NOT_DIRECTORY");
  await rejects(() => files.write(A, { path: "data.json/sub", text: "x" }), "NOT_DIRECTORY");
  await rejects(() => files.write(A, { path: "folder", text: "x", overwrite: true }).then(() => files.write(A, { path: "folder/sub", text: "x" })), "NOT_DIRECTORY");
});

test("路径拒绝绝对/父级/Windows别名和跨会话，resolve不创建缺失目标", async (t) => {
  const { files } = await fixture(t);
  for (const name of ["../outside", `../${B}/secret`, "a/../../x", "a\\..\\x"]) await rejects(() => files.resolve(A, name, { mustExist: false }), "PATH_ESCAPE");
  for (const name of ["/absolute", "C:\\absolute", "\\\\host\\share", "C:relative", "a:b", "con.txt", "LPT1", "COM¹", "CONIN$", "a.", "a ", "a?b", "\0", "", "x".repeat(1025)]) await rejects(() => files.resolve(A, name, { mustExist: false }), "INVALID_PATH");
  await rejects(() => files.root("../../other"), "INVALID_SESSION");
  await rejects(() => files.write(A, { path: ".", text: "x" }), "INVALID_PATH");
  assert.equal(await files.resolve(A, "missing/child", { mustExist: false }), path.join(await files.root(A), "missing", "child"));
  assert.deepEqual((await files.list(A)).entries, []);
  await rejects(() => files.resolve(A, "missing"), "FILE_NOT_FOUND");
  assert.equal(relativePath("a//./b\\c"), "a/b/c");
  assert.throws(() => new WorkspaceFiles(), WorkspaceError);
  assert.throws(() => new WorkspaceFiles({ baseDir: 1 }), WorkspaceError);
});

test("符号链接或junction在根/中间/目录列表/导入均被拒绝", async (t) => {
  const { files, directory } = await fixture(t);
  const outside = path.join(directory, "outside"); await mkdir(outside); await writeFile(path.join(outside, "secret.txt"), "不应读取");
  const root = await files.root(A), shortcut = path.join(root, "shortcut");
  await symlink(outside, shortcut, process.platform === "win32" ? "junction" : "dir");
  for (const operation of [() => files.resolve(A, "shortcut"), () => files.readBytes(A, "shortcut/secret.txt"), () => files.write(A, { path: "shortcut/new", text: "x" }), () => files.list(A)]) await rejects(operation, "SYMLINK_REJECTED");
  assert.deepEqual(await readdir(outside), ["secret.txt"]);
  await files.writeBytes(A, { path: "source.zip", bytes: rawZip([{ name: "new.txt" }]) });
  await rejects(() => files.zip(A, { action: "extract", path: "source.zip", destination: "shortcut" }), "SYMLINK_REJECTED");
  await rejects(() => files.zip(A, { action: "create", path: "output.zip", files: ["shortcut"] }), "SYMLINK_REJECTED");
  assert.deepEqual(await readdir(outside), ["secret.txt"]);
  const linkedBase = new WorkspaceFiles({ baseDir: shortcut });
  await rejects(() => linkedBase.root(B), "SYMLINK_REJECTED");
  const source = path.join(shortcut, "secret.txt");
  await rejects(() => files.importFile(A, { sourcePath: source, path: "imported" }, { approvedSourcePath: source }), "SYMLINK_REJECTED");
  const rootB = await files.root(B); await rmdir(rootB); await symlink(outside, rootB, process.platform === "win32" ? "junction" : "dir");
  await rejects(() => files.root(B), "SYMLINK_REJECTED");
});

test("导入只接受调用上下文精确授权，args不能自批且不覆盖", async (t) => {
  const { files, directory } = await fixture(t);
  const source = path.join(directory, "source.csv"), other = path.join(directory, "other.csv");
  await writeFile(source, "x,y\n1,2"); await writeFile(other, "other");
  await rejects(() => files.importFile(A, { sourcePath: source, approvedSourcePath: source, approved: true }), "IMPORT_NOT_APPROVED");
  await rejects(() => files.importFile(A, { sourcePath: source }, { approvedSourcePath: other }), "IMPORT_NOT_APPROVED");
  await rejects(() => files.importFile(A, { sourcePath: "source.csv" }, { approvedSourcePath: "source.csv" }), "IMPORT_NOT_APPROVED");
  assert.deepEqual(await files.importFile(A, { sourcePath: source }, { approvedSourcePath: path.join(directory, ".", "source.csv") }), { path: "source.csv", bytes: 7 });
  await rejects(() => files.importFile(A, { sourcePath: other, path: "source.csv" }, { approvedSourcePath: other }), "FILE_EXISTS");
  await files.importFile(A, { sourcePath: other, path: "source.csv", overwrite: true }, { approvedSourcePath: other });
  assert.equal((await files.read(A, { path: "source.csv" })).text, "other");
  await rejects(() => files.importFile(A, { sourcePath: directory }, { approvedSourcePath: directory }), "NOT_FILE");
});

test("ZIP目录/文件打包、列目录和解压闭环，保留Unicode与空目录", async (t) => {
  const { files } = await fixture(t);
  await files.write(A, { path: "input/中文.csv", text: "a,b\n1,2" });
  await files.write(A, { path: "readme.txt", text: "hello" });
  await mkdir(await files.resolve(A, "input/empty", { mustExist: false }));
  const created = await files.zip(A, { action: "create", path: "result.zip", files: ["input", "readme.txt"] });
  assert.equal(created.path, "result.zip"); assert.equal(created.entries, 4); assert.ok(created.bytes > 0);
  const listing = await files.zip(A, { action: "list", path: "result.zip" });
  assert.equal(listing.totalBytes, 12); assert.equal(listing.entries.length, 4);
  assert.ok(listing.entries.some((item) => item.path === "input/empty" && item.directory));
  const extracted = await files.zip(A, { action: "extract", path: "result.zip" });
  assert.equal(extracted.destination, "result.zip.extracted"); assert.equal(extracted.files.length, 2);
  assert.equal((await files.read(A, { path: "result.zip.extracted/input/中文.csv" })).text, "a,b\n1,2");
  assert.equal((await files.list(A, { path: "result.zip.extracted/input/empty" })).entries.length, 0);
  await rejects(() => files.zip(A, { action: "create", path: "result.zip", files: ["input"] }), "FILE_EXISTS");
  await rejects(() => files.zip(A, { action: "extract", path: "result.zip" }), "FILE_EXISTS");
  await rejects(() => files.zip(A, { action: "remove", path: "result.zip" }), "INVALID_ARGUMENTS");
  for (const list of [undefined, [], "input"]) await rejects(() => files.zip(A, { action: "create", path: "new.zip", files: list }), "INVALID_ARGUMENTS");
  await files.zip(B, { action: "create", path: "empty.zip", files: ["."] });
  assert.deepEqual((await files.zip(B, { action: "list", path: "empty.zip" })).entries, []);
});

for (const flags of [0x800, 0x808]) {
  test(`标准deflate ZIP与data descriptor可读取，flags=${flags}`, async (t) => {
    const { files } = await fixture(t);
    for (const unsignedDescriptor of [false, true]) {
      const archive = rawZip([{ name: "data.txt", method: 8, flags, text: "hello中文".repeat(5), unsignedDescriptor }], { comment: "archive comment" });
      const parsed = parseZip(archive);
      assert.equal(parsed.entries[0].data.toString(), "hello中文".repeat(5));
      await files.writeBytes(A, { path: `d-${unsignedDescriptor}.zip`, bytes: archive });
      await files.zip(A, { action: "extract", path: `d-${unsignedDescriptor}.zip`, destination: `out-${unsignedDescriptor}` });
      assert.equal((await files.read(A, { path: `out-${unsignedDescriptor}/data.txt` })).text, "hello中文".repeat(5));
    }
  });
}

const badArchives = [
  ["非ZIP", Buffer.from("no zip"), "ZIP_INVALID"],
  ["父级", rawZip([{ name: "../outside.txt" }]), "PATH_ESCAPE"],
  ["Windows父级", rawZip([{ name: "a\\..\\outside.txt" }]), "PATH_ESCAPE"],
  ["绝对路径", rawZip([{ name: "/outside" }]), "INVALID_PATH"],
  ["盘符", rawZip([{ name: "C:\\outside" }]), "INVALID_PATH"],
  ["系统保留名", rawZip([{ name: "CON" }]), "INVALID_PATH"],
  ["根目录条目", rawZip([{ name: "./", text: "" }]), "INVALID_PATH"],
  ["symlink", rawZip([{ name: "link", external: (0xa1ff * 65536) >>> 0 }]), "ZIP_LINK_REJECTED"],
  ["目录带数据", rawZip([{ name: "dir/", text: "bad" }]), "ZIP_INVALID"],
  ["重复", rawZip([{ name: "a" }, { name: "a" }]), "ZIP_INVALID"],
  ["大小写冲突", rawZip([{ name: "A" }, { name: "a" }]), "ZIP_INVALID"],
  ["父项是文件", rawZip([{ name: "a" }, { name: "a/b" }]), "ZIP_INVALID"],
  ["加密", rawZip([{ name: "a", flags: 0x801 }]), "ZIP_UNSUPPORTED"],
  ["不支持压缩", rawZip([{ name: "a", method: 99 }]), "ZIP_UNSUPPORTED"],
  ["非UTF8标记", rawZip([{ name: "中文", flags: 0 }]), "ZIP_UNSUPPORTED"],
  ["坏UTF8", rawZip([{ name: Buffer.from([255]) }]), "ZIP_INVALID"],
  ["中央ZIP64", rawZip([{ name: "a", version: 45 }]), "ZIP_UNSUPPORTED"],
  ["本地ZIP64", rawZip([{ name: "a", localVersion: 45 }]), "ZIP_UNSUPPORTED"],
  ["ZIP64扩展", rawZip([{ name: "a", extra: Buffer.from([1, 0, 0, 0]) }]), "ZIP_UNSUPPORTED"],
  ["坏扩展", rawZip([{ name: "a", extra: Buffer.from([2, 0, 9, 0]) }]), "ZIP_INVALID"],
  ["本地ZIP64扩展", rawZip([{ name: "a", localExtra: Buffer.from([1, 0, 0, 0]) }]), "ZIP_UNSUPPORTED"],
  ["坏CRC", mutated((b) => { b[35] ^= 1; }), "ZIP_INVALID"],
  ["中央头损坏", mutated((b, { central }) => b.writeUInt32LE(0, central)), "ZIP_INVALID"],
  ["本地头损坏", mutated((b) => b.writeUInt32LE(0, 0)), "ZIP_INVALID"],
  ["本地名称不同", mutated((b) => { b[30] = 98; }), "ZIP_INVALID"],
  ["本地CRC不同", mutated((b) => b.writeUInt32LE(0, 14)), "ZIP_INVALID"],
  ["压缩大小越界", mutated((b, { central }) => b.writeUInt32LE(99999, central + 20)), "ZIP_INVALID"],
  ["目录结束偏移不符", mutated((b, { end }) => b.writeUInt32LE(0, end + 12)), "ZIP_INVALID"],
  ["分卷", mutated((b, { end }) => b.writeUInt16LE(1, end + 4)), "ZIP_UNSUPPORTED"],
  ["中央分卷", mutated((b, { central }) => b.writeUInt16LE(1, central + 34)), "ZIP_UNSUPPORTED"],
  ["ZIP64结束", mutated((b, { end }) => b.writeUInt16LE(65535, end + 10)), "ZIP_UNSUPPORTED"],
  ["条目过多", mutated((b, { end }) => { b.writeUInt16LE(L.maxEntries + 1, end + 8); b.writeUInt16LE(L.maxEntries + 1, end + 10); }), "ZIP_LIMIT"],
  ["声明文件过大", mutated((b, { central }) => b.writeUInt32LE(L.maxFileBytes + 1, central + 24)), "ZIP_LIMIT"],
  ["零压缩尺寸炸弹", mutated((b, { central }) => b.writeUInt32LE(0, central + 20)), "ZIP_LIMIT"],
  ["解压率炸弹", rawZip([{ name: "bomb", method: 8, text: "a".repeat(10000) }]), "ZIP_LIMIT"],
];
for (const [label, archive, code] of badArchives) {
  test(`拒绝${label}且解压前不写目标`, async (t) => {
    const { files } = await fixture(t);
    await files.writeBytes(A, { path: "bad.zip", bytes: archive });
    await rejects(() => files.zip(A, { action: "extract", path: "bad.zip", destination: "output" }), code);
    await rejects(() => files.zip(A, { action: "list", path: "bad.zip" }), code);
    assert.deepEqual((await files.list(A)).entries.map((e) => e.name), ["bad.zip"]);
  });
}

test("解压先预检全部既有目标，冲突不产生前序文件或覆盖用户文件", async (t) => {
  const { files } = await fixture(t);
  await files.writeBytes(A, { path: "input.zip", bytes: rawZip([{ name: "new.txt" }, { name: "keep.txt", text: "overwrite" }]) });
  await files.write(A, { path: "output/keep.txt", text: "用户文件" });
  await rejects(() => files.zip(A, { action: "extract", path: "input.zip", destination: "output" }), "FILE_EXISTS");
  assert.deepEqual((await files.list(A, { path: "output" })).entries.map((e) => e.name), ["keep.txt"]);
  assert.equal((await files.read(A, { path: "output/keep.txt" })).text, "用户文件");
  await rejects(() => files.zip(A, { action: "extract", path: "input.zip", destination: "../other" }), "PATH_ESCAPE");
});

test("生成ZIP同样检查条目/累计大小且空ZIP合法，CRC为标准算法", () => {
  assert.equal(crc32(Buffer.from("123456789")), 0xcbf43926);
  assert.deepEqual(parseZip(createZip([])).entries, []);
  assert.throws(() => createZip(Array.from({ length: L.maxEntries + 1 }, (_, i) => ({ path: `f${i}`, data: Buffer.alloc(0) }))), (e) => e.code === "ZIP_LIMIT");
  assert.throws(() => createZip([{ path: "big", data: { length: L.maxFileBytes + 1 } }]), (e) => e.code === "ZIP_LIMIT");
  assert.throws(() => createZip([0, 1, 2].map((i) => ({ path: `big${i}`, data: { length: 25 * 1024 * 1024 } }))), (e) => e.code === "ZIP_LIMIT");
  assert.throws(() => createZip([{ path: "a", data: Buffer.alloc(0) }, { path: "a/b", data: Buffer.alloc(0) }]), (e) => e.code === "ZIP_INVALID");
});

test("空参数统一报错，合法点号前缀文件不被当作父级目录", async (t) => {
  const { files } = await fixture(t);
  for (const action of [() => files.list(A, null), () => files.read(A, null), () => files.readBytes(A, "x", null), () => files.writeBytes(A, null), () => files.writeBytes(A), () => files.write(A, null), () => files.importFile(A, null), () => files.importFile(A, {}, null), () => files.zip(A, null)]) await rejects(action, "INVALID_ARGUMENTS");
  assert.throws(() => new WorkspaceFiles(null), WorkspaceError);
  await files.write(A, { path: "..hidden", text: "safe" });
  assert.equal((await files.read(A, { path: "..hidden" })).text, "safe");
  await rejects(() => files.write(A, { path: ".", text: "x", overwrite: true }), "INVALID_PATH");
});

test("损坏deflate、descriptor与重叠数据区拒绝，未知普通扩展可安全跳过", () => {
  const deflate = rawZip([{ name: "z", method: 8, text: "abc" }]);
  deflate[31] = 7;
  assert.throws(() => parseZip(deflate), (e) => e.code === "ZIP_INVALID");
  const descriptor = rawZip([{ name: "a", flags: 0x808 }]);
  const descriptorCentral = descriptor.readUInt32LE(descriptor.length - 6);
  descriptor.writeUInt32LE(0, descriptorCentral - 12);
  assert.throws(() => parseZip(descriptor), (e) => e.code === "ZIP_INVALID");
  const overlap = rawZip([{ name: "a" }, { name: "a" }]);
  const overlapCentral = overlap.readUInt32LE(overlap.length - 6);
  overlap.writeUInt32LE(0, overlapCentral + 47 + 42);
  assert.throws(() => parseZip(overlap), (e) => e.code === "ZIP_INVALID");
  const extra = Buffer.from([2, 0, 1, 0, 99]);
  assert.equal(parseZip(rawZip([{ name: "a", flags: 0, extra, localExtra: extra }])).entries[0].data.toString(), "hello");
  assert.throws(() => parseZip(rawZip([{ name: "a", extra: Buffer.from([1]) }])), (e) => e.code === "ZIP_INVALID");
});

test("统一WorkspaceError映射I/O错误，不泄漏非中文底层异常", async () => {
  for (const [native, code] of [["ENOENT", "FILE_NOT_FOUND"], ["EEXIST", "FILE_EXISTS"], ["ENOTDIR", "NOT_DIRECTORY"], ["EISDIR", "NOT_FILE"], ["ELOOP", "SYMLINK_REJECTED"], ["EACCES", "FILE_ACCESS_DENIED"], ["EPERM", "FILE_ACCESS_DENIED"], ["OTHER", "WORKSPACE_IO"]]) {
    await rejects(() => workspaceIO(() => { throw Object.assign(new Error("raw"), { code: native }); }), code);
  }
  await assert.rejects(inspectAbsolute(path.join(path.parse(process.cwd()).root, `missing-${Date.now()}`)), (e) => e.code === "ENOENT");
});
