import { afterEach, describe, expect, it } from "vitest";
import { randomUUID, createHash } from "node:crypto";
import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  atomicJson,
  atomicWrite,
  guardedPath,
  readJson,
  scrub,
  withLock,
} from "../src/storage.js";
import {
  downloadResource,
  hashFile,
  resolveAssetAddresses,
  validateAssetUrl,
  verifyManifestFiles,
} from "../src/resources.js";
import { getJob, stableId, startJob, stopJob } from "../src/jobs.js";
import { AuthStore } from "../src/auth.js";
import { apiUrl } from "../src/client.js";
import type { Config } from "../src/config.js";
import type { Resource } from "../src/types.js";

/**
 * 本文件只补 packages/hetang 未被覆盖的分支，全部用假网络与自建临时目录：
 * 不联网、不写真实校园数据、不读真实账号状态。
 */
const QA_ROOT = path.resolve(
  fileURLToPath(new URL("../../../.local/qa-temp", import.meta.url)),
);
const created: string[] = [];

async function tempDir(tag: string): Promise<string> {
  const dir = path.join(QA_ROOT, `hetang-${tag}-${randomUUID()}`);
  await mkdir(dir, { recursive: true });
  created.push(dir);
  return dir;
}

afterEach(async () => {
  while (created.length) await rm(created.pop()!, { recursive: true, force: true });
});

function config(stateDir: string, overrides: Partial<Config> = {}): Config {
  return {
    stateDir,
    outputDir: path.join(stateDir, "out"),
    mock: false,
    timeoutMs: 2000,
    maxBytes: 1024,
    cloudCli: "npx thu-cloud",
    ...overrides,
  };
}

const sha256 = (data: string | Buffer) =>
  createHash("sha256").update(data).digest("hex");

const asset = (overrides: Partial<Resource> = {}): Resource => ({
  id: "r1",
  lessonId: "l1",
  kind: "slide",
  title: "课件",
  url: "https://s3.yuketang.cn/a.png",
  index: 1,
  ...overrides,
});

const publicLookup = async () => [{ address: "93.184.216.34", family: 4 }];

describe("storage.guardedPath", () => {
  it("允许目录内的相对路径并自动建目录", async () => {
    const root = await tempDir("guard");
    const target = await guardedPath(root, "a/b/c.txt");
    expect(target).toBe(path.join(root, "a", "b", "c.txt"));
    expect(await readJson(path.join(root, "missing.json"))).toBeUndefined();
  });

  it("拒绝 .. 穿越与绝对路径外逃", async () => {
    const root = await tempDir("guard-escape");
    await expect(guardedPath(root, "../evil.txt")).rejects.toMatchObject({
      code: "UNSAFE_PATH",
    });
    await expect(
      guardedPath(root, path.resolve(root, "..", "evil2.txt")),
    ).rejects.toMatchObject({ code: "UNSAFE_PATH" });
  });

  it("拒绝目录内指向外部的链接", async () => {
    const root = await tempDir("guard-link");
    const outside = await tempDir("guard-outside");
    await symlink(outside, path.join(root, "link"), "junction");
    await expect(guardedPath(root, "link/file.txt")).rejects.toMatchObject({
      code: "UNSAFE_PATH",
    });
  });
});

