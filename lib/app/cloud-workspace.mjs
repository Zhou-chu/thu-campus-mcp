import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { validSessionId } from "./sessions.mjs";
import { WorkspaceFiles } from "./workspace-files.mjs";
import { WorkspaceError, relativePath, inspectAbsolute, workspaceIO } from "./workspace-paths.mjs";

/**
 * 云盘持久层适配：把现有 WorkspaceFiles 的本地缓存换成“每账号隔离的私有云盘工作区”。
 *
 * - 每次文件操作前后核验在线身份；会话首次使用时绑定 accountHash，换账号不会静默迁移。
 * - 本地缓存 root 为 stateDir/workspaces/cloud-cache/<accountHash>/<sessionId>，只挂进容器；
 *   绑定与文件账本落在 stateDir/cloud-workspace/journal.json，永远不进容器挂载。
 * - 写入先落本地再逐文件上传；上传未确认时如实回报，不伪装成已保存。
 * - 只有全部文件核验成功的 sync 才返回 state:'synced'，其余一律抛错保留 pending。
 */

const CLOUD = Object.freeze({
  status: "cloud_workspace_status",
  init: "cloud_workspace_init",
  list: "cloud_workspace_list",
  pull: "cloud_workspace_pull",
  push: "cloud_workspace_push",
});

const DEFAULT_LIMITS = Object.freeze({
  maxFiles: 1000,
  maxTotalBytes: 64 * 1024 * 1024,
  maxFileBytes: 32 * 1024 * 1024,
  maxArchiveBytes: 64 * 1024 * 1024,
  maxPulledFiles: 200,
});

const STATE_VALUES = new Set(["ready", "uninitialized", "login-required", "unverified", "unavailable"]);
const ACCOUNT_ID = /^[0-9a-f]{32}$/i;
const SHA256 = /^[0-9a-f]{64}$/i;
const CODE = /^[A-Z][A-Z0-9_]{1,63}$/;
/** 沙箱冻结的主脚本只是运行期临时文件，既不进云盘也不进帐本。 */
const RUNTIME_PREFIX = ".sandbox-script-";
const JOURNAL_VERSION = 1;

function fail(code, message) {
  return new WorkspaceError(code, message);
}
function digestOf(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}
function accountHash(accountId) {
  return createHash("sha256").update(accountId.toLowerCase()).digest("hex").slice(0, 32);
}
function isRuntimeFile(relative) {
  return relative.split("/").some((part) => part.startsWith(RUNTIME_PREFIX));
}
function errorCode(value) {
  return typeof value === "string" && CODE.test(value) ? value : "";
}
function errorMessage(value) {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, 400) : "";
}
function stateFromCode(code) {
  if (/AUTH|LOGIN|EXPIRED|UNAUTHORIZED/.test(code)) return "login-required";
  if (/UNSUPPORTED|UNVERIFIED/.test(code)) return "unverified";
  return "unavailable";
}
async function fileDigest(absolute, maxBytes) {
  const info = await lstat(absolute);
  if (info.isSymbolicLink()) throw fail("SYMLINK_REJECTED", "不允许符号链接或目录联接。");
  if (!info.isFile()) throw fail("NOT_FILE", "此操作需要普通文件。");
  if (info.size > maxBytes) throw fail("FILE_TOO_LARGE", "文件超过同步大小限额。");
  const hash = createHash("sha256");
  let length = 0;
  for await (const chunk of createReadStream(absolute)) {
    length += chunk.length;
    if (length > maxBytes) throw fail("FILE_TOO_LARGE", "文件超过同步大小限额。");
    hash.update(chunk);
  }
  const current = await lstat(absolute);
  if (!current.isFile() || current.size !== length) throw fail("FILE_CHANGED", "同步期间文件发生变化，请重试。");
  return { sha256: hash.digest("hex"), size: length };
}

export class CloudWorkspaceFiles extends WorkspaceFiles {
  #host;
  #stateDir;
  #cacheBase;
  #journalFile;
  #limits;
  #journal = null;
  #chain = Promise.resolve();
  #nested = new Set();
  #plans = new WeakMap();
  #used = new WeakSet();

  constructor({ host, stateDir, limits } = {}) {
    if (!host || typeof host.call !== "function") throw fail("INVALID_ARGUMENTS", "云盘适配需要可调用的工具主机。");
    if (typeof stateDir !== "string" || !stateDir) throw fail("INVALID_ARGUMENTS", "必须配置应用状态目录。");
    super({ baseDir: path.join(stateDir, "workspaces", "cloud-cache") });
    this.#host = host;
    this.#stateDir = path.resolve(stateDir);
    this.#cacheBase = this.baseDir;
    this.#journalFile = path.join(this.#stateDir, "cloud-workspace", "journal.json");
    this.#limits = { ...DEFAULT_LIMITS, ...(limits && typeof limits === "object" ? limits : {}) };
  }

  // ---------------------------------------------------------------- 帐本

