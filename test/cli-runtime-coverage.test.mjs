import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { registerHooks } from "node:module";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { setImmediate as nextTurn } from "node:timers/promises";
import * as settings from "../lib/app/settings.mjs";

const root = path.resolve(import.meta.dirname, "..");
const temporaryRoot = path.join(root, ".local", "qa-temp");
const originalExitCode = process.exitCode;
const outputs = new WeakMap();
const signalContexts = new WeakMap();
let serial = 0;

// Only dependencies are replaced. The target URL is imported unchanged from disk
// (apart from a cache-isolation query); no production source is copied or transformed.
async function realModule(t, target, dependencies = {}) {
  const key = "__campusRuntimeUnit" + serial++;
  const values = Object.values(dependencies);
  const urls = new Map(Object.keys(dependencies).map((name, i) => {
    const url = name.startsWith("lib/") ? new URL("../" + name, import.meta.url).href : name;
    const source = Object.keys(values[i]).map((name) => name === "default"
      ? `export default globalThis[${JSON.stringify(key)}][${i}].default;`
      : `export const ${name}=globalThis[${JSON.stringify(key)}][${i}][${JSON.stringify(name)}];`).join("\n");
    return [url, "data:text/javascript," + encodeURIComponent(source)];
  }));
  globalThis[key] = values;
  const hook = registerHooks({
    resolve(specifier, context, resolve) {
      const canonical = specifier.startsWith(".") || specifier.startsWith("file:") ? new URL(specifier, context.parentURL).href : specifier;
      return urls.has(canonical) ? { url: urls.get(canonical), shortCircuit: true } : resolve(specifier, context);
    },
  });
  t.after(() => { hook.deregister(); delete globalThis[key]; });
  return import(new URL("../" + target + "?unit=" + key, import.meta.url));
}
async function ownedDirectory(t) {
  await mkdir(temporaryRoot, { recursive: true });
  const dir = await mkdtemp(path.join(temporaryRoot, "cli-runtime-"));
  assert(dir.startsWith(temporaryRoot + path.sep));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}
function output(t) {
  if (outputs.has(t)) { const io = outputs.get(t); io.clear(); return io; }
  process.exitCode = undefined;
  t.after(() => { process.exitCode = originalExitCode; });
  const io = { out: "", err: "" };
  const text = (chunk) => typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
  t.mock.method(process.stdout, "write", (chunk) => { io.out += text(chunk); return true; });
  t.mock.method(process.stderr, "write", (chunk) => { io.err += text(chunk); return true; });
  io.clear = () => { io.out = ""; io.err = ""; process.exitCode = undefined; };
  io.json = () => JSON.parse(io.out);
  outputs.set(t, io);
  return io;
}
function signalHandlers(t) {
  if (signalContexts.has(t)) { const handlers = signalContexts.get(t); handlers.clear(); return handlers; }
  const handlers = new Map();
  signalContexts.set(t, handlers);
  const on = process.on, off = process.off;
  t.mock.method(process, "on", function (event, listener) {
    if (["SIGINT", "SIGTERM"].includes(event)) { handlers.set(event, listener); return this; }
    return on.call(this, event, listener);
  });
  t.mock.method(process, "off", function (event, listener) {
    if (["SIGINT", "SIGTERM"].includes(event)) { handlers.delete(event); return this; }
    return off.call(this, event, listener);
  });
  return handlers;
}
async function settled(predicate) {
  for (let turn = 0; turn < 20 && !predicate(); turn++) await nextTurn();
  assert(predicate(), "controlled asynchronous callback must complete");
}
function fakeChild(onSpawn, event = "exit", value = 0) {
  const child = new EventEmitter();
  child.killed = false;
  child.kill = (signal) => { child.killed = true; child.signal = signal; };
  child.unref = () => { child.unreferenced = true; };
  onSpawn(child);
  queueMicrotask(() => { if (child.listenerCount(event)) child.emit(event, value); });
  return child;
}
async function appFixture(t) {
  const dir = await ownedDirectory(t);
  const h = {
    io: output(t), signals: signalHandlers(t), calls: [], lans: ["http://192.0.2.1:8971"],
    config: { root, stateDir: dir, host: "127.0.0.1", port: 8971, token: "", tlsCert: "", tlsKey: "", publicUrl: "", modelRoute: "openai", modelBaseUrl: "https://unit.invalid/v1", keepAliveMinutes: 5, keepAliveRestore: true, workspaceStorage: "local", sandboxPythonImage: "unused-python", sandboxNodeImage: "unused-node" },
    free: { free: true }, devices: [{ id: "unit-device" }], spawnEvent: "exit", spawnValue: 0,
  };
  h.host = { close: async () => { h.calls.push(["host.close"]); } };
  h.route = { status: async () => { if (h.statusError) throw h.statusError; return { available: true }; } };
  h.keep = {
    start: () => h.calls.push(["keep.start"]), stop: () => h.calls.push(["keep.stop"]),
    runOnce: async (why) => { h.calls.push(["keep.runOnce", why]); if (h.keepError) throw h.keepError; return { actions: ["unit-action"] }; },
  };
  h.app = { listen: async () => { if (h.listenError) throw h.listenError; return "http://127.0.0.1:8971"; }, close: async () => { h.calls.push(["app.close"]); } };
  t.mock.method(globalThis, "fetch", async (...args) => { h.calls.push(["fetch", ...args]); if (h.fetchError) throw h.fetchError; return h.response || Response.json({ ok: true }); });
  t.mock.method(process, "exit", (code) => { h.exit = code; });
  const service = {
    DEFAULT_TASK: "UnitTask", wrapperContent: (options) => { h.calls.push(["wrapper", options]); return JSON.stringify(options); },
    installTask: async (options) => { h.calls.push(["installTask", options]); if (h.installError) throw h.installError; return { wrapperPath: options.wrapperPath }; },
    uninstallTask: async (options) => { h.calls.push(["uninstallTask", options]); if (h.uninstallError) throw h.uninstallError; return { removed: true }; },
    taskStatus: async () => ({ installed: true }), startTask: async () => ({ started: true }),
    startupEntryPath: () => path.join(dir, "startup.cmd"),
    installStartup: (options) => h.calls.push(["installStartup", options]),
    uninstallStartup: () => ({ removed: true }), startupStatus: () => ({ installed: false }),
    wrapperMismatch: (a, b) => a !== b, readWrapperPort: () => 9000,
    explainFailure: (e) => e,
  };
  const module = await realModule(t, "lib/app/cli.mjs", {
    "lib/app/settings.mjs": { ...settings, appConfig: () => ({ ...h.config }), packageVersion: async () => "unit-version", lanUrls: () => h.lans },
    "lib/app/devices.mjs": { DeviceStore: class {
      constructor(stateDir) { assert.equal(stateDir, dir); }
      async list() { if (h.deviceError) throw h.deviceError; return h.devices; }
      async revoke(id) { h.calls.push(["revoke", id]); return id === "unit-device"; }
    } },
    "lib/app/pairing.mjs": { PairingCodes: class { issue() { return { code: "012345", ttlSeconds: 300 }; } }, writeInvite: (stateDir, value) => { assert.equal(stateDir, dir); h.invite = value; } },
    "lib/app/runtime-state.mjs": { readRuntime: () => h.running, writeRuntime: (stateDir, value) => { assert.equal(stateDir, dir); h.runtime = value; }, clearRuntime: () => { h.runtime = undefined; } },
    "lib/app/states.mjs": { createServiceProbe: (host) => { assert.equal(host, h.host); return "unit-probe"; } },
    "lib/app/keepalive.mjs": { createKeepAlive: (options) => { h.keepOptions = options; return h.keep; } },
    "lib/app/service.mjs": service,
    "lib/app/sessions.mjs": { SessionStore: class { constructor(stateDir) { assert.equal(stateDir, dir); } } },
    "lib/app/model.mjs": { createModelRoute: () => h.route, assertPortFree: async (port, host) => { h.calls.push(["port", port, host]); return h.free; } },
    "lib/app/host.mjs": { ToolHost: { start: async () => { if (h.hostError) throw h.hostError; return h.host; } } },
    "lib/app/workspace.mjs": { createWorkspaceHost: (options) => { h.workspaceOptions = options; if (h.workspaceError) throw h.workspaceError; return h.host; } },
    "lib/app/server.mjs": { createAppServer: (options) => { h.appOptions = options; return h.app; } },
    "node:child_process": { spawn: (...args) => fakeChild((child) => h.calls.push(["spawn", args, child]), h.spawnEvent, h.spawnValue) },
  });
  h.command = module.appCommand;
  return h;
}

