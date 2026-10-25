import { it, expect, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { AuthStore } from "../src/auth.js";
import { RainClient } from "../src/client.js";
import { loadConfig } from "../src/config.js";
it("sends credentials only to pro.yuketang.cn and binds the original authentication generation", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "hetang-client-"));
  const store = new AuthStore(root);
  try {
    await store.save({
      account: "test",
      userId: "test",
      cookieHeader: "sessionid=unit-test",
      bearerToken: "unit-test",
    });
    const c = new RainClient(loadConfig({ stateDir: root }));
    vi.stubGlobal("fetch", async (u: string, init: RequestInit) => {
      expect(new URL(u).origin).toBe("https://pro.yuketang.cn");
      expect(new Headers(init.headers).get("cookie")).toContain(
        "sessionid=unit-test",
      );
      return Response.json({ code: 0, data: { onLessonClassrooms: [] } });
    });
    expect(await c.active()).toEqual([]);
    await expect(c.request("https://evil.example/x")).rejects.toThrow(/同源/);
    await store.clear();
    await expect(c.active()).rejects.toThrow(/认证/);
    await store.save({
      account: "B",
      userId: "B",
      cookieHeader: "sessionid=other",
    });
    await expect(c.active()).rejects.toThrow(/认证/);
  } finally {
    vi.unstubAllGlobals();
    await rm(root, { recursive: true, force: true });
  }
});
