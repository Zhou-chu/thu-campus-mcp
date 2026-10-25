import { it, expect } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { AuthStore } from "../src/auth.js";
it("does not let a first browser login restore credentials after logout of an empty store", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "learnx-browser-generation-"));
  try {
    const store = new AuthStore(dir);
    const epoch = await store.generation();
    await store.clear();
    await expect(
      store.saveBrowserIfCurrent({ account: "example" }, epoch),
    ).rejects.toMatchObject({ code: "AUTH_CHANGED" });
    expect(await store.load()).toBeUndefined();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
