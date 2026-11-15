import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import {
  buildApiUrl,
  sanitizeApiPath,
  sanitizeBaseUrl,
  sanitizePairCode,
  sanitizeToken,
  trimTrailingSlashes,
} from "../webui/guards.js";
import { parseHeading, parseListItem, splitInline } from "../webui/markdown-inline.js";
import {
  CONNECTION_KEY,
  LEGACY_BASE_KEY,
  LEGACY_TOKEN_KEY,
  clearConnection,
  parseConnection,
  readConnection,
  resolveStartupConnection,
  writeConnection,
} from "../webui/connection.js";
import { safeLink } from "../webui/workspace.js";
import { resolveExecutable, trustedEnv, trustedPath } from "../scripts/trusted-path.mjs";
import { isPrivateOrGeneratedPath, scanText } from "../scripts/audit-patterns.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "..");
const read = (relative) => readFile(path.join(repo, relative), "utf8");

function memoryStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, String(value)),
    removeItem: (key) => map.delete(key),
    dump: () => Object.fromEntries(map),
  };
}

test("trimTrailingSlashes removes runs of trailing slashes without regex backtracking", () => {
  assert.equal(trimTrailingSlashes("http://a:1///"), "http://a:1");
  assert.equal(trimTrailingSlashes("http://a:1/"), "http://a:1");
  assert.equal(trimTrailingSlashes(""), "");
  assert.equal(trimTrailingSlashes(null), "");
});

test("sanitizeToken keeps real device tokens and rejects injected values", () => {
  const token = "tc1_" + "A".repeat(43);
  assert.equal(sanitizeToken(token), token);
  assert.equal(sanitizeToken("  " + token), "");
  assert.equal(sanitizeToken("tc1_x\r\nx"), "");
  assert.equal(sanitizeToken("a b"), "");
  assert.equal(sanitizeToken(""), "");
  assert.equal(sanitizeToken("x".repeat(4097)), "");
});

test("sanitizeBaseUrl only accepts plain http(s) origins without credentials or query", () => {
  assert.equal(sanitizeBaseUrl("http://192.168.1.23:8971/"), "http://192.168.1.23:8971");
  assert.equal(sanitizeBaseUrl("https://host.example/base/"), "https://host.example/base");
  assert.equal(sanitizeBaseUrl("javascript:alert(1)"), "");
  assert.equal(sanitizeBaseUrl("http://user:pass@host"), "");
  assert.equal(sanitizeBaseUrl("ftp://host"), "");
  assert.equal(sanitizeBaseUrl("http://host/?q=1"), "");
  assert.equal(sanitizeBaseUrl("http://host/#frag"), "");
  assert.equal(sanitizeBaseUrl("http://host/ a"), "");
  assert.equal(sanitizeBaseUrl("http://host/\n"), "http://host");
  assert.equal(sanitizeBaseUrl("http://ho\nst"), "");
  assert.equal(sanitizeBaseUrl(""), "");
});

test("sanitizeApiPath and buildApiUrl refuse redirects, traversal and non-http schemes", () => {
  assert.equal(sanitizeApiPath("/api/meta"), "/api/meta");
  assert.equal(sanitizeApiPath("/api/sessions/abc-123?x=1"), "/api/sessions/abc-123?x=1");
  assert.equal(sanitizeApiPath("//evil.example/x"), "");
  assert.equal(sanitizeApiPath("https://evil.example/x"), "");
  assert.equal(sanitizeApiPath("/api/../secret"), "");
  assert.equal(sanitizeApiPath("/api/%2e%2e/secret"), "");
  assert.equal(sanitizeApiPath("/api/a\\b"), "");
  assert.equal(sanitizeApiPath("/api/a b"), "");
  assert.equal(sanitizeApiPath(""), "");
  assert.equal(buildApiUrl("", "/api/meta"), "/api/meta");
  assert.equal(buildApiUrl("http://host:1/", "/api/meta"), "http://host:1/api/meta");
  assert.throws(() => buildApiUrl("", "//evil.example/x"), /接口路径不合法/);
});