test("app CLI validates flags, reports owned status/devices, and handles invite transport outcomes", async (t) => {
  const h = await appFixture(t);
  for (const args of [[], ["help"], ["--help"], ["-h"]]) { await h.command(args); assert.match(h.io.out, /app serve/); h.io.clear(); }
  for (const port of ["0", "65536", "no-port"]) await assert.rejects(h.command(["status", "--port", port]), { code: "USAGE" });
  await assert.rejects(h.command(["status", "--host", "0.0.0.0"]), { code: "INSECURE_LISTEN" });
  await assert.rejects(h.command(["unknown"]), { code: "USAGE" });
  await h.command(["devices"]); assert.deepEqual(h.io.json().devices, h.devices); h.io.clear();
  await h.command(["devices", "--revoke", "unit-device"]); assert.equal(h.io.json().ok, true); h.io.clear();
  await h.command(["status", "ignored", "--port", "9001", "--host", "localhost"]);
  assert.equal(h.io.json().port, 9001); assert.equal(h.io.json().stateDir, h.config.stateDir); assert.equal(h.io.json().model.available, true); h.io.clear();
  h.config.modelRoute = "madmodel"; h.statusError = new Error("fixture"); h.deviceError = new Error("fixture");
  await h.command(["status"]); assert.deepEqual(h.io.json().model, { route: "madmodel", available: false }); assert.deepEqual(h.io.json().devices, []); h.io.clear();
  h.config.token = "unit-token"; h.config.host = "0.0.0.0";
  h.response = Response.json({ code: "unit-invite" }); await h.command(["invite"]); assert.equal(h.io.json().code, "unit-invite");
  assert.equal(h.calls.findLast((c) => c[0] === "fetch")[2].headers.Authorization, "Bearer unit-token"); h.io.clear();
  h.response = Response.json({}, { status: 403 }); await h.command(["invite"]); assert.equal(h.io.json().error.code, "APP_NOT_RUNNING"); assert.equal(process.exitCode, 1); h.io.clear();
  h.fetchError = new Error("offline"); await h.command(["invite"]); assert.equal(h.io.json().ok, false); h.io.clear();
  h.config.token = ""; h.config.host = "127.0.0.1"; h.running = { host: "0.0.0.0", port: 9010, pid: 123, publicUrl: h.lans[0] };
  await h.command(["invite"]); assert.equal(h.io.json().runtimeReachable, false); assert.equal(h.io.json().runtime.pid, 123); assert.equal(h.io.json().lanUrls.length, 1); assert.match(h.invite.code, /^\d{6}$/); h.io.clear();
  h.fetchError = undefined; h.response = Response.json({}); h.running = undefined;
  await h.command(["invite"]); assert.equal(h.io.json().runtime, null); assert.equal(h.io.json().runtimeReachable, true);
});

