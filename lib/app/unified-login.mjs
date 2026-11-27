/**
 * 清华账号直连登录：用学号/邮箱/用户名 + 统一身份认证密码换一次真实会话，
 * 成功了才保存凭据并签发设备令牌。校验借道学校统一身份认证（CAS）与受保护页面，
 * 不是只看格式——与 THU-Info 一类实现的判定口径一致。
 */
import { saveAccount } from "./account.mjs";
import { loginLearnxWithAccount, LearnxAccountLoginError } from "./learnx-login.mjs";

const ERROR_MESSAGES = {
  ACCOUNT_NOT_CONFIGURED: "请填写清华学号、邮箱或用户名。",
  CAS_CAPTCHA_REQUIRED: "统一身份认证要求验证码或二次验证，请在运行实例的浏览器里完成一次登录。",
  LEARNX_LOGIN_UNCONFIRMED: "统一身份认证没有确认这组凭据：请检查账号与密码是否正确。",
  LEARNX_LOGIN_TIMEOUT: "统一身份认证响应超时，请稍后重试。",
  AUTH_CHANGED: "登录期间账号配置发生变化，请重试。",
};

export class UnifiedLoginError extends Error {
  constructor(code, message, status = 401) {
    super(message);
    this.name = "UnifiedLoginError";
    this.code = code;
    this.status = status;
  }
}

const clean = (value, max) => (typeof value === "string" ? value.trim().slice(0, max) : "");

/**
 * @returns {Promise<{ok: true, username: string}>}
 * 失败抛 UnifiedLoginError；密码不会出现在错误信息或日志里。
 */
export async function loginWithUnifiedAccount({ account, password, stateDir, login = loginLearnxWithAccount, save = saveAccount, persist = true } = {}) {
  const username = clean(account, 128);
  const secret = typeof password === "string" ? password : "";
  if (!username) throw new UnifiedLoginError("ACCOUNT_REQUIRED", "请填写清华学号、邮箱或用户名。", 400);
  if (secret.length < 4 || secret.length > 128) throw new UnifiedLoginError("PASSWORD_REQUIRED", "请填写统一身份认证密码。", 400);
  try {
    const result = await login({ stateDir, credentials: { username, password: secret } });
    const usernameVerified = result?.username || username;
    // persist=false 只验证不落盘：调用方先签发令牌，再由 commit() 统一提交账号，失败可回滚。
    if (persist) {
      await save({ username: usernameVerified, password: secret }, stateDir);
      return { ok: true, username: usernameVerified };
    }
    return {
      ok: true,
      username: usernameVerified,
      // 密码留在闭包里，不通过返回值扩散；commit 只做一次保存。
      commit: async () => {
        await save({ username: usernameVerified, password: secret }, stateDir);
        return { ok: true, username: usernameVerified };
      },
    };
  } catch (error) {
    if (error instanceof LearnxAccountLoginError) {
      const message = ERROR_MESSAGES[error.code] || "统一身份认证未完成，请稍后重试。";
      const status = error.code === "CAS_CAPTCHA_REQUIRED" ? 409 : error.code === "LEARNX_LOGIN_TIMEOUT" ? 504 : 401;
      throw new UnifiedLoginError(error.code, message, status);
    }
    throw new UnifiedLoginError("UNIFIED_LOGIN_FAILED", "统一身份认证未完成，请稍后重试。", 502);
  }
}