import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import {
  wrapperContent,
  createTaskArgs,
  queryTaskArgs,
  deleteTaskArgs,
  parseTaskCsv,
  installService,
  uninstallService,
  serviceStatus,
  startupEntryPath,
  installStartup,
  uninstallStartup,
  startupStatus,
  explainTaskFailure,
} from "../lib/app/service.mjs";
test("启动包装脚本带上环境变量、日志重定向与 CRLF", () => {
  const content = wrapperContent({
    nodePath: "C:\\Program Files\\nodejs\\node.exe",
    entryPath: "D:\\app\\bin\\thu-campus.mjs",
    port: 8971,
    host: "127.0.0.1",
    stateDir: "C:\\Users\\me\\.thu-campus-mcp\\app",
    logFile: "C:\\Users\\me\\.thu-campus-mcp\\app\\service.log",
    extraEnv: { THU_CAMPUS_APP_KEEPALIVE_MINUTES: "15", THU_CAMPUS_APP_PUBLIC_URL: "" },
  });
  assert.match(content, /set "THU_CAMPUS_APP_STATE_DIR=C:\\Users\\me\\\.thu-campus-mcp\\app"/);
  assert.match(content, /set "THU_CAMPUS_APP_PORT=8971"/);
  assert.match(content, /if not exist "C:\\Users\\me\\\.thu-campus-mcp\\app" mkdir/);
  assert.match(content, /set "THU_CAMPUS_APP_HOST=127.0.0.1"/);
  assert.match(content, /set "THU_CAMPUS_APP_KEEPALIVE_MINUTES=15"/);
  assert.ok(!content.includes("THU_CAMPUS_APP_PUBLIC_URL"), "空值不应写进脚本");
  assert.match(content, /"C:\\Program Files\\nodejs\\node.exe" "D:\\app\\bin\\thu-campus\.mjs" app serve --port 8971/);
  assert.match(content, />&1/);
  assert.ok(content.includes("\r\n"), "批处理必须使用 CRLF");
});
test("计划任务参数使用登录触发、最低权限、覆盖同名任务", () => {
  const args = createTaskArgs({ name: "thu-campus-app", wrapperPath: "C:\\Users\\me\\app\\service-run.cmd" });
  assert.deepEqual(args.slice(0, 2), ["/create", "/tn"]);
  assert.equal(args[2], "thu-campus-app");
  assert.equal(args[3], "/tr");
  assert.equal(args[4], 'cmd.exe /c "C:\\Users\\me\\app\\service-run.cmd"');
  assert.ok(args.includes("/sc"));
  assert.equal(args[args.indexOf("/sc") + 1], "onlogon");
  assert.equal(args[args.indexOf("/rl") + 1], "limited");
  assert.ok(args.includes("/f"));
  assert.deepEqual(queryTaskArgs("t"), ["/query", "/tn", "t", "/fo", "CSV", "/nh"]);
  assert.deepEqual(deleteTaskArgs("t"), ["/delete", "/tn", "t", "/f"]);
});
test("schtasks CSV 按位置解析，能处理带逗号的引号字段", () => {
  const parsed = parseTaskCsv('"thu-campus-app","2026/11/14 9:00:00","就绪"\r\n');
  assert.deepEqual(parsed, {
    taskName: "thu-campus-app",
    nextRun: "2026/11/14 9:00:00",
    status: "就绪",
  });
  const withComma = parseTaskCsv('"任务, 一名","N/A","Running"');
  assert.equal(withComma.taskName, "任务, 一名");
  assert.equal(withComma.status, "Running");
  assert.equal(parseTaskCsv(""), null);
  assert.equal(parseTaskCsv('"too-short"'), null);
});
test("安装会写出包装脚本并调用 schtasks", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "campus-service-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const wrapperPath = path.join(dir, "service-run.cmd");
  const calls = [];
  const exec = async (file, args) => {
    calls.push({ file, args });
    return { stdout: "", stderr: "" };
  };
  const result = await installService({
    name: "thu-campus-test",
    wrapperPath,
    content: "@echo off\r\necho hi\r\n",
    exec,
  });
  assert.equal(result.wrapperPath, wrapperPath);
  assert.equal(await readFile(wrapperPath, "utf8"), "@echo off\r\necho hi\r\n");
  if (process.platform !== "win32") return;
  const mode = (await stat(wrapperPath)).mode & 0o200;
  assert.ok(mode, "包装脚本应可写（Windows ACL 模式位不严格，这里只确认文件存在可读）");
  assert.deepEqual(calls[0].args.slice(0, 2), ["/create", "/tn"]);
});
test("卸载对不存在的任务不抛错，并清理包装脚本", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "campus-service-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const wrapperPath = path.join(dir, "service-run.cmd");
  await installService({
    name: "thu-campus-test",
    wrapperPath,
    content: "@echo off\r\n",
    exec: async () => ({ stdout: "", stderr: "" }),
  });
  const result = await uninstallService({
    name: "thu-campus-test",
    wrapperPath,
    exec: async () => {
      throw new Error("ERROR: The system cannot find the file specified.");
    },
  });
  assert.equal(result.removed, false);
  await assert.rejects(() => stat(wrapperPath), /ENOENT/);
});
test("状态查询区分已安装与未安装", async () => {
  const installed = await serviceStatus({
    name: "t",
    exec: async () => ({ stdout: '"t","2026/11/14 9:00:00","就绪"\r\n', stderr: "" }),
  });
  assert.equal(installed.installed, true);
  assert.equal(installed.status, "就绪");
  assert.equal(installed.nextRun, "2026/11/14 9:00:00");
  const missing = await serviceStatus({
    name: "t",
    exec: async () => {
      throw new Error("not found");
    },
  });
  assert.deepEqual(missing, { name: "t", installed: false });
});
test("启动项路径按 APPDATA 解析，落在当前用户的 Startup 目录", () => {
  const entry = startupEntryPath({ APPDATA: "C:\\Users\\me\\AppData\\Roaming" });
  assert.equal(
    entry,
    "C:\\Users\\me\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs\\Startup\\thu-campus-app.cmd",
  );
  const fallback = startupEntryPath({ USERPROFILE: "C:\\Users\\me", APPDATA: "" });
  assert.ok(fallback.includes("AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs\\Startup"));
});
test("启动项安装、查询、卸载是幂等的", async (t) => {
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
test("计划任务权限被拒时给出可执行的替代建议", () => {
  const mapped = explainTaskFailure(new Error("ERROR: Access is denied."));
  assert.equal(mapped.code, "SERVICE_ACCESS_DENIED");
  assert.match(mapped.message, /--task/);
  assert.match(mapped.message, /启动项/);
  const other = new Error("something else");
  assert.equal(explainTaskFailure(other), other);
});

