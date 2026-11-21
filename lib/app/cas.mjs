/**
 * 统一身份认证（CAS）表单填充。
 * 只在用户已同意保存本机账号时使用；不处理验证码，遇到即停下并回报。
 */
export async function fillCasForm(page, { username, password }) {
  const filled = await page
    .evaluate(
      ({ user, pass }) => {
        const setValue = (element, value) => {
          if (!element) return false;
          element.focus();
          element.value = value;
          element.dispatchEvent(new Event("input", { bubbles: true }));
          element.dispatchEvent(new Event("change", { bubbles: true }));
          return true;
        };
        const userField = document.querySelector("input[name=i_user]") || document.querySelector("input[name=username]");
        const passField = document.querySelector("input[name=i_pass]") || document.querySelector("input[type=password]");
        return { user: setValue(userField, user), pass: setValue(passField, pass) };
      },
      { user: username, pass: password },
    )
    .catch(() => ({ user: false, pass: false }));
  if (!filled.user || !filled.pass) return { ok: false, code: "CAS_FORM_NOT_FOUND", message: "没有找到统一身份认证的账号/密码输入框。" };

  const hasCaptcha = await page
    .evaluate(() => /验证码|captcha/i.test(document.body?.innerText || "") || Boolean(document.querySelector('input[name=captcha], input[name=verifyCode]')))
    .catch(() => false);
  if (hasCaptcha) return { ok: false, code: "CAS_CAPTCHA_REQUIRED", message: "统一身份认证要求验证码，需要本人完成。" };

  const submitted = await page
    .evaluate(() => {
      const candidates = [...document.querySelectorAll("button, input[type=submit], input[type=button], a")];
      const button = candidates.find(element => (element.textContent || element.value || "").trim() === "登录");
      if (!button) return false;
      button.click();
      return true;
    })
    .catch(() => false);
  if (!submitted) return { ok: false, code: "CAS_SUBMIT_NOT_FOUND", message: "没有找到统一身份认证的登录按钮。" };
  return { ok: true };
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