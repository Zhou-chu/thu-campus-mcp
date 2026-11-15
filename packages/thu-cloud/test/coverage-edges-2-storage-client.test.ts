import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import lockfile from 'proper-lockfile';
import { atomicJson, atomicWrite, digest, guardedPath, readJson, safeSegment, scrub, stableName, withLock } from '../src/storage.js';
import { AuthStore, type AuthData } from '../src/auth.js';
import { CloudClient } from '../src/client.js';
import { loadConfig } from '../src/config.js';
import { CloudError } from '../src/types.js';

const boundary = vi.hoisted(() => ({ actual: undefined as any }));
vi.mock('node:fs/promises', async original => {
  const actual = await original<typeof import('node:fs/promises')>(); boundary.actual = actual;
  return { ...actual, lstat: vi.fn(actual.lstat), realpath: vi.fn(actual.realpath), rename: vi.fn(actual.rename), writeFile: vi.fn(actual.writeFile) };
});
const QA = path.resolve('D:/code/thu-campus-mcp/.local/qa-temp');
const RID = '11111111-1111-4111-8111-111111111111';
const TOKEN = 'synthetic-unit-token-0123456789';
let root: string;
beforeEach(async () => {
  for (const key of ['lstat', 'realpath', 'rename', 'writeFile'] as const) vi.mocked(fs[key]).mockReset().mockImplementation(boundary.actual[key]);
  for (const key of ['TEMP', 'TMP', 'TMPDIR']) vi.stubEnv(key, QA);
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('Real network forbidden'); }));
  await fs.mkdir(QA, { recursive: true }); root = await fs.mkdtemp(path.join(QA, 'cloud-storage-client-edges-2-'));
});
afterEach(async () => {
  vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs();
  expect(path.dirname(path.resolve(root))).toBe(QA); expect(path.basename(root)).toMatch(/^cloud-storage-client-edges-2-/);
  await fs.rm(root, { recursive: true, force: true });
});

