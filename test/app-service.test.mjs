import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import {
  wrapperContent,
  taskScripts,
  encodePowerShell,
  powershellArgs,
  parseTaskJson,
  currentUser,
  installTask,
  uninstallTask,
  taskStatus,
  startTask,
  startupEntryPath,
  installStartup,
  uninstallStartup,
  startupStatus,
  explainFailure,
  wrapperMismatch,
  readWrapperPort,
} from "../lib/app/service.mjs";

test("启动包装脚本带上环境变量、目录守卫、日志重定向与 CRLF", () => {
  const content = wrapperContent({
    nodePath: "C:\\Program Files\\nodejs\\node.exe",
    entryPath: "D:\\app\\bin\\thu-campus.mjs",
    port: 8971,
    host: "127.0.0.1",
    stateDir: "C:\\Users\\me\\.thu-campus-mcp\\app",
    logFile: "C:\\Users\\me\\.thu-campus-mcp\\app\\service.log",
    extraEnv: { THU_CAMPUS_APP_KEEPALIVE_MINUTES: "15", THU_CAMPUS_APP_PUBLIC_URL: "" },
  });
  assert.match(content, /if not exist "C:\\Users\\me\\\.thu-campus-mcp\\app" mkdir/);
  assert.match(content, /set "THU_CAMPUS_APP_PORT=8971"/);
  assert.match(content, /set "THU_CAMPUS_APP_HOST=127.0.0.1"/);
  assert.match(content, /set "THU_CAMPUS_APP_KEEPALIVE_MINUTES=15"/);
  assert.ok(!content.includes("THU_CAMPUS_APP_PUBLIC_URL"), "空值不应写进脚本");
  assert.match(content, /app serve --port 8971/);
  assert.match(content, />&1/);
  assert.ok(content.includes("\r\n"), "批处理必须使用 CRLF");
});

test("任务脚本用 COM 注册登录任务，并对单引号转义", () => {
  const scripts = taskScripts({
    name: "it's-a-task",
    wrapperPath: "C:\\Users\\me\\service-run.cmd",
    user: "DOMAIN\\me",
  });
  assert.match(scripts.install, /Register-ScheduledTask -TaskName 'it''s-a-task'/);
  assert.match(scripts.install, /New-ScheduledTaskTrigger -AtLogOn -User 'DOMAIN\\me'/);
  assert.match(scripts.install, /-LogonType Interactive -RunLevel Limited/);
  assert.match(scripts.install, /Argument '\/c "C:\\Users\\me\\service-run\.cmd"'/);
  assert.match(scripts.status, /Get-ScheduledTask -TaskName 'it''s-a-task'/);
  assert.match(scripts.status, /ConvertTo-Json -Compress/);
  assert.match(scripts.uninstall, /Unregister-ScheduledTask/);
  assert.match(scripts.start, /Start-ScheduledTask/);
  assert.ok(!scripts.install.includes("schtasks"), "不应依赖 schtasks.exe（普通权限下会被拒绝）");
});

test("PowerShell 以 UTF-16LE base64 传参，避免引号地狱", () => {
  const script = "Write-Output '中文 ok'";
  const encoded = encodePowerShell(script);
  assert.equal(Buffer.from(encoded, "base64").toString("utf16le"), script);
  const args = powershellArgs(script);
  assert.deepEqual(args.slice(0, 3), ["-NoProfile", "-NonInteractive", "-EncodedCommand"]);
  assert.equal(args[3], encoded);
});

test("任务状态 JSON 能从噪声输出里提取，坏输出返回 null", () => {
  assert.deepEqual(parseTaskJson('{"installed":true,"state":"Ready"}'), {
    installed: true,
    state: "Ready",
  });
  assert.deepEqual(
    parseTaskJson('警告: something\r\n{"installed":false}\r\n'),
    { installed: false },
  );
  assert.equal(parseTaskJson("no json here"), null);
  assert.equal(parseTaskJson(""), null);
});

test("当前用户标识可被环境变量覆盖", () => {
  assert.equal(currentUser({ USERDOMAIN: "LAB", USERNAME: "me" }), "LAB\\me");
  assert.match(currentUser({}), /\\.+/);
});

