import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { WorkspaceFiles } from "../lib/app/workspace-files.mjs";
import { SandboxRunner } from "../lib/app/sandbox.mjs";
import { WorkspaceHost } from "../lib/app/workspace.mjs";
import { SessionStore } from "../lib/app/sessions.mjs";
import { DeviceStore } from "../lib/app/devices.mjs";
import { PairingCodes } from "../lib/app/pairing.mjs";
import { createAppServer } from "../lib/app/server.mjs";

// Explicit live acceptance: no paid model, real campus data, host interpreter or automatic pull.
const dir = await mkdtemp(path.join(os.tmpdir(), "campus-sandbox-live-"));
const files = new WorkspaceFiles({ baseDir: path.join(dir, "workspaces") });
const sandbox = new SandboxRunner({ files, stateDir: path.join(dir, "sandbox-jobs") });
const host = new WorkspaceHost({ host: { describe: () => [], toolForModel: () => [], call: async () => ({ ok: true, data: {} }), close: async () => {} }, files, sandbox });
const sessions = new SessionStore(dir), { id: sessionId } = await sessions.create();
const sampleId = randomUUID();
let app, checks = 0;
const check = (condition, description) => { assert.ok(condition, description); console.log("✔ " + description); checks++; };
async function call(name, args, approve = false) {
  const prepared = await host.prepareCall(name, args, { sessionId });
  const result = await host.call(name, args, { sessionId, prepared, approved: approve });
  assert.equal(result.ok, true, JSON.stringify(result.error));
  return result.data;
}
async function finished(job) {
  const deadline = Date.now() + 120000;
  while (job.state === "running" && Date.now() < deadline) { await delay(250); job = await sandbox.get(sessionId, job.jobId); }
  assert.equal(job.state, "succeeded", JSON.stringify(job));
  return job;
}
try {
  const status = await sandbox.status();
  check(status.runtimes.python.available && status.runtimes.node.available && status.isolation.hostFallback === false, "两套本地镜像已就绪；没有宿主回退");
  await files.write(sampleId, { path: "points.csv", text: "x,y\n0,0\n0,1\n1,0\n10,10\n10,11\n11,10\n" });
  await files.zip(sampleId, { action: "create", path: "sample.zip", files: ["points.csv"] });
  const sourcePath = path.join(dir, "test-attachment.zip");
  await writeFile(sourcePath, await files.readBytes(sampleId, "sample.zip"));
  await call("workspace_import", { sourcePath, path: "input/sample.zip" }, true);
  check((await call("workspace_zip", { action: "list", path: "input/sample.zip" })).entries.some(item => item.path === "points.csv"), "确认后真正导入并列出ZIP附件");
  await call("workspace_zip", { action: "extract", path: "input/sample.zip", destination: "input/data" });
  check((await call("workspace_read", { path: "input/data/points.csv" })).text.includes("10,11"), "解压后读到实际CSV，而非只找到路径");
  await call("workspace_write", { path: "code/verify.py", text: `import os, json, socket, pathlib
import numpy as np
from sklearn.cluster import KMeans
import matplotlib.pyplot as plt
from reportlab.pdfgen import canvas
assert os.geteuid() != 0
assert not pathlib.Path('/var/run/docker.sock').exists()
assert 'THU_SANDBOX_LIVE_SECRET' not in os.environ
status = pathlib.Path('/proc/self/status').read_text()
assert 'NoNewPrivs:\\t1' in status
assert int(next(line.split()[1] for line in status.splitlines() if line.startswith('CapEff:')), 16) == 0
root_mount = next(line.split() for line in pathlib.Path('/proc/mounts').read_text().splitlines() if line.split()[1] == '/')
assert 'ro' in root_mount[3].split(',')
try:
    socket.create_connection(('1.1.1.1', 443), timeout=1)
except OSError:
    network_blocked = True
else:
    raise AssertionError('network must be blocked')
points = np.loadtxt('input/data/points.csv', delimiter=',', skiprows=1)
labels = KMeans(n_clusters=2, n_init=10, random_state=0).fit_predict(points)
assert len(set(labels)) == 2
plt.scatter(points[:,0], points[:,1], c=labels)
plt.savefig('clusters.png')
plt.close()
report = canvas.Canvas('report.pdf')
report.drawString(50, 790, 'Sandbox verification sample - NOT coursework')
report.drawString(50, 770, 'Six actual points; NumPy + sklearn KMeans, two clusters.')
report.save()
pathlib.Path('results.json').write_text(json.dumps({'rows': len(points), 'clusters': len(set(labels)), 'non_root': True, 'read_only_root': True, 'network_blocked': network_blocked, 'no_host_secret': True}))
print('actual computation and PDF completed', flush=True)
` });
  process.env.THU_SANDBOX_LIVE_SECRET = "must-not-enter-container";
  const pythonJob = await call("workspace_run", { runtime: "python", scriptPath: "code/verify.py", timeoutSeconds: 120 }, true);
  check(pythonJob.state === "running", "代码提交立即返回后台job，不伪报完成");
  const python = await finished(pythonJob);
  check(python.exitCode === 0 && python.stdout.includes("actual computation"), "真正容器中NumPy/sklearn计算与PDF生成成功");
  const result = JSON.parse((await call("workspace_read", { path: "results.json" })).text);
  check(result.non_root && result.read_only_root && result.network_blocked && result.no_host_secret, "实际验证非root、只读根、禁网与不传宿主秘密");
  check((await files.readBytes(sessionId, "report.pdf")).subarray(0, 4).toString() === "%PDF", "PDF是实际二进制文件");
  await call("workspace_write", { path: "helper.mjs", text: "export const value = 42;" });
  await call("workspace_write", { path: "probe.mjs", text: "import {writeFile} from 'node:fs/promises'; import {value} from './helper.mjs'; if(process.getuid()===0)throw Error('root'); await writeFile('node-result.json', JSON.stringify({value,args:process.argv.slice(2)})); console.log('node esm actual');" });
  await finished(await call("workspace_run", { runtime: "node", scriptPath: "probe.mjs", args: ["--privileged", "literal;not-shell"], timeoutSeconds: 30 }, true));
  const node = JSON.parse((await call("workspace_read", { path: "node-result.json" })).text);
  check(node.value === 42 && node.args[0] === "--privileged" && node.args[1] === "literal;not-shell", "真实Node ESM相对导入可用，脚本参数不能变Docker开关");
  await call("workspace_write", { path: "sleep.py", text: "import time; print('waiting', flush=True); time.sleep(60)" });
  const waiting = await call("workspace_run", { runtime: "python", scriptPath: "sleep.py", timeoutSeconds: 90 }, true);
  const stopped = await call("workspace_stop", { jobId: waiting.jobId });
  check(stopped.state === "cancelled", "停止精确容器任务，不只是关闭Docker客户进程");
  const archive = await call("workspace_zip", { action: "create", path: "deliverable.zip", files: ["code", "report.pdf", "clusters.png", "results.json"] });
  check(archive.bytes > 100 && (await call("workspace_zip", { action: "list", path: "deliverable.zip" })).entries.some(item => item.path === "report.pdf"), "真实报告、代码、图表打包成可下载ZIP");
  const token = "sandbox-live-fixture-only";
  app = createAppServer({ config: { host: "127.0.0.1", hostname: "localhost", port: 0, stateDir: dir, token, modelRoute: "madmodel", requireApproval: true }, host,
    route: { status: async () => ({ available: true }), models: async () => [{ id: "fixture" }] },
    sessions, devices: new DeviceStore(dir), pairing: new PairingCodes(), version: "sandbox-live-test" });
  const base = await app.listen(), url = base + archive.downloadUrl;
  const denied = await fetch(url);
  check(denied.status === 401, "实际产物下载仍需设备鉴权");
  await denied.body.cancel();
  const response = await fetch(url, { headers: { Authorization: "Bearer " + token } });
  check(response.status === 200 && Buffer.from(await response.arrayBuffer()).subarray(0,2).toString() === "PK" && response.headers.get("content-disposition").startsWith("attachment"), "通过真实HTTP下载ZIP，不是文本路径或假链接");
  console.log(`真实隔离容器闭环通过${checks}项；只有自建样本，无计费模型或校园操作。`);
} finally {
  delete process.env.THU_SANDBOX_LIVE_SECRET;
  await app?.close();
  await host.close();
  const expected = path.join(os.tmpdir(), path.basename(dir));
  assert.equal(path.resolve(dir), path.resolve(expected));
  assert.ok(path.basename(dir).startsWith("campus-sandbox-live-"));
  await rm(dir, { recursive: true, force: true });
}
