import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { openAsBlob, createReadStream } from "node:fs";
import { open, lstat, mkdir, rename, link, rm } from "node:fs/promises";
import { CloudError, type Drive } from "./types.js";
import type { Config } from "./config.js";
import { trustedUrl, remotePath, bareName } from "./client.js";
import { guardedPath, safeSegment, withLock } from "./storage.js";
import { Operations } from "./operations.js";
export async function hashFile(file: string) {
  const h = createHash("sha256");
  for await (const b of createReadStream(file)) h.update(b);
  return h.digest("hex");
}
export interface DownloadInput {
  repoId: string;
  path: string;
  outputDir: string;
  filename?: string;
  overwrite?: boolean;
}
export interface UploadInput {
  repoId: string;
  path: string;
  filePath: string;
  overwrite?: boolean;
  requestId?: string;
}
export class TransferService {
  constructor(
    private client: Drive,
    private config: Config,
  ) {}
  private async receive<T>(
    url: string,
    consume: (b: Uint8Array) => Promise<void>,
    maximum: number,
  ): Promise<number> {
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const reset = () => {
      clearTimeout(timer);
      timer = setTimeout(() => abort.abort(), this.config.timeoutMs);
    };
    reset();
    try {
      let current = trustedUrl(url).toString();
      let response: Response | undefined;
      for (let n = 0; n < 5; n++) {
        await this.client.checkAuth();
        if (
          /^\/(?:accounts\/login|login|saml2|shib|oauth)/i.test(
            new URL(current).pathname,
          )
        )
          throw new CloudError("INVALID_DOWNLOAD", "下载转向登录页面。");
        response = await (
          this.client.transferRequest?.bind(this.client) || fetch
        )(current, { redirect: "manual", signal: abort.signal });
        if (response.status >= 300 && response.status < 400) {
          const location = response.headers.get("location");
          await response.body?.cancel();
          if (!location)
            throw new CloudError("UNSAFE_REDIRECT", "下载重定向没有地址。");
          current = trustedUrl(
            new URL(location, current).toString(),
          ).toString();
          continue;
        }
        break;
      }
      if (!response?.ok || !response.body)
        throw new CloudError(
          "TRANSFER_HTTP",
          "下载未成功，原文件保持不变。",
          response?.status,
        );
      const type = response.headers.get("content-type") || "";
      const declared = response.headers.get("content-length");
      const length = declared === null ? undefined : Number(declared);
      if (
        length !== undefined &&
        (!Number.isFinite(length) || length < 0 || length > maximum)
      )
        throw new CloudError("FILE_LIMIT", "下载声明大小无效或超出限制。");
      const reader = response.body.getReader();
      let total = 0;
      let head = new Uint8Array();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          reset();
          total += value.length;
          if (total > maximum)
            throw new CloudError("FILE_LIMIT", "文件超出大小上限。");
          if (head.length < 8192) {
            const joined = new Uint8Array(
              Math.min(8192, head.length + value.length),
            );
            joined.set(head);
            joined.set(
              value.subarray(0, joined.length - head.length),
              head.length,
            );
            head = joined;
          }
          await consume(value);
        }
        const text = new TextDecoder().decode(head);
        if (
          /<input[^>]+type=["']?password/i.test(text) &&
          /id\.tsinghua\.edu\.cn|csrfmiddlewaretoken|seahub|统一身份|(?:action|id|class)=["'][^"']*login/i.test(
            text,
          )
        )
          throw new CloudError(
            "INVALID_DOWNLOAD",
            "下载返回登录页面，未保存为文件。",
          );
        if (length !== undefined && total !== length)
          throw new CloudError("DOWNLOAD_SIZE", "下载实际大小与声明不一致。");
        await this.client.checkAuth();
        return total;
      } finally {
        await reader.cancel().catch(() => {});
      }
    } finally {
      clearTimeout(timer!);
      abort.abort();
    }
  }
  async read(repoId: string, p: string, maxBytes = 262144) {
    const meta = await this.client.info(repoId, p);
    if (!meta || meta.type !== "file")
      throw new CloudError("NOT_FOUND", "没有找到文件。");
    if (meta.size !== undefined && meta.size > maxBytes)
      throw new CloudError("FILE_LIMIT", "文件过大，请使用下载工具。");
    const parts: Uint8Array[] = [];
    const received = await this.receive(
      await this.client.downloadLink(repoId, p),
      async (b) => {
        parts.push(b);
      },
      maxBytes,
    );
    if (meta.size !== undefined && received !== meta.size)
      throw new CloudError(
        "DOWNLOAD_SIZE",
        "文本实际大小与文件元数据不一致，未返回不完整内容。",
      );
    try {
      return {
        path: p,
        content: new TextDecoder("utf-8", { fatal: true }).decode(
          Buffer.concat(parts),
        ),
        encoding: "utf-8",
        complete: true,
      };
    } catch {
      throw new CloudError(
        "BINARY_FILE",
        "不是有效 UTF-8 文本，请下载后使用对应文件工具读取。",
      );
    }
  }
  async download(input: DownloadInput) {
    if (!path.isAbsolute(input.outputDir))
      throw new CloudError("ABSOLUTE_PATH", "下载目录必须为绝对路径。");
    const p = remotePath(input.path);
    const meta = await this.client.info(input.repoId, p);
    if (!meta || meta.type !== "file")
      throw new CloudError("NOT_FOUND", "没有找到要下载的文件。");
    if (
      input.filename &&
      (/[<>:"/\\|?*\x00-\x1f]/.test(input.filename) ||
        /[. ]$/.test(input.filename) ||
        /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(input.filename))
    )
      throw new CloudError(
        "UNSAFE_PATH",
        "本地文件名包含 Windows 禁用字符、保留名或尾随空格/点。",
      );
    const name = input.filename
      ? bareName(input.filename)
      : safeSegment(path.posix.basename(p));
    const target = await guardedPath(input.outputDir, name);
    return withLock(
      path.join(
        this.config.stateDir,
        "download-locks",
        createHash("sha256").update(target.toLowerCase()).digest("hex"),
      ),
      async () => {
        const current = await lstat(target).catch((e) => {
          if (e.code !== "ENOENT") throw e;
          return undefined;
        });
        if (current && (!current.isFile() || !input.overwrite))
          throw new CloudError(
            "CONFLICT",
            "本地文件已存在，覆盖需要显式设置 overwrite。",
          );
        await mkdir(path.dirname(target), { recursive: true });
        const tmp = target + "." + randomUUID() + ".tmp";
        const handle = await open(tmp, "wx");
        const h = createHash("sha256");
        let closed = false;
        try {
          const bytes = await this.receive(
            await this.client.downloadLink(input.repoId, p),
            async (b) => {
              let at = 0;
              while (at < b.length) {
                const r = await handle.write(b, at, b.length - at);
                if (!r.bytesWritten)
                  throw new CloudError("LOCAL_WRITE", "本地写入未完成。");
                at += r.bytesWritten;
              }
              h.update(b);
            },
            this.config.maxBytes,
          );
          if (meta.size !== undefined && meta.size !== bytes)
            throw new CloudError(
              "DOWNLOAD_SIZE",
              "实际大小与文件元数据不一致。",
            );
          await handle.close();
          closed = true;
          await guardedPath(input.outputDir, name);
          if (input.overwrite) await rename(tmp, target);
          else {
            await link(tmp, target);
            await rm(tmp);
          }
          return {
            filePath: target,
            bytes,
            sha256: h.digest("hex"),
            path: p,
            verification: "downloaded-bytes",
          };
        } finally {
          if (!closed) await handle.close();
          await rm(tmp, { force: true });
        }
      },
    );
  }
  async upload(input: UploadInput) {
    if (!path.isAbsolute(input.filePath))
      throw new CloudError("ABSOLUTE_PATH", "上传文件必须使用本机绝对路径。");
    const stat = await lstat(input.filePath);
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      stat.size > this.config.maxBytes
    )
      throw new CloudError("FILE_LIMIT", "上传必须为普通文件且大小在限制内。");
    const p = remotePath(input.path);
    const sha256 = await hashFile(input.filePath);
    await this.client.resolveRepo(input.repoId, true);
    const summary = {
      repoId: input.repoId,
      path: p,
      filePath: input.filePath,
      bytes: stat.size,
      sha256,
      overwrite: Boolean(input.overwrite),
    };
    const operations = new Operations(this.client, this.config);
    if (input.requestId) {
      try {
        return await operations.get(input.requestId).then(async (old) => {
          if (JSON.stringify(old.summary) !== JSON.stringify(summary))
            throw new CloudError(
              "REQUEST_CONFLICT",
              "操作 ID 已绑定其他参数。",
            );
          return old;
        });
      } catch (e) {
        if (!(e instanceof CloudError) || e.code !== "NOT_FOUND") throw e;
      }
    }
    const existing = await this.client.info(input.repoId, p);
    if (existing && !input.overwrite)
      throw new CloudError(
        "CONFLICT",
        "云盘已有同名项目，覆盖需要显式设置 overwrite。",
      );
    if (existing?.type === "dir")
      throw new CloudError("CONFLICT", "目标是目录。");
    const upload = trustedUrl(
      await this.client.uploadLink(input.repoId, path.posix.dirname(p)),
    );
    upload.searchParams.set("ret-json", "1");
    return operations.run(
      "upload",
      summary,
      async () => {
        if ((await hashFile(input.filePath)) !== sha256)
          throw new CloudError(
            "FILE_CHANGED",
            "文件在准备后发生变化，未上传。",
          );
        const data = new FormData();
        data.append("parent_dir", path.posix.dirname(p));
        data.append("replace", input.overwrite ? "1" : "0");
        data.append(
          "file",
          await openAsBlob(input.filePath),
          path.posix.basename(p),
        );
        await this.client.checkAuth();
        const r = await (
          this.client.transferRequest?.bind(this.client) || fetch
        )(upload.toString(), {
          method: "POST",
          body: data,
          redirect: "manual",
          signal: AbortSignal.timeout(Math.max(this.config.timeoutMs, 300000)),
        });
        if (r.status >= 300 && r.status < 400) {
          await r.body?.cancel();
          throw new CloudError(
            "UPLOAD_UNKNOWN",
            "上传出现重定向，未重试。",
            500,
          );
        }
        if (!r.ok) {
          await r.body?.cancel();
          throw new CloudError(
            "UPLOAD_REJECTED",
            `上传响应 HTTP ${r.status}。`,
            r.status,
          );
        }
        let uploaded: any;
        try {
          uploaded = await r.json();
        } catch {
          throw new CloudError(
            "VERIFY_UNKNOWN",
            "上传已响应，但返回信息无法验证；未重试。",
            500,
          );
        }
        const row =
          Array.isArray(uploaded) && uploaded.length === 1
            ? uploaded[0]
            : undefined;
        if (
          !row ||
          row.name !== path.posix.basename(p) ||
          row.size !== stat.size
        )
          throw new CloudError(
            "UPLOAD_RENAMED",
            "上传后名称或大小不符，可能发生同名冲突改名；请检查目录，未重试。",
            500,
          );
        const after = await this.client.info(input.repoId, p);
        if (
          !after ||
          after.type !== "file" ||
          after.size !== stat.size ||
          (row.id && after.id !== row.id)
        )
          throw new CloudError(
            "VERIFY_UNKNOWN",
            "上传已响应，但文件名称/大小无法回读确认。",
            500,
          );
        return {
          repoId: input.repoId,
          path: p,
          bytes: stat.size,
          localSha256: sha256,
          verification: "server-metadata",
          notice: "已核对名称及大小；未声称核验远端文件哈希。",
        };
      },
      input.requestId,
    );
  }
}