test("app service CLI delegates only to mocks and reports install/access/cleanup/drift contracts", async (t) => {
  const h = await appFixture(t);
  await h.command(["service", "install", "--startup"]); assert.equal(h.io.json().mode, "startup-folder"); assert.equal(h.calls.find((c) => c[0] === "installStartup")[1].entryPath, path.join(h.config.stateDir, "startup.cmd")); h.io.clear();
  await h.command(["service", "install", "--port", "9000", "--host", "localhost"]); assert.equal(h.io.json().port, 9000); assert.equal(h.io.json().mode, "scheduled-task"); assert.match(h.io.json().note, /不一致/); h.io.clear();
  await h.command(["service", "install"]); assert.match(h.io.json().note, /不需要管理员/); h.io.clear();
  h.installError = Object.assign(new Error("denied"), { code: "SERVICE_ACCESS_DENIED" });
  await h.command(["service", "install"]); assert.equal(h.io.json().error.code, "SERVICE_ACCESS_DENIED"); h.io.clear();
  h.installError = Object.assign(new Error("broken"), { code: "SERVICE_FAILED" });
  await assert.rejects(h.command(["service", "install"]), { code: "SERVICE_FAILED" });
  await h.command(["service", "start"]); assert.equal(h.io.json().started, true); h.io.clear();
  await h.command(["service"]); assert.equal(h.io.json().installed, true); assert.equal(h.io.json().wrapper, null); h.io.clear();
  const wrapper = path.join(h.config.stateDir, "service-run.cmd"); await writeFile(wrapper, "unit-stale-wrapper");
  await h.command(["service", "status"]); assert.equal(h.io.json().wrapper.port, 9000); assert.equal(h.io.json().wrapper.expectedPort, 8971); assert.equal(h.io.json().wrapper.drift, true); assert.match(h.io.json().hint, /不一致/); h.io.clear();
  await h.command(["service", "uninstall"]); assert.equal(h.io.json().taskRemoved, true); assert.equal(h.io.json().startupRemoved, true); assert.equal(h.io.json().wrapperPath, wrapper); h.io.clear();
  h.uninstallError = new Error("missing task"); await h.command(["service", "uninstall"]); assert.equal(h.io.json().taskRemoved, false); h.io.clear();
  await assert.rejects(h.command(["service", "unsupported"]), { code: "USAGE" });
});

test("app serve failures close acquired hosts and preserve useful error codes without starting services", async (t) => {
  const h = await appFixture(t);
  for (const code of ["APP_PORT_BUSY", "EACCES"]) { h.free = { free: false, code }; await assert.rejects(h.command(["serve"]), { code: code === "APP_PORT_BUSY" ? code : "APP_PORT_ERROR" }); }
  h.free = { free: true };
  for (const code of ["ERR_MODULE_NOT_FOUND", "EIO"]) { h.hostError = Object.assign(new Error("fixture"), { code }); await assert.rejects(h.command(["serve"]), { code: "APP_HOST_FAILED" }); }
  h.hostError = undefined; h.workspaceError = new Error("MODULE_NOT_FOUND fixture"); await assert.rejects(h.command(["serve"]), /尚未构建/); h.workspaceError = undefined;
  h.config.tlsCert = path.join(h.config.stateDir, "cert.pem"); h.config.tlsKey = path.join(h.config.stateDir, "key.pem");
  await assert.rejects(h.command(["serve"]), { code: "TLS_UNREADABLE" });
  await writeFile(h.config.tlsCert, ""); await writeFile(h.config.tlsKey, ""); await assert.rejects(h.command(["serve"]), { code: "TLS_UNREADABLE" });
  await writeFile(h.config.tlsCert, "unit-cert"); await writeFile(h.config.tlsKey, "unit-key");
  for (const code of ["EADDRINUSE", "EACCES"]) { h.listenError = Object.assign(new Error("fixture"), { code }); await assert.rejects(h.command(["serve"]), { code: "APP_LISTEN_FAILED" }); }
  assert.equal(h.appOptions.tls.cert.toString(), "unit-cert"); assert(h.calls.filter((c) => c[0] === "host.close").length >= 4);
});

test("app serve real startup/shutdown wires fake keepalive, private workspace and restore process outcomes", async (t) => {
  const h = await appFixture(t);
  let failure;
  void h.command(["serve", "--open"]).catch((error) => { failure = error; });
  await settled(() => h.signals.has("SIGTERM") || failure); assert.equal(failure, undefined);
  assert.equal(h.runtime.version, "unit-version"); assert.equal(h.workspaceOptions.stateDir, h.config.stateDir); assert.equal(h.workspaceOptions.storageMode, "local");
  assert.equal(h.keepOptions.intervalMs, 300000); assert.equal(h.keepOptions.restoreExpired, true); assert.match(h.io.out, /首次配对码：012345/); assert.match(h.io.out, /keepalive-startup/);
  assert.equal(h.calls.find((c) => c[0] === "spawn")[2].unreferenced, true);
  h.keepOptions.logger("unit-keep", { safe: true }); h.appOptions.logger("unit-app", { safe: true }); assert.match(h.io.err, /unit-keep/); assert.match(h.io.err, /unit-app/);
  assert.deepEqual(await h.keepOptions.restore("learnx"), { ok: true });
  h.spawnValue = 1; assert.deepEqual(await h.keepOptions.restore("cloud"), { ok: false, code: "RESTORE_FAILED" });
  h.spawnEvent = "error"; h.spawnValue = new Error("fixture"); assert.deepEqual(await h.keepOptions.restore("hetang"), { ok: false, code: "RESTORE_FAILED" });
  h.signals.get("SIGTERM")(); await settled(() => h.exit === 0);
  assert.equal(h.runtime, undefined); assert(h.calls.some((c) => c[0] === "keep.stop")); assert(h.calls.some((c) => c[0] === "app.close")); assert(h.calls.some((c) => c[0] === "host.close"));
});

