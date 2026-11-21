import { encodeProject, gitlabRequest, loadGitlabConfig, GitlabError } from "./client.mjs";

const text = properties => ({ type: "object", properties, additionalProperties: false });

export const gitlabTools = [
  {
    name: "gitlab_status",
    description: "检查清华 GitLab 连通性并返回当前账号（不返回令牌）。只读。",
    inputSchema: text({}),
    annotations: { readOnlyHint: true },
  },
  {
    name: "gitlab_projects",
    description: "列出我参与的 GitLab 项目。可传 search 过滤、page 翻页。只读。",
    inputSchema: text({ search: { type: "string" }, page: { type: "number" }, perPage: { type: "number" } }),
    annotations: { readOnlyHint: true },
  },
  {
    name: "gitlab_issues",
    description: "列出某项目的议题。project 传 id 或 path（如 zhouc24/gtep-cli），可传 state（opened/closed/all）与 search。只读。",
    inputSchema: text({
      project: { type: "string" },
      state: { type: "string", enum: ["opened", "closed", "all"] },
      search: { type: "string" },
      page: { type: "number" },
    }),
    annotations: { readOnlyHint: true },
  },
  {
    name: "gitlab_merge_requests",
    description: "列出某项目的合并请求。可传 state（opened/merged/closed/all）。只读。",
    inputSchema: text({
      project: { type: "string" },
      state: { type: "string", enum: ["opened", "merged", "closed", "all"] },
      page: { type: "number" },
    }),
    annotations: { readOnlyHint: true },
  },
  {
    name: "gitlab_pipelines",
    description: "列出某项目最近的流水线状态。只读。",
    inputSchema: text({ project: { type: "string" }, perPage: { type: "number" } }),
    annotations: { readOnlyHint: true },
  },
];

const pickProject = items =>
  items.map(item => ({
    id: item.id,
    path: item.path_with_namespace,
    name: item.name,
    visibility: item.visibility,
    webUrl: item.web_url,
    lastActivityAt: item.last_activity_at,
  }));

export async function callGitlabTool(name, args = {}, options = {}) {
  const config = options.config || (await loadGitlabConfig(options));
  try {
    if (name === "gitlab_status") {
      const [version, user] = await Promise.all([
        gitlabRequest("version", { config, fetchImpl: options.fetchImpl }),
        gitlabRequest("user", { config, fetchImpl: options.fetchImpl }),
      ]);
      return {
        ok: true,
        baseUrl: config.baseUrl,
        version: version?.version || "unknown",
        user: { id: user?.id, username: user?.username, name: user?.name, state: user?.state },
      };
    }
    if (name === "gitlab_projects") {
      const items = await gitlabRequest("projects", {
        config,
        fetchImpl: options.fetchImpl,
        query: { membership: true, simple: true, search: args.search, page: args.page || 1, per_page: Math.min(Number(args.perPage) || 20, 100) },
      });
      return { ok: true, projects: pickProject(Array.isArray(items) ? items : []) };
    }
    if (name === "gitlab_issues") {
      const items = await gitlabRequest(`projects/${encodeProject(args.project)}/issues`, {
        config,
        fetchImpl: options.fetchImpl,
        query: { state: args.state || "opened", search: args.search, page: args.page || 1, per_page: 20 },
      });
      return {
        ok: true,
        issues: (Array.isArray(items) ? items : []).map(issue => ({
          iid: issue.iid,
          title: issue.title,
          state: issue.state,
          author: issue.author?.username,
          labels: issue.labels,
          webUrl: issue.web_url,
          createdAt: issue.created_at,
        })),
      };
    }
    if (name === "gitlab_merge_requests") {
      const items = await gitlabRequest(`projects/${encodeProject(args.project)}/merge_requests`, {
        config,
        fetchImpl: options.fetchImpl,
        query: { state: args.state || "opened", page: args.page || 1, per_page: 20 },
      });
      return {
        ok: true,
        mergeRequests: (Array.isArray(items) ? items : []).map(mr => ({
          iid: mr.iid,
          title: mr.title,
          state: mr.state,
          sourceBranch: mr.source_branch,
          targetBranch: mr.target_branch,
          webUrl: mr.web_url,
        })),
      };
    }
    if (name === "gitlab_pipelines") {
      const items = await gitlabRequest(`projects/${encodeProject(args.project)}/pipelines`, {
        config,
        fetchImpl: options.fetchImpl,
        query: { per_page: Math.min(Number(args.perPage) || 10, 50) },
      });
      return {
        ok: true,
        pipelines: (Array.isArray(items) ? items : []).map(item => ({
          id: item.id,
          status: item.status,
          ref: item.ref,
          sha: item.sha?.slice(0, 8),
          webUrl: item.web_url,
        })),
      };
    }
    throw new GitlabError("UNKNOWN_TOOL", `未知 GitLab 工具：${name}`);
  } catch (error) {
    if (error instanceof GitlabError) throw error;
    throw new GitlabError("GITLAB_FAILED", error?.message || "GitLab 调用失败。");
  }
}