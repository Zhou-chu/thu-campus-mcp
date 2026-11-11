#!/usr/bin/env node
/**
 * 运行时冒烟：真启动 bin/thu-campus.mjs app serve，验证配对、元信息、
 * 工具列表与一次真实工具调用。使用 mock 校园服务与临时状态目录，不联网、
 * 不触碰任何真实账号。
 */
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { root } from "../lib/services.mjs";
function fail(message, detail) {
  process.stderr.write(
    JSON.stringify({ ok: false, error: { message, detail } }, null, 2) + "\n",
  );
  process.exitCode = 1;
}
async function main() {
  const dir = await mkdtemp(path.join(tmpdir(), "campus-app-smoke-"));
  const port = 18000 + Math.floor(Math.random() * 2000);
  const env = {
    ...process.env,
    THU_CAMPUS_MOCK: "1",
    THU_CAMPUS_APP_STATE_DIR: path.join(dir, "app"),
    THU_CAMPUS_APP_PORT: String(port),
    THU_BROWSER_STATE_DIR: path.join(dir, "browser"),
    THU_BROWSER_RUNTIME_DIR: path.join(dir, "runtime"),
    NODE_OPTIONS: "",
  };
  for (const prefix of ["LEARNX", "THU_CLOUD", "HETANG"])
    Object.assign(env, {
      [prefix + "_MOCK"]: "1",
      [prefix + "_STATE_DIR"]: path.join(dir, prefix),
      [prefix + "_OUTPUT_DIR"]: path.join(dir, "output", prefix),
    });
  const child = spawn(
    process.execPath,
    [path.join(root, "bin/thu-campus.mjs"), "app", "serve", "--port", String(port)],
    { env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
  );
  let out = "";
  let err = "";
  child.stdout.on("data", (chunk) => (out += chunk));
  child.stderr.on("data", (chunk) => (err += chunk));
  const cleanup = async () => {
    child.kill("SIGTERM");
    await new Promise((resolve) => setTimeout(resolve, 400));
    if (!child.killed) child.kill("SIGKILL");
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  };
  const base = `http://127.0.0.1:${port}`;
  try {
    const deadline = Date.now() + 60000;
    let code = "";
    while (Date.now() < deadline) {
      const match = /首次配对码：(\d{6})/.exec(out);
      if (match) {
        code = match[1];
        break;
      }
      if (child.exitCode !== null)
        throw new Error("运行时提前退出：" + (err || out).slice(-800));
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    if (!code) throw new Error("未在超时内看到配对码：" + (err || out).slice(-800));
    const health = await fetch(base + "/healthz");
    if (!health.ok) throw new Error("healthz 失败：" + health.status);
    const redeemed = await (
      await fetch(base + "/api/pair/redeem", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code, deviceName: "冒烟测试", platform: "webui" }),
      })
    ).json();
    if (!redeemed.ok) throw new Error("配对失败：" + JSON.stringify(redeemed));
    const headers = {
      authorization: "Bearer " + redeemed.token,
      "content-type": "application/json",
    };
    const meta = await (await fetch(base + "/api/meta", { headers })).json();
    if (!meta.ok) throw new Error("meta 失败：" + JSON.stringify(meta));
    const tools = await (await fetch(base + "/api/tools", { headers })).json();
    if (!tools.ok || tools.tools.length < 51)
      throw new Error("工具列表不完整：" + tools.tools?.length);
    const status = await (
      await fetch(base + "/api/tools/learn_status", { method: "POST", headers, body: "{}" })
    ).json();
    if (!status.ok) throw new Error("工具调用失败：" + JSON.stringify(status));
    const unauthorized = await fetch(base + "/api/meta");
    if (unauthorized.status !== 401) throw new Error("未配对时应返回 401");
    process.stdout.write(
      JSON.stringify(
        {
          ok: true,
          url: base,
          tools: tools.tools.length,
          services: Object.fromEntries(
            Object.entries(meta.services).map(([k, v]) => [k, v.state]),
          ),
          model: meta.model,
          learnStatusKeys: Object.keys(status.data || {}).slice(0, 8),
        },
        null,
        2,
      ) + "\n",
    );
  } catch (e) {
    fail(e.message, (err || out).slice(-1200));
  } finally {
    await cleanup();
  }
}
main().catch((e) => {
  fail("冒烟脚本异常", String(e?.stack || e));
});