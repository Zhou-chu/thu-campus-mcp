import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import path from "node:path";
import { tmpdir } from "node:os";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { appConfig } from "../lib/app/settings.mjs";
import { createModelRoute } from "../lib/app/model.mjs";
import { SessionStore, validSessionId } from "../lib/app/sessions.mjs";
import { appCommand } from "../lib/app/cli.mjs";
import { readInvite, PairingCodes } from "../lib/app/pairing.mjs";
import { createAppServer } from "../lib/app/server.mjs";
import { createModelServer } from "../lib/madmodel/server.mjs";
import { LOGIN_URL, ORIGIN } from "../lib/madmodel/protocol.mjs";
import { installUnified } from "../lib/unified-install.mjs";

const UUID = "12345678-1234-1234-1234-123456789abc";
const attacks = [
  "../outside", "..\\outside", "/tmp/outside", "C:\\outside", "..%2foutside", "..%5coutside",
  "%2e%2e%2foutside", "%252e%252e%252foutside", UUID + "/../outside", UUID + "\\..\\outside",
  UUID + "%2f..", UUID + "%5c..", UUID + "\0", UUID + "\n", UUID + "\r", UUID + "\r\n",
  UUID.toUpperCase(), "-".repeat(36), "a".repeat(36), "", undefined, null, 42, true,
  {}, [], Object(UUID), { toString: () => UUID },
];
async function temp(t) {
  const dir = await mkdtemp(path.join(tmpdir(), "campus-sonar-backend-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}
function environment(t, values) {
  for (const [name, value] of Object.entries(values)) {
    const old = process.env[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
    t.after(() => {
      if (old === undefined) delete process.env[name];
      else process.env[name] = old;
    });
  }
}
async function listen(t, server) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve, reject) => server.close((e) => e ? reject(e) : resolve()));
  });
  return "http://127.0.0.1:" + server.address().port;
}
function getStatus(url, headers = {}, method = "GET") {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { headers, method, setHost: !Object.hasOwn(headers, "Host") }, (res) => {
      res.resume();
      res.once("end", () => resolve(res.statusCode));
    });
    req.once("error", reject);
    req.end();
  });
}

test("SessionStore: traversal, encoded separators, NUL and invalid types never reach a file sink", async (t) => {
  const dir = await temp(t);
  const store = new SessionStore(dir);
  const outside = path.join(dir, "outside.json");
  await writeFile(outside, "sentinel");
  await mkdir(store.dir);
  for (const id of attacks) {
    assert.equal(validSessionId(id), false, "reject " + String(id));
    assert.throws(() => store.file(id), { code: "INVALID_SESSION" });
    await assert.rejects(store.get(id), { code: "INVALID_SESSION" });
    await assert.rejects(store.remove(id), { code: "INVALID_SESSION" });
  }
  assert.deepEqual(await readdir(store.dir), []);
  assert.equal(await readFile(outside, "utf8"), "sentinel");
});

test("SessionStore: canonical UUID operations persist, reload and delete only their JSON file", async (t) => {
  const dir = await temp(t);
  const store = new SessionStore(dir, { maxMessages: 2 });
  await store.save({ id: UUID, title: "new", messages: [], createdAt: "2026-01-01" });
  assert.equal(store.file(UUID), path.join(store.dir, UUID + ".json"));
  await store.append(UUID, [{ role: "user", content: "one" }, { role: "user", content: "two" }, { role: "user", content: "three" }]);
  assert.equal((await store.rename(UUID, "renamed")).title, "renamed");
  const disk = new SessionStore(dir);
  const loaded = await disk.get(UUID);
  assert.deepEqual(loaded.messages.map((m) => m.content), ["two", "three"]);
  loaded.messages.pop();
  assert.equal((await disk.get(UUID)).messages.length, 2);
  assert.equal((await disk.list())[0].id, UUID);
  assert.equal(await disk.remove(UUID), true);
  assert.equal(await disk.get(UUID), undefined);
  assert.equal(await disk.remove(UUID), false);
  assert.equal(validSessionId((await disk.create()).id), true);
});

