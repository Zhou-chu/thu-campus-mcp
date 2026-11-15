import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createAppServer } from "../lib/app/server.mjs";
import { SessionStore } from "../lib/app/sessions.mjs";
import { DeviceStore } from "../lib/app/devices.mjs";
import { PairingCodes } from "../lib/app/pairing.mjs";
import { AssignmentsService, normalizeItem, sortUngraded, splitPending, toMillis, graded } from "../lib/app/assignments.mjs";
import { canonicalJson, createConfirmations } from "../lib/app/confirmations.mjs";
import { applyOrder, clampWidth, filterArchived, moveId, readJson, remaining, toggleArchived, writeJson } from "../webui/ddl-model.js";

const homework = (id, extra = {}) => ({ id, courseId: "c1", course: "电力电子", title: "作业" + id, submitted: false, deadline: "2099-01-01 00:00:00", ...extra });

test("assignments: deadline formats and unknown values never invent a date", () => {
  assert.equal(toMillis(1893456000000), 1893456000000);
  assert.equal(toMillis(1893456000), 1893456000000);
  assert.equal(toMillis("2099-01-01 00:00:00"), Date.parse("2099-01-01T00:00:00+08:00"));
  assert.equal(toMillis("2026-11-20T12:00:00Z"), Date.parse("2026-11-20T12:00:00Z"));
  assert.equal(toMillis(""), null);
  assert.equal(toMillis("不是日期"), null);
  assert.equal(toMillis(null), null);
  assert.equal(toMillis(0), null);
});

test("assignments: unsubmitted sorts near to far, unknown stays with open items, expired sinks to bottom", () => {
  const now = Date.parse("2026-11-15T12:00:00Z");
  const items = [
    { id: "late", title: "很久前过期", deadlineMs: now - 864e5 * 10 },
    { id: "far", title: "很远", deadlineMs: now + 864e5 * 9 },
    { id: "near", title: "很近", deadlineMs: now + 3600e3 },
    { id: "recent", title: "刚过期", deadlineMs: now - 3600e3 },
    { id: "unknown", title: "无期限", deadlineMs: null },
  ];
  assert.deepEqual(splitPending(items, now).map(item => item.id), ["near", "far", "unknown", "recent", "late"]);
});

test("assignments: ungraded orders by submit time and ignores graded or unsubmitted work", () => {
  const items = [
    normalizeItem(homework("old", { submitted: true, submitTime: "2026-11-01 10:00:00" })),
    normalizeItem(homework("new", { submitted: true, submitTime: "2026-11-10 10:00:00" })),
    normalizeItem(homework("graded", { submitted: true, submitTime: "2026-11-12 10:00:00", grade: 95 })),
    normalizeItem(homework("zero", { submitted: true, submitTime: "2026-11-09 10:00:00", grade: 0 })),
    normalizeItem(homework("open")),
  ];
  assert.equal(items[2].ungraded, false, "已有成绩的作业不算待批改");
  assert.equal(items[3].ungraded, false, "0 分是真实成绩，不是未批改");
  assert.equal(items[4].ungraded, false);
  assert.deepEqual(sortUngraded(items.filter(item => item.ungraded)).map(item => item.id), ["new", "old"]);
  assert.equal(normalizeItem({ id: "", courseId: "c" }), null);
});

test("assignments: saved manual order only reorders ids that still exist", () => {
  const items = [{ id: "a" }, { id: "b" }, { id: "c" }, { id: "d" }];
  assert.deepEqual(applyOrder(items, ["c", "a"]).map(item => item.id), ["c", "a", "b", "d"]);
  assert.deepEqual(applyOrder(items, []).map(item => item.id), ["a", "b", "c", "d"]);
  assert.deepEqual(applyOrder(items, ["gone", "b"]).map(item => item.id), ["b", "a", "c", "d"]);
  assert.deepEqual(moveId(["a", "b", "c"], 0, 2), ["b", "c", "a"]);
  assert.deepEqual(moveId(["a", "b", "c"], 2, 0), ["c", "a", "b"]);
  assert.deepEqual(moveId(["a", "b"], 0, 9), ["a", "b"]);
  assert.deepEqual(moveId(["a", "b"], 1, 1), ["a", "b"]);
});

