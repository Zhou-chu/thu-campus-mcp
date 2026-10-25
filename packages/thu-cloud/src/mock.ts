import path from "node:path";
import { randomUUID } from "node:crypto";
import { CloudError, type Drive, type Library, type Entry } from "./types.js";
import { remotePath, bareName } from "./client.js";
import { atomicJson, readJson, digest, withLock } from "./storage.js";
import type { Config } from "./config.js";
export const MOCK_REPO = "11111111-1111-4111-8111-111111111111";
interface FileData {
  type: "file" | "dir";
  data?: string;
  id: string;
  mtime: number;
}
export class MockDrive implements Drive {
  identity = "local-mock-account";
  constructor(private config: Config) {}
  async checkAuth() {}
  private get file() {
    return path.join(this.config.stateDir, "mock-files.json");
  }
  private async load() {
    return (
      (await readJson<Record<string, FileData>>(this.file)) || {
        "/README.txt": {
          type: "file",
          data: Buffer.from("清华云盘离线模拟文件。").toString("base64"),
          id: "initial",
          mtime: 1,
        },
      }
    );
  }
  private async change(fn: (files: Record<string, FileData>) => void) {
    return withLock(this.file + ".lock", async () => {
      const files = await this.load();
      fn(files);
      await atomicJson(this.file, files);
    });
  }
  async libraries(): Promise<Library[]> {
    return [
      { id: MOCK_REPO, name: "本地模拟库", permission: "rw", encrypted: false },
    ];
  }
  async resolveRepo(id?: string) {
    if (id !== MOCK_REPO)
      throw new CloudError("NOT_FOUND", "模拟资料库不存在。");
    return (await this.libraries())[0];
  }
  async list(id: string, p: string, offset = 0, limit = 100) {
    await this.resolveRepo(id);
    p = remotePath(p);
    const files = await this.load();
    const rows = Object.entries(files)
      .filter(([k]) => path.posix.dirname(k) === p && k !== p)
      .map(([k, f]) => this.asEntry(k, f));
    return {
      items: rows.slice(offset, offset + limit),
      total: rows.length,
      offset,
      nextOffset: offset + limit < rows.length ? offset + limit : undefined,
    };
  }
  private asEntry(k: string, f: FileData): Entry {
    return {
      path: k,
      name: path.posix.basename(k),
      type: f.type,
      id: f.id,
      mtime: f.mtime,
      size: f.data ? Buffer.from(f.data, "base64").length : 0,
    };
  }
  async info(id: string, p: string) {
    await this.resolveRepo(id);
    p = remotePath(p);
    if (p === "/") return { path: "/", name: "/", type: "dir" as const };
    const f = (await this.load())[p];
    return f ? this.asEntry(p, f) : undefined;
  }
  async downloadLink(id: string, p: string) {
    await this.resolveRepo(id);
    return `https://cloud.tsinghua.edu.cn/mock-download?p=${encodeURIComponent(remotePath(p))}`;
  }
  async uploadLink(id: string, p: string) {
    await this.resolveRepo(id);
    return `https://cloud.tsinghua.edu.cn/mock-upload?p=${encodeURIComponent(remotePath(p))}`;
  }
  async transferRequest(url: string, init: RequestInit = {}) {
    const u = new URL(url);
    if (u.pathname === "/mock-download") {
      const f = (await this.load())[remotePath(u.searchParams.get("p")!)];
      if (!f?.data) return new Response("", { status: 404 });
      const bytes = Buffer.from(f.data, "base64");
      return new Response(bytes, {
        headers: {
          "content-length": String(bytes.length),
          "content-type": "application/octet-stream",
        },
      });
    }
    if (u.pathname === "/mock-upload" && init.method === "POST") {
      const form = init.body as FormData;
      const file = form.get("file") as File;
      const p = remotePath(
        path.posix.join(u.searchParams.get("p")!, bareName(file.name)),
      );
      const data = Buffer.from(await file.arrayBuffer());
      let conflict = false;
      await this.change((files) => {
        if (files[p] && form.get("replace") !== "1") {
          conflict = true;
          return;
        }
        files[p] = {
          type: "file",
          data: data.toString("base64"),
          id: digest(data),
          mtime: Date.now(),
        };
      });
      return Response.json(
        conflict
          ? { error: "exists" }
          : [{ name: file.name, size: data.length, id: digest(data) }],
        { status: conflict ? 409 : 200 },
      );
    }
    throw new CloudError("MOCK_NETWORK", "模拟模式禁止访问远端传输。");
  }
  async mkdir(id: string, p: string) {
    await this.resolveRepo(id);
    p = remotePath(p);
    await this.change((f) => {
      if (f[p]) throw new CloudError("CONFLICT", "目录已存在。");
      f[p] = { type: "dir", id: randomUUID(), mtime: Date.now() };
    });
    return { createdPath: p };
  }
  async rename(id: string, p: string, name: string) {
    return this.relocate(
      "move",
      id,
      p,
      id,
      path.posix.dirname(p),
      bareName(name),
    );
  }
  async moveCopy(
    action: "move" | "copy",
    id: string,
    p: string,
    dstId: string,
    dstDir: string,
  ) {
    return this.relocate(action, id, p, dstId, dstDir, path.posix.basename(p));
  }
  private async relocate(
    action: "move" | "copy",
    id: string,
    p: string,
    dstId: string,
    dir: string,
    name: string,
  ) {
    await this.resolveRepo(id);
    await this.resolveRepo(dstId);
    p = remotePath(p);
    const dst = remotePath(path.posix.join(dir, name));
    await this.change((f) => {
      if (!f[p]) throw new CloudError("NOT_FOUND", "源项目不存在。");
      if (f[dst]) throw new CloudError("CONFLICT", "目标已存在。");
      for (const key of Object.keys(f).filter(
        (k) => k === p || k.startsWith(p + "/"),
      )) {
        f[dst + key.slice(p.length)] = { ...f[key] };
        if (action === "move") delete f[key];
      }
    });
    return { path: dst };
  }
  async share(
    id: string,
    p: string,
    _options: { password?: string; expireDays?: number },
  ) {
    await this.resolveRepo(id);
    return { link: "https://cloud.tsinghua.edu.cn/f/mock-share/", path: p };
  }
  async search(query: string, id?: string, limit = 50) {
    const rows = (await this.list(id || MOCK_REPO, "/", 0, 10000)).items;
    return {
      mode: "name-traversal",
      results: rows.filter((r) => r.name.includes(query)).slice(0, limit),
    };
  }
}
