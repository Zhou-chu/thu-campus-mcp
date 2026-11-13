import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  readFile,
  writeFile,
  mkdir,
  rm,
  symlink,
  lstat,
  truncate,
  readdir,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  CloudWorkspace,
  WORKSPACE_ROOT as ROOT,
  workspaceRelative,
} from "../dist/workspace.js";
import {
  protectedAccount,
  cloudStatus,
  authenticationFailure,
} from "../dist/status.js";
import { digest } from "../dist/storage.js";
import { CloudError } from "../dist/types.js";
import { loadConfig } from "../dist/config.js";
import { CloudClient } from "../dist/client.js";
import { AuthStore } from "../dist/auth.js";
const REPO = "11111111-1111-4111-8111-111111111111",
  SID = "22222222-2222-4222-8222-222222222222";
const EMAIL = "unit@example.test",
  ACCOUNT = digest(EMAIL).slice(0, 32),
  MARKER = ROOT + "/.thu-campus-agent.json";
const fails = (promise, code) =>
  assert.rejects(promise, (e) => e.code === code);
async function fixture(t, overrides = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "cloud-workspace-unit-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const f = {
    root,
    email: EMAIL,
    requests: [],
    writes: [],
    files: new Map(),
    dirs: new Set(["/"]),
    metadata: new Map(),
    accountCalls: 0,
  };
  f.config = loadConfig({
    stateDir: path.join(root, "state"),
    mock: false,
    maxBytes: 1024,
    ...overrides,
  });
  f.repo = {
    id: REPO,
    type: "repo",
    owner: EMAIL,
    permission: "rw",
    encrypted: false,
    virtual: false,
  };
  f.entry = (p) =>
    f.files.has(p)
      ? {
          name: path.posix.basename(p),
          path: p,
          type: "file",
          id: digest(f.files.get(p)).slice(0, 40),
          size: f.files.get(p).length,
        }
      : f.dirs.has(p)
        ? {
            name: path.posix.basename(p),
            path: p,
            type: "dir",
            id: "directory-id",
          }
        : undefined;
  f.drive = {
    identity: "",
    checkAuth: async () => {},
    request: async (p) => {
      f.requests.push(p);
      if (p === "/api2/account/info/") {
        f.accountCalls++;
        if (f.onAccount) await f.onAccount();
        return { email: f.email };
      }
      if (f.metadata.has(p)) {
        const value = f.metadata.get(p);
        if (value instanceof Error) throw value;
        return value;
      }
      if (p === "/api2/default-repo/") return { exists: true, repo_id: REPO };
      if (p === "/api2/repos/?type=mine") return [f.repo];
      return [];
    },
    info: async (id, p) => {
      assert.equal(id, REPO);
      return f.infoHook ? f.infoHook(p, f.entry(p)) : f.entry(p);
    },
    list: async (id, p) => {
      const items = [...new Set([...f.dirs, ...f.files.keys()])]
        .filter((q) => q !== p && path.posix.dirname(q) === p)
        .map((q) => f.entry(q));
      return f.listHook
        ? f.listHook(p, items)
        : { items, total: items.length, offset: 0 };
    },
    mkdir: async (id, p) => {
      assert.equal(id, REPO);
      f.writes.push(p);
      if (f.mkdirHook) await f.mkdirHook(p);
      if (f.dirs.has(p)) throw new CloudError("CONFLICT", "exists");
      f.dirs.add(p);
    },
  };
  f.transfer = {
    read: async (id, p) => {
      if (!f.files.has(p)) throw new CloudError("NOT_FOUND", "missing");
      return {
        path: p,
        content: f.files.get(p).toString(),
        encoding: "utf-8",
        complete: true,
      };
    },
    upload: async (input) => {
      f.writes.push(input.path);
      if (f.uploadHook) return f.uploadHook(input);
      const content = await readFile(input.filePath);
      f.files.set(input.path, content);
      return { status: "complete", id: input.requestId };
    },
    download: async (input) => {
      const content = f.files.get(input.path),
        filePath = path.join(input.outputDir, input.filename);
      await writeFile(filePath, content, { flag: "wx" });
      if (f.downloadHook) await f.downloadHook(input);
      return { filePath, bytes: content.length, sha256: digest(content) };
    },
  };
  f.workspace = new CloudWorkspace(f.config, f.drive, f.transfer);
  f.init = () => f.workspace.init({ accountId: ACCOUNT, expectedRepoId: REPO });
  f.input = { accountId: ACCOUNT, sessionId: SID, path: "nested/file.txt" };
  f.source = path.join(root, "source.txt");
  await writeFile(f.source, "hello");
  f.push = (extra = {}) =>
    f.workspace.push({ ...f.input, sourcePath: f.source, ...extra });
  f.remote = ROOT + "/sessions/" + SID + "/nested/file.txt";
  return f;
}