test("remote app startup warns about plaintext and survives a failed initial keepalive", async (t) => {
  const h = await appFixture(t); h.config.host = "0.0.0.0"; h.config.token = "unit-token"; h.config.publicUrl = "https://unit.invalid"; h.keepError = new Error("fixture");
  let failure; void h.command(["serve"]).catch((error) => { failure = error; });
  await settled(() => h.signals.has("SIGINT") || failure); assert.equal(failure, undefined);
  assert.match(h.io.err, /app-insecure-remote/); assert.equal(h.runtime.publicUrl, "https://unit.invalid"); assert.doesNotMatch(h.io.out, /首次配对码/);
  h.signals.get("SIGINT")(); await settled(() => h.exit === 0);
});

test("ToolHost normalizes payloads, tool metadata, validation and failures using an injected client", async (t) => {
  const { ToolHost, serviceOf } = await realModule(t, "lib/app/host.mjs");
  assert.deepEqual(["learn_status", "cloud_get", "rain_list", "madmodel_chat", "campus_browser_open", "other_tool"].map(serviceOf), ["learnx", "cloud", "hetang", "madmodel", "browser", "campus"]);
  let listing = [{ name: "learn_read", description: "x".repeat(1100), annotations: { readOnlyHint: true } }, { name: "cloud_write", annotations: { destructiveHint: true } }], response = {}, thrown, refreshError;
  const calls = [];
  const client = { listTools: async () => { if (refreshError) throw refreshError; return { tools: listing }; }, callTool: async (...args) => { calls.push(args); if (thrown) throw thrown; return response; }, close: async () => { throw new Error("already closed"); } };
  const host = new ToolHost({ client, timeoutMs: 321 }); await host.refresh();
  assert.equal(host.describe()[0].service, "learnx"); assert.equal(host.describe()[0].readOnly, true); assert.equal(host.describe()[1].destructive, true); assert.deepEqual(host.describe()[1].inputSchema, { type: "object", properties: {} });
  assert.equal(host.toolForModel()[0].function.description.length, 1024); assert.equal(host.toolForModel()[1].function.description, "");
  for (const name of [null, "../evil", "x", "Bad"]) assert.equal((await host.call(name)).error.code, "INVALID_TOOL");
  for (const args of [null, [], "x"]) assert.equal((await host.call("learn_read", args)).error.code, "INVALID_ARGUMENTS");
  assert.equal((await host.call("unknown_tool")).error.code, "UNKNOWN_TOOL"); refreshError = new Error("list failed"); assert.equal((await host.call("unknown_tool")).error.code, "UNKNOWN_TOOL"); refreshError = undefined;
  for (const [value, expected] of [[{ structuredContent: { n: 1 } }, { n: 1 }], [{ content: [{ type: "text", text: '{"n":2}' }] }, { n: 2 }], [{ content: [{ type: "text", text: "plain" }] }, { text: "plain" }], [{}, {}]]) { response = value; assert.deepEqual(await host.call("learn_read", { a: 1 }), { ok: true, data: expected }); }
  assert.deepEqual(calls[0], [{ name: "learn_read", arguments: { a: 1 } }, undefined, { timeout: 321 }]);
  response = { isError: true, structuredContent: { code: "AUTH_REQUIRED", message: "unit" } }; assert.deepEqual((await host.call("learn_read")).error, { code: "AUTH_REQUIRED", message: "unit" });
  response = { isError: true, structuredContent: { code: "unsafe-code" } }; assert.equal((await host.call("learn_read")).error.code, "TOOL_FAILED");
  for (const code of ["AUTH_EXPIRED", "bad-code"]) { thrown = Object.assign(new Error("secret not leaked"), { code }); const result = await host.call("learn_read"); assert.equal(result.error.code, code === "AUTH_EXPIRED" ? code : "TOOL_FAILED"); assert.doesNotMatch(result.error.message, /secret/); }
  thrown = undefined; listing = undefined; assert.deepEqual(await host.refresh(), []); await host.close();
});

test("ToolHost.start wires owned environment and drains mocked transport stderr before discovery", async (t) => {
  const dir = await ownedDirectory(t), calls = [];
  const { ToolHost } = await realModule(t, "lib/app/host.mjs", {
    "@modelcontextprotocol/sdk/client/index.js": { Client: class { constructor(info) { calls.push(["client", info]); } async connect(transport) { calls.push(["connect", transport]); } async listTools() { return { tools: [{ name: "unit_tool" }] }; } } },
    "@modelcontextprotocol/sdk/client/stdio.js": { StdioClientTransport: class { constructor(options) { this.options = options; this.stderr = { resume: () => calls.push(["resume"]) }; } } },
    "lib/services.mjs": { root, serviceEnvironment: (env) => ({ ...env, UNIT_ONLY: "1" }) },
  });
  const host = await ToolHost.start({ env: { UNIT_STATE: dir }, timeoutMs: 99 });
  assert.equal(host.timeoutMs, 99); assert.equal(host.tools[0].name, "unit_tool");
  assert.deepEqual(calls.find((c) => c[0] === "connect")[1].options.env, { UNIT_STATE: dir, UNIT_ONLY: "1" }); assert(calls.findIndex((c) => c[0] === "resume") < calls.findIndex((c) => c[0] === "connect"));
});

