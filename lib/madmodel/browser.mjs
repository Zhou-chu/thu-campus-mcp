import { withBrowser, browserStatus } from "../../packages/browser/index.mjs";
import { ORIGIN, LOGIN_URL, parseToken, error } from "./protocol.mjs";
async function goto(page, url, timeout) {
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout });
  } catch (e) {
    if (!/interrupted|ERR_ABORTED/.test(String(e.message))) throw e;
  }
}
export async function browserLogin({
  previous,
  force = false,
  headless = true,
  signal,
  interactive = false,
  timeoutMs = 60000,
  verify,
}) {
  const [{ tryBrowserAutofillLogin }, { AuthStore }, { loadConfig }] =
    await Promise.all([
      import("../../packages/learnx/dist/autofill-login.js"),
      import("../../packages/learnx/dist/auth.js"),
      import("../../packages/learnx/dist/config.js"),
    ]);
  const bound = await new AuthStore(loadConfig().stateDir).load();
  const expected = previous?.account || bound?.account || "";
  if (headless && !(await browserStatus()).snapshotSafeToRestore)
    throw error(
      "BROWSER_LOGIN_REQUIRED",
      "浏览器上次未正常保存，请先本机登录。",
      401,
    );
  return withBrowser({ headless, signal }, async (context) => {
    const page = context.pages()[0] || (await context.newPage());
    // The shared autofill helper may see the SSO URL immediately before a
    // redirect removes its form. Bound locator waits so that navigation race
    // cannot consume the entire login deadline waiting for a vanished form.
    page.setDefaultTimeout(1000);
    const deadline = Date.now() + timeoutMs,
      state = { submits: 0, lastClick: new Map() };
    let authReturned = !force,
      forced = false;
    await goto(page, force ? LOGIN_URL : ORIGIN, Math.min(15000, timeoutMs));
    while (Date.now() < deadline) {
      signal?.throwIfAborted();
      if (page.isClosed())
        throw error("BROWSER_LOGIN_REQUIRED", "登录窗口已关闭。", 401);
      const u = new URL(page.url());
      if (u.origin === ORIGIN && u.pathname === "/authLogin")
        authReturned = true;
      if (u.origin === ORIGIN && u.pathname !== "/authLogin") {
        const token = await page.evaluate(() => {
          try {
            return JSON.parse(localStorage.getItem("user") || "{}").token || "";
          } catch {
            return "";
          }
        });
        if (token && authReturned) {
          let data;
          try {
            data = parseToken(token);
          } catch {}
          if (
            data &&
            data.expiresAt > Date.now() + 60000 &&
            (await verify(token, signal))
          ) {
            if (
              (previous?.accountId && data.accountId !== previous.accountId) ||
              (expected && data.account !== expected)
            )
              throw error(
                "BROWSER_ACCOUNT_MISMATCH",
                "MadModel 账号与绑定不一致。",
                409,
              );
            return { token, ...data };
          }
        }
        // Start SSO only once after the SPA has had time to restore or redirect.
        if (!forced && Date.now() > deadline - timeoutMs + 2000) {
          forced = true;
          authReturned = false;
          await goto(
            page,
            LOGIN_URL,
            Math.min(15000, Math.max(1, deadline - Date.now())),
          );
        }
      }
      // A fast callback can navigate through /authLogin between polls. The new
      // token is then the evidence that the force-login callback completed.
      if (force && u.origin === ORIGIN && u.pathname === "/") {
        const changed = await page.evaluate((old) => {
          try {
            const t = JSON.parse(localStorage.getItem("user") || "{}").token;
            return !!t && t !== old;
          } catch {
            return false;
          }
        }, previous?.token || "");
        if (changed) authReturned = true;
      }
      if (process.env.THU_CAMPUS_AUTOFILL_LOGIN !== "0") {
        const step = await tryBrowserAutofillLogin(
          page,
          state,
          undefined,
          expected,
        );
        if (step === "verification-required" && headless)
          throw error("VERIFICATION_REQUIRED", "需要验证码。", 401);
      }
      await new Promise((resolve) => {
        const onAbort = () => {
          clearTimeout(timer);
          resolve();
        };
        const timer = setTimeout(() => {
          signal?.removeEventListener("abort", onAbort);
          resolve();
        }, 500);
        signal?.addEventListener("abort", onAbort, { once: true });
      });
    }
    throw error(
      "BROWSER_LOGIN_REQUIRED",
      interactive
        ? "本机登录等待超时。"
        : "自动登录超时，请运行 madmodel login。",
      401,
    );
  });
}