  #emptyJournal() {
    return { version: JOURNAL_VERSION, sessions: {} };
  }
  #validateJournal(data) {
    if (!data || typeof data !== "object" || data.version !== JOURNAL_VERSION) return null;
    const sessions = data.sessions;
    if (!sessions || typeof sessions !== "object" || Array.isArray(sessions)) return null;
    for (const entry of Object.values(sessions)) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
      if (entry.files !== undefined && (!entry.files || typeof entry.files !== "object" || Array.isArray(entry.files))) return null;
    }
    return data;
  }
  async #loadJournal() {
    if (this.#journal) return this.#journal;
    let text;
    try {
      text = await readFile(this.#journalFile, "utf8");
    } catch (error) {
      if (error?.code === "ENOENT") {
        this.#journal = this.#emptyJournal();
        return this.#journal;
      }
      throw fail("CLOUD_JOURNAL_UNAVAILABLE", "本地云盘绑定记录无法读取，已停止操作以免写错账号。");
    }
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw fail("CLOUD_JOURNAL_CORRUPT", "本地云盘绑定记录已损坏，需人工处理后再操作。");
    }
    const journal = this.#validateJournal(parsed);
    if (!journal) throw fail("CLOUD_JOURNAL_CORRUPT", "本地云盘绑定记录结构异常，需人工处理后再操作。");
    this.#journal = journal;
    return journal;
  }
  /** 回收路径专用：await 账本加载（重启后可能尚未载入），不联网、不读文件内容。 */
  async #journalForCleanup() {
    try {
      return await this.#loadJournal();
    } catch {
      // 账本损坏或不可读时 fail open：只回收 legacy 目录，不编造云端缓存路径。
      return this.#emptyJournal();
    }
  }
  async #saveJournal(data) {
    await mkdir(path.dirname(this.#journalFile), { recursive: true, mode: 0o700 });
    const temporary = `${this.#journalFile}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(data), { mode: 0o600 });
    await rename(temporary, this.#journalFile);
  }
  async #readJournal(read) {
    const data = await this.#loadJournal();
    return read(data);
  }
  #updateJournal(update) {
    const run = this.#chain.then(async () => {
      const data = await this.#loadJournal();
      const { result, changed } = await update(data);
      if (changed) await this.#saveJournal(data);
      return result;
    });
    this.#chain = run.then(() => undefined, () => undefined);
    return run;
  }

  // ---------------------------------------------------------------- 身份与绑定

  #sessionEntry(data, sessionId, { create = false } = {}) {
    const sessions = data.sessions;
    let entry = sessions[sessionId];
    let changed = false;
    if (!entry && create) {
      entry = { accountId: null, accountHash: null, accounts: [], boundAt: null, files: {} };
      sessions[sessionId] = entry;
      changed = true;
    }
    if (entry) {
      if (!entry.files || typeof entry.files !== "object" || Array.isArray(entry.files)) {
        entry.files = {};
        changed = true;
      }
      if (!Array.isArray(entry.accounts)) {
        entry.accounts = entry.accountHash ? [entry.accountHash] : [];
        changed = true;
      }
    }
    return { entry, changed };
  }
  async #bind(sessionId, accountId) {
    if (!validSessionId(sessionId)) throw fail("INVALID_SESSION", "会话ID不合法。");
    if (!ACCOUNT_ID.test(accountId)) throw fail("CLOUD_ACCOUNT_UNVERIFIED", "云盘返回的账户标识不可核验，未执行文件操作。");
    const hash = accountHash(accountId);
    return this.#updateJournal((data) => {
      const { entry, changed } = this.#sessionEntry(data, sessionId, { create: true });
      if (!entry.accountId) {
        entry.accountId = accountId;
        entry.accountHash = hash;
        entry.boundAt = new Date().toISOString();
        if (!entry.accounts.includes(hash)) entry.accounts.push(hash);
        return { result: hash, changed: true };
      }
      if (entry.accountId !== accountId || entry.accountHash !== hash)
        throw fail("CLOUD_ACCOUNT_MISMATCH", "该会话已绑定另一个云盘账号，未在新账号下写入、迁移或覆盖。");
      // 旧版本账本缺字段时，修复结果也要落盘，否则每次都要重新猜。
      return { result: hash, changed };
    });
  }
  async #checkBinding(sessionId, accountId) {
    const entry = await this.#readJournal((data) => data.sessions[sessionId]);
    if (!entry?.accountHash) return null;
    if (accountId && entry.accountId !== accountId)
      throw fail("CLOUD_ACCOUNT_MISMATCH", "该会话缓存属于另一个云盘账号，未在新账号下读取或写入。");
    return entry;
  }
  async #localRoot(sessionId, { create = false } = {}) {
    if (!validSessionId(sessionId)) throw fail("INVALID_SESSION", "会话ID不合法。");
    const entry = await this.#readJournal((data) => data.sessions[sessionId]);
    if (!entry?.accountHash) throw fail("CLOUD_CACHE_ABSENT", "该会话在本地还没有云盘缓存，需要在线状态才能建立。");
    const directory = path.join(this.#cacheBase, entry.accountHash, sessionId);
    if (create) await inspectAbsolute(directory, { createDirectories: true });
    return directory;
  }

  // ---------------------------------------------------------------- 云盘桥接

  async #call(name, args) {
    try {
      const reply = await this.#host.call(name, args);
      if (!reply || typeof reply !== "object") return { ok: false, error: { code: "CLOUD_BAD_REPLY", message: "云盘桥接返回了无法识别的结果。" } };
      return reply;
    } catch {
      return { ok: false, error: { code: "CLOUD_BRIDGE_FAILED", message: "云盘桥接不可用，请稍后重试。" } };
    }
  }
  #replyError(error, fallbackCode, fallbackMessage) {
    return fail(errorCode(error?.code) || fallbackCode, errorMessage(error?.message) || fallbackMessage);
  }
  #flatten(data) {
    const storage = data && typeof data.storage === "object" && data.storage ? data.storage : {};
    let state = STATE_VALUES.has(storage.state) ? storage.state : "unavailable";
    const scope = this.#scopeOf(storage.scope, data?.accountId, storage.repoId, storage.rootPath);
    const rawPrivacy = storage.privacy;
    const privacy = rawPrivacy && typeof rawPrivacy === "object" ? {
      verified: rawPrivacy.verified === true,
      checkedAt: typeof rawPrivacy.checkedAt === "string" ? rawPrivacy.checkedAt : null,
      code: errorCode(rawPrivacy.code) || null,
    } : null;
    const result = { mode: "cloud", state };
    if (scope) result.scope = scope;
    if (privacy) result.privacy = privacy;
    const message = errorMessage(storage.message);
    if (message) result.message = message;
    const code = errorCode(storage.code);
    if (code) result.code = code;
    if (state === "ready" && (!scope || privacy?.verified !== true)) {
      result.state = "unverified";
      result.code ||= "CLOUD_SCOPE_UNVERIFIED";
      result.message ||= "云盘返回的就绪状态缺少完整私有范围或权限核验，未按可用处理。";
    }
    return result;
  }
  #scopeOf(raw, accountId, repoId, rootPath) {
    const source = raw && typeof raw === "object" ? raw : {};
    const id = [source.accountId, accountId].find((value) => typeof value === "string" && ACCOUNT_ID.test(value));
    const repo = [source.repoId, repoId].find((value) => typeof value === "string" && /^[0-9a-z._-]{4,128}$/i.test(value));
    const root = [source.rootPath, rootPath].find((value) => typeof value === "string" && value.startsWith("/"));
    if (!id || !repo || !root) return undefined;
    return { accountId: id, repoId: repo, rootPath: root };
  }
  async #requireReady() {
    const storage = await this.status();
    if (storage.state === "ready" && storage.scope) return storage;
    const hints = {
      uninitialized: ["CLOUD_UNINITIALIZED", "云盘私有工作区尚未初始化，请在对话中确认固定范围后再写入。"],
      "login-required": ["CLOUD_LOGIN_REQUIRED", "清华云盘未登录或登录已过期，请先在服务页完成登录。"],
      unverified: ["CLOUD_UNVERIFIED", "未能核验个人私有云盘工作区，未执行写入。"],
      unavailable: ["CLOUD_UNAVAILABLE", "云盘当前不可用，未执行写入；本地模式需由应用显式配置，不会在这里静默降级。"],
    };
    const [code, message] = hints[storage.state];
    throw fail(code, storage.message || message);
  }
  async #verifyIdentity(sessionId, accountId) {
    const storage = await this.status();
    const current = storage.state === "ready" ? storage.scope?.accountId : null;
    if (current && current !== accountId)
      throw fail("CLOUD_ACCOUNT_MISMATCH", "操作期间云盘账号发生变化，已停止后续保存；本地文件已保留。");
    if (!current && storage.state !== "unavailable") return;
    await this.#checkBinding(sessionId, accountId);
  }

  // ---------------------------------------------------------------- 只读状态

  async status() {
    const reply = await this.#call(CLOUD.status, {});
    if (!reply.ok) {
      const code = errorCode(reply.error?.code) || "CLOUD_STATUS_FAILED";
      return {
        mode: "cloud",
        state: stateFromCode(code),
        code,
        message: errorMessage(reply.error?.message) || "未能核验云盘工作区状态。",
      };
    }
    return this.#flatten(reply.data);
  }

  // ---------------------------------------------------------------- 初始化

  async prepareInitialization() {
    const storage = await this.status();
    if (storage.state === "ready") throw fail("CLOUD_ALREADY_INITIALIZED", "云盘私有工作区已就绪，无需再次初始化。");
    if (storage.state === "login-required" || storage.state === "unavailable")
      throw fail(storage.state === "login-required" ? "CLOUD_LOGIN_REQUIRED" : "CLOUD_UNAVAILABLE",
        storage.message || "云盘当前不可用，无法提供初始化确认。");
    if (!storage.scope) throw fail("CLOUD_SCOPE_UNVERIFIED", "未能核验个人私有库与固定目录，未提供初始化确认。");
    const scope = storage.scope;
    const plan = Object.freeze({
      accountId: scope.accountId,
      expectedRepoId: scope.repoId,
      root: scope.rootPath,
      operation: "init",
    });
    const prepared = {
      approvalArgs: {
        operation: "init",
        accountId: plan.accountId,
        expectedRepoId: plan.expectedRepoId,
        root: plan.root,
        creates: ["/Agent工作区", "私有marker", "sessions"],
        scope: { ...scope },
      },
      risk: "将在你的清华云盘个人默认资料库中创建固定的全私有Agent工作区（含私有marker与sessions目录），此固定私有目录将作为后续会话输入与产物的自动持久层：工作区里的文件会被逐个上传到这里。不选共享库、不改分享权限、不接管无绑定同名目录；校园提交、宿主机附件导入与容器执行仍需逐次确认。确认后模型无法更改账户、仓库或路径。",
    };
    this.#plans.set(prepared, plan);
    return prepared;
  }
  async initialize({ prepared, approved } = {}) {
    const plan = prepared && typeof prepared === "object" ? this.#plans.get(prepared) : undefined;
    if (!plan) throw fail("CLOUD_APPROVAL_REQUIRED", "初始化必须使用本次运行生成的确认对象，不能自行拼造。");
    if (approved !== true) throw fail("CLOUD_APPROVAL_REQUIRED", "初始化需要用户明确确认精确的账户、仓库与目录范围。");
    if (this.#used.has(prepared)) throw fail("CLOUD_APPROVAL_CONSUMED", "该初始化确认已用过一次，需要重新发起并重新确认。");
    this.#used.add(prepared);
    const before = await this.status();
    if (before.scope?.accountId && before.scope.accountId !== plan.accountId)
      throw fail("CLOUD_ACCOUNT_MISMATCH", "云盘账户已变化，未在其它账号下初始化。");
    const reply = await this.#call(CLOUD.init, { accountId: plan.accountId, expectedRepoId: plan.expectedRepoId });
    if (!reply.ok) throw this.#replyError(reply.error, "CLOUD_INIT_FAILED", "云盘私有工作区初始化未完成。");
    const after = await this.status();
    if (after.state !== "ready" || after.scope?.repoId !== plan.expectedRepoId)
      throw fail("CLOUD_INIT_UNVERIFIED", "初始化返回后仍未核验到私有就绪状态，未标记为可用。");
    return { mode: "cloud", state: "ready", scope: after.scope, privacy: after.privacy, checkedAt: new Date().toISOString() };
  }

  // ---------------------------------------------------------------- 路径与回收

  async root(sessionId) {
    return workspaceIO(async () => {
      const storage = await this.#requireReady();
      await this.#bind(sessionId, storage.scope.accountId);
      const directory = await this.#localRoot(sessionId, { create: true });
      await inspectAbsolute(directory, { createDirectories: true });
      return directory;
    });
  }
  async resolve(sessionId, relative, { mustExist = true } = {}) {
    return workspaceIO(async () => {
      const safe = relativePath(relative);
      const root = await this.#localRoot(sessionId, { create: false });
      // relativePath 已拒绝绝对路径、上级目录与跨会话写法，拼出的绝对路径必然落在本会话缓存内。
      const absolute = path.resolve(root, safe);
      await inspectAbsolute(absolute, { mustExist });
      return absolute;
    });
  }
  /** 只按本地帐本算容器要收回的精确目录，不联网、不读文件内容、不删除任何东西。 */
  async cleanupRoot(sessionId) {
    const roots = [path.join(this.#stateDir, "workspaces", sessionId)];
    const journal = await this.#journalForCleanup();
    const hashes = new Set();
    if (validSessionId(sessionId)) {
      const entry = journal.sessions?.[sessionId];
      if (entry) {
        if (typeof entry.accountHash === "string" && /^[0-9a-f]{16,64}$/i.test(entry.accountHash)) hashes.add(entry.accountHash);
        for (const hash of Array.isArray(entry.accounts) ? entry.accounts : [])
          if (typeof hash === "string" && /^[0-9a-f]{16,64}$/i.test(hash)) hashes.add(hash);
      }
    }
    for (const hash of hashes) roots.push(path.join(this.#cacheBase, hash, sessionId));
    return roots;
  }

  // ---------------------------------------------------------------- 读取（含离线缓存与按需下载）

  async #readable(sessionId, storage) {
    if (!validSessionId(sessionId)) throw fail("INVALID_SESSION", "会话ID不合法。");
    // 只要云盘报出了可核验的线上身份，就先与本地绑定对账：
    // uninitialized/unverified 并不等于“没有身份”，不能借此把明确换账号当成离线缓存放过。
    const observedAccountId = ACCOUNT_ID.test(storage.scope?.accountId) ? storage.scope.accountId : null;
    const entry = await this.#checkBinding(sessionId, observedAccountId);
    const ready = storage.state === "ready" && Boolean(observedAccountId);
    if (!ready) {
      if (!entry?.accountHash) throw fail("CLOUD_CACHE_ABSENT", "该会话没有本地云盘缓存，且云盘当前不可用。");
      // 同一账号但工作区未就绪、或网络未知且没有 scope 时，才允许只读本地缓存。
      return { accountId: null, offline: true };
    }
    if (!entry?.accountHash) await this.#bind(sessionId, observedAccountId);
    await this.#localRoot(sessionId, { create: true });
    return { accountId: observedAccountId, offline: false };
  }
  #listStorage(session) {
    return {
      mode: "cloud",
      source: "local-cache",
      verified: false,
      offline: session.offline,
      note: session.offline
        ? "离线缓存：云端是否最新未核验。"
        : "本地缓存：只有 workspace_sync 核验后才代表已保存到云盘。",
    };
  }
  async #provenance(sessionId, relative, session, { pulled = false } = {}) {
    const storage = this.#listStorage(session);
    // 本次读取触发了按需下载时，来源要如实标成 cloud-pull 而不是纯本地缓存。
    if (pulled) storage.source = "cloud-pull";
    const entry = await this.#readJournal((data) => data.sessions[sessionId]?.files?.[relative]);
    if (!entry) return { ...storage, state: "local-only" };
    // 读取已经成功，这里只做一次内容核验；文件在此期间消失属于异常，交由调用方看到真实错误。
    const absolute = await this.resolve(sessionId, relative);
    const current = await fileDigest(absolute, this.#limitFor(relative));
    const verified = current.sha256 === String(entry.sha256).toLowerCase();
    return {
      ...storage,
      verified,
      remoteId: typeof entry.remoteId === "string" ? entry.remoteId : undefined,
      syncedAt: typeof entry.syncedAt === "string" ? entry.syncedAt : undefined,
      note: verified
        ? "与最近一次云盘保存的哈希一致；云端是否被其它设备更新需 workspace_sync 核验。"
        : "本地内容与上次云盘保存不一致，尚未确认云端最新。",
    };
  }
  async list(sessionId, args = {}) {
    return workspaceIO(async () => {
      const storage = await this.status();
      const session = await this.#readable(sessionId, storage);
      const requested = relativePath(args?.path ?? ".");
      let result;
      let hydrated = null;
      try {
        result = await WorkspaceFiles.prototype.list.call(this, sessionId, args ?? {});
      } catch (error) {
        if (session.offline || !(error instanceof WorkspaceError) || error.code !== "FILE_NOT_FOUND") throw error;
        hydrated = await this.#hydrateLevel(sessionId, requested, session.accountId);
        if (!hydrated.ok) throw this.#replyError(hydrated.error, "CLOUD_LIST_FAILED", "未能读取云盘目录，无法列出远端文件。");
        result = await WorkspaceFiles.prototype.list.call(this, sessionId, args ?? {});
      }
      if (!session.offline && !hydrated) {
        // 本地目录已存在也必须主动对一次远端：缓存目录一旦创建，本地永远是空目录，不能据此认为云端为空。
        hydrated = await this.#hydrateLevel(sessionId, requested, session.accountId);
        if (hydrated.ok) result = await WorkspaceFiles.prototype.list.call(this, sessionId, args ?? {});
      }
      return this.#withProvenance(sessionId, result, session, hydrated);
    });
  }
  /** 给本地列表附真实来源；远端读取失败时明确标未核验，而不是暗示云目录为空。 */
  async #withProvenance(sessionId, result, session, hydrated) {
    const entries = [];
    for (const entry of result.entries) {
      const known = await this.#readJournal((data) => data.sessions[sessionId]?.files?.[entry.path]);
      entries.push({
        ...entry,
        storage: {
          mode: "cloud",
          source: "local-cache",
          verified: false,
          remoteId: typeof known?.remoteId === "string" ? known.remoteId : undefined,
          synced: typeof known?.remoteId === "string",
        },
      });
    }
    const storage = this.#listStorage(session);
    if (hydrated) {
      if (hydrated.ok) {
        storage.remoteChecked = true;
      } else {
        // 远端读失败时必须说清“这只是本地缓存”，不能暗示云目录为空。
        storage.remoteChecked = false;
        storage.code = errorCode(hydrated.error?.code) || "CLOUD_LIST_FAILED";
        storage.message = "未能读取云端目录，以下只是本地缓存，不能据此认为云端为空。";
      }
    }
    return { ...result, entries, storage };
  }
  #remotePath(value) {
    try {
      return relativePath(value, { allowRoot: false });
    } catch {
      throw fail("CLOUD_INVALID_REMOTE", `云盘返回了非法路径 ${value}，未执行本地补全。`);
    }
  }
  /**
   * 在线列目录时按层对账远端：只补本地缺失的文件，已有文件一律保留（dirty 不丢）。
   * 预算沿用 1000 文件 / 单文件 32MiB（ZIP 64MiB）/ 累计 64MiB / 单次最多补 200 个。
   */
  async #hydrateLevel(sessionId, relative, accountId) {
    const reply = await this.#call(CLOUD.list, { accountId, sessionId, path: relative, recursive: false });
    if (!reply.ok) return { ok: false, error: reply.error, files: 0, pulled: 0, dirs: [] };
    let raw;
    try {
      raw = this.#entriesOf(reply);
    } catch (error) {
      return { ok: false, error: { code: error.code, message: error.message }, files: 0, pulled: 0, dirs: [] };
    }
    const files = [];
    const dirs = [];
    for (const entry of raw) {
      if (!entry || typeof entry.path !== "string" || entry.path === ".") continue;
      const type = entry.type === "directory" ? "dir" : entry.type;
      if (type === "file") files.push(entry);
      else if (type === "dir") dirs.push(entry);
    }
    if (files.length > this.#limits.maxFiles)
      throw fail("CLOUD_PULL_LIMIT", `云盘目录条目超过 ${this.#limits.maxFiles} 个，未自动补全。`);
    let total = 0;
    let pulled = 0;
    for (const entry of files) {
      const safe = this.#remotePath(entry.path);
      const absolute = await this.resolve(sessionId, safe, { mustExist: false });
      const existing = await lstat(absolute).catch(() => null);
      if (existing) continue;
      total += Number.isFinite(Number(entry.size)) ? Number(entry.size) : 0;
      if (total > this.#limits.maxTotalBytes)
        throw fail("CLOUD_PULL_LIMIT", "云端目录文件总大小超过本次补全限额。");
      if (pulled >= this.#limits.maxPulledFiles)
        throw fail("CLOUD_PULL_LIMIT", `单次最多补全 ${this.#limits.maxPulledFiles} 个文件，请改用目录或分批处理。`);
      await this.#pullFile(sessionId, safe, accountId);
      pulled += 1;
    }
    const listed = [];
    for (const entry of dirs) {
      const safe = this.#remotePath(entry.path);
      await inspectAbsolute(await this.resolve(sessionId, safe, { mustExist: false }), { createDirectories: true });
      listed.push({ name: safe.split("/").at(-1) || safe, path: safe });
    }
    return { ok: true, files: files.length, pulled, dirs: listed };
  }
  async read(sessionId, args = {}) {
    return workspaceIO(async () => {
      const storage = await this.status();
      const session = await this.#readable(sessionId, storage);
      let pulled = false;
      let result;
      try {
        result = await WorkspaceFiles.prototype.read.call(this, sessionId, args);
      } catch (error) {
        if (session.offline || !(error instanceof WorkspaceError) || error.code !== "FILE_NOT_FOUND") throw error;
        const requested = relativePath(args?.path, { allowRoot: false });
        await this.#pullFile(sessionId, requested, session.accountId);
        pulled = true;
        result = await WorkspaceFiles.prototype.read.call(this, sessionId, args);
      }
      return { ...result, storage: await this.#provenance(sessionId, result.path, session, { pulled }) };
    });
  }
  async #pullReceipt(sessionId, relative, accountId) {
    const reply = await this.#call(CLOUD.pull, { accountId, sessionId, path: relative });
    if (!reply.ok) throw this.#replyError(reply.error, "CLOUD_PULL_FAILED", "未能从云盘下载该文件。");
    const data = reply.data && typeof reply.data === "object" ? reply.data : {};
    const requested = data.sha256;
    if (typeof data.localPath !== "string" || !path.isAbsolute(data.localPath) || !SHA256.test(String(requested)) || typeof data.remoteId !== "string" || !data.remoteId)
      throw fail("CLOUD_BAD_RECEIPT", "云盘下载回执不完整，未写入本地缓存。");
    return {
      localPath: data.localPath,
      sha256: String(requested).toLowerCase(),
      remoteId: data.remoteId,
      bytes: Number(data.bytes) || 0,
      /** 后端只有在真实下载核对后才解锁“上次写入结果未知”；false 不能当作已保存。 */
      reconciledWrite: data.reconciledWrite === true,
    };
  }
  async #pullFile(sessionId, relative, accountId, { overwrite = false } = {}) {
    const safe = relativePath(relative, { allowRoot: false });
    const receipt = await this.#pullReceipt(sessionId, safe, accountId);
    const limit = this.#limitFor(safe);
    const info = await lstat(receipt.localPath).catch(() => null);
    if (!info || !info.isFile()) throw fail("CLOUD_PULL_MISSING", "云盘下载回执指向的本地文件不存在。");
    if (info.size > limit) throw fail("FILE_TOO_LARGE", "下载文件超过同步大小限额。");
    const bytes = await readFile(receipt.localPath);
    if (digestOf(bytes) !== receipt.sha256)
      throw fail("CLOUD_HASH_MISMATCH", "下载内容与回执哈希不一致，已拒绝写入本地缓存。");
    // 补缓存默认不覆盖：若本地在下载期间出现文件，原子写入会以 FILE_EXISTS 拒绝，不会丢本地改动。
    await WorkspaceFiles.prototype.writeBytes.call(this, sessionId, { path: safe, bytes, overwrite });
    await this.#registerFile(sessionId, safe, { sha256: receipt.sha256, remoteId: receipt.remoteId, size: bytes.length });
    return { path: safe, sha256: receipt.sha256, remoteId: receipt.remoteId, bytes: bytes.length, updated: true };
  }

  // ---------------------------------------------------------------- 写入（先本地，再逐文件核验上传）

  #limitFor(relative) {
    return /\.zip$/i.test(relative) ? this.#limits.maxArchiveBytes : this.#limits.maxFileBytes;
  }
  async #registerFile(sessionId, relative, { sha256, remoteId, size }) {
    return this.#updateJournal((data) => {
      const { entry } = this.#sessionEntry(data, sessionId, { create: true });
      entry.files[relative] = { sha256, remoteId, size, syncedAt: new Date().toISOString() };
      return { result: null, changed: true };
    });
  }
  async #pushFile(sessionId, relative, accountId, { remote = undefined } = {}) {
    const safe = relativePath(relative, { allowRoot: false });
    const absolute = await this.resolve(sessionId, safe);
    const limit = this.#limitFor(safe);
    const local = await fileDigest(absolute, limit);
    const known = await this.#readJournal((data) => data.sessions[sessionId]?.files?.[safe]);
    if (known?.sha256 === local.sha256 && typeof known.remoteId === "string")
      return { path: safe, sha256: local.sha256, remoteId: known.remoteId, skipped: true };
    const args = { accountId, sessionId, path: safe, sourcePath: absolute };
    if (typeof known?.remoteId === "string") {
      args.overwrite = true;
      args.expectedRemoteId = known.remoteId;
    }
    const reply = await this.#call(CLOUD.push, args);
    if (!reply.ok) {
      const code = errorCode(reply.error?.code);
      if (code === "WORKSPACE_WRITE_UNKNOWN") return this.#reconcileUnknown(sessionId, safe, accountId, local);
      if (["WORKSPACE_CONFLICT", "WORKSPACE_EXISTS", "FILE_EXISTS"].includes(code) && !args.overwrite)
        return this.#reconcileUnknown(sessionId, safe, accountId, local, { conflictCode: code });
      throw this.#replyError(reply.error, "CLOUD_PUSH_FAILED", "云盘保存未确认；本地文件已保留，可重试 workspace_sync。");
    }
    const data = reply.data && typeof reply.data === "object" ? reply.data : {};
    const remoteId = typeof data.remoteId === "string" && data.remoteId ? data.remoteId : "";
    const remoteDigest = SHA256.test(String(data.sha256)) ? String(data.sha256).toLowerCase() : "";
    if (!remoteId || !remoteDigest)
      throw fail("CLOUD_BAD_RECEIPT", "云盘上传回执缺少远端标识或哈希，未确认保存。");
    if (remoteDigest !== local.sha256)
      throw fail("CLOUD_HASH_MISMATCH", "云盘回执哈希与本地内容不一致，未确认保存。");
    await this.#registerFile(sessionId, safe, { sha256: local.sha256, remoteId, size: local.size });
    return { path: safe, sha256: local.sha256, remoteId, bytes: local.size, overwrite: args.overwrite === true };
  }
  /** 上传结果未知时不盲重投：先只读对账，同哈希才登记，否则按冲突保留本地。 */
  async #reconcileUnknown(sessionId, relative, accountId, local, { conflictCode = "" } = {}) {
    let receipt;
    try {
      receipt = await this.#pullReceipt(sessionId, relative, accountId);
    } catch {
      throw fail("CLOUD_WRITE_UNKNOWN", "上次云盘写入结果未知，且未能只读核对远端内容；本地文件已保留，可重试 workspace_sync。");
    }
    if (receipt.sha256 !== local.sha256) {
      throw fail("CLOUD_CONFLICT", `云盘上的 ${relative} 与本地内容不同（${conflictCode || "写入结果未知"}），未覆盖任何一侧；请先确认保留哪一份。`);
    }
    // 哈希一致只证明远端内容相同；后端未解除 unknown 锁时仍不能宣称保存完成，也不盲重投。
    if (receipt.reconciledWrite !== true) {
      throw fail("CLOUD_WRITE_UNKNOWN", `远端 ${relative} 的内容与本地一致，但云盘尚未解除上次未知写入的锁定；本地已保留，稍后可重试 workspace_sync。`);
    }
    await this.#registerFile(sessionId, relative, { sha256: local.sha256, remoteId: receipt.remoteId, size: local.size });
    return { path: relative, sha256: local.sha256, remoteId: receipt.remoteId, bytes: local.size, reconciled: true };
  }
  #unconfirmed(failed) {
    return {
      mode: "cloud",
      state: "unconfirmed",
      code: failed[0]?.code || "CLOUD_SYNC_FAILED",
      message: `本地已完成写入，但云盘保存未确认（${failed.map((item) => item.path).join("、")}）；本地文件已保留，可调用 workspace_sync 重试。`,
      files: [],
      failed,
    };
  }
  async #writeOperation(sessionId, action, artifacts) {
    return workspaceIO(async () => {
      const storage = await this.#requireReady();
      const accountId = storage.scope.accountId;
      await this.#bind(sessionId, accountId);
      await this.#localRoot(sessionId, { create: true });
      this.#nested.add(sessionId);
      try {
        const result = await action();
        const paths = artifacts(result).filter((relative) => typeof relative === "string" && relative && relative !== ".");
        const synced = [];
        const failed = [];
        for (const relative of paths) {
          if (isRuntimeFile(relative)) continue;
          try {
            synced.push(await this.#pushFile(sessionId, relative, accountId));
          } catch (error) {
            failed.push({ path: relative, code: errorCode(error?.code) || "CLOUD_SYNC_FAILED", message: errorMessage(error?.message) || "云盘保存未确认。" });
          }
        }
        await this.#verifyIdentity(sessionId, accountId);
        const provenance = failed.length
          ? this.#unconfirmed(failed)
          : { mode: "cloud", state: "synced", files: synced, checkedAt: new Date().toISOString() };
        return { ...result, storage: provenance };
      } finally {
        this.#nested.delete(sessionId);
      }
    });
  }
  async writeBytes(sessionId, args) {
    if (this.#nested.has(sessionId)) return WorkspaceFiles.prototype.writeBytes.call(this, sessionId, args);
    return this.#writeOperation(sessionId, () => WorkspaceFiles.prototype.writeBytes.call(this, sessionId, args), (result) => [result.path]);
  }
  async write(sessionId, args = {}) {
    return this.#writeOperation(sessionId, () => WorkspaceFiles.prototype.write.call(this, sessionId, args), (result) => [result.path]);
  }
  /** 隔离运行器的冻结脚本写入：只落本地缓存，不建帐本、不上传。 */
  async writeRuntimeBytes(sessionId, args = {}) {
    return workspaceIO(async () => {
      const storage = await this.#requireReady();
      await this.#bind(sessionId, storage.scope.accountId);
      await this.#localRoot(sessionId, { create: true });
      return WorkspaceFiles.prototype.writeBytes.call(this, sessionId, args);
    });
  }
  async importFile(sessionId, args = {}, context = {}) {
    return this.#writeOperation(sessionId, () => WorkspaceFiles.prototype.importFile.call(this, sessionId, args, context), (result) => [result.path]);
  }
  async zip(sessionId, args = {}) {
    return this.#writeOperation(sessionId, () => WorkspaceFiles.prototype.zip.call(this, sessionId, args), (result) => {
      if (Array.isArray(result?.files)) return result.files.map((item) => item.path);
      // ZIP 的 list 动作只读归档，不产生任何云端写入。
      if (Array.isArray(result?.entries)) return [];
      return [result?.path];
    });
  }

  // ---------------------------------------------------------------- 运行前有界恢复

  /**
   * 审批前把云端会话文件有界恢复到本地缓存，供隔离运行读取（审批后不再重新拉取）。
   * 本地有未保存改动时不覆盖；只有本地干净且云端 revision 变化才安全更新。
   */
  async prepareRuntime(sessionId) {
    const storage = await this.#requireReady();
    const accountId = storage.scope.accountId;
    await this.#bind(sessionId, accountId);
    await this.#localRoot(sessionId, { create: true });
    const reply = await this.#call(CLOUD.list, { accountId, sessionId, path: ".", recursive: true });
    if (!reply.ok) throw this.#replyError(reply.error, "CLOUD_LIST_FAILED", "未能读取云盘会话文件，无法准备运行环境。");
    const remote = this.#remoteMap(this.#entriesOf(reply));
    if (remote.size > this.#limits.maxFiles)
      throw fail("CLOUD_SYNC_LIMIT", `云盘会话文件超过 ${this.#limits.maxFiles} 个，未准备运行环境。`);
    const pulled = [];
    const keptDirty = [];
    let total = 0;
    for (const [relative, entry] of remote) {
      if (isRuntimeFile(relative)) continue;
      let safe;
      try {
        safe = relativePath(relative, { allowRoot: false });
      } catch {
        throw fail("CLOUD_INVALID_REMOTE", `云盘返回了非法路径 ${relative}，未准备运行环境。`);
      }
      const limit = this.#limitFor(safe);
      const expectedSize = Number.isFinite(entry.size) ? entry.size : 0;
      if (expectedSize > limit) throw fail("CLOUD_SYNC_LIMIT", `云端文件 ${safe} 超过单文件限额，未准备运行环境。`);
      total += expectedSize;
      if (total > this.#limits.maxTotalBytes) throw fail("CLOUD_SYNC_LIMIT", "云端会话文件总大小超过准备限额，未准备运行环境。");
      const absolute = await this.resolve(sessionId, safe, { mustExist: false });
      const existing = await lstat(absolute).catch(() => null);
      if (!existing) {
        const record = await this.#pullFile(sessionId, safe, accountId);
        pulled.push({ path: safe, bytes: record.bytes, remoteId: record.remoteId });
        continue;
      }
      if (!existing.isFile()) throw fail("NOT_FILE", `云端文件 ${safe} 与本地目录冲突，未准备运行环境。`);
      const known = await this.#readJournal((data) => data.sessions[sessionId]?.files?.[safe]);
      const local = await fileDigest(absolute, limit);
      if (known?.sha256 !== local.sha256) {
        keptDirty.push({ path: safe, reason: "local-dirty" });
        continue;
      }
      if (known.remoteId === entry.remoteId) continue;
      // 走到这里说明本地干净（哈希与上次保存一致）且云端 revision 已更新，覆盖是安全的。
      const record = await this.#pullFile(sessionId, safe, accountId, { overwrite: true });
      pulled.push({ path: safe, bytes: record.bytes, remoteId: record.remoteId });
    }
    await this.#verifyIdentity(sessionId, accountId);
    const result = {
      mode: "cloud",
      state: keptDirty.length ? "unconfirmed" : "ready",
      accountId,
      files: remote.size,
      pulled,
      keptDirty,
      checkedAt: new Date().toISOString(),
    };
    if (keptDirty.length) {
      result.code = "CLOUD_LOCAL_DIRTY";
      result.message = `有 ${keptDirty.length} 个本地文件尚未保存到云盘，已保留本地内容，准备阶段没有覆盖。`;
    }
    return result;
  }

  // ---------------------------------------------------------------- 全量同步

  /** B 契约要求 complete:true 且 entries 是数组；不完整回执不能当作“已核对为空”。 */
  #entriesOf(reply) {
    const data = reply?.data;
    if (!data || data.complete !== true || !Array.isArray(data.entries))
      throw fail("CLOUD_LIST_INCOMPLETE", "云盘目录回执不完整（需要 complete:true 与 entries 数组），未按已核对处理。");
    return data.entries;
  }
  #remoteMap(entries) {
    const map = new Map();
    for (const entry of Array.isArray(entries) ? entries : []) {
      if (!entry || typeof entry.path !== "string") continue;
      const relative = entry.path.replaceAll("\\", "/").replace(/^\.?\//, "");
      if (!relative || relative === ".") continue;
      const type = entry.type === "directory" ? "dir" : entry.type;
      if (type !== "file") continue;
      map.set(relative, {
        remoteId: typeof entry.remoteId === "string" ? entry.remoteId : "",
        size: Number.isFinite(Number(entry.size)) ? Number(entry.size) : null,
      });
    }
    return map;
  }
  async #scanSession(sessionId) {
    const files = [];
    let total = 0;
    const walk = async (relative) => {
      const absolute = await this.resolve(sessionId, relative);
      const names = (await readdir(absolute)).sort();
      for (const name of names) {
        const child = relative === "." ? name : `${relative}/${name}`;
        if (isRuntimeFile(child)) continue;
        const childAbsolute = await this.resolve(sessionId, child);
        const info = await lstat(childAbsolute);
        if (info.isSymbolicLink()) throw fail("SYMLINK_REJECTED", "工作区含符号链接或目录联接，未同步。");
        if (info.isDirectory()) {
          await walk(child);
          continue;
        }
        if (!info.isFile()) throw fail("NOT_FILE", "工作区含非普通文件条目，未同步。");
        if (info.size > this.#limitFor(child))
          throw fail("CLOUD_SYNC_LIMIT", `文件 ${child} 超过单文件同步限额，未同步。`);
        total += info.size;
        files.push({ path: child, absolute: childAbsolute, size: info.size });
        if (files.length > this.#limits.maxFiles)
          throw fail("CLOUD_SYNC_LIMIT", `文件数量超过 ${this.#limits.maxFiles} 个，未同步。`);
        if (total > this.#limits.maxTotalBytes)
          throw fail("CLOUD_SYNC_LIMIT", "工作区文件总大小超过同步限额，未同步。");
      }
    };
    await walk(".");
    return { files, totalBytes: total };
  }
  async sync(sessionId) {
    const storage = await this.#requireReady();
    const accountId = storage.scope.accountId;
    await this.#bind(sessionId, accountId);
    await this.#localRoot(sessionId, { create: true });
    const scanned = await this.#scanSession(sessionId);
    const checkedAt = new Date().toISOString();
    // 即使本地一个文件都没有，也必须拿完整回执再计算 remoteOnly；不完整回执不能宣称“已核对”。
    const reply = await this.#call(CLOUD.list, { accountId, sessionId, path: ".", recursive: true });
    if (!reply.ok) throw this.#replyError(reply.error, "CLOUD_LIST_FAILED", "未能读取云盘工作区列表，未上传任何文件，本地保留。");
    const remote = this.#remoteMap(this.#entriesOf(reply));
    if (!scanned.files.length)
      return { mode: "cloud", state: "synced", sessionId, files: 0, uploaded: [], skipped: [], remoteOnly: remote.size, checkedAt };
    const uploaded = [];
    const skipped = [];
    const conflicts = [];
    const changed = [];
    for (const file of scanned.files) {
      const known = await this.#readJournal((data) => data.sessions[sessionId]?.files?.[file.path]);
      const local = await fileDigest(file.absolute, this.#limitFor(file.path));
      const entry = remote.get(file.path);
      if (known?.sha256 === local.sha256 && typeof known.remoteId === "string") {
        // 云端已经没有这个文件（或 remoteId 不可用）时不能算“已保存”：可能是被外部删除。
        if (!entry || !entry.remoteId) {
          changed.push({ path: file.path, reason: "remote-missing", expected: known.remoteId });
          continue;
        }
        if (entry.remoteId !== known.remoteId) {
          changed.push({ path: file.path, remoteId: entry.remoteId, expected: known.remoteId });
          continue;
        }
        skipped.push({ path: file.path, reason: "unchanged" });
        continue;
      }
      if (entry && (!known?.remoteId || known.remoteId !== (entry.remoteId || ""))) {
        conflicts.push({
          path: file.path,
          code: "CLOUD_CONFLICT",
          message: "云盘上的版本与上次保存不同，本地也有改动，未覆盖任何一侧。",
        });
        continue;
      }
      try {
        uploaded.push(await this.#pushFile(sessionId, file.path, accountId, { remote: entry }));
      } catch (error) {
        conflicts.push({ path: file.path, code: errorCode(error?.code) || "CLOUD_SYNC_FAILED", message: errorMessage(error?.message) || "云盘保存未确认。" });
      }
    }
    if (conflicts.length) {
      const error = fail("CLOUD_CONFLICT", `有 ${conflicts.length} 个文件未保存到云盘（首个：${conflicts[0].path}）；本地文件全部保留，请先核对冲突再重试。`);
      error.conflicts = conflicts;
      throw error;
    }
    if (changed.length) {
      const error = fail("CLOUD_REMOTE_CHANGED", `有 ${changed.length} 个文件在云端已被更新或删除（首个：${changed[0].path}），本地未改动也未覆盖云端；请先拉取核对。`);
      error.changed = changed;
      throw error;
    }
    const localPaths = new Set(scanned.files.map((file) => file.path));
    const remoteOnly = [...remote.keys()].filter((relative) => !localPaths.has(relative)).length;
    await this.#verifyIdentity(sessionId, accountId);
    return { mode: "cloud", state: "synced", sessionId, files: scanned.files.length, uploaded, skipped, remoteOnly, checkedAt };
  }
}