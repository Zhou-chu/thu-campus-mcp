import { test } from "node:test";
import assert from "node:assert/strict";
import { safeLink, fetchArtifact, workspaceJob, createJobPoller, renderMarkdown, JOB_LABELS } from "../webui/workspace.js";

const origin = "http://localhost:8971";
const session = "12345678-1234-1234-1234-123456789012";
const file = `/api/workspaces/${session}/files?path=report.pdf`;
const running = (jobId = "job-1") => ({ jobId, state: "running", runtime: "python", statusUrl: `/api/workspaces/${session}/jobs/${jobId}`, stdout: "first", stderr: "" });
const flush = () => new Promise(resolve => setImmediate(resolve));

class Node {
  constructor(tag, text = "") { this.tag = tag; this.children = []; this.textContent = text; this.events = {}; }
  append(...items) { this.children.push(...items); }
  addEventListener(event, fn) { this.events[event] = fn; }
}
const document = { createElement: tag => new Node(tag), createTextNode: text => new Node("#text", text), createDocumentFragment: () => new Node("#fragment") };
const descendants = tree => [tree, ...tree.children.flatMap(descendants)];
const textOf = tree => tree.textContent + tree.children.map(textOf).join("");

test("安全链接只放行HTTP(S)外链与严格workspace产物路径", () => {
  assert.deepEqual(safeLink(file, origin), { kind: "artifact", href: file, filename: "report.pdf" });
  assert.equal(safeLink(origin + file, origin).kind, "artifact");
  assert.equal(safeLink(file.replace("report.pdf", "folder%2F%E6%8A%A5%E5%91%8A.pdf"), origin).filename, "报告.pdf");
  assert.equal(safeLink(file.replace("report.pdf", "%2F"), origin).filename, "artifact");
  assert.equal(safeLink("https://example.org/reference?q=1", origin).kind, "external");
  assert.equal(safeLink("http://example.org", origin).kind, "external");
  for (const value of [null, 1, "", "javascript:alert(1)", "data:text/html,bad", "file:///C:/secret", "mailto:x@y.org", "https://user:pass@example.org", "http://[broken", "https://evil.test/api/workspaces/a/files?path=x", "//evil.test/x", "/etc/passwd", "https:\\evil.test", "https://example.org/\n", file + "#x", file + "&token=secret", file + "&path=second", file.replace("path=report.pdf", "wrong=report.pdf"), file.replace("report.pdf", ""), file.replace("report.pdf", "%00"), file.replace(session, "not-a-session")]) assert.equal(safeLink(value, origin), null, String(value));
});

test("产物下载在请求头授权且以Blob返回，不向URL或重定向泄露令牌", async () => {
  let request;
  const result = await fetchArtifact(file, { origin, base: origin + "///", token: "fixture-device", fetchImpl: async (url, options) => { request = { url, options }; return new Response("%PDF-test", { headers: { "content-type": "application/pdf" } }); } });
  assert.equal(request.url, origin + file);
  assert.equal(request.options.headers.authorization, "Bearer fixture-device");
  assert.equal(request.options.redirect, "error");
  assert.equal(request.options.credentials, "omit");
  assert.equal(result.filename, "report.pdf");
  assert.equal(await result.blob.text(), "%PDF-test");
  await assert.rejects(fetchArtifact("javascript:alert(1)", { origin, token: "x" }), /地址不合法/);
  await assert.rejects(fetchArtifact(file, { origin }), /重新配对/);
  await assert.rejects(fetchArtifact(file, { origin, token: "x", fetchImpl: async () => Response.json({ error: { message: "文件不存在" } }, { status: 404 }) }), /文件不存在/);
  await assert.rejects(fetchArtifact(file, { origin, token: "x", fetchImpl: async () => new Response("unavailable", { status: 503 }) }), /HTTP 503/);
  await assert.rejects(fetchArtifact(file, { origin, token: "x", fetchImpl: async () => { throw new Error("network disconnected"); } }), /network disconnected/);
});

test("DOM Markdown包含标题列表代码表格和授权产物链接，不解析HTML", () => {
  let artifact;
  const markdown = `# 一级\r\n## 二级 **重点**\n### 三级\n#### 四级\n##### 五级\n###### 六级\n\n- 条目一\n+ 条目二\n3. 第三项\n4) 第四项\n普通段落与\`inline\`\n<script>danger()</script>\n[危险](javascript:alert(1))\n[外链](https://example.org/a(b))\n[下载](${file})\n| 名称 | 文件 |\n| --- | --- |\n| **报告** | [产物](${file}) |\n\n\`\`\`html\n<img src=x onerror=alert(1)>\n\`\`\`\n尾段`;
  const tree = renderMarkdown(markdown, { document, origin, onArtifact: (link, anchor) => { artifact = { link, anchor }; } });
  const all = descendants(tree), tags = all.map(node => node.tag);
  for (const tag of ["h1", "h2", "h3", "h4", "h5", "h6", "ul", "ol", "li", "code", "strong", "pre", "table", "thead", "tbody", "th", "td", "p"]) assert.ok(tags.includes(tag), tag);
  assert.equal(all.find(node => node.tag === "ol").start, 3);
  assert.equal(tags.includes("script"), false);
  assert.equal(tags.includes("img"), false);
  assert.match(textOf(tree), /<script>danger\(\)<\/script>/);
  assert.match(textOf(tree), /\[危险\]\(javascript:alert\(1\)\)/);
  const links = all.filter(node => node.tag === "a");
  assert.equal(links.length, 3);
  assert.equal(links[0].target, "_blank");
  assert.equal(links[0].rel, "noopener noreferrer");
  let prevented = false;
  links[1].events.click({ preventDefault() { prevented = true; } });
  assert.ok(prevented);
  assert.equal(artifact.link.href, file);
  assert.equal(artifact.anchor, links[1]);
  assert.equal(descendants(renderMarkdown("```\nunclosed", { document, origin })).find(n => n.tag === "pre").textContent, "unclosed");
  assert.equal(renderMarkdown(null, { document, origin }).children.length, 0);
  assert.equal(textOf(renderMarkdown("| 普通文本 |", { document, origin })), "| 普通文本 |");
});