test("sanitizePairCode accepts exactly six digits", () => {
  assert.equal(sanitizePairCode("123456"), "123456");
  assert.equal(sanitizePairCode(" 123456 "), "123456");
  assert.equal(sanitizePairCode("12345"), "");
  assert.equal(sanitizePairCode("12345a"), "");
  assert.equal(sanitizePairCode("<script>"), "");
});

test("splitInline tokenizes code, strong and links without nested quantifiers", () => {
  const kinds = splitInline("hi `a` **b** [c](http://x.example/p) tail").map((token) => token.kind);
  assert.deepEqual(kinds, ["text", "code", "text", "strong", "text", "link", "text"]);
  const link = splitInline("[c](http://x.example/(p))").find((token) => token.kind === "link");
  assert.equal(link.href, "http://x.example/(p)");
  const broken = splitInline("[a](http://x.example/a b)");
  assert.deepEqual(broken, [{ kind: "text", text: "[a](http://x.example/a b)" }]);
  assert.deepEqual(splitInline("plain"), [{ kind: "text", text: "plain" }]);
});

test("parseHeading matches the original heading shape, including trailing hashes", () => {
  assert.deepEqual(parseHeading("## Hi ##"), { level: 2, text: "Hi" });
  assert.deepEqual(parseHeading("   # deep"), { level: 1, text: "deep" });
  assert.equal(parseHeading("    ## four spaces"), null);
  assert.equal(parseHeading("####### seven"), null);
  assert.equal(parseHeading("#"), null);
  assert.equal(parseHeading("##   "), null);
});

test("parseListItem handles ordered and unordered markers", () => {
  assert.deepEqual(parseListItem("- a"), { ordered: false, start: 0, text: "a" });
  assert.deepEqual(parseListItem("3. c"), { ordered: true, start: 3, text: "c" });
  assert.deepEqual(parseListItem("4) d"), { ordered: true, start: 4, text: "d" });
  assert.deepEqual(parseListItem("  * nested"), { ordered: false, start: 0, text: "nested" });
  assert.equal(parseListItem("-"), null);
  assert.equal(parseListItem("- "), null);
  assert.equal(parseListItem("plain"), null);
});

test("linear parsers finish adversarial inputs quickly", () => {
  const started = Date.now();
  assert.equal(splitInline("[" .repeat(40000)).length > 0, true);
  assert.equal(parseHeading(" " + "#".repeat(40000) + "x"), null);
  assert.equal(parseListItem("9".repeat(40000) + "x"), null);
  assert.equal(parseListItem(" ".repeat(40000) + "- x").text, "x");
  assert.ok(Date.now() - started < 3000, "线性解析不应出现回溯爆炸");
});

test("safeLink only yields http(s) links and authenticated artifact URLs", () => {
  const origin = "http://127.0.0.1:8971";
  assert.equal(safeLink("javascript:alert(1)", origin), null);
  assert.equal(safeLink("data:text/html,x", origin), null);
  assert.equal(safeLink("file:///c:/x", origin), null);
  assert.deepEqual(safeLink("https://example.com/a", origin), { kind: "external", href: "https://example.com/a" });
  assert.equal(safeLink("http://evil.example/api/x", origin), null);
  const artifact = "/api/workspaces/8e5e6a52-0b7d-4e32-9a3f-1b2c3d4e5f60/files?path=out%2Freport.pdf";
  const link = safeLink(artifact, origin);
  assert.equal(link.kind, "artifact");
  assert.equal(link.filename, "report.pdf");
  assert.equal(safeLink(artifact + "&extra=1", origin), null);
  assert.equal(safeLink(artifact.replace("?path=", "?other="), origin), null);
});

