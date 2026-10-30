import { expect, it } from "vitest";
import { chromium } from "playwright-core";
import { runtimeInfo } from "@thu-campus/browser";
import { tryBrowserAutofillLogin } from "../src/autofill-login.js";

it("uses only filled HTTPS school forms, stops at captcha and limits submissions", async () => {
  const runtime = await runtimeInfo();
  expect(runtime.installed).toBe(true);
  const browser = await chromium.launch({ executablePath: runtime.executablePath!, headless: true });
  try {
    const page = await browser.newPage();
    await page.route("**/*", route => route.fulfill({ contentType: "text/html", body: `<form id="theform" action="/do/off/ui/auth/login/check"><input id="i_user"><input id="i_pass" type="password"><input id="c_code" hidden><a onclick="doLogin()">登录</a></form><script>window.submissions=0; function doLogin(){window.submissions++}</script>` }));
    await page.goto("https://id.tsinghua.edu.cn/do/off/ui/auth/login/form/test/0");
    const state = { submits: 0, lastClick: new Map<string, number>() };
    const limits = { maxSubmits: 2, minGapMs: 0 };
    expect(await tryBrowserAutofillLogin(page, state, limits, "synthetic-student")).toBe("waiting");
    await page.locator("#i_user").fill("synthetic-student");
    await page.locator("#i_pass").fill("synthetic-password");
    expect(await tryBrowserAutofillLogin(page, state, limits, "another-student")).toBe("none");
    expect(await page.evaluate(() => (window as any).submissions)).toBe(0);
    await page.locator("#c_code").evaluate(el => (el as HTMLElement).hidden = false);
    expect(await tryBrowserAutofillLogin(page, state, limits, "synthetic-student")).toBe("verification-required");
    expect(await page.evaluate(() => (window as any).submissions)).toBe(0);
    await page.locator("#c_code").evaluate(el => (el as HTMLElement).hidden = true);
    await page.locator("#theform").evaluate(el => (el as HTMLFormElement).action = "https://example.org/collect");
    expect(await tryBrowserAutofillLogin(page, state, limits, "synthetic-student")).toBe("none");
    await page.locator("#theform").evaluate(el => (el as HTMLFormElement).action = "/do/off/ui/auth/login/check");
    expect(await tryBrowserAutofillLogin(page, state, limits, "synthetic-student")).toBe("clicked");
    expect(await tryBrowserAutofillLogin(page, state, limits, "synthetic-student")).toBe("clicked");
    expect(await tryBrowserAutofillLogin(page, state, limits, "synthetic-student")).toBe("waiting");
    expect(await page.evaluate(() => (window as any).submissions)).toBe(2);
    await page.goto("http://learn.tsinghua.edu.cn/f/login");
    await page.setContent('<button id="loginButtonId" onclick="window.clicked=true">Login</button>');
    expect(await tryBrowserAutofillLogin(page, state, limits, "synthetic-student")).toBe("none");
  } finally { await browser.close(); }
}, 30000);
