import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);
const bin = path.resolve(import.meta.dirname, "../bin/thu-campus.mjs");

async function withState(runInside) {
  const dir = await mkdtemp(path.join(tmpdir(), "app-link-"));
  try {
    return await runInside(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function cli(args, env) {
  try {
    const { stdout } = await run(process.execPath, [bin, ...args], { env: { ...process.env, ...env }, timeout: 30000 });
    return { code: 0, out: stdout };
  } catch (error) {
    return { code: error.code ?? 1, out: String(error.stdout || "") + String(error.stderr || "") };
  }
}

test("app link 用一次性会话码给出可用链接，输出里没有令牌", async () => {
  await withState(async stateDir => {
    const token = "fixture-link-token-value-1234567890";
    await writeFile(path.join(stateDir, "access.json"), JSON.stringify({ token }));
    const server = await import("node:http").then(({ createServer }) => createServer((req, res) => {
      if (req.url === "/api/session/exchange" && req.method === "POST") {
        assert.equal(req.headers.authorization, "Bearer " + token);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, code: "SESSION_CODE_abcdefghijklmnop", expiresAt: "2026-11-23T00:01:00.000Z", ttlSeconds: 60 }));
        return;
      }
      res.writeHead(404).end("{}");
    }));
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    try {
      const port = server.address().port;
      const { out } = await cli(["app", "link", "--url", `http://127.0.0.1:${port}`], { THU_CAMPUS_APP_STATE_DIR: stateDir, THU_CAMPUS_APP_TOKEN: "" });
      assert.doesNotMatch(out, new RegExp(token), "输出不能包含令牌");
      const payload = JSON.parse(out);
      assert.equal(payload.ok, true);
      assert.match(payload.url, /\?session=SESSION_CODE_abcdefghijklmnop$/);
      assert.equal(payload.ttlSeconds, 60);
      assert.match(payload.hint, /不含令牌/);
    } finally {
      await new Promise(resolve => server.close(resolve));
    }
  });
});

test("app link 连不上时如实说明，不泄露令牌", async () => {
  await withState(async stateDir => {
    await writeFile(path.join(stateDir, "access.json"), JSON.stringify({ token: "fixture-offline-token-0987654321" }));
    const { out } = await cli(["app", "link", "--url", "http://127.0.0.1:9"], { THU_CAMPUS_APP_STATE_DIR: stateDir, THU_CAMPUS_APP_TOKEN: "" });
    assert.doesNotMatch(out, /fixture-offline-token/);
    const payload = JSON.parse(out);
    assert.equal(payload.ok, false);
    assert.match(payload.reason, /无法连接|确认实例/);
  });
});
test("启动与状态输出不出现令牌明文", async () => {
  await withState(async stateDir => {
    const token = "fixture-status-token-abcdefghijklmno";
    await writeFile(path.join(stateDir, "access.json"), JSON.stringify({ token }));
    const status = await cli(["app", "status"], { THU_CAMPUS_APP_STATE_DIR: stateDir, THU_CAMPUS_APP_TOKEN: token });
    assert.doesNotMatch(status.out, new RegExp(token), "状态输出不得包含令牌");
    const helptext = await cli(["app", "help"], { THU_CAMPUS_APP_STATE_DIR: stateDir, THU_CAMPUS_APP_TOKEN: token });
    assert.doesNotMatch(helptext.out, new RegExp(token));
    assert.match(helptext.out, /app/);
  });
});