async function gatewayFixture(t, { duplicate = false, failedConnect = false } = {}) {
  const h = { clients: [], handlers: new Map(), calls: [], restored: true };
  const schemaNames = ["ListToolsRequestSchema", "CallToolRequestSchema", "ListPromptsRequestSchema", "GetPromptRequestSchema"];
  const sdkTypes = Object.fromEntries(schemaNames.map((name) => [name, name]));
  const mod = await realModule(t, "lib/gateway.mjs", {
    "@modelcontextprotocol/sdk/server/index.js": { Server: class { constructor(info, capabilities) { h.server = this; h.info = info; h.capabilities = capabilities; } setRequestHandler(schema, handler) { h.handlers.set(schema, handler); } async connect(transport) { h.transport = transport; } } },
    "@modelcontextprotocol/sdk/server/stdio.js": { StdioServerTransport: class {} },
    "@modelcontextprotocol/sdk/client/index.js": { Client: class {
      constructor() { this.index = h.clients.length; h.clients.push(this); }
      async connect(transport) { this.transport = transport; if (failedConnect) throw new Error("connect fixture"); }
      async listTools() { return { tools: [{ name: this.index && !duplicate ? "cloud_write" : "learn_read", annotations: { readOnlyHint: this.index === 0 } }] }; }
      getServerCapabilities() { return this.index ? {} : { prompts: {} }; }
      async listPrompts() { return { prompts: [{ name: "unit_prompt" }] }; }
      async getPrompt(args) { h.calls.push(["prompt", args]); return { messages: [] }; }
      async callTool(...args) { h.calls.push(["tool", ...args]); if (h.toolError) throw h.toolError; return h.toolResults?.shift() || { structuredContent: { ok: true } }; }
      async close() { this.closed = true; }
    } },
    "@modelcontextprotocol/sdk/client/stdio.js": { StdioClientTransport: class { constructor(options) { this.options = options; } } },
    "@modelcontextprotocol/sdk/types.js": sdkTypes,
    "lib/services.mjs": { services: [{ name: "learnx" }, { name: "cloud" }], modulePath: (service) => "unit/" + service.name, serviceEnvironment: () => ({ UNIT_ONLY: "1" }) },
    "lib/madmodel/mcp.mjs": { madmodelTools: [{ name: "madmodel_unit" }], callMadmodelTool: async (name, args) => ({ name, args }) },
    "lib/browser.mjs": {
      browserOverview: async () => { if (h.browserError) throw h.browserError; return { running: false }; },
      startBrowserJob: async (...args) => { h.calls.push(["browser", ...args]); return { id: "unit-job" }; },
      closeBrowserJobs: async () => ({ closed: true }),
      restoreService: async (service) => { h.calls.push(["restore", service]); return h.restored; },
    },
  });
  h.mod = mod;
  h.call = (name, args) => h.handlers.get("CallToolRequestSchema")({ params: { name, ...(args === undefined ? {} : { arguments: args }) } });
  return h;
}

test("gateway registers real handlers, delegates tools/prompts and rejects browser credential-shaped input", async (t) => {
  const h = await gatewayFixture(t); await h.mod.serveGateway();
  assert.equal(h.info.name, "thu-campus-mcp"); assert.equal(h.clients[0].transport.options.stderr, "pipe");
  const listed = await h.handlers.get("ListToolsRequestSchema")(); assert.equal(listed.tools.length, 17); assert(listed.tools.some((tool) => tool.name === "campus_browser_login"));
  assert.deepEqual((await h.handlers.get("ListPromptsRequestSchema")()).prompts, [{ name: "unit_prompt" }]);
  assert.deepEqual(await h.handlers.get("GetPromptRequestSchema")({ params: { name: "unit_prompt", arguments: { x: "1" } } }), { messages: [] });
  await assert.rejects(h.handlers.get("GetPromptRequestSchema")({ params: { name: "missing" } }), /Unknown prompt/);
  assert.deepEqual((await h.call("madmodel_unit", { unit: true })).structuredContent, { name: "madmodel_unit", args: { unit: true } });
  for (const args of [null, [], { password: "not-a-secret" }, { service: "foreign" }, { account: 1 }, { account: " " }, { account: "x".repeat(129) }, {}]) assert.equal((await h.call("campus_browser_login", args)).structuredContent.code, "INVALID_ARGUMENTS");
  assert.equal((await h.call("campus_browser_status")).structuredContent.running, false);
  assert.equal((await h.call("campus_browser_open")).structuredContent.id, "unit-job");
  await h.call("campus_browser_login", { service: "learnx", account: "unit-only" });
  assert.deepEqual(h.calls.findLast((c) => c[0] === "browser"), ["browser", "login", "learnx", "unit-only"]);
  assert.equal((await h.call("campus_browser_close")).structuredContent.closed, true);
  assert.equal((await h.call("missing_tool")).isError, true);
  assert.equal((await h.call("learn_read", { x: 1 })).structuredContent.ok, true);
  assert.deepEqual(h.calls.findLast((c) => c[0] === "tool").slice(1), [{ name: "learn_read", arguments: { x: 1 } }, undefined, { timeout: 180000 }]);
  for (const code of ["BROWSER_BUSY", "unsafe-code"]) { h.browserError = Object.assign(new Error("secret fixture"), { code }); const reply = await h.call("campus_browser_status"); assert.equal(reply.structuredContent.code, code === "BROWSER_BUSY" ? code : "GATEWAY_ERROR"); assert.doesNotMatch(reply.content[0].text, /secret/); }
  h.server.onclose(); await nextTurn(); assert(h.clients.every((client) => client.closed));
});

test("gateway recovers reads once, never repeats writes, and closes clients on duplicate/connect failure", async (t) => {
  const h = await gatewayFixture(t); await h.mod.serveGateway();
  h.toolResults = [{ isError: true, structuredContent: { code: "AUTH_REQUIRED" } }, { structuredContent: { replayed: true } }];
  assert.equal((await h.call("learn_read")).structuredContent.replayed, true); assert.equal(h.calls.filter((c) => c[0] === "restore").length, 1);
  h.toolResults = [{ isError: true, structuredContent: { code: "AUTH_EXPIRED" } }];
  assert.equal((await h.call("cloud_write")).isError, true); assert.equal(h.calls.filter((c) => c[0] === "restore").length, 1);
  const bad = { isError: true, content: [{ type: "text", text: "not-json" }] };
  assert.equal(await h.mod.invokeWithRecovery({ annotations: { readOnlyHint: true } }, async () => bad, async () => { throw new Error("must not recover malformed payload"); }), bad);
  const absent = { isError: true }; assert.equal(await h.mod.invokeWithRecovery({ annotations: { readOnlyHint: true } }, async () => absent, async () => true), absent);
  const duplicate = await gatewayFixture(t, { duplicate: true }); await assert.rejects(duplicate.mod.serveGateway(), /Duplicate/); assert(duplicate.clients.every((client) => client.closed));
  const failed = await gatewayFixture(t, { failedConnect: true }); await assert.rejects(failed.mod.serveGateway(), /connect fixture/); assert(failed.clients.every((client) => client.closed));
});

