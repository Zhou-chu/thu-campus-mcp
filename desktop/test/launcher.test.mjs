import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, rm, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  buildLaunchArgs,
  ensureConfig,
  waitForHealth,
  redact,
} from "../launcher.mjs";
async function temp(t) {
  const dir = await mkdtemp(path.join(tmpdir(), "campus-desktop-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}
test("令牌首次生成后复用，且以片段形式传给窗口", async (t) => {
  const dir = await temp(t);
  const first = await ensureConfig({ dir, port: 8971 });
  assert.equal(first.port, 8971);
  assert.match(first.token, /^[A-Za-z0-9_-]{40,}$/);
  const second = await ensureConfig({ dir, port: 9999 });
  assert.equal(second.token, first.token, "已有配置不能被覆盖");
  assert.equal(second.port, 8971);
  assert.equal(second.created, false);
  const raw = JSON.parse(await readFile(path.join(dir, "desktop.json"), "utf8"));
  assert.equal(raw.token, first.token);
  if (process.platform !== "win32") {
    const mode = (await stat(path.join(dir, "desktop.json"))).mode & 0o777;
    assert.equal(mode, 0o600);
  }
});
test("窗口参数把令牌放在片段里，不进入查询串", () => {
  const args = buildLaunchArgs({ port: 8975, token: "tc1_secret", profileDir: "C:\\tmp\\profile" });
  assert.ok(args.some((arg) => arg.startsWith("--app=http://127.0.0.1:8975/#token=tc1_secret")));
  assert.ok(!args.join(" ").includes("?token="), "令牌不能出现在查询串，会被访问日志记录");
  assert.ok(args.includes("--user-data-dir=C:\\tmp\\profile"));
  assert.ok(args.includes("--window-size=1180,820"));
});
test("健康检查成功返回运行时元信息", async (t) => {
  const dir = await temp(t);
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, version: "1.3.0" }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const { port } = server.address();
  const body = await waitForHealth({ url: `http://127.0.0.1:${port}/healthz`, timeoutMs: 5000 });
  assert.equal(body.version, "1.3.0");
  assert.equal(dir.startsWith(tmpdir()), true);
});
test("运行时就绪超时给出明确错误码", async () => {
  await assert.rejects(
    () => waitForHealth({ url: "http://127.0.0.1:1/healthz", timeoutMs: 600, intervalMs: 100 }),
    (e) => e.code === "APP_NOT_READY",
  );
});
test("日志脱敏不留下令牌明文", () => {
  const token = "tc1_abcdef";
  const output = redact(`started with token=${token} ok`, token);
  assert.ok(!output.includes(token));
  assert.match(output, /令牌已隐藏/);
  assert.equal(redact("nothing", token), "nothing");
  assert.equal(redact(undefined, token), "");
});