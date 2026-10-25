import { it, expect } from "vitest";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { AuthStore } from "../src/auth.js";
it("rejects browser commit after a legacy writer replaces auth without advancing generation", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "learnx-browser-legacy-race-"));
  try {
    const store = new AuthStore(path.join(dir, "a")),
      other = new AuthStore(path.join(dir, "b"));
    await store.save({ account: "A" });
    const epoch = await store.generation(),
      version = await store.version();
    await other.save({ account: "B" });
    await writeFile(store.file, await readFile(other.file));
    await expect(
      store.saveBrowserIfCurrent({ account: "A" }, epoch, version!),
    ).rejects.toMatchObject({ code: "AUTH_CHANGED" });
    expect((await store.load())?.account).toBe("B");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