test("production CloudClient info reports missing parent 404 and private first push creates it safely", async (t) => {
  const f = await fixture(t);
  await new AuthStore(f.config.stateDir).save({
    account: EMAIL,
    token: "unit-test-only-token",
    mode: "account",
  });
  const client = new CloudClient(f.config),
    missingParents = [];
  client.request = async (endpoint) => {
    const u = new URL(endpoint, "https://cloud.tsinghua.edu.cn");
    if (u.pathname === "/api2/repos/")
      return [{ ...f.repo, name: "unit-owned-library" }];
    assert.equal(u.pathname, `/api2/repos/${REPO}/dir/`);
    const parent = u.searchParams.get("p");
    if (!f.dirs.has(parent)) {
      missingParents.push(parent);
      throw new CloudError(
        "NOT_FOUND",
        "directory API: parent does not exist",
        404,
      );
    }
    return [...new Set([...f.dirs, ...f.files.keys()])]
      .filter((p) => p !== parent && path.posix.dirname(p) === parent)
      .map((p) => f.entry(p));
  };
  f.drive.info = client.info.bind(client);
  f.drive.list = client.list.bind(client);
  await f.init();
  await assert.rejects(
    client.info(REPO, f.remote),
    (error) => error.code === "NOT_FOUND" && error.status === 404,
  );
  const pushed = await f.push();
  assert.equal(pushed.bytes, 5);
  assert.ok(missingParents.includes(path.posix.dirname(f.remote)));
  assert.ok(f.dirs.has(ROOT + "/sessions/" + SID));
  assert.ok(f.dirs.has(path.posix.dirname(f.remote)));
  assert.equal(f.files.get(f.remote).toString(), "hello");
  assert.equal(
    (
      await f.workspace.list({
        accountId: ACCOUNT,
        sessionId: SID,
        recursive: true,
      })
    ).entries.at(-1).remoteId,
    pushed.remoteId,
  );
});

test("explicit missing-parent 404 does not bypass expected remote ID or create an intent", async (t) => {
  const f = await fixture(t);
  await f.init();
  f.infoHook = (p, entry) => {
    if (p === f.remote)
      throw new CloudError("NOT_FOUND", "missing parent", 404);
    return entry;
  };
  const writes = f.writes.length;
  await fails(
    f.push({ overwrite: true, expectedRemoteId: "previous-file-id" }),
    "REMOTE_CONFLICT",
  );
  assert.equal(f.writes.length, writes);
  await assert.rejects(
    lstat(
      path.join(
        f.config.stateDir,
        "workspace-writes",
        ACCOUNT,
        digest(f.remote) + ".json",
      ),
    ),
    { code: "ENOENT" },
  );
});

test("first target info preserves auth network and non-explicit absence errors before any write", async (t) => {
  const f = await fixture(t);
  await f.init();
  const writes = f.writes.length;
  for (const failure of [
    new CloudError("AUTH_REQUIRED", "login required", 401),
    new CloudError("PERMISSION_DENIED", "forbidden", 403),
    new TypeError("fetch failed"),
    new CloudError("HTTP_ERROR", "upstream unavailable", 500),
    new CloudError("NOT_FOUND", "unclassified absence"),
    new CloudError("NOT_FOUND", "not an absence response", 500),
    Object.assign(new Error("not the typed API error"), {
      code: "NOT_FOUND",
      status: 404,
    }),
  ]) {
    f.infoHook = (p, entry) => {
      if (p === f.remote) throw failure;
      return entry;
    };
    await assert.rejects(f.push(), (error) => error === failure);
    assert.equal(f.writes.length, writes);
    await assert.rejects(
      lstat(
        path.join(
          f.config.stateDir,
          "workspace-writes",
          ACCOUNT,
          digest(f.remote) + ".json",
        ),
      ),
      { code: "ENOENT" },
    );
  }
});

