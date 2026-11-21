import { loadAccount } from "./account.mjs";
import { login as seatLogin } from "./seat.mjs";
import { loginWithAccount as sportsLogin } from "./sports.mjs";

const describe = error => ({
  ok: false,
  code: error?.code || "LOGIN_FAILED",
  message: error?.message || "登录失败。",
});

/**
 * 一次操作把依赖统一账号的服务逐个登录。
 * 每个服务单独成败，失败如实返回，不影响其它服务。
 */
export async function loginAll({ account } = {}) {
  const credentials = account || (await loadAccount(process.env.THU_CAMPUS_APP_STATE_DIR || process.env.SEAT_STATE_DIR || "."));
  if (!credentials?.username || !credentials?.password)
    throw Object.assign(new Error("还没有配置清华账号，请先填写学号与密码。"), { code: "ACCOUNT_NOT_CONFIGURED" });

  const results = {};
  try {
    results.seat = { ok: true, ...(await seatLogin()) };
  } catch (error) {
    results.seat = describe(error);
  }
  try {
    results.sports = await sportsLogin(credentials);
  } catch (error) {
    results.sports = describe(error);
  }
  const succeeded = Object.values(results).filter(item => item.ok).length;
  return { ok: succeeded > 0, succeeded, total: Object.keys(results).length, results };
}