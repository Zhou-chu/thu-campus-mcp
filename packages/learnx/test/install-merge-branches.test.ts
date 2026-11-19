import { describe, expect, it } from "vitest";
import { mergeJson } from "../src/install.js";

const entry = { command: "/usr/bin/learnx", args: ["/usr/bin/learnx-mcp.js"] };
const other = { command: "/usr/bin/learnx", args: ["/opt/other/learnx-mcp.js"] };

describe("learnx mergeJson 边界", () => {
  it("空文本按格式生成骨架", () => {
    const json = JSON.parse(mergeJson("", entry, "json", false));
    expect(json.mcpServers.learnx.command).toBe(entry.command);
    const harness = JSON.parse(mergeJson("", entry, "harness", false));
    expect(Array.isArray(harness.servers)).toBe(true);
  });

  it("拒绝非对象与非法 harness 结构", () => {
    expect(() => mergeJson("[]", entry, "json", false)).toThrow();
    expect(() => mergeJson("[]", entry, "harness", false)).toThrow();
    expect(() => mergeJson('{"version":9,"servers":[]}', entry, "harness", false)).toThrow();
    expect(() => mergeJson('{"version":1,"servers":7}', entry, "harness", false)).toThrow();
  });

  it("同名不同路径报冲突", () => {
    expect(() => mergeJson(JSON.stringify({ mcpServers: { learnx: other } }), entry, "json", false)).toThrow();
  });

  it("卸载不存在条目时原样返回", () => {
    expect(mergeJson('{"mcpServers":{}}', entry, "json", true)).toBe('{"mcpServers":{}}');
    const harness = '{"version":1,"servers":[]}';
    expect(mergeJson(harness, entry, "harness", true)).toBe(harness);
  });

  it("mcpServers 非法类型时拒绝", () => {
    expect(() => mergeJson('{"mcpServers":[]}', entry, "json", false)).toThrow();
    expect(() => mergeJson('{"mcpServers":null}', entry, "json", false)).toThrow();
  });
});