const MIB = 1024 * 1024;
async function actualTransferFixture(t, overrides = {}) {
  const f = await fixture(t, { maxBytes: 128 * MIB, ...overrides });
  f.transfers = [];
  f.drive.resolveRepo = async (id) => {
    assert.equal(id, REPO);
    return f.repo;
  };
  f.drive.downloadLink = async (id, p) => {
    assert.equal(id, REPO);
    return (
      "https://cloud.tsinghua.edu.cn/unit-download?path=" +
      encodeURIComponent(p)
    );
  };
  f.drive.uploadLink = async (id) => {
    assert.equal(id, REPO);
    return "https://cloud.tsinghua.edu.cn/unit-upload";
  };
  f.drive.transferRequest = async (url, init = {}) => {
    const u = new URL(url);
    if (u.pathname === "/unit-upload") {
      const file = init.body.get("file"),
        p = path.posix.join(init.body.get("parent_dir"), file.name);
      f.writes.push(p);
      f.transfers.push({ path: p, method: "upload" });
      const bytes = Buffer.from(await file.arrayBuffer());
      f.files.set(p, bytes);
      return Response.json([
        { name: file.name, size: bytes.length, id: f.entry(p).id },
      ]);
    }
    assert.equal(u.pathname, "/unit-download");
    const p = u.searchParams.get("path");
    f.transfers.push({ path: p, method: "download" });
    if (f.downloadResponse) {
      const custom = f.downloadResponse(p);
      if (custom) return custom;
    }
    const bytes = f.files.get(p);
    return new Response(bytes, {
      headers: {
        "content-type": "application/octet-stream",
        "content-length": String(bytes.length),
      },
    });
  };
  // Exercise the production transfer instances, not the fixture's injected stubs.
  f.workspace = new CloudWorkspace(f.config, f.drive);
  await f.init();
  return f;
}
function storedZip(totalBytes) {
  const name = Buffer.from("payload.bin"),
    data = Buffer.alloc(totalBytes - (30 + 46 + 22 + 2 * name.length));
  const table = Uint32Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let i = 0; i < 8; i++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  let crc = 0xffffffff;
  for (const value of data) crc = table[(crc ^ value) & 255] ^ (crc >>> 8);
  crc = (crc ^ 0xffffffff) >>> 0;
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(33, 12);
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(data.length, 18);
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(name.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(33, 14);
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(data.length, 20);
  central.writeUInt32LE(data.length, 24);
  central.writeUInt16LE(name.length, 28);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length + name.length, 12);
  end.writeUInt32LE(local.length + name.length + data.length, 16);
  return Buffer.concat([local, name, data, central, name, end]);
}

test("ordinary files above 32MiB fail snapshot and metadata checks even with a ZIP source name", async (t) => {
  const f = await actualTransferFixture(t),
    source = path.join(f.root, "source.zip"),
    p = "exports/ordinary.bin",
    remote = ROOT + "/sessions/" + SID + "/" + p;
  await writeFile(source, "");
  await truncate(source, 33 * MIB);
  const count = f.writes.length;
  await fails(f.push({ path: p, sourcePath: source }), "FILE_LIMIT");
  f.files.set(remote, Buffer.from("x"));
  f.infoHook = (target, entry) =>
    target === remote ? { ...entry, size: 33 * MIB } : entry;
  await fails(f.workspace.pull({ ...f.input, path: p }), "FILE_LIMIT");
  assert.equal(f.writes.length, count);
  assert.equal(
    f.transfers.some((r) => r.path === remote),
    false,
  );
});

test("a valid 50MiB ZIP roundtrips through production snapshot/upload/download using its target extension", async (t) => {
  const f = await actualTransferFixture(t),
    bytes = storedZip(50 * MIB),
    p = "exports/Bundle.ZIP";
  await writeFile(f.source, bytes); // Source remains source.txt: only the guarded target is classified.
  const pushed = await f.push({ path: p });
  assert.equal(pushed.bytes, 50 * MIB);
  assert.equal(pushed.sha256, digest(bytes));
  const pulled = await f.workspace.pull({ ...f.input, path: p });
  assert.equal(pulled.bytes, 50 * MIB);
  assert.equal(pulled.sha256, pushed.sha256);
  assert.equal((await lstat(pulled.localPath)).size, 50 * MIB);
  const remote = f.files.get(ROOT + "/sessions/" + SID + "/" + p);
  assert.equal(remote.readUInt32LE(0), 0x04034b50);
  assert.equal(remote.readUInt32LE(remote.length - 22), 0x06054b50);
});

test("ZIP above 64MiB fails snapshot and metadata checks without artifact transfer", async (t) => {
  const f = await actualTransferFixture(t),
    p = "exports/too-large.zip",
    remote = ROOT + "/sessions/" + SID + "/" + p;
  await truncate(f.source, 65 * MIB);
  const count = f.writes.length;
  await fails(f.push({ path: p }), "FILE_LIMIT");
  f.files.set(remote, Buffer.from("x"));
  f.infoHook = (target, entry) =>
    target === remote ? { ...entry, size: 65 * MIB } : entry;
  await fails(f.workspace.pull({ ...f.input, path: p }), "FILE_LIMIT");
  assert.equal(f.writes.length, count);
  assert.equal(
    f.transfers.some((r) => r.path === remote),
    false,
  );
});

