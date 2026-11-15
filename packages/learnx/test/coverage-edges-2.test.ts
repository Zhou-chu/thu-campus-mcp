import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import lockfile from 'proper-lockfile';
import { loadConfig } from '../src/config.js';
import { getJob, runJob, startJob } from '../src/jobs.js';
import { SyncService } from '../src/sync.js';
import { LearnError } from '../src/types.js';
import { atomicJson, atomicWrite, digest, guardedPath, readJson, safeSegment, scrub, stableName, withLock } from '../src/storage.js';

const fsBoundary = vi.hoisted(() => ({ actual: undefined as any }));
vi.mock('node:fs/promises', async original => {
  const actual = await original<typeof import('node:fs/promises')>(); fsBoundary.actual = actual;
  return { ...actual, lstat: vi.fn(actual.lstat), realpath: vi.fn(actual.realpath), rename: vi.fn(actual.rename) };
});
const boundary = vi.hoisted(() => ({ spawn: vi.fn(), createClient: vi.fn() }));
vi.mock('node:child_process', async original => ({ ...await original<typeof import('node:child_process')>(), spawn: (...args: any[]) => boundary.spawn(...args) }));
vi.mock('../src/client.js', async original => ({ ...await original<typeof import('../src/client.js')>(), createClient: (...args: any[]) => boundary.createClient(...args) }));
const QA = path.resolve('D:/code/thu-campus-mcp/.local/qa-temp');
const ID = '44444444-4444-4444-8444-444444444444';
let root: string;
let child: EventEmitter & { unref: ReturnType<typeof vi.fn> };
beforeEach(async () => {
  for (const name of ['lstat', 'realpath', 'rename'] as const) vi.mocked(fs[name]).mockReset().mockImplementation(fsBoundary.actual[name]);
  for (const name of ['TEMP', 'TMP', 'TMPDIR']) vi.stubEnv(name, QA);
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('Real network forbidden'); }));
  await fs.mkdir(QA, { recursive: true }); root = await fs.mkdtemp(path.join(QA, 'learnx-sdk-edges-2-'));
  child = Object.assign(new EventEmitter(), { unref: vi.fn() }); boundary.spawn.mockReset().mockReturnValue(child);
  boundary.createClient.mockReset().mockResolvedValue({ identity: 'offline-test-account', currentSemester: async () => ({ id: 'semester' }), courses: async () => [], contents: async () => [] });
});
afterEach(async () => {
  vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs();
  expect(path.dirname(path.resolve(root))).toBe(QA); expect(path.basename(root)).toMatch(/^learnx-sdk-edges-2-/);
  await fs.rm(root, { recursive: true, force: true });
});
const config = (mock = false) => loadConfig({ stateDir: path.join(root, 'state'), outputDir: path.join(root, 'output'), mock });
const file = (cfg = config()) => path.join(cfg.stateDir, 'jobs', ID + '.json');
async function queue(status = 'queued', pid?: number) {
  const cfg = config(); const options = { outputDir: cfg.outputDir, semesterId: 'semester', sections: ['notification'] as const };
  await atomicJson(file(cfg), { id: ID, status, pid, createdAt: '2020-01-01T00:00:00.000Z', updatedAt: '2020-01-01T00:00:00.000Z', options });
  return cfg;
}

