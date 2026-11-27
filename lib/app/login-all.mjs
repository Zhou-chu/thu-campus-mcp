import { defaultAccountDir, loadAccount } from "./account.mjs";
import { login as seatLogin } from "./seat.mjs";
import { loginLearnxWithAccount } from "./learnx-login.mjs";
import { loginWithAccount as sportsLogin } from "./sports.mjs";

/** 单个服务的失败按“下一步能做什么”归档，而不是笼统的失败。 */
export function classifyLoginOutcome(error) {
  const code = error?.code || "LOGIN_FAILED";
  const message = error?.message || "登录失败。";
  if (["CAS_CAPTCHA_REQUIRED", "SEAT_LOGIN_UNCONFIRMED", "SPORTS_MANUAL_VERIFICATION"].includes(code))
    return { ok: false, state: "needs-manual", code, message };
  if (code === "BROWSER_BUSY") return { ok: false, state: "busy", code, message };
  if (["SPORTS_UNREACHABLE", "SEAT_UNREACHABLE", "PROBE_FAILED", "UPSTREAM_FAILED"].includes(code))
    return { ok: false, state: "unavailable", code, message };
  if (code === "ACCOUNT_NOT_CONFIGURED") return { ok: false, state: "not-configured", code, message };
  return { ok: false, state: "failed", code, message };
}

const success = extra => ({ ok: true, state: "ready", code: "VERIFIED", message: "", ...extra });

/**
 * 一次操作把依赖统一账号的服务逐个准备好。
 * - 每个服务独立成败，一个失败不影响其它服务；
 * - 结果带 state（ready / needs-manual / busy / unavailable / failed），
 *   上层据此决定是重试、提示本人验证，还是先关占用窗口；
 * - 适配器可注入，HTTP 入口与测试共用同一编排。
 */
export async function loginAll({ account, adapters, skip = [] } = {}) {
  const credentials = account || (await loadAccount(defaultAccountDir()));
  if (!credentials?.username || !credentials?.password)
    throw Object.assign(new Error("还没有配置清华账号，请先填写学号与密码。"), { code: "ACCOUNT_NOT_CONFIGURED" });

  const services = adapters || {
    learnx: ({ credentials: creds }) => loginLearnxWithAccount({ credentials: creds }),
    seat: () => seatLogin(),
    sports: ({ credentials: creds }) => sportsLogin(creds),
  };
  const results = {};
  for (const [name, prepare] of Object.entries(services)) {
    if (skip.includes(name)) {
      results[name] = { ok: true, state: "ready", code: "SKIPPED", message: "已经核验通过，未重复登录。" };
      continue;
    }
    try {
      const outcome = (await prepare({ credentials, name })) ?? {};
      results[name] = outcome.ok === false ? classifyLoginOutcome(outcome) : success(outcome?.alreadyLoggedIn ? { alreadyLoggedIn: true } : {});
    } catch (error) {
      results[name] = classifyLoginOutcome(error);
    }
  }
  const values = Object.values(results);
  return {
    ok: values.some(item => item.ok),
    total: values.length,
    ready: values.filter(item => item.ok).length,
    needsManual: values.filter(item => item.state === "needs-manual").map(item => item.code),
    busy: values.filter(item => item.state === "busy").length,
    results,
  };
}