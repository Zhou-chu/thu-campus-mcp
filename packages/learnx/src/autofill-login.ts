import type { Page } from "playwright-core";

export type AutofillStep = "clicked" | "waiting" | "verification-required" | "none";

/** Use only browser-saved credentials; return no password data to Node. */
export async function tryBrowserAutofillLogin(
  page: Page,
  state: { submits: number; lastClick: Map<string, number> },
  limits = { maxSubmits: 2, minGapMs: 2000 },
  expectedAccount = "",
): Promise<AutofillStep> {
  let url: URL;
  try { url = new URL(page.url()); } catch { return "none"; }
  const now = Date.now();
  const gated = (key: string) => now - (state.lastClick.get(key) ?? 0) < limits.minGapMs;
  const mark = (key: string) => state.lastClick.set(key, now);
  const visible = async (selector: string) => {
    try { const l = page.locator(selector).first(); return (await l.count()) > 0 && (await l.isVisible()); } catch { return false; }
  };
  try {
    if (url.origin === "https://learn.tsinghua.edu.cn") {
      if (await visible("a.chongxin")) {
        if (gated("chongxin")) return "waiting";
        mark("chongxin");
        await page.locator("a.chongxin").first().click({ timeout: 5000 });
        return "clicked";
      }
      if (url.pathname.startsWith("/f/login") && (await visible("#loginButtonId"))) {
        if (gated("loginButton")) return "waiting";
        mark("loginButton");
        await page.locator("#loginButtonId").click({ timeout: 5000 });
        return "clicked";
      }
      return "none";
    }
    if (url.origin === "https://id.tsinghua.edu.cn" && url.pathname.startsWith("/do/off/ui/auth/login/form/")) {
      if (await visible("#c_code")) return "verification-required";
      const action = await page.locator("#theform").getAttribute("action");
      if (!action || new URL(action, url).href !== "https://id.tsinghua.edu.cn/do/off/ui/auth/login/check") return "none";
      const user = page.locator("#i_user"), pass = page.locator("#i_pass");
      if (!(await user.isVisible()) || !(await pass.isVisible())) return "waiting";
      // Chromium restores the saved sign-in a moment after load; wait for it instead of submitting an empty form.
      const filled = (await user.evaluate(el => Boolean((el as HTMLInputElement).value))) && (await pass.evaluate(el => Boolean((el as HTMLInputElement).value)));
      if (!filled) return "waiting";
      if (!expectedAccount || (await user.inputValue()).trim() !== expectedAccount) return "none";
      if (state.submits >= limits.maxSubmits) return "waiting";
      if (gated("idSubmit")) return "waiting";
      mark("idSubmit");
      state.submits++;
      await page.locator("#theform a[onclick*='doLogin']").first().click({ timeout: 5000 });
      return "clicked";
    }
  } catch {
    return "waiting";
  }
  return "none";
}