test("sidebar model: archive toggles, archived hidden by default, width and countdown stay bounded", () => {
  const items = [{ id: "a" }, { id: "b" }];
  const archived = toggleArchived([], "a");
  assert.deepEqual(filterArchived(items, archived, false), { visible: [{ id: "b" }], hidden: 1 });
  assert.deepEqual(filterArchived(items, archived, true), { visible: [{ id: "b" }, { id: "a" }], hidden: 1 });
  assert.deepEqual(toggleArchived(archived, "a"), []);
  assert.equal(clampWidth(10), 320);
  assert.equal(clampWidth(9999), 720);
  assert.equal(clampWidth("abc"), 380);
  const now = Date.parse("2026-11-15T12:00:00Z");
  assert.equal(remaining(now + 3600e3 * 5, now).text, "剩 5 小时");
  assert.equal(remaining(now - 864e5 * 2, now).text, "已过期 2 天");
  assert.equal(remaining(Number.NaN, now).text, "期限未知");
  assert.equal(remaining(now + 1000, now).overdue, false);
});

test("assignments service: a throwing tool host degrades to unavailable and concurrent reads share one fetch", async () => {
  const throwing = new AssignmentsService({ call: async () => { throw new Error("worker crashed"); } });
  const down = await throwing.overview();
  assert.equal(down.state, "unavailable");
  assert.equal(down.error.code, "LEARNX_UNAVAILABLE");
  assert.equal((await throwing.detail("c1", "h1")).error.code, "LEARNX_UNAVAILABLE");
  assert.equal((await throwing.prepare({ courseId: "c1", homeworkId: "h1", content: "x" })).error.code, "LEARNX_UNAVAILABLE");
  assert.equal((await throwing.submit("11111111-1111-4111-8111-111111111111")).error.code, "LEARNX_UNAVAILABLE");

  let calls = 0;
  const service = new AssignmentsService({ call: async () => { calls++; await new Promise(resolve => setTimeout(resolve, 5)); return { ok: true, data: { items: [], errors: [] } }; } }, { cacheTtl: 0 });
  const [first, second] = await Promise.all([service.overview(), service.overview()]);
  assert.equal(calls, 1, "并发读取共用同一次请求");
  assert.equal(first.fetchedAt, second.fetchedAt);
  await service.overview({ refresh: true });
  assert.equal(calls, 2, "强制刷新跳过缓存");
});

test("assignments service: pagination stops on missing or empty pages and arguments stay explicit", async () => {
  const seen = [];
  const host = {
    call: async (name, args) => {
      seen.push(args);
      if (name === "learn_prepare_submission") return { ok: true, data: { id: "11111111-1111-4111-8111-111111111111" } };
      if (name === "learn_list_assignments") return { ok: true, data: { items: [{ ...homework("h1"), submitted: "1", grade: "" }], nextOffset: "not-a-number" } };
      return { ok: true, data: {} };
    },
  };
  const service = new AssignmentsService(host, { cacheTtl: 0 });
  const first = await service.overview();
  assert.equal(first.state, "ready");
  assert.equal(first.pages, 1, "非数字 nextOffset 视为结束");
  const empty = await new AssignmentsService({ call: async () => ({ ok: true, data: { items: [], nextOffset: 5 } }) }).overview();
  assert.equal(empty.active.length, 0);

  await service.overview();
  assert.equal(seen.filter(args => args && args.limit !== undefined).length >= 2, true, "缓存过期后重新读取");
  await service.prepare({ courseId: "c1", homeworkId: "h1" });
  assert.deepEqual(seen.at(-1), { courseId: "c1", homeworkId: "h1" }, "没有正文与文件时不带这些字段");
  await service.prepare({ courseId: "c1", homeworkId: "h1", overwrite: true });
  assert.deepEqual(seen.at(-1), { courseId: "c1", homeworkId: "h1", overwrite: true });
  const minimal = await service.detail("c1", "h1");
  assert.deepEqual(minimal.data.attachments, []);
  assert.equal(minimal.data.body, "");
  assert.equal((await service.prepare({ courseId: "bad/id", homeworkId: "h1" })).ok, false);
});

