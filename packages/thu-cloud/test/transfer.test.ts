import { it, expect, vi } from "vitest";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { loadConfig } from "../src/config.js";
import { CloudClient } from "../src/client.js";
import { TransferService } from "../src/transfer.js";
import { Operations } from "../src/operations.js";
const rid = "11111111-1111-4111-8111-111111111111";
async function setup(
  fn: (t: TransferService, c: CloudClient, root: string) => Promise<void>,
) {
  const root = await mkdtemp(path.join(tmpdir(), "cloud-transfer-"));
  const cfg = loadConfig({
    stateDir: path.join(root, "state"),
    timeoutMs: 70,
    outputDir: root,
  });
  const c = new CloudClient(cfg);
  c.identity = "test";
  c.checkAuth = async () => {};
  c.resolveRepo = async () => ({
    id: rid,
    name: "R",
    permission: "rw",
    encrypted: false,
  });
  c.info = async () => undefined;
  c.downloadLink = async () =>
    "https://cloud.tsinghua.edu.cn/seafhttp/files/signed/a";
  c.uploadLink = async () =>
    "https://cloud.tsinghua.edu.cn/seafhttp/upload-api/signed";
  try {
    await fn(new TransferService(c, cfg), c, root);
  } finally {
    vi.unstubAllGlobals();
    await rm(root, { recursive: true, force: true });
  }
}
it("streams active bytes past the total request duration using an inactivity timeout", () =>
  setup(async (t, c) => {
    vi.useFakeTimers();
    let started!: () => void;
    const ready = new Promise<void>((r) => {
      started = r;
    });
    let timer: ReturnType<typeof setInterval>;
    try {
      c.info = async () => ({ name: "a", path: "/a", type: "file", size: 10 });
      vi.stubGlobal(
        "fetch",
        async (_u: string, init: RequestInit) =>
          new Response(
            new ReadableStream({
              start(ctrl) {
                let n = 0;
                timer = setInterval(() => {
                  ctrl.enqueue(new Uint8Array([65]));
                  if (++n === 10) {
                    clearInterval(timer);
                    ctrl.close();
                  }
                }, 20);
                init.signal?.addEventListener("abort", () => {
                  clearInterval(timer);
                  ctrl.error(new Error("aborted"));
                });
                started();
              },
              cancel() {
                clearInterval(timer);
              },
            }),
            { headers: { "content-length": "10" } },
          ),
      );
      const result = t.read(rid, "/a");
      await ready;
      await vi.advanceTimersByTimeAsync(200);
      expect((await result).content).toBe("AAAAAAAAAA");
    } finally {
      vi.useRealTimers();
    }
  }));
it("aborts a stalled download when its inactivity deadline expires", () =>
  setup(async (t, c) => {
    vi.useFakeTimers();
    let started!: () => void;
    const ready = new Promise<void>((r) => {
      started = r;
    });
    try {
      c.info = async () => ({ name: "a", path: "/a", type: "file", size: 10 });
      vi.stubGlobal(
        "fetch",
        async (_u: string, init: RequestInit) =>
          new Response(
            new ReadableStream({
              start(ctrl) {
                init.signal?.addEventListener("abort", () =>
                  ctrl.error(new Error("idle timeout")),
                );
                started();
              },
            }),
          ),
      );
      const outcome = t.read(rid, "/a").then(
        () => false,
        (e) => e.message,
      );
      await ready;
      await vi.advanceTimersByTimeAsync(71);
      expect(await outcome).toBe("idle timeout");
    } finally {
      vi.useRealTimers();
    }
  }));
it("does not replace an existing file with a truncated transfer or login HTML", () =>
  setup(async (t, c, root) => {
    await writeFile(path.join(root, "a"), "old");
    c.info = async () => ({ name: "a", path: "/a", type: "file", size: 10 });
    vi.stubGlobal(
      "fetch",
      async () => new Response("x", { headers: { "content-length": "10" } }),
    );
    await expect(
      t.download({ repoId: rid, path: "/a", outputDir: root, overwrite: true }),
    ).rejects.toThrow(/大小/);
    expect(await readFile(path.join(root, "a"), "utf8")).toBe("old");
    vi.stubGlobal(
      "fetch",
      async () =>
        new Response('<html><input type="password"></html>', {
          headers: { "content-type": "text/html" },
        }),
    );
    await expect(
      t.download({ repoId: rid, path: "/a", outputDir: root, overwrite: true }),
    ).rejects.toThrow();
  }));
it("uploads a local binary path once and records an unknown response without replay", () =>
  setup(async (t, c, root) => {
    const f = path.join(root, "binary.dat");
    await writeFile(f, new Uint8Array([0, 255, 13, 10]));
    let calls = 0;
    vi.stubGlobal("fetch", async (_u: string, init: RequestInit) => {
      calls++;
      expect(new Headers(init.headers).has("Authorization")).toBe(false);
      expect((init.body as FormData).get("replace")).toBe("0");
      throw new Error("lost response");
    });
    const requestId = "22222222-2222-4222-8222-222222222222";
    const input = { repoId: rid, path: "/binary.dat", filePath: f, requestId };
    expect((await t.upload(input)).status).toBe("unknown");
    expect((await t.upload(input)).status).toBe("unknown");
    expect(calls).toBe(1);
    const op = await new Operations(
      c,
      loadConfig({ stateDir: path.join(root, "state") }),
    ).get(requestId);
    expect(op.status).toBe("unknown");
  }));
