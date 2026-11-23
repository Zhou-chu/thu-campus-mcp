/** 第三方模型提供商 HTTP 路由：配置、启用、连接测试与模型列表导入。 */
import { ProviderError, fetchProviderModels } from "../providers.mjs";
import { fail, json } from "./respond.mjs";

export function createProviderRoutes({ store, readBody, hydrate = null }) {
  const statusOf = error => (error instanceof ProviderError
    ? { status: error.code === "PROVIDER_NOT_FOUND" ? 404 : 400, code: error.code, message: error.message }
    : { status: 502, code: "PROVIDER_ERROR", message: error?.message || "上游请求失败。" });

  return async function handleProviderRoutes(req, res, { pathname, method }) {
    if (hydrate) await hydrate();
    if (pathname === "/api/providers" && method === "GET") {
      return json(res, 200, { ok: true, providers: store.list(), activeId: store.state.activeId });
    }
    if (pathname === "/api/providers" && method === "POST") {
      const body = await readBody(req, 16384);
      try {
        return json(res, 200, { ok: true, provider: await store.create(body || {}) });
      } catch (error) {
        const mapped = statusOf(error);
        return fail(res, mapped.status, mapped.code, mapped.message);
      }
    }
    if (pathname === "/api/providers/active" && method === "PUT") {
      const body = await readBody(req, 4096);
      try {
        const provider = await store.setActive(String(body?.id || ""));
        return json(res, 200, { ok: true, activeId: store.state.activeId, provider });
      } catch (error) {
        const mapped = statusOf(error);
        return fail(res, mapped.status, mapped.code, mapped.message);
      }
    }
    const match = /^\/api\/providers\/([0-9a-f-]{36})(\/models|\/test)?$/.exec(pathname);
    if (match) {
      const id = match[1];
      const action = match[2];
      const provider = store.get(id);
      if (!provider) return fail(res, 404, "PROVIDER_NOT_FOUND", "提供商不存在。");

      if (!action && (method === "PATCH" || method === "PUT")) {
        const body = await readBody(req, 16384);
        try {
          const updated = await store.update(id, body || {});
          return json(res, 200, { ok: true, provider: updated });
        } catch (error) {
          const mapped = statusOf(error);
          return fail(res, mapped.status, mapped.code, mapped.message);
        }
      }
      if (!action && method === "DELETE") {
        await store.remove(id);
        return json(res, 200, { ok: true, removed: id, activeId: store.state.activeId });
      }
      if (action === "/models" && method === "POST") {
        try {
          const models = await fetchProviderModels(provider);
          const saved = await store.setModels(id, models);
          return json(res, 200, { ok: true, models, provider: saved });
        } catch (error) {
          const mapped = statusOf(error);
          return fail(res, mapped.status, mapped.code, mapped.message);
        }
      }
      if (action === "/test" && method === "POST") {
        try {
          const models = await fetchProviderModels(provider);
          return json(res, 200, { ok: true, models: models.slice(0, 20), count: models.length });
        } catch (error) {
          const mapped = statusOf(error);
          return fail(res, mapped.status, mapped.code, mapped.message);
        }
      }
    }
    return false;
  };
}