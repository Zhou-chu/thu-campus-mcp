import {
  withBrowser,
  authGuard,
  BrowserError,
  type BrowserOptions,
} from "@thu-campus/browser";
import { digest } from "./storage.js";
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
export async function browserLogin(
  config: Config,
  channel?: string,
  options: BrowserOptions = {},
) {
  const store = new AuthStore(config.stateDir);
  const { epoch: generation, version } = await authGuard(store, {
    epoch: options.expectedGeneration,
    version: options.expectedVersion,
  });
  try {
    return await withBrowser({ ...options, channel }, async (browser) => {
      const page = browser.pages()[0] || (await browser.newPage());
      await page.goto(CLOUD, { waitUntil: "domcontentloaded", timeout: 60000 });
      if (!options.headless)
        process.stderr.write("请在独立浏览器完成云盘登录；登录状态会保留。\n");
      const until =
        Date.now() + (options.timeoutMs ?? (options.headless ? 15000 : 600000));
      while (Date.now() < until) {
        if (!browser.pages().length)
          throw new CloudError("CANCELLED", "登录浏览器已关闭。");
        const token = cookieToken(await browser.cookies());
        if (token) {
          try {
            const data = await validateToken(token, config);
            if (
              options.expectedAccountId &&
              digest(data.account).slice(0, 16) !== options.expectedAccountId
            )
              throw new CloudError(
                "BROWSER_ACCOUNT_MISMATCH",
                "浏览器中的云盘账号与当前 MCP 账号不同，未替换认证。",
              );
            const authVersion = await store.saveIfCurrent(
              data,
              generation,
              version,
            );
            return {
              authVersion,
              accountId: digest(data.account).slice(0, 16),
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
        options.headless ? "BROWSER_LOGIN_REQUIRED" : "AUTH_TIMEOUT",
        "等待登录超时；也可用 auth login 在终端隐藏输入 Web API Token。",
      );
    });
  } catch (e) {
    if (e instanceof BrowserError) throw new CloudError(e.code, e.message);
    throw e;
  }
}
