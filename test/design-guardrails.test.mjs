import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const read = (name) => readFile(path.join(root, name), "utf8");

const css = await read("webui/styles.css");
const html = await read("webui/index.html");
const design = await read("DESIGN.md");
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

test("DESIGN.md 保持九节结构", () => {
  const headings = [...design.matchAll(/^## (\d)\. /gm)].map((m) => m[1]);
  assert.deepEqual(headings, ["1", "2", "3", "4", "5", "6", "7", "8", "9"], "DESIGN.md 章节缺失或乱序");
  assert.match(design, /Agent Prompt Guide/);
});

test("入口页的静态资源都带版本号，避免升级后吃旧缓存", () => {
  for (const asset of ["/theme.js", "/styles.css", "/app.js"])
    assert.ok(
      new RegExp(`${asset.replace(/\./g, "\\.")}\\?v=`).test(html),
      `${asset} 缺少 ?v= 版本号`,
    );
  assert.match(html, /<meta name="theme-color"[^>]*--paper|content="#f4f3f0"/, "主题色应跟纸色一致");
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

test("无障碍：消息区是 live region，视图容器不整块播报", () => {
  assert.match(html, /class="skip"/, "缺少跳过导航链接");
  assert.match(html, /<main id="view" class="view" tabindex="-1">/);
  assert.ok(!/id="view"[^>]*aria-live/.test(html), "整块视图不应是 live region");
});