describe('real learnx job persistence without executing child processes', () => {
  it.each([false, true])('queues mock=%s jobs and passes only configured state/output to the inert worker boundary', async mock => {
    const cfg = config(mock), options = { outputDir: cfg.outputDir, courseId: 'unit-course' };
    const receipt = await startJob(cfg, options);
    expect(receipt).toMatchObject({ id: expect.stringMatching(/^[a-f0-9-]{36}$/), status: 'queued' });
    expect(await getJob(cfg, receipt.id)).toMatchObject({ id: receipt.id, status: 'queued', options, createdAt: expect.any(String) });
    expect(boundary.spawn).toHaveBeenCalledOnce(); const [exe, args, spawnOptions] = boundary.spawn.mock.calls[0];
    expect(exe).toBe(process.execPath); expect(args.slice(1)).toEqual(['worker', receipt.id]);
    expect(spawnOptions).toMatchObject({ detached: true, windowsHide: true, stdio: 'ignore', env: { LEARNX_STATE_DIR: cfg.stateDir, LEARNX_OUTPUT_DIR: cfg.outputDir, LEARNX_MOCK: mock ? '1' : '0' } });
    expect(child.unref).toHaveBeenCalledOnce(); expect(boundary.createClient).not.toHaveBeenCalled();
  });
  it('records asynchronous worker-start failure without leaking process diagnostics', async () => {
    const cfg = config(); const receipt = await startJob(cfg, { outputDir: cfg.outputDir }); child.emit('error', new Error('sensitive process diagnostic'));
    await vi.waitFor(async () => expect(await getJob(cfg, receipt.id)).toMatchObject({ status: 'failed', error: { code: 'WORKER_START' } }));
    expect(JSON.stringify(await getJob(cfg, receipt.id))).not.toContain('sensitive'); expect(boundary.spawn).toHaveBeenCalledOnce();
  });
  it('rejects malformed or absent job IDs before creating a client', async () => {
    for (const id of ['', '../outside', 'A'.repeat(36), 'short']) await expect(getJob(config(), id)).rejects.toMatchObject({ code: 'INVALID_ID' });
    await expect(getJob(config(), ID)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(boundary.createClient).not.toHaveBeenCalled();
  });
  it.each(['running', 'queued'])('reports stopped %s worker as interrupted without rewriting its durable record', async status => {
    const cfg = await queue(status, 9999); const kill = vi.spyOn(process, 'kill').mockImplementation(() => { throw Object.assign(new Error('gone'), { code: 'ESRCH' }); });
    expect(await getJob(cfg, ID)).toMatchObject({ status: 'interrupted', error: { code: 'WORKER_STOPPED' } });
    expect(kill).toHaveBeenCalledWith(9999, 0); expect(await readJson(file(cfg))).toMatchObject({ status });
  });
  it('does not interrupt a live worker, a pid-less queued record, or a settled job', async () => {
    const kill = vi.spyOn(process, 'kill').mockReturnValue(true);
    const cfg = await queue('running', 9999); expect((await getJob(cfg, ID)).status).toBe('running'); expect(kill).toHaveBeenCalledOnce();
    await queue('queued'); expect((await getJob(cfg, ID)).status).toBe('queued');
    await queue('complete', 9999); expect((await getJob(cfg, ID)).status).toBe('complete'); expect(kill).toHaveBeenCalledOnce();
  });
  it.each(['complete', 'partial', 'failed', 'interrupted', 'running'])('does not replay settled or active %s jobs', async status => {
    const cfg = await queue(status); await expect(runJob(cfg, ID)).resolves.toBeUndefined();
    expect(boundary.createClient).not.toHaveBeenCalled(); expect((await readJson(file(cfg)))!.status).toBe(status);
  });
  it('executes the real offline SyncService, persists progress and finishes complete', async () => {
    const cfg = await queue();
    boundary.createClient.mockResolvedValue({ identity: 'offline-test-account', courses: async () => [{ id: 'c', name: 'Offline course' }], contents: async () => [] });
    await runJob(cfg, ID);
    const job = await getJob(cfg, ID);
    expect(job).toMatchObject({ status: 'complete', pid: process.pid, progress: { courseId: 'c', section: '公告' }, result: { status: 'complete', courses: 1, added: 0 } });
    expect(job.updatedAt).not.toBe('2020-01-01T00:00:00.000Z'); expect(boundary.createClient).toHaveBeenCalledWith(cfg);
    const manifest = await readJson(path.join(cfg.outputDir, 'semester', 'manifest.json'));
    expect(manifest).toMatchObject({ accountId: 'offline-test-account', courses: { c: { sections: { notification: { status: 'complete' } } } } });
  });
  it('retains real partial sync result rather than marking missing sections complete', async () => {
    const cfg = await queue();
    boundary.createClient.mockResolvedValue({ identity: 'offline-test-account', courses: async () => [{ id: 'c', name: 'Offline course' }], contents: async () => { throw new LearnError('OFFLINE_SECTION', 'Synthetic section unavailable'); } });
    await runJob(cfg, ID);
    expect(await getJob(cfg, ID)).toMatchObject({ status: 'partial', result: { status: 'partial', errors: [{ code: 'OFFLINE_SECTION' }] } });
  });
  it.each([new LearnError('AUTH_CHANGED', 'Synthetic auth changed'), new Error('private credential'), Object.assign(new Error('private path'), { code: 'ENOENT' })])('persists sanitized worker failure for %s', async failure => {
    const cfg = await queue(); boundary.createClient.mockRejectedValueOnce(failure); await runJob(cfg, ID);
    const job = await getJob(cfg, ID);
    expect(job.status).toBe('failed'); expect(job.error).toMatchObject({ code: failure instanceof LearnError ? 'AUTH_CHANGED' : (failure as any).code === 'ENOENT' ? 'NOT_FOUND' : 'OPERATION_FAILED' });
    expect(JSON.stringify(job)).not.toContain('private');
    await runJob(cfg, ID); expect(boundary.createClient).toHaveBeenCalledOnce();
  });
  it('persists a SyncService rejection and releases the real job lock', async () => {
    const cfg = await queue(); vi.spyOn(SyncService.prototype, 'run').mockRejectedValueOnce(new LearnError('ACCOUNT_MISMATCH', 'Synthetic mismatch'));
    await runJob(cfg, ID); expect(await getJob(cfg, ID)).toMatchObject({ status: 'failed', error: { code: 'ACCOUNT_MISMATCH' } });
    await expect(withLock(path.join(cfg.stateDir, 'job-locks', ID), async () => 'released')).resolves.toBe('released');
  });
});

describe('learnx real storage utilities and filesystem failure boundaries', () => {
  it.each([
    ['...  ', '_'], [' . hello . ', 'hello'], ['CON.txt', '_CON.txt'], ['lpt9', '_lpt9'], ['__a?', '_a_'], ['e\u0301', 'é'], ['a/b\\c:d*e?f|g<h>i"', 'a_b_c_d_e_f_g_h_i_'],
  ])('sanitizes %j deterministically', (input, expected) => expect(safeSegment(input)).toBe(expected));
  it('uses bounded collision-resistant long names and stable IDs', () => {
    const input = 'a'.repeat(80); expect(safeSegment(input)).toBe('a'.repeat(59) + '__' + digest(input).slice(0, 11));
    expect(stableName('a'.repeat(80), 'id')).toBe('a'.repeat(45) + '__' + digest('id').slice(0, 12));
    expect(digest(new Uint8Array([97]))).toBe(digest('a'));
  });
  it('guards root equality, existing children and missing descendants but refuses lexical escape', async () => {
    const base = path.join(root, 'guard'); await fs.mkdir(path.join(base, 'existing'), { recursive: true });
    expect(await guardedPath(base, '.')).toBe(base);
    expect(await guardedPath(base, 'existing/new/file')).toBe(path.join(base, 'existing/new/file'));
    await expect(guardedPath(base, '../outside')).rejects.toMatchObject({ code: 'UNSAFE_PATH' });
    await expect(guardedPath(base, path.parse(base).root)).rejects.toMatchObject({ code: 'UNSAFE_PATH' });
  });
  it('refuses existing links and propagates inspection failures', async () => {
    const base = path.join(root, 'guard'); const target = path.join(root, 'target'); await fs.mkdir(base); await fs.mkdir(target);
    const link = path.join(base, 'link'); await fs.symlink(target, link, 'junction');
    await expect(guardedPath(base, 'link/file')).rejects.toMatchObject({ code: 'UNSAFE_PATH' });
    vi.mocked(fs.lstat).mockRejectedValueOnce(Object.assign(new Error('denied'), { code: 'EACCES' }));
    await expect(guardedPath(base, 'new')).rejects.toMatchObject({ code: 'EACCES' });
  });
  it('rejects a resolved child that escapes the real base even when lstat is not a link', async () => {
    const base = path.join(root, 'guard'); await fs.mkdir(path.join(base, 'existing'), { recursive: true });
    const real = fsBoundary.actual.realpath; vi.mocked(fs.realpath).mockImplementation(async (...args: any[]) => args[0] === path.join(base, 'existing') ? root : (real as any)(...args));
    await expect(guardedPath(base, 'existing')).rejects.toMatchObject({ code: 'UNSAFE_PATH' });
  });
  it('atomically writes bytes/JSON, returns missing JSON as undefined, and exposes corruption/fs errors', async () => {
    const target = path.join(root, 'data', 'value.json'); expect(await readJson(target)).toBeUndefined();
    await atomicWrite(target, new Uint8Array([97, 98])); expect(await fs.readFile(target, 'utf8')).toBe('ab');
    await atomicJson(target, { value: 2 }); expect(await readJson(target)).toEqual({ value: 2 }); expect(await fs.readFile(target, 'utf8')).toBe('{\n  "value": 2\n}\n');
    await fs.writeFile(target, 'broken'); await expect(readJson(target)).rejects.toBeInstanceOf(SyntaxError);
    await expect(readJson(path.dirname(target))).rejects.toMatchObject({ code: 'EISDIR' });
    expect((await fs.readdir(path.dirname(target))).filter(name => name.endsWith('.tmp'))).toEqual([]);
  });
  it.each(['EPERM', 'EACCES', 'EBUSY'])('retries only local Windows %s rename then cleans its own temp file', async code => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] }); const target = path.join(root, 'retry.txt'); const rename = fsBoundary.actual.rename;
    const spy = vi.mocked(fs.rename).mockRejectedValueOnce(Object.assign(new Error('busy'), { code })).mockImplementation(rename);
    const pending = atomicWrite(target, 'same bytes'); const assertion = expect(pending).resolves.toBeUndefined();
    await vi.waitFor(() => expect(spy).toHaveBeenCalledTimes(1)); await vi.runAllTimersAsync(); await assertion;
    expect(spy).toHaveBeenCalledTimes(2); expect(await fs.readFile(target, 'utf8')).toBe('same bytes');
    expect((await fs.readdir(root)).filter(name => name.endsWith('.tmp'))).toEqual([]);
  });
  it('does not retry unclassified rename failures and cleans staged bytes', async () => {
    const target = path.join(root, 'value'); const failure = Object.assign(new Error('disk full'), { code: 'ENOSPC' });
    const rename = vi.mocked(fs.rename).mockRejectedValueOnce(failure);
    await expect(atomicWrite(target, 'data')).rejects.toBe(failure); expect(rename).toHaveBeenCalledOnce();
    expect(await fs.readdir(root)).toEqual([]);
  });
  it('bounds busy rename retries at twenty attempts without leaving partial data', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] }); const target = path.join(root, 'value'); const failure = Object.assign(new Error('busy'), { code: 'EBUSY' });
    const rename = vi.mocked(fs.rename).mockRejectedValue(failure); const pending = atomicWrite(target, 'data');
    const assertion = expect(pending).rejects.toBe(failure);
    await vi.waitFor(() => expect(rename).toHaveBeenCalled());
    for (let count = 0; count < 25; count++) { await vi.advanceTimersByTimeAsync(250); await new Promise<void>(resolve => setImmediate(resolve)); }
    await assertion; expect(rename).toHaveBeenCalledTimes(20); expect(await fs.readdir(root)).toEqual([]);
  });
  it('releases a real lock after callback rejection and serializes concurrent callbacks', async () => {
    const directory = path.join(root, 'lock'); const failure = new Error('callback');
    await expect(withLock(directory, async () => { throw failure; })).rejects.toBe(failure);
    const order: string[] = []; let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
    const first = withLock(directory, async () => { order.push('first'); await gate; order.push('first-end'); return 1; });
    await vi.waitFor(() => expect(order).toEqual(['first']));
    const second = withLock(directory, async () => { order.push('second'); return 2; }); release();
    expect(await Promise.all([first, second])).toEqual([1, 2]); expect(order).toEqual(['first', 'first-end', 'second']);
  });
  it('propagates lock acquisition failure without invoking the protected callback', async () => {
    const callback = vi.fn(); const failure = Object.assign(new Error('lock denied'), { code: 'EACCES' }); vi.spyOn(lockfile, 'lock').mockRejectedValueOnce(failure);
    await expect(withLock(path.join(root, 'lock'), callback)).rejects.toBe(failure); expect(callback).not.toHaveBeenCalled();
  });
  it('scrubs sensitive keys and signed URL parameters while preserving ordinary values', () => {
    const result = scrub({ Password: 'x', cookies: 'x', csrfToken: 'x', fingerPrint: 'x', authorization: 'x', nested: { keep: 3, text: 'link?_csrf=x&ok=1 and x&amp;ticket=y&amp;z=2 end?sessionid=secret' }, url: 'https://example.test/file?token=secret&ticket=secret&sessionid=secret&keep=yes', literal: 'hello', nil: null });
    expect(result).toEqual({ nested: { keep: 3, text: 'link?ok=1 and x&amp;z=2 end' }, url: 'https://example.test/file?keep=yes', literal: 'hello', nil: null });
    expect(() => scrub({ url: 'https://[' })).toThrow();
  });
});
