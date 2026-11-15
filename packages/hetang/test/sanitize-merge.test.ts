import { it, expect } from "vitest";
import { parse } from "smol-toml";
import { mergeToml } from "../src/install.js";
import { safeSegment } from "../src/storage.js";
import { normalizeAnswer } from "../src/classroom.js";
import { trimTrailingSlashes } from "../src/cloud.js";

const entry = {
  command: "C:/Program Files/nodejs/node.exe",
  args: ["D:/code/hetang-mcp/dist/cli.js", "serve"],
  env: { HETANG_MOCK: "0" },
};

// 下面两条是超线性正则换成线性扫描后的行为回归：结果必须逐字节一致，
// 同时超长输入不能再触发二次回溯。
it("safeSegment 去掉首尾的点与空格，保留中间的空白", () => {
  expect(safeSegment(".. 课程 课件 ..")).toBe("课程 课件");
  expect(safeSegment("  两侧空格  ")).toBe("两侧空格");
  expect(safeSegment("a  b")).toBe("a  b");
  expect(safeSegment(" . . ")).toBe("_");
  expect(safeSegment("...")).toBe("_");
});

it("safeSegment 其余规则不变：前导下划线折叠与 Windows 保留名", () => {
  expect(safeSegment("__x")).toBe("_x");
  expect(safeSegment("con.txt")).toBe("_con.txt");
  expect(safeSegment("a/b\\c")).toBe("a_b_c");
});

it("safeSegment 处理超长内嵌空白是线性的", () => {
  const input = "x" + " ".repeat(100_000) + "z";
  const started = Date.now();
  const value = safeSegment(input);
  expect(Date.now() - started).toBeLessThan(2000);
  expect(value.startsWith("x")).toBe(true);
  expect(value.length).toBeLessThanOrEqual(72);
});

it("mergeToml 去掉末尾空白后只保留一个空行分隔，内容仍可解析", () => {
  const before = 'model = "keep-me"\n' + " ".repeat(64) + "\n\n\n";
  const after = mergeToml(before, entry, false);
  expect(after.startsWith('model = "keep-me"\n\n')).toBe(true);
  expect(/[ \t]+\n\n/.test(after)).toBe(false);
  expect((parse(after) as any).model).toBe("keep-me");
  // 幂等：再跑一次不应继续改写。
  expect(mergeToml(after, entry, false)).toBe(after);
});

it("多选答案保持码元序，不是数字序", () => {
  const base = {
    id: "q1",
    lessonId: "l1",
    presentationId: "p1",
    slideId: "s1",
    prompt: "",
    published: true,
    answered: false,
  };
  const ab = {
    ...base,
    type: "multiple" as const,
    options: [
      { key: "A", text: "" },
      { key: "B", text: "" },
    ],
  };
  expect(normalizeAnswer(ab, ["b", "a"])).toEqual(["A", "B"]);
  const numeric = {
    ...base,
    type: "multiple" as const,
    options: [
      { key: "9", text: "" },
      { key: "10", text: "" },
    ],
  };
  // 数字序会得到 ["9","10"]；这里必须仍是码元序 ["10","9"]。
  expect(normalizeAnswer(numeric, ["9", "10"])).toEqual(["10", "9"]);
});

it("云盘根路径只去掉末尾斜杠，其余原样保留", () => {
  expect(trimTrailingSlashes("/荷塘雨课堂")).toBe("/荷塘雨课堂");
  expect(trimTrailingSlashes("/荷塘雨课堂///")).toBe("/荷塘雨课堂");
  expect(trimTrailingSlashes("///")).toBe("");
  expect(trimTrailingSlashes("/a/b/")).toBe("/a/b");
  // 中间斜杠与首斜杠不能被吃掉。
  expect(trimTrailingSlashes("/a//b")).toBe("/a//b");
});

it("超长斜杠后缀同样是线性处理", () => {
  const input = "/root" + "/".repeat(100_000);
  const started = Date.now();
  expect(trimTrailingSlashes(input)).toBe("/root");
  expect(Date.now() - started).toBeLessThan(2000);
});