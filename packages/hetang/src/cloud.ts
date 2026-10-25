import path from "node:path";
import { copyFile, mkdir, rm, chmod } from "node:fs/promises";
import { constants } from "node:fs";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { RainError } from "./types.js";
import type { RainClient } from "./client.js";
import type { Config } from "./config.js";
import {
  readJson,
  atomicJson,
  guardedPath,
  safeSegment,
  digest,
  withLock,
} from "./storage.js";
import {
  verifyManifestFiles,
  hashFile,
  type DownloadManifest,
} from "./resources.js";
import { stableId } from "./jobs.js";
export class CloudBridge {
  private mcp?: Client;
  private lease: any;
  accountId = "";
  repoId = "";
  constructor(
    private cfg: Config,
    private guard: () => Promise<boolean> = async () => true,
  ) {}
  private async ensureActive() {
    if (!(await this.guard()))
      throw new RainError("CANCELLED", "荷塘任务已停止，未继续云盘写入。");
  }
  async open(repoId?: string) {
    if (this.cfg.mock) {
      this.accountId = "mock-cloud-account";
      this.repoId = repoId || "11111111-1111-4111-8111-111111111111";
      return;
    }
    const directory = path.dirname(this.cfg.cloudCli);
    const [{ CloudClient }, { loadConfig }] = await Promise.all([
      import(pathToFileURL(path.join(directory, "client.js")).href),
      import(pathToFileURL(path.join(directory, "config.js")).href),
    ]);
    this.lease = new CloudClient(loadConfig());
    await this.lease.checkAuth();
    this.mcp = new Client({ name: "hetang-cloud-archive", version: "0.1" });
    await this.mcp.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [this.cfg.cloudCli, "serve"],
        env: { ...process.env, THU_CLOUD_MOCK: "0" },
        stderr: "pipe",
      }),
    );
    const status: any = await this.call("cloud_status", {});
    if (!status.authentication?.configured || status.mode !== "real")
      throw new RainError(
        "CLOUD_AUTH_REQUIRED",
        "请先登录现有 thu-cloud MCP。",
      );
    this.accountId = status.authentication.accountId;
    const libraries: any = await this.call("cloud_list_libraries", {});
    if (repoId) {
      if (
        !libraries.libraries.some(
          (r: any) =>
            r.id === repoId &&
            !r.encrypted &&
            String(r.permission).includes("w"),
        )
      )
        throw new RainError("CLOUD_SCOPE", "指定云盘资料库不可写或已加密。");
      this.repoId = repoId;
      return;
    }
    const raw = await this.lease.request("/api2/repos/");
    const owned = raw.filter(
      (r: any) =>
        r.type === "repo" && !r.encrypted && String(r.permission).includes("w"),
    );
    if (!owned.length)
      throw new RainError(
        "CLOUD_TARGET_REQUIRED",
        "没有明确的个人可写资料库；请指定 cloudRepoId，不会选择共享资料库兜底。",
      );
    this.repoId = owned[0].id;
  }
  async close() {
    await this.mcp?.close();
  }
  async check() {
    await this.ensureActive();
    if (this.cfg.mock) return;
    await this.lease.checkAuth();
    const s: any = await this.call("cloud_status", {});
    if (s.authentication?.accountId !== this.accountId)
      throw new RainError("CLOUD_AUTH_CHANGED", "云盘账号发生变化，归档停止。");
  }
  async call(name: string, args: Record<string, unknown>): Promise<any> {
    if (!this.mcp)
      throw new RainError("CLOUD_UNAVAILABLE", "云盘 MCP 尚未连接。");
    await this.lease.checkAuth();
    if (name === "cloud_create_directory" || name === "cloud_upload_file")
      await this.ensureActive();
    const r = await this.mcp.callTool({ name, arguments: args }, undefined, {
      timeout: name === "cloud_upload_file" ? 300000 : 120000,
    });
    const d: any = r.structuredContent;
    if (r.isError)
      throw new RainError(
        d?.code || "CLOUD_ERROR",
        d?.message || "云盘工具调用失败。",
      );
    return d;
  }
  async info(p: string): Promise<any> {
    if (this.cfg.mock) return;
    let offset = 0;
    while (true) {
      const r = await this.call("cloud_list_directory", {
        repoId: this.repoId,
        path: path.posix.dirname(p),
        offset,
        limit: 1000,
      });
      const found = r.items.find((e: any) => e.name === path.posix.basename(p));
      if (found) return found;
      if (r.nextOffset === undefined) return;
      offset = r.nextOffset;
    }
  }
  async mkdirs(p: string) {
    await this.ensureActive();
    if (
      !p.startsWith("/") ||
      p.includes("\\") ||
      p
        .split("/")
        .some(
          (x) =>
            x === ".." ||
            x === "." ||
            (!x && p !== "/" && x !== p.split("/")[0]),
        )
    )
      throw new RainError("CLOUD_PATH", "云盘根路径无效。");
    let current = "";
    for (const segment of p.split("/").filter(Boolean)) {
      current += "/" + segment;
      if (this.cfg.mock) continue;
      await this.check();
      const present = await this.info(current);
      if (present) {
        if (present.type !== "dir")
          throw new RainError("CLOUD_CONFLICT", "云盘路径存在同名文件。");
        continue;
      }
      const r = await this.call("cloud_create_directory", {
        repoId: this.repoId,
        path: current,
        requestId: stableId(this.accountId + ":mkdir:" + this.repoId + current),
      });
      if (r.status !== "complete")
        throw new RainError(
          "CLOUD_UNKNOWN",
          `云盘目录未确认，操作 ID ${r.id}。`,
        );
    }
  }
  async upload(file: string, p: string, sha256: string) {
    await this.check();
    if (this.cfg.mock)
      return { operationId: stableId(p + sha256), remoteId: sha256 };
    const r = await this.call("cloud_upload_file", {
      repoId: this.repoId,
      path: p,
      filePath: file,
      overwrite: false,
      requestId: stableId(
        this.accountId + ":upload:" + this.repoId + p + sha256,
      ),
    });
    if (r.status !== "complete")
      throw new RainError(
        "CLOUD_UNKNOWN",
        `云盘上传未确认，操作 ID ${r.id}，未自动重试。`,
      );
    return { operationId: r.id, remoteId: (await this.info(p))?.id };
  }
}
export async function archiveManifest(
  client: RainClient,
  cfg: Config,
  manifestPath: string,
  options: any,
  check: () => Promise<boolean>,
  progress: (r: unknown) => Promise<void>,
) {
  if (!path.isAbsolute(manifestPath))
    throw new RainError("UNSAFE_PATH", "归档清单必须使用绝对路径。");
  if (path.basename(manifestPath) !== ".hetang-manifest.json")
    throw new RainError("INVALID_MANIFEST", "资源清单名称无效。");
  return withLock(
    path.join(
      cfg.stateDir,
      "download-locks",
      digest(path.dirname(manifestPath)),
    ),
    async () => {
      const manifest = await readJson<DownloadManifest>(manifestPath);
      if (
        !manifest ||
        path.basename(manifestPath) !== ".hetang-manifest.json" ||
        path.resolve(path.dirname(manifestPath)) !== path.resolve(manifest.root)
      )
        throw new RainError(
          "INVALID_MANIFEST",
          "不是本项目下载任务生成的资源清单。",
        );
      await client.checkAuth();
      const approved = await readJson<{
        accountId: string;
        manifestPath: string;
        root: string;
        filesDigest: string;
      }>(path.join(cfg.stateDir, "manifests", digest(manifestPath) + ".json"));
      if (
        !approved ||
        approved.accountId !== client.identity ||
        approved.manifestPath !== manifestPath ||
        approved.root !== manifest.root ||
        approved.filesDigest !== digest(JSON.stringify(manifest.files))
      )
        throw new RainError(
          "UNAPPROVED_MANIFEST",
          "清单未登记为当前账号的下载产物。",
        );
      const files = await verifyManifestFiles(manifest, client.identity);
      if (!files.length)
        throw new RainError(
          "NO_FILES",
          "资源清单中没有已验证文件，未创建云盘目录。",
        );
      const bridge = new CloudBridge(cfg, check);
      let uploaded = 0,
        skipped = 0;
      const errors: any[] = [];
      try {
        await bridge.open(options.cloudRepoId);
        const cloudBase = String(options.cloudRoot || "/荷塘雨课堂").replace(
          /\/+$/,
          "",
        );
        const root =
          cloudBase +
          "/" +
          safeSegment(manifest.courseName) +
          "__" +
          digest(manifest.courseId || "unspecified").slice(0, 10) +
          "/" +
          safeSegment(manifest.lessonTitle) +
          "__" +
          digest(manifest.lessonId).slice(0, 12);
        if (
          manifest.cloud &&
          (manifest.cloud.accountId !== bridge.accountId ||
            manifest.cloud.repoId !== bridge.repoId ||
            manifest.cloud.root !== root)
        )
          throw new RainError(
            "CLOUD_TARGET_CHANGED",
            "此清单已有另一云盘归档目标，未自动切换。",
          );
        manifest.cloud ||= {
          repoId: bridge.repoId,
          root,
          accountId: bridge.accountId,
          files: {},
        };
        if (!(await check()))
          throw new RainError("CANCELLED", "归档任务已停止。");
        await bridge.mkdirs(root);
        for (const f of files) {
          if (!(await check()))
            throw new RainError("CANCELLED", "归档任务停止。");
          try {
            await bridge.check();
            const remote = root + "/" + f.relative.split(path.sep).join("/");
            await bridge.mkdirs(path.posix.dirname(remote));
            const existing = await bridge.info(remote);
            const saved = manifest.cloud.files[f.relative];
            if (
              saved &&
              saved.sha256 === f.sha256 &&
              (cfg.mock ||
                (existing?.type === "file" &&
                  existing?.id &&
                  existing.id === saved.remoteId))
            ) {
              skipped++;
              continue;
            }
            if (existing)
              throw new RainError(
                "CLOUD_CONFLICT",
                "云盘目标已有未经当前清单确认的同名文件，未覆盖。",
              );
            if (!(await check()))
              throw new RainError("CANCELLED", "归档任务已停止，未上传。");
            const snapshotDir = await guardedPath(
              cfg.stateDir,
              "archive-snapshots",
            );
            await mkdir(snapshotDir, { recursive: true });
            const snapshot = await guardedPath(
              snapshotDir,
              randomUUID() + ".bin",
            );
            let r: { operationId: string; remoteId?: string };
            try {
              await copyFile(f.filePath, snapshot, constants.COPYFILE_EXCL);
              await chmod(snapshot, 0o600);
              if ((await hashFile(snapshot)) !== f.sha256)
                throw new RainError(
                  "MANIFEST_CHANGED",
                  "上传前文件内容已改变，未发送。",
                );
              if (!(await check()))
                throw new RainError("CANCELLED", "归档任务已停止，未上传。");
              r = await bridge.upload(snapshot, remote, f.sha256);
            } finally {
              await rm(snapshot, { force: true }).catch(() => {});
            }
            manifest.cloud.files[f.relative] = { sha256: f.sha256, ...r };
            uploaded++;
            await atomicJson(manifestPath, manifest);
            await progress({
              kind: "archive-progress",
              lessonId: manifest.lessonId,
              uploaded,
              skipped,
            });
          } catch (e) {
            const { publicError } = await import("./types.js");
            errors.push({ relative: f.relative, ...publicError(e) });
            if (
              e instanceof RainError &&
              ["AUTH_CHANGED", "CLOUD_AUTH_CHANGED", "CANCELLED"].includes(
                e.code,
              )
            )
              break;
          }
        }
        await atomicJson(manifestPath, manifest);
        return {
          status: errors.length ? ("partial" as const) : ("complete" as const),
          repoId: bridge.repoId,
          cloudRoot: root,
          uploaded,
          skipped,
          errors,
        };
      } finally {
        await bridge.close();
      }
    },
  );
}