describe('real cloud storage edge conditions', () => {
  it.each([[' . a . ', 'a'], ['...  ', '_'], ['CON.txt', '_CON.txt'], ['PRN', '_PRN'], ['aux.txt', '_aux.txt'], ['com9.log', '_com9.log'], ['__a/b', '_a_b'], ['e\u0301', 'é']])('sanitizes %j to %j', (input, expected) => expect(safeSegment(input)).toBe(expected));
  it('bounds long names with content digests and stable identifiers', () => {
    const value = 'x'.repeat(80); expect(safeSegment(value)).toBe('x'.repeat(59) + '__' + digest(value).slice(0, 11));
    expect(stableName(value, 'id')).toBe('x'.repeat(45) + '__' + digest('id').slice(0, 12)); expect(digest(new Uint8Array([120]))).toBe(digest('x'));
  });
  it('accepts root equality, existing children and absent descendants but not lexical escapes', async () => {
    const base = path.join(root, 'base'); await fs.mkdir(path.join(base, 'exists'), { recursive: true });
    expect(await guardedPath(base, '.')).toBe(base); expect(await guardedPath(base, 'exists/new/file')).toBe(path.join(base, 'exists/new/file'));
    await expect(guardedPath(base, '../outside')).rejects.toMatchObject({ code: 'UNSAFE_PATH' });
    await expect(guardedPath(base, path.parse(base).root)).rejects.toMatchObject({ code: 'UNSAFE_PATH' });
  });
  it('refuses junction paths and propagates non-ENOENT filesystem errors', async () => {
    const base = path.join(root, 'base'), target = path.join(root, 'target'); await fs.mkdir(base); await fs.mkdir(target); await fs.symlink(target, path.join(base, 'link'), 'junction');
    await expect(guardedPath(base, 'link/file')).rejects.toMatchObject({ code: 'UNSAFE_PATH' });
    vi.mocked(fs.lstat).mockRejectedValueOnce(Object.assign(new Error('denied'), { code: 'EACCES' }));
    await expect(guardedPath(base, 'new')).rejects.toMatchObject({ code: 'EACCES' });
  });
  it('refuses resolved descendants outside the actual base', async () => {
    const base = path.join(root, 'base'); await fs.mkdir(path.join(base, 'child'), { recursive: true });
    vi.mocked(fs.realpath).mockImplementation(async (...args: any[]) => args[0] === path.join(base, 'child') ? root : boundary.actual.realpath(...args));
    await expect(guardedPath(base, 'child')).rejects.toMatchObject({ code: 'UNSAFE_PATH' });
  });
  it('writes complete JSON and byte snapshots without leaving temporary files', async () => {
    const target = path.join(root, 'data/value.json'); expect(await readJson(target)).toBeUndefined();
    await atomicWrite(target, new Uint8Array([97, 98])); expect(await fs.readFile(target, 'utf8')).toBe('ab');
    await atomicJson(target, { value: 2 }); expect(await readJson(target)).toEqual({ value: 2 }); expect(await fs.readFile(target, 'utf8')).toBe('{\n  "value": 2\n}\n');
    await fs.writeFile(target, 'broken'); await expect(readJson(target)).rejects.toBeInstanceOf(SyntaxError);
    await expect(readJson(path.dirname(target))).rejects.toMatchObject({ code: 'EISDIR' });
    expect((await fs.readdir(path.dirname(target))).filter(name => name.endsWith('.tmp'))).toEqual([]);
  });
  it.each(['EPERM', 'EACCES', 'EBUSY'])('retries only a local Windows %s atomic rename', async code => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] }); const target = path.join(root, 'value');
    const rename = vi.mocked(fs.rename).mockRejectedValueOnce(Object.assign(new Error('busy'), { code })).mockImplementation(boundary.actual.rename);
    const pending = atomicWrite(target, 'same bytes'); const assertion = expect(pending).resolves.toBeUndefined();
    await vi.waitFor(() => expect(rename).toHaveBeenCalledOnce()); await vi.runAllTimersAsync(); await assertion;
    expect(rename).toHaveBeenCalledTimes(2); expect(await fs.readFile(target, 'utf8')).toBe('same bytes'); expect(await fs.readdir(root)).toEqual(['value']);
  });
  it('does not retry unclassified rename errors and removes the unpublished temp file', async () => {
    const failure = Object.assign(new Error('disk full'), { code: 'ENOSPC' }); const rename = vi.mocked(fs.rename).mockRejectedValueOnce(failure);
    await expect(atomicWrite(path.join(root, 'value'), 'data')).rejects.toBe(failure); expect(rename).toHaveBeenCalledOnce(); expect(await fs.readdir(root)).toEqual([]);
  });
  it('removes a partially written temp file when the filesystem write fails', async () => {
    const failure = Object.assign(new Error('disk full'), { code: 'ENOSPC' });
    vi.mocked(fs.writeFile).mockImplementationOnce(async (...args: any[]) => { await boundary.actual.writeFile(...args); throw failure; });
    await expect(atomicWrite(path.join(root, 'value'), 'partial')).rejects.toBe(failure); expect(await fs.readdir(root)).toEqual([]); expect(fs.rename).not.toHaveBeenCalled();
  });
  it('stops local busy replacement after twenty attempts and preserves previous bytes', async () => {
    const target = path.join(root, 'value'); await fs.writeFile(target, 'previous'); vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const failure = Object.assign(new Error('busy'), { code: 'EBUSY' }); const rename = vi.mocked(fs.rename).mockRejectedValue(failure);
    const pending = atomicWrite(target, 'new'); const assertion = expect(pending).rejects.toBe(failure);
    await vi.waitFor(() => expect(rename).toHaveBeenCalled()); await vi.runAllTimersAsync(); await assertion;
    expect(rename).toHaveBeenCalledTimes(20); expect(await fs.readFile(target, 'utf8')).toBe('previous'); expect(await fs.readdir(root)).toEqual(['value']);
  });
  it('releases a real lock after callback failure and serializes concurrent updates', async () => {
    const directory = path.join(root, 'lock'); const failure = new Error('callback'); await expect(withLock(directory, async () => { throw failure; })).rejects.toBe(failure);
    let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; }); const order: number[] = [];
    const first = withLock(directory, async () => { order.push(1); await gate; order.push(2); return 'first'; });
    await vi.waitFor(() => expect(order).toEqual([1])); const second = withLock(directory, async () => { order.push(3); return 'second'; }); release();
    expect(await Promise.all([first, second])).toEqual(['first', 'second']); expect(order).toEqual([1, 2, 3]);
  });
  it('does not invoke callback when lock acquisition fails', async () => {
    const callback = vi.fn(), failure = Object.assign(new Error('denied'), { code: 'EACCES' }); vi.spyOn(lockfile, 'lock').mockRejectedValueOnce(failure);
    await expect(withLock(path.join(root, 'lock'), callback)).rejects.toBe(failure); expect(callback).not.toHaveBeenCalled();
  });
  it('redacts sensitive nested fields, signed query keys and embedded credential fragments', () => {
    expect(scrub({ password: 'x', Cookie: 'x', csrf: 'x', fingerPrint: 'x', authorization: 'x', token: 'x', list: [1, true, null], nested: { keep: 'ordinary', text: 'link?_csrf=x&ok=1 x&amp;ticket=y&amp;z=2 end?sessionid=x' }, url: 'https://example.test/x?access_token=x&ticket=x&session=x&keep=yes' })).toEqual({ list: [1, true, null], nested: { keep: 'ordinary', text: 'link?ok=1 x&amp;z=2 end' }, url: 'https://example.test/x?keep=yes' });
    expect(() => scrub({ url: 'https://[' })).toThrow();
  });
});

