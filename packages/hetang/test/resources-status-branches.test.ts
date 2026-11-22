import { describe, expect, test, vi } from "vitest";
import { resolveAssetAddresses, validateAssetUrl } from "../src/resources.js";
import { rainStatus } from "../src/status.js";
import { RainError } from "../src/types.js";

const answer = (data: string) => ({ ok: true, json: async () => ({ Status: 0, Answer: [{ type: 1, data }] }) });

describe("资源地址解析：Fake-IP 与公网 DNS", () => {
  test("Fake-IP 结果改走公网 DNS，带 lookup 时不复用缓存", async () => {
    const fetcher = vi.fn(async () => answer("198.51.100.7"));
    const lookup = async () => [{ address: "198.18.0.9", family: 4 as const }];
    const rows = await resolveAssetAddresses("fake-unit.invalid", { lookup, fetcher });
    expect(rows).toEqual([{ address: "198.51.100.7", family: 4 }]);
    const second = await resolveAssetAddresses("fake-unit.invalid", { lookup, fetcher });
    expect(second).toEqual(rows);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  test("私网与 Fake-IP 混合、公网 DNS 异常都拒绝", async () => {
    const mixed = async () => [
      { address: "198.19.0.1", family: 4 as const },
      { address: "192.168.1.9", family: 4 as const },
    ];
    await expect(resolveAssetAddresses("mixed-unit.invalid", { lookup: mixed })).rejects.toMatchObject({ code: "UNSAFE_ASSET" });

    const lookup = async () => [{ address: "198.18.0.2", family: 4 as const }];
    await expect(resolveAssetAddresses("dns-500.invalid", { lookup, fetcher: async () => ({ ok: false }) })).rejects.toMatchObject({ code: "ASSET_DNS" });
    await expect(resolveAssetAddresses("dns-status.invalid", { lookup, fetcher: async () => ({ ok: true, json: async () => ({ Status: 2, Answer: [] }) }) })).rejects.toMatchObject({ code: "UNSAFE_ASSET" });
    await expect(resolveAssetAddresses("dns-private.invalid", { lookup, fetcher: async () => answer("10.0.0.8") })).rejects.toMatchObject({ code: "UNSAFE_ASSET" });
    await expect(resolveAssetAddresses("dns-empty.invalid", { lookup, fetcher: async () => ({ ok: true, json: async () => ({ Status: 0, Answer: [{ type: 1 }] }) }) })).rejects.toMatchObject({ code: "UNSAFE_ASSET" });
  });
});

describe("资源地址校验：域名白名单与地址族", () => {
  const resolveTo = (...addresses: string[]) => async () => addresses.map(address => ({ address, family: address.includes(":") ? 6 as const : 4 as const }));

  test("只允许 https 的雨课堂 CDN 域名", async () => {
    for (const value of ["http://yuketang.cn/a", "https://user:pass@yuketang.cn/a", "https://yuketang.cn:8443/a", "https://example.com/a", "not a url"]) {
      await expect(validateAssetUrl(value, resolveTo("203.0.113.10"))).rejects.toBeInstanceOf(RainError);
    }
    const ok = await validateAssetUrl("https://cdn.yuketang.cn/files/a.pdf", resolveTo("203.0.113.10"));
    expect(ok.hostname).toBe("cdn.yuketang.cn");
    const ali = await validateAssetUrl("https://x.aliyuncs.com/a", resolveTo("203.0.113.10"));
    expect(ali.protocol).toBe("https:");
  });

  test("IPv4 私网段、IPv6 文档段与非法地址都拒绝", async () => {
    for (const address of ["10.1.2.3", "127.0.0.1", "169.254.1.1", "172.20.1.1", "192.168.0.1", "100.70.0.1", "198.18.0.1", "198.19.1.1", "224.0.0.1", "2001:db8::1", "not-an-ip"]) {
      await expect(validateAssetUrl("https://yuketang.cn/a", resolveTo(address))).rejects.toMatchObject({ code: "UNSAFE_ASSET" });
    }
    await expect(validateAssetUrl("https://yuketang.cn/a", resolveTo())).rejects.toMatchObject({ code: "UNSAFE_ASSET" });
    const v6 = await validateAssetUrl("https://yuketang.cn/a", resolveTo("2001:4860:4860::8888"));
    expect(v6.hostname).toBe("yuketang.cn");
  });
});

describe("雨课堂会话状态：三类配置与四类错误", () => {
  const config = { mock: false, stateDir: "." } as any;

  test("未配置、仅本地核验与验证成功", async () => {
    const none = await rainStatus(config, { user: async () => ({}) } as any, { verify: false, store: { status: async () => ({ configured: false }) } as any });
    expect(none.code).toBe("AUTH_REQUIRED");
    const local = await rainStatus(config, { user: async () => ({}) } as any, { verify: false, store: { status: async () => ({ configured: true }) } as any });
    expect(local).toMatchObject({ code: "UNVERIFIED", verified: false });
    const verified = await rainStatus(config, { user: async () => ({ id: "unit" }) } as any, { store: { status: async () => ({ configured: true }) } as any });
    expect(verified).toMatchObject({ code: "VERIFIED", sessionValidity: "verified", source: "protected-api:rain-basic-info" });
  });

  test("鉴权与网络错误映射为可读状态", async () => {
    const store = (configured: boolean) => ({ status: async () => ({ configured }) }) as any;
    const cases: Array<[any, string, string]> = [
      [new RainError("AUTH_REQUIRED", "需要登录"), "AUTH_EXPIRED", "expired"],
      [new RainError("AUTH_CHANGED", "账号变了"), "AUTH_CHANGED", "unknown"],
      [new RainError("AUTH_STORAGE", "存储坏了"), "AUTH_STORAGE", "unknown"],
      [new RainError("AUTH_PLATFORM", "平台不支持"), "AUTH_PLATFORM", "unknown"],
      [new Error("网络断了"), "NETWORK_ERROR", "unknown"],
    ];
    for (const [error, code, validity] of cases) {
      const out = await rainStatus(config, { user: async () => { throw error; } } as any, { store: store(true) });
      expect(out.code).toBe(code);
      expect(out.sessionValidity).toBe(validity);
    }
    const unconfigured = await rainStatus(config, { user: async () => { throw new RainError("AUTH_REQUIRED", "x"); } } as any, { store: store(false) });
    expect(unconfigured.code).toBe("AUTH_REQUIRED");
  });

  test("mock 模式直接说明是模拟", async () => {
    const out = await rainStatus({ mock: true, stateDir: "." } as any, {} as any);
    expect(out).toMatchObject({ code: "MOCK_MODE", state: "mock", source: "mock:hetang" });
  });
});