test("安装会写出包装脚本并通过 PowerShell 注册任务", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "campus-service-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const wrapperPath = path.join(dir, "service-run.cmd");
  const calls = [];
  const exec = async (file, args) => {
    calls.push({ file, args });
    return { stdout: '{"installed":true}', stderr: "" };
  };
  const result = await installTask({
    name: "thu-campus-test",
    wrapperPath,
    content: "@echo off\r\necho hi\r\n",
    exec,
  });
  assert.equal(result.result.installed, true);
  assert.equal(await readFile(wrapperPath, "utf8"), "@echo off\r\necho hi\r\n");
  assert.equal(calls[0].file, "powershell.exe");
  assert.ok(calls[0].args.includes("-EncodedCommand"));
  const decoded = Buffer.from(calls[0].args.at(-1), "base64").toString("utf16le");
  assert.match(decoded, /Register-ScheduledTask -TaskName 'thu-campus-test'/);
});

test("卸载会清理包装脚本，任务不存在时如实返回 false", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "campus-service-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const wrapperPath = path.join(dir, "service-run.cmd");
  await installTask({
    name: "t",
    wrapperPath,
    content: "@echo off\r\n",
    exec: async () => ({ stdout: '{"installed":true}', stderr: "" }),
  });
  const result = await uninstallTask({
    name: "t",
    wrapperPath,
    exec: async () => ({ stdout: '{"removed":false}', stderr: "" }),
  });
  assert.equal(result.removed, false);
  await assert.rejects(() => stat(wrapperPath), /ENOENT/);
});

test("任务状态与启动分别解析各自的 JSON", async () => {
  const installed = await taskStatus({
    name: "t",
    exec: async () => ({
      stdout: '{"installed":true,"state":"Ready","lastResult":0,"nextRun":null}',
      stderr: "",
    }),
  });
  assert.equal(installed.installed, true);
  assert.equal(installed.state, "Ready");
  const missing = await taskStatus({
    name: "t",
    exec: async () => ({ stdout: '{"installed":false}', stderr: "" }),
  });
  assert.equal(missing.installed, false);
  const broken = await taskStatus({
    name: "t",
    exec: async () => {
      throw Object.assign(new Error("powershell missing"), { code: "ENOENT" });
    },
  });
  assert.equal(broken.installed, false);
  const started = await startTask({
    name: "t",
    exec: async () => ({ stdout: '{"started":true}', stderr: "" }),
  });
  assert.equal(started.started, true);
});

test("启动项路径按 APPDATA 解析，安装/查询/卸载幂等", async (t) => {
  const entry = startupEntryPath({ APPDATA: "C:\\Users\\me\\AppData\\Roaming" });
  assert.equal(
    entry,
    "C:\\Users\\me\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs\\Startup\\thu-campus-app.cmd",
  );
  if (process.platform !== "win32") return;
  const dir = await mkdtemp(path.join(tmpdir(), "campus-startup-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const entryPath = path.join(dir, "thu-campus-app.cmd");
  assert.equal(startupStatus({ entryPath }).installed, false);
  installStartup({ entryPath, content: "@echo off\r\n" });
  assert.equal(startupStatus({ entryPath }).installed, true);
  assert.equal(uninstallStartup({ entryPath }).removed, true);
  assert.equal(uninstallStartup({ entryPath }).removed, false, "重复卸载不报错");
});

test("权限被拒时给出可执行的替代建议", () => {
  const mapped = explainFailure(new Error("ERROR: Access is denied."));
  assert.equal(mapped.code, "SERVICE_ACCESS_DENIED");
  assert.match(mapped.message, /--startup/);
  const other = new Error("something else");
  assert.equal(explainFailure(other), other);
});

test("端口改动会被识别为包装脚本漂移", () => {
  const base = wrapperContent({
    nodePath: "node.exe",
    entryPath: "app.mjs",
    port: 8971,
    host: "127.0.0.1",
    stateDir: "C:\\state",
    logFile: "C:\\state\\service.log",
  });
  const moved = wrapperContent({
    nodePath: "node.exe",
    entryPath: "app.mjs",
    port: 9000,
    host: "127.0.0.1",
    stateDir: "C:\\state",
    logFile: "C:\\state\\service.log",
  });
  assert.equal(wrapperMismatch(base, base), false);
  assert.equal(wrapperMismatch(base, moved), true);
  assert.equal(wrapperMismatch(base.replace(/\r\n/g, "\n"), base), false, "换行差异不算漂移");
  assert.equal(readWrapperPort(base), 8971);
  assert.equal(readWrapperPort(moved), 9000);
  assert.equal(readWrapperPort("nothing"), null);
});