function account(mode: 'account' | 'repo' = 'account') {
  const config = loadConfig({ stateDir: path.join(root, 'state'), outputDir: path.join(root, 'out'), mock: false });
  let generation = 'unit-generation', version = 'unit-version';
  let saved: { data: AuthData; version: string } | undefined = { version, data: { account: 'synthetic@example.test', token: TOKEN, mode, repoId: RID } };
  const generationSpy = vi.spyOn(AuthStore.prototype, 'generation').mockImplementation(async () => generation);
  const versionSpy = vi.spyOn(AuthStore.prototype, 'version').mockImplementation(async () => version);
  const load = vi.spyOn(AuthStore.prototype, 'loadVersioned').mockImplementation(async () => saved);
  let route = (_url: URL, _init: RequestInit): Response => Response.json(null);
  let repo: any = { id: RID, name: 'Account library', permission: 'rw', encrypted: false };
  let repoInfo: any = { id: RID, name: 'Alias library' }, directory: any = {};
  const fetch = vi.fn(async (raw: any, init: RequestInit = {}) => {
    const url = new URL(raw); expect(url.origin).toBe('https://cloud.tsinghua.edu.cn'); expect(init.redirect).toBe('manual'); expect(new Headers(init.headers).get('authorization')).toBe('Token ' + TOKEN);
    if (url.pathname === '/api2/repos/') return Response.json(repo);
    if (url.pathname === '/api/v2.1/via-repo-token/repo-info/') return Response.json(repoInfo);
    if (url.pathname === '/api/v2.1/via-repo-token/dir/' && !url.searchParams.has('path')) return Response.json(directory);
    return route(url, init);
  });
  repo = [repo]; vi.stubGlobal('fetch', fetch);
  return { client: new CloudClient(config), config, fetch, generationSpy, versionSpy, load, setGeneration: (v: string) => { generation = v; }, setVersion: (v: string) => { version = v; }, setSaved: (v: typeof saved) => { saved = v; }, route: (fn: typeof route) => { route = fn; }, repos: (v: any) => { repo = v; }, repoInfo: (v: any) => { repoInfo = v; }, directory: (v: any) => { directory = v; } };
}

