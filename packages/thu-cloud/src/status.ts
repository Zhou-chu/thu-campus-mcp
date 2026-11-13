import { AuthStore } from "./auth.js";
import { digest } from "./storage.js";
import { CloudError, type Drive } from "./types.js";
import { makeDrive } from "./factory.js";
import type { Config } from "./config.js";

export type AccountDrive = Drive & {
  request?: (endpoint: string, init?: RequestInit) => Promise<any>;
};
export async function protectedAccount(drive: AccountDrive) {
  if (!drive.request)
    throw new CloudError(
      "ACCOUNT_API_UNSUPPORTED",
      "当前认证方式不能核验个人云盘账号。",
    );
  const result = await drive.request("/api2/account/info/");
  const email = result?.email;
  if (
    typeof email !== "string" ||
    email !== email.trim() ||
    !/^[^\s@]+@[^\s@]+$/.test(email)
  )
    throw new CloudError("UNVERIFIED", "受保护账号接口未返回有效稳定身份。");
  // The clear identity is internal only; tools must return the digest, never this record.
  drive.identity = digest(email).slice(0, 16);
  return { accountId: digest(email).slice(0, 32), identity: email };
}
export function authenticationFailure(error: unknown, configured = false) {
  const e = error as { code?: string; status?: number; name?: string };
  if (e.code === "AUTH_REQUIRED")
    return {
      state: configured ? "expired" : "login-required",
      code: configured ? "AUTH_EXPIRED" : "AUTH_REQUIRED",
      sessionValidity: configured ? "expired" : "unverified",
    };
  if (e.code === "AUTH_CHANGED")
    return {
      state: "unverified",
      code: "AUTH_CHANGED",
      sessionValidity: "unverified",
    };
  if (e.code === "ACCOUNT_API_UNSUPPORTED" || e.code === "UNVERIFIED")
    return { state: "unverified", code: e.code, sessionValidity: "unverified" };
  if (
    e.name === "TypeError" ||
    e.name === "TimeoutError" ||
    e.name === "AbortError" ||
    ["ECONNRESET", "ETIMEDOUT", "ENOTFOUND"].includes(e.code || "")
  )
    return {
      state: "unknown",
      code: "NETWORK_ERROR",
      sessionValidity: "unknown",
    };
  return {
    state: "unknown",
    code: e.code || "UNVERIFIED",
    sessionValidity: "unknown",
  };
}
export async function cloudStatus(
  config: Config,
  options: {
    verify?: boolean;
    drive?: AccountDrive;
    localStatus?: () => Promise<{
      configured: boolean;
      mode?: string;
      protection?: string;
    }>;
  } = {},
) {
  if (config.mock)
    return {
      mode: "mock",
      state: "mock",
      verified: false,
      checkedAt: null,
      source: "mock:cloud",
      code: "MOCK",
      sessionValidity: "unverified",
      authentication: { configured: false },
    };
  let configured = false;
  const verify = options.verify !== false;
  const checkedAt = verify ? new Date().toISOString() : null;
  try {
    const local = await (
      options.localStatus || (() => new AuthStore(config.stateDir).status())
    )();
    configured = local.configured;
    const authentication = {
      configured,
      mode: local.mode,
      protection: local.protection,
    };
    if (!verify)
      return {
        mode: "real",
        state: configured ? "unverified" : "login-required",
        verified: false,
        checkedAt,
        source: "local:cloud-auth-store",
        code: configured ? "UNVERIFIED" : "AUTH_REQUIRED",
        sessionValidity: "unverified",
        authentication,
      };
    if (!configured) throw new CloudError("AUTH_REQUIRED", "尚未登录云盘。");
    if (local.mode === "repo")
      throw new CloudError(
        "ACCOUNT_API_UNSUPPORTED",
        "资料库令牌不能核验个人账号身份，未宣称令牌过期。",
      );
    const account = await protectedAccount(
      options.drive || (await makeDrive(config)),
    );
    return {
      mode: "real",
      state: "ready",
      verified: true,
      checkedAt,
      source: "protected-api:cloud-account",
      code: "VERIFIED",
      sessionValidity: "verified",
      accountId: account.accountId,
      authentication,
    };
  } catch (error) {
    return {
      mode: "real",
      verified: false,
      checkedAt,
      source: verify ? "protected-api:cloud-account" : "local:cloud-auth-store",
      ...authenticationFailure(error, configured),
      authentication: { configured },
    };
  }
}
