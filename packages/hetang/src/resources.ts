import path from "node:path";
import { lookup } from "node:dns/promises";
import { request as httpsRequest } from "node:https";
import { Readable } from "node:stream";
import { isIP } from "node:net";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { open, lstat, link, rm, readFile, mkdir } from "node:fs/promises";
import { PDFDocument } from "pdf-lib";
import { RainError, publicError, type Resource } from "./types.js";
import type { Config } from "./config.js";
import type { RainClient } from "./client.js";
import type { Job } from "./jobs.js";
import {
  digest,
  safeSegment,
  guardedPath,
  atomicJson,
  readJson,
  atomicWrite,
  withLock,
} from "./storage.js";
type Address = { address: string; family: number };
type Resolver = (host: string) => Promise<Address[]>;
const dnsCache = new Map<string, { until: number; addresses: Address[] }>();
function fakeAddress(address: string) {
  return /^198\.(?:18|19)\./.test(address);
}
export async function resolveAssetAddresses(
  host: string,
  options: { lookup?: Resolver; fetcher?: typeof fetch } = {},
): Promise<Address[]> {
  const cached = dnsCache.get(host);
  if (!options.lookup && cached && cached.until > Date.now())
    return cached.addresses;
  const rows = await (
    options.lookup ||
    ((name: string) => lookup(name, { all: true, verbatim: true }))
  )(host);
  if (!rows.some((a) => fakeAddress(a.address))) return rows;
  if (rows.some((a) => !publicAddress(a.address) && !fakeAddress(a.address)))
    throw new RainError("UNSAFE_ASSET", "DNS 混有私网目标，已拒绝。");
  const endpoint = new URL("https://cloudflare-dns.com/dns-query");
  endpoint.searchParams.set("name", host);
  endpoint.searchParams.set("type", "A");
  const response = await (options.fetcher || fetch)(endpoint, {
    headers: { Accept: "application/dns-json" },
    redirect: "manual",
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok)
    throw new RainError(
      "ASSET_DNS",
      "本机代理返回 Fake-IP，公网 DNS 查询失败。",
    );
  const json: any = await response.json();
  const resolved: Address[] = (json.Answer || [])
    .filter((r: any) => r.type === 1 && typeof r.data === "string")
    .map((r: any) => ({ address: r.data, family: 4 }));
  if (
    json.Status !== 0 ||
    !resolved.length ||
    resolved.some((a) => !publicAddress(a.address))
  )
    throw new RainError("UNSAFE_ASSET", "公网 DNS 未返回可验证的公网目标。");
  if (!options.lookup)
    dnsCache.set(host, { until: Date.now() + 60000, addresses: resolved });
  return resolved;
}
const resolvePublic: Resolver = (host) => resolveAssetAddresses(host);
function publicAddress(address: string) {
  if (isIP(address) === 4) {
    const [a, b] = address.split(".").map(Number);
    return !(
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && [0, 168].includes(b)) ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 198 && [18, 19].includes(b)) ||
      a >= 224
    );
  }
  if (isIP(address) === 6) {
    const first = parseInt(address.split(":")[0], 16);
    return (
      (first & 0xe000) === 0x2000 &&
      !address.toLowerCase().startsWith("2001:db8:")
    );
  }
  return false;
}
export async function validateAssetUrl(
  value: string,
  resolve: Resolver = resolvePublic,
) {
  let u: URL;
  try {
    u = new URL(value);
  } catch {
    throw new RainError("UNSAFE_ASSET", "无效资源地址。");
  }
  const host = u.hostname.toLowerCase();
  if (
    u.protocol !== "https:" ||
    u.username ||
    u.password ||
    (u.port && u.port !== "443") ||
    !["yuketang.cn", "xuetangx.com", "xuetangx.com.cn", "aliyuncs.com"].some(
      (s) => host === s || host.endsWith("." + s),
    )
  )
    throw new RainError(
      "UNSAFE_ASSET",
      "资源地址不在允许的雨课堂 CDN 域名中。",
    );
  const addresses = await resolve(host);
  if (!addresses.length || addresses.some((a) => !publicAddress(a.address)))
    throw new RainError("UNSAFE_ASSET", "资源地址指向本地或私网，已拒绝。");
  return u;
}
async function pinnedFetch(
  u: URL,
  addresses: Address[],
  signal: AbortSignal,
): Promise<Response> {
  return new Promise((resolve, reject) => {
    const req = httpsRequest(
      u,
      {
        method: "GET",
        signal,
        headers: { Accept: "*/*" },
        lookup: ((_host: any, options: any, callback: any) => {
          if (options?.all) callback(null, addresses);
          else callback(null, addresses[0].address, addresses[0].family);
        }) as any,
      },
      (res) => {
        const headers = new Headers();
        for (const name of ["content-type", "content-length", "location"]) {
          const v = res.headers[name];
          if (v) headers.set(name, Array.isArray(v) ? v[0] : v);
        }
        resolve(
          new Response(Readable.toWeb(res) as ReadableStream, {
            status: res.statusCode || 500,
            headers,
          }),
        );
      },
    );
    req.on("error", reject);
    req.end();
  });
}
export async function hashFile(file: string) {
  const h = createHash("sha256");
  for await (const b of createReadStream(file)) h.update(b);
  return h.digest("hex");
}
export async function downloadResource(
  resource: Resource,
  target: string,
  cfg: Config,
  check: () => Promise<boolean>,
  options: { resolve?: Resolver; fetcher?: typeof fetch } = {},
) {
  const dir = path.dirname(target);
  await mkdir(dir, { recursive: true });
  target = await guardedPath(dir, path.basename(target));
  if (await lstat(target).catch(() => undefined))
    throw new RainError("LOCAL_CONFLICT", "下载目标已存在，未覆盖。");
  const temp = target + "." + randomUUID() + ".part";
  const handle = await open(temp, "wx", 0o600);
  let closed = false,
    timer: ReturnType<typeof setTimeout> | undefined;
  const abort = new AbortController();
  const reset = () => {
    clearTimeout(timer);
    timer = setTimeout(() => abort.abort(), cfg.timeoutMs);
  };
  let bytes = 0;
  const hash = createHash("sha256");
  try {
    reset();
    let current = resource.url,
      response: Response | undefined;
    for (let n = 0; n < 6; n++) {
      if (!(await check()))
        throw new RainError("CANCELLED", "下载任务已停止。");
      let addresses: Address[] = [];
      const u = await validateAssetUrl(
        current,
        async (host) =>
          (addresses = await (options.resolve || resolvePublic)(host)),
      );
      response = options.fetcher
        ? await options.fetcher(u, { redirect: "manual", signal: abort.signal })
        : await pinnedFetch(u, addresses, abort.signal);
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
        await response.body?.cancel();
        if (!location)
          throw new RainError("UNSAFE_REDIRECT", "下载重定向缺少位置。");
        current = new URL(location, u).toString();
        continue;
      }
      break;
    }
    if (!response?.ok || !response.body)
      throw new RainError(
        "DOWNLOAD_HTTP",
        `资源下载未成功（HTTP ${response?.status ?? 0}）。`,
        response?.status,
      );
    const type = response.headers.get("content-type") || "";
    if (/text\/html/.test(type) && resource.kind !== "file")
      throw new RainError("INVALID_DOWNLOAD", "资源返回登录页面。");
    const header = response.headers.get("content-length");
    const declared = header === null ? undefined : Number(header);
    if (
      declared !== undefined &&
      (!Number.isFinite(declared) || declared < 0 || declared > cfg.maxBytes)
    )
      throw new RainError("FILE_LIMIT", "资源大小超出限制。");
    const reader = response.body.getReader();
    try {
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        reset();
        if (!(await check()))
          throw new RainError("CANCELLED", "下载任务已停止。");
        bytes += next.value.length;
        if (bytes > cfg.maxBytes)
          throw new RainError("FILE_LIMIT", "资源超过文件上限。");
        let at = 0;
        while (at < next.value.length) {
          const w = await handle.write(next.value, at);
          if (!w.bytesWritten)
            throw new RainError("LOCAL_WRITE", "本地写入未完成。");
          at += w.bytesWritten;
        }
        hash.update(next.value);
      }
    } finally {
      await reader.cancel().catch(() => {});
    }
    if (
      (declared !== undefined && declared !== bytes) ||
      (resource.size !== undefined && resource.size !== bytes)
    )
      throw new RainError("DOWNLOAD_SIZE", "下载大小与声明不一致。");
    if (!(await check()))
      throw new RainError("CANCELLED", "下载完成前任务已停止。");
    await handle.close();
    closed = true;
    await guardedPath(dir, path.basename(target));
    await link(temp, target);
    await rm(temp);
    return {
      filePath: target,
      bytes,
      sha256: hash.digest("hex"),
      mimeType: type,
    };
  } finally {
    clearTimeout(timer);
    abort.abort();
    if (!closed) await handle.close();
    await rm(temp, { force: true });
  }
}
export interface ManifestFile {
  relative: string;
  sha256: string;
  bytes: number;
  resourceId: string;
  sourceKey?: string;
  kind: string;
}
export interface DownloadManifest {
  version: 1;
  accountId: string;
  lessonId: string;
  courseId?: string;
  courseName: string;
  lessonTitle: string;
  root: string;
  files: ManifestFile[];
  status: "complete" | "partial";
  errors: { resourceId: string; code: string; message: string }[];
  cloud?: {
    repoId: string;
    root: string;
    accountId: string;
    files: Record<
      string,
      { sha256: string; remoteId?: string; operationId: string }
    >;
  };
}
export async function verifyManifestFiles(
  manifest: Pick<DownloadManifest, "root" | "accountId" | "files">,
  accountId: string,
) {
  if (manifest.accountId !== accountId)
    throw new RainError("ACCOUNT_MISMATCH", "归档清单属于另一账号。");
  if (!path.isAbsolute(manifest.root))
    throw new RainError("UNSAFE_PATH", "资源清单根目录必须是绝对路径。");
  const out = [];
  for (const f of manifest.files) {
    if (path.isAbsolute(f.relative))
      throw new RainError("UNSAFE_PATH", "清单路径必须为相对路径。");
    const file = await guardedPath(manifest.root, f.relative);
    const stat = await lstat(file);
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      (await hashFile(file)) !== f.sha256
    )
      throw new RainError(
        "MANIFEST_CHANGED",
        "清单文件内容已改变或不是普通文件，未上传。",
      );
    out.push({ ...f, filePath: file });
  }
  return out;
}
function extension(r: Resource) {
  const e = path.posix.extname(new URL(r.url).pathname).toLowerCase();
  return /^\.[a-z0-9]{1,7}$/.test(e)
    ? e
    : r.kind === "slide"
      ? ".jpg"
      : r.kind === "video"
        ? ".mp4"
        : ".bin";
}
function sourceKey(r: Resource) {
  const u = new URL(r.url);
  return digest(u.origin + u.pathname + ":" + (r.size ?? ""));
}
export async function downloadLesson(
  client: RainClient,
  cfg: Config,
  lessonId: string,
  options: any,
  check: () => Promise<boolean>,
  progress: (r: unknown) => Promise<void>,
) {
  const collected = await client.collectResources(lessonId);
  let selected = collected.resources.filter(
    (r) => options.includeVideos !== false || r.kind !== "video",
  );
  if (options.resourceIds?.length) {
    const wanted = new Set(options.resourceIds);
    selected = selected.filter((r) => wanted.has(r.id));
    if (selected.length !== wanted.size)
      throw new RainError("NOT_FOUND", "部分资源 ID 不属于该课堂。");
  }
  const limit = Math.min(options.maxResources ?? 5000, 20000);
  const limited = selected.length > limit;
  selected = selected.slice(0, limit);
  const base = path.resolve(options.outputDir || cfg.outputDir),
    root = await guardedPath(
      base,
      path.join(
        safeSegment(options.courseName || "未分类课程") +
          "__" +
          (options.classroomId
            ? digest(options.classroomId).slice(0, 10)
            : "unspecified"),
        safeSegment(collected.title) + "__" + digest(lessonId).slice(0, 12),
      ),
    );
  await mkdir(root, { recursive: true });
  const manifestFile = await guardedPath(root, ".hetang-manifest.json");
  return withLock(
    path.join(cfg.stateDir, "download-locks", digest(root)),
    async () => {
      const previous = await readJson<DownloadManifest>(manifestFile);
      if (previous && previous.accountId !== client.identity)
        throw new RainError("ACCOUNT_MISMATCH", "下载目录已绑定另一账号。");
      if (previous) {
        const approved = await readJson<{
          accountId: string;
          manifestPath: string;
          root: string;
          filesDigest: string;
        }>(
          path.join(cfg.stateDir, "manifests", digest(manifestFile) + ".json"),
        );
        if (
          !approved ||
          approved.accountId !== client.identity ||
          approved.manifestPath !== manifestFile ||
          approved.root !== root ||
          previous.root !== root ||
          previous.lessonId !== lessonId ||
          approved.filesDigest !== digest(JSON.stringify(previous.files))
        )
          throw new RainError(
            "MANIFEST_CHANGED",
            "旧资源清单不再匹配原登记记录，未复用或重新批准。",
          );
      }
      const manifest: DownloadManifest = {
        version: 1,
        accountId: client.identity,
        lessonId,
        courseId: options.classroomId,
        courseName: options.courseName || "未分类课程",
        lessonTitle: collected.title,
        root,
        files: [],
        status:
          limited ||
          (collected.replayUnavailable && options.includeVideos !== false)
            ? "partial"
            : "complete",
        errors: [],
        cloud: previous?.cloud,
      };
      if (limited)
        manifest.errors.push({
          resourceId: "*",
          code: "RESOURCE_LIMIT",
          message: "超过资源上限，当前结果不完整。",
        });
      if (collected.replayUnavailable && options.includeVideos !== false)
        manifest.errors.push({
          resourceId: "replay",
          code: "REPLAY_UNAVAILABLE",
          message: "回放接口不可用，未声称回放已完整下载。",
        });
      for (const r of selected) {
        if (!(await check()))
          throw new RainError("CANCELLED", "下载任务停止。");
        const relative = path.join(
          r.kind === "slide"
            ? "课件图片"
            : r.kind === "video"
              ? "课堂回放"
              : "课程文件",
          safeSegment(r.title) +
            "__" +
            digest(r.presentationId || r.id).slice(0, 10),
          String(r.index).padStart(4, "0") + "__" + r.id + extension(r),
        );
        const target = await guardedPath(root, relative);
        try {
          const old = previous?.files.find(
            (f) => f.resourceId === r.id && f.sourceKey === sourceKey(r),
          );
          if (
            old &&
            (await hashFile(target).catch(() => undefined)) === old.sha256
          ) {
            manifest.files.push(old);
          } else {
            const result = await downloadResource(
              r,
              target,
              cfg,
              check,
              cfg.mock
                ? {
                    resolve: async () => [{ address: "8.8.8.8", family: 4 }],
                    fetcher: async () =>
                      new Response(
                        Buffer.from(
                          "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jV0cAAAAASUVORK5CYII=",
                          "base64",
                        ),
                        { headers: { "content-type": "image/png" } },
                      ),
                  }
                : {},
            );
            manifest.files.push({
              relative,
              resourceId: r.id,
              sourceKey: sourceKey(r),
              kind: r.kind,
              bytes: result.bytes,
              sha256: result.sha256,
            });
          }
        } catch (e) {
          manifest.status = "partial";
          manifest.errors.push({ resourceId: r.id, ...publicError(e) });
        }
        await atomicJson(manifestFile, manifest);
        await progress({
          kind: "download-progress",
          lessonId,
          files: manifest.files.length,
          errors: manifest.errors.length,
        });
      }
      if (options.pdf !== false) {
        for (const pid of [
          ...new Set(
            selected
              .filter((r) => r.kind === "slide")
              .map((r) => r.presentationId!),
          ),
        ]) {
          const pages = selected
            .filter((r) => r.presentationId === pid && r.kind === "slide")
            .sort((a, b) => a.index - b.index);
          if (
            pages.some(
              (r) => !manifest.files.some((f) => f.resourceId === r.id),
            )
          )
            continue;
          const pdfKey = digest(
            pages
              .map(
                (r) =>
                  r.id +
                  ":" +
                  manifest.files.find((f) => f.resourceId === r.id)!.sha256,
              )
              .join("|"),
          ).slice(0, 12);
          const isSubset =
            pages.length <
            collected.resources.filter(
              (r) => r.kind === "slide" && r.presentationId === pid,
            ).length;
          const relative = path.join(
            "课件PDF",
            safeSegment(pages[0].title) +
              "__" +
              digest(pid).slice(0, 12) +
              (isSubset ? "__选页" : "") +
              "__" +
              pdfKey +
              ".pdf",
          );
          try {
            const target = await guardedPath(root, relative);
            const old = previous?.files.find((f) => f.relative === relative);
            if (
              old &&
              (await hashFile(target).catch(() => undefined)) === old.sha256
            ) {
              manifest.files.push(old);
              continue;
            }
            if (await lstat(target).catch(() => undefined))
              throw new RainError("LOCAL_CONFLICT", "PDF 已存在，未覆盖。");
            const pdf = await PDFDocument.create();
            for (const r of pages) {
              if (!(await check()))
                throw new RainError("CANCELLED", "PDF 生成已停止。");
              const f = manifest.files.find((f) => f.resourceId === r.id)!;
              const bytes = await readFile(await guardedPath(root, f.relative));
              const image =
                bytes[0] === 0x89
                  ? await pdf.embedPng(bytes)
                  : await pdf.embedJpg(bytes);
              const page = pdf.addPage([image.width, image.height]);
              page.drawImage(image, {
                x: 0,
                y: 0,
                width: image.width,
                height: image.height,
              });
            }
            const bytes = await pdf.save();
            await mkdir(path.dirname(target), { recursive: true });
            const pdfTemp = target + "." + randomUUID() + ".part";
            try {
              const h = await open(pdfTemp, "wx", 0o600);
              try {
                await h.writeFile(bytes);
              } finally {
                await h.close();
              }
              await link(pdfTemp, target);
            } finally {
              await rm(pdfTemp, { force: true });
            }
            manifest.files.push({
              relative,
              resourceId: "pdf:" + pid,
              kind: "pdf",
              bytes: bytes.length,
              sha256: digest(bytes),
            });
          } catch (e) {
            manifest.status = "partial";
            manifest.errors.push({
              resourceId: "pdf:" + pid,
              ...publicError(e),
            });
          }
        }
      }
      await atomicJson(manifestFile, manifest);
      await atomicJson(
        path.join(cfg.stateDir, "manifests", digest(manifestFile) + ".json"),
        {
          accountId: client.identity,
          manifestPath: manifestFile,
          root,
          filesDigest: digest(JSON.stringify(manifest.files)),
        },
      );
      return {
        status: manifest.status,
        manifestPath: manifestFile,
        root,
        files: manifest.files.length,
        errors: manifest.errors,
      };
    },
  );
}
export async function runResourceJob(
  client: RainClient,
  cfg: Config,
  job: Job,
  check: () => Promise<boolean>,
  progress: (r: unknown) => Promise<void>,
) {
  const results: any[] = [];
  if (job.kind === "archive") {
    const { archiveManifest } = await import("./cloud.js");
    return archiveManifest(
      client,
      cfg,
      job.options.manifestPath,
      job.options,
      check,
      progress,
    );
  }
  for (const lessonId of job.options.lessonIds) {
    try {
      const result = await downloadLesson(
        client,
        cfg,
        lessonId,
        job.options,
        check,
        progress,
      );
      if (job.options.archive) {
        try {
          const { archiveManifest } = await import("./cloud.js");
          const archived = await archiveManifest(
            client,
            cfg,
            result.manifestPath,
            job.options,
            check,
            progress,
          );
          results.push({
            ...result,
            archive: archived,
            status: archived.status === "complete" ? result.status : "partial",
          });
        } catch (e) {
          results.push({
            ...result,
            status: "partial",
            archive: { status: "partial", error: publicError(e) },
          });
          if (
            e instanceof RainError &&
            ["AUTH_CHANGED", "CANCELLED", "CLOUD_AUTH_CHANGED"].includes(e.code)
          )
            break;
        }
      } else results.push(result);
    } catch (e) {
      results.push({ status: "partial", lessonId, error: publicError(e) });
      if (
        e instanceof RainError &&
        ["AUTH_CHANGED", "CANCELLED", "CLOUD_AUTH_CHANGED"].includes(e.code)
      )
        break;
    }
  }
  return {
    status: results.some((r) => r.status !== "complete")
      ? ("partial" as const)
      : ("complete" as const),
    results,
  };
}