test("confirmations: malformed tokens, expiry and clearing never authorise", () => {
  let now = 0;
  const store = createConfirmations({ ttlMs: 50, now: () => now, limit: 2 });
  assert.equal(store.consume("short", "s", "b"), false);
  assert.equal(store.consume("z".repeat(48), "s", "b"), false);
  const first = store.issue("s", "b");
  store.issue("s", "b");
  store.issue("s", "b");
  now = 60;
  assert.equal(store.consume(first.token, "s", "b"), false, "过期凭证即使未被清理也不能使用");
  const fresh = store.issue("s", "b");
  store.clear();
  assert.equal(store.consume(fresh.token, "s", "b"), false, "清空后全部失效");
});

test("sidebar http: attachment upload rejects empty and unsafe names", async t => {
  const host = { describe: () => [], call: async () => ({ ok: true, data: {} }), close: async () => {} };
  const app = await appWith(host);
  t.after(app.close);
  const headers = { ...auth, "content-type": "application/octet-stream" };
  assert.equal((await fetch(app.base + "/api/sidebar/attachments?name=" + encodeURIComponent("../.."), { method: "POST", headers, body: Buffer.from("") })).status, 400);
  assert.equal((await fetch(app.base + "/api/sidebar/attachments?name=" + encodeURIComponent("a/b.txt"), { method: "POST", headers, body: Buffer.from("x") })).status, 200);
  assert.equal((await fetch(app.base + "/api/sidebar/attachments?name=", { method: "POST", headers, body: Buffer.from("x") })).status, 400);
});

test("assignments: ties, missing fields and blank grades keep deterministic order", () => {
  const now = Date.parse("2026-11-15T12:00:00Z");
  assert.deepEqual(
    splitPending([{ id: "b", title: "B", deadlineMs: now + 1000 }, { id: "a", title: "A", deadlineMs: now + 1000 }], now).map(item => item.id),
    ["a", "b"],
    "同期限按标题稳定排序",
  );
  assert.deepEqual(
    splitPending([{ id: "y", title: "Y", deadlineMs: null }, { id: "x", title: "X", deadlineMs: null }], now).map(item => item.id),
    ["x", "y"],
  );
  assert.deepEqual(
    sortUngraded([{ id: "m2", title: "M", submitMs: null, deadlineMs: null }, { id: "m1", title: "M", submitMs: null, deadlineMs: now }]).map(item => item.id),
    ["m1", "m2"],
    "缺提交时间退到期限，两者都缺按 0 处理",
  );
  assert.equal(graded("  "), false);
  assert.equal(graded("A"), true);
  assert.equal(normalizeItem({ id: "x", courseId: "c" }).course, "c");
  assert.equal(normalizeItem({ id: "x", courseId: "c" }).title, "x");
});

test("assignments service: empty payloads and partial detail keep an honest empty result", async () => {
  const empty = await new AssignmentsService({ call: async () => ({ ok: true, data: null }) }, { cacheTtl: 0 }).overview();
  assert.equal(empty.state, "ready");
  assert.deepEqual(empty.active, []);
  const offline = await new AssignmentsService({ call: async () => ({ ok: false, error: {} }) }).overview();
  assert.equal(offline.error.code, "LEARNX_UNAVAILABLE");
  const bare = await new AssignmentsService({ call: async () => ({ ok: true, data: null }) }).detail("c1", "h1");
  assert.equal(bare.ok, true);
  assert.equal(bare.data.grade, null);
  assert.equal(bare.data.title, "");
});

