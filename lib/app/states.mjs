/**
 * 服务登录态归一化与探测。
 * `/api/meta`、`/api/auth/status` 与保活自检共用同一套判定，
 * 避免"配置存在"被误报成"会话有效"。
 */
export function stateOf(payload) {
  if (!payload || typeof payload !== "object") return "unknown";
  const auth =
    payload.authentication && typeof payload.authentication === "object"
      ? payload.authentication
      : null;
  const validity = payload.sessionValidity;
  if (payload.expired === true || payload.expiresIn === 0) return "expired";
  if (validity === "expired" || validity === "invalid") return "expired";
  if (payload.disabled === true) return "login-required";
  if (auth && auth.configured === false) return "login-required";
  if (payload.authenticated === false || payload.loggedIn === false)
    return "login-required";
  if (!auth && payload.configured === false && payload.hasToken !== true)
    return "login-required";
  if (validity === "valid" || validity === "verified") return "ready";
  if (payload.configured === true) return "ready";
  if (auth && auth.configured === true) return "ready";
  if (payload.authenticated === true || payload.loggedIn === true) return "ready";
  if (payload.account || payload.token != null) return "ready";
  return "unknown";
}
const PROBES = [
  ["learnx", "learn_status"],
  ["cloud", "cloud_status"],
  ["hetang", "rain_status"],
  ["madmodel", "madmodel_status"],
];
/** 逐个调用只读状态工具，返回 `{ 服务名: { state, code? } }`。 */
export function createServiceProbe(host) {
  return async function probe() {
    const entries = await Promise.all(
      PROBES.map(async ([service, tool]) => {
        const result = await host.call(tool, {});
        if (!result.ok) {
          const loginRequired = ["AUTH_REQUIRED", "AUTH_EXPIRED"].includes(
            result.error?.code,
          );
          return [
            service,
            {
              state: loginRequired ? "login-required" : "unknown",
              code: result.error?.code,
            },
          ];
        }
        return [service, { state: stateOf(result.data) }];
      }),
    );
    return Object.fromEntries(entries);
  };
}