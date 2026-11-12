#!/usr/bin/env node
/**
 * 四端产物一键校验：源码形态必须始终成立，构建产物存在时才校验结构与签名。
 *
 *   node scripts/verify-clients.mjs           # 缺产物只告警
 *   node scripts/verify-clients.mjs --strict  # 缺产物即失败（发布门禁用）
 *   node scripts/verify-clients.mjs --json    # 机器可读
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("../", import.meta.url));
const args = new Set(process.argv.slice(2));
const strict = args.has("--strict");
const asJson = args.has("--json");
const rows = [];
function record(target, name, state, detail) {
  rows.push({ target, name, state, detail });
}
function ok(target, name, detail) {
  record(target, name, "ok", detail);
}
function warn(target, name, detail) {
  record(target, name, "warn", detail);
}
function fail(target, name, detail) {
  record(target, name, "fail", detail);
}
function file(rel) {
  return path.join(root, rel);
}
function sizeLabel(rel) {
  const bytes = statSync(file(rel)).size;
  return bytes > 1024 * 1024
    ? `${(bytes / 1024 / 1024).toFixed(2)} MB`
    : `${(bytes / 1024).toFixed(1)} KB`;
}
function zipMagic(rel) {
  const fd = readFileSync(file(rel));
  return fd.subarray(0, 4).toString("hex");
}
function syntaxCheck(rel) {
  const result = spawnSync(process.execPath, ["--check", file(rel)], {
    encoding: "utf8",
  });
  return result.status === 0 ? null : (result.stderr || "").trim().split("\n")[0];
}
/* ---------- WebUI ---------- */
const webuiFiles = [
  "webui/index.html",
  "webui/app.js",
  "webui/styles.css",
  "webui/manifest.webmanifest",
  "webui/sw.js",
  "webui/icons/icon.svg",
];
{
  const missing = webuiFiles.filter((rel) => !existsSync(file(rel)));
  if (missing.length) fail("webui", "必需文件", `缺少 ${missing.join(", ")}`);
  else ok("webui", "必需文件", `${webuiFiles.length} 个齐全`);
  for (const script of ["webui/app.js", "webui/sw.js"]) {
    if (!existsSync(file(script))) continue;
    const error = syntaxCheck(script);
    if (error) fail("webui", "语法", `${script}: ${error}`);
    else ok("webui", "语法", path.basename(script));
  }
  if (existsSync(file("webui/manifest.webmanifest"))) {
    try {
      const manifest = JSON.parse(readFileSync(file("webui/manifest.webmanifest"), "utf8"));
      if (!manifest.start_url || !manifest.icons?.length)
        fail("webui", "PWA 清单", "缺少 start_url 或 icons");
      else ok("webui", "PWA 清单", `name=${manifest.name} display=${manifest.display}`);
    } catch (e) {
      fail("webui", "PWA 清单", e.message);
    }
  }
}
/* ---------- 桌面 ---------- */
{
  const launcher = "desktop/launcher.mjs";
  if (!existsSync(file(launcher))) fail("desktop", "启动器", "缺少 desktop/launcher.mjs");
  else {
    const error = syntaxCheck(launcher);
    if (error) fail("desktop", "语法", error);
    else ok("desktop", "语法", "launcher.mjs");
  }
  const cmd = "desktop/thu-campus-desktop.cmd";
  if (!existsSync(file(cmd))) fail("desktop", "入口", "缺少 thu-campus-desktop.cmd");
  else {
    const body = readFileSync(file(cmd), "utf8");
    if (!body.includes("%~dp0")) fail("desktop", "入口", "cmd 未使用 %~dp0 解析自身目录");
    else ok("desktop", "入口", "thu-campus-desktop.cmd");
  }
  if (existsSync(file("desktop/test/launcher.test.mjs")))
    ok("desktop", "单测", "desktop/test/launcher.test.mjs");
  else warn("desktop", "单测", "缺少启动器单测");
}
/* ---------- Android ---------- */
{
  const candidates = [
    ["mobile/android/app/build/outputs/apk/release/app-release.apk", "release"],
    ["mobile/android/app/build/outputs/apk/debug/app-debug.apk", "debug"],
  ];
  let found = false;
  for (const [rel, kind] of candidates) {
    if (!existsSync(file(rel))) continue;
    found = true;
    if (zipMagic(rel) !== "504b0304") {
      fail("android", `${kind} APK`, "不是合法 ZIP");
      continue;
    }
    ok("android", `${kind} APK`, sizeLabel(rel));
  }
  if (!found) {
    const message = "未构建（运行 mobile/android/gradlew.bat assembleRelease）";
    if (strict) fail("android", "APK", message);
    else warn("android", "APK", message);
  }
  for (const rel of ["mobile/android/gradlew.bat", "mobile/android/gradle/wrapper/gradle-wrapper.jar"])
    if (!existsSync(file(rel))) fail("android", "wrapper", `缺少 ${rel}`);
  if (existsSync(file("mobile/android/keystore.properties")))
    warn("android", "签名材料", "keystore.properties 存在（应保持被 gitignore 忽略）");
}
/* ---------- HarmonyOS ---------- */
{
  const hap = "mobile/harmony/entry/build/default/outputs/default/entry-default-unsigned.hap";
  const signed = "mobile/harmony/entry/build/default/outputs/default/entry-default-signed.hap";
  const target = existsSync(file(signed)) ? signed : existsSync(file(hap)) ? hap : null;
  if (!target) {
    const message = "未构建（运行 hvigorw assembleHap，见 mobile/harmony/README.md）";
    if (strict) fail("harmony", "HAP", message);
    else warn("harmony", "HAP", message);
  } else if (zipMagic(target) !== "504b0304") {
    fail("harmony", "HAP", "不是合法 ZIP");
  } else {
    ok("harmony", "HAP", `${sizeLabel(target)}${target === signed ? "（已签名）" : "（未签名）"}`);
  }
  for (const rel of ["mobile/harmony/build-profile.json5", "mobile/harmony/entry/src/main/module.json5"]) {
    if (!existsSync(file(rel))) {
      fail("harmony", "工程", `缺少 ${rel}`);
      continue;
    }
    try {
      JSON.parse(readFileSync(file(rel), "utf8"));
      ok("harmony", "工程", path.basename(rel));
    } catch (e) {
      fail("harmony", "工程", `${rel}: ${e.message}`);
    }
  }
}
/* ---------- 运行时 ---------- */
{
  for (const rel of ["lib/app/server.mjs", "lib/app/agent.mjs", "lib/app/cli.mjs"]) {
    if (!existsSync(file(rel))) {
      fail("runtime", "模块", `缺少 ${rel}`);
      continue;
    }
    const error = syntaxCheck(rel);
    if (error) fail("runtime", "语法", `${rel}: ${error}`);
  }
  ok("runtime", "模块", "server/agent/cli 语法通过");
}
const failed = rows.filter((row) => row.state === "fail");
const warned = rows.filter((row) => row.state === "warn");
if (asJson) {
  process.stdout.write(
    JSON.stringify({ ok: failed.length === 0, strict, rows }, null, 2) + "\n",
  );
} else {
  let target = "";
  for (const row of rows) {
    if (row.target !== target) {
      target = row.target;
      process.stdout.write(`\n${target}\n`);
    }
    const mark = row.state === "ok" ? "✔" : row.state === "warn" ? "!" : "✖";
    process.stdout.write(`  ${mark} ${row.name}：${row.detail}\n`);
  }
  process.stdout.write(
    `\n通过 ${rows.filter((r) => r.state === "ok").length} 项，告警 ${warned.length} 项，失败 ${failed.length} 项\n`,
  );
}
process.exitCode = failed.length ? 1 : 0;