import { launchEphemeral } from "@thu-campus/browser";
import { loadAccount } from "./account.mjs";
import { CAS_ORIGIN, fillCasForm } from "./cas.mjs";

const LEARN_ORIGIN = "https://learn.tsinghua.edu.cn";
const loadLearnx = async () => {
  const [auth, browserAuth, config] = await Promise.all([
    import("../../packages/learnx/dist/auth.js"),
    import("../../packages/learnx/dist/browser-auth.js"),
    import("../../packages/learnx/dist/config.js"),
  ]);
  return { ...auth, ...browserAuth, ...config };
};

export class LearnxAccountLoginError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "LearnxAccountLoginError";
    this.code = code;
  }
}
const loginError = (code, message) => new LearnxAccountLoginError(code, message);
const isCoursePage = url => url.origin === LEARN_ORIGIN && url.pathname.startsWith("/f/wlxt/");

/** 从空浏览器登录，不能把另一个账号的持久 Cookie 绑定到当前配置。 */
export function createLearnxAccountLogin({ launch = launchEphemeral, accountStore = loadAccount, learnx = loadLearnx, fill = fillCasForm } = {}) {
  return async ({ stateDir, sameAccountOnly = false, expectedAccount } = {}) => {
    const account = await accountStore(stateDir);
    if (expectedAccount && (account?.username !== expectedAccount.username || account?.password !== expectedAccount.password))
      throw loginError("AUTH_CHANGED", "恢复期间清华账号配置已变化，未登录。");
    if (!account) throw loginError("ACCOUNT_NOT_CONFIGURED", "请先在“清华账号”配置学号与密码。");
    const { AuthStore, loadConfig, browserSessionData, verifyBrowserSession } = await learnx();
    const store = new AuthStore(loadConfig().stateDir);
    const epoch = await store.generation();
    const version = (await store.version()) ?? null;
    if (sameAccountOnly) {
      const prior = await store.loadVersioned();
      if ((prior?.version ?? null) !== version) throw loginError("AUTH_CHANGED", "恢复期间网络学堂账号配置已变化，未登录。");
      if (prior && prior.data.account !== account.username) throw loginError("BROWSER_ACCOUNT_MISMATCH", "统一账号与原网络学堂账号不同，未自动换号。");
    }
    const browser = await launch({ headless: true });
    try {
      const context = await browser.newContext();
      const page = await context.newPage();
      await page.goto(`${LEARN_ORIGIN}/f/login`, { waitUntil: "domcontentloaded", timeout: 25000 });
      const entry = page.locator("#loginButtonId");
      await entry.click({ timeout: 10000 });
      await page.waitForURL(url => url.origin === CAS_ORIGIN, { timeout: 12000, waitUntil: "domcontentloaded" });
      await page.locator("input#i_pass, input[type=password]").first().waitFor({ state: "visible", timeout: 8000 }).catch(() => {});
      const submitted = await fill(page, account);
      if (!submitted.ok && submitted.code !== "CAS_SUBMIT_INTERRUPTED") throw loginError(submitted.code, submitted.message);
      const reached = await page.waitForURL(isCoursePage, { timeout: 18000, waitUntil: "domcontentloaded" }).then(() => true, () => false);
      if (!reached) {
        const challenge = await page.evaluate(origin => location.origin === origin && /验证码|短信验证|二次验证/.test(document.body?.innerText || ""), CAS_ORIGIN).catch(() => false);
        if (challenge) throw loginError("CAS_CAPTCHA_REQUIRED", "学校统一身份认证要求人工验证，未保存会话。");
        throw loginError("LEARNX_LOGIN_UNCONFIRMED", "统一身份认证未返回网络学堂，请核对已保存的账号和密码。");
      }
      const data = await browserSessionData(account.username, await context.cookies([LEARN_ORIGIN]), await page.content());
      if (!(await verifyBrowserSession(context, data.csrfToken))) {
        throw loginError("LEARNX_LOGIN_UNCONFIRMED", "网络学堂未通过登录核验，未保存会话。");
      }
      const current = await accountStore(stateDir);
      if (current?.username !== account.username || current?.password !== account.password) {
        throw loginError("AUTH_CHANGED", "登录期间清华账号配置已变化，未保存会话。");
      }
      await store.saveBrowserIfCurrent(data, epoch, version);
      return { ok: true };
    } catch (error) {
      // Playwright 的原始堆栈可能包含完整认证 URL，不转发给界面。
      if (error?.name === "TimeoutError") throw loginError("LEARNX_LOGIN_TIMEOUT", "网络学堂登录等待超时，请稍后重试。");
      throw error;
    } finally {
      await browser.close().catch(() => {});
    }
  };
}

export const loginLearnxWithAccount = createLearnxAccountLogin();
