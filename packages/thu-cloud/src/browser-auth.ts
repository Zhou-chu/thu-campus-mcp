import { chromium } from "playwright-core";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { AuthStore } from "./auth.js";
import { CLOUD, type Config } from "./config.js";
import { validateToken } from "./client.js";
import { CloudError } from "./types.js";
export function cookieToken(
  cookies: { name: string; value: string; domain: string }[],
): string | undefined {
  for (const c of cookies) {
    if (
      c.name !== "seahub_auth" ||
      c.domain.replace(/^\./, "") !== "cloud.tsinghua.edu.cn"
    )
      continue;
    try {
      let value = decodeURIComponent(c.value);
      if (value.startsWith('"') && value.endsWith('"'))
        value = value.slice(1, -1);
      const token = value.split("@").at(-1)!;
      if (/^[A-Za-z0-9._-]{20,512}$/.test(token) && token !== value)
        return token;
    } catch {
      /* invalid cookie */
    }
  }
}
export async function browserLogin(config: Config, channel = "msedge") {
  const store = new AuthStore(config.stateDir);
  const generation = await store.generation();
  const directory = await mkdtemp(path.join(tmpdir(), "thu-cloud-login-"));
  const browser = await chromium.launchPersistentContext(directory, {
    channel,
    headless: false,
    viewport: null,
  });
  try {
    const page = browser.pages()[0] || (await browser.newPage());
    await page.goto(CLOUD, { waitUntil: "domcontentloaded", timeout: 60000 });
    process.stderr.write(
      "请在新开的浏览器中完成清华云盘登录。凭据仅在本机处理，最多等待 10 分钟。\n",
    );
    const until = Date.now() + 600000;
    while (Date.now() < until) {
      if (!browser.pages().length)
        throw new CloudError("CANCELLED", "登录浏览器已关闭。");
      const token = cookieToken(await browser.cookies());
      if (token) {
        try {
          const data = await validateToken(token, config);
          await store.saveIfCurrent(data, generation);
          return {
            configured: true,
            mode: data.mode,
            protection: "Windows-DPAPI",
            message: "云盘令牌已在本机验证并加密保存。",
          };
        } catch (e) {
          if (
            !(e instanceof CloudError) ||
            !["AUTH_TOKEN", "AUTH_REQUIRED"].includes(e.code)
          )
            throw e;
        }
      }
      await new Promise((r) => setTimeout(r, 1500));
    }
    throw new CloudError(
      "AUTH_TIMEOUT",
      "等待登录超时；也可用 auth login 在终端隐藏输入 Web API Token。",
    );
  } finally {
    await browser.close();
    await rm(directory, { recursive: true, force: true });
  }
}
