import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { gitlabRequest, loadGitlabConfig, maskToken, saveGitlabConfig, encodeProject, GitlabError } from "../lib/gitlab/client.mjs";
import { callGitlabTool } from "../lib/gitlab/mcp.mjs";

const tempState = () => mkdtemp(path.join(tmpdir(), "gitlab-test-"));

const jsonResponse = (payload, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  text: async () => JSON.stringify(payload),
});

test("gitlab: 未配置令牌时返回 GITLAB_NOT_CONFIGURED 而不是网络错误", async () => {
  const stateDir = await tempState();
  const config = await loadGitlabConfig({ stateDir, env: {} });
  assert.equal(config.configured, false);
  assert.equal(config.baseUrl, "https://git.tsinghua.edu.cn");
  await assert.rejects(() => gitlabRequest("user", { config }), error => error.code === "GITLAB_NOT_CONFIGURED");
});

test("gitlab: 保存配置后不回显明文令牌，且地址非法会被拒绝", async () => {
  const stateDir = await tempState();
  const saved = await saveGitlabConfig({ baseUrl: "https://git.tsinghua.edu.cn/", token: "abcd1234efgh" }, { stateDir });
  assert.equal(saved.baseUrl, "https://git.tsinghua.edu.cn");
  assert.equal(saved.configured, true);
  const config = await loadGitlabConfig({ stateDir, env: {} });
  assert.equal(config.token, "abcd1234efgh");
  assert.equal(config.source, "file");
  assert.equal(maskToken(config.token), "abcd****efgh");
  const raw = await readFile(path.join(stateDir, "gitlab.json"), "utf8");
  assert.ok(raw.includes("abcd1234efgh"), "令牌落盘在状态目录");
  await assert.rejects(() => saveGitlabConfig({ baseUrl: "ftp://x", token: "t" }, { stateDir }), error => error.code === "INVALID_BASE_URL");
});

test("gitlab: 环境变量兜底，且文件优先", async () => {
  const stateDir = await tempState();
  const fromEnv = await loadGitlabConfig({ stateDir, env: { GITLAB_TOKEN: "env-token", GITLAB_BASE_URL: "https://gitlab.example" } });
  assert.equal(fromEnv.token, "env-token");
  assert.equal(fromEnv.source, "env");
  await saveGitlabConfig({ token: "file-token" }, { stateDir });
  const merged = await loadGitlabConfig({ stateDir, env: { GITLAB_TOKEN: "env-token" } });
  assert.equal(merged.token, "file-token", "文件优先");
  assert.equal(merged.source, "file");
});

test("gitlab: HTTP 状态映射到错误码，非 JSON 也不冒充成功", async () => {
  const config = { baseUrl: "https://git.tsinghua.edu.cn", token: "t", configured: true };
  const cases = [
    [401, "GITLAB_UNAUTHORIZED"],
    [403, "GITLAB_FORBIDDEN"],
    [404, "GITLAB_NOT_FOUND"],
    [429, "GITLAB_RATE_LIMITED"],
    [500, "GITLAB_REQUEST_FAILED"],
  ];
  for (const [status, code] of cases) {
    await assert.rejects(
      () => gitlabRequest("user", { config, fetchImpl: async () => jsonResponse({ message: "x" }, status) }),
      error => error.code === code,
    );
  }
  await assert.rejects(
    () => gitlabRequest("user", { config, fetchImpl: async () => ({ ok: true, status: 200, text: async () => "<html>" }) }),
    error => error.code === "GITLAB_INVALID_RESPONSE",
  );
  await assert.rejects(
    () => gitlabRequest("user", { config, fetchImpl: async () => { throw new Error("ECONNREFUSED"); } }),
    error => error.code === "GITLAB_UNREACHABLE",
  );
});

test("gitlab: 请求会带上 PRIVATE-TOKEN 与查询参数", async () => {
  const config = { baseUrl: "https://git.tsinghua.edu.cn", token: "secret", configured: true };
  let captured = null;
  const payload = await gitlabRequest("projects", {
    config,
    query: { membership: true, page: 2, search: "" },
    fetchImpl: async (url, options) => {
      captured = { url: url.toString(), headers: options.headers };
      return jsonResponse([{ id: 1 }]);
    },
  });
  assert.equal(payload[0].id, 1);
  assert.equal(captured.headers["PRIVATE-TOKEN"], "secret");
  assert.match(captured.url, /membership=true/);
  assert.match(captured.url, /page=2/);
  assert.ok(!captured.url.includes("search="), "空查询参数不发送");
});

test("gitlab: 工具层归一项目/议题/MR/流水线字段", async () => {
  const config = { baseUrl: "https://git.tsinghua.edu.cn", token: "t", configured: true };
  const routes = {
    "projects?membership=true&simple=true&page=1&per_page=20": [
      { id: 52412, name: "gtep-cli", path_with_namespace: "zhouc24/gtep-cli", visibility: "private", web_url: "https://git.tsinghua.edu.cn/zhouc24/gtep-cli", last_activity_at: "2026-11-20T00:00:00Z" },
    ],
    "projects/zhouc24%2Fgtep-cli/issues?state=opened&page=1&per_page=20": [
      { iid: 3, title: "修复", state: "opened", author: { username: "zhouc24" }, labels: ["bug"], web_url: "u", created_at: "c" },
    ],
    "projects/1/merge_requests?state=opened&page=1&per_page=20": [
      { iid: 7, title: "MR", state: "opened", source_branch: "feat", target_branch: "main", web_url: "u" },
    ],
    "projects/1/pipelines?per_page=10": [{ id: 9, status: "success", ref: "main", sha: "abcdef1234", web_url: "u" }],
  };
  const fetchImpl = async url => {
    const relative = url.toString().replace("https://git.tsinghua.edu.cn/api/v4/", "");
    return jsonResponse(routes[relative] ?? []);
  };
  const projects = await callGitlabTool("gitlab_projects", {}, { config, fetchImpl });
  assert.equal(projects.projects[0].path, "zhouc24/gtep-cli");
  const issues = await callGitlabTool("gitlab_issues", { project: "zhouc24/gtep-cli" }, { config, fetchImpl });
  assert.equal(issues.issues[0].iid, 3);
  assert.deepEqual(issues.issues[0].labels, ["bug"]);
  const mrs = await callGitlabTool("gitlab_merge_requests", { project: 1 }, { config, fetchImpl });
  assert.equal(mrs.mergeRequests[0].sourceBranch, "feat");
  const pipelines = await callGitlabTool("gitlab_pipelines", { project: 1 }, { config, fetchImpl });
  assert.equal(pipelines.pipelines[0].sha, "abcdef12");
  await assert.rejects(() => callGitlabTool("gitlab_bogus", {}, { config, fetchImpl }), error => error.code === "UNKNOWN_TOOL");
  await assert.rejects(() => callGitlabTool("gitlab_issues", {}, { config, fetchImpl }), error => error.code === "ARGUMENT_REQUIRED");
  assert.equal(encodeProject(52412), "52412");
  assert.equal(encodeProject("zhouc24/gtep-cli"), "zhouc24%2Fgtep-cli");
  assert.ok(new GitlabError("X", "y") instanceof Error);
});