test("a smaller configured cap remains effective for ordinary and ZIP snapshots and metadata", async (t) => {
  const f = await actualTransferFixture(t, { maxBytes: 20 * MIB });
  await truncate(f.source, 21 * MIB);
  for (const p of ["exports/small.bin", "exports/small.zip"]) {
    const remote = ROOT + "/sessions/" + SID + "/" + p;
    await fails(f.push({ path: p }), "FILE_LIMIT");
    f.files.set(remote, Buffer.from("x"));
    f.infoHook = (target, entry) =>
      target === remote ? { ...entry, size: 21 * MIB } : entry;
    await fails(f.workspace.pull({ ...f.input, path: p }), "FILE_LIMIT");
    assert.equal(
      f.transfers.some((r) => r.path === remote),
      false,
    );
  }
});

test("actual download streams obey ordinary32 ZIP64 and smaller config caps despite small metadata", async (t) => {
  for (const [p, cap, actualMiB] of [
    ["file.bin", 128, 33],
    ["file.zip", 128, 65],
    ["file.ZIP", 20, 21],
  ]) {
    const f = await actualTransferFixture(t, { maxBytes: cap * MIB }),
      remote = ROOT + "/sessions/" + SID + "/" + p;
    f.files.set(remote, Buffer.from("x"));
    f.downloadResponse = (target) =>
      target === remote
        ? new Response(
            new ReadableStream({
              start(controller) {
                const chunk = new Uint8Array(MIB);
                for (let i = 0; i < actualMiB; i++) controller.enqueue(chunk);
                controller.close();
              },
            }),
            { headers: { "content-type": "application/octet-stream" } },
          )
        : undefined;
    await fails(f.workspace.pull({ ...f.input, path: p }), "FILE_LIMIT");
    assert.equal(f.transfers.filter((r) => r.path === remote).length, 1);
    const cache = await readdir(
      path.join(f.config.stateDir, "workspace-cache"),
      { recursive: true, withFileTypes: true },
    );
    assert.equal(cache.filter((entry) => entry.isFile()).length, 0);
  }
});

test("authentication truth is protected, timestamped, sanitized, and never inferred from configuration", async (t) => {
  const f = await fixture(t),
    localStatus = async () => ({
      configured: true,
      mode: "account",
      protection: "Windows-DPAPI",
      accountId: "untrusted",
    });
  assert.equal((await cloudStatus(f.config)).code, "AUTH_REQUIRED");
  const options = { drive: f.drive, localStatus };
  const ready = await cloudStatus(f.config, options);
  assert.equal(ready.verified, true);
  assert.equal(ready.source, "protected-api:cloud-account");
  assert.equal(ready.accountId, ACCOUNT);
  assert.ok(Number.isFinite(Date.parse(ready.checkedAt)));
  assert.ok(!JSON.stringify(ready).includes(EMAIL));
  const local = await cloudStatus(f.config, { ...options, verify: false });
  assert.equal(local.state, "unverified");
  assert.equal(local.checkedAt, null);
  assert.equal(local.accountId, undefined);
  assert.equal(
    (
      await cloudStatus(f.config, {
        verify: false,
        localStatus: async () => ({ configured: false }),
      })
    ).state,
    "login-required",
  );
  assert.equal(
    (
      await cloudStatus(f.config, {
        localStatus: async () => ({ configured: false }),
      })
    ).code,
    "AUTH_REQUIRED",
  );
  const repositoryOnly = await cloudStatus(f.config, {
    drive: f.drive,
    localStatus: async () => ({ configured: true, mode: "repo" }),
  });
  assert.equal(repositoryOnly.state, "unverified");
  assert.equal(repositoryOnly.code, "ACCOUNT_API_UNSUPPORTED");
  assert.equal((await cloudStatus({ ...f.config, mock: true })).state, "mock");
  assert.equal(
    (await cloudStatus(f.config, { ...options, drive: {} })).code,
    "ACCOUNT_API_UNSUPPORTED",
  );
  for (const email of [undefined, "bad", " x@y.test", "name only"]) {
    f.email = email;
    assert.equal((await cloudStatus(f.config, options)).code, "UNVERIFIED");
  }
  f.drive.request = async () => {
    throw new CloudError("AUTH_REQUIRED", "expired");
  };
  assert.equal((await cloudStatus(f.config, options)).code, "AUTH_EXPIRED");
  f.drive.request = async () => {
    throw new TypeError("offline");
  };
  assert.equal((await cloudStatus(f.config, options)).state, "unknown");
  const broken = await cloudStatus(f.config, {
    verify: false,
    localStatus: async () => {
      throw Error("local failure");
    },
  });
  assert.equal(broken.verified, false);
  assert.equal(broken.source, "local:cloud-auth-store");
  for (const [e, code] of [
    [new CloudError("AUTH_CHANGED", "changed"), "AUTH_CHANGED"],
    [new DOMException("timeout", "TimeoutError"), "NETWORK_ERROR"],
    [Object.assign(Error(), { code: "ENOTFOUND" }), "NETWORK_ERROR"],
    [Error(), "UNVERIFIED"],
    [new CloudError("PERMISSION_DENIED", "denied"), "PERMISSION_DENIED"],
  ])
    assert.equal(authenticationFailure(e).code, code);
  await fails(protectedAccount({}), "ACCOUNT_API_UNSUPPORTED");
});

