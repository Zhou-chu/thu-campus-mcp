import { describe, expect, it } from "vitest";
import { mergeJson } from "../src/install.js";

const entry = { command: "/usr/bin/hetang", args: ["/usr/bin/hetang-mcp.js"] };
const other = { command: "/usr/bin/hetang", args: ["/opt/other/hetang-mcp.js"] };

describe("mergeJson 边界", () => {
  it("空文件按格式选择骨架", () => {
    const json = JSON.parse(mergeJson("", entry, "json", false));
    expect(json.mcpServers.hetang.command).toBe(entry.command);
    const harness = JSON.parse(mergeJson("", entry, "harness", false));
    expect(harness.version).toBe(1);
    expect(harness.servers[0].name).toBe("hetang");
  });

  it("拒绝非对象与非受支持的 harness 格式", () => {
    expect(() => mergeJson("[]", entry, "json", false)).toThrowError(/INVALID_CONFIG|JSON 对象/);
    expect(() => mergeJson("[]", entry, "harness", false)).toThrowError(/INVALID_CONFIG|JSON 对象/);
    expect(() => mergeJson('{"version":2,"servers":[]}', entry, "harness", false)).toThrowError(/INVALID_CONFIG|Harness/);
    expect(() => mergeJson('{"version":1,"servers":{}}', entry, "harness", false)).toThrowError(/INVALID_CONFIG|Harness/);
  });

  it("同名但不同路径时报冲突而不是覆盖", () => {
    const before = JSON.stringify({ mcpServers: { hetang: other } });
    expect(() => mergeJson(before, entry, "json", false)).toThrowError(/INSTALL_CONFLICT|更名/);
  });

  it("卸载不存在的条目时原样返回", () => {
    const before = '{"mcpServers":{}}';
    expect(mergeJson(before, entry, "json", true)).toBe(before);
    const harness = '{"version":1,"servers":[]}';
    expect(mergeJson(harness, entry, "harness", true)).toBe(harness);
  });

  it("目标状态已一致时保持文本不变", () => {
    const once = mergeJson("", entry, "harness", false);
    expect(mergeJson(once, entry, "harness", false)).toBe(once);
  });

  it("mcpServers 类型非法时拒绝写入", () => {
    expect(() => mergeJson('{"mcpServers":[]}', entry, "json", false)).toThrowError(/INVALID_CONFIG|mcpServers/);
    expect(() => mergeJson('{"mcpServers":"x"}', entry, "json", false)).toThrowError(/INVALID_CONFIG|mcpServers/);
    expect(() => mergeJson('{"mcpServers":null}', entry, "json", false)).toThrowError(/INVALID_CONFIG|mcpServers/);
  });
});
describe("mergeJson 边界补充", () => {
  it("条目缺少 args 时按不同路径处理", () => {
    const before = JSON.stringify({ mcpServers: { hetang: { command: "/usr/bin/hetang" } } });
    expect(() => mergeJson(before, entry, "json", false)).toThrow();
  });

  it("harness 版本或 servers 缺失时拒绝", () => {
    expect(() => mergeJson('{"servers":[]}', entry, "harness", false)).toThrow();
    expect(() => mergeJson('{"version":1}', entry, "harness", false)).toThrow();
  });
});