test("sidebar model: storage failures and boundary texts stay explicit", () => {
  const broken = { getItem() { throw new Error("blocked"); }, setItem() { throw new Error("quota"); } };
  assert.deepEqual(readJson(broken, "k", { fallback: true }), { fallback: true });
  assert.equal(writeJson(broken, "k", { a: 1 }), false);
  const now = Date.parse("2026-11-15T12:00:00Z");
  assert.equal(remaining(now + 20e3, now).text, "即将截止");
  assert.equal(remaining(now + 30e3, now).text, "剩 1 分钟");
  assert.equal(normalizeItem(homework("s1", { submitted: "1" })).submitted, true);
  assert.equal(normalizeItem(homework("s2", { submitted: 1 })).submitted, true);
  assert.equal(normalizeItem(homework("s3", { deadline: "1893456000" })).deadlineMs, 1893456000000);
  assert.equal(normalizeItem(null), null);
  assert.equal(toMillis(Number.POSITIVE_INFINITY), null);
  assert.deepEqual(filterArchived([{ id: "a" }], undefined, false).visible, [{ id: "a" }]);
  assert.deepEqual(applyOrder([{ id: "a" }], undefined), [{ id: "a" }]);
  assert.deepEqual(moveId(["a"], 0.5, 0), ["a"]);
  assert.deepEqual(toggleArchived(undefined, "x"), ["x"]);
  assert.equal(readJson({ getItem: () => "" }, "k", { empty: true }).empty, true);
});

test("confirmations: bound to arguments, single use, and expiring", () => {
  let now = 1000;
  const store = createConfirmations({ ttlMs: 100, now: () => now });
  const { token } = store.issue("tool:learn_submit_assignment", canonicalJson({ preparationId: "a" }));
  assert.equal(store.consume(token, "tool:learn_submit_assignment", canonicalJson({ preparationId: "b" })), false);
  assert.equal(store.consume(token, "other", canonicalJson({ preparationId: "a" })), false);
  assert.equal(store.consume(token, "tool:learn_submit_assignment", canonicalJson({ preparationId: "a" })), true);
  assert.equal(store.consume(token, "tool:learn_submit_assignment", canonicalJson({ preparationId: "a" })), false, "一次性凭证不能重放");
  const second = store.issue("scope", canonicalJson({ x: 1 })).token;
  now += 101;
  assert.equal(store.consume(second, "scope", canonicalJson({ x: 1 })), false, "过期凭证失效");
  assert.equal(canonicalJson({ b: 1, a: [2, { d: 3, c: 4 }] }), '{"a":[2,{"c":4,"d":3}],"b":1}');
});

test("assignments service: paginates, derives sections and reports an unavailable site honestly", async () => {
  const pages = [
    { items: [homework("1"), homework("2", { submitted: true, submitTime: "2026-11-10 09:00:00" })], nextOffset: 2, total: 3 },
    { items: [homework("3", { submitted: true, submitTime: "2026-11-12 09:00:00", grade: 88 })], nextOffset: undefined, total: 3 },
  ];
  let calls = 0;
  const host = { call: async (name) => { assert.equal(name, "learn_list_assignments"); return { ok: true, data: pages[calls++] }; } };
  const service = new AssignmentsService(host, { now: () => Date.parse("2026-11-15T12:00:00Z"), cacheTtl: 10_000 });
  const data = await service.overview();
  assert.equal(data.state, "ready");
  assert.equal(calls, 2);
  assert.deepEqual(data.active.map(item => item.id), ["1"]);
  assert.deepEqual(data.ungraded.map(item => item.id), ["2"]);
  await service.overview();
  assert.equal(calls, 2, "缓存命中不应重复调用网络学堂");

  const offline = new AssignmentsService({ call: async () => ({ ok: false, error: { code: "AUTH_REQUIRED", message: "需要登录" } }) });
  const failed = await offline.overview();
  assert.equal(failed.state, "unavailable");
  assert.equal(failed.error.code, "AUTH_REQUIRED");
  assert.deepEqual(failed.active, []);
});