test("session HTTP source rejects encoded traversal before Store read/delete", async (t) => {
  const dir = await temp(t);
  const sessions = new SessionStore(dir);
  const session = await sessions.create();
  const app = createAppServer({
    config: { root: path.resolve(import.meta.dirname, ".."), host: "127.0.0.1", port: 0, stateDir: dir, token: "test-only", modelRoute: "openai", hostname: "test-host" },
    host: { describe: () => [] }, route: { route: "openai" }, sessions,
    pairing: new PairingCodes(), devices: {}, webuiDir: path.join(dir, "webui"),
  });
  const base = await app.listen();
  t.after(() => app.close());
  const headers = { Authorization: "Bearer test-only" };
  for (const id of ["..%2foutside", "..%5coutside", "%2e%2e%2foutside", "%252e%252e%252foutside", session.id + "%00", session.id + "%0a"]) {
    for (const method of ["GET", "DELETE"]) {
      assert.equal(await getStatus(base + "/api/sessions/" + id, headers, method), 404);
    }
  }
  assert.equal(await getStatus(base + "/api/sessions/" + session.id, headers), 200);
  assert.equal(await getStatus(base + "/api/sessions/" + session.id, headers, "DELETE"), 200);
  assert.equal(await sessions.get(session.id), undefined);
});

test("URL tails: public URL removes only trailing slashes with long and interior runs preserved", () => {
  for (const [input, expected] of [
    ["", ""], ["https://example.test/v1", "https://example.test/v1"],
    ["https://example.test/a//b///", "https://example.test/a//b"],
    ["/".repeat(100000), ""], ["https://example.test/" + "/".repeat(100000) + "x", "https://example.test/" + "/".repeat(100000) + "x"],
    ["https://example.test/ \n", "https://example.test/ \n"],
  ]) {
    assert.equal(appConfig({ THU_CAMPUS_APP_PUBLIC_URL: input }).publicUrl, expected);
  }
});

test("OpenAI base normalization preserves headers, bodies, abort signal and failure contract without external requests", async (t) => {
  const seen = [];
  t.mock.method(globalThis, "fetch", async (url, options) => {
    seen.push({ url, options });
    return url.endsWith("/models") ? Response.json({ data: ["model-a"] }) : Response.json({ ok: true });
  });
  const route = createModelRoute({ modelRoute: "openai", modelBaseUrl: "https://model.test/a//v1" + "/".repeat(100000), modelApiKey: "test-only" });
  assert.deepEqual(await route.models(), [{ id: "model-a", label: "model-a" }]);
  const body = { model: "model-a", messages: [{ role: "user", content: "fixture" }], stream: true };
  const signal = new AbortController().signal;
  await route.chat(body, { signal });
  assert.deepEqual(seen.map((x) => x.url), ["https://model.test/a//v1/models", "https://model.test/a//v1/chat/completions"]);
  assert.equal(seen[1].options.headers.Authorization, "Bearer test-only");
  assert.equal(seen[1].options.body, JSON.stringify(body));
  assert.equal(seen[1].options.signal, signal);
  assert.throws(() => createModelRoute({ modelRoute: "openai", modelBaseUrl: "/".repeat(100000) }), { code: "MODEL_NOT_CONFIGURED" });
  t.mock.method(globalThis, "fetch", async () => Response.json({}, { status: 503 }));
  assert.deepEqual(await route.models(), []);
  await assert.rejects(route.models({ strict: true }), { code: "MODEL_DISCOVERY_FAILED" });
  await assert.rejects(route.chat(body), { code: "MODEL_FAILED" });
});

