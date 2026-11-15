import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { CloudWorkspace, WORKSPACE_ROOT as W, workspaceRelative } from '../src/workspace.js';
import { loadConfig } from '../src/config.js';
import { CloudError, type Entry } from '../src/types.js';
import { atomicJson, digest, readJson } from '../src/storage.js';
import { MockDrive, MOCK_REPO } from '../src/mock.js';

const fsBoundary = vi.hoisted(() => ({ actual: undefined as any }));
vi.mock('node:fs/promises', async original => {
  const actual = await original<typeof import('node:fs/promises')>(); fsBoundary.actual = actual;
  return { ...actual, lstat: vi.fn(actual.lstat), open: vi.fn(actual.open) };
});

const QA = path.resolve('D:/code/thu-campus-mcp/.local/qa-temp');
const RID = MOCK_REPO, OTHER = '22222222-2222-4222-8222-222222222222';
const SID = '33333333-3333-4333-8333-333333333333';
const EMAIL = 'workspace-unit@example.test', AID = digest(EMAIL).slice(0, 32);
const MARKER = W + '/.thu-campus-agent.json';
let root: string;
beforeEach(async () => {
  vi.mocked(fs.lstat).mockReset().mockImplementation(fsBoundary.actual.lstat);
  vi.mocked(fs.open).mockReset().mockImplementation(fsBoundary.actual.open);
  for (const name of ['TEMP', 'TMP', 'TMPDIR']) vi.stubEnv(name, QA);
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('Real network forbidden'); }));
  await mkdir(QA, { recursive: true });
  root = await mkdtemp(path.join(QA, 'cloud-sdk-edges-2-'));
});
afterEach(async () => {
  vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs();
  expect(path.dirname(path.resolve(root))).toBe(QA);
  expect(path.basename(root)).toMatch(/^cloud-sdk-edges-2-/);
  await rm(root, { recursive: true, force: true });
});

function fixture(options: { mock?: boolean; maxBytes?: number } = {}) {
  const cfg = loadConfig({ stateDir: path.join(root, 'state'), outputDir: path.join(root, 'out'), mock: false, ...options });
  const files = new Map<string, Entry>();
  const bytes = new Map<string, Buffer>();
  const responses = new Map<string, any>();
  const remote = (p: string, content: string | Buffer = 'abc', id = digest(content)) => {
    const data = Buffer.from(content); bytes.set(p, data);
    files.set(p, { path: p, name: path.posix.basename(p), type: 'file', id, size: data.length });
  };
  const dir = (p: string) => files.set(p, { path: p, name: path.posix.basename(p), type: 'dir', id: 'dir-' + p });
  const drive = {
    identity: '', checkAuth: vi.fn(async () => undefined),
    request: vi.fn(async (endpoint: string) => {
      if (responses.has(endpoint)) {
        const value = responses.get(endpoint);
        if (value instanceof Error) throw value;
        return typeof value === 'function' ? value() : value;
      }
      if (endpoint === '/api2/account/info/') return { email: EMAIL };
      if (endpoint === '/api2/default-repo/') return { exists: true, repo_id: RID };
      if (endpoint === '/api2/repos/?type=mine') return [{ id: RID, owner: EMAIL, type: 'repo', encrypted: false, virtual: false, permission: 'rw' }];
      return [];
    }),
    info: vi.fn(async (_id: string, p: string) => files.get(p) ? { ...files.get(p)! } : undefined),
    list: vi.fn(async (_id: string, p: string) => {
      const items = [...files.values()].filter(f => path.posix.dirname(f.path) === p && f.path !== p).map(f => ({ ...f }));
      return { items, total: items.length, offset: 0, nextOffset: undefined as number | undefined };
    }),
    mkdir: vi.fn(async (_id: string, p: string) => { if (files.has(p)) throw new CloudError('CONFLICT', 'exists'); dir(p); return { createdPath: p }; }),
  };
  const transfers = {
    read: vi.fn(async (_id: string, p: string) => ({ content: bytes.get(p)!.toString('utf8') })),
    upload: vi.fn(async (input: any) => { remote(input.path, await readFile(input.filePath)); return { status: 'complete' }; }),
    download: vi.fn(async (input: any) => {
      const data = bytes.get(input.path)!; const filePath = path.join(input.outputDir, input.filename);
      await writeFile(filePath, data); return { filePath, sha256: digest(data), bytes: data.length };
    }),
  };
  const workspace = new CloudWorkspace(cfg, drive as any, transfers as any);
  const binding = path.join(cfg.stateDir, 'workspace-bindings', AID + '.json');
  const session = W + '/sessions/' + SID;
  const input = { accountId: AID, sessionId: SID };
  const intent = (p: string) => path.join(cfg.stateDir, 'workspace-writes', AID, digest(session + '/' + p) + '.json');
  async function ready(phase = 'ready') {
    dir(W); dir(W + '/sessions');
    remote(MARKER, JSON.stringify({ version: 1, accountId: AID, repoId: RID, workspaceId: SID }));
    await atomicJson(binding, { accountId: AID, repoId: RID, workspaceId: SID, phase });
  }
  async function source(content = 'abc') { const file = path.join(root, 'input-' + digest(content).slice(0, 8)); await writeFile(file, content); return file; }
  return { cfg, drive, transfers, workspace, files, bytes, responses, remote, dir, binding, session, input, intent, ready, source };
}
const base = `/api2/repos/${RID}`;
const rejectedStatus = async (f: ReturnType<typeof fixture>, code: string) => {
  expect(await f.workspace.status()).toMatchObject({ storage: { state: 'unverified', code, privacy: { verified: false } } });
  expect(f.drive.mkdir).not.toHaveBeenCalled(); expect(f.transfers.upload).not.toHaveBeenCalled();
};

