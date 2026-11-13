import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const read = (name) => readFile(path.join(root, name), "utf8");

const css = await read("webui/styles.css");
const html = await read("webui/index.html");
const design = await read("UIdesign.md");
const designEntry = await read("DESIGN.md");
const app = await read("webui/app.js");
const preview = await read("webui/preview.html");

test("样式表里没有脱离变量的硬编码颜色", () => {
  // 只允许在变量声明处写十六进制色值；其余一律走 var(--x) 或 color-mix。
  const withoutDeclarations = css.replace(/--[a-z0-9-]+:\s*#[0-9a-fA-F]{3,8}\s*;/g, "");
  const leftovers = [...withoutDeclarations.matchAll(/#[0-9a-fA-F]{3,8}\b/g)]
    .map((m) => m[0])
    .filter((value) => /^#[0-9a-f]{3,8}$/i.test(value))
    .filter((value) => value.length !== 4 || !/^#[a-z]/i.test(value));
  assert.deepEqual(leftovers, [], `发现硬编码色值：${leftovers.join(", ")}`);
});

test("每个用到的 CSS 变量都有定义", () => {
  const defined = new Set([...css.matchAll(/(--[a-z0-9-]+)\s*:/g)].map((m) => m[1]));
  const used = new Set([...css.matchAll(/var\((--[a-z0-9-]+)/g)].map((m) => m[1]));
  const missing = [...used].filter((name) => !defined.has(name));
  assert.deepEqual(missing, [], `未定义的变量：${missing.join(", ")}`);
});

test("间距阶与断点是完整的一套", () => {
  for (const step of ["--space-1", "--space-2", "--space-3", "--space-4", "--space-5", "--space-6", "--space-7"])
    assert.ok(css.includes(`${step}:`), `缺少 ${step}`);
  assert.match(css, /@media \(min-width: 900px\)/);
  assert.match(css, /@media \(max-width: 430px\)/);
  assert.match(css, /prefers-reduced-motion: reduce/);
});

test("UIdesign.md 保持九节结构", () => {
  const headings = [...design.matchAll(/^## (\d)\. /gm)].map((m) => m[1]);
  assert.deepEqual(headings, ["1", "2", "3", "4", "5", "6", "7", "8", "9"], "UIdesign.md 章节缺失或乱序");
  assert.match(design, /Agent执行流程/);
});

test("静态资源版本号来自单一占位符，不硬编码", async () => {
  const sw = await read("webui/sw.js");
  for (const asset of ["/theme.js", "/styles.css", "/app.js"])
    assert.ok(
      new RegExp(`${asset.replace(/\./g, "\\.")}\\?v=__ASSET_VERSION__`).test(html),
      `${asset} 应使用 ?v=__ASSET_VERSION__`,
    );
  assert.match(sw, /__ASSET_VERSION__/, "service worker 的资源列表也要走占位符");
  for (const [name, content] of [["index.html", html], ["preview.html", preview], ["sw.js", sw]])
    assert.ok(!/\?v=\d+\.\d+\.\d+/.test(content), `${name} 里不应再写死版本号`);
  assert.match(html, /content="#f4f3f0"/, "主题色应跟纸色一致");
});

test("设计目录页与主应用同源、无内联脚本", () => {
  assert.match(preview, /href="\/styles.css\?v=/);
  assert.ok(!/<script(?![^>]*src=)/.test(preview), "CSP 不允许内联脚本");
  assert.match(design, /preview\.html|设计目录/);
});

test("CSP 收紧到 style-src self 时，页面里不能有内联样式", () => {
  // 内联 style 属性会被 CSP 直接丢掉，表现为色块消失、布局塌陷——只能靠类名。
  for (const [name, content] of [
    ["webui/preview.html", preview],
    ["webui/index.html", html],
  ]) {
    const inline = [...content.matchAll(/\sstyle="[^"]*"/g)].map((m) => m[0].trim());
    assert.deepEqual(inline, [], `${name} 含内联样式：${inline.slice(0, 3).join(" | ")}`);
  }
});

test("防点击劫持只走响应头，不写在 meta 里", async () => {
  for (const [name, content] of [["index.html", html], ["preview.html", preview]])
    assert.ok(!content.includes("frame-ancestors"), `${name} 的 meta 里不应含 frame-ancestors`);
  const server = await read("lib/app/server.mjs");
  assert.match(server, /"X-Frame-Options": "DENY"/);
  assert.match(server, /"Content-Security-Policy": "frame-ancestors 'none'"/);
});

test("无障碍：消息区是 live region，视图容器不整块播报", () => {
  assert.match(html, /class="skip"/, "缺少跳过导航链接");
  assert.match(html, /<main id="view" class="view" tabindex="-1">/);
  assert.ok(!/id="view"[^>]*aria-live/.test(html), "整块视图不应是 live region");
});

test("设计规范唯一入口且Agent必须先读", async () => {
  assert.match(designEntry, /UIdesign\.md/);
  assert.doesNotMatch(designEntry, /^## \d+\./m, "兼容入口不另立设计规则");
  assert.match(await read("AGENTS.md"), /先完整阅读.*UIdesign\.md/);
  assert.match(design, /awesome-design-md/);
  assert.match(design, /AI直出UI/);
  assert.match(design, /覆盖率≥90%/);
});

test("日常UI不再生成重复眉标和无操作意义说明", () => {
  for (const text of ["THU CAMPUS · AGENT", "PAIR THIS DEVICE", "选择后自动保存", "先点「服务」确认登录状态", "永远登录不上的空壳"])
    assert.ok(!(html + app).includes(text), "冗余文案回归：" + text);
  assert.doesNotMatch(app, /dataset: \{ eyebrow:/);
  assert.doesNotMatch(css, /h2\[data-eyebrow\]/);
  assert.match(app, /status\.hidden = !status\.textContent/);
});

test("简化文案不删除输入名称、配对帮助或写入风险确认", () => {
  assert.match(app, /"aria-label": "消息"/);
  assert.match(html, /<summary>获取配对码<\/summary>/);
  assert.match(app, /此操作会改动校园数据/);
  for (const text of ["允许执行", "拒绝", "使用说明", "诊断信息"])
    assert.ok(app.includes(text), "缺少必要交互：" + text);
});


test("UI字阶统一且不重新引入微型操作字号", () => {
  for (const role of ["body", "chat", "ui", "meta", "code", "title", "heading", "section"])
    assert.ok(css.includes("--text-" + role + ":"));
  assert.match(css, /--text-chat:\s*1\.25rem/);
  assert.match(css, /@media \(min-width: 1600px\)/);
  assert.doesNotMatch(css, /font-size:\s*(?:10|11|12|13)(?:\.\d+)?px/);
  assert.match(design, /只测空白页/);
  assert.match(design, /computed font-size/);
});

test("UI不保留机械工具步数设置", () => {
  assert.doesNotMatch(app, /maxSteps|stepsInput|最大工具步数/);
  assert.match(design, /不设.*固定工具轮数截断/);
});
