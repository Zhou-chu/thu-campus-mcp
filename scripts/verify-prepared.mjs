import { execFileSync, spawn } from "node:child_process";
import { mkdir, copyFile, unlink } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { root } from "../lib/services.mjs";
const moved = path.join(root, ".local", "relocated 校园 package", randomUUID());
await mkdir(moved, { recursive: true });
// Older Windows tar builds corrupt Unicode argv. ZIP extraction also needs a seekable file.
const archive = path.join(moved, "bundle.zip");
await copyFile(
  path.join(root, ".local/release/thu-campus-mcp-windows-x64.zip"),
  archive,
);
execFileSync("tar.exe", ["-xf", "bundle.zip"], { cwd: moved });
await unlink(archive);
const windows = process.env.SystemRoot || "C:\\Windows";
const env = {
  ...process.env,
  Path: [
    path.join(windows, "System32"),
    path.join(windows, "System32/WindowsPowerShell/v1.0"),
    windows,
  ].join(";"),
};
delete env.PATH;
delete env.THU_BROWSER_RUNTIME_DIR;
delete env.THU_BROWSER_STATE_DIR;
const node = path.join(moved, ".runtime/node.exe");
for (const args of [
  ["--test", "test/gateway.test.mjs"],
  ["packages/browser/test/smoke.mjs"],
  ["packages/browser/test/manual-close.mjs"],
]) {
  await new Promise((resolve, reject) => {
    const child = spawn(node, args, {
      cwd: moved,
      env,
      stdio: "inherit",
      windowsHide: true,
    });
    child.once("error", reject);
    child.once("exit", (code) =>
      code === 0
        ? resolve()
        : reject(new Error("Relocated prepared package verification failed.")),
    );
  });
}
console.log(
  "PASS: relocated Unicode/space prepared ZIP, bundled Node and Chromium, no system Node/browser dependency; 53 MCP tools.",
);
