/**
 * 身份变更后的会话回收：账号被改/被清除时，旧身份留下的校园站点会话必须一起作废，
 * 否则界面会拿着旧 Cookie 显示“已登录”，甚至用旧身份继续操作。
 *
 * 只清理校园站点自己的 Cookie / localStorage 与网络学堂授权文件，不动其它来源。
 */
import { readSnapshot, saveSnapshot } from "@thu-campus/browser";

const CAMPUS_HOSTS = new Set([
  "seat.lib.tsinghua.edu.cn",
  "www.sports.tsinghua.edu.cn",
  "learn.tsinghua.edu.cn",
  "id.tsinghua.edu.cn",
  "pro.yuketang.cn",
  "cloud.tsinghua.edu.cn",
]);

const hostOf = value => {
  try { return new URL(String(value)).hostname; } catch { return ""; }
};

async function clearLearnxAuth() {
  const [{ AuthStore }, { loadConfig }] = await Promise.all([
    import("../../packages/learnx/dist/auth.js"),
    import("../../packages/learnx/dist/config.js"),
  ]);
  await new AuthStore(loadConfig().stateDir).clear();
}

/**
 * @returns {Promise<{cleared: boolean, cookies: number, origins: number}>}
 * 失败不抛给调用方：会话回收失败不应让“保存账号”整体失败，但调用方要能记录。
 */
export async function resetCampusSessions({ snapshot = readSnapshot, save = saveSnapshot, clearLearnx = clearLearnxAuth } = {}) {
  let cookies = 0;
  let origins = 0;
  const state = await snapshot().catch(() => null);
  if (state) {
    const keptCookies = (state.cookies ?? []).filter(cookie => {
      const drop = CAMPUS_HOSTS.has(String(cookie?.domain || "").replace(/^\./, ""));
      if (drop) cookies += 1;
      return !drop;
    });
    const keptOrigins = (state.origins ?? []).filter(origin => {
      const drop = CAMPUS_HOSTS.has(hostOf(origin?.origin));
      if (drop) origins += 1;
      return !drop;
    });
    if (cookies || origins) await save({}, { ...state, cookies: keptCookies, origins: keptOrigins });
  }
  await clearLearnx().catch(() => {});
  return { cleared: true, cookies, origins };
}