import { type Cookie, type BrowserContext } from "playwright-core";
import {
  withBrowser,
  authGuard,
  BrowserError,
  type BrowserOptions,
} from "@thu-campus/browser";
import { CookieJar } from "tough-cookie";
import * as cheerio from "cheerio";
import { AuthStore, type AuthData } from "./auth.js";
import { LearnError } from "./types.js";
import { digest } from "./storage.js";
export async function verifyBrowserSession(
  context: BrowserContext,
  csrfToken: string,
): Promise<boolean> {
  try {
    const response = await context.request.get(
      "https://learn.tsinghua.edu.cn/b/kc/zhjw_v_code_xnxq/getCurrentAndNextSemester?_csrf=" +
        encodeURIComponent(csrfToken),
      { timeout: 15000, maxRedirects: 0, failOnStatusCode: false },
    );
    if (!response.ok()) return false;
    const data = await response.json();
    return data.message === "success" && Boolean(data.result?.id);
  } catch {
    return false;
  }
}
export async function browserSessionData(
  account: string,
  cookies: Cookie[],
  html: string,
): Promise<AuthData> {
  const $ = cheerio.load(html);
  const token =
    $('meta[name="_csrf"]').attr("content") ||
    $('input[name="_csrf"]').attr("value") ||
    html.replace(/&amp;/g, "&").match(/[?&]_csrf=([^\s"'<>&]+)/)?.[1];
  if (!token)
    throw new LearnError(
      "AUTH_TOKEN",
      "当前页面没有可识别的网络学堂 CSRF，会话未保存。",
    );
  const jar = new CookieJar();
  let count = 0;
  for (const c of cookies) {
    const domain = c.domain.replace(/^\./, "");
    if (!["learn.tsinghua.edu.cn", "id.tsinghua.edu.cn"].includes(domain))
      continue;
    await jar.setCookie(
      `${c.name}=${c.value}; Domain=${c.domain}; Path=${c.path}${c.secure ? "; Secure" : ""}${c.httpOnly ? "; HttpOnly" : ""}${c.expires > 0 ? "; Expires=" + new Date(c.expires * 1000).toUTCString() : ""}`,
      `https://${domain}`,
    );
    if (domain === "learn.tsinghua.edu.cn") count++;
  }
  if (!count)
    throw new LearnError("AUTH_COOKIE", "没有网络学堂 Cookie，会话未保存。");
  return { account, csrfToken: token, cookieJar: jar.toJSON() };
}
export async function browserLogin(
  store: AuthStore,
  account: string,
  channel?: string,
  options: BrowserOptions = {},
) {
  const { epoch, version } = await authGuard(store, {
    epoch: options.expectedGeneration,
    version: options.expectedVersion,
  });
  const old = await store.load();
  const initialCookies = old?.cookieJar
    ? CookieJar.fromJSON(old.cookieJar as any)
        .toJSON()
        .cookies.filter((c) =>
          ["learn.tsinghua.edu.cn", "id.tsinghua.edu.cn"].includes(
            c.domain.replace(/^\./, ""),
          ),
        )
        .map((c) => ({
          name: c.key,
          value: c.value,
          domain: (c.hostOnly ? "" : ".") + c.domain.replace(/^\./, ""),
          path: c.path || "/",
          secure: Boolean(c.secure),
          httpOnly: Boolean(c.httpOnly),
          expires: Number.isFinite(Date.parse(String(c.expires)))
            ? Date.parse(String(c.expires)) / 1000
            : -1,
        }))
    : [];
  try {
    return await withBrowser(
      { ...options, initialCookies, channel },
      async (context) => {
        const page = context.pages()[0] || (await context.newPage());
        await page.goto(
          "https://learn.tsinghua.edu.cn/f/wlxt/index/course/student/",
          { waitUntil: "domcontentloaded", timeout: 60000 },
        );
        if (!options.headless)
          process.stderr.write(
            "请在独立浏览器完成学校登录；此浏览器会保留登录状态。\n",
          );
        const until =
          Date.now() +
          (options.timeoutMs ?? (options.headless ? 15000 : 600000));
        while (Date.now() < until) {
          if (!context.pages().length)
            throw new LearnError("CANCELLED", "登录浏览器已关闭。");
          for (const candidate of context.pages()) {
            const url = new URL(candidate.url());
            if (
              url.hostname !== "learn.tsinghua.edu.cn" ||
              !url.pathname.includes("/f/wlxt/")
            )
              continue;
            try {
              const data = await browserSessionData(
                account,
                await context.cookies(),
                await candidate.content(),
              );
              if (!(await verifyBrowserSession(context, data.csrfToken!)))
                continue;
              const authVersion = await store.saveBrowserIfCurrent(
                data,
                epoch,
                version,
              );
              return {
                authVersion,
                accountId: digest(data.account).slice(0, 16),
                configured: true,
                method: "persistent-browser",
                message: "已验证并保存本机持久浏览器会话。",
              };
            } catch (error) {
              if (
                !(
                  error instanceof LearnError &&
                  ["AUTH_TOKEN", "AUTH_COOKIE"].includes(error.code)
                )
              )
                throw error;
            }
          }
          await new Promise((r) => setTimeout(r, 1000));
        }
        throw new LearnError(
          options.headless ? "BROWSER_LOGIN_REQUIRED" : "AUTH_TIMEOUT",
          "浏览器会话需人工登录，请运行 browser login learnx。",
        );
      },
    );
  } catch (e) {
    if (e instanceof BrowserError) throw new LearnError(e.code, e.message);
    throw e;
  }
}
