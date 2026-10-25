import { it, expect, vi } from "vitest";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  downloadResource,
  validateAssetUrl,
  verifyManifestFiles,
  resolveAssetAddresses,
} from "../src/resources.js";
it("resolves proxy Fake-IP through public DNS and refuses private DNS answers", async () => {
  const options = {
    lookup: async () => [{ address: "198.18.0.99", family: 4 }],
    fetcher: async () =>
      Response.json({
        Status: 0,
        Answer: [{ type: 1, data: "8.8.8.8", TTL: 60 }],
      }),
  };
  expect(await resolveAssetAddresses("content.xuetangx.com", options)).toEqual([
    { address: "8.8.8.8", family: 4 },
  ]);
  await expect(
    resolveAssetAddresses("content.xuetangx.com", {
      ...options,
      fetcher: async () =>
        Response.json({ Status: 0, Answer: [{ type: 1, data: "127.0.0.1" }] }),
    }),
  ).rejects.toThrow();
});
import { loadConfig } from "../src/config.js";
it("rejects local network targets and non-HTTPS asset URLs", async () => {
  for (const url of [
    "http://cdn.xuetangx.com/a",
    "https://127.0.0.1/a",
    "https://[::1]/a",
    "https://192.168.1.1/a",
    "https://user:pass@cdn.xuetangx.com/a",
    "https://evil.example/a",
  ])
    await expect(validateAssetUrl(url)).rejects.toThrow();
  expect(
    (
      await validateAssetUrl("https://content.xuetangx.com/a.jpg", async () => [
        { address: "8.8.8.8", family: 4 },
      ])
    ).protocol,
  ).toBe("https:");
});
it("downloads CDN bytes without forwarding credentials and preserves old files on failure", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "hetang-download-"));
  const cfg = loadConfig({ stateDir: root, outputDir: root });
  const resource = {
    id: "file1",
    lessonId: "lesson1",
    kind: "slide" as const,
    title: "课件",
    url: "https://content.xuetangx.com/1.jpg",
    index: 1,
  };
  try {
    vi.stubGlobal("fetch", async (_u: string, init: RequestInit) => {
      expect(new Headers(init.headers).get("Cookie")).toBeNull();
      return new Response("hi", {
        headers: { "content-length": "2", "content-type": "image/jpeg" },
      });
    });
    const r = await downloadResource(
      resource,
      path.join(root, "a.jpg"),
      cfg,
      async () => true,
      {
        resolve: async () => [{ address: "8.8.8.8", family: 4 }],
        fetcher: fetch,
      },
    );
    expect(r.bytes).toBe(2);
    expect(await readFile(r.filePath, "utf8")).toBe("hi");
    vi.stubGlobal(
      "fetch",
      async () => new Response("bad", { headers: { "content-length": "10" } }),
    );
    await expect(
      downloadResource(
        resource,
        path.join(root, "b.jpg"),
        cfg,
        async () => true,
        {
          resolve: async () => [{ address: "8.8.8.8", family: 4 }],
          fetcher: fetch,
        },
      ),
    ).rejects.toThrow();
    expect(await readFile(r.filePath, "utf8")).toBe("hi");
  } finally {
    vi.unstubAllGlobals();
    await rm(root, { recursive: true, force: true });
  }
});
it("refuses archive manifests that reference arbitrary files or changed content", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "hetang-manifest-"));
  try {
    await writeFile(path.join(root, "a.txt"), "data");
    await expect(
      verifyManifestFiles(
        {
          root,
          accountId: "self",
          files: [{ relative: "../other", sha256: "x" }],
        },
        "self",
      ),
    ).rejects.toThrow();
    await expect(
      verifyManifestFiles({ root, accountId: "other", files: [] }, "self"),
    ).rejects.toThrow();
    await expect(
      verifyManifestFiles(
        {
          root,
          accountId: "self",
          files: [{ relative: "a.txt", sha256: "wrong" }],
        },
        "self",
      ),
    ).rejects.toThrow();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
