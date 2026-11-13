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

let lastRequestedModel = "";
const route = {
  route: "madmodel",
  async models() {
    return [{ id: "e2e-model", label: "E2E 模型" }, { id: "e2e-second", label: "第二个模型" }];
  },
  async status() {
    return { route: "madmodel", available: true, configured: true, masked: "2024****0419" };
  },
  async chat(request) {
    lastRequestedModel = request.model;
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
  // 有实际消息、Markdown表格和工具记录的排版样本，不能只验空白页。
  await sessionStore.append(history.id, [
    { role: "assistant", content: "这是排版回归样本，不代表真实课程结果。\n\n长段中文与EnglishIdentifier需要在宽屏、窄屏中保持适当的阅读比例，不能用微型字号配合大片留白。工具名称、完成状态与操作控件也必须清楚可读。" },
    ...Array.from({ length: 6 }, (_, index) => [
      { role: "assistant", content: "", toolCalls: [{ id: "layout-" + index, name: index === 0 ? "learn_sync_semester" : "learn_sync_status", arguments: "{}" }] },
      { role: "tool", toolCallId: "layout-" + index, name: "learn_sync_status", content: JSON.stringify({ ok: true, data: { phase: "running", completed: index, total: 14, fixture: true } }) },
    ]).flat(),
    { role: "assistant", content: "排版样本结束。实际后台任务未完成时必须如实报告状态，不能编造结果。" },
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
  let expectedModelError = false;
  const consoleErrors = [];
  page.on("console", (message) => {
    const expected = expectedModelError && message.location().url.includes("/api/models") && message.text().includes("502");
    if (message.type() === "error" && !expected) consoleErrors.push(message.text());
  });
  page.on("pageerror", (error) => consoleErrors.push(String(error)));
  const badResponses = [];
  page.on("response", (response) => {
    const expected = expectedModelError && new URL(response.url()).pathname === "/api/models" && response.status() === 502;
    if (response.status() >= 400 && !expected) badResponses.push(`${response.status()} ${response.url()}`);
  });

  try {
    // 1. 未带令牌 → 配对页
    await page.goto(`${base}/`, { waitUntil: "load" });
    record("配对页可见", await page.locator("#pair").isVisible());
    record("主应用隐藏", !(await page.locator("#app").isVisible()));
    record("配对帮助默认折叠", !(await page.locator("#pair code").isVisible()));
    await page.locator("#pair summary").click();
    record("配对码获取方式可展开", await page.locator("#pair code").isVisible());
    await page.fill("#pair-code", "12");
    await page.click("#pair-submit");
    record("必要的配对错误反馈保留", await page.locator("#pair-error").isVisible());

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
    const firstRow = page.locator(".session-row").filter({ hasText: "雨课堂签到的自动提醒" }).first();
    await firstRow.getByRole("button", { name: "重命名" }).click({ timeout: 8000 });
    step("已进入重命名");
    const titleInput = page.getByRole("textbox", { name: "会话标题", exact: true });
    await titleInput.fill("端到端改名");
    await titleInput.press("Enter");
    await page.waitForFunction(() => document.body.innerText.includes("端到端改名"), null, { timeout: 8000 });
    record("重命名即时生效", true);

    // 5.6 历史会话：消息与 Markdown 表格都要真的渲染
    await page.click('button[data-view="sessions"]');
    await page.waitForSelector(".session-row");
    await page.fill('input[type="search"]', "历史会话回归");
    await page.locator(".session-row .item").filter({ hasText: "历史会话回归" }).first().click();
    await page.waitForSelector("#messages .bubble");
    record("历史消息已渲染", (await page.locator("#messages .bubble").count()) >= 2);
    record("Markdown 表格已渲染", (await page.locator("#messages table.rich-table").count()) === 1);
    record(
      "表格内容正确",
      (await page.locator("#messages table.rich-table td").first().innerText()).includes("11-16"),
    );

    // 6. 设置页：常驻卡片与设计目录入口
    await page.click('button[data-view="settings"]');
    const help = page.locator(".help-panel");
    record("帮助默认折叠", (await help.getAttribute("open")) === null);
    record("设置不再提供机械工具步数限制", (await page.locator('#view input[type="number"]').count()) === 0 && !(await page.locator("#view").innerText()).includes("工具步数"));
    record("说明与诊断不常驻", !(await page.locator("#view").innerText()).includes("运行信息"));
    record("开发设计入口默认隐藏", !(await page.locator('a[href="/preview.html"]').isVisible()));
    await page.locator(".help-panel > summary").click();
    await page.getByText("使用说明", { exact: true }).click();
    record("使用说明可主动展开", (await help.innerText()).includes("Enter发送"));
    await page.getByText("诊断信息", { exact: true }).click();
    record("诊断内保留常驻管理", (await help.innerText()).includes("常驻"));
    record("设计目录可主动访问", await page.locator('a[href="/preview.html"]').isVisible());

    // 模型全量列表、自动保存、持久化和真实请求参数（不消耗上游额度）
    if (!urlArg) {
      await page.waitForFunction(() => document.querySelector('#settings-model')?.options.length === 2);
      record("完整模型目录供选择", (await page.locator('#settings-model option').count()) === 2);
      await page.selectOption('#settings-model', 'e2e-second');
      await page.waitForFunction(() => !document.querySelector('#settings-model').disabled);
      const saved = await (await fetch(base + '/api/settings', { headers: { authorization: 'Bearer ' + TOKEN } })).json();
      record("选择模型自动保存", saved.settings.modelName === 'e2e-second');
      await page.click('button[data-view="chat"]');
      record("对话与设置模型一致", (await page.inputValue('#chat-model')) === 'e2e-second');
      await page.fill('#composer', '保留这份草稿');
      await page.getByRole('button', { name: '刷新模型', exact: true }).click();
      await page.waitForFunction(() => !document.querySelector('#chat-model').disabled);
      record("刷新模型不丢草稿", (await page.inputValue('#composer')) === '保留这份草稿');
      await page.fill('#composer', '模型参数测试');
      await page.click('#chat-send');
      await page.waitForFunction(() => document.querySelector('#messages')?.textContent.includes('端到端回复') && !document.querySelector('#chat-send').disabled);
      record("所选模型实际发送到后端", lastRequestedModel === 'e2e-second', lastRequestedModel);
      await page.reload({ waitUntil: 'load' });
      await page.waitForSelector('#chat-model');
      record("刷新页面保留模型选择", (await page.inputValue('#chat-model')) === 'e2e-second');
      record("空闲模型栏无说明小字", await page.locator(".model-status").isHidden());
      record("消息输入有独立名称", (await page.getByRole("textbox", { name: "消息", exact: true }).count()) === 1);
      let releaseRefresh;
      const refreshGate = new Promise(resolve => { releaseRefresh = resolve; });
      expectedModelError = true;
      await page.route("**/api/models?refresh=1", async intercepted => {
        await refreshGate;
        await intercepted.fulfill({ status: 502, contentType: "application/json", body: JSON.stringify({ ok: false, error: { code: "MODEL_DISCOVERY_FAILED", message: "模型目录暂不可用，请重试。" } }) });
      });
      await page.fill("#composer", "出错时也保留草稿");
      await page.getByRole("button", { name: "刷新模型", exact: true }).click();
      record("必要加载状态可见", await page.locator(".model-status").isVisible() && await page.locator("#chat-model").isDisabled());
      releaseRefresh();
      await page.waitForFunction(() => !document.querySelector("#chat-model").disabled);
      record("模型错误仍清晰可见", (await page.locator(".model-status.error").innerText()).includes("请重试"));
      record("失败不清空草稿或旧目录", (await page.inputValue("#composer")) === "出错时也保留草稿" && (await page.locator("#chat-model option").count()) === 2);
      await page.unroute("**/api/models?refresh=1");
      expectedModelError = false;
      await page.getByRole("button", { name: "刷新模型", exact: true }).click();
      await page.waitForFunction(() => !document.querySelector("#chat-model").disabled);
      record("重试成功收起错误行", await page.locator(".model-status").isHidden());
    }

    // 载入有消息、表格及工具记录的会话，再检查几何和实际computed字号。
    await page.click('button[data-view="sessions"]');
    await page.fill('input[type="search"]', "历史会话回归");
    await page.locator(".session-row .item").filter({ hasText: "历史会话回归" }).first().click();
    await page.waitForSelector("#messages .tool-card");
    for (const width of [1920, 2560, 1536, 1280, 390]) {
      await page.setViewportSize({ width, height: width < 900 ? 844 : 1080 });
      await page.click('button[data-view="chat"]');
      const geometry = await page.evaluate(() => {
        const chat = document.querySelector('.chat').getBoundingClientRect();
        const dock = document.querySelector('.chat-dock').getBoundingClientRect();
        const messages = document.querySelector('#messages').getBoundingClientRect();
        const composer = document.querySelector('.composer').getBoundingClientRect();
        const nav = document.querySelector('.tabbar').getBoundingClientRect();
        const rail = innerWidth >= 900 ? nav.right : 0;
        return {
          centered: Math.abs((chat.left - rail) - (innerWidth - chat.right)) < 3,
          aligned: Math.abs(messages.left - dock.left) < 2 && Math.abs(messages.right - dock.right) < 2,
          visible: composer.bottom <= innerHeight && composer.top > 0 && messages.height > 150,
          noOverflow: document.documentElement.scrollWidth <= innerWidth,
        };
      });
      record(width + '宽布局居中且输入区可见', Object.values(geometry).every(Boolean), JSON.stringify(geometry));
      const typography = await page.evaluate(() => {
        const size = selector => parseFloat(getComputedStyle(document.querySelector(selector)).fontSize);
        return { message: size(".bubble.assistant"), tool: size(".tool-name"), status: size(".tool-state"), button: size("#chat-send"), select: size("#chat-model"), table: size(".rich-table") };
      });
      const large = width >= 1600, desktop = width >= 900;
      const legible = typography.message >= (large ? 20 : desktop ? 18 : 16)
        && typography.button >= (large ? 17 : desktop ? 16 : 15)
        && typography.status >= (large ? 16 : desktop ? 15 : 14)
        && typography.tool >= 16 && typography.select >= 16 && typography.table >= 16;
      record(width + "宽带内容字号符合阅读比例", legible, JSON.stringify(typography));
      if (process.env.CAMPUS_E2E_SCREENSHOT_DIR) {
        await page.evaluate(() => { document.querySelector("#messages").scrollTop = 0; });
        await page.screenshot({ path: path.join(process.env.CAMPUS_E2E_SCREENSHOT_DIR, "readability-" + width + ".png") });
      }
    }
    await page.setViewportSize({ width: 390, height: 640 });
    record("窄屏矮窗口仍可输入和阅读", await page.evaluate(() => document.querySelector(".composer").getBoundingClientRect().bottom <= innerHeight && document.querySelector("#messages").getBoundingClientRect().height > 150));
    await page.click("#theme-dark");
    record("深色带内容字号不缩水", await page.evaluate(() => parseFloat(getComputedStyle(document.querySelector(".bubble.assistant")).fontSize) >= 16));
    await page.click("#theme-light");
    await page.setViewportSize({ width: 1280, height: 900 });

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
