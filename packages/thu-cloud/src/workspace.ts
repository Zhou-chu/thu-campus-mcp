import path from "node:path";
import { constants } from "node:fs";
import { randomUUID } from "node:crypto";
import { open, lstat, mkdir, chmod, writeFile, rm } from "node:fs/promises";
import { CloudError } from "./types.js";
import type { Config } from "./config.js";
import { remotePath } from "./client.js";
import {
  protectedAccount,
  authenticationFailure,
  type AccountDrive,
} from "./status.js";
import {
  atomicJson,
  readJson,
  digest,
  guardedPath,
  withLock,
} from "./storage.js";
import { TransferService } from "./transfer.js";

export const WORKSPACE_ROOT = "/Agent工作区";
const MARKER = WORKSPACE_ROOT + "/.thu-campus-agent.json";
const UUID = /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i;
const MAX_BYTES = 32 * 1024 * 1024,
  MAX_ARCHIVE_BYTES = 64 * 1024 * 1024,
  MAX_ENTRIES = 1000;
const error = (code: string, message: string, status?: number): never => {
  throw new CloudError(code, message, status);
};
const object = (value: any) =>
  value && typeof value === "object" && !Array.isArray(value);
function accountArgument(value: string) {
  if (!/^[a-f\d]{32}$/.test(value))
    error("INVALID_ARGUMENTS", "accountId必须是预览取得的在线身份摘要。");
}
export function workspaceRelative(value = ".", allowRoot = true) {
  if (
    typeof value !== "string" ||
    !value ||
    value.length > 1024 ||
    value.startsWith("/") ||
    /[\\<>:"|?*\x00-\x1f]/.test(value) ||
    /%(?:2e|2f|5c)/i.test(value)
  )
    error("UNSAFE_PATH", "需要安全的会话相对路径。");
  if (value === "." && allowRoot) return ".";
  const parts = value.split("/");
  if (
    parts.some(
      (p) =>
        !p ||
        p === "." ||
        p === ".." ||
        /[. ]$/.test(p) ||
        /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p),
    )
  )
    error("UNSAFE_PATH", "相对路径不能越界或使用系统保留名称。");
  return parts.join("/");
}
function sessionPath(sessionId: string, relative = ".") {
  if (!UUID.test(sessionId)) error("INVALID_SESSION", "会话ID必须为UUID。");
  const p = workspaceRelative(relative);
  return `${WORKSPACE_ROOT}/sessions/${sessionId}${p === "." ? "" : "/" + p}`;
}
function related(value: unknown) {
  if (typeof value !== "string")
    error("PRIVACY_UNSUPPORTED", "权限或分享元数据缺少路径，不能保证私有。");
  const p = remotePath(value as string).replace(/\/$/, "") || "/";
  return (
    p === "/" ||
    p === WORKSPACE_ROOT ||
    p.startsWith(WORKSPACE_ROOT + "/") ||
    WORKSPACE_ROOT.startsWith(p + "/")
  );
}
interface Binding {
  accountId: string;
  repoId: string;
  workspaceId: string;
  phase: "creating" | "ready";
}
interface Scope {
  accountId: string;
  repoId: string;
  rootPath: string;
}
type Transfers = Pick<TransferService, "read" | "download" | "upload">;

async function snapshot(sourcePath: string, maximum: number) {
  if (!path.isAbsolute(sourcePath))
    error("ABSOLUTE_PATH", "sourcePath必须为内部调用提供的绝对文件路径。");
  let current = path.parse(sourcePath).root;
  for (const segment of path.relative(current, sourcePath).split(path.sep)) {
    current = path.join(current, segment);
    if ((await lstat(current)).isSymbolicLink())
      error("UNSAFE_PATH", "上传源路径不能包含符号链接或联接。");
  }
  const handle = await open(
    sourcePath,
    constants.O_RDONLY | (constants.O_NOFOLLOW || 0),
  );
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.size > maximum)
      error("FILE_LIMIT", "源必须为有界普通文件。");
    const chunks: Buffer[] = [];
    let size = 0;
    for (;;) {
      const buffer = Buffer.alloc(Math.min(65536, maximum + 1 - size));
      const read = await handle.read(buffer, 0, buffer.length, null);
      if (!read.bytesRead) break;
      size += read.bytesRead;
      if (size > maximum) error("FILE_LIMIT", "源文件超过工作区大小上限。");
      chunks.push(buffer.subarray(0, read.bytesRead));
    }
    const after = await handle.stat(),
      entry = await lstat(sourcePath);
    if (
      entry.isSymbolicLink() ||
      entry.ino !== before.ino ||
      entry.dev !== before.dev ||
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs
    )
      error("FILE_CHANGED", "源文件读取期间发生变化，未上传。");
    return Buffer.concat(chunks, size);
  } finally {
    await handle.close();
  }
}

