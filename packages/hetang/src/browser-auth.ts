import {
  withBrowser,
  BrowserError,
  type BrowserOptions,
} from "@thu-campus/browser";
import { digest } from "./storage.js";
import { AuthStore } from "./auth.js";
import { ORIGIN, type Config } from "./config.js";
import { dataOf, identifier, parseJson } from "./protocol.js";
import { RainError } from "./types.js";
export async function browserLogin(
  config: Config,
  channel?: string,
  options: BrowserOptions = {},
) {
  const store = new AuthStore(config.stateDir),
    epoch = await store.generation();
  const prior = await store.load();
  const initialCookies = (prior?.cookieHeader || "")
    .split(";")
    .map((c) => c.trim())
    .filter((c) => c.includes("="))
    .map((c) => ({
      name: c.slice(0, c.indexOf("=")),
      value: c.slice(c.indexOf("=") + 1),
      domain: "pro.yuketang.cn",
      path: "/",
      secure: true,
      httpOnly: true,
      expires: -1,
    }));
  try {
    return await withBrowser(
      { ...options, initialCookies, channel },
      async (context) => {
        let bearerToken: string | undefined;
        context.on("request", async (request) => {
          try {
            if (new URL(request.url()).origin !== ORIGIN) return;
            const h = await request.allHeaders();
            const a = h.authorization;
            if (a?.startsWith("Bearer ")) bearerToken = a.slice(7);
          } catch {}
        });
        const page = context.pages()[0] || (await context.newPage());
        await page.goto(ORIGIN, {
          waitUntil: "domcontentloaded",
          timeout: 60000,
        });
        if (!options.headless)
          process.stderr.write(
            "请在独立浏览器扫码/登录雨课堂；此浏览器会保留会话。\n",
          );
        const until =
          Date.now() +
          (options.timeoutMs ?? (options.headless ? 15000 : 600000));
        while (Date.now() < until) {
          if (!context.pages().length)
            throw new RainError("CANCELLED", "登录窗口已关闭。");
          const cookies = await context.cookies(ORIGIN);
          if (cookies.some((c) => c.name === "sessionid" && c.value)) {
            const response = await context.request.get(
              ORIGIN + "/api/v3/user/basic-info",
              {
                headers: {
                  xtbz: "ykt",
                  "x-client": "h5",
                  Referer: ORIGIN + "/",
                },
                timeout: 15000,
                failOnStatusCode: false,
                maxRedirects: 0,
              },
            );
            if (response.ok()) {
              try {
                const raw = parseJson(await response.text());
                const d = dataOf(raw);
                const u = d.userInfo ?? d.user_info ?? d;
                const userId = identifier(u.userId ?? u.user_id ?? u.id);
                if (Number(raw.code ?? 0) === 0) {
                  if (
                    options.expectedAccountId &&
                    digest(userId).slice(0, 16) !== options.expectedAccountId
                  )
                    throw new RainError(
                      "BROWSER_ACCOUNT_MISMATCH",
                      "浏览器中的雨课堂账号与当前 MCP 账号不同，未替换认证。",
                    );
                  const newAuth = response.headers()["set-auth"];
                  if (newAuth) bearerToken = newAuth.replace(/^Bearer\s+/i, "");
                  const cookieHeader = (await context.cookies(ORIGIN))
                    .map((c) => c.name + "=" + c.value)
                    .join("; ");
                  await store.saveIfCurrent(
                    { account: userId, userId, cookieHeader, bearerToken },
                    epoch,
                  );
                  return {
                    configured: true,
                    verified: true,
                    protection: "Windows-DPAPI",
                  };
                }
              } catch (e) {
                if (
                  e instanceof RainError &&
                  ["AUTH_CHANGED", "BROWSER_ACCOUNT_MISMATCH"].includes(e.code)
                )
                  throw e;
              }
            }
          }
          await new Promise((r) => setTimeout(r, 2000));
        }
        throw new RainError(
          options.headless ? "BROWSER_LOGIN_REQUIRED" : "AUTH_TIMEOUT",
          "扫码登录等待超时，可重新运行 auth browser。",
        );
      },
    );
  } catch (e) {
    if (e instanceof BrowserError) throw new RainError(e.code, e.message);
    throw e;
  }
}
