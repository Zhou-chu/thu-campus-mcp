import { it, expect } from "vitest";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { MockDrive, MOCK_REPO } from "../src/mock.js";
import { loadConfig } from "../src/config.js";
import { TransferService } from "../src/transfer.js";
import { SyncService } from "../src/sync.js";
it("roundtrips binary files and incrementally repairs corrupted downloads", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "cloud-sync-"));
  const cfg = loadConfig({
    stateDir: path.join(root, "state"),
    mock: true,
    outputDir: path.join(root, "out"),
  });
  try {
    const c = new MockDrive(cfg);
    const t = new TransferService(c, cfg);
    const f = path.join(root, "binary.dat");
    await writeFile(f, new Uint8Array([0, 255, 12, 9]));
    expect(
      (await t.upload({ repoId: MOCK_REPO, path: "/binary.dat", filePath: f }))
        .status,
    ).toBe("complete");
    const sync = new SyncService(c, cfg);
    const input = {
      direction: "download" as const,
      repoId: MOCK_REPO,
      path: "/",
      localDir: cfg.outputDir,
    };
    expect((await sync.run(input)).status).toBe("complete");
    expect((await sync.run(input)).skipped).toBe(2);
    await writeFile(path.join(cfg.outputDir, "binary.dat"), "corrupt");
    expect((await sync.run(input)).transferred).toBe(1);
    expect([
      ...(await readFile(path.join(cfg.outputDir, "binary.dat"))),
    ]).toEqual([0, 255, 12, 9]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
it("uploads an incremental directory and reports unknown-name conflicts without overwriting", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "cloud-sync-up-"));
  const cfg = loadConfig({ stateDir: path.join(root, "state"), mock: true });
  try {
    const c = new MockDrive(cfg);
    await c.mkdir(MOCK_REPO, "/target");
    const local = path.join(root, "local");
    await (await import("node:fs/promises")).mkdir(local);
    await writeFile(path.join(local, "x.txt"), "hello");
    const sync = new SyncService(c, cfg);
    const input = {
      direction: "upload" as const,
      repoId: MOCK_REPO,
      path: "/target",
      localDir: local,
    };
    expect((await sync.run(input)).transferred).toBe(1);
    expect((await sync.run(input)).skipped).toBe(1);
    await writeFile(path.join(local, "x.txt"), "updated");
    expect((await sync.run(input)).status).toBe("partial");
    expect((await sync.run({ ...input, overwrite: true })).transferred).toBe(1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("restores remote files that disappeared even when the API omits object IDs", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "cloud-sync-ids-"));
  const cfg = loadConfig({ stateDir: path.join(root, "state"), mock: true });
  try {
    const c = new MockDrive(cfg);
    const original = c.info.bind(c);
    let missing = false;
    c.info = async (id, p) => {
      if (missing && p === "/x.txt") return undefined;
      const r = await original(id, p);
      return r ? { ...r, id: undefined } : r;
    };
    const local = path.join(root, "local");
    await (await import("node:fs/promises")).mkdir(local);
    await writeFile(path.join(local, "x.txt"), "data");
    const sync = new SyncService(c, cfg);
    const input = {
      direction: "upload" as const,
      repoId: MOCK_REPO,
      path: "/",
      localDir: local,
    };
    // Upload verification uses the returned object ID when present; omit it from this mock response as well.
    const req = c.transferRequest.bind(c);
    c.transferRequest = async (u, i) => {
      const r = await req(u, i);
      if (i?.method === "POST")
        return Response.json([{ name: "x.txt", size: 4 }]);
      return r;
    };
    expect((await sync.run(input)).transferred).toBe(1);
    missing = true;
    const r = await sync.run(input);
    expect(r.skipped).toBe(0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
it("reports traversal limits as partial and rejects a queued task from another account", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "cloud-sync-limits-"));
  const cfg = loadConfig({ stateDir: path.join(root, "state"), mock: true });
  try {
    const c = new MockDrive(cfg);
    await c.mkdir(MOCK_REPO, "/child");
    const sync = new SyncService(c, cfg);
    const input = {
      repoId: MOCK_REPO,
      path: "/",
      direction: "download" as const,
      localDir: path.join(root, "out"),
    };
    const result = await sync.run({ ...input, maxFiles: 1 });
    expect(result.status).toBe("partial");
    expect(result.errors[0].code).toBe("SYNC_LIMIT");
    await expect(
      sync.run({ ...input, accountId: "different-account" }),
    ).rejects.toThrow(/另一账号/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("keeps Windows-equivalent remote names in separate stable local paths", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "cloud-case-"));
  const cfg = loadConfig({ stateDir: path.join(root, "state"), mock: true });
  try {
    const c = new MockDrive(cfg);
    await c.mkdir(MOCK_REPO, "/docs");
    const transfer = new TransferService(c, cfg);
    for (const name of ["A.txt", "a.txt"]) {
      const local = path.join(root, "input");
      await writeFile(local, name);
      expect(
        (
          await transfer.upload({
            repoId: MOCK_REPO,
            path: "/docs/" + name,
            filePath: local,
          })
        ).status,
      ).toBe("complete");
    }
    const sync = new SyncService(c, cfg);
    const localDir = path.join(root, "out");
    const input = {
      repoId: MOCK_REPO,
      path: "/docs",
      direction: "download" as const,
      localDir,
      overwrite: true,
    };
    expect((await sync.run(input)).status).toBe("complete");
    const fs = await import("node:fs/promises");
    const files = (await fs.readdir(localDir)).filter(
      (n) => !n.startsWith(".thu-cloud"),
    );
    expect(files).toHaveLength(2);
    expect(
      new Set(
        await Promise.all(
          files.map((n) => readFile(path.join(localDir, n), "utf8")),
        ),
      ),
    ).toEqual(new Set(["A.txt", "a.txt"]));
    expect((await sync.run(input)).skipped).toBe(2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