test("assignments service: detail and submission surface tool errors instead of faking success", async () => {
  const seen = [];
  const host = {
    call: async (name, args) => {
      seen.push([name, args]);
      if (name === "learn_get_content") return { ok: true, data: { id: args.id, title: "作业", body: "要求", attachments: [{ name: "a.pdf", role: "attachment" }] } };
      if (name === "learn_prepare_submission") return { ok: true, data: { id: "11111111-1111-4111-8111-111111111111", course: "电力电子", content: args.content, attachment: { name: "报告.pdf", size: 3 } } };
      return { ok: false, error: { code: "DEADLINE_PASSED", message: "作业已过允许的提交截止时间。" } };
    },
  };
  const service = new AssignmentsService(host);
  const detail = await service.detail("c1", "h1");
  assert.equal(detail.ok, true);
  assert.deepEqual(detail.data.attachments, [{ name: "a.pdf", role: "attachment" }]);
  const prepared = await service.prepare({ courseId: "c1", homeworkId: "h1", content: "正文", filePath: "/tmp/x.pdf" });
  assert.equal(prepared.ok, true);
  assert.deepEqual(seen.at(-1)[1], { courseId: "c1", homeworkId: "h1", content: "正文", filePath: "/tmp/x.pdf" });
  const rejected = await service.submit("11111111-1111-4111-8111-111111111111");
  assert.equal(rejected.ok, false);
  assert.equal(rejected.error.code, "DEADLINE_PASSED");
  assert.equal((await service.submit("not-a-uuid")).ok, false);
  assert.equal((await service.detail("../etc", "h1")).ok, false);
  const sameStamp = sortUngraded([
    { id: "z", title: "B", submitMs: 5, deadlineMs: null },
    { id: "y", title: "A", submitMs: 5, deadlineMs: null },
  ]);
  assert.deepEqual(sameStamp.map(item => item.id), ["y", "z"], "同一提交时间按标题稳定排序");
  const gradedDetail = await new AssignmentsService({ call: async () => ({ ok: true, data: { id: "h", title: "t", grade: 92 } }) }).detail("c1", "h1");
  assert.equal(gradedDetail.data.grade, 92);
});

async function appWith(host) {
  const dir = await mkdtemp(path.join(tmpdir(), "campus-sidebar-"));
  const server = createAppServer({
    config: { host: "127.0.0.1", hostname: "localhost", port: 0, stateDir: dir, token: "sidebar-fixture", modelRoute: "madmodel", modelName: "fixture", requireApproval: true },
    host,
    route: { route: "madmodel", models: async () => [], status: async () => ({ available: false }), chat: async () => Response.json({}) },
    sessions: new SessionStore(dir),
    version: "sidebar-test",
    webuiDir: path.join(import.meta.dirname, "..", "webui"),
    devices: new DeviceStore(dir, { encrypt: async value => value }),
    pairing: new PairingCodes(),
  });
  const base = await server.listen();
  return { base, close: async () => { await server.close?.(); await rm(dir, { recursive: true, force: true }); } };
}

const auth = { authorization: "Bearer sidebar-fixture" };
const post = (base, url, body, extra = {}) => fetch(base + url, { method: "POST", headers: { ...auth, "content-type": "application/json", ...extra }, body: JSON.stringify(body) });

