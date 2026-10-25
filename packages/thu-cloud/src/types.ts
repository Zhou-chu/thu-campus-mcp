export class CloudError extends Error {
  constructor(
    public code: string,
    message: string,
    public status?: number,
  ) {
    super(message);
    this.name = "CloudError";
  }
}
export function publicError(e: unknown) {
  const system = e as NodeJS.ErrnoException | undefined;
  const systemCode = [
    "EACCES",
    "EPERM",
    "EBUSY",
    "ENOENT",
    "ENOSPC",
    "EIO",
    "EEXIST",
    "EMFILE",
    "ENFILE",
    "ENOTDIR",
    "EISDIR",
    "ELOOP",
    "ECONNRESET",
    "ETIMEDOUT",
  ].includes(system?.code || "")
    ? system?.code
    : undefined;
  const syscall = [
    "rename",
    "unlink",
    "rmdir",
    "mkdir",
    "open",
    "write",
    "read",
    "stat",
    "lstat",
    "connect",
  ].includes(system?.syscall || "")
    ? system?.syscall
    : undefined;
  return e instanceof CloudError
    ? { code: e.code, message: e.message }
    : {
        code: "OPERATION_FAILED",
        message:
          "操作失败；请检查网络、会话与本地路径。诊断不包含凭据或原始响应。",
        systemCode,
        syscall,
      };
}
export interface Library {
  id: string;
  name: string;
  permission: string;
  encrypted: boolean;
  size?: number;
}
export interface Entry {
  name: string;
  path: string;
  type: "file" | "dir";
  id?: string;
  size?: number;
  mtime?: number;
  permission?: string;
}
export interface Directory {
  items: Entry[];
  total: number;
  offset: number;
  nextOffset?: number;
}
export interface Drive {
  transferRequest?(url: string, init?: RequestInit): Promise<Response>;
  identity: string;
  checkAuth(): Promise<void>;
  libraries(): Promise<Library[]>;
  resolveRepo(repoId?: string, write?: boolean): Promise<Library>;
  list(
    repoId: string,
    p: string,
    offset?: number,
    limit?: number,
  ): Promise<Directory>;
  info(repoId: string, p: string): Promise<Entry | undefined>;
  search(query: string, repoId?: string, limit?: number): Promise<unknown>;
  downloadLink(repoId: string, p: string): Promise<string>;
  uploadLink(repoId: string, p: string): Promise<string>;
  mkdir(repoId: string, p: string): Promise<unknown>;
  rename(repoId: string, p: string, name: string): Promise<unknown>;
  moveCopy(
    action: "move" | "copy",
    repoId: string,
    p: string,
    dstRepo: string,
    dstDir: string,
  ): Promise<unknown>;
  share(
    repoId: string,
    p: string,
    options: { password?: string; expireDays?: number },
  ): Promise<unknown>;
}
