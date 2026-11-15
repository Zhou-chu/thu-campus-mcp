import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { PassThrough } from "node:stream";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { AuthStore } from "../src/auth.js";
import {
  bareName,
  CloudClient,
  remotePath,
  trustedUrl,
  validateToken,
} from "../src/client.js";
import { loadConfig, type Config } from "../src/config.js";
import { MockDrive, MOCK_REPO } from "../src/mock.js";
import { Operations } from "../src/operations.js";
import { createServer, serve } from "../src/server.js";
import { atomicJson, digest } from "../src/storage.js";
import { TransferService } from "../src/transfer.js";
import { CloudError } from "../src/types.js";

const QA = path.resolve("D:/code/thu-campus-mcp/.local/qa-temp");
const RID = MOCK_REPO;
const OTHER = "22222222-2222-4222-8222-222222222222";
const TOKEN = "coverage-unit-only-token-000000";
const roots: string[] = [];
const closers: Array<() => Promise<unknown>> = [];
const json = (value: unknown, init?: ResponseInit) =>
  Response.json(value, init);

beforeEach(() => {
  vi.stubEnv("TEMP", QA);
  vi.stubEnv("TMP", QA);
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      throw new Error("Unplanned network is prohibited in this unit suite");
    }),
  );
});
afterEach(async () => {
  while (closers.length) await closers.pop()!();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  while (roots.length) {
    const root = roots.pop()!;
    expect(path.dirname(path.resolve(root))).toBe(QA);
    expect(path.basename(root)).toMatch(/^cloud-sdk-edges-/);
    await rm(root, { recursive: true, force: true });
  }
});
async function config(overrides: Partial<Config> = {}) {
  await mkdir(QA, { recursive: true });
  const root = await mkdtemp(path.join(QA, "cloud-sdk-edges-"));
  roots.push(root);
  return {
    root,
    cfg: loadConfig({
      stateDir: path.join(root, "state"),
      outputDir: path.join(root, "output"),
      mock: false,
      timeoutMs: 2000,
      ...overrides,
    }),
  };
}
async function account(mode: "account" | "repo" = "account") {
  const f = await config();
  const store = new AuthStore(f.cfg.stateDir);
  await store.save({
    account: "coverage@example.test",
    token: TOKEN,
    mode,
    repoId: mode === "repo" ? RID : undefined,
  });
  const client = new CloudClient(f.cfg);
  return { ...f, store, client, mode };
}
function api(
  f: { mode: string },
  handler: (url: URL, init: RequestInit) => Response | Promise<Response>,
  permission = "rw",
) {
  const fn = vi.fn(async (raw: string, init: RequestInit = {}) => {
    const u = new URL(raw);
    expect(u.origin).toBe("https://cloud.tsinghua.edu.cn");
    expect(init.redirect).toBe("manual");
    expect(new Headers(init.headers).get("authorization")).toBe(
      "Token " + TOKEN,
    );
    if (u.pathname === "/api2/repos/")
      return json([{ id: RID, name: "Owned unit library", permission }]);
    if (f.mode === "repo" && u.pathname.endsWith("/repo-info/"))
      return json({
        repo_id: RID,
        repo_name: "Scoped unit library",
        permission,
      });
    if (
      f.mode === "repo" &&
      u.pathname.endsWith("/dir/") &&
      !u.searchParams.has("path")
    )
      return json({ user_perm: permission, dirent_list: [] });
    return handler(u, init);
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}
function rows(p = "/") {
  if (p === "/")
    return [
      { name: "a.txt", type: "file", id: "a-id", size: 3 },
      { name: "folder", type: "dir", id: "folder-id" },
      { name: "dest", type: "d", id: "dest-id" },
    ];
  if (p === "/folder")
    return [{ name: "nested.txt", type: "file", id: "nested-id", size: 2 }];
  return [];
}

describe("CloudClient protocol and guard edges", () => {
  it("rejects invalid names/repositories and normalizes only safe same-origin paths", async () => {
    for (const name of ["", ".", "..", "a/b", "a\\b", "a\0b"])
      expect(() => bareName(name)).toThrow();
    expect(bareName("资料.txt")).toBe("资料.txt");
    expect(remotePath("folder//file.txt")).toBe("/folder/file.txt");
    expect(() => remotePath("")).toThrow();
    expect(trustedUrl("/api2/repos/").origin).toBe(
      "https://cloud.tsinghua.edu.cn",
    );
    const f = await account();
    vi.stubGlobal("fetch", async () =>
      json([{ id: "invalid-id", name: "bad" }]),
    );
    await expect(f.client.libraries()).rejects.toMatchObject({
      code: "INVALID_REPO",
    });
  });

  it("maps non-OK HTTP, rejects read/write redirects, login HTML and malformed JSON without retry", async () => {
    const f = await account();
    for (const [status, code] of [
      [401, "AUTH_REQUIRED"],
      [403, "PERMISSION_DENIED"],
      [404, "NOT_FOUND"],
      [503, "HTTP_ERROR"],
    ] as const) {
      const fetch = api(f, () => new Response("refused", { status }));
      await expect(f.client.request("/unit-api")).rejects.toMatchObject({
        code,
        status,
      });
      expect(fetch).toHaveBeenCalledTimes(1);
    }
    for (const method of [undefined, "GET", "POST"]) {
      const fetch = api(
        f,
        () =>
          new Response("", { status: 302, headers: { location: "/login/" } }),
      );
      await expect(
        f.client.request("/unit-api", { method }),
      ).rejects.toMatchObject({
        code: "UNSAFE_REDIRECT",
        status: method === "POST" ? 500 : undefined,
      });
      expect(fetch).toHaveBeenCalledTimes(1);
    }
    for (const [body, code] of [
      ["<html>login</html>", "AUTH_REQUIRED"],
      ["<form>sign in</form>", "AUTH_REQUIRED"],
      ["not json", "INVALID_RESPONSE"],
    ]) {
      api(f, () => new Response(body));
      await expect(
        f.client.request("/unit-api", { method: "POST" }),
      ).rejects.toMatchObject({ code, status: 500 });
    }
    api(f, () => new Response(" \n "));
    await expect(f.client.request("/unit-api")).resolves.toBeNull();
  });

  it("requires a same-path exact Location before accepting a mutation acknowledgment", async () => {
    const f = await account(),
      endpoint = `/api2/repos/${RID}/file/?p=/a.txt`;
    for (const location of [
      undefined,
      "https://evil.example/file/?p=/new.txt",
      "/wrong/?p=/new.txt",
      `?p=/wrong.txt`,
    ]) {
      api(
        f,
        () =>
          new Response(JSON.stringify("success"), {
            status: 301,
            headers: location ? { location } : {},
          }),
      );
      await expect(
        f.client.request(endpoint, { method: "POST" }, "/new.txt"),
      ).rejects.toMatchObject({ code: "VERIFY_UNKNOWN", status: 500 });
    }
    api(
      f,
      () =>
        new Response(JSON.stringify("success"), {
          status: 301,
          headers: { location: "?p=/new.txt" },
        }),
    );
    await expect(
      f.client.request(endpoint, { method: "POST" }, "/new.txt"),
    ).resolves.toBe("success");
    api(
      f,
      () =>
        new Response("null", {
          headers: { location: `/api2/repos/${RID}/file/` },
        }),
    );
    await expect(
      f.client.request(endpoint, { method: "POST" }, "/"),
    ).resolves.toBeNull();
  });

  it("rejects malformed/oversized directory lists and preserves metadata aliases and local pagination", async () => {
    const f = await account();
    api(f, () => json({ nonsense: [] }));
    await expect(f.client.list(RID, "/")).rejects.toMatchObject({
      code: "INVALID_RESPONSE",
    });
    api(f, () =>
      json(
        Array.from({ length: 20001 }, () => ({ name: "item", type: "file" })),
      ),
    );
    await expect(f.client.list(RID, "/")).rejects.toMatchObject({
      code: "DIRECTORY_LIMIT",
    });
    api(f, () =>
      json({
        dirent_list: [
          {
            obj_name: "alias.txt",
            obj_id: "alias-id",
            type: "f",
            size: "unknown",
          },
          { name: "folder", type: "dir" },
          { name: "last", type: "file", size: 7 },
        ],
      }),
    );
    expect(await f.client.list(RID, "/", 0, 1)).toMatchObject({
      total: 3,
      nextOffset: 1,
      items: [{ name: "alias.txt", id: "alias-id", size: undefined }],
    });
    expect(await f.client.info(RID, "/")).toMatchObject({
      type: "dir",
      path: "/",
    });
    expect(await f.client.info(RID, "/folder")).toMatchObject({ type: "dir" });
    expect(await f.client.info(RID, "/absent")).toBeUndefined();
    api(f, () => json([{ type: "file" }]));
    await expect(f.client.list(RID, "/")).rejects.toMatchObject({
      code: "UNSAFE_PATH",
    });
  });

  it("enforces missing/read-only libraries and repository-token default metadata", async () => {
    const f = await account();
    api(f, () => json([]), "r");
    await expect(f.client.resolveRepo(RID, true)).rejects.toMatchObject({
      code: "READ_ONLY",
    });
    await expect(f.client.resolveRepo(OTHER)).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    const r = await account("repo");
    vi.stubGlobal("fetch", async (u: string) =>
      json(
        new URL(u).pathname.endsWith("repo-info/")
          ? { id: RID, name: "Fallback" }
          : {},
      ),
    );
    expect(await r.client.resolveRepo()).toMatchObject({
      id: RID,
      name: "Fallback",
      permission: "r",
    });
    await expect(r.client.share(RID, "/a", {})).rejects.toMatchObject({
      code: "TOKEN_SCOPE",
    });
    api(r, () => json([]));
    await expect(
      r.client.moveCopy("copy", RID, "/a", RID, "/"),
    ).rejects.toMatchObject({ code: "TOKEN_SCOPE" });
  });

  it("verifies account and repo-token mkdir/rename acknowledgments and never accepts a different destination", async () => {
    const f = await account();
    api(f, (u, init) => {
      if (init.method !== "POST")
        return json(rows(u.searchParams.get("p") || "/"));
      const body = init.body as URLSearchParams;
      const dest =
        body.get("operation") === "mkdir"
          ? u.searchParams.get("p")!
          : "/new.txt";
      return new Response(JSON.stringify("success"), {
        headers: { location: u.pathname + "?p=" + encodeURIComponent(dest) },
      });
    });
    expect(await f.client.mkdir(RID, "/new-dir")).toEqual({
      createdPath: "/new-dir",
    });
    expect(await f.client.rename(RID, "/a.txt", "new.txt")).toEqual({
      path: "/new.txt",
    });
    await expect(f.client.rename(RID, "/missing", "new")).rejects.toMatchObject(
      { code: "NOT_FOUND" },
    );
    await expect(
      f.client.rename(RID, "/a.txt", "folder"),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    const r = await account("repo");
    let wrong = false;
    api(r, (u, init) =>
      init.method === "POST"
        ? json({
            parent_dir: "/",
            obj_name: wrong
              ? "different"
              : (init.body as URLSearchParams).get("operation") === "mkdir"
                ? "made"
                : "renamed",
          })
        : json({ dirent_list: rows(u.searchParams.get("path") || "/") }),
    );
    expect(await r.client.mkdir(RID, "/made")).toEqual({
      createdPath: "/made",
    });
    expect(await r.client.rename(RID, "/a.txt", "renamed")).toEqual({
      path: "/renamed",
    });
    wrong = true;
    await expect(r.client.mkdir(RID, "/made")).rejects.toMatchObject({
      code: "VERIFY_UNKNOWN",
    });
    await expect(
      r.client.rename(RID, "/a.txt", "renamed"),
    ).rejects.toMatchObject({ code: "VERIFY_UNKNOWN" });
  });

  it("checks move/copy source, destination, self-copy, collisions and exact server success", async () => {
    const f = await account();
    let collision = false,
      succeed = true;
    api(f, (u, init) => {
      if (init.method === "POST") {
        expect(JSON.parse(String(init.body))).toMatchObject({
          src_repo_id: RID,
          dst_repo_id: RID,
        });
        return json({ success: succeed });
      }
      const p = u.searchParams.get("p") || "/";
      return json(
        p === "/dest" && collision
          ? [{ name: "a.txt", type: "file", id: "existing" }]
          : rows(p),
      );
    });
    await expect(
      f.client.moveCopy("copy", RID, "/missing", RID, "/dest"),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      f.client.moveCopy("move", RID, "/folder", RID, "/folder/sub"),
    ).rejects.toMatchObject({ code: "UNSAFE_PATH" });
    await expect(
      f.client.moveCopy("copy", RID, "/a.txt", RID, "/a.txt"),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    collision = true;
    await expect(
      f.client.moveCopy("copy", RID, "/a.txt", RID, "/dest"),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    collision = false;
    expect(
      await f.client.moveCopy("copy", RID, "/a.txt", RID, "/dest"),
    ).toEqual({ success: true });
    succeed = false;
    await expect(
      f.client.moveCopy("move", RID, "/a.txt", RID, "/dest"),
    ).rejects.toMatchObject({ code: "VERIFY_UNKNOWN" });
  });

  it("builds scoped share requests and validates both signed-link response shapes", async () => {
    const f = await account();
    let wrapped = false;
    api(f, (u, init) => {
      if (u.pathname.endsWith("share-links/")) {
        expect(Object.fromEntries(init.body as URLSearchParams)).toMatchObject({
          repo_id: RID,
          path: "/a.txt",
          password: "unit-share",
          expire_days: "3",
        });
        return json({ link: "/f/unit-only/", expire_date: "unit-expiry" });
      }
      const link = "https://cloud.tsinghua.edu.cn/seafhttp/unit-signed";
      return json(wrapped ? { download_link: link, upload_link: link } : link);
    });
    expect(
      await f.client.share(RID, "/a.txt", {
        password: "unit-share",
        expireDays: 3,
      }),
    ).toEqual({
      link: "https://cloud.tsinghua.edu.cn/f/unit-only/",
      expireDate: "unit-expiry",
    });
    for (const value of [false, true]) {
      wrapped = value;
      expect(await f.client.downloadLink(RID, "/a.txt")).toContain(
        "/seafhttp/",
      );
      expect(await f.client.uploadLink(RID, "/")).toContain("/seafhttp/");
    }
  });

  it("uses server search aliases then bounded traversal only for documented unavailable statuses", async () => {
    const f = await account();
    for (const payload of [
      { results: [{ name: "one" }], total: 1 },
      { data: [{ name: "two" }] },
      [{ name: "three" }],
    ]) {
      api(f, (u) => {
        expect(u.searchParams.get("search_repo")).toBe("all");
        return json(payload);
      });
      expect(await f.client.search("needle")).toMatchObject({
        mode: "server",
        complete: false,
      });
    }
    for (const status of [403, 404, 501]) {
      api(f, (u) =>
        u.pathname.endsWith("search/")
          ? new Response("", { status })
          : json(rows(u.searchParams.get("p") || "/")),
      );
      expect(await f.client.search("nested", RID, 10)).toMatchObject({
        mode: "name-traversal",
        complete: true,
        results: [{ name: "nested.txt", repoId: RID }],
      });
      expect(await f.client.search("", RID, 1)).toMatchObject({
        complete: false,
        scanned: 1,
      });
    }
    api(f, () => new Response("", { status: 500 }));
    await expect(f.client.search("x")).rejects.toMatchObject({
      code: "HTTP_ERROR",
    });
    api(f, () => {
      throw new TypeError("unit transport unavailable");
    });
    await expect(f.client.search("x")).rejects.toThrow(
      "unit transport unavailable",
    );
    const r = await account("repo");
    api(r, () =>
      json({
        dirent_list: Array.from({ length: 2001 }, (_, n) => ({
          name: "item-" + n,
          type: "file",
        })),
      }),
    );
    expect(await r.client.search("not-present", undefined, 50)).toMatchObject({
      scanned: 2000,
      complete: false,
    });
  });

  it("rejects unconfigured and invalidated clients without leaking or reusing stale auth", async () => {
    const empty = await config();
    await expect(new CloudClient(empty.cfg).checkAuth()).rejects.toMatchObject({
      code: "AUTH_REQUIRED",
    });
    const f = await account();
    await f.client.checkAuth();
    await f.store.clear();
    await expect(f.client.checkAuth()).rejects.toMatchObject({
      code: "AUTH_CHANGED",
    });
    await expect(f.client.checkAuth()).rejects.toMatchObject({
      code: "AUTH_CHANGED",
    });
    expect(f.client.identity).toBe("");
  });

  it("validates token format, account identity and only explicit 401/403 repo-token fallback", async () => {
    const f = await config();
    await expect(validateToken("short", f.cfg)).rejects.toMatchObject({
      code: "AUTH_FORMAT",
    });
    for (const identity of [
      { email: "unit@example.test" },
      { name: "unit-name" },
    ]) {
      vi.stubGlobal("fetch", async () => json(identity));
      expect(await validateToken(TOKEN, f.cfg)).toMatchObject({
        token: TOKEN,
        mode: "account",
      });
    }
    vi.stubGlobal("fetch", async () => json({}));
    await expect(validateToken(TOKEN, f.cfg)).rejects.toMatchObject({
      code: "AUTH_TOKEN",
    });
    for (const status of [401, 403]) {
      const fetch = vi.fn(async (u: string) =>
        new URL(u).pathname.includes("account")
          ? new Response("", { status })
          : json({ id: RID }),
      );
      vi.stubGlobal("fetch", fetch);
      expect(await validateToken(TOKEN, f.cfg)).toMatchObject({
        account: "repo:" + RID,
        mode: "repo",
        repoId: RID,
      });
      expect(fetch).toHaveBeenCalledTimes(2);
    }
    const fetch = vi.fn(async () => new Response("", { status: 500 }));
    vi.stubGlobal("fetch", fetch);
    await expect(validateToken(TOKEN, f.cfg)).rejects.toMatchObject({
      code: "AUTH_TOKEN",
      status: 500,
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

async function put(
  drive: MockDrive,
  p: string,
  content = "abc",
  replace = false,
) {
  const form = new FormData();
  form.set("file", new File([content], path.posix.basename(p)));
  if (replace) form.set("replace", "1");
  return drive.transferRequest(
    await drive.uploadLink(RID, path.posix.dirname(p)),
    { method: "POST", body: form },
  );
}
describe("MockDrive observable storage edges", () => {
  it("paginates entries and safely mutates/copies nested trees and returns deterministic share/search metadata", async () => {
    const { cfg } = await config({ mock: true }),
      d = new MockDrive(cfg);
    await d.mkdir(RID, "/tree");
    await d.mkdir(RID, "/tree/deep");
    expect((await put(d, "/tree/deep/file.txt")).status).toBe(200);
    expect((await d.list(RID, "/", 0, 1)).nextOffset).toBe(1);
    expect(await d.info(RID, "/")).toMatchObject({ type: "dir" });
    expect(await d.info(RID, "/absent")).toBeUndefined();
    await d.moveCopy("copy", RID, "/tree", RID, "/copy-parent");
    expect(await d.info(RID, "/copy-parent/tree/deep/file.txt")).toMatchObject({
      size: 3,
    });
    await d.rename(RID, "/tree", "renamed");
    expect(await d.info(RID, "/tree")).toBeUndefined();
    expect(await d.info(RID, "/renamed/deep/file.txt")).toMatchObject({
      size: 3,
    });
    expect(await d.share(RID, "/renamed", {})).toMatchObject({
      link: expect.stringContaining("/f/mock-share/"),
    });
    expect((await d.search("README")).results).toHaveLength(1);
    expect((await d.search("no-match", RID, 1)).results).toEqual([]);
  });
  it("preserves existing bytes on conflicts, supports explicit replace and refuses non-mock transfers", async () => {
    const { cfg } = await config({ mock: true }),
      d = new MockDrive(cfg);
    await expect(d.resolveRepo(OTHER)).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    await d.mkdir(RID, "/dir");
    await expect(d.mkdir(RID, "/dir")).rejects.toMatchObject({
      code: "CONFLICT",
    });
    await put(d, "/a.txt", "old");
    expect((await put(d, "/a.txt", "new")).status).toBe(409);
    expect(
      await (
        await d.transferRequest(await d.downloadLink(RID, "/a.txt"))
      ).text(),
    ).toBe("old");
    expect((await put(d, "/a.txt", "new", true)).status).toBe(200);
    await expect(
      d.moveCopy("copy", RID, "/missing", RID, "/dir"),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await put(d, "/dir/a.txt");
    await expect(
      d.moveCopy("move", RID, "/a.txt", RID, "/dir"),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(
      (await d.transferRequest(await d.downloadLink(RID, "/missing"))).status,
    ).toBe(404);
    await expect(
      d.transferRequest("https://cloud.tsinghua.edu.cn/other"),
    ).rejects.toMatchObject({ code: "MOCK_NETWORK" });
    await expect(
      d.transferRequest(await d.uploadLink(RID, "/")),
    ).rejects.toMatchObject({ code: "MOCK_NETWORK" });
  });
});

async function transfer(overrides: Partial<Config> = {}) {
  const f = await config({ maxBytes: 32, ...overrides }),
    c = new CloudClient(f.cfg);
  c.identity = "owned-unit-identity";
  c.checkAuth = async () => {};
  c.resolveRepo = async () => ({
    id: RID,
    name: "Unit",
    permission: "rw",
    encrypted: false,
  });
  c.info = async () => ({
    path: "/a.txt",
    name: "a.txt",
    type: "file",
    id: "unit-id",
    size: 3,
  });
  c.downloadLink = async () => "https://cloud.tsinghua.edu.cn/unit-download";
  c.uploadLink = async () => "https://cloud.tsinghua.edu.cn/unit-upload";
  const source = path.join(f.root, "source.bin");
  await writeFile(source, "abc");
  return { ...f, c, source, t: new TransferService(c, f.cfg) };
}
describe("TransferService refuses invalid/ambiguous transfers", () => {
  it("rejects unsafe redirect chains, login targets, failed HTTP and invalid declared lengths", async () => {
    const f = await transfer();
    const cases = [
      {
        response: () => new Response("", { status: 302 }),
        code: "UNSAFE_REDIRECT",
      },
      {
        response: () =>
          new Response("", {
            status: 302,
            headers: { location: "https://evil.example/file" },
          }),
        code: "UNSAFE_URL",
      },
      {
        response: () =>
          new Response("", {
            status: 302,
            headers: { location: "/accounts/login/" },
          }),
        code: "INVALID_DOWNLOAD",
      },
      {
        response: () => new Response("", { status: 404 }),
        code: "TRANSFER_HTTP",
      },
      {
        response: () => new Response(null, { status: 204 }),
        code: "TRANSFER_HTTP",
      },
      ...["NaN", "-1", "999999"].map((length) => ({
        response: () =>
          new Response("abc", { headers: { "content-length": length } }),
        code: "FILE_LIMIT",
      })),
    ];
    for (const entry of cases) {
      vi.stubGlobal("fetch", entry.response);
      await expect(f.t.read(RID, "/a.txt")).rejects.toMatchObject({
        code: entry.code,
      });
    }
    const fetch = vi.fn(
      async () =>
        new Response("", { status: 302, headers: { location: "/again" } }),
    );
    vi.stubGlobal("fetch", fetch);
    await expect(f.t.read(RID, "/a.txt")).rejects.toMatchObject({
      code: "TRANSFER_HTTP",
    });
    expect(fetch).toHaveBeenCalledTimes(5);
  });
  it("checks actual bytes, UTF8, login password forms, metadata and oversized multi-chunk heads", async () => {
    const f = await transfer();
    f.c.info = async () => undefined;
    await expect(f.t.read(RID, "/a")).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    f.c.info = async () => ({ name: "a", path: "/a", type: "file", size: 10 });
    await expect(f.t.read(RID, "/a", 2)).rejects.toMatchObject({
      code: "FILE_LIMIT",
    });
    f.c.info = async () => ({ name: "a", path: "/a", type: "file" });
    vi.stubGlobal("fetch", async () => new Response("abc"));
    await expect(f.t.read(RID, "/a", 2)).rejects.toMatchObject({
      code: "FILE_LIMIT",
    });
    vi.stubGlobal("fetch", async () => new Response(new Uint8Array([255])));
    await expect(f.t.read(RID, "/a")).rejects.toMatchObject({
      code: "BINARY_FILE",
    });
    vi.stubGlobal(
      "fetch",
      async () =>
        new Response(
          '<form action="login"><input type="password" name="csrfmiddlewaretoken"></form>',
        ),
    );
    await expect(f.t.read(RID, "/a")).rejects.toMatchObject({
      code: "INVALID_DOWNLOAD",
    });
    f.c.info = async () => ({ name: "a", path: "/a", type: "file", size: 2 });
    vi.stubGlobal("fetch", async () => new Response("abc"));
    await expect(f.t.read(RID, "/a")).rejects.toMatchObject({
      code: "DOWNLOAD_SIZE",
    });
    f.c.info = async () => ({ name: "a", path: "/a", type: "file" });
    vi.stubGlobal(
      "fetch",
      async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              for (const n of [8192, 1000, 1000])
                controller.enqueue(new TextEncoder().encode("a".repeat(n)));
              controller.close();
            },
          }),
        ),
    );
    expect((await f.t.read(RID, "/a")).content).toHaveLength(10192);
  });
  it("validates local download targets, refuses replacement, and removes partial data after metadata mismatch", async () => {
    const f = await transfer();
    await expect(
      f.t.download({ repoId: RID, path: "/a", outputDir: "relative" }),
    ).rejects.toMatchObject({ code: "ABSOLUTE_PATH" });
    f.c.info = async () => undefined;
    await expect(
      f.t.download({ repoId: RID, path: "/a", outputDir: f.root }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    f.c.info = async () => ({ name: "a", path: "/a", type: "file", size: 3 });
    for (const filename of ["CON", "a.", "bad:name"])
      await expect(
        f.t.download({ repoId: RID, path: "/a", outputDir: f.root, filename }),
      ).rejects.toMatchObject({ code: "UNSAFE_PATH" });
    await writeFile(path.join(f.root, "a"), "existing");
    await expect(
      f.t.download({ repoId: RID, path: "/a", outputDir: f.root }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    vi.stubGlobal("fetch", async () => new Response("x"));
    await expect(
      f.t.download({
        repoId: RID,
        path: "/a",
        outputDir: f.root,
        overwrite: true,
      }),
    ).rejects.toMatchObject({ code: "DOWNLOAD_SIZE" });
    expect(await readFile(path.join(f.root, "a"), "utf8")).toBe("existing");
    expect((await readdir(f.root)).some((name) => name.endsWith(".tmp"))).toBe(
      false,
    );
  });
  it("rejects invalid upload sources, existing directories and mismatched idempotency parameters", async () => {
    const f = await transfer();
    await expect(
      f.t.upload({ repoId: RID, path: "/a", filePath: "relative" }),
    ).rejects.toMatchObject({ code: "ABSOLUTE_PATH" });
    await expect(
      f.t.upload({ repoId: RID, path: "/a", filePath: f.root }),
    ).rejects.toMatchObject({ code: "FILE_LIMIT" });
    await writeFile(f.source, "x".repeat(33));
    await expect(
      f.t.upload({ repoId: RID, path: "/a", filePath: f.source }),
    ).rejects.toMatchObject({ code: "FILE_LIMIT" });
    await writeFile(f.source, "abc");
    f.c.info = async () => ({ name: "a", path: "/a", type: "dir" });
    await expect(
      f.t.upload({
        repoId: RID,
        path: "/a",
        filePath: f.source,
        overwrite: true,
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    const id = randomUUID();
    await new Operations(f.c, f.cfg).run("different", {}, async () => ({}), id);
    await expect(
      f.t.upload({
        repoId: RID,
        path: "/a",
        filePath: f.source,
        requestId: id,
      }),
    ).rejects.toMatchObject({ code: "REQUEST_CONFLICT" });
  });
  it("records ambiguous upload HTTP/JSON/name/readback outcomes without automatic replay", async () => {
    const f = await transfer();
    const cases = [
      {
        response: () => new Response("", { status: 302 }),
        code: "UPLOAD_UNKNOWN",
        status: "unknown",
      },
      {
        response: () => new Response("", { status: 403 }),
        code: "UPLOAD_REJECTED",
        status: "failed",
      },
      {
        response: () => new Response("not JSON"),
        code: "VERIFY_UNKNOWN",
        status: "unknown",
      },
      {
        response: () => json({ success: true }),
        code: "UPLOAD_RENAMED",
        status: "unknown",
      },
      {
        response: () => json([{ name: "wrong", size: 3 }]),
        code: "UPLOAD_RENAMED",
        status: "unknown",
      },
      {
        response: () => json([{ name: "a.txt", size: 3, id: "wrong-id" }]),
        code: "VERIFY_UNKNOWN",
        status: "unknown",
      },
    ];
    for (const entry of cases) {
      let uploaded = false;
      f.c.info = async () =>
        uploaded
          ? {
              name: "a.txt",
              path: "/a.txt",
              type: "file",
              id: "unit-id",
              size: 3,
            }
          : undefined;
      const fetch = vi.fn(async () => {
        uploaded = true;
        return entry.response();
      });
      vi.stubGlobal("fetch", fetch);
      const input = {
        repoId: RID,
        path: "/a.txt",
        filePath: f.source,
        requestId: randomUUID(),
      };
      expect(await f.t.upload(input)).toMatchObject({
        status: entry.status,
        error: { code: entry.code },
      });
      expect(await f.t.upload(input)).toMatchObject({ status: entry.status });
      expect(fetch).toHaveBeenCalledTimes(1);
    }
  });
  it("detects source mutation between hashing and upload without submitting bytes", async () => {
    const f = await transfer();
    f.c.info = async () => undefined;
    f.c.uploadLink = async () => {
      await writeFile(f.source, "mutated");
      return "https://cloud.tsinghua.edu.cn/unit-upload";
    };
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    expect(
      await f.t.upload({ repoId: RID, path: "/a.txt", filePath: f.source }),
    ).toMatchObject({ status: "failed", error: { code: "FILE_CHANGED" } });
    expect(fetch).not.toHaveBeenCalled();
  });
});

async function mcp() {
  const f = await config({ mock: true });
  const server = await createServer(f.cfg),
    client = new Client({ name: "coverage-edges", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  await client.connect(b);
  closers.push(async () => {
    await client.close();
    await server.close();
  });
  return {
    ...f,
    client,
    server,
    call: async (name: string, args: Record<string, unknown> = {}) =>
      (await client.callTool({ name, arguments: args }))
        .structuredContent as any,
  };
}
describe("MCP protocol behavior and verification failures", () => {
  it("runs mock directory/file/share/operation tools and verifies move/copy results", async () => {
    const f = await mcp();
    expect(
      (await f.call("cloud_list_directory", { repoId: RID, path: "/" })).total,
    ).toBe(1);
    expect(
      (await f.call("cloud_search", { query: "README" })).results[0],
    ).toMatchObject({ name: "README.txt" });
    expect(
      (await f.call("cloud_read_file", { repoId: RID, path: "/README.txt" }))
        .content,
    ).toContain("离线模拟");
    const made = await f.call("cloud_create_directory", {
      repoId: RID,
      path: "/dest",
    });
    expect(made.status).toBe("complete");
    expect(
      (await f.call("cloud_operation_status", { id: made.id })).status,
    ).toBe("complete");
    expect(
      (await f.call("cloud_create_directory", { repoId: RID, path: "/dest" }))
        .error.code,
    ).toBe("CONFLICT");
    expect(
      (await f.call("cloud_create_directory", { repoId: RID, path: "/" })).error
        .code,
    ).toBe("UNSAFE_PATH");
    expect(
      (
        await f.call("cloud_create_directory", {
          repoId: RID,
          path: "/missing/child",
        })
      ).error.code,
    ).toBe("NOT_FOUND");
    const copied = await f.call("cloud_copy_item", {
      repoId: RID,
      path: "/README.txt",
      destinationRepoId: RID,
      destinationDirectory: "/dest",
    });
    expect(copied.status).toBe("complete");
    expect(
      (
        await f.call("cloud_rename_item", {
          repoId: RID,
          path: "/dest/README.txt",
          name: "copy.txt",
        })
      ).status,
    ).toBe("complete");
    expect(
      (
        await f.call("cloud_move_item", {
          repoId: RID,
          path: "/dest/copy.txt",
          destinationRepoId: RID,
          destinationDirectory: "/",
        })
      ).status,
    ).toBe("complete");
    expect(
      (
        await f.call("cloud_move_item", {
          repoId: RID,
          path: "/missing",
          destinationRepoId: RID,
          destinationDirectory: "/",
        })
      ).error.code,
    ).toBe("NOT_FOUND");
    expect(
      (
        await f.call("cloud_create_share_link", {
          repoId: RID,
          path: "/copy.txt",
          password: "unit-only",
          expireDays: 1,
        })
      ).status,
    ).toBe("complete");
    expect(
      (
        await f.call("cloud_create_share_link", {
          repoId: RID,
          path: "/absent",
        })
      ).error.code,
    ).toBe("NOT_FOUND");
    const filePath = path.join(f.root, "upload.txt");
    await writeFile(filePath, "unit");
    expect(
      (
        await f.call("cloud_upload_file", {
          repoId: RID,
          path: "/upload.txt",
          filePath,
        })
      ).status,
    ).toBe("complete");
    expect(
      (
        await f.call("cloud_download_file", {
          repoId: RID,
          path: "/upload.txt",
        })
      ).bytes,
    ).toBe(4);
    expect(
      (
        await f.call("cloud_download_file", {
          repoId: RID,
          path: "/upload.txt",
          outputDir: path.join(f.root, "other"),
        })
      ).bytes,
    ).toBe(4);
    expect(
      (
        await f.call("cloud_sync", {
          repoId: RID,
          path: "/README.txt",
          direction: "download",
          localDir: f.root,
        })
      ).code,
    ).toBe("NOT_FOUND");
  });
  it("does not confirm mkdir if acknowledgment/type or sibling changes are ambiguous", async () => {
    const f = await mcp(),
      original = MockDrive.prototype.mkdir;
    const spy = vi.spyOn(MockDrive.prototype, "mkdir");
    spy.mockImplementation(async function (this: MockDrive, id, p) {
      await original.call(this, id, p);
      return { createdPath: "/wrong" };
    });
    expect(
      (await f.call("cloud_create_directory", { repoId: RID, path: "/ack" }))
        .status,
    ).toBe("unknown");
    spy.mockImplementation(async function (this: MockDrive, id, p) {
      await original.call(this, id, p);
      await original.call(this, id, p + "-extra");
      return { createdPath: p };
    });
    expect(
      (
        await f.call("cloud_create_directory", {
          repoId: RID,
          path: "/ambiguous",
        })
      ).error.code,
    ).toBe("VERIFY_UNKNOWN");
    const info = MockDrive.prototype.info;
    spy.mockImplementation(original);
    vi.spyOn(MockDrive.prototype, "info").mockImplementation(async function (
      this: MockDrive,
      id,
      p,
    ) {
      const found = await info.call(this, id, p);
      return p === "/wrong-type" && found ? { ...found, type: "file" } : found;
    });
    expect(
      (
        await f.call("cloud_create_directory", {
          repoId: RID,
          path: "/wrong-type",
        })
      ).error.code,
    ).toBe("VERIFY_UNKNOWN");
  });
  it("leaves move unknown if the source remains after a confirmed copy-like server response", async () => {
    const f = await mcp();
    await f.call("cloud_create_directory", { repoId: RID, path: "/dest" });
    const original = MockDrive.prototype.moveCopy;
    vi.spyOn(MockDrive.prototype, "moveCopy").mockImplementation(function (
      this: MockDrive,
      _action,
      ...args
    ) {
      return original.call(this, "copy", ...args);
    });
    expect(
      (
        await f.call("cloud_move_item", {
          repoId: RID,
          path: "/README.txt",
          destinationRepoId: RID,
          destinationDirectory: "/dest",
        })
      ).error.code,
    ).toBe("VERIFY_UNKNOWN");
  });
  it("sanitizes search capabilities and handles non-object results without exposing transport metadata", async () => {
    const f = await mcp();
    vi.spyOn(MockDrive.prototype, "search").mockResolvedValue({
      results: [
        {
          obj_name: "alias",
          fullpath: "/alias",
          repo_id: RID,
          type: "file",
          download_link: "never-expose",
        },
      ],
    } as any);
    const search = await f.call("cloud_search", { query: "a" });
    expect(search.results).toEqual([
      { name: "alias", path: "/alias", repoId: RID, type: "file" },
    ]);
    expect(JSON.stringify(search)).not.toContain("never-expose");
    vi.mocked(MockDrive.prototype.search).mockResolvedValue({
      results: undefined,
    } as any);
    expect((await f.call("cloud_search", { query: "a" })).results).toEqual([]);
    vi.spyOn(TransferService.prototype, "read").mockResolvedValue(
      "unit-result" as any,
    );
    expect(
      await f.call("cloud_read_file", { repoId: RID, path: "/README.txt" }),
    ).toEqual({ result: "unit-result" });
  });
  it("checks sync-job ownership without starting a worker and keeps private tools fail-closed in mock mode", async () => {
    const f = await mcp(),
      id = randomUUID();
    const record = {
      id,
      status: "complete",
      options: { accountId: "someone-else" },
    };
    await atomicJson(path.join(f.cfg.stateDir, "jobs", id + ".json"), record);
    expect((await f.call("cloud_sync_status", { id })).code).toBe("NOT_FOUND");
    await atomicJson(path.join(f.cfg.stateDir, "jobs", id + ".json"), {
      ...record,
      options: { accountId: "local-mock-account" },
    });
    expect((await f.call("cloud_sync_status", { id })).status).toBe("complete");
    expect(
      (await f.call("cloud_workspace_status")).storage.privacy.verified,
    ).toBe(false);
    const privateArgs = {
      accountId: "0".repeat(32),
      sessionId: OTHER,
      path: "file.txt",
    };
    expect(
      (
        await f.call("cloud_workspace_init", {
          accountId: privateArgs.accountId,
          expectedRepoId: RID,
        })
      ).code,
    ).toBe("PRIVACY_UNSUPPORTED");
    expect((await f.call("cloud_workspace_list", privateArgs)).code).toBe(
      "PRIVACY_UNSUPPORTED",
    );
    expect((await f.call("cloud_workspace_pull", privateArgs)).code).toBe(
      "PRIVACY_UNSUPPORTED",
    );
    const sourcePath = path.join(f.root, "private.txt");
    await writeFile(sourcePath, "owned");
    expect(
      (await f.call("cloud_workspace_push", { ...privateArgs, sourcePath }))
        .code,
    ).toBe("PRIVACY_UNSUPPORTED");
  });
});

it("constructs the actual stdio server with connection isolated from the host stdin", async () => {
  const { cfg } = await config({ mock: true });
  const { McpServer } = await import("@modelcontextprotocol/sdk/server/mcp.js");
  const connected = vi
    .spyOn(McpServer.prototype, "connect")
    .mockResolvedValue();
  const server = await serve(cfg);
  expect(connected).toHaveBeenCalledTimes(1);
  expect(connected.mock.calls[0][0].constructor.name).toBe(
    "StdioServerTransport",
  );
  closers.push(() => server.close());
});

type CliOptions = {
  input?: string;
  tty?: boolean;
  keys?: Array<[string, { name: string; ctrl?: boolean }]>;
};
async function runCli(args: string[], options: CliOptions = {}) {
  const f = await config({ mock: true });
  const input = Object.assign(new PassThrough(), {
    isTTY: Boolean(options.tty),
    setRawMode: vi.fn(),
  });
  const output: string[] = [],
    errors: string[] = [];
  const mocks = {
    serve: vi.fn(async () => ({})),
    runJob: vi.fn(async () => undefined),
    browserLogin: vi.fn(async () => ({ unitBrowser: true })),
    installClients: vi.fn(async () => ({ unitInstall: true })),
  };
  const previousArgv = process.argv,
    previousExit = process.exitCode;
  const stderr = vi.spyOn(process.stderr, "write").mockImplementation(((
    chunk: unknown,
  ) => {
    errors.push(String(chunk));
    return true;
  }) as any);
  vi.stubEnv("THU_CLOUD_STATE_DIR", f.cfg.stateDir);
  vi.stubEnv("THU_CLOUD_OUTPUT_DIR", f.cfg.outputDir);
  vi.stubEnv("THU_CLOUD_MOCK", "1");
  vi.resetModules();
  vi.doMock("node:process", async () => ({
    ...(await vi.importActual<any>("node:process")),
    stdin: input,
    stdout: {
      write: (chunk: unknown) => {
        output.push(String(chunk));
        return true;
      },
    },
  }));
  vi.doMock("../src/server.js", () => ({ serve: mocks.serve }));
  vi.doMock("../src/jobs.js", () => ({ runJob: mocks.runJob }));
  vi.doMock("../src/browser-auth.js", () => ({
    browserLogin: mocks.browserLogin,
  }));
  vi.doMock("../src/install.js", () => ({
    installClients: mocks.installClients,
  }));
  process.argv = [process.execPath, "owned-cli-test", ...args];
  if (options.input !== undefined) input.end(options.input);
  try {
    await import("../src/cli.js");
    if (options.keys) {
      await vi.waitFor(
        () => expect(input.setRawMode).toHaveBeenCalledWith(true),
        { timeout: 10000 },
      );
      for (const [str, key] of options.keys)
        input.emit("keypress", str, { ctrl: false, ...key });
    }
    await vi.waitFor(
      () => {
        if (args[0] === "serve") expect(mocks.serve).toHaveBeenCalledTimes(1);
        else if (args[0] === "worker")
          expect(mocks.runJob).toHaveBeenCalledTimes(1);
        else if (args[0] === "auth" && args[1] === "browser")
          expect(output.join("")).toContain('"unitBrowser": true');
        else if (options.keys)
          expect(
            output.join("").includes('"configured"') || errors.length > 0,
          ).toBe(true);
        else expect(output.length + errors.length).toBeGreaterThan(0);
      },
      { timeout: 15000, interval: 10 },
    );
    return {
      ...f,
      mocks,
      output: output.join(""),
      errors: errors.join(""),
      exitCode: process.exitCode,
      rawModes: input.setRawMode.mock.calls.map((call) => call[0]),
    };
  } finally {
    process.argv = previousArgv;
    process.exitCode = previousExit;
    stderr.mockRestore();
    input.destroy();
    for (const module of [
      "node:process",
      "../src/server.js",
      "../src/jobs.js",
      "../src/browser-auth.js",
      "../src/install.js",
    ])
      vi.doUnmock(module);
    vi.resetModules();
  }
}

describe("CLI dispatch and input boundaries using the actual entry module", () => {
  it("prints default help and mock diagnostic/library/local-auth status from owned state", async () => {
    expect((await runCli([])).output).toContain("thu-cloud MCP");
    expect((await runCli(["unknown-command"])).output).toContain(
      "auth import --stdin",
    );
    for (const command of ["status", "doctor"]) {
      const f = await runCli([command]);
      expect(JSON.parse(f.output)).toMatchObject({
        mode: "mock",
        node: process.version,
        stateDir: f.cfg.stateDir,
        outputDir: f.cfg.outputDir,
      });
    }
    expect(
      JSON.parse((await runCli(["libraries"])).output).libraries[0].id,
    ).toBe(RID);
    expect(
      JSON.parse((await runCli(["auth", "status"])).output).configured,
    ).toBe(false);
    expect(JSON.parse((await runCli(["auth", "logout"])).output)).toEqual({
      configured: false,
    });
  });
  it("dispatches serve, worker, installer and browser arguments only to isolated boundaries", async () => {
    const served = await runCli(["serve"]);
    expect(served.mocks.serve).toHaveBeenCalledWith(
      expect.objectContaining({ stateDir: served.cfg.stateDir }),
    );
    const worker = await runCli(["worker", OTHER]);
    expect(worker.mocks.runJob).toHaveBeenCalledWith(
      expect.objectContaining({ stateDir: worker.cfg.stateDir }),
      OTHER,
    );
    for (const [args, expected] of [
      [["install"], { apply: false, uninstall: false }],
      [["install", "--apply"], { apply: true, uninstall: false }],
      [["install", "preview", "--apply"], { apply: true, uninstall: false }],
      [["uninstall", "--apply"], { apply: true, uninstall: true }],
    ] as const) {
      const f = await runCli([...args]);
      expect(f.mocks.installClients).toHaveBeenCalledWith(expected);
      expect(JSON.parse(f.output)).toEqual({ unitInstall: true });
    }
    const automatic = await runCli(["auth", "browser"]);
    expect(automatic.mocks.browserLogin.mock.calls[0][1]).toBeUndefined();
    const chrome = await runCli(["auth", "browser", "--channel", "chrome"]);
    expect(chrome.mocks.browserLogin.mock.calls[0][1]).toBe("chrome");
  });
  it("rejects non-TTY login, unsupported auth usage and oversized stdin before network", async () => {
    const fetch = vi.fn(async () => {
      throw new Error("must not reach network");
    });
    vi.stubGlobal("fetch", fetch);
    for (const [args, input, code] of [
      [["auth", "login"], undefined, "TTY_REQUIRED"],
      [["auth", "import"], undefined, "AUTH_USAGE"],
      [["auth", "wrong"], undefined, "AUTH_USAGE"],
      [["auth", "import", "--stdin"], "x".repeat(2049), "AUTH_FORMAT"],
    ] as const) {
      const f = await runCli([...args], { input });
      expect(JSON.parse(f.errors).code).toBe(code);
      expect(f.exitCode).toBe(1);
    }
    expect(fetch).not.toHaveBeenCalled();
  });
  it("imports only validated stdin tokens and prints no credential bytes", async () => {
    const fetch = vi.fn(async (u: string, init: RequestInit) => {
      expect(new URL(u).pathname).toBe("/api2/account/info/");
      expect(new Headers(init.headers).get("authorization")).toBe(
        "Token " + TOKEN,
      );
      return json({ email: "cli-unit@example.test" });
    });
    vi.stubGlobal("fetch", fetch);
    const f = await runCli(["auth", "import", "--stdin"], {
      input: "  " + TOKEN + "\n",
    });
    expect(JSON.parse(f.output)).toMatchObject({
      configured: true,
      verified: true,
      mode: "account",
      protection: "Windows-DPAPI",
    });
    expect(f.output).not.toContain(TOKEN);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect((await new AuthStore(f.cfg.stateDir).status()).configured).toBe(
      true,
    );
  });
  it("handles hidden input, ignored control text, backspace and cancellation without host TTY", async () => {
    vi.stubGlobal("fetch", async () =>
      json({ email: "tty-unit@example.test" }),
    );
    const f = await runCli(["auth", "login"], {
      tty: true,
      keys: [
        [" " + TOKEN + "x", { name: "x" }],
        ["", { name: "backspace" }],
        ["ignored", { name: "z", ctrl: true }],
        ["", { name: "unknown" }],
        ["", { name: "return" }],
      ],
    });
    expect(f.output).toContain('"configured": true');
    expect(f.output).not.toContain(TOKEN);
    expect(f.rawModes).toEqual([true, false]);
    const cancelled = await runCli(["auth", "login"], {
      tty: true,
      keys: [["", { name: "c", ctrl: true }]],
    });
    expect(JSON.parse(cancelled.errors).code).toBe("CANCELLED");
    expect(cancelled.rawModes).toEqual([true, false]);
  });
});