test("private preview, init, idempotence, relative list/pull and checked overwrite roundtrip", async (t) => {
  const f = await fixture(t);
  const preview = await f.workspace.status();
  assert.equal(preview.storage.state, "uninitialized");
  assert.equal(preview.storage.privacy.verified, true);
  assert.deepEqual(preview.storage.scope, {
    accountId: ACCOUNT,
    repoId: REPO,
    rootPath: ROOT,
  });
  assert.equal(f.writes.length, 0);
  assert.equal((await f.init()).storage.state, "ready");
  const count = f.writes.length;
  assert.equal((await f.init()).storage.state, "ready");
  assert.equal(f.writes.length, count);
  assert.deepEqual(
    (await f.workspace.list({ accountId: ACCOUNT, sessionId: SID })).entries,
    [],
  );
  const pushed = await f.push();
  assert.equal(pushed.sha256, digest("hello"));
  assert.equal(pushed.atomicReplace, false);
  assert.equal(pushed.bytes, 5);
  const listed = await f.workspace.list({
    accountId: ACCOUNT,
    sessionId: SID,
    recursive: true,
  });
  assert.deepEqual(
    listed.entries.map((r) => r.path),
    ["nested", "nested/file.txt"],
  );
  assert.deepEqual(
    (
      await f.workspace.list({ accountId: ACCOUNT, sessionId: SID })
    ).entries.map((r) => r.type),
    ["dir"],
  );
  assert.equal(
    (await f.workspace.list({ ...f.input, path: "nested" })).entries[0]
      .remoteId,
    pushed.remoteId,
  );
  const pulled = await f.workspace.pull(f.input);
  assert.equal(await readFile(pulled.localPath, "utf8"), "hello");
  assert.equal(pulled.sha256, pushed.sha256);
  assert.ok(
    pulled.localPath.startsWith(
      path.join(f.config.stateDir, "workspace-cache", ACCOUNT, SID),
    ),
  );
  await fails(f.push(), "REMOTE_CONFLICT");
  await fails(f.push({ overwrite: true }), "REMOTE_CONFLICT");
  await fails(
    f.push({ overwrite: true, expectedRemoteId: "wrong" }),
    "REMOTE_CONFLICT",
  );
  await writeFile(f.source, "updated");
  assert.equal(
    (await f.push({ overwrite: true, expectedRemoteId: pushed.remoteId }))
      .bytes,
    7,
  );
  f.files.delete(f.remote);
  await fails(
    f.push({ overwrite: true, expectedRemoteId: pushed.remoteId }),
    "REMOTE_CONFLICT",
  );
});

