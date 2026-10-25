import path from "node:path";
import { AuthStore, type AuthData } from "./auth.js";
import { CLOUD, type Config } from "./config.js";
import { digest } from "./storage.js";
import {
  CloudError,
  type Drive,
  type Library,
  type Entry,
  type Directory,
} from "./types.js";

export function trustedUrl(value: string): URL {
  const u = new URL(value, CLOUD);
  if (u.protocol !== "https:" || u.origin !== CLOUD || u.username || u.password)
    throw new CloudError("UNSAFE_URL", "只允许清华云盘同源 HTTPS 地址。");
  return u;
}
export function remotePath(p: string): string {
  if (
    !p ||
    /[\\\x00-\x1f]/.test(p) ||
    /%(?:2e|2f|5c)/i.test(p) ||
    p.split("/").some((x) => x === ".." || x === ".")
  )
    throw new CloudError("UNSAFE_PATH", "云盘路径不允许目录穿越或控制字符。");
  return path.posix.normalize("/" + p.replace(/^\/+/, ""));
}
export function bareName(name: string): string {
  if (!name || name === "." || name === ".." || /[\/\\\x00-\x1f]/.test(name))
    throw new CloudError("UNSAFE_PATH", "文件名必须是单一名称。");
  return name;
}
function repoId(id: string): string {
  if (!/^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(id))
    throw new CloudError("INVALID_REPO", "资料库 ID 必须为 UUID。");
  return id;
}
function entry(v: any, parent: string): Entry {
  return {
    name: bareName(String(v.name ?? v.obj_name ?? "")),
    path: remotePath(
      path.posix.join(parent, String(v.name ?? v.obj_name ?? "")),
    ),
    type: ["dir", "d"].includes(v.type) ? "dir" : "file",
    id: v.id ?? v.obj_id,
    size: typeof v.size === "number" ? v.size : undefined,
    mtime: v.mtime,
    permission: v.permission,
  };
}
export class CloudClient implements Drive {
  identity = "";
  private auth?: AuthData;
  private version?: string;
  private store: AuthStore;
  constructor(public config: Config) {
    this.store = new AuthStore(config.stateDir);
  }
  private invalidated = false;
  private generation?: string;
  private authQueue: Promise<unknown> = Promise.resolve();
  checkAuth(): Promise<void> {
    const next = this.authQueue
      .catch(() => {})
      .then(() => this.checkGeneration());
    this.authQueue = next;
    return next;
  }
  private invalidate(): never {
    this.invalidated = true;
    this.auth = undefined;
    this.identity = "";
    throw new CloudError(
      "AUTH_CHANGED",
      "认证已变化；当前操作已停止，请重新调用工具。",
    );
  }
  private async checkGeneration() {
    if (this.invalidated) this.invalidate();
    const generation = await this.store.generation();
    if (this.generation && generation !== this.generation) this.invalidate();
    if (!this.auth) {
      const saved = await this.store.loadVersioned();
      if (!saved)
        throw new CloudError(
          "AUTH_REQUIRED",
          "尚未登录云盘，请在本机运行 auth browser 或 auth login。",
        );
      if (
        (await this.store.generation()) !== generation ||
        (await this.store.version()) !== saved.version
      )
        this.invalidate();
      this.auth = saved.data;
      this.version = saved.version;
      this.generation = generation;
      this.identity = digest(this.auth.account).slice(0, 16);
    } else if ((await this.store.version()) !== this.version) this.invalidate();
  }
  async request(
    endpoint: string,
    init: RequestInit = {},
    expectedLocation?: string,
  ): Promise<any> {
    await this.checkAuth();
    const u = trustedUrl(endpoint);
    const response = await fetch(u.toString(), {
      ...init,
      redirect: "manual",
      headers: {
        Authorization: `Token ${this.auth!.token}`,
        Accept: "application/json",
        ...init.headers,
      },
      signal: AbortSignal.timeout(this.config.timeoutMs),
    });
    await this.checkAuth();
    const knownRename = response.status === 301 && Boolean(expectedLocation);
    if (expectedLocation && (response.ok || knownRename)) {
      const location = response.headers.get("location");
      if (!location)
        throw new CloudError(
          "VERIFY_UNKNOWN",
          "写入响应缺少目标地址，未确认成功。",
          500,
        );
      let actual: URL;
      try {
        actual = trustedUrl(new URL(location, u).toString());
      } catch {
        throw new CloudError(
          "VERIFY_UNKNOWN",
          "服务器返回了无法验证的写入目标地址；未跟随。",
          500,
        );
      }
      if (
        actual.pathname !== u.pathname ||
        remotePath(actual.searchParams.get("p") || "/") !== expectedLocation
      )
        throw new CloudError(
          "VERIFY_UNKNOWN",
          "服务器实际目标发生变化，可能已改名；未重试。",
          500,
        );
    }
    if (response.status >= 300 && response.status < 400 && !knownRename) {
      await response.body?.cancel();
      throw new CloudError(
        "UNSAFE_REDIRECT",
        "API 返回重定向，未跟随或转发凭据。",
        init.method && init.method !== "GET" ? 500 : undefined,
      );
    }
    if (!response.ok && !knownRename) {
      await response.body?.cancel();
      throw new CloudError(
        response.status === 401
          ? "AUTH_REQUIRED"
          : response.status === 403
            ? "PERMISSION_DENIED"
            : response.status === 404
              ? "NOT_FOUND"
              : "HTTP_ERROR",
        `云盘接口请求失败（HTTP ${response.status}），未自动重放写入。`,
        response.status,
      );
    }
    const text = await response.text();
    await this.checkAuth();
    if (/^\s*(?:<!doctype|<html|<form)/i.test(text))
      throw new CloudError(
        "AUTH_REQUIRED",
        "云盘返回登录页面，请重新登录。",
        init.method && init.method !== "GET" ? 500 : undefined,
      );
    if (!text.trim()) return null;
    try {
      return JSON.parse(text);
    } catch {
      throw new CloudError(
        "INVALID_RESPONSE",
        "云盘未返回预期 JSON。",
        init.method && init.method !== "GET" ? 500 : undefined,
      );
    }
  }
  async libraries(): Promise<Library[]> {
    await this.checkAuth();
    if (this.auth!.mode === "repo") {
      const r = await this.request("/api/v2.1/via-repo-token/repo-info/");
      const directory = await this.request("/api/v2.1/via-repo-token/dir/");
      return [
        {
          id: repoId(r.repo_id ?? r.id),
          name: r.repo_name ?? r.name,
          permission: directory.user_perm ?? r.permission ?? "r",
          encrypted: Boolean(r.encrypted),
          size: r.size,
        },
      ];
    }
    const rows = await this.request("/api2/repos/");
    if (!Array.isArray(rows))
      throw new CloudError("INVALID_RESPONSE", "无法识别资料库列表。");
    return rows.map((r: any) => ({
      id: repoId(r.id),
      name: r.name,
      permission: r.permission ?? "r",
      encrypted: Boolean(r.encrypted),
      size: r.size,
    }));
  }
  async resolveRepo(id?: string, write = false): Promise<Library> {
    const rows = await this.libraries();
    const r = rows.find((x) => x.id === (id || this.auth?.repoId));
    if (!r)
      throw new CloudError("NOT_FOUND", "当前账号或令牌不可访问该资料库。");
    if (r.encrypted)
      throw new CloudError("ENCRYPTED_LIBRARY", "首版不解锁加密资料库。");
    if (write && !r.permission.includes("w"))
      throw new CloudError("READ_ONLY", "资料库没有写权限。");
    return r;
  }
  private endpoint(id: string, part: string, p: string, modePart?: string) {
    const repo = this.auth!.mode === "repo";
    const u = trustedUrl(
      repo
        ? `/api/v2.1/via-repo-token/${modePart || part}/`
        : `/api2/repos/${repoId(id)}/${part}/`,
    );
    u.searchParams.set(repo ? "path" : "p", remotePath(p));
    return u;
  }
  async list(id: string, p = "/", offset = 0, limit = 100): Promise<Directory> {
    await this.resolveRepo(id);
    p = remotePath(p);
    const r = await this.request(this.endpoint(id, "dir", p).toString());
    const rows = Array.isArray(r) ? r : r?.dirent_list;
    if (!Array.isArray(rows))
      throw new CloudError("INVALID_RESPONSE", "无法识别目录列表。");
    // Seafile API2 and via-repo-token dir return a complete array (no page/per_page).
    if (rows.length > 20000)
      throw new CloudError(
        "DIRECTORY_LIMIT",
        "目录超过 20000 项，未声称完整。",
      );
    const all = rows.map((v: any) => entry(v, p));
    return {
      items: all.slice(offset, offset + limit),
      total: all.length,
      offset,
      nextOffset: offset + limit < all.length ? offset + limit : undefined,
    };
  }
  async info(id: string, p: string): Promise<Entry | undefined> {
    p = remotePath(p);
    if (p === "/") {
      await this.resolveRepo(id);
      return { name: "/", path: "/", type: "dir" };
    }
    return (await this.list(id, path.posix.dirname(p), 0, 20000)).items.find(
      (x) => x.name === path.posix.basename(p),
    );
  }
  async downloadLink(id: string, p: string) {
    await this.resolveRepo(id);
    const r = await this.request(
      this.endpoint(id, "file", p, "download-link").toString(),
    );
    return trustedUrl(typeof r === "string" ? r : r.download_link).toString();
  }
  async uploadLink(id: string, p: string) {
    await this.resolveRepo(id, true);
    const r = await this.request(
      this.endpoint(id, "upload-link", p).toString(),
    );
    return trustedUrl(typeof r === "string" ? r : r.upload_link).toString();
  }
  async mkdir(id: string, p: string) {
    await this.resolveRepo(id, true);
    p = remotePath(p);
    const scoped = this.auth!.mode === "repo";
    const result = await this.request(
      this.endpoint(id, "dir", p).toString(),
      { method: "POST", body: new URLSearchParams({ operation: "mkdir" }) },
      scoped ? undefined : p,
    );
    if (
      scoped &&
      remotePath(
        path.posix.join(result?.parent_dir || "/", result?.obj_name || ""),
      ) !== p
    )
      throw new CloudError(
        "VERIFY_UNKNOWN",
        "创建目录返回的名称无法确认。",
        500,
      );
    return { createdPath: p };
  }
  async rename(id: string, p: string, name: string) {
    await this.resolveRepo(id, true);
    const item = await this.info(id, p);
    if (!item) throw new CloudError("NOT_FOUND", "云盘项目不存在。");
    const dest = remotePath(
      path.posix.join(path.posix.dirname(p), bareName(name)),
    );
    if (await this.info(id, dest))
      throw new CloudError("CONFLICT", "目标名称已存在，未覆盖。");
    const scoped = this.auth!.mode === "repo";
    const u = this.endpoint(id, item.type === "dir" ? "dir" : "file", p);
    const result = await this.request(
      u.toString(),
      {
        method: "POST",
        body: new URLSearchParams({ operation: "rename", newname: name }),
      },
      !scoped && item.type === "file" ? dest : undefined,
    );
    if (
      scoped &&
      remotePath(
        path.posix.join(
          result?.parent_dir || "/",
          result?.obj_name || result?.name || "",
        ),
      ) !== dest
    )
      throw new CloudError(
        "VERIFY_UNKNOWN",
        "服务器返回了不同的重命名目标。",
        500,
      );
    return { path: dest };
  }

