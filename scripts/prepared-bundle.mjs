import { spawn, execFileSync } from "node:child_process";
import {
  mkdir,
  readFile,
  writeFile,
  copyFile,
  cp,
  readdir,
  lstat,
  realpath,
  unlink,
} from "node:fs/promises";
import path from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { root, services } from "../lib/services.mjs";
import { runtimeInfo, launchEphemeral } from "@thu-campus/browser";
import { request } from "playwright-core";
if (process.platform !== "win32")
  throw new Error("Prepared release currently targets Windows x64.");
const runtime = await runtimeInfo();
if (!runtime.installed)
  throw new Error("Run browser install before preparing a release.");
const release = path.join(root, ".local/release"),
  stage = path.join(root, ".local/prepared", randomUUID());
await mkdir(stage, { recursive: true });
await mkdir(release, { recursive: true });
const source = path.join(stage, "source.zip");
execFileSync("git", ["archive", "--format=zip", "--output", source, "HEAD"], {
  cwd: root,
});
execFileSync("tar.exe", ["-xf", source, "-C", stage]);
await unlink(source);
// 独立应用的前端与桌面壳必须真的随包分发，否则便携包只能当 MCP 用。
const requiredEntries = [
  "webui/index.html",
  "webui/app.js",
  "webui/manifest.webmanifest",
  "desktop/launcher.mjs",
  "desktop/thu-campus-desktop.cmd",
  "bin/thu-campus.mjs",
  "lib/app/server.mjs",
  "lib/app/agent.mjs",
  "lib/app/keepalive.mjs",
  "lib/app/states.mjs",
  "lib/app/runtime-state.mjs",
  "lib/app/workspace.mjs",
  "lib/app/workspace-http.mjs",
  "lib/app/workspace-files.mjs",
  "lib/app/workspace-paths.mjs",
  "lib/app/workspace-zip.mjs",
  "lib/app/sandbox.mjs",
  "webui/workspace.js",
  "sandbox/Dockerfile",
  "sandbox/requirements.txt",
  ".dockerignore",
];
for (const entry of requiredEntries) {
  const present = await lstat(path.join(stage, entry)).then(
    () => true,
    () => false,
  );
  if (!present)
    throw new Error(`Prepared release is missing ${entry}; 独立应用将无法启动。`);
}
for (const s of services)
  await cp(
    path.join(root, "packages", s.directory, "dist"),
    path.join(stage, "packages", s.directory, "dist"),
    { recursive: true },
  );
const run = (command, args, options = {}) =>
  new Promise((resolve, reject) => {
    const p = spawn(command, args, {
      windowsHide: true,
      stdio: "inherit",
      ...options,
    });
    p.once("error", reject);
    p.once("exit", (c) =>
      c === 0
        ? resolve()
        : reject(new Error("Release preparation command failed.")),
    );
  });
// cmd file is fixed, and all arguments are literals; no source text becomes a shell command.
await run(
  process.env.ComSpec || "cmd.exe",
  ["/d", "/c", "npm.cmd ci --omit=dev --ignore-scripts --no-audit --no-fund"],
  { cwd: stage },
);
for (const [name, entry] of Object.entries(
  JSON.parse(await readFile(path.join(stage, "package-lock.json"), "utf8"))
    .packages,
)) {
  if (!name.includes("node_modules/") || !entry.link) continue;
  const link = path.join(stage, name),
    target = await realpath(link);
  if (!target.startsWith(stage + path.sep))
    throw new Error("Release workspace link escaped staging directory.");
  if ((await lstat(link)).isSymbolicLink()) {
    await unlink(link);
    await cp(target, link, {
      recursive: true,
      dereference: true,
      filter: (p) =>
        !path
          .relative(target, p)
          .split(path.sep)
          .some((s) =>
            ["node_modules", "downloads", ".local", ".runtime"].includes(s),
          ),
    });
  }
}
const engineDir = runtime.relativeExecutable.split(/[\\/]/)[0];
if (!/^chromium-\d+$/.test(engineDir))
  throw new Error("Unexpected runtime layout.");
const outRuntime = path.join(stage, ".runtime/browsers");
await mkdir(outRuntime, { recursive: true });
await cp(
  path.join(runtime.runtimeDir, engineDir),
  path.join(outRuntime, engineDir),
  { recursive: true },
);
await copyFile(
  path.join(runtime.runtimeDir, "browser.json"),
  path.join(outRuntime, "browser.json"),
);
await copyFile(process.execPath, path.join(stage, ".runtime/node.exe"));
let license;
for (const name of ["LICENSE", "LICENSE.txt"])
  try {
    license = await readFile(path.join(path.dirname(process.execPath), name));
    break;
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
  }
if (!license) {
  const proxyUrl =
    process.env.HTTPS_PROXY ||
    process.env.https_proxy ||
    process.env.HTTP_PROXY;
  let proxy;
  if (proxyUrl) {
    const url = new URL(proxyUrl);
    proxy = {
      server: url.origin,
      username: decodeURIComponent(url.username),
      password: decodeURIComponent(url.password),
    };
  }
  const client = await request.newContext({ proxy });
  try {
    const response = await client.get(
      `https://raw.githubusercontent.com/nodejs/node/${process.version}/LICENSE`,
      { timeout: 60000 },
    );
    if (!response.ok())
      throw new Error("Cannot obtain matching Node.js license.");
    license = await response.body();
  } finally {
    await client.dispose();
  }
}
await writeFile(path.join(stage, ".runtime/NODE-LICENSE.txt"), license);
const cleanBrowser = await launchEphemeral({ headless: true });
try {
  const page = await cleanBrowser.newPage();
  await page.goto("chrome://credits/");
  const credits = await page.content();
  if (!/copyright|license/i.test(credits))
    throw new Error("Browser credits unavailable.");
  await writeFile(
    path.join(stage, ".runtime/CHROMIUM-THIRD-PARTY-NOTICES.html"),
    credits,
  );
} finally {
  await cleanBrowser.close();
}
const forbidden = [];
async function audit(dir) {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isSymbolicLink())
      throw new Error("Unresolved symlink in prepared release.");
    if (e.isDirectory()) await audit(p);
    else if (
      /\.dpapi$|^(Cookies|Login Data|History|bindings\.json)$/.test(e.name) ||
      [".env", "report.json", "verification.json"].includes(e.name)
    )
      forbidden.push(path.relative(stage, p));
  }
}
await audit(stage);
if (forbidden.length)
  throw new Error("Private state detected in prepared release.");
const destination = path.join(release, "thu-campus-mcp-windows-x64.zip");
execFileSync("tar.exe", ["-a", "-cf", destination, "-C", stage, "."]);
const sha256 = createHash("sha256")
  .update(await readFile(destination))
  .digest("hex");
await writeFile(
  destination + ".sha256",
  sha256 + "  " + path.basename(destination) + "\n",
);
console.log(
  JSON.stringify({
    filename: destination,
    sha256,
    includes:
      "Node.js, production dependencies, compiled services, webui, desktop shell and independent Chromium; no user profiles",
  }),
);



