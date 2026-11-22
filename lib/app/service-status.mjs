import { createServiceProbe, serviceEvidence } from "./states.mjs";
import { loadGitlabConfig, gitlabRequest } from "../gitlab/client.mjs";

/** GitLab 是唯一以自管站点令牌接入的服务；其余服务走 MCP 工具探测。 */
export async function probeGitlabSession({
  stateDir,
  now = () => Date.now(),
  loadConfig = loadGitlabConfig,
  request = gitlabRequest,
} = {}) {
  const source = "protected-api:gitlab-user";
  let state = "unknown";
  let code = "PROBE_FAILED";
  try {
    const settings = await loadConfig({ stateDir });
    if (!settings.configured) return { state: "login-required", verified: false, code: "NOT_CONFIGURED", source, checkedAt: new Date(now()).toISOString() };
    const user = await request("/user", { config: settings, timeoutMs: 4000 });
    if (Number.isSafeInteger(user?.id) && user.id > 0) {
      state = "ready";
      code = "VERIFIED";
    }
  } catch (error) {
    if (error?.status === 401) {
      state = "expired";
      code = "AUTH_EXPIRED";
    }
  }
  return { state, verified: state === "ready", code, source, checkedAt: new Date(now()).toISOString() };
}

/** 七个服务状态的唯一汇总点：MCP 探测 + 座位/体育/GitLab 受保护接口 + 会话信号。 */
export function composeServiceStates({ base, seat, sports, gitlab, signals = null }) {
  const merged = { ...base, seat, sports, gitlab };
  return signals ? signals.apply(merged) : merged;
}

export function createServiceStatus({
  host,
  stateDir,
  signals,
  probe = createServiceProbe(host),
  seatStatus = () => import("./seat-read.mjs").then(m => m.probeSeatSession()),
  sportsStatus = () => import("./sports.mjs").then(m => m.sportsSessionStatus()),
  gitlabStatus = options => probeGitlabSession({ stateDir, ...options }),
  now = () => Date.now(),
} = {}) {
  return async function serviceStates() {
    const [base, seat, sports, gitlab] = await Promise.all([probe(), seatStatus(), sportsStatus(), gitlabStatus({ now })]);
    return composeServiceStates({ base, seat, sports, gitlab, signals });
  };
}