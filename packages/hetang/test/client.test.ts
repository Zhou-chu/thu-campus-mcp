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
it("uses the official source marker when checking into an active lesson", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "hetang-checkin-source-"));
  const store = new AuthStore(root);
  try {
    await store.save({
      account: "test",
      userId: "test",
      cookieHeader: "sessionid=unit-test",
    });
    const c = new RainClient(loadConfig({ stateDir: root }));
    vi.stubGlobal("fetch", async (u: URL, init: RequestInit) => {
      if (u.pathname === "/api/v3/classroom/on-lesson")
        return Response.json({
          code: 0,
          data: {
            onLessonClassrooms: [
              { lessonId: "1900000000000000001", classroomId: "3200000" },
            ],
          },
        });
      if (u.pathname === "/api/v3/lesson/checkin") {
        const body = JSON.parse(String(init.body));
        if (body.source !== 1)
          return Response.json({ code: 400 }, { status: 400 });
        expect(body.lessonId).toBe("1900000000000000001");
        return Response.json({
          code: 0,
          data: { lessonToken: "synthetic-lesson-token" },
        });
      }
      throw new Error("Unexpected endpoint");
    });
    expect(await c.join("1900000000000000001")).toMatchObject({ joined: true });
  } finally {
    vi.unstubAllGlobals();
    await rm(root, { recursive: true, force: true });
  }
});
it("persists the checkin set-auth bearer in encrypted lesson state for another process", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "hetang-lesson-bearer-"));
  const store = new AuthStore(root);
  try {
    await store.save({
      account: "test",
      userId: "test",
      cookieHeader: "sessionid=unit-test",
      bearerToken: "account-bearer",
    });
    vi.stubGlobal("fetch", async (u: URL, init: RequestInit) => {
      if (u.pathname.endsWith("/on-lesson"))
        return Response.json({
          code: 0,
          data: {
            onLessonClassrooms: [
              {
                lessonId: "lesson",
                classroomId: "course",
                presentationId: "deck",
              },
            ],
          },
        });
      if (u.pathname.endsWith("/checkin"))
        return Response.json(
          { code: 0, data: { lessonToken: "socket-token" } },
          { headers: { "set-auth": "lesson-api-bearer" } },
        );
      if (u.pathname.endsWith("/presentation/fetch")) {
        if (
          new Headers(init.headers).get("Authorization") !==
          "Bearer lesson-api-bearer"
        )
          return Response.json({ code: 401 }, { status: 401 });
        return Response.json({ code: 0, data: { slides: [] } });
      }
      throw new Error("Unexpected endpoint");
    });
    await new RainClient(loadConfig({ stateDir: root })).join("lesson");
    const fresh = new RainClient(loadConfig({ stateDir: root }));
    expect(await fresh.refreshQuestions("lesson")).toEqual({ items: [] });
  } finally {
    vi.unstubAllGlobals();
    await rm(root, { recursive: true, force: true });
  }
});
it("downloads only published live slides when the post-class summary is not ready", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "hetang-live-resource-"));
  const store = new AuthStore(root);
  try {
    await store.save({
      account: "test",
      userId: "test",
      cookieHeader: "sessionid=unit-test",
    });
    const c = new RainClient(loadConfig({ stateDir: root }));
    await c.checkAuth();
    await c.saveState({
      account: c.identity,
      lessonId: "lesson",
      lessonToken: "socket",
      lessonBearerToken: "api",
      presentationId: "deck",
      publishedSlides: { deck: ["s12"] },
      questions: [],
      published: ["q12"],
      resources: [],
    } as any);
    vi.stubGlobal("fetch", async (u: URL) => {
      if (u.pathname.endsWith("/on-lesson"))
        return Response.json({
          code: 0,
          data: {
            onLessonClassrooms: [{ lessonId: "lesson", classroomId: "course" }],
          },
        });
      if (u.pathname.endsWith("/presentation/fetch"))
        return Response.json({
          code: 0,
          data: {
            title: "Live deck",
            slides: [
              {
                id: "s12",
                index: 12,
                cover: "https://cdn.xuetangx.com/12.jpg",
              },
              {
                id: "s90",
                index: 90,
                cover: "https://cdn.xuetangx.com/unpublished.jpg",
              },
            ],
          },
        });
      return Response.json({ code: 0, data: { errorCode: -1 } });
    });
    const result = await c.collectResources("lesson");
    expect(result.resources).toHaveLength(1);
    expect(result.resources[0]).toMatchObject({ index: 12 });
  } finally {
    vi.unstubAllGlobals();
    await rm(root, { recursive: true, force: true });
  }
});
it("keeps each concurrent checkin bearer attached to its own lesson", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "hetang-concurrent-bearer-"));
  const store = new AuthStore(root);
  try {
    await store.save({
      account: "test",
      userId: "test",
      cookieHeader: "sessionid=unit-test",
    });
    const c = new RainClient(loadConfig({ stateDir: root }));
    vi.stubGlobal("fetch", async (u: URL, init: RequestInit) => {
      if (u.pathname.endsWith("/on-lesson"))
        return Response.json({
          code: 0,
          data: {
            onLessonClassrooms: [
              { lessonId: "A", classroomId: "course" },
              { lessonId: "B", classroomId: "course" },
            ],
          },
        });
      const id = JSON.parse(String(init.body)).lessonId;
      return Response.json(
        { code: 0, data: { lessonToken: "socket-" + id } },
        { headers: { "set-auth": "api-" + id } },
      );
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve)),
      original = c.request.bind(c);
    c.request = async (...args: Parameters<RainClient["request"]>) => {
      const response = await original(...args);
      if (args[0].endsWith("/checkin")) {
        if (JSON.parse(String(args[1]?.body)).lessonId === "A") await gate;
        else release();
      }
      return response;
    };
    await Promise.all([c.join("A"), c.join("B")]);
    expect((await c.state("A"))?.lessonBearerToken).toBe("api-A");
    expect((await c.state("B"))?.lessonBearerToken).toBe("api-B");
  } finally {
    vi.unstubAllGlobals();
    await rm(root, { recursive: true, force: true });
  }
});
