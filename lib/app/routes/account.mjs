/**
 * 账号与 GitLab 凭据路由。
 * 由 server.mjs 传入依赖，模块本身不持有全局状态，便于单独测试与后续继续拆分。
 */
import { clearAccount, loadAccount, maskAccount, saveAccount } from "../account.mjs";
import { GitlabError, gitlabRequest, loadGitlabConfig, maskToken, saveGitlabConfig } from "../../gitlab/client.mjs";
import { loginFailure, loginStatusOf, sendLogin } from "../login-contract.mjs";
import { requestCanCarrySecrets } from "../transport.mjs";
import { fail, json } from "./respond.mjs";
import { currentUserId } from "../request-context.mjs";

export function createAccountRoutes({ config, loginAll, readBody, accountSync = null, gitlab = null, resetSessions = null, onIdentityChanged = null }) {
  const gitlabOptions = () => ({ stateDir: config.stateDir, ...(gitlab ? { secure: gitlab } : {}) });
  const userIdOf = () => { try { return currentUserId(); } catch { return null; } };
  return async function handleAccountRoutes(req, res, { pathname, method }) {
    if (pathname === "/api/account") {
      if (method === "GET") {
        const userId = userIdOf();
        const stored = accountSync && userId ? await accountSync.loadForUser(userId) : null;
        // 登录用户的账号以库为准；本机 DPAPI 只服务未登录的设备令牌模式与各服务包。
        const account = userId ? stored : await loadAccount(config.stateDir);
        return json(res, 200, {
          ok: true,
          configured: Boolean(account),
          masked: account ? maskAccount(account) : "",
          source: account?.source || "none",
        });
      }
      if (method === "PUT") {
        if (!requestCanCarrySecrets(req, config))
          return fail(res, 403, "ACCOUNT_HTTPS_REQUIRED", "请通过HTTPS或本机回环地址配置清华账号，不要在远程HTTP页面输入密码。");
        const body = await readBody(req, 8192);
        try {
          const saved = await saveAccount({ username: body?.username, password: body?.password }, config.stateDir);
          if (accountSync) await accountSync.saveForUser(userIdOf(), saved);
          // 身份变了才回收旧会话：同一组凭据重复保存不应打断正在用的服务。
          if (saved.changed) {
            await resetSessions?.().catch(() => {});
            onIdentityChanged?.({ reason: "account-changed", generation: saved.generation });
          }
          return json(res, 200, { ok: true, configured: true, masked: maskAccount(saved), source: "account", generation: saved.generation, changed: !!saved.changed });
        } catch (error) {
          return fail(res, 400, error?.code || "INVALID_ARGUMENTS", error?.message || "账号保存失败。");
        }
      }
      if (method === "DELETE") {
        const cleared = await clearAccount(config.stateDir);
        if (accountSync) await accountSync.clearForUser(userIdOf());
        await resetSessions?.().catch(() => {});
        onIdentityChanged?.({ reason: "account-cleared", generation: cleared?.generation });
        return json(res, 200, { ok: true, configured: false, masked: "", source: "none", generation: cleared?.generation });
      }
    }
    if (pathname === "/api/account/login" && method === "POST") {
      const body = await readBody(req, 4096).catch(() => null);
      // skip：已经核验通过的服务不重复登录，避免又开一次窗口。
      const skip = Array.isArray(body?.skip) ? body.skip.filter(name => typeof name === "string").slice(0, 8) : [];
      const services = Array.isArray(body?.services) ? body.services.filter(name => typeof name === "string").slice(0, 8) : [];
      try {
        const result = await loginAll({ skip, services });
        const status = result.ok ? 200 : loginStatusOf("LOGIN_FAILED");
        return json(res, status, {
          ok: result.ok,
          ...result,
          ...(result.ok ? {} : { error: { code: "LOGIN_FAILED", message: "没有服务成功登录，请查看各项结果。", service: "all" } }),
        });
      } catch (error) {
        if (error?.code !== "ACCOUNT_NOT_CONFIGURED") throw error;
        return sendLogin(res, json, loginFailure("all", error));
      }
    }
    if (pathname === "/api/gitlab/config") {
      const options = gitlabOptions();
      if (method === "GET") {
        const current = await loadGitlabConfig(options);
        return json(res, 200, { ok: true, baseUrl: current.baseUrl, configured: current.configured, masked: maskToken(current.token), source: current.source });
      }
      if (method === "PUT") {
        const body = await readBody(req, 8192);
        try {
          const saved = await saveGitlabConfig({ baseUrl: body?.baseUrl, token: body?.token }, options);
          const current = await loadGitlabConfig(options);
          return json(res, 200, { ok: true, baseUrl: saved.baseUrl, configured: saved.configured, masked: maskToken(current.token) });
        } catch (error) {
          if (error instanceof GitlabError) return fail(res, 400, error.code, error.message);
          throw error;
        }
      }
    }
    if (pathname === "/api/gitlab/test" && method === "POST") {
      const current = await loadGitlabConfig(gitlabOptions());
      try {
        const [user, version] = await Promise.all([
          gitlabRequest("user", { config: current }),
          gitlabRequest("version", { config: current }),
        ]);
        return json(res, 200, { ok: true, version: version?.version || "unknown", user: { username: user?.username, name: user?.name } });
      } catch (error) {
        if (error instanceof GitlabError) return json(res, error.code === "GITLAB_NOT_CONFIGURED" ? 409 : 502, { ok: false, error: { code: error.code, message: error.message } });
        throw error;
      }
    }
    return false;
  };
}