const privacyCases = [
  [
    "default missing",
    "/api2/default-repo/",
    { exists: false },
    "PRIVACY_UNSUPPORTED",
  ],
  [
    "default malformed",
    "/api2/default-repo/",
    { exists: true, repo_id: "bad" },
    "PRIVACY_UNSUPPORTED",
  ],
  [
    "owned list malformed",
    "/api2/repos/?type=mine",
    { results: [] },
    "PRIVACY_UNSUPPORTED",
  ],
  [
    "owned row malformed",
    "/api2/repos/?type=mine",
    [null],
    "PRIVACY_UNSUPPORTED",
  ],
  ["not owned", "/api2/repos/?type=mine", [], "NOT_PRIVATE"],
  ["public", "/api2/repos/?type=org", [{ id: REPO }], "NOT_PRIVATE"],
  ["public unknown", "/api2/repos/?type=org", [{}], "PRIVACY_UNSUPPORTED"],
  [
    "root user",
    `/api2/repos/${REPO}/dir/shared_items/?p=%2F&share_type=user`,
    [{}],
    "NOT_PRIVATE",
  ],
  [
    "root group",
    `/api2/repos/${REPO}/dir/shared_items/?p=%2F&share_type=group`,
    [{}],
    "NOT_PRIVATE",
  ],
  [
    "user inherited ACL",
    `/api2/repos/${REPO}/user-folder-perm/`,
    [{ folder_path: "/" }],
    "NOT_PRIVATE",
  ],
  [
    "group child ACL",
    `/api2/repos/${REPO}/group-folder-perm/`,
    [{ folder_path: ROOT + "/child" }],
    "NOT_PRIVATE",
  ],
  [
    "unknown ACL",
    `/api2/repos/${REPO}/user-folder-perm/`,
    [{}],
    "PRIVACY_UNSUPPORTED",
  ],
  [
    "download ancestor",
    `/api2/repos/${REPO}/download-shared-links/`,
    [{ path: "/" }],
    "NOT_PRIVATE",
  ],
  [
    "upload target",
    `/api2/repos/${REPO}/upload-shared-links/`,
    [{ path: ROOT + "/" }],
    "NOT_PRIVATE",
  ],
  [
    "folder share",
    "/api/v2.1/shared-folders/",
    [{ repo_id: REPO, path: ROOT + "/child" }],
    "NOT_PRIVATE",
  ],
  [
    "folder identity unknown",
    "/api/v2.1/shared-folders/",
    [{}],
    "PRIVACY_UNSUPPORTED",
  ],
  [
    "unsupported",
    `/api2/repos/${REPO}/group-folder-perm/`,
    new CloudError("PERMISSION_DENIED", "no audit", 403),
    "PRIVACY_UNSUPPORTED",
  ],
];
for (const [name, endpoint, value, code] of privacyCases)
  test("privacy fail-closed: " + name, async (t) => {
    const f = await fixture(t);
    f.metadata.set(endpoint, value);
    const s = await f.workspace.status();
    assert.equal(s.storage.privacy.verified, false);
    assert.equal(s.storage.code, code);
    await fails(f.init(), code);
    assert.equal(f.writes.length, 0);
  });

test("library ownership flags and mock cannot masquerade as a private account", async (t) => {
  const f = await fixture(t);
  for (const patch of [
    { type: "srepo" },
    { owner: "other@example.test" },
    { encrypted: true },
    { virtual: true },
    { permission: "r" },
  ]) {
    const old = { ...f.repo };
    Object.assign(f.repo, patch);
    assert.equal((await f.workspace.status()).storage.code, "NOT_PRIVATE");
    f.repo = old;
  }
  const mock = new CloudWorkspace(
    { ...f.config, mock: true },
    f.drive,
    f.transfer,
  );
  assert.equal((await mock.status()).storage.privacy.verified, false);
  const noAPI = new CloudWorkspace(f.config, {}, f.transfer);
  assert.equal((await noAPI.status()).storage.code, "ACCOUNT_API_UNSUPPORTED");
  f.drive.request = async () => {
    throw new CloudError("AUTH_REQUIRED", "missing");
  };
  assert.equal((await f.workspace.status()).storage.state, "login-required");
});

test("unrelated sibling grants do not imply scope sharing; unknown scope grants do", async (t) => {
  const f = await fixture(t),
    base = `/api2/repos/${REPO}`;
  f.metadata.set(base + "/download-shared-links/", [{ path: "/unrelated" }]);
  f.metadata.set(base + "/user-folder-perm/", [{ folder_path: "/unrelated" }]);
  f.metadata.set("/api/v2.1/shared-folders/", [
    { repo_id: "33333333-3333-4333-8333-333333333333", path: "/" },
  ]);
  assert.equal((await f.workspace.status()).storage.privacy.verified, true);
  await f.init();
  f.metadata.set(
    base +
      "/dir/shared_items/?p=" +
      encodeURIComponent(ROOT) +
      "&share_type=user",
    [{}],
  );
  assert.equal((await f.workspace.status()).storage.code, "NOT_PRIVATE");
});

test("initialization is tied to approved account and repo; never adopts existing data", async (t) => {
  const f = await fixture(t);
  await fails(
    f.workspace.init({ accountId: "bad", expectedRepoId: REPO }),
    "INVALID_ARGUMENTS",
  );
  await fails(
    f.workspace.init({ accountId: ACCOUNT, expectedRepoId: "bad" }),
    "INVALID_REPO",
  );
  await fails(
    f.workspace.init({ accountId: "0".repeat(32), expectedRepoId: REPO }),
    "ACCOUNT_MISMATCH",
  );
  await fails(
    f.workspace.init({ accountId: ACCOUNT, expectedRepoId: SID }),
    "REPO_MISMATCH",
  );
  f.dirs.add(ROOT);
  assert.equal((await f.workspace.status()).storage.code, "WORKSPACE_UNBOUND");
  await fails(f.init(), "WORKSPACE_UNBOUND");
  assert.equal(f.writes.length, 0);
  f.dirs.delete(ROOT);
  f.files.set(ROOT, Buffer.from("other user data"));
  assert.equal((await f.workspace.status()).storage.code, "WORKSPACE_CONFLICT");
});

