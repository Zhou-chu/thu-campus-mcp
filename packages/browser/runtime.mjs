import path from "node:path";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { access, readFile, realpath } from "node:fs/promises";
import lockfile from "proper-lockfile";
import {
  browserConfig,
  BrowserError,
  directory,
  inside,
  readJson,
  atomic,
} from "./core.mjs";
const require = createRequire(import.meta.url);
const playwrightRoot = path.dirname(
  require.resolve("playwright-core/package.json"),
);
async function pinned() {
  return JSON.parse(
    await readFile(path.join(playwrightRoot, "browsers.json"), "utf8"),
  ).browsers.find((b) => b.name === "chromium");
}
export async function runtimeInfo(options = {}) {
  const cfg = browserConfig(options),
    manifest = await readJson(path.join(cfg.runtimeDir, "browser.json"));
  if (!manifest)
    return {
      installed: false,
      runtimeDir: cfg.runtimeDir,
      revision: (await pinned()).revision,
    };
  const target = path.resolve(
    cfg.runtimeDir,
    manifest.relativeExecutable || ".",
  );
  if (
    !inside(cfg.runtimeDir, target) ||
    manifest.revision !== (await pinned()).revision
  )
    throw new BrowserError(
      "BROWSER_RUNTIME_INVALID",
      "浏览器运行时版本或路径不匹配，请运行 browser install。",
    );
  try {
    await access(target);
    const actual = await realpath(target);
    if (!inside(await realpath(cfg.runtimeDir), actual))
      throw new BrowserError(
        "BROWSER_RUNTIME_INVALID",
        "浏览器可执行文件超出运行时目录。",
      );
  } catch (e) {
    if (e.code === "ENOENT")
      return {
        installed: false,
        runtimeDir: cfg.runtimeDir,
        revision: manifest.revision,
      };
    throw e;
  }
  return {
    ...manifest,
    installed: true,
    executablePath: target,
    runtimeDir: cfg.runtimeDir,
  };
}
export async function installRuntime(options = {}) {
  const cfg = browserConfig(options);
  await directory(cfg.runtimeDir);
  const release = await lockfile.lock(cfg.runtimeDir, {
    retries: { retries: 60, minTimeout: 200, maxTimeout: 1000 },
    stale: 180000,
    update: 10000,
  });
  try {
    const existing = await runtimeInfo(cfg).catch((e) => {
      if (e.code === "BROWSER_RUNTIME_INVALID") return { installed: false };
      throw e;
    });
    if (existing.installed) return existing;
    await new Promise((resolve, reject) => {
      const child = spawn(
        process.execPath,
        [
          path.join(playwrightRoot, "cli.js"),
          "install",
          "chromium",
          "--no-shell",
        ],
        {
          env: {
            ...process.env,
            PLAYWRIGHT_BROWSERS_PATH: cfg.runtimeDir,
            PLAYWRIGHT_SKIP_BROWSER_GC: "1",
            PLAYWRIGHT_DOWNLOAD_CONNECTION_TIMEOUT: "120000",
          },
          windowsHide: true,
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      child.stdout.on("data", (b) => process.stderr.write(b));
      child.stderr.on("data", (b) => process.stderr.write(b));
      child.once("error", () =>
        reject(
          new BrowserError("BROWSER_INSTALL_FAILED", "无法启动浏览器安装器。"),
        ),
      );
      child.once("exit", (c) =>
        c === 0
          ? resolve()
          : reject(
              new BrowserError(
                "BROWSER_INSTALL_FAILED",
                "独立浏览器下载失败，请检查网络后重试 browser install。",
              ),
            ),
      );
    });
    const output = await new Promise((resolve, reject) => {
      const child = spawn(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          'import {chromium} from "playwright-core";process.stdout.write(chromium.executablePath());',
        ],
        {
          cwd: path.dirname(playwrightRoot),
          env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: cfg.runtimeDir },
          windowsHide: true,
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      let value = "";
      child.stdout.on("data", (b) => (value += b));
      child.stderr.resume();
      child.once("error", reject);
      child.once("exit", (c) =>
        c === 0
          ? resolve(value)
          : reject(
              new BrowserError(
                "BROWSER_INSTALL_FAILED",
                "无法定位浏览器内核。",
              ),
            ),
      );
    });
    if (!inside(cfg.runtimeDir, path.resolve(output)))
      throw new BrowserError(
        "BROWSER_RUNTIME_INVALID",
        "安装器返回的浏览器路径超出项目目录。",
      );
    const p = await pinned();
    await atomic(
      path.join(cfg.runtimeDir, "browser.json"),
      JSON.stringify(
        {
          revision: p.revision,
          version: p.browserVersion,
          platform: process.platform,
          arch: process.arch,
          relativeExecutable: path.relative(cfg.runtimeDir, output),
        },
        null,
        2,
      ) + "\n",
    );
    return runtimeInfo(cfg);
  } finally {
    await release();
  }
}