test("model routes normalize mocked catalogs, preserve abort and sanitize failures/status without real accounts", async (t) => {
  const dir = await ownedDirectory(t);
  const h = { list: { data: ["plain", { id: "id", name: "label" }, { id: 7, label: "seven" }, null] }, status: { configured: true, expiresAt: "unit-expiry" }, data: {} };
  const { createModelRoute } = await realModule(t, "lib/app/model.mjs", {
    "lib/madmodel/config.mjs": { loadConfig: () => ({ stateDir: dir }) },
    "lib/madmodel/auth.mjs": { SessionStore: class { constructor(stateDir) { assert.equal(stateDir, dir); } async load() { if (h.loadError) throw h.loadError; return { data: h.data }; } } },
    "lib/madmodel/client.mjs": { MadModelClient: class { constructor(options) { h.options = options; this.manager = { status: async () => { if (h.statusError) throw h.statusError; return h.status; } }; } async models(options) { h.catalogOptions = options; if (h.modelError) throw h.modelError; return h.list; } async completion(body, options) { h.chat = { body, options }; if (h.chatError) throw h.chatError; return "unit-completion"; } } },
  });
  const signal = new AbortController().signal; const route = createModelRoute({ modelRoute: "madmodel" }, { signal });
  assert.equal(h.options.signal, signal); assert.equal(h.options.config.stateDir, dir);
  assert.deepEqual(await route.models({ refresh: true, strict: true }), [{ id: "plain", label: "plain" }, { id: "id", label: "label" }, { id: "7", label: "seven" }]); assert.deepEqual(h.catalogOptions, { refresh: true });
  h.list = { data: null }; assert.deepEqual(await route.models(), []);
  h.modelError = new Error("fixture"); assert.deepEqual(await route.models(), []); await assert.rejects(route.models({ strict: true }), { code: "MODEL_DISCOVERY_FAILED" }); h.modelError = undefined;
  const body = { model: "unit", messages: [] }; assert.equal(await route.chat(body, { signal }), "unit-completion"); assert.equal(h.chat.body, body); assert.equal(h.chat.options.signal, signal);
  for (const code of ["VERIFICATION_REQUIRED", "BROWSER_LOGIN_REQUIRED", "AUTH_EXPIRED", "unsafe-code"]) { h.chatError = Object.assign(new Error("secret"), { code, status: 401 }); await assert.rejects(route.chat(body), (error) => { assert.equal(error.code, code === "unsafe-code" ? "MODEL_FAILED" : code); assert.equal(error.status, 401); assert.doesNotMatch(error.message, /secret/); return true; }); }
  h.chatError = new Error("fixture"); await assert.rejects(route.chat(body), { code: "MODEL_FAILED", status: 502 });
  const token = "unit." + Buffer.from(JSON.stringify({ zjh: "unit12345678", exp: 2000000000 })).toString("base64url") + ".unit";
  h.data = { token }; assert.equal((await route.status()).masked, settings.maskAccount("unit12345678")); assert.equal((await route.status()).available, true);
  h.data = { token, disabled: true }; h.status = { configured: true, expired: true, disabled: true }; assert.equal((await route.status()).masked, ""); assert.equal((await route.status()).available, false);
  h.data = { token: "invalid" }; assert.equal((await route.status()).masked, ""); h.loadError = new Error("fixture"); h.statusError = new Error("fixture"); assert.equal((await route.status()).configured, false);
});

test("OpenAI and port checks cover transport/JSON/error defaults through dependency mocks", async (t) => {
  const mode = { error: undefined };
  const { createModelRoute, assertPortFree } = await realModule(t, "lib/app/model.mjs", {
    "lib/madmodel/client.mjs": { MadModelClient: class {} },
    "lib/madmodel/auth.mjs": { SessionStore: class {} },
    "lib/madmodel/config.mjs": { loadConfig: () => ({}) },
    "node:net": { default: { createServer: () => { const server = new EventEmitter(); server.listen = (options, ready) => { mode.options = options; queueMicrotask(() => mode.error ? server.emit("error", mode.error) : ready()); }; server.close = (done) => done(); return server; } } },
  });
  assert.deepEqual(await assertPortFree(10), { free: true }); assert.deepEqual(mode.options, { port: 10, host: "127.0.0.1", exclusive: true });
  for (const code of ["EADDRINUSE", "EACCES", undefined]) { mode.error = Object.assign(new Error("fixture"), { code }); assert.deepEqual(await assertPortFree(11, "localhost"), { free: false, code: code === "EADDRINUSE" ? "APP_PORT_BUSY" : code || "APP_PORT_ERROR" }); }
  const route = createModelRoute({ modelRoute: "openai", modelBaseUrl: "https://unit.invalid/v1/" });
  let response = { ok: true, json: async () => { throw new Error("invalid json"); } };
  const seen = []; t.mock.method(globalThis, "fetch", async (...args) => { seen.push(args); if (response instanceof Error) throw response; return response; });
  assert.deepEqual(await route.models(), []); assert.equal(seen[0][1].headers.Authorization, undefined);
  response = { ok: true, json: async () => ({ data: [{ id: "unit", name: "Unit" }] }) }; assert.deepEqual(await route.models(), [{ id: "unit", label: "Unit" }]);
  response = new Error("offline"); assert.deepEqual(await route.models(), []); await assert.rejects(route.models({ strict: true }), { code: "MODEL_DISCOVERY_FAILED" }); await assert.rejects(route.chat({}), { code: "MODEL_UNREACHABLE" });
  assert.deepEqual(await route.status(), { route: "openai", available: true, configured: true, expired: false, disabled: false, masked: "", expiresAt: null });
});

