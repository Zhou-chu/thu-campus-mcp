import { describe, expect, it, vi } from "vitest";
import { CampusApiError, CampusClient } from "../src/client.js";

const jsonResponse = (payload: unknown, status = 200) =>
  new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });

const makeClient = (fetchImpl: typeof fetch) =>
  new CampusClient({ baseUrl: "http://127.0.0.1:8973/", token: "device-token", fetchImpl });

describe("CampusClient", () => {
  it("带上设备令牌并去掉末尾斜杠", async () => {
    let captured: { url: string; headers: Record<string, string> } | null = null;
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      captured = { url: String(url), headers: init?.headers as Record<string, string> };
      return jsonResponse({ ok: true, version: "1.5.0" });
    }) as unknown as typeof fetch;
    const meta = await makeClient(fetchImpl).meta();
    expect(meta.version).toBe("1.5.0");
    expect(captured!.url).toBe("http://127.0.0.1:8973/api/meta");
    expect(captured!.headers.authorization).toBe("Bearer device-token");
  });

  it("把错误码与状态码翻译成 CampusApiError", async () => {
    const fetchImpl = (async () => jsonResponse({ ok: false, error: { code: "SEAT_CLOSED", message: "座位系统未开放" } }, 503)) as unknown as typeof fetch;
    await expect(makeClient(fetchImpl).seatLibraries()).rejects.toMatchObject({
      code: "SEAT_CLOSED",
      status: 503,
      message: "座位系统未开放",
    });
  });

  it("网络失败给出 NETWORK_ERROR，不伪装成空数据", async () => {
    const fetchImpl = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    await expect(makeClient(fetchImpl).meta()).rejects.toBeInstanceOf(CampusApiError);
    await expect(makeClient(fetchImpl).meta()).rejects.toMatchObject({ code: "NETWORK_ERROR" });
  });

  it("体育场次查询会对参数做 url 编码", async () => {
    let captured = "";
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      captured = String(url);
      return jsonResponse({ ok: true, sessions: [] });
    }) as unknown as typeof fetch;
    await makeClient(fetchImpl).sportsSlots("游泳", "陈明游泳馆", "2026-11-22");
    expect(captured).toContain("sport=%E6%B8%B8%E6%B3%B3");
    expect(captured).toContain("venue=%E9%99%88%E6%98%8E%E6%B8%B8%E6%B3%B3%E9%A6%86");
  });
});