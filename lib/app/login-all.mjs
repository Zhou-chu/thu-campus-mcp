import { defaultAccountDir, loadAccount } from "./account.mjs";
import { login as seatLogin } from "./seat.mjs";
import { loginLearnxWithAccount } from "./learnx-login.mjs";
import { loginWithAccount as sportsLogin } from "./sports.mjs";

/** 单个服务的失败按“下一步能做什么”归档，而不是笼统的失败。 */
export function classifyLoginOutcome(error) {
  const code = error?.code || "LOGIN_FAILED";
  const message = error?.message || "登录失败。";
  const state =
    ["CAS_CAPTCHA_REQUIRED", "SEAT_LOGIN_UNCONFIRMED", "SPORTS_MANUAL_VERIFICATION"].includes(code) ? "needs-manual"
      : code === "BROWSER_BUSY" ? "busy"
        : ["SPORTS_UNREACHABLE", "SEAT_UNREACHABLE", "PROBE_FAILED", "UPSTREAM_FAILED"].includes(code) ? "unavailable"
          : code === "ACCOUNT_NOT_CONFIGURED" ? "not-configured"
            // 交给 worker 的任务已经提交、还没结束：不是失败，界面应继续跟着任务查进度。
            : code === "LOGIN_QUEUED" ? "queued"
              : "failed";
  return { ok: false, state, code, message, ...(error?.jobId ? { jobId: error.jobId } : {}) };
}

const success = extra => ({ ok: true, state: "ready", code: "VERIFIED", message: "", ...extra });

/** 直接登录的默认适配器；调用方可追加走 worker 任务的服务（cloud/hetang）。 */
export function loginAdapters(extra = {}) {
  return {
    learnx: ({ credentials }) => loginLearnxWithAccount({ credentials }),
    seat: () => seatLogin(),
    sports: ({ credentials }) => sportsLogin(credentials),
    ...extra,
  };
}

/**
 * 一次操作把依赖统一账号的服务逐个准备好。
 * - 每个服务独立成败，一个失败不影响其它服务；
 * - 结果带 state（ready / needs-manual / busy / unavailable / failed），
 *   上层据此决定是重试、提示本人验证，还是先关占用窗口；
 * - 适配器可注入，HTTP 入口与测试共用同一编排。
 */
export async function loginAll({ account, adapters, skip = [], services = [] } = {}) {
  const credentials = account || (await loadAccount(defaultAccountDir()));
  if (!credentials?.username || !credentials?.password)
    throw Object.assign(new Error("还没有配置清华账号，请先填写学号与密码。"), { code: "ACCOUNT_NOT_CONFIGURED" });

  const all = adapters || loginAdapters();
  // services 只收窄本次要准备的范围；未列出的适配器不执行。
  const selected = services.length ? Object.entries(all).filter(([name]) => services.includes(name)) : Object.entries(all);
  const results = {};
  for (const [name, prepare] of selected) {
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