async function binFixture(t, args, options = {}) {
  const dir = await ownedDirectory(t);
  const h = { io: output(t), calls: [], signals: signalHandlers(t), installed: options.installed ?? false };
  const services = [{ name: "learnx" }, { name: "cloud" }, { name: "hetang" }];
  const call = (name, value = {}) => async (...args) => { h.calls.push([name, ...args]); return value; };
  const dependencies = {
    "lib/services.mjs": {
      services,
      service: (name) => { const found = services.find((service) => service.name === name); if (!found) throw Object.assign(new Error("unknown service fixture"), { code: "UNKNOWN_SERVICE" }); return found; },
      modulePath: () => path.join(dir, "unit-child.mjs"), serviceEnvironment: () => ({ UNIT_ONLY: "1" }),
      clientConfig: call("clientConfig", { mcpServers: { unit: { command: "unit-only" } } }),
    },
    "lib/gateway.mjs": { serveGateway: async () => { h.calls.push(["gateway"]); h.done = true; } },
    "lib/app/cli.mjs": { appCommand: async (args) => { h.calls.push(["app", args]); h.done = true; } },
    "lib/madmodel/cli.mjs": { main: async (args) => { h.calls.push(["madmodel", args]); if (options.madmodelError) throw options.madmodelError; h.done = true; }, safeFailure: () => ({ code: "UNIT_SAFE_ERROR", message: "safe fixture" }) },
    "@thu-campus/browser": {
      installRuntime: async () => { h.calls.push(["installRuntime"]); h.installed = true; return { installed: true }; },
      runtimeInfo: async () => ({ installed: h.installed }), resetBrowser: call("resetBrowser", { reset: true }),
    },
    "lib/browser.mjs": {
      browserOverview: call("overview", { running: false }), closeBrowserJobs: call("close", { closed: true }),
      runBrowserJob: async (target) => { h.calls.push(["worker", target]); h.done = true; },
      restoreService: call("restore", true), startBrowserJob: call("browserJob", { id: "unit-job" }),
    },
    "lib/unified-install.mjs": { unifiedConfig: call("unifiedConfig", { mcpServers: { unified: { command: "unit-only" } } }), installUnified: call("installUnified", { applied: true }) },
    "lib/install.mjs": { installBundle: async (...args) => { h.calls.push(["installBundle", ...args]); if (options.installError) throw options.installError; return { applied: false }; } },
    "node:fs/promises": { access: async (file) => { h.calls.push(["access", file]); if (options.missingBuild) throw Object.assign(new Error("fixture"), { code: "ENOENT" }); } },
    "node:child_process": { spawn: (...args) => {
      h.calls.push(["spawn", ...args]);
      const child = new EventEmitter(); h.child = child; child.killed = false;
      child.kill = (signal) => { child.killed = true; h.calls.push(["kill", signal]); };
      if (!options.pause) queueMicrotask(() => { child.emit(options.childError ? "error" : "exit", options.childError || options.childCode || 0); h.done = true; });
      return child;
    } },
  };
  const savedArgs = process.argv;
  process.argv = [process.execPath, path.join(root, "bin/thu-campus.mjs"), ...args];
  try { await realModule(t, "bin/thu-campus.mjs", dependencies); }
  finally { process.argv = savedArgs; }
  if (options.pause) await settled(() => h.signals.has("SIGTERM"));
  else await settled(() => h.done || h.io.out || h.io.err);
  await nextTurn();
  return h;
}

test("unified bin routes actual commands, maintains reset confirmation and install preview/apply intent", async (t) => {
  const help = await binFixture(t, []); assert.match(help.io.out, /MadModel/);
  for (const [args, called] of [[["serve"], "gateway"], [["app", "status"], "app"], [["madmodel", "models"], "madmodel"], [["browser", "worker", "unit-job"], "worker"]]) {
    const h = await binFixture(t, args); assert.equal(h.calls.at(-1)[0], called);
  }
  const rejected = await binFixture(t, ["madmodel", "chat"], { madmodelError: new Error("secret") }); assert.equal(process.exitCode, 1); assert.equal(JSON.parse(rejected.io.err).code, "UNIT_SAFE_ERROR"); assert.doesNotMatch(rejected.io.err, /secret/);
  for (const [args, expected] of [[["config"], "unit"], [["config", "--unified"], "unified"]]) { const h = await binFixture(t, args); assert(h.io.json().mcpServers[expected]); }
  for (const command of ["install", "uninstall"]) for (const unified of [false, true]) {
    const h = await binFixture(t, [command, ...(unified ? ["--unified", "--apply"] : [])]);
    const invocation = h.calls.find((call) => call[0] === (unified ? "installUnified" : "installBundle"));
    assert.deepEqual(invocation[1], { apply: unified, uninstall: command === "uninstall" });
  }
  const badFlag = await binFixture(t, ["install", "--bad"]); assert.equal(process.exitCode, 2); assert.equal(JSON.parse(badFlag.io.err).code, "USAGE");
  const noConfirmation = await binFixture(t, ["browser", "reset"]); assert.equal(process.exitCode, 2); assert.equal(JSON.parse(noConfirmation.io.err).code, "USAGE"); assert(!noConfirmation.calls.some((call) => call[0] === "resetBrowser"));
  const reset = await binFixture(t, ["browser", "reset", "--confirm"]); assert.equal(reset.io.json().reset, true);
});