test("index.html CSP drops inline styles and keeps scripts external", async () => {
  const html = await read("webui/index.html");
  const meta = /http-equiv="Content-Security-Policy"\s+content="([^"]+)"/i.exec(html);
  assert.ok(meta, "缺少 CSP meta");
  const policy = meta[1];
  assert.equal(policy.includes("unsafe-inline"), false);
  assert.equal(policy.includes("unsafe-eval"), false);
  assert.match(policy, /script-src 'self'/);
  assert.match(policy, /default-src 'self'/);
  assert.equal(/<style[\s>]/i.test(html), false);
  assert.equal(/\sstyle="/i.test(html), false);
  const scripts = html.match(/<script\b[^>]*>/gi) || [];
  assert.ok(scripts.length > 0);
  for (const tag of scripts) assert.match(tag, /\bsrc="/);
});

test("webui contains no inline HTML sinks and no bare parseFloat", async () => {
  for (const file of await readdir(path.join(repo, "webui"))) {
    if (!file.endsWith(".js")) continue;
    const source = await read(`webui/${file}`);
    assert.equal(/\.innerHTML\s*=/.test(source), false, `${file} 不应写 innerHTML`);
    assert.equal(/setAttribute\(\s*["']style["']/.test(source), false, `${file} 不应写内联 style 属性`);
    assert.equal(/\.style\.cssText\s*=/.test(source), false, `${file} 不应写 cssText`);
    assert.equal(/(?<![\w.$])parseFloat\s*\(/.test(source), false, `${file} 应使用 Number.parseFloat`);
  }
  for (const file of await readdir(path.join(repo, "scripts"))) {
    if (!file.endsWith(".mjs") || file.startsWith("coverage")) continue;
    const source = await read(`scripts/${file}`);
    assert.equal(/(?<![\w.$])parseFloat\s*\(/.test(source), false, `${file} 应使用 Number.parseFloat`);
  }
});

test("flagged super-linear regexes are gone from the frontend", async () => {
  const workspace = await read("webui/workspace.js");
  assert.match(workspace, /splitInline\(/);
  assert.match(workspace, /parseHeading\(/);
  assert.match(workspace, /parseListItem\(/);
  assert.equal(workspace.includes("/\\/+$/"), false);
  assert.equal(workspace.includes("(?:[^()\\s]|\\([^()\\s]*\\))+"), false);
  const appSource = await read("webui/app.js");
  assert.equal(appSource.includes("/\\/+$/"), false);
  assert.match(appSource, /buildApiUrl\(state\.base, path\)/);
});

test("app.js binds token to the full API base and omits ambient credentials", async () => {
  const source = await read("webui/app.js");
  assert.match(source, /resolveStartupConnection\(\{/);
  assert.match(source, /writeConnection\(localStorage, \{ base: connection\.base, token: connection\.token \}\)/);
  assert.match(source, /writeConnection\(localStorage, \{ base, token: issuedToken \}\)/);
  assert.match(source, /const code = sanitizePairCode\(/);
  assert.match(source, /const issuedToken = sanitizeToken\(String\(data\.token/);
  assert.equal(source.includes("STORAGE_TOKEN"), false);
  assert.equal(source.includes("STORAGE_BASE"), false);
  const omitted = source.match(/credentials: "omit"/g) || [];
  assert.ok(omitted.length >= 3, "api、聊天流与配对请求都应显式 credentials:omit");
  assert.match(source, /if \(connection\.cleared\) state\.pairNotice/);
});

test("connection helpers bind token to the normalized base and discard it on target change", () => {
  const token = "tc1_" + "a".repeat(43);
  const stored = JSON.stringify({ version: 1, base: "http://host:1/agent/", token });
  const same = resolveStartupConnection({
    storedRaw: stored,
    href: "http://host:1/index.html",
    urlBaseRaw: "http://host:1/agent",
  });
  assert.deepEqual(same, { base: "http://host:1/agent", token, persist: false, cleared: false, reason: "SAME_TARGET" });

  const changedPath = resolveStartupConnection({
    storedRaw: stored,
    href: "http://host:1/index.html",
    urlBaseRaw: "http://host:1/other",
  });
  assert.equal(changedPath.base, "http://host:1/other");
  assert.equal(changedPath.token, "");
  assert.equal(changedPath.cleared, true);
  assert.equal(changedPath.reason, "TARGET_CHANGED");

  const newToken = resolveStartupConnection({
    storedRaw: stored,
    href: "http://host:1/index.html",
    urlBaseRaw: "http://evil.invalid",
    urlTokenRaw: "tc1_" + "b".repeat(43),
  });
  assert.equal(newToken.base, "http://evil.invalid");
  assert.equal(newToken.token, "tc1_" + "b".repeat(43));

  const pageBound = resolveStartupConnection({
    storedRaw: stored,
    href: "http://127.0.0.1:8971/index.html",
    urlTokenRaw: "tc1_" + "c".repeat(43),
  });
  assert.equal(pageBound.base, "http://127.0.0.1:8971");
});

test("connection helpers migrate legacy keys without letting credentials follow a new base", () => {
  const token = "tc1_" + "d".repeat(43);
  const legacy = resolveStartupConnection({
    legacyTokenRaw: token,
    legacyBaseRaw: "http://host:1/agent",
    href: "http://host:1/index.html",
    urlBaseRaw: "http://host:1/agent",
  });
  assert.equal(legacy.token, token);
  assert.equal(legacy.base, "http://host:1/agent");

  const legacyNoBase = resolveStartupConnection({
    legacyTokenRaw: token,
    href: "http://127.0.0.1:8971/index.html",
  });
  assert.equal(legacyNoBase.base, "http://127.0.0.1:8971");
  assert.equal(legacyNoBase.token, token);
  assert.equal(legacyNoBase.reason, "LEGACY_BOUND_TO_PAGE");

  const filePage = resolveStartupConnection({ legacyTokenRaw: token, href: "file:///C:/app/index.html" });
  assert.equal(filePage.token, "");
  assert.equal(filePage.cleared, true);

  const fileWithBase = resolveStartupConnection({
    legacyTokenRaw: token,
    legacyBaseRaw: "http://host:1/agent",
    href: "file:///C:/app/index.html",
  });
  assert.equal(fileWithBase.base, "http://host:1/agent");
  assert.equal(fileWithBase.token, token);

  const corrupted = resolveStartupConnection({
    storedRaw: "{not-json",
    legacyTokenRaw: token,
    legacyBaseRaw: "http://host:1/agent",
    href: "http://host:1/index.html",
  });
  assert.equal(corrupted.base, "http://host:1/agent");
  assert.equal(corrupted.token, token);
  assert.equal(corrupted.persist, true);

  const empty = resolveStartupConnection({ href: "http://host:1/index.html" });
  assert.deepEqual(empty, { base: "", token: "", persist: false, cleared: false, reason: "EMPTY" });
});

test("atomic connection records never borrow residual legacy fields", () => {
  const oldToken = "tc1_" + "a".repeat(43);
  const newToken = "tc1_" + "b".repeat(43);
  const legacy = { legacyBaseRaw: "https://old.invalid/api", legacyTokenRaw: oldToken, href: "https://page.invalid/" };
  const baseOnly = JSON.stringify({ version: 1, base: "https://new.invalid/api", token: "" });
  const selected = resolveStartupConnection({ ...legacy, storedRaw: baseOnly });
  assert.equal(selected.base, "https://new.invalid/api");
  assert.equal(selected.token, "");
  assert.equal(selected.persist, true);
  const sameUrl = resolveStartupConnection({ ...legacy, storedRaw: baseOnly, urlBaseRaw: "https://new.invalid/api" });
  assert.equal(sameUrl.token, "");
  const tokenOnly = JSON.stringify({ version: 1, base: "", token: newToken });
  const pageBound = resolveStartupConnection({ ...legacy, storedRaw: tokenOnly });
  assert.equal(pageBound.base, "https://page.invalid");
  assert.equal(pageBound.token, newToken);
  const noTarget = resolveStartupConnection({ ...legacy, href: "file:///C:/app/index.html", storedRaw: tokenOnly });
  assert.equal(noTarget.base, "");
  assert.equal(noTarget.token, "");
  const corrupt = resolveStartupConnection({ ...legacy, storedRaw: "{broken" });
  assert.equal(corrupt.base, legacy.legacyBaseRaw);
  assert.equal(corrupt.token, oldToken);
});

test("connection storage is written atomically and legacy keys are retired", () => {
  const token = "tc1_" + "e".repeat(43);
  const store = memoryStorage({
    [LEGACY_TOKEN_KEY]: token,
    [LEGACY_BASE_KEY]: "http://host:1/agent",
  });
  const written = writeConnection(store, { base: "http://host:1/agent/", token });
  assert.deepEqual(written, { base: "http://host:1/agent", token });
  const dump = store.dump();
  assert.equal(dump[LEGACY_TOKEN_KEY], undefined);
  assert.equal(dump[LEGACY_BASE_KEY], undefined);
  assert.deepEqual(JSON.parse(dump[CONNECTION_KEY]), { version: 1, base: "http://host:1/agent", token });
  assert.deepEqual(readConnection(store), { base: "http://host:1/agent", token });

  writeConnection(store, { base: "http://host:1/agent", token: "" });
  assert.deepEqual(readConnection(store), { base: "http://host:1/agent", token: "" });
  clearConnection(store);
  assert.equal(store.dump()[CONNECTION_KEY], undefined);
  assert.equal(readConnection(store), null);
  assert.equal(parseConnection("{not-json"), null);
});

test("service worker precaches the new modules with a bumped cache", async () => {
  const sw = await read("webui/sw.js");
  assert.match(sw, /const CACHE = "campus-app-v15"/);
  for (const asset of ["/guards.js", "/connection.js", "/markdown-inline.js"]) assert.ok(sw.includes(`"${asset}"`), `sw.js 缺少 ${asset}`);
});

test("trusted PATH keeps subprocess resolution out of cwd and inherited PATH", () => {
  const dirs = trustedPath();
  assert.ok(dirs.length > 0);
  for (const dir of dirs) assert.equal(path.isAbsolute(dir), true, `PATH 片段必须是绝对目录：${dir}`);
  assert.equal(dirs.includes(process.cwd()), false);
  const hostile = { ...process.env, PATH: `/tmp/evil${path.delimiter}${process.env.PATH || ""}`, Path: "/tmp/evil" };
  const env = trustedEnv({ EXTRA_FLAG: "1" }, hostile);
  assert.equal(env.EXTRA_FLAG, "1");
  assert.equal(env.PATH, dirs.join(path.delimiter));
  assert.equal(env.PATH.includes("/tmp/evil"), false);
  assert.equal(env.Path, undefined);
});

test("scripts spawn git and tar with the trusted environment", async () => {
  const files = ["scripts/audit-source.mjs", "scripts/bundle.mjs", "scripts/prepared-bundle.mjs", "scripts/verify-prepared.mjs"];
  for (const file of files) {
    const source = await read(file);
    assert.match(source, /trustedEnv\(/, `${file} 必须使用 trustedEnv`);
    assert.match(source, /(?:resolveExecutable|systemExecutable)\(/, `${file} 必须解析为固定可执行文件路径`);
    let found = 0;
    let cursor = 0;
    for (;;) {
      const at = source.indexOf("execFileSync(", cursor);
      if (at < 0) break;
      cursor = at + 1;
      const window = source.slice(at, at + 600);
      if (!/gitBin|tarBin|["'](?:git|tar\.exe)["']/.test(window)) continue;
      found += 1;
      assert.match(window, /env:\s*(?:trustedEnv\(\)|gitEnv\b)/, `${file} 的子进程必须固定 PATH`);
    }
    assert.ok(found > 0, `${file} 应包含 git/tar 调用`);
  }
});

test("tar resolves through the shared browser system helper on Windows", { skip: process.platform !== "win32" }, async () => {
  const { systemExecutable } = await import("@thu-campus/browser");
  const tar = await systemExecutable(path.join("System32", "tar.exe"));
  assert.equal(path.isAbsolute(tar), true);
  assert.match(tar.toLowerCase(), /system32[\\/]tar\.exe$/);
  await assert.rejects(() => systemExecutable(path.join("System32", "not-a-real-tool.exe")), (error) => error.code === "EXEC_MISSING");
});

test("executables resolve inside the trusted directories", () => {
  for (const name of ["git", "tar.exe"]) {
    const resolved = resolveExecutable(name);
    assert.equal(typeof resolved, "string");
    if (resolved !== name) {
      assert.equal(path.isAbsolute(resolved), true, `${name} 应解析为绝对路径`);
      const dirs = trustedPath();
      assert.ok(dirs.some((dir) => resolved.startsWith(dir)), `${name} 必须位于受信任目录内`);
    }
  }
});

test("prepared bundle keeps the sandbox lock input list in sync", async () => {
  const source = await read("scripts/prepared-bundle.mjs");
  assert.match(source, /"sandbox\/Dockerfile"/);
  assert.match(source, /"sandbox\/requirements\.txt"/);
  assert.match(source, /"sandbox\/requirements\.in"/);
});

test("audit path detection keeps the original private/generated coverage", () => {
  const hits = [
    "node_modules/pkg/index.js",
    "packages/learnx/dist/server.js",
    "downloads/file.zip",
    ".runtime/browser/data",
    ".local/release/x.zip",
    ".superpowers/spec.md",
    "config/.env",
    "config/.env.local",
    "state/devices.dpapi",
    "NODE_MODULES/UP.CJS",
    "CONFIG/.ENV",
  ];
  for (const name of hits) assert.equal(isPrivateOrGeneratedPath(name), true, `应命中：${name}`);
  const misses = [
    "webui/app.js",
    "docs/node_modules.md",
    "src/environment.js",
    "notes/.environment",
    "dist.txt",
    ".envrc",
    "state/devices.dpapi.txt",
  ];
  for (const name of misses) assert.equal(isPrivateOrGeneratedPath(name), false, `不应命中：${name}`);
});

test("audit secret rules still detect the same credential families", () => {
  // 逐段拼接，避免测试文件本身被 audit-source 当成真实私钥样本。
  assert.deepEqual(scanText(["-----BEGIN", "OPENSSH", "PRIVATE KEY-----"].join(" ")), ["private-key"]);
  assert.deepEqual(scanText("token=ghp_" + "a".repeat(36)), ["github-token"]);
  assert.deepEqual(scanText("sk-" + "b".repeat(40)), ["model-key"]);
  assert.deepEqual(scanText("Cookie: JSESSIONID=" + "c".repeat(32)), ["session-cookie"]);
  assert.deepEqual(scanText("const value = 1;"), []);
});

test("no NOSONAR markers or source-exclusion escapes were added", async () => {
  const files = [
    ...(await readdir(path.join(repo, "webui"))).filter((file) => /\.(js|html)$/.test(file)).map((file) => `webui/${file}`),
    ...(await readdir(path.join(repo, "scripts"))).filter((file) => file.endsWith(".mjs")).map((file) => `scripts/${file}`),
  ];
  for (const file of files) {
    const source = await read(file);
    assert.equal(source.includes("NOSONAR"), false, `${file} 不应添加 NOSONAR`);
    assert.equal(/sonar\.(?:c|cpp)\.ignore|sonar\.exclusions/.test(source), false, `${file} 不应添加排除规则`);
  }
});