test("作业回执校验状态白名单、会话路径及jobId，兼容历史data封装", () => {
  for (const state of Object.keys(JOB_LABELS)) assert.equal(workspaceJob({ ...running(), state }).state, state);
  assert.equal(workspaceJob({ ok: true, data: running() }).sessionId, session);
  assert.equal(workspaceJob({ job: running() }).jobId, "job-1");
  for (const value of [null, {}, { ...running(), state: "complete" }, { ...running(), state: "toString" }, { ...running(), statusUrl: 1 }, { ...running(), statusUrl: "https://evil.test/jobs/job-1" }, { ...running(), statusUrl: running().statusUrl + "?token=x" }, { ...running(), jobId: "mismatch" }]) assert.equal(workspaceJob(value), null);
});

function polling(read) {
  let active = true, jobs = [running()], serial = 0;
  const timers = new Map(), updates = [], errors = [];
  const poller = createJobPoller({
    isActive: () => active, getJobs: () => jobs,
    readJob: read,
    onUpdate(job) { updates.push(job); jobs = jobs.map(old => old.jobId === job.jobId ? job : old); },
    onError(job, error) { errors.push(error.message); job.requestError = error.message; },
    setTimer(fn) { const id = ++serial; timers.set(id, fn); return id; },
    clearTimer(id) { timers.delete(id); },
  });
  return { poller, timers, updates, errors, setActive(value) { active = value; }, setJobs(value) { jobs = value; }, async tick() { const [id, fn] = timers.entries().next().value; timers.delete(id); fn(); await flush(); } };
}

test("作业轮询仅pending且可见时运行，终态停止，重复sync不并发", async () => {
  let release, calls = 0;
  const state = polling(async () => { calls++; return new Promise(resolve => { release = resolve; }); });
  state.poller.sync(); state.poller.sync();
  assert.equal(state.timers.size, 1);
  await state.tick();
  state.poller.sync();
  assert.equal(state.timers.size, 0);
  assert.equal(calls, 1);
  release({ ok: true, job: { ...running(), state: "succeeded", stdout: "finished" } }); await flush();
  assert.equal(state.updates[0].state, "succeeded");
  assert.equal(state.timers.size, 0);
  state.setJobs([running()]); state.setActive(false); state.poller.sync();
  assert.equal(state.timers.size, 0);
  state.setActive(true); state.poller.sync(); assert.equal(state.timers.size, 1);
  state.setActive(false); state.poller.sync(); assert.equal(state.timers.size, 0);
  state.setActive(true); state.setJobs([{ ...running(), stopping: true }, { ...running("job-2"), requestError: "failed" }]); state.poller.sync();
  assert.equal(state.timers.size, 0);
  state.poller.stop();
});

test("轮询错误保留running且暂停，恢复后继续；无效API响应不能假成功", async () => {
  let response = { ok: true, job: { ...running(), stdout: "more logs" } };
  const state = polling(async () => response);
  state.poller.sync(); await state.tick();
  assert.equal(state.updates[0].stdout, "more logs"); assert.equal(state.timers.size, 1);
  response = { ok: true, job: running("another-job") };
  await state.tick(); assert.match(state.errors[0], /状态响应无效/); assert.equal(state.timers.size, 0);
  state.setJobs([running()]); response = { ok: false }; state.poller.sync(); await state.tick();
  assert.equal(state.errors.length, 2);
  state.poller.stop();
  const failed = polling(async () => { throw new Error("HTTP 503"); });
  failed.poller.sync(); await failed.tick(); assert.deepEqual(failed.errors, ["HTTP 503"]); failed.poller.stop();
});

test("切页中止在途轮询，不接受旧帧，取消后可恢复且stop清掉计时器", async () => {
  let release, signal;
  const state = polling(async (_job, current) => { signal = current; return new Promise(resolve => { release = resolve; }); });
  state.poller.sync(); await state.tick();
  state.setActive(false); state.poller.sync(); assert.equal(signal.aborted, true);
  release({ ok: true, job: { ...running(), state: "succeeded" } }); await flush();
  assert.equal(state.updates.length, 0); assert.equal(state.errors.length, 0);
  state.setActive(true); state.poller.sync(); assert.equal(state.timers.size, 1);
  state.poller.stop(); assert.equal(state.timers.size, 0);
  state.poller.sync(); await state.tick(); state.poller.stop();
  assert.equal(signal.aborted, true); release({ ok: true, job: running() }); await flush();
  assert.equal(state.timers.size, 0, "显式stop后旧请求结束不能复活轮询");
  state.poller.sync(); assert.equal(state.timers.size, 1); state.poller.stop();
});