  async moveCopy(
    action: "move" | "copy",
    id: string,
    p: string,
    dstId: string,
    dstDir: string,
  ) {
    await this.resolveRepo(id, action === "move");
    await this.resolveRepo(dstId, true);
    if (this.auth!.mode !== "account")
      throw new CloudError(
        "TOKEN_SCOPE",
        "资料库令牌不支持移动/复制，需要账号令牌。",
      );
    p = remotePath(p);
    dstDir = remotePath(dstDir);
    const item = await this.info(id, p);
    if (!item) throw new CloudError("NOT_FOUND", "源项目不存在。");
    if (
      item.type === "dir" &&
      id === dstId &&
      (dstDir === p || dstDir.startsWith(p + "/"))
    )
      throw new CloudError("UNSAFE_PATH", "不能将目录移动或复制到自身内部。");
    if ((await this.info(dstId, dstDir))?.type !== "dir")
      throw new CloudError("NOT_FOUND", "目标目录不存在。");
    if (await this.info(dstId, path.posix.join(dstDir, item.name)))
      throw new CloudError("CONFLICT", "目标已有同名项目。");
    const result = await this.request(
      `/api/v2.1/repos/sync-batch-${action}-item/`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          src_repo_id: id,
          src_parent_dir: path.posix.dirname(p),
          src_dirents: [item.name],
          dst_repo_id: dstId,
          dst_parent_dir: dstDir,
        }),
      },
    );
    if (result?.success !== true)
      throw new CloudError(
        "VERIFY_UNKNOWN",
        "移动/复制返回的逐项结果未确认成功。",
        500,
      );
    return result;
  }
  async share(
    id: string,
    p: string,
    options: { password?: string; expireDays?: number },
  ) {
    await this.resolveRepo(id);
    if (this.auth!.mode !== "account")
      throw new CloudError("TOKEN_SCOPE", "生成分享链接需要账号令牌。");
    const body = new URLSearchParams({
      repo_id: id,
      path: remotePath(p),
      permissions: JSON.stringify({ can_download: true, can_preview: true }),
    });
    if (options.password) body.set("password", options.password);
    if (options.expireDays) body.set("expire_days", String(options.expireDays));
    const r = await this.request("/api/v2.1/share-links/", {
      method: "POST",
      body,
    });
    return { link: trustedUrl(r.link).toString(), expireDate: r.expire_date };
  }
  async search(query: string, id?: string, limit = 50): Promise<unknown> {
    await this.checkAuth();
    if (id) await this.resolveRepo(id);
    if (this.auth!.mode === "account") {
      try {
        const u = trustedUrl("/api2/search/");
        for (const [k, v] of Object.entries({
          q: query,
          search_repo: id || "all",
          page: "1",
          per_page: String(limit),
        }))
          u.searchParams.set(k, v);
        const r = await this.request(u.toString());
        return {
          mode: "server",
          results: r.results ?? r.data ?? r,
          total: r.total,
          complete: false,
          notice: "服务器搜索仅返回当前一页。",
        };
      } catch (e) {
        if (
          !(e instanceof CloudError) ||
          ![403, 404, 501].includes(e.status ?? 0)
        )
          throw e;
      }
    }
    const found: Entry[] = [];
    let scanned = 0;
    let truncated = false;
    const queue = (await this.libraries())
      .filter((r) => !id || r.id === id)
      .filter((r) => !r.encrypted)
      .map((r) => ({ id: r.id, p: "/" }));
    while (queue.length) {
      const current = queue.shift()!;
      for (const item of (await this.list(current.id, current.p, 0, 20000))
        .items) {
        scanned++;
        if (item.name.toLowerCase().includes(query.toLowerCase()))
          found.push({ ...item, ...{ repoId: current.id } });
        if (item.type === "dir") queue.push({ id: current.id, p: item.path });
        if (scanned >= 2000 || found.length >= limit) {
          truncated = true;
          queue.length = 0;
          break;
        }
      }
    }
    return {
      mode: "name-traversal",
      results: found,
      scanned,
      complete: !truncated,
      notice: "按名称遍历；不等同于服务端全文搜索。",
    };
  }
}
export async function validateToken(
  token: string,
  config: Config,
): Promise<AuthData> {
  if (!/^[A-Za-z0-9._-]{20,512}$/.test(token))
    throw new CloudError("AUTH_FORMAT", "Token 格式无效。");
  const call = async (endpoint: string) => {
    const r = await fetch(CLOUD + endpoint, {
      headers: { Authorization: `Token ${token}`, Accept: "application/json" },
      redirect: "manual",
      signal: AbortSignal.timeout(config.timeoutMs),
    });
    if (!r.ok) {
      await r.body?.cancel();
      throw new CloudError("AUTH_TOKEN", "无法验证云盘 Token。", r.status);
    }
    return r.json() as Promise<any>;
  };
  try {
    const r = await call("/api2/account/info/");
    if (!r.email && !r.name)
      throw new CloudError("AUTH_TOKEN", "未取得账号信息。");
    return { account: r.email || r.name, token, mode: "account" };
  } catch (e) {
    if (!(e instanceof CloudError) || ![401, 403].includes(e.status ?? 0))
      throw e;
  }
  const r = await call("/api/v2.1/via-repo-token/repo-info/");
  const id = repoId(r.repo_id ?? r.id);
  return { account: "repo:" + id, token, mode: "repo", repoId: id };
}