test("online identity changes invalidate status and all existing session operations", async (t) => {
  const f = await fixture(t);
  await f.init();
  f.email = "new@example.test";
  for (const op of [
    () => f.workspace.list(f.input),
    () => f.workspace.pull(f.input),
    () => f.push(),
  ])
    await fails(op(), "ACCOUNT_MISMATCH");
  f.email = EMAIL;
  f.onAccount = () => {
    if (f.accountCalls % 2 === 0) f.email = "new@example.test";
  };
  f.accountCalls = 0;
  assert.equal((await f.workspace.status()).storage.code, "ACCOUNT_MISMATCH");
});

test("remote binding marker protects ready state and initializing recovery never rewrites", async (t) => {
  const f = await fixture(t);
  await f.init();
  const bindingFile = path.join(
    f.config.stateDir,
    "workspace-bindings",
    ACCOUNT + ".json",
  );
  const binding = JSON.parse(await readFile(bindingFile, "utf8"));
  binding.phase = "creating";
  await writeFile(bindingFile, JSON.stringify(binding));
  assert.equal(
    (await f.workspace.status()).storage.code,
    "WORKSPACE_INIT_UNKNOWN",
  );
  const count = f.writes.length;
  assert.equal((await f.init()).storage.state, "ready");
  assert.equal(f.writes.length, count);
  f.files.set(MARKER, Buffer.from("{}"));
  assert.equal((await f.workspace.status()).storage.code, "WORKSPACE_UNBOUND");
  await fails(f.workspace.list(f.input), "WORKSPACE_UNBOUND");
});

test("incomplete initialization and absent session marker fail closed", async (t) => {
  const f = await fixture(t);
  await f.init();
  f.dirs.delete(ROOT + "/sessions");
  assert.equal((await f.workspace.status()).storage.code, "WORKSPACE_UNBOUND");
  f.dirs.delete(ROOT);
  await fails(f.workspace.list(f.input), "WORKSPACE_UNINITIALIZED");
});

for (const failure of ["mkdir", "marker", "sessions"])
  test("init unknown is not blindly retried: " + failure, async (t) => {
    const f = await fixture(t);
    if (failure === "marker")
      f.uploadHook = async () => ({ status: "unknown" });
    else
      f.mkdirHook = async (p) => {
        if (p === (failure === "mkdir" ? ROOT : ROOT + "/sessions"))
          throw Error("connection lost");
      };
    await fails(f.init(), "WORKSPACE_INIT_UNKNOWN");
    const count = f.writes.length;
    await assert.rejects(f.init());
    assert.equal(f.writes.length, count);
  });

test("path and file confinement reject traversal, drive paths, device names, links and excess bytes", async (t) => {
  const f = await fixture(t);
  await f.init();
  for (const p of [
    "",
    "/",
    "../a",
    "a/../b",
    "a//b",
    "a\\b",
    "C:/x",
    "%2e%2e/x",
    "%2froot",
    "CON",
    "a.",
    "a ",
    ".hidden/..",
    "a\0b",
    "a/".repeat(700),
  ])
    assert.throws(() => workspaceRelative(p));
  assert.equal(workspaceRelative("."), ".");
  assert.equal(workspaceRelative("中文/a.txt"), "中文/a.txt");
  assert.throws(() => workspaceRelative(".", false));
  await fails(
    f.workspace.list({ ...f.input, sessionId: "bad" }),
    "INVALID_SESSION",
  );
  await fails(
    f.workspace.list({ ...f.input, accountId: "bad" }),
    "INVALID_ARGUMENTS",
  );
  await fails(f.push({ sourcePath: "relative" }), "ABSOLUTE_PATH");
  await fails(f.push({ sourcePath: f.root }), "FILE_LIMIT");
  const link = path.join(f.root, "linked");
  await symlink(f.root, link, "junction");
  await fails(
    f.push({ sourcePath: path.join(link, "source.txt") }),
    "UNSAFE_PATH",
  );
  const tiny = new CloudWorkspace(
    { ...f.config, maxBytes: 2 },
    f.drive,
    f.transfer,
  );
  await fails(tiny.push({ ...f.input, sourcePath: f.source }), "FILE_LIMIT");
});

