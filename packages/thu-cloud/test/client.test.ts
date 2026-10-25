import { it, expect, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { AuthStore } from "../src/auth.js";
import { CloudClient, remotePath, trustedUrl } from "../src/client.js";
import { loadConfig } from "../src/config.js";
const rid = "11111111-1111-4111-8111-111111111111";
async function setup(
  fn: (c: CloudClient, s: AuthStore) => Promise<void>,
  mode: "account" | "repo" = "account",
) {
  const root = await mkdtemp(path.join(tmpdir(), "cloud-client-"));
  const s = new AuthStore(root);
  await s.save({
    account: "test",
    token: "unit-test-only-token",
    mode,
    repoId: mode === "repo" ? rid : undefined,
  });
  try {
    await fn(new CloudClient(loadConfig({ stateDir: root })), s);
  } finally {
    vi.unstubAllGlobals();
    await rm(root, { recursive: true, force: true });
  }
}
it("uses account Token auth and stops after logout", () =>
  setup(async (c, s) => {
    vi.stubGlobal("fetch", async (u: string, init: RequestInit) => {
      expect(new URL(u).origin).toBe("https://cloud.tsinghua.edu.cn");
      expect(new Headers(init.headers).get("Authorization")).toBe(
        "Token unit-test-only-token",
      );
      return Response.json([
        { id: rid, name: "课程", permission: "rw", encrypted: false },
      ]);
    });
    expect((await c.libraries())[0].name).toBe("课程");
    expect(JSON.stringify(await s.status())).not.toContain("unit-test");
    const disk = await import("node:fs/promises");
    expect(await disk.readFile(s.file, "utf8")).not.toContain("unit-test");
    await s.clear();
    await expect(c.libraries()).rejects.toThrow(/认证已变化/);
  }));
it("uses library-token endpoints and rejects a different repository", () =>
  setup(async (c) => {
    vi.stubGlobal("fetch", async (u: string) => {
      const p = new URL(u).pathname;
      expect(p).toContain("/via-repo-token/");
      return Response.json(
        p.endsWith("repo-info/")
          ? { repo_id: rid, repo_name: "Scoped", permission: "rw" }
          : {
              user_perm: "rw",
              dirent_list: [
                { name: "a.txt", type: "file", id: "abc", size: 3 },
              ],
            },
      );
    });
    expect((await c.list(rid, "/")).items[0].name).toBe("a.txt");
    await expect(
      c.list("22222222-2222-4222-8222-222222222222", "/"),
    ).rejects.toThrow(/资料库/);
  }, "repo"));
it("refuses cross-origin and encoded traversal inputs", () => {
  for (const p of ["/../x", "/a/../../x", "/a\\b", "/%2e%2e/x", "/a\u0000b"])
    expect(() => remotePath(p)).toThrow();
  for (const u of [
    "http://cloud.tsinghua.edu.cn/x",
    "https://evil.example/x",
    "https://cloud.tsinghua.edu.cn:444/x",
    "https://user:pass@cloud.tsinghua.edu.cn/x",
  ])
    expect(() => trustedUrl(u)).toThrow();
  expect(remotePath("/中文/空 格.txt")).toBe("/中文/空 格.txt");
});
it("slices complete directory lists locally and rejects encrypted libraries", () =>
  setup(async (c) => {
    let encrypted = false;
    vi.stubGlobal("fetch", async (u: string) =>
      Response.json(
        new URL(u).pathname === "/api2/repos/"
          ? [{ id: rid, name: "R", permission: "rw", encrypted }]
          : [
              { name: "repeat", type: "file", id: "a", size: 1 },
              { name: "again", type: "file", id: "b", size: 1 },
            ],
      ),
    );
    expect((await c.list(rid, "/", 1, 1)).items[0].name).toBe("again");
    encrypted = true;
    await expect(c.list(rid, "/")).rejects.toThrow(/加密/);
  }));

it("copies directories using the synchronous batch API and checks per-item outcomes", () =>
  setup(async (c) => {
    await c.checkAuth();
    c.resolveRepo = async () => ({
      id: rid,
      name: "R",
      permission: "rw",
      encrypted: false,
    });
    c.info = async (_id, p) =>
      p === "/folder"
        ? { name: "folder", path: p, type: "dir" }
        : p === "/dest"
          ? { name: "dest", path: p, type: "dir" }
          : undefined;
    vi.stubGlobal("fetch", async (u: string, init: RequestInit) => {
      expect(new URL(u).pathname).toBe("/api/v2.1/repos/sync-batch-copy-item/");
      expect(JSON.parse(String(init.body))).toMatchObject({
        src_repo_id: rid,
        src_parent_dir: "/",
        src_dirents: ["folder"],
        dst_repo_id: rid,
        dst_parent_dir: "/dest",
      });
      return Response.json({ success: [], failed: [{ error: "permission" }] });
    });
    await expect(
      c.moveCopy("copy", rid, "/folder", rid, "/dest"),
    ).rejects.toThrow(/未确认/);
  }));

it("stops an in-flight operation even if another concurrent check observes a new login", () =>
  setup(async (c, s) => {
    let release!: () => void;
    let started!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const ready = new Promise<void>((r) => {
      started = r;
    });
    vi.stubGlobal("fetch", async () => {
      started();
      await gate;
      return Response.json([{ id: rid, name: "A", permission: "rw" }]);
    });
    const pending = c.libraries();
    await ready;
    await s.save({
      account: "B",
      token: "other-unit-test-token",
      mode: "account",
    });
    await c.checkAuth().catch(() => {});
    await c.checkAuth().catch(() => {});
    release();
    await expect(pending).rejects.toThrow(/认证/);
  }));
it("does not restore a pending save after logout", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "cloud-logout-save-"));
  const s = new AuthStore(root);
  try {
    const pending = s
      .save({ account: "test", token: "unit-test-only-token", mode: "account" })
      .catch(() => {});
    await s.clear();
    await pending;
    expect((await s.status()).configured).toBe(false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
it("handles the documented successful API2 file rename without replaying or following redirects", () =>
  setup(async (c) => {
    await c.checkAuth();
    c.resolveRepo = async () => ({
      id: rid,
      name: "R",
      permission: "rw",
      encrypted: false,
    });
    c.info = async (_id, p) =>
      p === "/old.txt"
        ? { name: "old.txt", path: p, type: "file", id: "source" }
        : undefined;
    let calls = 0;
    vi.stubGlobal("fetch", async (u: string) => {
      calls++;
      return new URL(u).searchParams.get("reloaddir") === "true"
        ? Response.json([])
        : new Response(JSON.stringify("success"), {
            status: 301,
            headers: {
              Location: `https://cloud.tsinghua.edu.cn/api2/repos/${rid}/file/?p=/new.txt`,
            },
          });
    });
    await expect(c.rename(rid, "/old.txt", "new.txt")).resolves.toBeDefined();
    expect(calls).toBe(1);
  }));

it("does not let a previously started login commit after logout of an empty store", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "cloud-login-generation-"));
  const store = new AuthStore(root);
  try {
    const generation = await store.generation();
    await store.clear();
    await expect(
      store.saveIfCurrent(
        { account: "test", token: "unit-test-only-token", mode: "account" },
        generation,
      ),
    ).rejects.toThrow(/认证/);
    expect((await store.status()).configured).toBe(false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
