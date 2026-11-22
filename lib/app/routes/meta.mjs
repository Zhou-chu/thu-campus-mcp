/** 元信息、配对、设备与模型目录路由。 */
import { isLoopback, lanUrls, loginCapability } from "../settings.mjs";
import { requestUsesTrustedHttps } from "../transport.mjs";
import { fail, json } from "./respond.mjs";

export function createMetaRoutes({ config, route, overrides, serviceStates, devices, pairing, keepAlive, version, needsLoaded }) {
  return async function handleMetaRoutes(req, res, { pathname, method, url }) {
    if (pathname === "/api/meta" && method === "GET") {
      await needsLoaded();
      const status = await route.status().catch(() => ({ available: false, route: config.modelRoute }));
      const models = await route.models().catch(() => []);
      return json(res, 200, {
        ok: true,
        version,
        hostname: config.hostname,
        account: { bound: !!status.masked, masked: status.masked || "" },
        model: {
          route: status.route,
          name: overrides.modelName || models[0]?.id || "",
          available: !!status.available,
          reasoningEffort: overrides.reasoningEffort || "",
          reasoningEfforts: ["", "low", "medium", "high"],
        },
        models,
        services: await serviceStates(),
        pairing: { enabled: !config.token, deviceCount: await devices.count() },
        lanUrls: isLoopback(config.host) ? lanUrls(config.port) : [],
        loginCapability: loginCapability(),
        keepAlive: keepAlive
          ? {
              enabled: keepAlive.status().enabled,
              lastRunAt: keepAlive.status().lastRunAt,
              expiredServices: keepAlive.status().expiredServices,
            }
          : { enabled: false },
        security: {
          https: requestUsesTrustedHttps(req, config),
          hosted: !isLoopback(config.host) || !!config.publicUrl,
          publicUrl: config.publicUrl || null,
          allowRemote: !!config.allowRemote,
        },
      });
    }
    if (pathname === "/api/pair/invite" && method === "POST") {
      if (config.token) return fail(res, 403, "PAIRING_DISABLED", "已配置固定令牌，配对被禁用。");
      const issued = pairing.issue();
      return json(res, 200, {
        ok: true,
        code: issued.code,
        expiresAt: issued.expiresAt,
        ttlSeconds: issued.ttlSeconds,
        lanUrls: lanUrls(config.port),
      });
    }
    if (pathname === "/api/devices" && method === "GET") {
      await needsLoaded();
      return json(res, 200, { ok: true, devices: await devices.list() });
    }
    const deviceMatch = /^\/api\/devices\/([A-Za-z0-9-]+)$/.exec(pathname);
    if (deviceMatch && method === "DELETE") {
      await needsLoaded();
      const removed = await devices.revoke(deviceMatch[1]);
      return removed
        ? json(res, 200, { ok: true, revoked: deviceMatch[1] })
        : fail(res, 404, "DEVICE_NOT_FOUND", "设备不存在。");
    }
    if (pathname === "/api/models" && method === "GET") {
      try {
        const models = await route.models({ refresh: url.searchParams.get("refresh") === "1", strict: true });
        if (!models.length)
          return fail(res, 502, "MODEL_DISCOVERY_FAILED", "模型服务没有返回可用模型，请刷新重试。");
        return json(res, 200, {
          ok: true,
          models,
          current: overrides.modelName || models[0].id,
          route: config.modelRoute,
        });
      } catch {
        return fail(res, 502, "MODEL_DISCOVERY_FAILED", "无法获取模型列表，请检查网络后刷新重试。");
      }
    }
    return false;
  };
}