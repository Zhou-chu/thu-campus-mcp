#!/usr/bin/env node
/**
 * WebUI 端到端冒烟：真实 Chromium 打开真实服务端与真实 webui/ 目录。
 *
 * 覆盖上线前必须成立的事：配对页、五个视图、编号索引、常驻卡片、设计目录、
 * 主题切换持久化、资源版本注入、控制台无报错。
 *
 * 用法：node scripts/e2e-web.mjs [--headed] [--json]
 */
import path from "node:path";
import { mkdtemp, readFile, rm, readdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { chromium } from "playwright-core";
import { createAppServer } from "../lib/app/server.mjs";
import { PairingCodes } from "../lib/app/pairing.mjs";
import { DeviceStore } from "../lib/app/devices.mjs";
import { SessionStore } from "../lib/app/sessions.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const headed = process.argv.includes("--headed");
const asJson = process.argv.includes("--json");
// 可选：直接对已经在跑的目标做验收（例如解压后的便携包），不自己起服务。
const urlArg = process.argv.find((arg) => arg.startsWith("--url="))?.slice("--url=".length) || "";
const tokenArg = process.argv.find((arg) => arg.startsWith("--token="))?.slice("--token=".length);
const TOKEN = tokenArg || "e2e-token";
const TOOLS = [
  { name: "learn_status", description: "检查网络学堂认证配置", readOnly: true },
  { name: "learn_list_courses", description: "列出课程", readOnly: true },
  { name: "cloud_list_directory", description: "列出云盘目录", readOnly: true },
  { name: "rain_active_classrooms", description: "查询雨课堂课程", readOnly: true },
  {
    name: "learn_submit_assignment",
    description: "提交作业（写入）",
    readOnly: false,
    destructive: true,
  },
];

function fakeHost() {
  return {
    describe: () =>
      TOOLS.map((tool) => ({
        name: tool.name,
        description: tool.description,
        service: "learnx",
        inputSchema: { type: "object", properties: {} },
        readOnly: tool.readOnly === true,
        destructive: tool.destructive === true,
      })),
    toolForModel: () =>
      TOOLS.map((tool) => ({
        type: "function",
        function: { name: tool.name, description: tool.description, parameters: { type: "object", properties: {} } },
      })),
    async call(name) {
      if (name === "learn_status") return { ok: true, data: { configured: true } };
      if (name === "cloud_status") return { ok: true, data: { configured: true, sessionValidity: "valid" } };
      if (name === "rain_status") return { ok: true, data: { loggedIn: true } };
      if (name === "madmodel_status") return { ok: true, data: { configured: true } };
      return { ok: true, data: { echo: name } };
    },
    async close() {},
  };
}

const route = {
  route: "madmodel",
  async models() {
    return [{ id: "e2e-model", label: "E2E 模型" }];
  },
  async status() {
    return { route: "madmodel", available: true, configured: true, masked: "2024****0419" };
  },
  async chat() {
    const body = `data: ${JSON.stringify({ choices: [{ delta: { content: "端到端回复" } }] })}\n\ndata: [DONE]\n\n`;
    return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
  },
};

async function findChromium() {
  const dir = path.join(ROOT, ".runtime", "browsers");
  const entries = await readdir(dir).catch(() => []);
  for (const entry of entries.filter((name) => name.startsWith("chromium-"))) {
    for (const sub of ["chrome-win64", "chrome-win"]) {
      const candidate = path.join(dir, entry, sub, "chrome.exe");
      if (await stat(candidate).then(() => true, () => false)) return candidate;
    }
  }
  throw new Error(`未找到 Chromium，请先运行 node bin/thu-campus.mjs browser install（查找目录 ${dir}）`);
}

const checks = [];
const startedAt = Date.now();
// 看门狗：任何一个浏览器动作卡住都不该让脚本无限等待。
const watchdog = setTimeout(() => {
  process.stderr.write(`\n✖ 端到端超时（${Math.round((Date.now() - startedAt) / 1000)}s 未完成）\n`);
  process.exit(1);
}, 120000);
watchdog.unref();
function step(label) {
  process.stdout.write(`  · ${label}\n`);
}
function record(name, ok, detail = "") {
  checks.push({ name, ok, detail });
  process.stdout.write(`  ${ok ? "✔" : "✖"} ${name}${detail ? `（${detail}）` : ""}\n`);
  if (!ok) throw new Error(`${name}${detail ? `：${detail}` : ""}`);
}

async function main() {
  let app = null;
  let stateDir = "";
  let base = urlArg ? urlArg.replace(/\/+$/, "") : "";
  if (!base) {
  stateDir = await mkdtemp(path.join(tmpdir(), "campus-e2e-"));
  const config = {
    root: ROOT,
    host: "127.0.0.1",
    port: 0,
    stateDir,
    token: TOKEN,
    modelRoute: "madmodel",
    modelBaseUrl: "",
    modelApiKey: "",
    modelName: "",
    maxSteps: 8,
    hostname: "e2e-host",
    version: "9.9.9",
    requireApproval: true,
    approvalTimeoutMs: 5000,
    keepAliveMinutes: 30,
  };
  const devices = new DeviceStore(stateDir, { encrypt: async (buffer) => buffer });
  const sessionStore = new SessionStore(stateDir);
  for (const title of ["把本学期课程更新到 D:\\网络学堂", "列出尚未提交的作业", "雨课堂签到的自动提醒"])
    await sessionStore.create({ title });
  const history = await sessionStore.create({ title: "历史会话回归" });
  await sessionStore.append(history.id, [
    { role: "user", content: "历史消息测试" },
    {
      role: "assistant",
      content: "| 截止时间 | 课程 |\n| --- | --- |\n| 11-16 | 电力电子技术基础 |",
    },
  ]);
  app = createAppServer({
    config,
    host: fakeHost(),
    route,
    devices,
    pairing: new PairingCodes(),
    sessions: sessionStore,
    version: config.version,
    webuiDir: path.join(ROOT, "webui"),
    keepAlive: null,
  });
  base = await app.listen();
  } else {
    record("目标可达", (await fetch(base + "/healthz")).ok, base);
  }
  const browser = await chromium.launch({
    executablePath: await findChromium(),
    headless: !headed,
    timeout: 20000,
  });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const consoleErrors = [];
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("pageerror", (error) => consoleErrors.push(String(error)));
  const badResponses = [];
  page.on("response", (response) => {
    if (response.status() >= 400) badResponses.push(`${response.status()} ${response.url()}`);
  });

  try {
    // 1. 未带令牌 → 配对页
    await page.goto(`${base}/`, { waitUntil: "load" });
    record("配对页可见", await page.locator("#pair").isVisible());
    record("主应用隐藏", !(await page.locator("#app").isVisible()));

    // 2. 注入版本号：页面里不应残留占位符
    const expectedVersion = urlArg
      ? JSON.parse(await readFile(path.join(ROOT, "package.json"), "utf8")).version
      : "9.9.9";
    const rawHtml = await (await fetch(`${base}/`)).text();
    record(
      "服务端注入版本号",
      rawHtml.includes(`?v=${expectedVersion}`) && !rawHtml.includes("__ASSET_VERSION__"),
      `期望 ${expectedVersion}`,
    );

    // 3. 带令牌 → 主应用
    await page.goto(`${base}/?e2e=1#token=${TOKEN}`, { waitUntil: "load" });
    await page.waitForSelector("#app .tab", { state: "visible", timeout: 10000 });
    record("主应用可见", await page.locator("#app").isVisible());
    record("五个导航标签", (await page.locator(".tabbar .tab").count()) === 5);

    // 4. 服务页：四行服务 + 编号
    await page.click('button[data-view="services"]');
    await page.waitForSelector(".item");
    record("服务行数为 4", (await page.locator(".item").count()) === 4);
    record("服务编号存在", (await page.locator(".item").first().innerText()).includes("网络学堂"));

    // 5. 工具页：编号索引与写入标记
    await page.click('button[data-view="tools"]');
    await page.waitForSelector(".list > .card");
    record("工具条数正确", (await page.locator(".list > .card").count()) === TOOLS.length);
    // 浏览器不会把 counter() 解析成数字，只能确认伪元素真的挂了计数器。
    const pseudo = await page.evaluate(() => {
      const style = getComputedStyle(document.querySelector(".list > .card"), "::before");
      return { content: style.content, increment: style.counterIncrement };
    });
    record("工具行挂上编号计数器", String(pseudo.content).includes("counter("), JSON.stringify(pseudo));
    record("编号按行递增", String(pseudo.increment).includes("entry"), JSON.stringify(pseudo));

    // 5.5 会话：搜索与重命名（这两个是纯前端交互，只有真浏览器能验）
    step("切到会话页");
    await page.click('button[data-view="sessions"]');
    await page.waitForSelector(".session-row");
    step("会话行已渲染");
    record("会话列表四条", (await page.locator(".session-row").count()) === 4);
    step("准备填搜索框");
    await page.fill('input[type="search"]', "雨课堂", { timeout: 8000 });
    step("搜索已填");
    const filteredCount = await page.locator(".session-row").count();
    const searchValue = await page.inputValue('input[type="search"]');
    record("搜索按标题过滤", filteredCount === 1, `行数=${filteredCount} 输入=${searchValue}`);
    await page.fill('input[type="search"]', "");
    record("清空搜索恢复全部", (await page.locator(".session-row").count()) === 4);
    step("准备点重命名");
    const firstRow = page.locator(".session-row").first();
    await firstRow.getByRole("button", { name: "重命名" }).click({ timeout: 8000 });
    step("已进入重命名");
    const titleInput = firstRow.locator('input[type="text"]');
    await titleInput.fill("端到端改名");
    await titleInput.press("Enter");
    await page.waitForFunction(() => document.body.innerText.includes("端到端改名"), null, { timeout: 8000 });
    record("重命名即时生效", true);

    // 5.6 历史会话：消息与 Markdown 表格都要真的渲染
    await page.click('button[data-view="sessions"]');
    await page.waitForSelector(".session-row");
    await page.fill('input[type="search"]', "历史会话回归");
    await page.locator(".session-row .item").first().click();
    await page.waitForSelector("#messages .bubble");
    record("历史消息已渲染", (await page.locator("#messages .bubble").count()) >= 2);
    record("Markdown 表格已渲染", (await page.locator("#messages table.rich-table").count()) === 1);
    record(
      "表格内容正确",
      (await page.locator("#messages table.rich-table td").first().innerText()).includes("11-16"),
    );

    // 6. 设置页：常驻卡片与设计目录入口
    await page.click('button[data-view="settings"]');
    await page.waitForSelector('a[href="/preview.html"]');
    const settingsText = await page.locator("#view").innerText();
    record("设置页有常驻卡片", settingsText.includes("常驻"));
    record("设置页链接设计目录", (await page.locator('a[href="/preview.html"]').count()) === 1);

    // 7. 设计目录：色块真的画出来了
    await page.goto(`${base}/preview.html`, { waitUntil: "load" });
    record("色块数量为 8", (await page.locator(".swatch").count()) === 8);
    const box = await page.locator(".swatch").first().boundingBox();
    record("色块有实际尺寸", !!box && box.width > 8 && box.height > 8, JSON.stringify(box));

    // 8. 主题切换并持久化
    await page.goto(`${base}/?e2e=2#token=${TOKEN}`, { waitUntil: "load" });
    await page.waitForSelector("#app .tab", { state: "visible", timeout: 10000 });
    await page.click("#theme-dark");
    record("切到深色", (await page.evaluate(() => document.documentElement.dataset.theme)) === "dark");
    await page.reload({ waitUntil: "load" });
    record(
      "刷新后仍是深色",
      (await page.evaluate(() => document.documentElement.dataset.theme)) === "dark",
    );
    await page.click("#theme-light");
    record("切回浅色", (await page.evaluate(() => document.documentElement.dataset.theme)) === "light");

    // 9. 无障碍：消息区是 live region，视图不是
    await page.click('button[data-view="chat"]');
    await page.waitForSelector("#messages");
    record(
      "消息区是 live region",
      (await page.locator("#messages").getAttribute("aria-live")) === "polite",
    );
    record("视图容器不整块播报", (await page.locator("#view").getAttribute("aria-live")) === null);

    record("没有 4xx/5xx 资源请求", badResponses.length === 0, badResponses.slice(0, 4).join(" | "));
    record("控制台无报错", consoleErrors.length === 0, consoleErrors.slice(0, 3).join(" | "));
  } finally {
    await browser.close().catch(() => {});
    if (app) await app.close?.().catch?.(() => {});
    if (stateDir) await rm(stateDir, { recursive: true, force: true }).catch(() => {});
  }

  if (asJson) process.stdout.write(JSON.stringify({ ok: true, checks }, null, 2) + "\n");
  else {
    process.stdout.write(`\nWebUI 端到端通过 ${checks.length} 项。\n`);
  }
  // 浏览器与临时服务都已关闭；显式退出，避免个别句柄把进程吊住。
  process.exit(0);
}

main().catch((error) => {
  const failed = checks.filter((check) => !check.ok).at(-1);
  if (asJson) process.stdout.write(JSON.stringify({ ok: false, failed: failed?.name, error: error.message }, null, 2) + "\n");
  else {
    process.stderr.write(`\n✖ ${error.message}\n`);
  }
  process.exit(1);
});