describe('CloudClient authentication races and response-shape edges', () => {
  it('recovers a rejected auth queue before any credentials were loaded', async () => {
    const f = account(); f.load.mockResolvedValueOnce(undefined); await expect(f.client.checkAuth()).rejects.toMatchObject({ code: 'AUTH_REQUIRED' });
    await expect(f.client.checkAuth()).resolves.toBeUndefined(); expect(f.client.identity).toBe(digest('synthetic@example.test').slice(0, 16));
  });
  it.each(['generation', 'version'])('invalidates when %s changes during initial authentication', async kind => {
    const f = account(); if (kind === 'generation') f.generationSpy.mockResolvedValueOnce('old').mockResolvedValue('new'); else f.versionSpy.mockResolvedValue('different');
    await expect(f.client.checkAuth()).rejects.toMatchObject({ code: 'AUTH_CHANGED' }); expect(f.client.identity).toBe('');
    await expect(f.client.checkAuth()).rejects.toMatchObject({ code: 'AUTH_CHANGED' }); expect(f.fetch).not.toHaveBeenCalled();
  });
  it('invalidates a warmed client when bytes change without epoch rotation', async () => {
    const f = account(); await f.client.checkAuth(); f.setVersion('new-version');
    await expect(f.client.checkAuth()).rejects.toMatchObject({ code: 'AUTH_CHANGED' }); expect(f.client.identity).toBe('');
  });
  it.each(['fetch', 'body'])('refuses response when auth changes during %s', async stage => {
    const f = account(); f.route(() => {
      if (stage === 'fetch') { f.setGeneration('new'); return Response.json({ secret: 'discard' }); }
      const response = Response.json({ secret: 'discard' }); response.text = async () => { f.setGeneration('new'); return '{"secret":"discard"}'; }; return response;
    });
    await expect(f.client.request('/unit-only')).rejects.toMatchObject({ code: 'AUTH_CHANGED' }); expect(f.fetch).toHaveBeenCalledOnce();
  });
  it('rejects malformed libraries and explicit encrypted metadata before read', async () => {
    const f = account(); f.repos({ data: [] }); await expect(f.client.libraries()).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
    f.repos([{ id: RID, name: 'Encrypted', encrypted: true }]); await expect(f.client.resolveRepo(RID)).rejects.toMatchObject({ code: 'ENCRYPTED_LIBRARY' });
  });
  it('accepts repo-info aliases but defaults unknown permission to read-only', async () => {
    const f = account('repo'); expect(await f.client.libraries()).toMatchObject([{ id: RID, name: 'Alias library', permission: 'r' }]);
    expect(await f.client.resolveRepo()).toMatchObject({ id: RID }); await expect(f.client.uploadLink(RID, '/')).rejects.toMatchObject({ code: 'READ_ONLY' });
    f.repoInfo({ id: RID, name: 'Alias library', permission: 'rw' }); expect((await f.client.libraries())[0].permission).toBe('rw');
    f.directory({ user_perm: 'r' }); expect((await f.client.libraries())[0].permission).toBe('r');
  });
  it.each(['string', 'object', 'unsafe'])('validates %s download/upload link response shapes and scoped endpoints', async shape => {
    const f = account('repo'); f.directory({ user_perm: 'rw' });
    f.route((url) => { const link = shape === 'unsafe' ? 'https://foreign.test/token' : '/safe-transfer'; return Response.json(shape === 'string' ? link : url.pathname.includes('download-link') ? { download_link: link } : { upload_link: link }); });
    if (shape === 'unsafe') { await expect(f.client.downloadLink(RID, '/file')).rejects.toMatchObject({ code: 'UNSAFE_URL' }); await expect(f.client.uploadLink(RID, '/')).rejects.toMatchObject({ code: 'UNSAFE_URL' }); }
    else { expect(await f.client.downloadLink(RID, '/file')).toBe('https://cloud.tsinghua.edu.cn/safe-transfer'); expect(await f.client.uploadLink(RID, '/')).toBe('https://cloud.tsinghua.edu.cn/safe-transfer'); }
    expect(f.fetch.mock.calls.some(([raw]) => new URL(raw).pathname.endsWith('/download-link/'))).toBe(true);
  });
  it('normalizes root parent/name aliases on scoped mkdir and rename', async () => {
    const f = account('repo'); f.directory({ user_perm: 'rw' });
    f.route((_url, init) => init.method === 'POST' ? Response.json({ obj_name: 'new' }) : Response.json([{ name: 'old', type: 'file' }]));
    expect(await f.client.mkdir(RID, '/new')).toEqual({ createdPath: '/new' });
    f.route((_url, init) => init.method === 'POST' ? Response.json({ name: 'new' }) : Response.json([{ name: 'old', type: 'file' }]));
    expect(await f.client.rename(RID, '/old', 'new')).toEqual({ path: '/new' });
  });
  it('renames an account directory without accepting file-only Location semantics', async () => {
    const f = account(); f.route((_url, init) => init.method === 'POST' ? Response.json('success') : Response.json([{ name: 'old', type: 'dir' }]));
    expect(await f.client.rename(RID, '/old', 'new')).toEqual({ path: '/new' });
    const mutation = f.fetch.mock.calls.find(([, init]) => init.method === 'POST')!; expect(new URL(mutation[0]).pathname).toContain('/dir/');
  });
  it('does not fall back to traversal after unclassified or network search failures', async () => {
    const f = account(); const failure = new Error('synthetic network'); f.route(() => { throw failure; });
    await expect(f.client.search('q')).rejects.toBe(failure); expect(f.fetch).toHaveBeenCalledOnce();
  });
});
