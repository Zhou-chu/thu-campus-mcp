import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { validSessionId } from "./sessions.mjs";
import { WorkspaceFiles } from "./workspace-files.mjs";
import { SandboxRunner } from "./sandbox.mjs";

const text = (description, extra = {}) => ({ type: "string", description, ...extra });
function tool(name, description, properties, required = [], options = {}) {
  return { name, description, service: "workspace", readOnly: true, destructive: false, ...options,
    inputSchema: { type: "object", properties, required, additionalProperties: false } };
}
const relativePath = text("当前会话工作区内的相对路径；不是宿主机绝对路径");
export const WORKSPACE_TOOLS = [
  tool("workspace_status", "查询本会话工作区与真正隔离的Python/Node容器是否就绪；不可用时不回退宿主机。", {}),
  tool("workspace_list", "列出当前会话工作区文件；文件回执含可下载地址和实际绝对路径。", { path: relativePath }),
  tool("workspace_read", "分页读取工作区文本、CSV、JSON或ipynb源码。ZIP先用workspace_zip列出和解压；PDF/Office/二进制用隔离脚本解析，不能假读。", {
    path: relativePath, offset: { type: "integer", minimum: 0 }, maxChars: { type: "integer", minimum: 1, maximum: 60000 },
  }, ["path"]),
  tool("workspace_import", "将已下载的宿主机单个附件复制进本会话工作区；必须由用户确认精确源路径。找到路径不等于读过文件。", {
    sourcePath: text("已定位附件的宿主机绝对路径"), path: relativePath,
  }, ["sourcePath", "path"], { readOnly: false, destructive: true, mandatoryApproval: true }),
  tool("workspace_write", "在当前工作区写UTF-8文本/代码/HTML；默认不覆盖。覆盖已有文件需单独确认。只写代码不等于执行成功。", {
    path: relativePath, text: text("完整文件内容"), overwrite: { type: "boolean", default: false },
  }, ["path", "text"], { readOnly: false }),
  tool("workspace_zip", "安全列出、解压或打包当前工作区ZIP。extract写新目录；create的files是文件/目录相对路径数组，不是通配符。不覆盖已有产物。", {
    action: { type: "string", enum: ["list", "extract", "create"] }, path: relativePath,
    destination: relativePath, files: { type: "array", items: relativePath, minItems: 1, maxItems: 1000 },
  }, ["action", "path"], { readOnly: false }),
  tool("workspace_run", "在真正隔离、禁网络、只挂本会话工作区的容器中运行现有Python/Node脚本；确认卡展示完整冻结脚本。返回后台job不代表计算成功。缺少Docker/镜像时明确不可运行，禁止宿主机回退。", {
    runtime: { type: "string", enum: ["python", "node"] }, scriptPath: relativePath,
    args: { type: "array", items: { type: "string" }, maxItems: 64 },
    timeoutSeconds: { type: "integer", minimum: 1, maximum: 3600, default: 120 },
  }, ["runtime", "scriptPath"], { readOnly: false, destructive: true, mandatoryApproval: true }),
  tool("workspace_job", "读取本会话后台代码任务真实状态、退出码与输出；running不是成功。可长轮询最多10秒，避免连续空转。", {
    jobId: text("workspace_run返回的jobId"), waitSeconds: { type: "integer", minimum: 0, maximum: 10, default: 3 },
  }, ["jobId"]),
  tool("workspace_stop", "停止当前会话的精确容器作业；不触碰其他会话或其他Docker容器。", { jobId: text("任务jobId") }, ["jobId"], { readOnly: false }),
];
function validateArgs(name, args) {
  const spec = WORKSPACE_TOOLS.find(tool => tool.name === name);
  if (!spec) throw invalid("没有此工作区工具。", "UNKNOWN_TOOL");
  if (!args || typeof args !== "object" || Array.isArray(args)) throw invalid("工具参数必须是对象。");
  if (Object.keys(args).some(key => !Object.hasOwn(spec.inputSchema.properties, key)) || spec.inputSchema.required.some(key => !Object.hasOwn(args, key)))
    throw invalid("工具参数包含未声明字段或缺少必填字段。");
}
function failure(error) {
  return { ok: false, error: {
    code: /^[A-Z_]+$/.test(error?.code || "") ? error.code : "WORKSPACE_FAILED",
    message: error?.message || "工作区操作失败。",
  } };
}
function invalid(message, code = "INVALID_ARGUMENTS") { return Object.assign(new Error(message), { code }); }
export function workspaceJobUrl(sessionId, jobId) {
  return `/api/workspaces/${encodeURIComponent(sessionId)}/jobs/${encodeURIComponent(jobId)}`;
}
/** Compose local capabilities with campus MCP without granting them a host shell. */
export class WorkspaceHost {
  constructor({ host, files, sandbox }) {
    this.host = host;
    this.workspaceFiles = files;
    this.sandbox = sandbox;
    this.closed = false;
  }
  describe() { return [...this.host.describe(), ...WORKSPACE_TOOLS]; }
  toolForModel() {
    return [...this.host.toolForModel(), ...WORKSPACE_TOOLS.map(({ name, description, inputSchema }) => ({
      type: "function", function: { name, description, parameters: inputSchema },
    }))];
  }
  async prepareCall(name, args = {}, { sessionId } = {}) {
    if (typeof name !== "string" || !name.startsWith("workspace_")) return undefined;
    validateArgs(name, args);
    if (!validSessionId(sessionId)) throw invalid("工作区操作必须绑定有效会话。", "INVALID_SESSION");
    if (name === "workspace_import") {
      if (typeof args.sourcePath !== "string" || !path.isAbsolute(args.sourcePath)) throw invalid("导入源必须是宿主机绝对路径。");
      const sourcePath = path.resolve(args.sourcePath);
      return { kind: "import", sourcePath, binding: JSON.stringify(args), mandatoryApproval: true,
        approvalArgs: { sourcePath, destination: args.path },
        risk: "将确认的这一个本机附件复制到当前会话工作区；附件会交给模型或隔离脚本读取。不会授予其他宿主路径。" };
    }
    if (name === "workspace_run") {
      const prepared = await this.sandbox.prepare(sessionId, args);
      return { kind: "run", runtimePrepared: prepared, mandatoryApproval: true,
        approvalArgs: prepared.approvalArgs,
        risk: "将在真正隔离的容器中执行下方完整脚本：禁网络、只挂当前会话工作区、容器根目录只读。脚本可修改工作区文件；不会自动提交校园数据。" };
    }
    if (name === "workspace_write" && args.overwrite === true) return {
      kind: "overwrite", binding: JSON.stringify(args), mandatoryApproval: true, approvalArgs: args,
      risk: "将覆盖当前会话工作区中指定文件，请核对路径与完整新内容。",
    };
    return undefined;
  }
  async artifact(sessionId, item) {
    if (!item || typeof item !== "object" || typeof item.path !== "string" || item.type === "directory") return item;
    const absolutePath = await this.workspaceFiles.resolve(sessionId, item.path);
    return { ...item, absolutePath, downloadUrl: `/api/workspaces/${sessionId}/files?path=${encodeURIComponent(item.path)}` };
  }
  job(sessionId, job) { return { ...job, statusUrl: workspaceJobUrl(sessionId, job.jobId) }; }
  async call(name, args = {}, context = {}) {
    if (typeof name !== "string" || !/^[a-z][a-z0-9_]{2,63}$/.test(name)) return failure(invalid("工具名不合法。", "INVALID_TOOL"));
    if (!name.startsWith("workspace_")) return this.host.call(name, args);
    try {
      const { sessionId, prepared, approved = false } = context;
      validateArgs(name, args);
      if (!validSessionId(sessionId)) throw invalid("请从有效会话调用工作区工具。", "INVALID_SESSION");
      if (prepared?.error) return { ok: false, error: prepared.error };
      let data;
      switch (name) {
        case "workspace_status":
          data = { directory: await this.workspaceFiles.root(sessionId), sandbox: await this.sandbox.status(),
            policy: "只有隔离容器执行，不提供宿主机shell；程序提交、退出成功和产物生成必须分别核实。" };
          break;
        case "workspace_list": {
          const result = await this.workspaceFiles.list(sessionId, args);
          data = { ...result, entries: await Promise.all(result.entries.map(item => this.artifact(sessionId, item))) };
          break;
        }
        case "workspace_read": data = await this.workspaceFiles.read(sessionId, args); break;
        case "workspace_import":
          if (approved !== true || prepared?.kind !== "import" || prepared.binding !== JSON.stringify(args) || prepared.sourcePath !== path.resolve(args.sourcePath))
            throw invalid("导入本机附件必须逐次确认精确源路径。", "APPROVAL_REQUIRED");
          data = await this.artifact(sessionId, await this.workspaceFiles.importFile(sessionId, args, { approvedSourcePath: prepared.sourcePath }));
          break;
        case "workspace_write":
          if (args.overwrite === true && (approved !== true || prepared?.kind !== "overwrite" || prepared.binding !== JSON.stringify(args))) throw invalid("覆盖已有文件必须确认。", "APPROVAL_REQUIRED");
          data = await this.artifact(sessionId, await this.workspaceFiles.write(sessionId, args)); break;
        case "workspace_zip": data = await this.artifact(sessionId, await this.workspaceFiles.zip(sessionId, args)); break;
        case "workspace_run":
          if (approved !== true || prepared?.kind !== "run") throw invalid("运行脚本必须逐次确认完整冻结内容。", "APPROVAL_REQUIRED");
          data = this.job(sessionId, await this.sandbox.run(sessionId, args, { prepared: prepared.runtimePrepared, approved: true }));
          break;
        case "workspace_job": {
          const seconds = args.waitSeconds ?? 3;
          if (!Number.isInteger(seconds) || seconds < 0 || seconds > 10) throw invalid("waitSeconds必须为0–10的整数。");
          let job = await this.sandbox.get(sessionId, args.jobId);
          if (job.state === "running" && seconds) {
            await delay(seconds * 1000, undefined, { signal: context.signal });
            job = await this.sandbox.get(sessionId, args.jobId);
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
    try { await this.sandbox.close(); } finally { await this.host.close(); }
  }
}
export function createWorkspaceHost({ host, stateDir, pythonImage, nodeImage }) {
  const files = new WorkspaceFiles({ baseDir: path.join(stateDir, "workspaces") });
  return new WorkspaceHost({ host, files, sandbox: new SandboxRunner({ files, stateDir: path.join(stateDir, "sandbox-jobs"), pythonImage, nodeImage }) });
}
