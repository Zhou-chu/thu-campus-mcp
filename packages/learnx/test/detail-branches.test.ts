import { describe, expect, test } from "vitest";
import { extractDetail, inlineResources, sanitizedHtml, validateDownload } from "../src/detail.js";
import { LearnError } from "../src/types.js";

const page = (body: string) => `<html><body>${body}</body></html>`;

describe("详情清洗：脚本、内联事件与公式", () => {
  test("数学脚本转成公式标记，普通脚本与事件属性被删除", () => {
    const html = sanitizedHtml(page(`
      <script type="math/tex; mode=display">x^2</script>
      <script type="math/tex">a+b</script>
      <script>alert(1)</script>
      <div onclick="steal()">正文</div>
      <link rel="stylesheet" href="/a.css"><meta name="x"><form><input value="1"></form>
    `));
    expect(html).toContain('class="learnx-math"');
    expect(html).toContain('data-display="block"');
    expect(html).not.toContain("alert(1)");
    expect(html).not.toContain("onclick");
    expect(html).not.toContain("<form");
  });

  test("没有脚本的片段也能清洗", () => {
    expect(sanitizedHtml("<p>只有正文</p>")).toContain("只有正文");
  });
});

describe("内嵌资源：协议、域名与去重", () => {
  const base = "https://learn.tsinghua.edu.cn/course/1";

  test("站内资源收集，外站与 data: 跳过并给出告警", () => {
    const { attachments, warnings } = inlineResources(`
      <img src="data:image/png;base64,AAA">
      <img src="https://learn.tsinghua.edu.cn/f/a.png">
      <img src="https://learn.tsinghua.edu.cn/f/a.png">
      <img src="https://evil.example/f/b.png">
      <img src="http://learn.tsinghua.edu.cn/f/c.png">
      <a href="https://learn.tsinghua.edu.cn/course/1">普通链接</a>
      <a href="https://learn.tsinghua.edu.cn/f/d.pdf">附件</a>
      <img src="/broken path/%E0%A4%A">
      <img srcset="a.png 1x, b.png 2x">
    `, base);
    expect(attachments.map(a => a.name)).toEqual(["a.png", "d.pdf", "%E0%A4%A"]);
    expect(warnings).toEqual(expect.arrayContaining(["存在外部内嵌资源，未跨站下载。", "响应式图片 srcset 需要站点验证，已保留原始标记。"]));
  });

  test("无法解析的地址只给告警，坏文件名回退原文", () => {
    const { attachments, warnings } = inlineResources('<img src="https://[bad">', base);
    expect(attachments).toEqual([]);
    expect(warnings).toContain("有无法解析的内嵌资源。");
  });
});

describe("下载与详情正文的可读判断", () => {
  test("网页或登录页不当作附件保存", () => {
    expect(() => validateDownload(new TextEncoder().encode("<html><input type=password></html>"), "text/html", "作业.pdf")).toThrow(LearnError);
    expect(() => validateDownload(new TextEncoder().encode("<!doctype html><p>x</p>"), "application/pdf", "作业.pdf")).toThrow(LearnError);
    expect(() => validateDownload(new TextEncoder().encode("<!doctype html><p>x</p>"), "text/html", "页面.html")).not.toThrow();
    expect(() => validateDownload(new TextEncoder().encode("PDFDATA"), "application/pdf", "作业.pdf")).not.toThrow();
  });

  test("登录页与缺正文结构的详情分别给出错误或告警", () => {
    expect(() => extractDetail(page('<input name="i_pass">'), "https://learn.tsinghua.edu.cn/a")).toThrow(LearnError);
    const empty = extractDetail(page("<div>没有可识别结构</div>"), "https://learn.tsinghua.edu.cn/a");
    expect(empty.html).toBe("");
    expect(empty.warnings[0]).toContain("未识别详情正文结构");
    expect(empty.next).toBeUndefined();
  });

  test("正文节点、下一页与 javascript 链接", () => {
    const withNext = extractDetail(page('<div class="tlnr">正文</div><a rel="next" href="/page/2">下一页</a>'), "https://learn.tsinghua.edu.cn/a");
    expect(withNext.html).toContain("正文");
    expect(withNext.next).toBe("https://learn.tsinghua.edu.cn/page/2");

    const js = extractDetail(page('<div class="tlnr">正文</div><a rel="next" href="javascript:void(0)">下一页</a>'), "https://learn.tsinghua.edu.cn/a");
    expect(js.next).toBeUndefined();

    const byText = extractDetail(page('<div class="boxbox">正文</div><a href="/page/3">下一页</a>'), "https://learn.tsinghua.edu.cn/a");
    expect(byText.next).toBe("https://learn.tsinghua.edu.cn/page/3");
  });
});