describe("storage 读写与锁", () => {
  it("atomicWrite/atomicJson 落盘后可读回", async () => {
    const dir = await tempDir("atomic");
    const file = path.join(dir, "x", "y.json");
    await atomicJson(file, { a: 1 });
    expect(await readJson<{ a: number }>(file)).toEqual({ a: 1 });
    const plain = path.join(dir, "plain.txt");
    await atomicWrite(plain, "hello");
    expect(await readFile(plain, "utf8")).toBe("hello");
  });

  it("readJson 对坏 JSON 抛错而不是静默返回 undefined", async () => {
    const dir = await tempDir("atomic-bad");
    const file = path.join(dir, "bad.json");
    await writeFile(file, "{not json", "utf8");
    await expect(readJson(file)).rejects.toThrow();
  });

  it("withLock 让并发进入串行化，且异常后仍释放锁", async () => {
    const dir = await tempDir("lock");
    let active = 0;
    let peak = 0;
    const run = () =>
      withLock(dir, async () => {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((r) => setTimeout(r, 30));
        active -= 1;
        return true;
      });
    await expect(Promise.all([run(), run()])).resolves.toEqual([true, true]);
    expect(peak).toBe(1);
    await expect(
      withLock(dir, async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    await expect(run()).resolves.toBe(true);
  });
});

describe("storage.scrub", () => {
  it("抹掉凭据字段但保留 64 位指纹", () => {
    const fingerprint = "a".repeat(64);
    const out = scrub({
      password: "p",
      cookie: "c",
      token: "t",
      Authorization: "bearer",
      questionFingerprint: fingerprint,
      keep: "v",
    });
    expect(out).toEqual({ questionFingerprint: fingerprint, keep: "v" });
  });

  it("从 URL 上删除 csrf/token/ticket/session 参数", () => {
    const out = scrub({
      url: "https://x.test/a?csrf=1&keep=2&ticket=3&sessionid=4",
    });
    expect(out.url).toBe("https://x.test/a?keep=2");
  });

  it("从普通文本里删除内联凭据查询串", () => {
    const out = scrub({ note: "redirect?ticket=abc&x=1" });
    expect(out.note).toBe("redirect?x=1");
    const token = scrub({ note: "a?access_token=zzz" });
    expect(token.note).toBe("a");
  });
});

describe("resources.validateAssetUrl", () => {
  it("只放行允许的雨课堂 CDN 域名且必须是 https", async () => {
    const url = await validateAssetUrl(
      "https://s3.yuketang.cn/a.png",
      publicLookup,
    );
    expect(url.hostname).toBe("s3.yuketang.cn");

    for (const bad of [
      "http://s3.yuketang.cn/a.png",
      "https://evil.com/a.png",
      "https://s3.yuketang.cn:8080/a.png",
      "https://user:pw@s3.yuketang.cn/a.png",
      "not a url",
    ]) {
      await expect(validateAssetUrl(bad, publicLookup)).rejects.toMatchObject({
        code: "UNSAFE_ASSET",
      });
    }
  });

  it("解析到私网或没有解析结果时拒绝", async () => {
    for (const lookup of [
      async () => [{ address: "10.0.0.1", family: 4 }],
      async () => [],
    ]) {
      await expect(
        validateAssetUrl("https://s3.yuketang.cn/a.png", lookup),
      ).rejects.toMatchObject({ code: "UNSAFE_ASSET" });
    }
  });
});

describe("resources.resolveAssetAddresses", () => {
  it("直连解析结果全是公网时原样返回", async () => {
    const rows = await resolveAssetAddresses("direct.example", {
      lookup: publicLookup,
    });
    expect(rows).toEqual([{ address: "93.184.216.34", family: 4 }]);
  });

  it("只有 Fake-IP 时改用公网 DNS 查询", async () => {
    const rows = await resolveAssetAddresses("fakeip.example", {
      lookup: async () => [{ address: "198.18.0.7", family: 4 }],
      fetcher: async () =>
        new Response(
          JSON.stringify({
            Status: 0,
            Answer: [{ type: 1, data: "93.184.216.34" }],
          }),
          { status: 200, headers: { "content-type": "application/dns-json" } },
        ),
    });
    expect(rows).toEqual([{ address: "93.184.216.34", family: 4 }]);
  });

  it("Fake-IP 与私网混在一起时直接拒绝，不发起 DNS 查询", async () => {
    let called = false;
    await expect(
      resolveAssetAddresses("mixed.example", {
        lookup: async () => [
          { address: "198.19.0.1", family: 4 },
          { address: "192.168.1.1", family: 4 },
        ],
        fetcher: async () => {
          called = true;
          return new Response("{}");
        },
      }),
    ).rejects.toMatchObject({ code: "UNSAFE_ASSET" });
    expect(called).toBe(false);
  });

  it("公网 DNS 失败或返回私网时拒绝", async () => {
    const fakeOnly = async () => [{ address: "198.18.0.9", family: 4 }];
    await expect(
      resolveAssetAddresses("dns-fail.example", {
        lookup: fakeOnly,
        fetcher: async () => new Response("nope", { status: 502 }),
      }),
    ).rejects.toMatchObject({ code: "ASSET_DNS" });

    for (const answer of [
      { Status: 0, Answer: [{ type: 1, data: "10.1.2.3" }] },
      { Status: 0, Answer: [] },
      { Status: 3, Answer: [{ type: 1, data: "93.184.216.34" }] },
    ]) {
      await expect(
        resolveAssetAddresses(`dns-bad-${randomUUID()}.example`, {
          lookup: fakeOnly,
          fetcher: async () =>
            new Response(JSON.stringify(answer), { status: 200 }),
        }),
      ).rejects.toMatchObject({ code: "UNSAFE_ASSET" });
    }
  });
});

describe("resources.hashFile", () => {
  it("返回文件内容的 sha256", async () => {
    const dir = await tempDir("hash");
    const file = path.join(dir, "a.bin");
    await writeFile(file, "abc");
    expect(await hashFile(file)).toBe(sha256("abc"));
  });
});

describe("resources.downloadResource", () => {
  const ok = (body: string, headers: Record<string, string> = {}) =>
    new Response(body, {
      status: 200,
      headers: { "content-type": "image/png", "content-length": String(Buffer.byteLength(body)), ...headers },
    });

  it("成功写入并返回字节数与摘要", async () => {
    const dir = await tempDir("dl");
    const target = path.join(dir, "sub", "a.png");
    const result = await downloadResource(
      asset(),
      target,
      config(dir),
      async () => true,
      { resolve: publicLookup, fetcher: async () => ok("hello") },
    );
    expect(result.bytes).toBe(5);
    expect(result.sha256).toBe(sha256("hello"));
    expect(await readFile(target, "utf8")).toBe("hello");
  });

  it("目标已存在时拒绝覆盖", async () => {
    const dir = await tempDir("dl-conflict");
    const target = path.join(dir, "a.png");
    await writeFile(target, "old");
    await expect(
      downloadResource(asset(), target, config(dir), async () => true, {
        resolve: publicLookup,
        fetcher: async () => ok("new"),
      }),
    ).rejects.toMatchObject({ code: "LOCAL_CONFLICT" });
  });

  it("任务被停止时抛 CANCELLED", async () => {
    const dir = await tempDir("dl-cancel");
    await expect(
      downloadResource(asset(), path.join(dir, "a.png"), config(dir), async () => false, {
        resolve: publicLookup,
        fetcher: async () => ok("x"),
      }),
    ).rejects.toMatchObject({ code: "CANCELLED" });
  });

  it("非 2xx 抛 DOWNLOAD_HTTP", async () => {
    const dir = await tempDir("dl-404");
    await expect(
      downloadResource(asset(), path.join(dir, "a.png"), config(dir), async () => true, {
        resolve: publicLookup,
        fetcher: async () => new Response("no", { status: 404 }),
      }),
    ).rejects.toMatchObject({ code: "DOWNLOAD_HTTP" });
  });

  it("声明长度超限或与实体不一致时拒绝", async () => {
    const dir = await tempDir("dl-size");
    await expect(
      downloadResource(asset(), path.join(dir, "big.png"), config(dir), async () => true, {
        resolve: publicLookup,
        fetcher: async () => ok("x".repeat(2048)),
      }),
    ).rejects.toMatchObject({ code: "FILE_LIMIT" });

    await expect(
      downloadResource(asset(), path.join(dir, "mismatch.png"), config(dir), async () => true, {
        resolve: publicLookup,
        fetcher: async () =>
          new Response("abcd", {
            status: 200,
            headers: { "content-type": "image/png", "content-length": "10" },
          }),
      }),
    ).rejects.toMatchObject({ code: "DOWNLOAD_SIZE" });
  });

  it("非文件类资源返回登录页时拒绝", async () => {
    const dir = await tempDir("dl-html");
    await expect(
      downloadResource(asset(), path.join(dir, "a.png"), config(dir), async () => true, {
        resolve: publicLookup,
        fetcher: async () =>
          new Response("<html></html>", {
            status: 200,
            headers: { "content-type": "text/html" },
          }),
      }),
    ).rejects.toMatchObject({ code: "INVALID_DOWNLOAD" });
  });

  it("重定向缺少 location 时拒绝，带 location 时跟随", async () => {
    const dir = await tempDir("dl-redirect");
    await expect(
      downloadResource(asset(), path.join(dir, "a.png"), config(dir), async () => true, {
        resolve: publicLookup,
        fetcher: async () => new Response(null, { status: 302 }),
      }),
    ).rejects.toMatchObject({ code: "UNSAFE_REDIRECT" });

    let call = 0;
    const result = await downloadResource(
      asset(),
      path.join(dir, "b.png"),
      config(dir),
      async () => true,
      {
        resolve: publicLookup,
        fetcher: async () => {
          call += 1;
          if (call === 1)
            return new Response(null, {
              status: 302,
              headers: { location: "https://s3.yuketang.cn/final.png" },
            });
          return ok("done");
        },
      },
    );
    expect(result.bytes).toBe(4);
    expect(call).toBe(2);
  });
});

describe("resources.verifyManifestFiles", () => {
  async function manifest() {
    const root = await tempDir("manifest");
    await writeFile(path.join(root, "f1.bin"), "one");
    return {
      root,
      accountId: "acc",
      files: [
        { relative: "f1.bin", sha256: sha256("one"), bytes: 3, resourceId: "r1", kind: "file" },
      ],
    };
  }

  it("通过校验后返回带绝对路径的条目", async () => {
    const m = await manifest();
    const out = await verifyManifestFiles(m, "acc");
    expect(out).toHaveLength(1);
    expect(out[0].filePath).toBe(path.join(m.root, "f1.bin"));
  });

  it("账号不符、根目录非绝对、相对路径为绝对、内容被改动都拒绝", async () => {
    const m = await manifest();
    await expect(verifyManifestFiles(m, "other")).rejects.toMatchObject({
      code: "ACCOUNT_MISMATCH",
    });
    await expect(
      verifyManifestFiles({ ...m, root: "relative" }, "acc"),
    ).rejects.toMatchObject({ code: "UNSAFE_PATH" });
    await expect(
      verifyManifestFiles(
        { ...m, files: [{ ...m.files[0], relative: path.join(m.root, "f1.bin") }] },
        "acc",
      ),
    ).rejects.toMatchObject({ code: "UNSAFE_PATH" });

    await writeFile(path.join(m.root, "f1.bin"), "tampered");
    await expect(verifyManifestFiles(m, "acc")).rejects.toMatchObject({
      code: "MANIFEST_CHANGED",
    });
  });
});

describe("jobs 记录读写", () => {
  const UUID = "11111111-2222-4333-8444-555555555555";

  async function writeJob(dir: string, job: Record<string, unknown>) {
    await mkdir(path.join(dir, "jobs"), { recursive: true });
    await writeFile(
      path.join(dir, "jobs", `${UUID}.json`),
      JSON.stringify({
        id: UUID,
        kind: "monitor",
        accountId: "acc",
        generation: "gen",
        options: {},
        status: "queued",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        events: [],
        cursor: 0,
        ...job,
      }),
      "utf8",
    );
  }

  it("stableId 稳定且是 UUID 形状", () => {
    const a = stableId("lesson-1");
    expect(a).toBe(stableId("lesson-1"));
    expect(a).not.toBe(stableId("lesson-2"));
    expect(a).toMatch(/^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-8[\da-f]{3}-[\da-f]{12}$/);
  });

  it("非法 ID 与不存在的任务都明确报错", async () => {
    const dir = await tempDir("job-id");
    await expect(getJob(config(dir), "not-a-uuid")).rejects.toMatchObject({
      code: "INVALID_ID",
    });
    await expect(getJob(config(dir), UUID)).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });

  it("超时未启动的定时任务被判定为 interrupted", async () => {
    const dir = await tempDir("job-stale");
    await writeJob(dir, {
      kind: "scheduled-answer",
      status: "queued",
      createdAt: new Date(Date.now() - 120000).toISOString(),
    });
    expect((await getJob(config(dir), UUID)).status).toBe("interrupted");
  });

  it("进程已消失的运行中任务被判定为 interrupted，进程仍在则保持原状态", async () => {
    const dir = await tempDir("job-pid");
    await writeJob(dir, { status: "running", pid: 2147483646 });
    expect((await getJob(config(dir), UUID)).status).toBe("interrupted");

    await writeJob(dir, { status: "running", pid: process.pid });
    expect((await getJob(config(dir), UUID)).status).toBe("running");
  });

  it("stopJob 写入停止标记，并区分是否可能已派发", async () => {
    const dir = await tempDir("job-stop");
    await writeJob(dir, { status: "running", pid: process.pid });
    await expect(stopJob(config(dir), UUID)).resolves.toEqual({
      id: UUID,
      stopRequested: true,
    });
    expect((await getJob(config(dir), UUID)).stop).toBe(true);

    await writeJob(dir, {
      kind: "scheduled-answer",
      status: "running",
      pid: process.pid,
      result: { intentAt: new Date().toISOString() },
    });
    expect(await stopJob(config(dir), UUID)).toMatchObject({
      stopRequested: true,
      mayHaveDispatched: true,
    });
  });

  it("未登录时创建任务被拒绝，不产生任务记录", async () => {
    const dir = await tempDir("job-unauth");
    await expect(startJob(config(dir), "monitor", {})).rejects.toMatchObject({
      code: "AUTH_REQUIRED",
    });
    await expect(getJob(config(dir), UUID)).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });
});

describe("client.apiUrl", () => {
  it("只接受荷塘雨课堂同源 HTTPS", () => {
    expect(apiUrl("/api/v1/x").toString()).toContain("/api/v1/x");
    for (const bad of [
      "http://www.yuketang.cn/api",
      "https://evil.example.com/api",
      "https://user:pw@www.yuketang.cn/api",
    ]) {
      expect(() => apiUrl(bad)).toThrowError(/UNSAFE_URL|只允许/);
    }
  });
});

describe("auth.AuthStore", () => {
  const dpapiTest = process.platform === "win32" ? it : it.skip;

  it("未保存时 version 为 undefined，且 generation 稳定", async () => {
    const dir = await tempDir("auth-empty");
    const store = new AuthStore<{ account: string }>(dir);
    expect(await store.version()).toBeUndefined();
    expect(await store.load()).toBeUndefined();
    expect(await store.generation()).toBe(await store.generation());
    expect((await store.status()).configured).toBe(false);
  });

  it("拒绝没有账号的会话", async () => {
    const dir = await tempDir("auth-account");
    const store = new AuthStore<{ account: string }>(dir);
    await expect(store.save({ account: "  " })).rejects.toMatchObject({
      code: "AUTH_ACCOUNT",
    });
  });

  dpapiTest("保存后可读回，且每次保存推进 generation", async () => {
    const dir = await tempDir("auth-roundtrip");
    const store = new AuthStore<{ account: string; extra?: string }>(dir);
    const first = await store.generation();
    await store.save({ account: "u1", extra: "v" });
    expect(await store.load()).toEqual({ account: "u1", extra: "v" });
    expect(typeof (await store.version())).toBe("string");
    const afterSave = await store.generation();
    expect(afterSave).not.toBe(first);
    expect((await store.status()).configured).toBe(true);

    // 用同一个 generation 再保存一次应当因认证已变化而失败。
    await expect(
      store.saveIfCurrent({ account: "u2" }, afterSave),
    ).resolves.toBeTruthy();
    await expect(
      store.saveIfCurrent({ account: "u3" }, afterSave),
    ).rejects.toMatchObject({ code: "AUTH_CHANGED" });
  });

  dpapiTest("clear 之后版本与数据都消失", async () => {
    const dir = await tempDir("auth-clear");
    const store = new AuthStore<{ account: string }>(dir);
    await store.save({ account: "u1" });
    const before = await store.generation();
    await store.clear();
    expect(await store.load()).toBeUndefined();
    expect(await store.generation()).not.toBe(before);
  });
});