test("list is bounded, complete and confined even with hostile remote metadata", async (t) => {
  const f = await fixture(t);
  await f.init();
  await f.push();
  await fails(
    f.workspace.list({ ...f.input, path: "nested/file.txt" }),
    "NOT_DIRECTORY",
  );
  for (const hook of [
    () => ({ items: [], total: 1, offset: 0 }),
    () => ({ items: [], total: 0, offset: 0, nextOffset: 0 }),
    () => ({ items: Array(1001).fill({}), total: 1001, offset: 0 }),
    () => ({
      items: [{ name: "escape", path: "/escape", type: "file" }],
      total: 1,
      offset: 0,
    }),
    () => ({
      items: [
        {
          name: "different",
          path: ROOT + "/sessions/" + SID + "/safe",
          type: "file",
        },
      ],
      total: 1,
      offset: 0,
    }),
  ]) {
    f.listHook = hook;
    await assert.rejects(
      f.workspace.list({ accountId: ACCOUNT, sessionId: SID, recursive: true }),
    );
  }
});

test("pull requires known bounded file metadata and discards cache on concurrent remote/account change", async (t) => {
  const f = await fixture(t);
  await f.init();
  await fails(f.workspace.pull(f.input), "NOT_FOUND");
  await f.push();
  for (const patch of [
    { id: undefined },
    { size: undefined },
    { size: 2000 },
  ]) {
    f.infoHook = (p, entry) =>
      p === f.remote ? { ...entry, ...patch } : entry;
    await fails(
      f.workspace.pull(f.input),
      patch.id === undefined && "id" in patch ? "NOT_FOUND" : "FILE_LIMIT",
    );
  }
  f.infoHook = undefined;
  let cached;
  f.downloadHook = async (input) => {
    cached = path.join(input.outputDir, input.filename);
    f.files.set(f.remote, Buffer.from("change"));
  };
  await fails(f.workspace.pull(f.input), "FILE_CHANGED");
  await assert.rejects(lstat(cached), { code: "ENOENT" });
  f.downloadHook = async (input) => {
    cached = path.join(input.outputDir, input.filename);
    f.email = "new@example.test";
  };
  await fails(f.workspace.pull(f.input), "FILE_CHANGED");
  await assert.rejects(lstat(cached), { code: "ENOENT" });
});

test("pull reconciles only byte-identical unknown writes without any cloud mutation", async (t) => {
  const f = await fixture(t);
  await f.init();
  f.uploadHook = async (input) => {
    f.files.set(input.path, await readFile(input.filePath));
    return { status: "unknown" };
  };
  await fails(f.push(), "WORKSPACE_WRITE_UNKNOWN");
  const writes = f.writes.length;
  assert.equal((await f.workspace.pull(f.input)).reconciledWrite, true);
  assert.equal(f.writes.length, writes);
  f.uploadHook = undefined;
  const old = f.entry(f.remote).id;
  await writeFile(f.source, "new version");
  assert.equal(
    (await f.push({ overwrite: true, expectedRemoteId: old })).bytes,
    11,
  );
});

test("mismatched readback leaves unknown write locked", async (t) => {
  const f = await fixture(t);
  await f.init();
  await f.push();
  const old = f.entry(f.remote).id;
  await writeFile(f.source, "not committed");
  f.uploadHook = async () => ({ status: "unknown" });
  await fails(
    f.push({ overwrite: true, expectedRemoteId: old }),
    "WORKSPACE_WRITE_UNKNOWN",
  );
  const count = f.writes.length;
  assert.equal((await f.workspace.pull(f.input)).reconciledWrite, false);
  await fails(
    f.push({ overwrite: true, expectedRemoteId: old }),
    "WORKSPACE_WRITE_UNKNOWN",
  );
  assert.equal(f.writes.length, count);
});

for (const kind of ["receipt", "throw", "metadata", "account", "parent"])
  test("push unknown is recorded and not retried: " + kind, async (t) => {
    const f = await fixture(t);
    await f.init();
    if (kind === "receipt") f.uploadHook = async () => ({ status: "unknown" });
    if (kind === "throw")
      f.uploadHook = async () => {
        throw Error("lost");
      };
    if (kind === "metadata")
      f.uploadHook = async () => ({ status: "complete" });
    if (kind === "account")
      f.mkdirHook = async () => {
        f.email = "new@example.test";
      };
    if (kind === "parent")
      f.files.set(ROOT + "/sessions/" + SID, Buffer.from("not dir"));
    await fails(f.push(), "WORKSPACE_WRITE_UNKNOWN");
    const count = f.writes.length;
    f.email = EMAIL;
    await fails(f.push(), "WORKSPACE_WRITE_UNKNOWN");
    assert.equal(f.writes.length, count);
  });
