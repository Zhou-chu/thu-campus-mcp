/**
 * 同步接口（#96）：设备用 since 增量拉取本账号的变更。
 *
 * 目前是只读变更流；推送与冲突合并随后续批次接入。没有数据库时明确返回
 * SYNC_UNAVAILABLE，而不是假装“没有变更”。
 */
export function createSyncRoutes({ store }) {
  return async function handleSyncRoutes(req, res, { pathname, method, url, json, fail }) {
    if (pathname !== "/api/sync/changes") return false;
    if (method !== "GET") return fail(res, 405, "METHOD_NOT_ALLOWED", "不支持的请求方法。");
    if (!store) return fail(res, 503, "SYNC_UNAVAILABLE", "当前实例未配置数据库，无法同步。");
    let user = null;
    try {
      user = await store.repos.users.first();
    } catch {
      user = null;
    }
    if (!user) return json(res, 200, { ok: true, latest: 0, changes: [] });
    const since = Math.max(0, Number(url.searchParams.get("since") || 0) || 0);
    const limit = Math.min(Math.max(Number(url.searchParams.get("limit") || 200) || 200, 1), 1000);
    const changes = await store.repos.changes.list(user.id, { since, limit });
    const latest = await store.repos.changes.latest(user.id);
    return json(res, 200, { ok: true, latest, changes });
  };
}