test("bin browser dispatch installs when needed, preserves account binding, and restores explicit services", async (t) => {
  for (const [args, event] of [[["browser", "install"], "installRuntime"], [["browser"], "overview"], [["browser", "close"], "close"]]) { const h = await binFixture(t, args); assert(h.calls.some((call) => call[0] === event)); }
  const opened = await binFixture(t, ["browser", "open", "cloud"]); assert.deepEqual(opened.calls.at(-1), ["browserJob", "open", "cloud", undefined]); assert.equal(opened.installed, true);
  const logged = await binFixture(t, ["browser", "login", "learnx", "--account", "unit-only"], { installed: true }); assert.deepEqual(logged.calls.at(-1), ["browserJob", "login", "learnx", "unit-only"]); assert(!logged.calls.some((call) => call[0] === "installRuntime"));
  const all = await binFixture(t, ["browser", "restore"]); assert.deepEqual(Object.keys(all.io.json().restored), ["learnx", "cloud", "hetang", "madmodel"]);
  for (const service of ["madmodel", "cloud"]) { const h = await binFixture(t, ["browser", "restore", service]); assert.deepEqual(h.io.json().restored, { [service]: true }); }
  const invalid = await binFixture(t, ["browser", "invalid"]); assert.equal(JSON.parse(invalid.io.err).code, "USAGE");
});

test("bin errors and mocked child lifecycle retain build checks, argument forwarding and signal cleanup", async (t) => {
  const unknown = await binFixture(t, ["unknown"]); assert.equal(JSON.parse(unknown.io.err).code, "UNKNOWN_SERVICE"); assert.equal(process.exitCode, 2);
  const missing = await binFixture(t, ["learnx"], { missingBuild: true }); assert.equal(JSON.parse(missing.io.err).code, "BUILD_REQUIRED"); assert.equal(process.exitCode, 1);
  for (const code of ["ERR_MODULE_NOT_FOUND", undefined]) { const h = await binFixture(t, ["install"], { installError: Object.assign(new Error("fixture failure"), { code }) }); assert.equal(JSON.parse(h.io.err).code, code || "BUNDLE_ERROR"); assert.equal(process.exitCode, 1); if (code) assert.match(h.io.err, /尚未构建/); }
  const fallback = await binFixture(t, ["cloud"], { childCode: 4 }); assert.deepEqual(fallback.calls.find((call) => call[0] === "spawn")[2].slice(1), ["help"]); assert.equal(process.exitCode, 4); assert.equal(fallback.signals.size, 0);
  const h = await binFixture(t, ["learnx", "status"], { pause: true });
  const spawn = h.calls.find((call) => call[0] === "spawn"); assert.equal(spawn[3].stdio, "inherit"); assert.deepEqual(spawn[3].env, { UNIT_ONLY: "1" }); assert.equal(spawn[2][1], "status");
  h.signals.get("SIGINT")(); h.signals.get("SIGTERM")(); assert.deepEqual(h.calls.filter((call) => call[0] === "kill"), [["kill", "SIGINT"]]);
  h.child.emit("exit", null, "SIGINT"); await settled(() => h.signals.size === 0); assert.equal(process.exitCode, 1);
  const errored = await binFixture(t, ["hetang"], { childError: Object.assign(new Error("spawn fixture"), { code: "EUNIT" }) }); assert.equal(JSON.parse(errored.io.err).code, "EUNIT"); assert.equal(process.exitCode, 1);
});

test("MadModel CLI exports run owned mocked auth/catalog actions and streams without touching real stdin", async (t) => {
  const dir = await ownedDirectory(t), io = output(t), handlers = signalHandlers(t);
  const h = { calls: [], input: [], config: { stateDir: dir, maxBodyBytes: 64 } };
  t.mock.method(process.stdin, Symbol.asyncIterator, async function* () { yield* h.input; });
  const { main, safeFailure } = await realModule(t, "lib/madmodel/cli.mjs", {
    "lib/madmodel/config.mjs": { loadConfig: () => h.config },
    "lib/madmodel/client.mjs": { MadModelClient: class {
      constructor({ config }) { assert.equal(config.stateDir, dir); this.manager = {
        ensure: async (options) => h.calls.push(["ensure", options]), status: async () => ({ unit: "status" }),
        check: async () => ({ unit: "check" }), logout: async () => ({ unit: "logout" }),
      }; }
      async models() { return { unit: "models" }; }
      async completion(body) { h.calls.push(["completion", body]); return h.response; }
    } },
    "lib/madmodel/server.mjs": { startModelService: async (config) => { assert.equal(config.stateDir, dir); h.calls.push(["serve"]); return { close: async () => h.calls.push(["close"]) }; } },
  });
  await main(); assert.match(io.out, /MadModel/); io.clear();
  for (const command of ["status", "check", "logout", "models"]) { await main([command]); assert.equal(io.json().unit, command); io.clear(); }
  await main(["login", "--headless"]); assert.deepEqual(h.calls.at(-1), ["ensure", { interactive: true, force: true, headless: true }]); io.clear();
  await main(["login"]); assert.equal(h.calls.at(-1)[1].headless, false); io.clear();
  await main(["refresh"]); assert.deepEqual(h.calls.at(-1), ["ensure", { force: true }]); io.clear();
  await main(["not-a-command"]); assert.equal(process.exitCode, 2); assert.match(io.out, /MadModel/); io.clear();
  h.input = ['{"model":', '"unit"}']; h.response = { ok: true, body: (async function* () { yield Buffer.from("unit-"); yield Buffer.from("stream"); })() };
  await main(["chat"]); assert.equal(io.out, "unit-stream"); assert.deepEqual(h.calls.at(-1), ["completion", { model: "unit" }]); io.clear();
  let cancelled = false; h.response = { ok: false, body: { cancel: async () => { cancelled = true; } } }; await assert.rejects(main(["chat"]), /Upstream refused/); assert.equal(cancelled, true);
  h.input = ["invalid-json"]; await assert.rejects(main(["chat"]), SyntaxError);
  h.input = ["x".repeat(65)]; await assert.rejects(main(["chat"]), /Request too large/);
  assert.equal(safeFailure(new Error("secret")).code, "MADMODEL_FAILED");
  await main(["serve"]); assert(handlers.has("SIGINT")); handlers.get("SIGINT")(); await settled(() => handlers.size === 0); assert(h.calls.some((call) => call[0] === "close"));
});