test("sidebar http: read routes, attachment upload, two-step submission and single-use confirmation", async t => {
  let submitted = 0;
  const host = {
    describe: () => [{ name: "learn_list_assignments", readOnly: true, destructive: false }, { name: "learn_submit_assignment", readOnly: false, destructive: true }],
    call: async (name, args) => {
      if (name === "learn_list_assignments") return { ok: true, data: { items: [homework("h1")], errors: [], total: 1 } };
      if (name === "learn_prepare_submission") return { ok: true, data: { id: "22222222-2222-4222-8222-222222222222", course: "电力电子", title: args.homeworkId, content: args.content, attachment: args.filePath ? { name: "x.pdf" } : undefined } };
      if (name === "learn_submit_assignment") { submitted++; return { ok: true, data: { status: "submitted", message: "已回读核验" } }; }
      return { ok: false, error: { code: "UNKNOWN", message: "unexpected" } };
    },
    close: async () => {},
  };
  const app = await appWith(host);
  t.after(app.close);
  const listed = await (await fetch(app.base + "/api/sidebar/assignments", { headers: auth })).json();
  assert.equal(listed.ok, true);
  assert.equal(listed.state, "ready");
  assert.deepEqual(listed.active.map(item => item.id), ["h1"]);

  const uploaded = await fetch(app.base + "/api/sidebar/attachments?name=" + encodeURIComponent("报告.pdf"), { method: "POST", headers: { ...auth, "content-type": "application/octet-stream" }, body: Buffer.from("hello") });
  const file = (await uploaded.json()).file;
  assert.equal(file.name, "报告.pdf");
  assert.equal(file.size, 5);
  assert.equal(await readFile(file.path, "utf8"), "hello");

  const prepared = await (await post(app.base, "/api/sidebar/submissions/prepare", { courseId: "c1", homeworkId: "h1", content: "正文", filePath: file.path })).json();
  assert.ok(prepared.confirmToken);
  assert.equal((await post(app.base, "/api/sidebar/submissions/confirm", { preparationId: prepared.preparation.id, confirmToken: "0".repeat(48) })).status, 409);
  const confirmed = await post(app.base, "/api/sidebar/submissions/confirm", { preparationId: prepared.preparation.id, confirmToken: prepared.confirmToken });
  assert.equal(confirmed.status, 200);
  assert.equal((await confirmed.json()).receipt.status, "submitted");
  assert.equal((await post(app.base, "/api/sidebar/submissions/confirm", { preparationId: prepared.preparation.id, confirmToken: prepared.confirmToken })).status, 409, "同一确认不能重放");
  assert.equal(submitted, 1);
});

test("sidebar http: destructive tools need a one-time approval bound to their exact arguments", async t => {
  const calls = [];
  const host = {
    describe: () => [{ name: "learn_list_assignments", readOnly: true, destructive: false }, { name: "learn_submit_assignment", readOnly: false, destructive: true }],
    call: async (name, args) => { calls.push([name, args]); return { ok: true, data: { status: "submitted" } }; },
    close: async () => {},
  };
  const app = await appWith(host);
  t.after(app.close);
  const args = { preparationId: "33333333-3333-4333-8333-333333333333" };
  const blocked = await post(app.base, "/api/tools/learn_submit_assignment", args);
  assert.equal(blocked.status, 428);
  assert.equal((await blocked.json()).requiresApproval, true);
  assert.equal(calls.length, 0, "未确认前不得调用写入工具");

  assert.equal((await post(app.base, "/api/tool-approvals", { name: "learn_list_assignments", args })).status, 400);
  assert.equal((await post(app.base, "/api/tool-approvals", { name: "nope_tool", args })).status, 404);
  const { token } = await (await post(app.base, "/api/tool-approvals", { name: "learn_submit_assignment", args })).json();
  assert.equal((await post(app.base, "/api/tools/learn_submit_assignment", { preparationId: "44444444-4444-4444-8444-444444444444" }, { "x-campus-approval": token })).status, 428, "凭证绑定参数，换了参数无效");
  const allowed = await post(app.base, "/api/tools/learn_submit_assignment", args, { "x-campus-approval": token });
  assert.equal(allowed.status, 200);
  assert.deepEqual(calls, [["learn_submit_assignment", args]]);
  assert.equal((await post(app.base, "/api/tools/learn_submit_assignment", args, { "x-campus-approval": token })).status, 428, "凭证一次性");
  assert.equal(calls.length, 1);
});