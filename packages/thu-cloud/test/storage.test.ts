import { it, expect, vi } from "vitest";
import { mkdtemp, mkdir, symlink, rm, rename } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { guardedPath, atomicJson, readJson } from "../src/storage.js";
vi.mock("node:fs/promises", async (original) => {
  const actual = await original<typeof import("node:fs/promises")>();
  return { ...actual, rename: vi.fn(actual.rename) };
});
it.skipIf(process.platform !== "win32")(
  "retries Windows sharing violations when atomically replacing JSON",
  async () => {
    const root = await mkdtemp(path.join(tmpdir(), "cloud-share-"));
    const file = path.join(root, "state.json");
    try {
      await atomicJson(file, { n: 0 });
      vi.mocked(rename).mockClear();
      vi.mocked(rename)
        .mockRejectedValueOnce(
          Object.assign(new Error("sharing violation"), { code: "EPERM" }),
        )
        .mockRejectedValueOnce(
          Object.assign(new Error("busy"), { code: "EBUSY" }),
        );
      await atomicJson(file, { n: 1 });
      expect(await readJson(file)).toEqual({ n: 1 });
      expect(rename).toHaveBeenCalledTimes(3);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
it("rejects output traversal and junctions inside the selected directory", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "cloud-path-"));
  try {
    await mkdir(path.join(root, "allowed"));
    await mkdir(path.join(root, "outside"));
    await symlink(
      path.join(root, "outside"),
      path.join(root, "allowed", "junction"),
      "junction",
    );
    await expect(
      guardedPath(path.join(root, "allowed"), "../outside/a"),
    ).rejects.toThrow(/路径/);
    await expect(
      guardedPath(path.join(root, "allowed"), "junction/a"),
    ).rejects.toThrow(/链接/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
