import { test } from "node:test";
import assert from "node:assert/strict";
import { authPresentation, storagePresentation, jobStoragePresentation, workspaceJobIsPending } from "../webui/workspace.js";

const checkedAt = "2026-11-13T18:00:00.000Z";
const verified = { state: "ready", verified: true, checkedAt, source: "protected-api:fixture-account-info" };
const scope = { accountId: "account-digest", repoId: "private-repo", rootPath: "/Agent工作区" };
const storage = { mode: "cloud", state: "ready", privacy: { verified: true, checkedAt, code: "PRIVATE" }, scope };

test("已登录必须有真实受保护核验标记、固定来源和有效时间", () => {
  assert.equal(authPresentation(verified).label, "已登录");
  assert.equal(authPresentation(verified).verified, true);
  for (const value of [undefined, null, "ready", {}, { state: "ready" }, { state: "ready", configured: true, account: "configured-user", token: "not-proof" }, { ...verified, verified: false }, { ...verified, source: "configured" }, { ...verified, source: null }, { ...verified, checkedAt: "not-a-date" }, { ...verified, checkedAt: 1 }, { ...verified, checkedAt: undefined }]) {
    assert.equal(authPresentation(value).state, "unverified");
    assert.equal(authPresentation(value).verified, false);
  }
});

test("认证枚举不混淆未登录、过期、未核验、网络无法核验和模拟", () => {
  for (const [state, label] of Object.entries({ "login-required": "未登录", expired: "登录已过期", unverified: "未核验", unknown: "无法核验", mock: "模拟" })) assert.equal(authPresentation({ state }).label, label);
  assert.equal(authPresentation({ ...verified, mode: "mock" }).state, "mock");
  assert.equal(authPresentation({ ...verified, mock: true }).state, "mock");
  assert.equal(authPresentation({ state: "toString" }).state, "unverified");
});

test("正在核验或状态刷新失败时不将旧证据显示为当前已登录", () => {
  const checking = authPresentation(verified, { checking: true });
  assert.equal(checking.label, "核验中…");
  assert.equal(checking.verified, false);
  assert.equal(checking.checkedAt, checkedAt);
  const stale = authPresentation(verified, { stale: true });
  assert.equal(stale.label, "无法核验");
  assert.equal(stale.verified, false);
});

test("只保留核验白名单，不将配置账号、token或原始响应带入UI记录", () => {
  assert.deepEqual(authPresentation({ ...verified, code: "VERIFIED", account: "do-not-display", token: "do-not-display", raw: { secret: "do-not-display" } }), { state: "ready", label: "已登录", verified: true, source: verified.source, checkedAt, code: "VERIFIED" });
  assert.deepEqual(authPresentation({ state: "unknown", source: 1, code: false, checkedAt: "bad" }), { state: "unknown", label: "无法核验", verified: false });
});

test("云盘可用必须审计通过且绑定固定私有目录精确范围", () => {
  const status = storagePresentation(storage);
  assert.equal(status.label, "云盘工作区可用");
  assert.equal(status.privacyVerified, true);
  assert.equal(status.canInitialize, false);
  assert.deepEqual(status.scope, scope);
  for (const value of [{ ...storage, privacy: { verified: false } }, { ...storage, privacy: { verified: true } }, { ...storage, scope: null }, { ...storage, scope: { ...scope, rootPath: "/其他目录" } }, { ...storage, scope: { ...scope, accountId: "" } }, { ...storage, scope: { ...scope, repoId: 1 } }]) {
    assert.equal(storagePresentation(value).state, "unverified");
    assert.equal(storagePresentation(value).canInitialize, false);
  }
});

test("未初始化的精确预览不是已创建，不允许无证据或本地缓存冒充云盘", () => {
  const preview = storagePresentation({ ...storage, state: "uninitialized" });
  assert.equal(preview.label, "云盘工作区待初始化");
  assert.equal(preview.canInitialize, true);
  assert.equal(storagePresentation({ ...storage, state: "uninitialized", privacy: { verified: false } }).canInitialize, false);
  for (const value of [null, {}, { ...storage, mode: "local" }, { ...storage, state: "toString" }]) assert.equal(storagePresentation(value).state, "unavailable");
  for (const state of ["login-required", "unverified", "unavailable"]) assert.equal(storagePresentation({ ...storage, state }).state, state);
});

test("云盘查询加载与错误不展示旧ready，保留实际恢复原因", () => {
  const loading = storagePresentation(storage, { loading: true });
  assert.equal(loading.state, "loading");
  assert.equal(loading.canInitialize, false);
  const failure = storagePresentation(storage, { error: "状态接口暂不可用" });
  assert.equal(failure.state, "unavailable");
  assert.equal(failure.message, "状态接口暂不可用");
  assert.equal(failure.canInitialize, false);
  assert.equal(storagePresentation({ ...storage, message: "需要重新核验", code: "PRIVACY_UNVERIFIED" }).message, "需要重新核验");
  assert.equal(storagePresentation({ ...storage, message: false, code: 1 }).code, "");
});

test("计算与云盘同步独立：计算完成但pending仍需查询，failed不伪称已保存", () => {
  const job = { state: "succeeded", storage: { mode: "cloud", state: "pending" } };
  assert.equal(workspaceJobIsPending(job), true);
  assert.equal(jobStoragePresentation(job).label, "云盘同步中");
  const failed = { ...job, storage: { mode: "cloud", state: "failed", message: "网络中断" } };
  assert.equal(workspaceJobIsPending(failed), false);
  assert.equal(jobStoragePresentation(failed).label, "云盘同步失败");
  assert.equal(jobStoragePresentation(failed).message, "网络中断");
  const synced = { ...job, storage: { mode: "cloud", state: "synced" } };
  assert.equal(workspaceJobIsPending(synced), false);
  assert.equal(jobStoragePresentation(synced).label, "云盘已保存");
  assert.equal(workspaceJobIsPending({ state: "running" }), true);
  assert.equal(jobStoragePresentation({ state: "succeeded" }).visible, false);
  assert.equal(jobStoragePresentation({ storage: { mode: "local", state: "synced" } }).label, "云盘状态未核验");
  assert.equal(jobStoragePresentation({ storage: { mode: "cloud", state: "toString", message: false } }).state, "unverified");
  assert.equal(jobStoragePresentation({ storage: { mode: "cloud", state: "unconfirmed", code: "CLOUD_PUSH_FAILED" } }).label, "仅本地·云盘未确认");
  assert.equal(jobStoragePresentation({ storage: { mode: "cloud", state: "unconfirmed", code: "CLOUD_PUSH_FAILED" } }).code, "CLOUD_PUSH_FAILED");
});
