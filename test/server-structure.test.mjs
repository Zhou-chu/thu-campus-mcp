import assert from "node:assert/strict";
import test from "node:test";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

const LINES = file => readFile(file, "utf8").then(text => text.split(/\r?\n/).length);

test("server.mjs 保持为组合根，而不是所有路由的宿主", async () => {
  const lines = await LINES("lib/app/server.mjs");
  assert.ok(lines <= 520, `server.mjs 现为 ${lines} 行，超过 520 行说明路由又开始堆回来了`);
  const text = await readFile("lib/app/server.mjs", "utf8");
  assert.match(text, /createAccountRoutes/, "账号路由必须来自模块");
  assert.match(text, /createSettingsRoutes/, "设置路由必须来自模块");
  assert.match(text, /createMetaRoutes/, "元信息路由必须来自模块");
  assert.match(text, /createChatRoutes/, "会话与对话路由必须来自模块");
  assert.match(text, /createToolRoutes/, "工具路由必须来自模块");
  assert.match(text, /createCampusRoutes/, "座位与体育路由必须来自模块");
  assert.match(text, /createSidebarRoutes/, "课表与作业路由必须来自模块");
});

test("拆分后的路由模块各自控制在可读规模内", async () => {
  const directory = "lib/app/routes";
  const files = (await readdir(directory)).filter(name => name.endsWith(".mjs"));
  assert.ok(files.length >= 7, `应至少有 7 个路由模块，实际 ${files.length}`);
  for (const name of files) {
    const lines = await LINES(path.join(directory, name));
    assert.ok(lines <= 220, `${name} 有 ${lines} 行，单文件继续膨胀前应先再拆分`);
  }
});