/** Private default-library capability; no arbitrary repo/path/output-directory selection. */
export class CloudWorkspace {
  private transfer: Transfers;
  private archiveTransfer: Transfers;
  private config: Config;
  constructor(
    config: Config,
    private drive: AccountDrive,
    transfer?: Transfers,
  ) {
    this.config = {
      ...config,
      maxBytes: Math.min(config.maxBytes, MAX_ARCHIVE_BYTES),
    };
    this.transfer =
      transfer ||
      new TransferService(drive, {
        ...this.config,
        maxBytes: Math.min(this.config.maxBytes, MAX_BYTES),
      });
    this.archiveTransfer = transfer || new TransferService(drive, this.config);
  }
  private limitFor(relative: string) {
    return Math.min(
      this.config.maxBytes,
      /\.zip$/i.test(relative) ? MAX_ARCHIVE_BYTES : MAX_BYTES,
    );
  }
  private transferFor(relative: string) {
    return /\.zip$/i.test(relative) ? this.archiveTransfer : this.transfer;
  }
  private bindingFile(accountId: string) {
    return path.join(
      this.config.stateDir,
      "workspace-bindings",
      accountId + ".json",
    );
  }
  private async api(endpoint: string) {
    if (this.config.mock || !this.drive.request)
      error("PRIVACY_UNSUPPORTED", "当前后端无法审计真实个人私有云盘。");
    try {
      return await this.drive.request!(endpoint);
    } catch (e) {
      if (
        e instanceof CloudError &&
        ["AUTH_REQUIRED", "AUTH_CHANGED"].includes(e.code)
      )
        throw e;
      throw new CloudError(
        "PRIVACY_UNSUPPORTED",
        "必要权限审计接口不可用，不能保证私有。",
      );
    }
  }
  private async rows(endpoint: string) {
    const rows = await this.api(endpoint);
    if (
      !Array.isArray(rows) ||
      rows.length > 20000 ||
      rows.some((row) => !object(row))
    )
      error("PRIVACY_UNSUPPORTED", "权限列表不是已知完整数组，不能保证私有。");
    return rows as any[];
  }
  private async inspect(expectedAccountId?: string) {
    if (this.config.mock)
      error("PRIVACY_UNSUPPORTED", "模拟云盘不能宣称真实私有存储。");
    const account = await protectedAccount(this.drive);
    if (
      expectedAccountId !== undefined &&
      account.accountId !== expectedAccountId
    )
      error("ACCOUNT_MISMATCH", "当前在线账号与会话绑定身份不符，未自动迁移。");
    const defaultRepo = await this.api("/api2/default-repo/");
    if (!defaultRepo?.exists || !UUID.test(defaultRepo.repo_id))
      error(
        "PRIVACY_UNSUPPORTED",
        "未取得已有个人默认资料库，未创建或选择其他库。",
      );
    const repoId = defaultRepo.repo_id as string;
    const owned = await this.rows("/api2/repos/?type=mine");
    const repo = owned.find((r) => r.id === repoId);
    if (
      !repo ||
      repo.type !== "repo" ||
      repo.owner !== account.identity ||
      repo.encrypted !== false ||
      repo.virtual !== false ||
      repo.permission !== "rw"
    )
      error(
        "NOT_PRIVATE",
        "默认库不是当前本人拥有的非虚拟、未加密可写个人库。",
      );
    const base = `/api2/repos/${repoId}`;
    const [
      publicRepos,
      users,
      groups,
      userACL,
      groupACL,
      downloads,
      uploads,
      folders,
    ] = await Promise.all([
      this.rows("/api2/repos/?type=org"),
      this.rows(base + "/dir/shared_items/?p=%2F&share_type=user"),
      this.rows(base + "/dir/shared_items/?p=%2F&share_type=group"),
      this.rows(base + "/user-folder-perm/"),
      this.rows(base + "/group-folder-perm/"),
      this.rows(base + "/download-shared-links/"),
      this.rows(base + "/upload-shared-links/"),
      this.rows("/api/v2.1/shared-folders/"),
    ]);
    if (publicRepos.some((r) => !UUID.test(r.id)))
      error("PRIVACY_UNSUPPORTED", "公开库列表身份格式未知。");
    if (
      publicRepos.some((r) => r.id === repoId) ||
      users.length ||
      groups.length
    )
      error("NOT_PRIVATE", "默认库被公开或向用户/群组共享，拒绝使用。");
    if (
      [...userACL, ...groupACL].some((r) => related(r.folder_path)) ||
      [...downloads, ...uploads].some((r) => related(r.path))
    )
      error("NOT_PRIVATE", "工作区、祖先或后代存在ACL/分享链接，拒绝使用。");
    for (const folder of folders) {
      if (!UUID.test(folder.repo_id))
        error("PRIVACY_UNSUPPORTED", "文件夹共享缺少资料库身份。");
      if (folder.repo_id === repoId && related(folder.path))
        error("NOT_PRIVATE", "Agent子树存在文件夹共享，拒绝使用。");
    }
    const entry = await this.drive.info(repoId, WORKSPACE_ROOT);
    if (entry) {
      if (entry.type !== "dir")
        error("WORKSPACE_CONFLICT", "Agent工作区目标不是目录。");
      const query = `?p=${encodeURIComponent(WORKSPACE_ROOT)}&share_type=`;
      const targetShares = await Promise.all([
        this.rows(base + "/dir/shared_items/" + query + "user"),
        this.rows(base + "/dir/shared_items/" + query + "group"),
      ]);
      if (targetShares.some((rows) => rows.length))
        error("NOT_PRIVATE", "Agent目录存在共享，拒绝使用。");
    }
    const after = await protectedAccount(this.drive);
    if (after.accountId !== account.accountId)
      error("ACCOUNT_MISMATCH", "隐私审计期间在线账号发生变化。");
    return {
      accountId: account.accountId,
      repoId,
      rootPath: WORKSPACE_ROOT,
      exists: Boolean(entry),
      privacy: {
        verified: true,
        checkedAt: new Date().toISOString(),
        code: "PRIVATE_SCOPE_VERIFIED",
      },
    };
  }
  private async marker(scope: Scope, binding: Binding) {
    const marker = JSON.parse(
      (await this.transfer.read(scope.repoId, MARKER, 16384)).content,
    );
    if (
      marker.version !== 1 ||
      marker.accountId !== scope.accountId ||
      marker.repoId !== scope.repoId ||
      marker.workspaceId !== binding.workspaceId
    )
      error("WORKSPACE_UNBOUND", "远端标记与私有绑定不符，拒绝接管已有数据。");
    const sessions = await this.drive.info(
      scope.repoId,
      WORKSPACE_ROOT + "/sessions",
    );
    if (sessions?.type !== "dir")
      error("WORKSPACE_UNBOUND", "会话根目录缺失，初始化未完成。");
  }
  private async bound(accountId: string) {
    accountArgument(accountId);
    const scope = await this.inspect(accountId);
    const binding = await readJson<Binding>(this.bindingFile(accountId));
    if (
      !scope.exists ||
      !binding ||
      binding.accountId !== accountId ||
      binding.repoId !== scope.repoId ||
      binding.phase !== "ready"
    )
      error("WORKSPACE_UNINITIALIZED", "此在线身份的专用工作区尚未初始化。");
    await this.marker(scope, binding!);
    return scope;
  }
  async status() {
    let preview: Awaited<ReturnType<CloudWorkspace["inspect"]>> | undefined;
    try {
      preview = await this.inspect();
      const binding = await readJson<Binding>(
        this.bindingFile(preview.accountId),
      );
      let state = "uninitialized",
        code = "WORKSPACE_UNINITIALIZED";
      if (
        binding?.accountId === preview.accountId &&
        binding.repoId === preview.repoId &&
        preview.exists
      ) {
        await this.marker(preview, binding);
        if (binding.phase !== "ready")
          return {
            accountId: preview.accountId,
            storage: {
              ...preview,
              state: "unverified",
              code: "WORKSPACE_INIT_UNKNOWN",
              scope: {
                accountId: preview.accountId,
                repoId: preview.repoId,
                rootPath: WORKSPACE_ROOT,
              },
            },
          };
        state = "ready";
        code = "WORKSPACE_READY";
      } else if (preview.exists) code = "WORKSPACE_UNBOUND";
      return {
        accountId: preview.accountId,
        storage: {
          state,
          repoId: preview.repoId,
          rootPath: WORKSPACE_ROOT,
          privacy: preview.privacy,
          scope: {
            accountId: preview.accountId,
            repoId: preview.repoId,
            rootPath: WORKSPACE_ROOT,
          },
          code,
        },
      };
    } catch (e) {
      const code = e instanceof CloudError ? e.code : "UNVERIFIED";
      const auth = authenticationFailure(e);
      return {
        ...(preview ? { accountId: preview.accountId } : {}),
        storage: {
          state:
            auth.state === "login-required" || auth.state === "expired"
              ? "login-required"
              : "unverified",
          rootPath: WORKSPACE_ROOT,
          privacy: {
            verified: false,
            checkedAt: new Date().toISOString(),
            code,
          },
          code,
          message: "未能核验个人私有工作区；未选择共享库或写入云盘。",
        },
      };
    }
  }
  async init(input: { accountId: string; expectedRepoId: string }) {
    accountArgument(input.accountId);
    if (!UUID.test(input.expectedRepoId))
      error("INVALID_REPO", "expectedRepoId必须为预览的默认库UUID。");
    return withLock(
      path.join(this.config.stateDir, "workspace-lock"),
      async () => {
        const scope = await this.inspect(input.accountId);
        if (scope.repoId !== input.expectedRepoId)
          error("REPO_MISMATCH", "默认库与批准预览不符，未创建目录。");
        const file = this.bindingFile(input.accountId),
          previous = await readJson<Binding>(file);
        if (scope.exists) {
          if (
            !previous ||
            previous.accountId !== scope.accountId ||
            previous.repoId !== scope.repoId
          )
            error(
              "WORKSPACE_UNBOUND",
              "同名目录已存在但无本机私有绑定，拒绝接管。",
            );
          await this.marker(scope, previous!);
          if (previous!.phase !== "ready") {
            previous!.phase = "ready";
            await atomicJson(file, previous);
          }
          return this.status();
        }
        if (previous?.phase === "creating")
          error(
            "WORKSPACE_INIT_UNKNOWN",
            "上次初始化状态未知，未重复云盘写入。",
            500,
          );
        const binding: Binding = {
          accountId: scope.accountId,
          repoId: scope.repoId,
          workspaceId: randomUUID(),
          phase: "creating",
        };
        await atomicJson(file, binding);
        const cache = await this.cache(scope.accountId, "initialization");
        const markerFile = path.join(cache, "marker.json");
        try {
          await this.drive.mkdir(scope.repoId, WORKSPACE_ROOT);
          await writeFile(
            markerFile,
            JSON.stringify({
              version: 1,
              accountId: scope.accountId,
              repoId: scope.repoId,
              workspaceId: binding.workspaceId,
            }),
            { mode: 0o600, flag: "wx" },
          );
          const receipt = await this.transfer.upload({
            repoId: scope.repoId,
            path: MARKER,
            filePath: markerFile,
            overwrite: false,
          });
          if (receipt.status !== "complete")
            error("WORKSPACE_INIT_UNKNOWN", "标记写入结果未知，未重投。", 500);
          await this.drive.mkdir(scope.repoId, WORKSPACE_ROOT + "/sessions");
          await this.inspect(scope.accountId);
          await this.marker(scope, binding);
          binding.phase = "ready";
          await atomicJson(file, binding);
        } catch {
          error(
            "WORKSPACE_INIT_UNKNOWN",
            "初始化未完整核验，保留私有绑定与回执；不得盲目重投。",
            500,
          );
        } finally {
          await rm(markerFile, { force: true });
        }
        return this.status();
      },
    );
  }
  private async cache(accountId: string, sessionId: string) {
    const base = path.join(this.config.stateDir, "workspace-cache");
    await mkdir(base, { recursive: true, mode: 0o700 });
    await chmod(base, 0o700);
    const directory = await guardedPath(
      base,
      `${accountId}/${sessionId}/${randomUUID()}`,
    );
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700);
    return directory;
  }
  async list(input: {
    accountId: string;
    sessionId: string;
    path?: string;
    recursive?: boolean;
  }) {
    const relative = workspaceRelative(input.path),
      root = sessionPath(input.sessionId, relative),
      scope = await this.bound(input.accountId);
    const first = await this.drive.info(scope.repoId, root);
    if (!first)
      return {
        accountId: scope.accountId,
        sessionId: input.sessionId,
        path: relative,
        entries: [],
        complete: true,
      };
    if (first.type !== "dir") error("NOT_DIRECTORY", "列目录需要会话内目录。");
    const entries: {
        path: string;
        type: string;
        remoteId?: string;
        size?: number;
      }[] = [],
      queue = [root];
    while (queue.length) {
      const directory = queue.shift()!,
        rows = await this.drive.list(scope.repoId, directory, 0, 20000);
      if (
        rows.nextOffset !== undefined ||
        rows.total !== rows.items.length ||
        rows.items.length + entries.length > MAX_ENTRIES
      )
        error("DIRECTORY_LIMIT", "会话条目过多或不完整，未声称列举完整。");
      for (const row of rows.items) {
        const p = path.posix.relative(sessionPath(input.sessionId), row.path);
        workspaceRelative(p, false);
        if (row.path !== path.posix.join(directory, row.name))
          error("UNSAFE_PATH", "远端目录条目越出声明父目录。");
        entries.push({
          path: p,
          type: row.type,
          remoteId: row.id,
          size: row.size,
        });
        if (input.recursive && row.type === "dir") queue.push(row.path);
      }
    }
    return {
      accountId: scope.accountId,
      sessionId: input.sessionId,
      path: relative,
      entries,
      complete: true,
    };
  }
  async pull(input: { accountId: string; sessionId: string; path: string }) {
    const relative = workspaceRelative(input.path, false),
      remote = sessionPath(input.sessionId, relative),
      scope = await this.bound(input.accountId);
    const before = await this.drive.info(scope.repoId, remote);
    if (before?.type !== "file" || !before.id)
      error("NOT_FOUND", "未找到带明确ID的会话文件。");
    if (before!.size === undefined || before!.size > this.limitFor(relative))
      error("FILE_LIMIT", "远端文件大小未知或超限。");
    const directory = await this.cache(scope.accountId, input.sessionId);
    const downloaded = await this.transferFor(relative).download({
      repoId: scope.repoId,
      path: remote,
      outputDir: directory,
      filename: "content",
      overwrite: false,
    });
    await chmod(downloaded.filePath, 0o600);
    const after = await this.drive.info(scope.repoId, remote);
    if (
      after?.id !== before!.id ||
      (await protectedAccount(this.drive)).accountId !== input.accountId
    ) {
      await rm(downloaded.filePath, { force: true });
      error("FILE_CHANGED", "下载期间远端文件或在线身份变化，未发布缓存。");
    }
    // Readback reconciliation changes only the private journal, never replays a cloud write.
    const reconciledWrite = await withLock(
      path.join(this.config.stateDir, "workspace-lock"),
      async () => {
        const intentFile = path.join(
          this.config.stateDir,
          "workspace-writes",
          scope.accountId,
          digest(remote) + ".json",
        );
        const intent = await readJson<{
          status: string;
          sha256: string;
          requestId: string;
        }>(intentFile);
        if (intent?.status !== "unknown" || intent.sha256 !== downloaded.sha256)
          return false;
        await atomicJson(intentFile, {
          ...intent,
          status: "complete",
          remoteId: before!.id,
          reconciledAt: new Date().toISOString(),
        });
        return true;
      },
    );
    return {
      accountId: scope.accountId,
      sessionId: input.sessionId,
      path: relative,
      reconciledWrite,
      localPath: downloaded.filePath,
      sha256: downloaded.sha256,
      remoteId: before!.id,
      bytes: downloaded.bytes,
    };
  }
  private async parents(repoId: string, remote: string) {
    const parts = path.posix
      .dirname(remote)
      .slice((WORKSPACE_ROOT + "/sessions/").length)
      .split("/");
    let current = WORKSPACE_ROOT + "/sessions";
    for (const part of parts) {
      current += "/" + part;
      const info = await this.drive.info(repoId, current);
      if (info && info.type !== "dir") error("CONFLICT", "父路径不是目录。");
      if (!info) await this.drive.mkdir(repoId, current);
    }
  }
  async push(input: {
    accountId: string;
    sessionId: string;
    path: string;
    sourcePath: string;
    overwrite?: boolean;
    expectedRemoteId?: string;
  }) {
    const relative = workspaceRelative(input.path, false),
      remote = sessionPath(input.sessionId, relative);
    const bytes = await snapshot(input.sourcePath, this.limitFor(relative)),
      sha256 = digest(bytes);
    return withLock(
      path.join(this.config.stateDir, "workspace-lock"),
      async () => {
        const scope = await this.bound(input.accountId),
          intentFile = path.join(
            this.config.stateDir,
            "workspace-writes",
            scope.accountId,
            digest(remote) + ".json",
          );
        const old = await readJson<{ status: string }>(intentFile);
        if (old?.status === "unknown")
          error(
            "WORKSPACE_WRITE_UNKNOWN",
            "此路径上次写入未知，禁止自动重投；请核验原回执。",
            500,
          );
        const before = await this.drive
          .info(scope.repoId, remote)
          .catch((cause: unknown) => {
            // info lists dirname(remote): a new session/parent can legitimately return HTTP 404.
            // Normalize only that explicit API absence, never auth, network or unclassified failures.
            if (
              cause instanceof CloudError &&
              cause.code === "NOT_FOUND" &&
              cause.status === 404
            )
              return undefined;
            throw cause;
          });
        if (
          before &&
          (before.type !== "file" ||
            !input.overwrite ||
            !input.expectedRemoteId ||
            before.id !== input.expectedRemoteId)
        )
          error(
            "REMOTE_CONFLICT",
            "远端已存在，必须显式覆盖并匹配预期remoteId。",
          );
        if (!before && input.expectedRemoteId)
          error("REMOTE_CONFLICT", "预期远端文件已不存在，未写入。");
        const directory = await this.cache(scope.accountId, input.sessionId),
          staged = path.join(directory, "source");
        await writeFile(staged, bytes, { mode: 0o600, flag: "wx" });
        const requestId = randomUUID();
        await atomicJson(intentFile, {
          status: "unknown",
          requestId,
          sha256,
          remote,
        });
        try {
          await this.parents(scope.repoId, remote);
          if (
            (await protectedAccount(this.drive)).accountId !== input.accountId
          )
            error("ACCOUNT_MISMATCH", "写入前在线身份变化。");
          const receipt = await this.transferFor(relative).upload({
            repoId: scope.repoId,
            path: remote,
            filePath: staged,
            overwrite: Boolean(input.overwrite),
            requestId,
          });
          if (receipt.status !== "complete")
            error(
              "WORKSPACE_WRITE_UNKNOWN",
              "云盘写入未完整确认，未重投。",
              500,
            );
          const after = await this.drive.info(scope.repoId, remote);
          if (
            after?.type !== "file" ||
            !after.id ||
            after.size !== bytes.length ||
            (await protectedAccount(this.drive)).accountId !== input.accountId
          )
            error(
              "WORKSPACE_WRITE_UNKNOWN",
              "写后文件或账号无法核验，未重投。",
              500,
            );
          await atomicJson(intentFile, {
            status: "complete",
            requestId,
            sha256,
            remoteId: after!.id,
          });
          return {
            accountId: scope.accountId,
            sessionId: input.sessionId,
            path: relative,
            remoteId: after!.id,
            sha256,
            bytes: bytes.length,
            operationId: requestId,
            verification: "server-metadata",
            atomicReplace: false,
          };
        } catch {
          error(
            "WORKSPACE_WRITE_UNKNOWN",
            "写入结果未知，保留回执且禁止自动重投。",
            500,
          );
        } finally {
          await rm(staged, { force: true });
        }
      },
    );
  }
}