test("CLI invite uses secure randomness and keeps six-digit, five-minute offline invite contract", async (t) => {
  const dir = await temp(t);
  environment(t, { THU_CAMPUS_APP_STATE_DIR: dir, THU_CAMPUS_APP_HOST: "127.0.0.1", THU_CAMPUS_APP_TOKEN: "", THU_CAMPUS_APP_MODEL_ROUTE: "openai", THU_CAMPUS_APP_PORT: "8971" });
  t.mock.method(Math, "random", () => { throw new Error("insecure RNG must not be used"); });
  t.mock.method(globalThis, "fetch", async (url) => {
    assert.equal(url, "http://127.0.0.1:8971/healthz");
    return Response.json({ ok: true });
  });
  let output = "";
  t.mock.method(process.stdout, "write", (text) => { output += text; return true; });
  const before = Date.now();
  await appCommand(["invite", "--json"]);
  const after = Date.now();
  const result = JSON.parse(output);
  assert.match(result.code, /^\d{6}$/);
  assert.equal(result.ttlSeconds, 300);
  assert.equal(result.runtimeReachable, true);
  const saved = readInvite(dir);
  assert.equal(saved.code, result.code);
  assert(saved.expiresAt >= before + 300000 && saved.expiresAt <= after + 300000);
  assert.equal(new Date(saved.expiresAt).toISOString(), result.expiresAt);
});

test("unified installer trims long trailing whitespace without changing other TOML or tool policy", async (t) => {
  const dir = await temp(t);
  environment(t, {
    THU_BROWSER_STATE_DIR: path.join(dir, "browser"),
    LEARNX_STATE_DIR: path.join(dir, "learnx"), LEARNX_OUTPUT_DIR: path.join(dir, "learnx-output"),
    THU_CLOUD_STATE_DIR: path.join(dir, "cloud"), THU_CLOUD_OUTPUT_DIR: path.join(dir, "cloud-output"),
    HETANG_STATE_DIR: path.join(dir, "hetang"), HETANG_OUTPUT_DIR: path.join(dir, "hetang-output"),
  });
  const home = path.join(dir, "home");
  const harnessHome = path.join(dir, "harness");
  await mkdir(path.join(home, ".codex"), { recursive: true });
  const file = path.join(home, ".codex/config.toml");
  const prefix = '# keep comment\n[model]\nname = "fixture"\n';
  await writeFile(file, prefix + " \t\r\n".repeat(25000));
  const result = await installUnified({ apply: true, home, harnessHome });
  assert.equal(result.apply, true);
  const text = await readFile(file, "utf8");
  assert(text.startsWith(prefix.trimEnd() + "\n\n[mcp_servers."));
  assert(text.includes("tool_timeout_sec = 180"));
  await installUnified({ apply: true, home, harnessHome });
  assert.equal(await readFile(file, "utf8"), text);
});

test("public SSO application identifier remains the upstream-compatible fixed MD5 route over HTTPS", () => {
  assert.equal(ORIGIN, "https://madmodel.cs.tsinghua.edu.cn");
  const url = new URL(LOGIN_URL);
  assert.equal(url.protocol, "https:");
  assert.equal(url.hostname, "id.tsinghua.edu.cn");
  assert.equal(url.pathname, "/do/off/ui/auth/login/form/d736f067a6705ab942df52f958a0f23b/0");
  assert.equal(url.search, "?/authLogin");
});

test("Host URL parsing has no outbound sink and rejects hostile Host/Origin before fake model calls", async (t) => {
  t.mock.method(globalThis, "fetch", () => { throw new Error("Host parsing must not fetch"); });
  let calls = 0;
  const server = createModelServer({
    config: { host: "127.0.0.1", apiKey: "", maxBodyBytes: 1024 },
    client: { models: async () => { calls++; return { object: "list", data: [] }; } },
  });
  const base = await listen(t, server);
  for (const Host of ["evil.example", "127.0.0.1.evil.example", "[::ffff:127.0.0.1]", "not a host", "", "evil.example@evil.example"]) {
    assert.equal(await getStatus(base + "/v1/models", { Host }), 403, "Host=" + JSON.stringify(Host));
  }
  assert.equal(await getStatus(base + "/v1/models", { Origin: "https://evil.example" }), 403);
  assert.equal(calls, 0);
  for (const Host of ["localhost", "127.0.0.1", "[::1]"]) {
    assert.equal(await getStatus(base + "/v1/models", { Host }), 200);
  }
  assert.equal(calls, 3);
});