describe('workspace relative path guards', () => {
  it.each(['', '/absolute', 'a\\b', 'a:b', 'a\0b', 'a%2fb', 'a%2Eb', 'a%5cb', '../x', './x', 'x//y', 'x/', 'x.', 'x ', 'CON', 'nul.txt', 'com1', 'LPT9.csv', '*', '?', 'a'.repeat(1025)])('rejects unsafe relative %j', value => {
    expect(() => workspaceRelative(value)).toThrow(expect.objectContaining({ code: 'UNSAFE_PATH' }));
  });
  it('accepts Unicode paths, defaults root, and distinguishes a root-forbidden operation', () => {
    expect(workspaceRelative()).toBe('.'); expect(workspaceRelative('资料/报告.zip')).toBe('资料/报告.zip');
    expect(() => workspaceRelative('.', false)).toThrow(expect.objectContaining({ code: 'UNSAFE_PATH' }));
    expect(() => workspaceRelative(null as any)).toThrow(expect.objectContaining({ code: 'UNSAFE_PATH' }));
  });
});

describe('real workspace fail-closed privacy audit', () => {
  it('previews an uninitialized scope, initializes once, and reuses the exact bound marker', async () => {
    const f = fixture();
    expect(await f.workspace.status()).toMatchObject({ accountId: AID, storage: { state: 'uninitialized', code: 'WORKSPACE_UNINITIALIZED', privacy: { verified: true } } });
    expect(await f.workspace.init({ accountId: AID, expectedRepoId: RID })).toMatchObject({ storage: { state: 'ready' } });
    expect(await readJson(f.binding)).toMatchObject({ accountId: AID, repoId: RID, phase: 'ready' });
    expect(f.drive.mkdir).toHaveBeenCalledTimes(2); expect(f.transfers.upload).toHaveBeenCalledOnce();
    expect(await f.workspace.init({ accountId: AID, expectedRepoId: RID })).toMatchObject({ storage: { state: 'ready' } });
    expect(f.transfers.upload).toHaveBeenCalledOnce();
    const markerFile = f.transfers.upload.mock.calls[0][0].filePath;
    await expect(readFile(markerFile)).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it.each([
    ['default absent', '/api2/default-repo/', { exists: false }, 'PRIVACY_UNSUPPORTED'],
    ['default malformed', '/api2/default-repo/', { exists: true, repo_id: 'wrong' }, 'PRIVACY_UNSUPPORTED'],
    ['owned missing', '/api2/repos/?type=mine', [], 'NOT_PRIVATE'],
    ['non-array audit', '/api2/repos/?type=org', {}, 'PRIVACY_UNSUPPORTED'],
    ['nonobject audit', '/api2/repos/?type=org', [null], 'PRIVACY_UNSUPPORTED'],
    ['array row audit', '/api2/repos/?type=org', [[]], 'PRIVACY_UNSUPPORTED'],
    ['oversized audit', '/api2/repos/?type=org', Array.from({ length: 20001 }, () => ({})), 'PRIVACY_UNSUPPORTED'],
    ['public malformed', '/api2/repos/?type=org', [{ id: 'invalid' }], 'PRIVACY_UNSUPPORTED'],
    ['public library', '/api2/repos/?type=org', [{ id: RID }], 'NOT_PRIVATE'],
    ['user share', base + '/dir/shared_items/?p=%2F&share_type=user', [{}], 'NOT_PRIVATE'],
    ['group share', base + '/dir/shared_items/?p=%2F&share_type=group', [{}], 'NOT_PRIVATE'],
    ['ACL root', base + '/user-folder-perm/', [{ folder_path: '/' }], 'NOT_PRIVATE'],
    ['ACL descendant', base + '/group-folder-perm/', [{ folder_path: W + '/child' }], 'NOT_PRIVATE'],
    ['download link', base + '/download-shared-links/', [{ path: W }], 'NOT_PRIVATE'],
    ['upload link', base + '/upload-shared-links/', [{ path: W + '/child' }], 'NOT_PRIVATE'],
    ['missing ACL path', base + '/user-folder-perm/', [{}], 'PRIVACY_UNSUPPORTED'],
    ['folder id absent', '/api/v2.1/shared-folders/', [{ path: W }], 'PRIVACY_UNSUPPORTED'],
    ['folder share', '/api/v2.1/shared-folders/', [{ repo_id: RID, path: W }], 'NOT_PRIVATE'],
    ['API unavailable', base + '/user-folder-perm/', new Error('private diagnostic'), 'PRIVACY_UNSUPPORTED'],
  ])('refuses %s without writing', async (_label, endpoint, response, code) => {
    const f = fixture(); f.responses.set(endpoint as string, response); await rejectedStatus(f, code as string);
  });
  it.each([
    { type: 'group' }, { owner: 'other@example.test' }, { encrypted: true }, { virtual: true }, { permission: 'r' },
  ])('requires explicit personal owner metadata %j', async patch => {
    const f = fixture(); f.responses.set('/api2/repos/?type=mine', [{ id: RID, type: 'repo', owner: EMAIL, encrypted: false, virtual: false, permission: 'rw', ...patch }]);
    await rejectedStatus(f, 'NOT_PRIVATE');
  });
  it('allows unrelated ACLs and shares but refuses target-directory shares', async () => {
    const f = fixture();
    f.responses.set(base + '/user-folder-perm/', [{ folder_path: '/unrelated' }]);
    f.responses.set(base + '/download-shared-links/', [{ path: '/unrelated' }]);
    f.responses.set('/api/v2.1/shared-folders/', [{ repo_id: OTHER, path: W }, { repo_id: RID, path: '/unrelated' }]);
    expect((await f.workspace.status()).storage.privacy.verified).toBe(true);
    f.dir(W); f.responses.set(base + '/dir/shared_items/?p=' + encodeURIComponent(W) + '&share_type=group', [{}]);
    await rejectedStatus(f, 'NOT_PRIVATE');
  });
  it('refuses mock or unsupported request backends and a file at the workspace root', async () => {
    const f = fixture({ mock: true }); await rejectedStatus(f, 'PRIVACY_UNSUPPORTED');
    const real = fixture(); (real.drive as any).request = undefined; await rejectedStatus(real, 'ACCOUNT_API_UNSUPPORTED');
    const conflict = fixture(); conflict.remote(W); await rejectedStatus(conflict, 'WORKSPACE_CONFLICT');
  });
  it.each(['AUTH_REQUIRED', 'AUTH_CHANGED'])('preserves authentication failure %s', async code => {
    const f = fixture(); f.responses.set('/api2/default-repo/', new CloudError(code, 'auth'));
    expect(await f.workspace.status()).toMatchObject({ storage: { code, state: code === 'AUTH_REQUIRED' ? 'login-required' : 'unverified' } });
  });
  it('reports account changes during audit, invalid accounts, and non-Cloud errors without private details', async () => {
    const f = fixture(); let count = 0;
    f.responses.set('/api2/account/info/', () => ({ email: ++count === 1 ? EMAIL : 'changed@example.test' }));
    await rejectedStatus(f, 'ACCOUNT_MISMATCH');
    f.responses.set('/api2/account/info/', { email: 'invalid' }); await rejectedStatus(f, 'UNVERIFIED');
    f.responses.set('/api2/account/info/', new Error('private details')); const result = await f.workspace.status();
    expect(result.storage.code).toBe('UNVERIFIED'); expect(JSON.stringify(result)).not.toContain('private details');
  });
});

describe('workspace bindings, marker validation and initialization failures', () => {
  it('validates account and repository arguments before mutation', async () => {
    const f = fixture();
    await expect(f.workspace.init({ accountId: 'invalid', expectedRepoId: RID })).rejects.toMatchObject({ code: 'INVALID_ARGUMENTS' });
    await expect(f.workspace.init({ accountId: AID, expectedRepoId: 'invalid' })).rejects.toMatchObject({ code: 'INVALID_REPO' });
    await expect(f.workspace.init({ accountId: AID, expectedRepoId: OTHER })).rejects.toMatchObject({ code: 'REPO_MISMATCH' });
    await expect(f.workspace.init({ accountId: 'a'.repeat(32), expectedRepoId: RID })).rejects.toMatchObject({ code: 'ACCOUNT_MISMATCH' });
    expect(f.drive.mkdir).not.toHaveBeenCalled();
  });
  it('never adopts a preexisting directory without the matching private local binding', async () => {
    const f = fixture(); f.dir(W);
    expect(await f.workspace.status()).toMatchObject({ storage: { state: 'uninitialized', code: 'WORKSPACE_UNBOUND' } });
    await expect(f.workspace.init({ accountId: AID, expectedRepoId: RID })).rejects.toMatchObject({ code: 'WORKSPACE_UNBOUND' });
    for (const patch of [{ accountId: 'b'.repeat(32) }, { repoId: OTHER }]) {
      await atomicJson(f.binding, { accountId: AID, repoId: RID, workspaceId: SID, phase: 'ready', ...patch });
      await expect(f.workspace.init({ accountId: AID, expectedRepoId: RID })).rejects.toMatchObject({ code: 'WORKSPACE_UNBOUND' });
    }
    expect(f.transfers.upload).not.toHaveBeenCalled();
  });
  it.each([{ version: 2 }, { accountId: 'bad' }, { repoId: OTHER }, { workspaceId: OTHER }])('rejects a foreign marker %j', async patch => {
    const f = fixture(); await f.ready();
    f.remote(MARKER, JSON.stringify({ version: 1, accountId: AID, repoId: RID, workspaceId: SID, ...patch }));
    await rejectedStatus(f, 'WORKSPACE_UNBOUND');
  });
  it('reports malformed markers and missing sessions without assuming readiness', async () => {
    const f = fixture(); await f.ready(); f.remote(MARKER, 'not-json'); await rejectedStatus(f, 'UNVERIFIED');
    f.remote(MARKER, JSON.stringify({ version: 1, accountId: AID, repoId: RID, workspaceId: SID }));
    f.files.delete(W + '/sessions'); await rejectedStatus(f, 'WORKSPACE_UNBOUND');
  });
  it('recovers a verified creating binding without repeating initialization uploads', async () => {
    const f = fixture(); await f.ready('creating');
    expect(await f.workspace.status()).toMatchObject({ accountId: AID, storage: { state: 'unverified', code: 'WORKSPACE_INIT_UNKNOWN' } });
    expect(await f.workspace.init({ accountId: AID, expectedRepoId: RID })).toMatchObject({ storage: { state: 'ready' } });
    expect(await readJson(f.binding)).toMatchObject({ phase: 'ready' }); expect(f.transfers.upload).not.toHaveBeenCalled();
  });
  it('does not replay a creating binding whose remote root is absent', async () => {
    const f = fixture(); await atomicJson(f.binding, { accountId: AID, repoId: RID, workspaceId: SID, phase: 'creating' });
    await expect(f.workspace.init({ accountId: AID, expectedRepoId: RID })).rejects.toMatchObject({ code: 'WORKSPACE_INIT_UNKNOWN', status: 500 });
    expect(f.drive.mkdir).not.toHaveBeenCalled();
  });
  it.each(['receipt', 'throw', 'post-audit'])('preserves creating intent after initialization %s failure', async mode => {
    const f = fixture();
    if (mode === 'receipt') f.transfers.upload.mockResolvedValueOnce({ status: 'unknown' });
    if (mode === 'throw') f.transfers.upload.mockRejectedValueOnce(new Error('private upload issue'));
    if (mode === 'post-audit') f.drive.mkdir.mockImplementation(async (_id, p) => { f.dir(p); if (p.endsWith('/sessions')) f.responses.set(base + '/user-folder-perm/', [{ folder_path: W }]); return { createdPath: p }; });
    await expect(f.workspace.init({ accountId: AID, expectedRepoId: RID })).rejects.toMatchObject({ code: 'WORKSPACE_INIT_UNKNOWN' });
    expect(await readJson(f.binding)).toMatchObject({ phase: 'creating' });
    const staged = f.transfers.upload.mock.calls[0][0].filePath;
    await expect(readFile(staged)).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it.each(['missing', 'account', 'repo', 'phase', 'root'])('refuses list with %s binding state', async mode => {
    const f = fixture(); await f.ready();
    if (mode === 'missing') await rm(f.binding);
    else if (mode === 'root') f.files.delete(W);
    else await atomicJson(f.binding, { accountId: mode === 'account' ? 'b'.repeat(32) : AID, repoId: mode === 'repo' ? OTHER : RID, workspaceId: SID, phase: mode === 'phase' ? 'creating' : 'ready' });
    await expect(f.workspace.list(f.input)).rejects.toMatchObject({ code: 'WORKSPACE_UNINITIALIZED' });
  });
});

describe('workspace directory, download and write guards', () => {
  it('lists missing, shallow and recursive session paths without exposing siblings', async () => {
    const f = fixture(); await f.ready();
    expect(await f.workspace.list(f.input)).toMatchObject({ entries: [], complete: true, path: '.' });
    f.dir(f.session); f.dir(f.session + '/folder'); f.remote(f.session + '/a.txt'); f.remote(f.session + '/folder/nested.txt');
    expect((await f.workspace.list(f.input)).entries.map(e => e.path)).toEqual(['folder', 'a.txt']);
    expect((await f.workspace.list({ ...f.input, recursive: true })).entries.map(e => e.path)).toEqual(['folder', 'a.txt', 'folder/nested.txt']);
    await expect(f.workspace.list({ ...f.input, sessionId: 'invalid' })).rejects.toMatchObject({ code: 'INVALID_SESSION' });
    await expect(f.workspace.list({ ...f.input, path: 'a.txt' })).rejects.toMatchObject({ code: 'NOT_DIRECTORY' });
  });
  it.each(['next-page', 'wrong-total', 'too-many', 'outside', 'wrong-parent'])('rejects %s directory metadata', async mode => {
    const f = fixture(); await f.ready(); f.dir(f.session);
    const row = { path: f.session + '/a', name: 'a', type: 'file' as const };
    const items = mode === 'too-many' ? Array.from({ length: 1001 }, () => row) : [mode === 'outside' ? { ...row, path: W + '/outside' } : mode === 'wrong-parent' ? { ...row, path: f.session + '/nested/a' } : row];
    f.drive.list.mockResolvedValueOnce({ items, total: mode === 'wrong-total' ? 2 : items.length, offset: 0, nextOffset: mode === 'next-page' ? 1 : undefined });
    await expect(f.workspace.list(f.input)).rejects.toMatchObject({ code: ['outside', 'wrong-parent'].includes(mode) ? 'UNSAFE_PATH' : 'DIRECTORY_LIMIT' });
  });
  it.each(['missing', 'directory', 'missing-id', 'missing-size', 'too-large'])('refuses pull with %s remote metadata', async mode => {
    const f = fixture({ maxBytes: 4 }); await f.ready(); const p = f.session + '/file.txt';
    if (mode !== 'missing') f.remote(p);
    if (mode === 'directory') f.dir(p);
    if (mode === 'missing-id') f.files.get(p)!.id = undefined;
    if (mode === 'missing-size') f.files.get(p)!.size = undefined;
    if (mode === 'too-large') f.files.get(p)!.size = 5;
    await expect(f.workspace.pull({ ...f.input, path: 'file.txt' })).rejects.toMatchObject({ code: ['missing-size', 'too-large'].includes(mode) ? 'FILE_LIMIT' : 'NOT_FOUND' });
    expect(f.transfers.download).not.toHaveBeenCalled();
  });
  it.each(['remote', 'account'])('deletes downloaded cache if %s changed', async mode => {
    const f = fixture(); await f.ready(); f.remote(f.session + '/a.txt');
    const download = f.transfers.download.getMockImplementation()!;
    f.transfers.download.mockImplementationOnce(async input => {
      const receipt = await download(input);
      if (mode === 'remote') f.remote(f.session + '/a.txt', 'new', 'new-id');
      else f.responses.set('/api2/account/info/', { email: 'other@example.test' });
      return receipt;
    });
    await expect(f.workspace.pull({ ...f.input, path: 'a.txt' })).rejects.toMatchObject({ code: 'FILE_CHANGED' });
    const output = path.join(f.transfers.download.mock.calls[0][0].outputDir, 'content');
    await expect(readFile(output)).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it.each(['none', 'different', 'complete', 'match'])('reconciles only a matching unknown write journal: %s', async mode => {
    const f = fixture(); await f.ready(); f.remote(f.session + '/a.zip');
    if (mode !== 'none') await atomicJson(f.intent('a.zip'), { status: mode === 'complete' ? 'complete' : 'unknown', sha256: digest(mode === 'different' ? 'other' : 'abc'), requestId: SID });
    const receipt = await f.workspace.pull({ ...f.input, path: 'a.zip' });
    expect(receipt).toMatchObject({ reconciledWrite: mode === 'match', sha256: digest('abc'), bytes: 3 });
    expect(await readFile(receipt.localPath, 'utf8')).toBe('abc');
    if (mode === 'match') expect(await readJson(f.intent('a.zip'))).toMatchObject({ status: 'complete', remoteId: digest('abc'), reconciledAt: expect.any(String) });
    expect(f.transfers.upload).not.toHaveBeenCalled();
  });
  it('snapshots local source, creates parents, uploads once, and permits only exact expected-ID replacement', async () => {
    const f = fixture(); await f.ready(); const sourcePath = await f.source();
    const result = await f.workspace.push({ ...f.input, path: 'nested/a.zip', sourcePath });
    expect(result).toMatchObject({ path: 'nested/a.zip', bytes: 3, sha256: digest('abc'), remoteId: digest('abc'), atomicReplace: false, verification: 'server-metadata' });
    expect(f.files.get(f.session)?.type).toBe('dir'); expect(f.files.get(f.session + '/nested')?.type).toBe('dir');
    expect(await readJson(f.intent('nested/a.zip'))).toMatchObject({ status: 'complete', sha256: digest('abc') });
    const staged = f.transfers.upload.mock.calls[0][0].filePath; await expect(readFile(staged)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(sourcePath, 'utf8')).toBe('abc');
    expect(await f.workspace.push({ ...f.input, path: 'nested/a.zip', sourcePath, overwrite: true, expectedRemoteId: result.remoteId })).toMatchObject({ bytes: 3 });
    expect(f.transfers.upload).toHaveBeenCalledTimes(2);
  });
  it.each(['no-overwrite', 'no-id', 'wrong-id', 'directory', 'missing-expected'])('refuses %s replacement before upload', async mode => {
    const f = fixture(); await f.ready(); const sourcePath = await f.source();
    if (mode !== 'missing-expected') f.remote(f.session + '/a.txt');
    if (mode === 'directory') f.dir(f.session + '/a.txt');
    await expect(f.workspace.push({ ...f.input, path: 'a.txt', sourcePath, overwrite: mode !== 'no-overwrite', expectedRemoteId: mode === 'no-id' ? undefined : mode === 'wrong-id' ? 'wrong' : digest('abc') })).rejects.toMatchObject({ code: 'REMOTE_CONFLICT' });
    expect(f.transfers.upload).not.toHaveBeenCalled();
  });
  it.each(['relative', 'oversized', 'changed'])('rejects %s source snapshots without upload', async mode => {
    const f = fixture({ maxBytes: 3 }); await f.ready(); const sourcePath = mode === 'relative' ? 'relative.txt' : await f.source(mode === 'oversized' ? 'abcd' : 'abc');
    if (mode === 'changed') {
      const real = fsBoundary.actual.lstat; vi.mocked(fs.lstat).mockImplementation(async (...args: any[]) => {
        const stat = await (real as any)(...args);
        if (args[0] === sourcePath) return new Proxy(stat, { get(target, key) { return key === 'ino' ? -1 : typeof (target as any)[key] === 'function' ? (target as any)[key].bind(target) : (target as any)[key]; } });
        return stat;
      });
    }
    await expect(f.workspace.push({ ...f.input, path: 'a.txt', sourcePath })).rejects.toMatchObject({ code: mode === 'relative' ? 'ABSOLUTE_PATH' : mode === 'oversized' ? 'FILE_LIMIT' : 'FILE_CHANGED' });
    expect(f.transfers.upload).not.toHaveBeenCalled();
  });
  it('rejects a source under a directory junction before reading or uploading it', async () => {
    const f = fixture(); await f.ready(); const target = path.join(root, 'source-dir'); await mkdir(target);
    await writeFile(path.join(target, 'source.txt'), 'abc'); const link = path.join(root, 'source-link'); await fs.symlink(target, link, 'junction');
    await expect(f.workspace.push({ ...f.input, path: 'a.txt', sourcePath: path.join(link, 'source.txt') })).rejects.toMatchObject({ code: 'UNSAFE_PATH' });
    expect(f.transfers.upload).not.toHaveBeenCalled(); expect(fs.open).not.toHaveBeenCalled();
  });
  it('closes the real source handle and refuses bytes that grow beyond the snapshot limit', async () => {
    const f = fixture({ maxBytes: 3 }); await f.ready(); const sourcePath = await f.source(); let closed: ReturnType<typeof vi.spyOn> | undefined;
    vi.mocked(fs.open).mockImplementationOnce(async (...args: any[]) => {
      const handle = await fsBoundary.actual.open(...args); const stat = handle.stat.bind(handle); closed = vi.spyOn(handle, 'close');
      vi.spyOn(handle, 'stat').mockImplementationOnce(async () => { const before = await stat(); await writeFile(sourcePath, 'abcdef'); return before; });
      return handle;
    });
    await expect(f.workspace.push({ ...f.input, path: 'a.txt', sourcePath })).rejects.toMatchObject({ code: 'FILE_LIMIT' });
    expect(closed).toHaveBeenCalledOnce(); expect(f.transfers.upload).not.toHaveBeenCalled();
  });
  it('snapshots and verifies an empty ordinary file without inventing nonzero size', async () => {
    const f = fixture(); await f.ready(); const sourcePath = await f.source('');
    expect(await f.workspace.push({ ...f.input, path: 'empty.txt', sourcePath })).toMatchObject({ bytes: 0, sha256: digest('') });
    expect((await f.workspace.pull({ ...f.input, path: 'empty.txt' })).bytes).toBe(0);
  });
  it.each(['upload-unknown', 'upload-throw', 'wrong-size', 'missing-id', 'missing-file', 'parent-file', 'account-change'])('persists unknown receipt after %s and forbids replay', async mode => {
    const f = fixture(); await f.ready(); const sourcePath = await f.source(); const target = f.session + '/nested/a.txt';
    if (mode === 'parent-file') f.remote(f.session);
    const upload = f.transfers.upload.getMockImplementation()!;
    if (mode === 'upload-unknown') f.transfers.upload.mockResolvedValueOnce({ status: 'unknown' });
    else if (mode === 'upload-throw') f.transfers.upload.mockRejectedValueOnce(new Error('private diagnostic'));
    else if (mode !== 'parent-file') f.transfers.upload.mockImplementationOnce(async input => {
      const result = await upload(input);
      if (mode === 'wrong-size') f.files.get(target)!.size = 99;
      if (mode === 'missing-id') f.files.get(target)!.id = undefined;
      if (mode === 'missing-file') f.files.delete(target);
      if (mode === 'account-change') f.responses.set('/api2/account/info/', { email: 'changed@example.test' });
      return result;
    });
    await expect(f.workspace.push({ ...f.input, path: 'nested/a.txt', sourcePath })).rejects.toMatchObject({ code: 'WORKSPACE_WRITE_UNKNOWN', status: 500 });
    expect(await readJson(f.intent('nested/a.txt'))).toMatchObject({ status: 'unknown', sha256: digest('abc') });
    f.responses.delete('/api2/account/info/');
    const calls = f.transfers.upload.mock.calls.length;
    await expect(f.workspace.push({ ...f.input, path: 'nested/a.txt', sourcePath })).rejects.toMatchObject({ code: 'WORKSPACE_WRITE_UNKNOWN' });
    expect(f.transfers.upload).toHaveBeenCalledTimes(calls);
    if (calls) await expect(readFile(f.transfers.upload.mock.calls[0][0].filePath)).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it.each([new CloudError('NOT_FOUND', 'missing', 404), new CloudError('NOT_FOUND', 'not explicit'), new CloudError('AUTH_REQUIRED', 'auth'), new Error('network')])('normalizes only explicit HTTP404 absence before pushing (%s)', async failure => {
    const f = fixture(); await f.ready(); const sourcePath = await f.source(); const info = f.drive.info.getMockImplementation()!;
    let thrown = false;
    f.drive.info.mockImplementation(async (id, p) => { if (p === f.session + '/new.txt' && !thrown) { thrown = true; throw failure; } return info(id, p); });
    const pending = f.workspace.push({ ...f.input, path: 'new.txt', sourcePath });
    if (failure instanceof CloudError && failure.status === 404) { expect(await pending).toMatchObject({ bytes: 3 }); expect(f.transfers.upload).toHaveBeenCalledOnce(); }
    else { await expect(pending).rejects.toBe(failure); expect(f.transfers.upload).not.toHaveBeenCalled(); }
  });
});

describe('MockDrive public API negative cases not exercised by the first batch', () => {
  it('checks auth offline, rejects bad repositories on every public entry, and handles empty files', async () => {
    const cfg = loadConfig({ stateDir: path.join(root, 'mock'), mock: true }); const drive = new MockDrive(cfg);
    await expect(drive.checkAuth()).resolves.toBeUndefined();
    for (const operation of [() => drive.resolveRepo(), () => drive.list(OTHER, '/'), () => drive.info(OTHER, '/'), () => drive.downloadLink(OTHER, '/'), () => drive.uploadLink(OTHER, '/'), () => drive.mkdir(OTHER, '/x'), () => drive.rename(OTHER, '/README.txt', 'new'), () => drive.moveCopy('copy', RID, '/README.txt', OTHER, '/'), () => drive.share(OTHER, '/', {}), () => drive.search('x', OTHER)]) await expect(operation()).rejects.toMatchObject({ code: 'NOT_FOUND' });
    const form = new FormData(); form.set('file', new File([''], 'empty.txt'));
    const upload = await drive.transferRequest(await drive.uploadLink(RID, '/'), { method: 'POST', body: form });
    expect(await upload.json()).toEqual([{ name: 'empty.txt', size: 0, id: digest('') }]);
    expect(await drive.info(RID, '/empty.txt')).toMatchObject({ size: 0, id: digest('') });
    expect((await drive.list(RID, '/', 1, 1)).nextOffset).toBeUndefined();
    expect(await readdir(path.join(root, 'mock'))).toContain('mock-files.json');
  });
});
