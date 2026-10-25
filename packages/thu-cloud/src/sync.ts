import path from "node:path";
import { lstat, mkdir, readdir, readFile } from "node:fs/promises";
import { CloudError, publicError, type Drive, type Entry } from "./types.js";
import type { Config } from "./config.js";
import { remotePath } from "./client.js";
import { TransferService, hashFile } from "./transfer.js";
import {
  atomicJson,
  readJson,
  digest,
  guardedPath,
  safeSegment,
  withLock,
} from "./storage.js";
export interface SyncInput {
  direction: "download" | "upload";
  repoId: string;
  path: string;
  localDir: string;
  overwrite?: boolean;
  maxFiles?: number;
  accountId?: string;
}
interface Saved {
  remoteId?: string;
  sha256: string;
  local: string;
}
interface Manifest {
  accountId: string;
  repoId: string;
  remoteRoot: string;
  direction: string;
  items: Record<string, Saved>;
  paths?: Record<string, string>;
}
function segment(name: string) {
  const safe = safeSegment(name);
  if (safe === name) return name;
  const ext = path.posix.extname(safe);
  return (
    safe.slice(0, safe.length - ext.length) +
    "__" +
    digest(name).slice(0, 8) +
    ext
  );
}
export class SyncService {
  constructor(
    private client: Drive,
    private config: Config,
  ) {}
  async run(input: SyncInput, progress?: (r: unknown) => Promise<void>) {
    if (!path.isAbsolute(input.localDir))
      throw new CloudError("ABSOLUTE_PATH", "同步目录必须为绝对路径。");
    const root = path.resolve(input.localDir);
    await mkdir(root, { recursive: true });
    const remoteRoot = remotePath(input.path);
    await this.client.resolveRepo(input.repoId, input.direction === "upload");
    const accountId = this.client.identity;
    if (input.accountId && input.accountId !== accountId)
      throw new CloudError(
        "ACCOUNT_MISMATCH",
        "后台任务属于另一账号，未执行。",
      );
    const key = digest(
      JSON.stringify([input.direction, input.repoId, remoteRoot]),
    ).slice(0, 16);
    const manifestPath = await guardedPath(
      root,
      ".thu-cloud-sync-" + key + ".json",
    );
    return withLock(
      path.join(this.config.stateDir, "sync-locks", digest(root.toLowerCase())),
      async () => {
        const saved = await readJson<Manifest>(manifestPath);
        if (saved && saved.accountId !== accountId)
          throw new CloudError(
            "ACCOUNT_MISMATCH",
            "本地同步清单属于另一账号。",
          );
        const manifest: Manifest = saved || {
          accountId,
          repoId: input.repoId,
          remoteRoot,
          direction: input.direction,
          items: {},
        };
        const result = {
          status: "complete" as "complete" | "partial",
          direction: input.direction,
          transferred: 0,
          skipped: 0,
          errors: [] as { path: string; code: string; message: string }[],
        };
        let count = 0;
        const limit = input.maxFiles || 2000;
        const transfer = new TransferService(this.client, this.config);
        const check = async () => {
          await this.client.checkAuth();
          if (this.client.identity !== accountId)
            throw new CloudError("AUTH_CHANGED", "同步期间账号发生变化。");
          if (++count > limit)
            throw new CloudError(
              "SYNC_LIMIT",
              "达到遍历上限，当前结果不完整。",
            );
        };
        const save = async () => {
          await atomicJson(manifestPath, manifest);
          await progress?.({ ...result, scanned: count });
        };
        const error = (p: string, e: unknown) => {
          result.status = "partial";
          result.errors.push({ path: p, ...publicError(e) });
        };
        const down = async (p: string, localRelative: string) => {
          const items = (await this.client.list(input.repoId, p, 0, 20000))
            .items;
          manifest.paths ||= {};
          const mapped = new Map<string, string>();
          const used = new Set(
            Object.values(manifest.paths)
              .filter((local) => path.dirname(local) === (localRelative || "."))
              .map((local) =>
                path.basename(local).normalize("NFC").toLowerCase(),
              ),
          );
          const groups = new Map<string, number>();
          for (const item of items) {
            const name = segment(item.name).normalize("NFC").toLowerCase();
            groups.set(name, (groups.get(name) || 0) + 1);
          }
          for (const item of [...items].sort((a, b) =>
            a.path.localeCompare(b.path),
          )) {
            const previous = manifest.paths[item.path];
            if (previous) {
              mapped.set(item.path, previous);
              continue;
            }
            const base = segment(item.name),
              ext = path.extname(base);
            let candidate = base;
            let n = 0;
            while (
              used.has(candidate.normalize("NFC").toLowerCase()) ||
              (n === 0 &&
                (groups.get(base.normalize("NFC").toLowerCase()) || 0) > 1)
            ) {
              candidate =
                base.slice(0, base.length - ext.length) +
                "__" +
                digest(item.path + ":" + n++).slice(0, 12) +
                ext;
            }
            used.add(candidate.normalize("NFC").toLowerCase());
            const relative = path.join(localRelative, candidate);
            manifest.paths[item.path] = relative;
            mapped.set(item.path, relative);
          }
          await save();
          for (const item of items) {
            await check();
            const relative = mapped.get(item.path)!;
            const target = await guardedPath(root, relative);
            try {
              if (item.type === "dir") {
                await mkdir(target, { recursive: true });
                await down(item.path, relative);
                continue;
              }
              const old = manifest.items[item.path];
              let valid = false;
              if (old && item.id && old.remoteId === item.id) {
                try {
                  valid = (await hashFile(target)) === old.sha256;
                } catch {
                  /* absent */
                }
              }
              if (valid) {
                result.skipped++;
                continue;
              }
              const exists = await lstat(target).catch(() => undefined);
              if (exists && !old && !input.overwrite)
                throw new CloudError(
                  "CONFLICT",
                  "未受清单管理的本地文件已存在，未覆盖。",
                );
              const r = await transfer.download({
                repoId: input.repoId,
                path: item.path,
                outputDir: path.dirname(target),
                filename: path.basename(target),
                overwrite: Boolean(old || input.overwrite),
              });
              manifest.items[item.path] = {
                remoteId: item.id,
                sha256: r.sha256,
                local: relative,
              };
              result.transferred++;
            } catch (e) {
              error(item.path, e);
            }
            await save();
          }
        };
        const up = async (localRelative: string, p: string) => {
          for (const name of await readdir(
            await guardedPath(root, localRelative),
          )) {
            if (name.startsWith(".thu-cloud-sync-")) continue;
            await check();
            const rel = path.join(localRelative, name);
            const local = await guardedPath(root, rel);
            const meta = await lstat(local);
            const dest = remotePath(path.posix.join(p, name));
            try {
              if (meta.isSymbolicLink())
                throw new CloudError("UNSAFE_PATH", "同步不跟随符号链接。");
              if (meta.isDirectory()) {
                const r = await this.client.info(input.repoId, dest);
                if (!r) await this.client.mkdir(input.repoId, dest);
                else if (r.type !== "dir")
                  throw new CloudError("CONFLICT", "远端同名项目不是目录。");
                await up(rel, dest);
                continue;
              }
              if (!meta.isFile())
                throw new CloudError("FILE_LIMIT", "只同步普通文件。");
              const sha256 = await hashFile(local);
              const old = manifest.items[dest];
              const remote = await this.client.info(input.repoId, dest);
              if (
                old &&
                remote?.type === "file" &&
                remote.id &&
                old.sha256 === sha256 &&
                remote.id === old.remoteId
              ) {
                result.skipped++;
                continue;
              }
              const r = await transfer.upload({
                repoId: input.repoId,
                path: dest,
                filePath: local,
                overwrite: input.overwrite,
              });
              if (r.status !== "complete")
                throw new CloudError(
                  "UPLOAD_UNCONFIRMED",
                  `上传未确认；操作 ID ${r.id}，未自动重试。`,
                );
              const after = await this.client.info(input.repoId, dest);
              manifest.items[dest] = {
                sha256,
                remoteId: after?.id,
                local: rel,
              };
              result.transferred++;
            } catch (e) {
              error(dest, e);
            }
            await save();
          }
        };
        try {
          if (input.direction === "download") await down(remoteRoot, "");
          else {
            const remote = await this.client.info(input.repoId, remoteRoot);
            if (!remote || remote.type !== "dir")
              throw new CloudError("NOT_FOUND", "上传同步目标必须是已有目录。");
            await up("", remoteRoot);
          }
        } catch (e) {
          error(remoteRoot, e);
        }
        await save();
        return result;
      },
    );
  }
}
