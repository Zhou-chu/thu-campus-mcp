import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { validSessionId } from "./sessions.mjs";
import { WorkspaceFiles } from "./workspace-files.mjs";
import { CloudWorkspaceFiles } from "./cloud-workspace.mjs";
import { SandboxRunner } from "./sandbox.mjs";

const text = (description, extra = {}) => ({ type: "string", description, ...extra });
function tool(name, description, properties, required = [], options = {}) {
  return { name, description, service: "workspace", readOnly: true, destructive: false, ...options,
    inputSchema: { type: "object", properties, required, additionalProperties: false } };
}
const relativePath = text("当前会话工作区内的相对路径；不是宿主机绝对路径");
export const WORKSPACE_TOOLS = [
  tool("workspace_status", "查询默认云盘私有工作区与真正隔离的Python/Node容器状态；配置/目录存在不代表已登录或已同步。", {}),
  tool("workspace_initialize", "初始化清华云盘个人默认资料库的全私有Agent工作区。固定目录、在线身份和私有权限必须先核验；确认精确范围后才创建，不选共享库、不改分享权限。", {}, [], { readOnly: false, destructive: true, mandatoryApproval: true }),
  tool("workspace_sync", "将本会话有界文件同步到已授权的云盘私有工作区，或对未知写入先只读对账；冲突不盲目覆盖。运行中作业结束后自动同步，失败可用此工具重试。", {}, [], { readOnly: false }),
  tool("workspace_list", "列出当前会话工作区文件；回执区分云盘和离线缓存，文件含已认证下载地址。", { path: relativePath }),
  tool("workspace_read", "分页读取工作区文本、CSV、JSON或ipynb源码。ZIP先列出和解压；PDF/Office/二进制用隔离脚本解析，离线缓存不冒充最新云端。", {
    path: relativePath, offset: { type: "integer", minimum: 0 }, maxChars: { type: "integer", minimum: 1, maximum: 60000 },
  }, ["path"]),
  tool("workspace_import", "将已下载的宿主机单个附件导入当前会话，并保存至已授权的云盘私有工作区；必须确认精确源路径，不能仅找到路径就声称已读取。", {
    sourcePath: text("已定位附件的宿主机绝对路径"), path: relativePath,
  }, ["sourcePath", "path"], { readOnly: false, destructive: true, mandatoryApproval: true }),
  tool("workspace_write", "写UTF-8文本/代码并保存到当前私有工作区；默认不覆盖，覆盖需确认。云盘失败时明确本地已写但未确认云保存，不自动退回本地模式。", {
    path: relativePath, text: text("完整文件内容"), overwrite: { type: "boolean", default: false },
  }, ["path", "text"], { readOnly: false }),
  tool("workspace_zip", "安全列出、解压或打包当前工作区ZIP，新产物同步到授权私有目录。不覆盖已有产物，files是相对路径数组，不是通配符。", {
    action: { type: "string", enum: ["list", "extract", "create"] }, path: relativePath,
    destination: relativePath, files: { type: "array", items: relativePath, minItems: 1, maxItems: 1000 },
  }, ["action", "path"], { readOnly: false }),
  tool("workspace_run", "在真正隔离、禁网、只挂当前会话缓存的容器中执行冻结脚本，云盘令牌不进入容器；用户确认完整脚本后提交后台job，结束后另核验云盘同步，禁止宿主机回退。", {
    runtime: { type: "string", enum: ["python", "node"] }, scriptPath: relativePath,
    args: { type: "array", items: { type: "string" }, maxItems: 64 },
    timeoutSeconds: { type: "integer", minimum: 1, maximum: 3600, default: 120 },
  }, ["runtime", "scriptPath"], { readOnly: false, destructive: true, mandatoryApproval: true }),
  tool("workspace_job", "读取本会话作业真实状态/退出码/日志和独立云盘同步状态；计算成功不等于云盘已保存，长轮询最多10秒。", {
    jobId: text("workspace_run返回的jobId"), waitSeconds: { type: "integer", minimum: 0, maximum: 10, default: 3 },
  }, ["jobId"]),
  tool("workspace_stop", "停止当前会话的精确容器作业；不触碰其他会话/其他Docker容器，停止后仍核验已有产物同步。", { jobId: text("任务jobId") }, ["jobId"], { readOnly: false }),
];
function validateArgs(name, args) {
  const spec = WORKSPACE_TOOLS.find(item => item.name === name);
  if (!spec) throw invalid("没有此工作区工具。", "UNKNOWN_TOOL");
  if (!args || typeof args !== "object" || Array.isArray(args)) throw invalid("工具参数必须是对象。");
  if (Object.keys(args).some(key => !Object.hasOwn(spec.inputSchema.properties, key)) || spec.inputSchema.required.some(key => !Object.hasOwn(args, key)))
    throw invalid("工具参数包含未声明字段或缺少必填字段。");
}
function failure(error) {
  return { ok: false, error: { code: /^[A-Z_]+$/.test(error?.code || "") ? error.code : "WORKSPACE_FAILED", message: error?.message || "工作区操作失败。" } };
}
function invalid(message, code = "INVALID_ARGUMENTS") { return Object.assign(new Error(message), { code }); }
function internal(name) { return typeof name === "string" && name.startsWith("cloud_workspace_"); }
export function workspaceJobUrl(sessionId, jobId) { return `/api/workspaces/${encodeURIComponent(sessionId)}/jobs/${encodeURIComponent(jobId)}`; }

