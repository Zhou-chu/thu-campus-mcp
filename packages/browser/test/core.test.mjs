import { test } from "node:test";
import { strict as assert } from "node:assert";
import path from "node:path";
import { realpath } from "node:fs/promises";
import { BrowserError, systemExecutable } from "../index.mjs";

const isWindows = process.platform === "win32";
const POWERSHELL = path.join(
  "System32",
  "WindowsPowerShell",
  "v1.0",
  "powershell.exe",
);

test(
  "systemExecutable 解析到系统目录内的绝对路径",
  { skip: !isWindows },
  async () => {
    const actual = await systemExecutable(POWERSHELL);
    assert.ok(path.isAbsolute(actual), actual);
    assert.match(path.basename(actual).toLowerCase(), /^powershell\.exe$/);
    const root = await realpath(process.env.SystemRoot);
    const relative = path.relative(root, actual);
    assert.ok(
      relative && !relative.startsWith("..") && !path.isAbsolute(relative),
      "应仍在 %SystemRoot% 内",
    );
  },
);

test("拒绝 .. 穿越，不回退到 PATH", async () => {
  await assert.rejects(
    systemExecutable(path.join("..", "..", "evil.exe"), {
      root: process.env.SystemRoot || "C:\\Windows",
      platform: "win32",
    }),
    (error) => {
      assert.ok(error instanceof BrowserError);
      assert.equal(error.code, "EXEC_UNSAFE");
      return true;
    },
  );
});

test("根目录不是绝对路径时明确拒绝", async () => {
  await assert.rejects(
    systemExecutable(POWERSHELL, { root: "relative/root", platform: "win32" }),
    (error) => error.code === "EXEC_ROOT",
  );
});

test("非 Windows 平台明确拒绝", async () => {
  await assert.rejects(
    systemExecutable(POWERSHELL, { platform: "linux" }),
    (error) => error.code === "EXEC_PLATFORM",
  );
});

test(
  "系统可执行文件不存在时抛 EXEC_MISSING，而不是交给 PATH 去猜",
  { skip: !isWindows },
  async () => {
    await assert.rejects(
      systemExecutable(path.join("System32", "thu-campus-no-such-tool.exe")),
      (error) => {
        assert.equal(error.code, "EXEC_MISSING");
        return true;
      },
    );
  },
);