it("rejects uploads that would overwrite without explicit authorization", () =>
  setup(async (t, c, root) => {
    const f = path.join(root, "a");
    await writeFile(f, "hi");
    c.info = async () => ({ name: "a", path: "/a", type: "file", size: 2 });
    await expect(
      t.upload({ repoId: rid, path: "/a", filePath: f }),
    ).rejects.toThrow(/覆盖/);
  }));

it("does not confirm the requested path when Seafile renamed an upload on a collision", () =>
  setup(async (t, c, root) => {
    const f = path.join(root, "a.txt");
    await writeFile(f, "hi");
    let uploaded = false;
    c.info = async () =>
      uploaded
        ? { name: "a.txt", path: "/a.txt", type: "file", size: 2, id: "old" }
        : undefined;
    vi.stubGlobal("fetch", async () => {
      uploaded = true;
      return Response.json([{ name: "a (1).txt", size: 2, id: "new" }]);
    });
    const receipt = await t.upload({
      repoId: rid,
      path: "/a.txt",
      filePath: f,
    });
    expect(receipt.status).toBe("unknown");
  }));
it("refuses a signed-link redirect outside the cloud without forwarding credentials", () =>
  setup(async (t, c, root) => {
    c.info = async () => ({ name: "a", path: "/a", type: "file", size: 2 });
    let calls = 0;
    vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
      calls++;
      expect(new Headers(init.headers).has("Authorization")).toBe(false);
      return new Response(null, {
        status: 302,
        headers: { location: "https://evil.example/file" },
      });
    });
    await expect(
      t.download({ repoId: rid, path: "/a", outputDir: root }),
    ).rejects.toThrow(/同源/);
    expect(calls).toBe(1);
  }));
it("leaves the destination untouched if authentication is revoked while streaming", () =>
  setup(async (t, c, root) => {
    await writeFile(path.join(root, "a"), "original");
    c.info = async () => ({ name: "a", path: "/a", type: "file", size: 2 });
    let checks = 0;
    const { CloudError } = await import("../src/types.js");
    c.checkAuth = async () => {
      if (++checks > 1) throw new CloudError("AUTH_CHANGED", "认证已变化。");
    };
    vi.stubGlobal(
      "fetch",
      async () => new Response("hi", { headers: { "content-length": "2" } }),
    );
    await expect(
      t.download({ repoId: rid, path: "/a", outputDir: root, overwrite: true }),
    ).rejects.toThrow(/认证/);
    expect(await readFile(path.join(root, "a"), "utf8")).toBe("original");
  }));
it("rejects local alternate streams and reserved names before download", () =>
  setup(async (t, c, root) => {
    c.info = async () => ({ name: "a", path: "/a", type: "file", size: 2 });
    for (const filename of ["a:secret", "CON", "trailing."])
      await expect(
        t.download({ repoId: rid, path: "/a", outputDir: root, filename }),
      ).rejects.toThrow(/文件名/);
  }));

it("does not label a response shorter than file metadata as complete text", () =>
  setup(async (t, c) => {
    c.info = async () => ({
      name: "a.txt",
      path: "/a.txt",
      type: "file",
      size: 10,
    });
    vi.stubGlobal("fetch", async () => new Response("hi"));
    await expect(t.read(rid, "/a.txt")).rejects.toThrow(/大小/);
  }));
it("reads and downloads a genuine HTML report but rejects an authentication page", () =>
  setup(async (t, c, root) => {
    const html = "<!doctype html><html><body>report</body></html>";
    c.info = async () => ({
      name: "report.html",
      path: "/report.html",
      type: "file",
      size: Buffer.byteLength(html),
    });
    vi.stubGlobal(
      "fetch",
      async () =>
        new Response(html, { headers: { "content-type": "text/html" } }),
    );
    expect((await t.read(rid, "/report.html")).content).toBe(html);
    expect(
      await readFile(
        (
          await t.download({
            repoId: rid,
            path: "/report.html",
            outputDir: root,
          })
        ).filePath,
        "utf8",
      ),
    ).toBe(html);
    const login =
      '<html><form action="https://id.tsinghua.edu.cn/login"><input type="password" name="password"></form></html>';
    c.info = async () => ({
      name: "report.html",
      path: "/report.html",
      type: "file",
      size: Buffer.byteLength(login),
    });
    vi.stubGlobal(
      "fetch",
      async () =>
        new Response(login, { headers: { "content-type": "text/html" } }),
    );
    await expect(t.read(rid, "/report.html")).rejects.toThrow(/登录/);
  }));
