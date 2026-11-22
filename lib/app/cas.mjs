/**
 * 统一身份认证（CAS）表单填充。
 * 只在用户已同意保存本机账号时使用；不处理验证码，遇到即停下并回报。
 */
export const CAS_ORIGIN = "https://id.tsinghua.edu.cn";

export async function fillCasForm(page, { username, password }) {
  const status = await page.evaluate(({ origin, user, pass }) => {
    if (location.origin !== origin) return "CAS_WRONG_ORIGIN";
    const visible = element => Boolean(element?.getClientRects().length && getComputedStyle(element).visibility === "visible");
    const hasChallenge = () => /验证码|短信验证|二次验证/.test(document.body?.innerText || "") ||
      [...document.querySelectorAll('input[name=captcha], input[name=verifyCode], input[autocomplete=one-time-code]')].some(visible);
    if (hasChallenge()) return "CAS_CAPTCHA_REQUIRED";
    const userField = [...document.querySelectorAll("input#i_user, input[name=i_user], input[name=username]")].find(visible);
    const passField = [...document.querySelectorAll("input#i_pass, input[name=i_pass], input[type=password]")].find(visible);
    if (!userField || !passField) return "CAS_FORM_NOT_FOUND";
    const button = [...document.querySelectorAll("button, input[type=submit], input[type=button], a")]
      .find(element => visible(element) && (element.textContent || element.value || "").replace(/\s/g, "") === "登录");
    if (!button) return "CAS_SUBMIT_NOT_FOUND";
    for (const [element, value] of [[userField, user], [passField, pass]]) {
      element.focus();
      element.value = value;
      element.dispatchEvent(new Event("input", { bubbles: true }));
      element.dispatchEvent(new Event("change", { bubbles: true }));
    }
    if (hasChallenge()) return "CAS_CAPTCHA_REQUIRED";
    button.click();
    return "submitted";
  }, { origin: CAS_ORIGIN, user: username, pass: password }).catch(() => "CAS_SUBMIT_INTERRUPTED");
  if (status === "submitted") return { ok: true };
  const messages = {
    CAS_WRONG_ORIGIN: "不是清华统一身份认证页面，未填写账号与密码。",
    CAS_CAPTCHA_REQUIRED: "统一身份认证要求验证码，需要本人完成。",
    CAS_FORM_NOT_FOUND: "没有找到统一身份认证的账号/密码输入框。",
    CAS_SUBMIT_NOT_FOUND: "没有找到统一身份认证的登录按钮。",
    CAS_SUBMIT_INTERRUPTED: "登录页面已变化，未确认提交结果。",
  };
  return { ok: false, code: status, message: messages[status] };
}

/** 轮询等待某个判定条件成立（登录后页面刷新/跳转）。 */
export async function waitFor(page, predicate, { timeoutMs = 20_000, intervalMs = 800 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ok = await page.evaluate(predicate).catch(() => false);
    if (ok) return true;
    await page.waitForTimeout(intervalMs);
  }
  return false;
}