/** Cloud persistence is outside the container; only the session's local cache is mounted. */
export class WorkspaceHost {
  constructor({ host, files, sandbox }) {
    this.host = host; this.workspaceFiles = files; this.sandbox = sandbox; this.closed = false;
    this.cloud = typeof files.initialize === "function" && typeof files.status === "function";
    this.jobs = new Map(); this.syncStates = new Map(); this.generations = new Map(); this.syncTasks = new Map();
    this.unsubscribe = sandbox.onComplete?.(({ sessionId, job }) => {
      if (!this.cloud) return;
      this.jobs.set(`${sessionId}:${job.jobId}`, { sessionId, ...job });
      this.changed(sessionId);
      return this.syncSession(sessionId, { automatic: true });
    });
  }
  describe() { return [...this.host.describe().filter(item => !internal(item.name)), ...WORKSPACE_TOOLS]; }
  toolForModel() {
    return [...this.host.toolForModel().filter(item => !internal(item.function?.name)), ...WORKSPACE_TOOLS.map(({ name, description, inputSchema }) => ({
      type: "function", function: { name, description, parameters: inputSchema },
    }))];
  }
  async storageStatus() {
    return this.cloud ? this.workspaceFiles.status() : { mode: "local", state: "ready", message: "显式本地工作区，不同步云盘。" };
  }
  async prepareCall(name, args = {}, { sessionId } = {}) {
    if (typeof name !== "string" || !name.startsWith("workspace_")) return undefined;
    validateArgs(name, args);
    if (!validSessionId(sessionId)) throw invalid("工作区操作必须绑定有效会话。", "INVALID_SESSION");
    if (name === "workspace_initialize") {
      if (!this.cloud) throw invalid("当前明确使用本地模式，无云盘初始化。", "CLOUD_NOT_ENABLED");
      const storagePrepared = await this.workspaceFiles.prepareInitialization();
      return { kind: "initialize", storagePrepared, mandatoryApproval: true, approvalArgs: storagePrepared.approvalArgs, risk: storagePrepared.risk };
    }
    if (name === "workspace_import") {
      if (typeof args.sourcePath !== "string" || !path.isAbsolute(args.sourcePath)) throw invalid("导入源必须是宿主机绝对路径。");
      const sourcePath = path.resolve(args.sourcePath);
      return { kind: "import", sourcePath, binding: JSON.stringify(args), mandatoryApproval: true,
        approvalArgs: { sourcePath, destination: args.path, storage: await this.storageStatus() },
        risk: `将这一个本机附件（精确源路径）复制到当前会话${this.cloud ? "并保存至已授权的私有云盘" : "的本地工作区，不上传云盘"}，供模型或隔离脚本读取；不授予其他宿主路径，不创建公开链接。` };
    }
    if (name === "workspace_run") {
      const prepared = await this.sandbox.prepare(sessionId, args);
      return { kind: "run", runtimePrepared: prepared, mandatoryApproval: true,
        approvalArgs: { ...prepared.approvalArgs, storage: await this.storageStatus() },
        risk: `将在真正隔离的容器中执行完整冻结脚本，禁网、根只读，只挂当前会话缓存；云盘令牌不进容器。脚本可修改工作区，${this.cloud ? "结束后另核验私有云盘同步" : "本地模式不上传云盘"}，校园提交仍需单独确认。` };
    }
    if (name === "workspace_write" && args.overwrite === true) return {
      kind: "overwrite", binding: JSON.stringify(args), mandatoryApproval: true, approvalArgs: args,
      risk: "将覆盖当前会话指定文件并更新授权私有工作区；云盘仅作前置版本冲突检查，没有服务端原子CAS保证。请核对路径与完整新内容。",
    };
    return undefined;
  }
  async artifact(sessionId, item) {
    if (!item || typeof item !== "object" || typeof item.path !== "string" || item.type === "directory") return item;
    return { ...item, absolutePath: await this.workspaceFiles.resolve(sessionId, item.path), downloadUrl: `/api/workspaces/${sessionId}/files?path=${encodeURIComponent(item.path)}` };
  }
  changed(sessionId) {
    this.generations.set(sessionId, (this.generations.get(sessionId) || 0) + 1);
    this.syncStates.set(sessionId, { mode: "cloud", state: "pending", message: "等待作业结束并核验云盘保存。" });
  }
  active(sessionId) { return this.sandbox.hasActiveJobs?.(sessionId) === true || [...this.jobs.values()].some(job => job.sessionId === sessionId && job.state === "running"); }
  syncSession(sessionId, { automatic = false } = {}) {
    if (!this.cloud) return Promise.reject(invalid("当前明确使用本地模式。", "CLOUD_NOT_ENABLED"));
    if (this.active(sessionId)) {
      if (automatic) return Promise.resolve(this.syncStates.get(sessionId));
      return Promise.reject(invalid("当前会话仍有运行中作业，结束后自动同步。", "WORKSPACE_BUSY"));
    }
    if (this.syncTasks.has(sessionId)) return this.syncTasks.get(sessionId);
    const task = (async () => {
      this.syncStates.set(sessionId, { mode: "cloud", state: "pending", message: "正在保存私有云盘工作区。" });
      await this.sandbox.initialize?.();
      if (this.active(sessionId)) throw invalid("仍有运行或回收未确认的容器，暂不上传其缓存。", "WORKSPACE_BUSY");
      for (;;) {
        const generation = this.generations.get(sessionId) || 0;
        const receipt = await this.workspaceFiles.sync(sessionId);
        if (receipt?.mode !== "cloud" || receipt.state !== "synced") throw invalid("云盘同步未返回已核验成功回执。", "CLOUD_SYNC_UNVERIFIED");
        if (this.active(sessionId)) return this.syncStates.get(sessionId);
        if (generation !== (this.generations.get(sessionId) || 0)) continue;
        const state = { ...receipt, mode: "cloud", state: "synced", checkedAt: new Date().toISOString() };
        this.syncStates.set(sessionId, state);
        return state;
      }
    })().catch(error => {
      this.syncStates.set(sessionId, { mode: "cloud", state: "failed", code: /^[A-Z_]+$/.test(error?.code || "") ? error.code : "CLOUD_SYNC_FAILED", message: error?.message || "本地结果保留，但云盘保存未确认；可重试workspace_sync。" });
      if (!automatic) throw error;
      return this.syncStates.get(sessionId);
    }).finally(() => this.syncTasks.delete(sessionId));
    this.syncTasks.set(sessionId, task);
    return task;
  }
  job(sessionId, job) {
    if (!this.cloud) return { ...job, statusUrl: workspaceJobUrl(sessionId, job.jobId) };
    const storage = job.cleanupPending === true && job.state !== "running"
      ? { mode: "cloud", state: "failed", code: "SANDBOX_CLEANUP_PENDING", message: "容器回收未确认，暂不上传缓存；请先重试停止。" }
      : this.syncStates.get(sessionId) || { mode: "cloud", state: job.state === "running" ? "pending" : "failed", code: "SYNC_UNVERIFIED", message: "恢复后尚未核验云盘保存；可调用workspace_sync。" };
    return { ...job, storage, statusUrl: workspaceJobUrl(sessionId, job.jobId) };
  }
  async call(name, args = {}, context = {}) {
    if (typeof name !== "string" || !/^[a-z][a-z0-9_]{2,63}$/.test(name)) return failure(invalid("工具名不合法。", "INVALID_TOOL"));
    if (internal(name)) return failure(invalid("私有存储内部能力不能绕过工作区授权。", "WORKSPACE_INTERNAL_ONLY"));
    if (!name.startsWith("workspace_")) return this.host.call(name, args);
    try {
      const { sessionId, prepared, approved = false } = context;
      validateArgs(name, args);
      if (!validSessionId(sessionId)) throw invalid("请从有效会话调用工作区工具。", "INVALID_SESSION");
      if (prepared?.error) return { ok: false, error: prepared.error };
      let data;
      switch (name) {
        case "workspace_status": {
          const storage = await this.storageStatus();
          data = { storage, sandbox: await this.sandbox.status(), policy: "只有隔离容器执行，不提供宿主机shell；计算成功、云盘保存、产物和校园提交分别核实。" };
          if (storage.state === "ready") data.directory = await this.workspaceFiles.root(sessionId);
          break;
        }
        case "workspace_initialize":
          if (!this.cloud || approved !== true || prepared?.kind !== "initialize") throw invalid("云盘私有工作区初始化必须确认精确范围。", "APPROVAL_REQUIRED");
          data = await this.workspaceFiles.initialize({ prepared: prepared.storagePrepared, approved: true }); break;
        case "workspace_sync": data = await this.syncSession(sessionId); break;
        case "workspace_list": {
          const result = await this.workspaceFiles.list(sessionId, args);
          data = { ...result, entries: await Promise.all(result.entries.map(item => this.artifact(sessionId, item))) }; break;
        }
        case "workspace_read": data = await this.workspaceFiles.read(sessionId, args); break;
        case "workspace_import":
          if (approved !== true || prepared?.kind !== "import" || prepared.binding !== JSON.stringify(args) || prepared.sourcePath !== path.resolve(args.sourcePath)) throw invalid("导入本机附件必须逐次确认精确源路径。", "APPROVAL_REQUIRED");
          data = await this.artifact(sessionId, await this.workspaceFiles.importFile(sessionId, args, { approvedSourcePath: prepared.sourcePath })); break;
        case "workspace_write":
          if (args.overwrite === true && (approved !== true || prepared?.kind !== "overwrite" || prepared.binding !== JSON.stringify(args))) throw invalid("覆盖已有文件必须确认。", "APPROVAL_REQUIRED");
          data = await this.artifact(sessionId, await this.workspaceFiles.write(sessionId, args)); break;
        case "workspace_zip": data = await this.artifact(sessionId, await this.workspaceFiles.zip(sessionId, args)); break;
        case "workspace_run": {
          if (approved !== true || prepared?.kind !== "run") throw invalid("运行脚本必须逐次确认完整冻结内容。", "APPROVAL_REQUIRED");
          const job = await this.sandbox.run(sessionId, args, { prepared: prepared.runtimePrepared, approved: true });
          if (this.cloud) {
            const key = `${sessionId}:${job.jobId}`;
            if (!this.jobs.has(key)) { this.jobs.set(key, { sessionId, ...job }); this.changed(sessionId); }
          }
          data = this.job(sessionId, job); break;
        }
        case "workspace_job": {
          const seconds = args.waitSeconds ?? 3;
          if (!Number.isInteger(seconds) || seconds < 0 || seconds > 10) throw invalid("waitSeconds必须为0–10的整数。");
          let job = await this.sandbox.get(sessionId, args.jobId);
          if ((job.state === "running" || this.job(sessionId, job).storage?.state === "pending") && seconds) {
            await delay(seconds * 1000, undefined, { signal: context.signal }); job = await this.sandbox.get(sessionId, args.jobId);
          }
          data = this.job(sessionId, job); break;
        }
        case "workspace_stop": data = this.job(sessionId, await this.sandbox.stop(sessionId, args.jobId)); break;
      }
      return { ok: true, data };
    } catch (error) { return failure(error); }
  }
  async close() {
    if (this.closed) return;
    this.closed = true;
    try { await this.sandbox.close(); await Promise.allSettled(this.syncTasks.values()); }
    finally { this.unsubscribe?.(); await this.host.close(); }
  }
}
export function createWorkspaceHost({ host, stateDir, pythonImage, nodeImage, storageMode = "cloud" }) {
  if (!["cloud", "local"].includes(storageMode)) throw invalid("工作区模式必须是cloud或local。", "INVALID_SETTINGS");
  const files = storageMode === "cloud" ? new CloudWorkspaceFiles({ host, stateDir }) : new WorkspaceFiles({ baseDir: path.join(stateDir, "workspaces") });
  return new WorkspaceHost({ host, files, sandbox: new SandboxRunner({ files, stateDir: path.join(stateDir, "sandbox-jobs"), pythonImage, nodeImage }) });
}
