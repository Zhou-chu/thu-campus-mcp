/**
 * 公开（未登录）认证入口：清华账号直连登录、会话码兑换、设备配对。
 * 单独成模块，组合根只负责装配——这几条都必须在鉴权门之前处理。
 */
import { publicBase } from "../settings.mjs";
import { requestCanCarrySecrets } from "../transport.mjs";
import { PairingError, readInvite, clearInvite } from "../pairing.mjs";
import { UnifiedLoginError } from "../unified-login.mjs";

const PLATFORMS = new Set(["webui", "desktop", "android", "harmony"]);
const platformOf = value => (PLATFORMS.has(value) ? value : "webui");
const deviceNameOf = (value, fallback) => (typeof value === "string" && value.trim() ? value.slice(0, 64) : fallback);
/** 回复后返回 true：告诉组合根这条请求已经处理完。 */
const handled = reply => reply.then(() => true);

export function createPublicAuthRoutes({ config, devices, pairing, exchange, unifiedLogin, readBody, logger, json, fail }) {
  return async function handlePublicAuth(req, res, { pathname, method }) {
    if (pathname === "/api/auth/unified") {
      // 清华账号直连登录：凭据必须走 HTTPS/回环；校验成功才签发设备令牌。
      if (method !== "POST") return handled(fail(res, 405, "METHOD_NOT_ALLOWED", "不支持的请求方法。"));
      if (!requestCanCarrySecrets(req, config)) return handled(fail(res, 403, "UNIFIED_HTTPS_REQUIRED", "请通过HTTPS或本机回环地址登录。"));
      if (config.token) return handled(fail(res, 403, "UNIFIED_LOGIN_DISABLED", "该实例使用固定令牌，不开放账号登录。"));
      const body = await readBody(req, 8192).catch(() => null);
      try {
        const result = await unifiedLogin({ account: body?.account, password: body?.password, stateDir: config.stateDir });
        const issued = await devices.issue({ name: deviceNameOf(body?.deviceName, "清华账号登录"), platform: platformOf(body?.platform) });
        logger("unified-login", { username: result?.username || "" });
        return handled(json(res, 200, { ok: true, username: result?.username || "", token: issued.token, deviceId: issued.id, baseUrl: publicBase(config) }));
      } catch (error) {
        if (error instanceof UnifiedLoginError) return handled(fail(res, error.status, error.code, error.message));
        throw error;
      }
    }
    if (pathname !== "/api/session/redeem" && pathname !== "/api/pair/redeem") return false;
    if (method !== "POST") return handled(fail(res, 405, "METHOD_NOT_ALLOWED", "不支持的请求方法。"));
    if (!requestCanCarrySecrets(req, config)) return handled(fail(res, 403, "PAIRING_HTTPS_REQUIRED", "请通过HTTPS或本机回环地址完成连接。"));
    const body = await readBody(req, 8192);
    if (pathname === "/api/session/redeem") {
      const token = exchange.redeem(body?.code);
      if (!token) return handled(fail(res, 403, "SESSION_CODE_INVALID", "会话码无效或已过期，请从本机重新打开。"));
      return handled(json(res, 200, { ok: true, token, baseUrl: publicBase(config) }));
    }
    if (config.token) return handled(fail(res, 403, "PAIRING_DISABLED", "已配置固定令牌，配对被禁用。"));
    try {
      pairing.consume(body.code);
    } catch (error) {
      // 回落到 `app invite` 预生成的邀请码（守护进程场景，控制台不可见）。
      const invite = readInvite(config.stateDir);
      if (invite && String(body.code || "").trim() === invite.code) await clearInvite(config.stateDir);
      else if (error instanceof PairingError) return handled(fail(res, 403, error.code, error.message));
      else throw error;
    }
    const platform = platformOf(body.platform);
    const issued = await devices.issue({ name: deviceNameOf(body.deviceName, "未命名设备"), platform });
    logger("device-paired", { platform });
    return handled(json(res, 200, { ok: true, token: issued.token, deviceId: issued.id, baseUrl: publicBase(config) }));
  };
}