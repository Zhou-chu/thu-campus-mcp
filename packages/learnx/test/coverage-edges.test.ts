import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { CookieJar } from 'tough-cookie';
import { AuthStore, type AuthData } from '../src/auth.js';
import { RealClient, allowedUrl } from '../src/client.js';
import { browserLogin, browserSessionData, verifyBrowserSession } from '../src/browser-auth.js';
import { BrowserError } from '@thu-campus/browser';
import { loadConfig } from '../src/config.js';
import { digest } from '../src/storage.js';
import { LearnError, type Kind } from '../src/types.js';
import { learnStatus } from '../src/status.js';

// Only the OS protection boundary is fake. AuthStore, its lock, atomic writes and
// generation/version comparisons run unchanged against an exclusively owned root.
const boundary = vi.hoisted(() => ({
  dpapi: 'ok' as 'ok' | 'error' | 'close' | 'invalid-json',
  executable: vi.fn(), spawn: vi.fn(), browser: vi.fn(), autofill: vi.fn(),
  helpers: [] as any[], methods: {} as Record<string, ReturnType<typeof vi.fn>>,
}));
vi.mock('node:child_process', async (original) => ({
  ...await original<typeof import('node:child_process')>(),
  spawn: (...args: any[]) => boundary.spawn(...args),
}));
vi.mock('@thu-campus/browser', async (original) => ({
  ...await original<typeof import('@thu-campus/browser')>(),
  systemExecutable: (...args: any[]) => boundary.executable(...args),
  withBrowser: (...args: any[]) => boundary.browser(...args),
}));
vi.mock('../src/autofill-login.js', () => ({
  tryBrowserAutofillLogin: (...args: any[]) => boundary.autofill(...args),
}));
vi.mock('thu-learn-lib', () => ({
  Learn2018Helper: class {
    token = ''; options: any;
    constructor(options: any) {
      this.options = options; boundary.helpers.push(this);
      for (const name of ['login', 'getCurrentSemester', 'getSemesterIdList', 'getCourseList', 'getNotificationList', 'getFileList', 'getHomeworkList', 'getDiscussionList', 'getAnsweredQuestionList', 'getQuestionnaireList', 'submitHomework']) {
        (this as any)[name] = (...args: any[]) => boundary.methods[name](...args);
      }
    }
    setCSRFToken(value: string) { this.token = value; }
    getCSRFToken() { return this.token || 'synthetic-refreshed-token'; }
  },
}));

const tempRoot = 'D:\\code\\thu-campus-mcp\\.local\\qa-temp';
const realProcess = process;
let root: string;
let store: AuthStore;
let deniedFetch: ReturnType<typeof vi.fn>;
const session = (account = 'synthetic-account'): AuthData => ({
  account, cookieJar: new CookieJar().toJSON(), csrfToken: 'synthetic-csrf',
});
const cookie = (overrides: Record<string, unknown> = {}) => ({
  name: 'SESSION', value: 'synthetic-cookie', domain: 'learn.tsinghua.edu.cn',
  path: '/', expires: -1, secure: true, httpOnly: true, sameSite: 'Lax' as const,
  ...overrides,
});

beforeEach(async () => {
  vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs();
  for (const name of ['auth', 'client', 'config', 'server', 'jobs', 'sync', 'browser-auth', 'install', 'submission', 'status']) vi.doUnmock(`../src/${name}.js`);
  vi.doUnmock('node:process'); vi.doUnmock('node:readline'); vi.doUnmock('node:readline/promises');
  boundary.dpapi = 'ok'; boundary.helpers.length = 0;
  boundary.executable.mockReset().mockResolvedValue('X:\\synthetic\\powershell.exe');
  boundary.browser.mockReset().mockRejectedValue(new Error('Unplanned browser launch'));
  boundary.autofill.mockReset().mockResolvedValue('none');
  boundary.spawn.mockReset().mockImplementation((_exe, args) => {
    const child = new EventEmitter() as any;
    child.stdout = new EventEmitter(); child.stdout.setEncoding = vi.fn();
    child.stderr = { resume: vi.fn() };
    child.stdin = { end: vi.fn((input: string) => queueMicrotask(() => {
      if (boundary.dpapi === 'error') { child.emit('error', new Error('synthetic process failure')); return; }
      if (boundary.dpapi === 'close') { child.emit('close', 5); return; }
      const decrypt = args.at(-1).includes('::Unprotect');
      const output = boundary.dpapi === 'invalid-json' && decrypt
        ? Buffer.from('not JSON').toString('base64')
        : decrypt ? Buffer.from(input, 'base64').toString().slice('cipher:'.length)
          : Buffer.from('cipher:' + input).toString('base64');
      child.stdout.emit('data', '  ' + output); child.stdout.emit('data', '\n'); child.emit('close', 0);
    })) };
    return child;
  });
  boundary.methods = Object.fromEntries(['login', 'getCurrentSemester', 'getSemesterIdList', 'getCourseList', 'getNotificationList', 'getFileList', 'getHomeworkList', 'getDiscussionList', 'getAnsweredQuestionList', 'getQuestionnaireList', 'submitHomework'].map(name => [name, vi.fn().mockResolvedValue([])]));
  boundary.methods.getCurrentSemester.mockResolvedValue({ id: 'semester-1' });
  deniedFetch = vi.fn(async () => { throw new Error('Unplanned network access denied'); });
  vi.stubGlobal('fetch', deniedFetch);
  vi.stubEnv('TEMP', tempRoot); vi.stubEnv('TMP', tempRoot);
  await mkdir(tempRoot, { recursive: true });
  root = await mkdtemp(path.join(tempRoot, 'learnx-coverage-edges-'));
  store = new AuthStore(root);
});
afterEach(async () => {
  vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs();
  // This path is returned by mkdtemp above, never a user/profile state directory.
  expect(path.dirname(root)).toBe(tempRoot);
  await rm(root, { recursive: true, force: true });
});

describe('AuthStore real persistence and concurrency edges', () => {
  it('creates a stable browser epoch and rotates it even when clearing an empty store', async () => {
    expect(await store.loadVersioned()).toBeUndefined();
    expect(await store.version()).toBeUndefined();
    expect(await store.status()).toEqual({ configured: false, accountId: undefined, method: undefined });
    const first = await store.generation(); expect(await store.generation()).toBe(first);
    await store.clear(); expect(await store.generation()).not.toBe(first);
    expect(await store.load()).toBeUndefined(); expect(boundary.spawn).not.toHaveBeenCalled();
  });
  it.each(['', '   '])('refuses empty account %j before invoking DPAPI', async account => {
    await expect(store.save({ account })).rejects.toMatchObject({ code: 'AUTH_ACCOUNT' });
    expect(boundary.spawn).not.toHaveBeenCalled(); expect(await store.version()).toBeUndefined();
  });
  it('protects and decrypts data, hashes encrypted bytes, and redacts both status methods', async () => {
    const data = { account: 'synthetic-user', username: 'synthetic-user', password: 'never-real-secret', fingerPrint: 'synthetic-device' };
    await store.save(data);
    const encrypted = await readFile(store.file, 'utf8');
    expect(encrypted).not.toContain(data.password); expect(encrypted).not.toContain(data.fingerPrint);
    expect(await store.loadVersioned()).toEqual({ data, version: digest(encrypted) });
    expect(await store.load()).toEqual(data);
    expect(await store.status()).toEqual({ configured: true, accountId: digest(data.account).slice(0, 16), method: 'credentials' });
    const scripts = boundary.spawn.mock.calls.map(call => call[1].at(-1));
    expect(scripts.some(script => script.includes('::Protect'))).toBe(true);
    expect(scripts.some(script => script.includes('::Unprotect'))).toBe(true);
    await store.save(session()); expect((await store.status()).method).toBe('session');
  });
  it('atomically updates only the expected version and rotates the browser epoch', async () => {
    await store.save(session('A')); const version = (await store.version())!; const epoch = await store.generation();
    const next = await store.saveIfCurrent(session('B'), version);
    expect(next).toBe(await store.version()); expect(next).not.toBe(version);
    expect((await store.load())?.account).toBe('B'); expect(await store.generation()).not.toBe(epoch);
    await expect(store.saveIfCurrent(session('A'), version)).rejects.toMatchObject({ code: 'AUTH_CHANGED' });
    expect((await store.load())?.account).toBe('B');
  });
  it('does not resurrect a cleared session through saveIfCurrent', async () => {
    await store.save(session()); const version = (await store.version())!;
    await store.clear(); await expect(store.saveIfCurrent(session(), version)).rejects.toMatchObject({ code: 'AUTH_CHANGED' });
    expect(await store.load()).toBeUndefined();
  });
  it.each([undefined, null])('accepts initial browser save with expected version %j', async expected => {
    const epoch = await store.generation();
    const version = await store.saveBrowserIfCurrent(session(), epoch, expected);
    expect(await store.version()).toBe(version); expect(await store.generation()).not.toBe(epoch);
    expect((await store.load())?.account).toBe('synthetic-account');
  });
  it('binds browser saves to both generation and nonempty expected version', async () => {
    await store.save(session('A')); const epoch = await store.generation(); const version = (await store.version())!;
    const next = await store.saveBrowserIfCurrent(session('B'), epoch, version);
    expect(next).toBe(await store.version()); expect((await store.load())?.account).toBe('B');
    await expect(store.saveBrowserIfCurrent(session('A'), epoch, next)).rejects.toMatchObject({ code: 'AUTH_CHANGED' });
    await expect(store.saveBrowserIfCurrent(session('A'), await store.generation(), version)).rejects.toMatchObject({ code: 'AUTH_CHANGED' });
    expect((await store.load())?.account).toBe('B');
  });
  it('rejects an initial null version once another session exists', async () => {
    await store.save(session());
    await expect(store.saveBrowserIfCurrent(session('stale'), await store.generation(), null)).rejects.toMatchObject({ code: 'AUTH_CHANGED' });
    expect((await store.load())?.account).toBe('synthetic-account');
  });
  it('propagates non-ENOENT errors from generation, version and versioned reads', async () => {
    await mkdir(path.join(root, 'auth-generation'));
    await expect(store.generation()).rejects.toMatchObject({ code: 'EISDIR' });
    await mkdir(store.file);
    await expect(store.version()).rejects.toMatchObject({ code: 'EISDIR' });
    await expect(store.loadVersioned()).rejects.toMatchObject({ code: 'EISDIR' });
  });
  it('does not invoke the OS component on unsupported platforms', async () => {
    vi.stubGlobal('process', { ...realProcess, platform: 'linux' });
    await expect(store.save(session())).rejects.toMatchObject({ code: 'AUTH_PLATFORM' });
    expect(boundary.spawn).not.toHaveBeenCalled();
  });
  it.each(['lookup', 'error', 'close'])('maps DPAPI %s failure without writing authentication', async mode => {
    if (mode === 'lookup') boundary.executable.mockRejectedValueOnce(new Error('missing executable'));
    else boundary.dpapi = mode as 'error' | 'close';
    await expect(store.save(session())).rejects.toMatchObject({ code: 'AUTH_STORAGE' });
    expect(await store.version()).toBeUndefined();
  });
  it('rejects corrupted decrypted JSON without disguising it as an absent session', async () => {
    await store.save(session()); boundary.dpapi = 'invalid-json';
    await expect(store.load()).rejects.toBeInstanceOf(SyntaxError);
  });
});

async function runCli(argv: string[], options: { input?: string; answers?: string[]; keys?: Array<[string, { name: string; ctrl?: boolean }]>; tty?: boolean; failServe?: unknown } = {}) {
  vi.resetModules();
  const output: string[] = [], errors: string[] = [];
  const stdin = new EventEmitter() as any;
  stdin.isTTY = options.tty ?? false; stdin.setRawMode = vi.fn(); stdin.resume = vi.fn(); stdin.pause = vi.fn();
  stdin[Symbol.asyncIterator] = async function* () { const bytes = Buffer.from(options.input ?? ''); yield bytes.subarray(0, 4); yield bytes.subarray(4); };
  const on = stdin.on.bind(stdin);
  stdin.on = (name: string, listener: (...args: any[]) => void) => {
    on(name, listener);
    if (name === 'keypress') queueMicrotask(() => { for (const [str, key] of options.keys ?? []) stdin.emit('keypress', str, { ctrl: false, ...key }); });
    return stdin;
  };
  const stdout = { write: vi.fn((chunk: string) => { output.push(chunk); return true; }) };
  const stderr = { write: vi.fn((chunk: string) => { errors.push(chunk); return true; }) };
  const fakeProcess = { ...realProcess, argv: ['node', 'cli.ts', ...argv], stdin, stdout, stderr, exitCode: undefined as number | undefined };
  const serve = vi.fn().mockImplementation(async () => { if (options.failServe) throw options.failServe; });
  const runJob = vi.fn().mockResolvedValue(undefined);
  const browser = vi.fn().mockResolvedValue({ configured: true, method: 'synthetic-browser' });
  const install = vi.fn().mockImplementation(async opts => ({ ...opts, synthetic: true }));
  const syncRun = vi.fn().mockResolvedValue({ synced: true }); const client = { synthetic: true };
  const createClient = vi.fn().mockResolvedValue(client);
  const config = loadConfig({ stateDir: root, outputDir: path.join(root, 'downloads'), mock: true });
  const answers = [...(options.answers ?? [])];
  const rl = { question: vi.fn(async () => answers.shift() ?? ''), close: vi.fn() };
  vi.stubGlobal('process', fakeProcess);
  vi.doMock('node:process', () => ({ stdin, stdout, stderr }));
  vi.doMock('node:readline', () => ({ emitKeypressEvents: vi.fn() }));
  vi.doMock('node:readline/promises', () => ({ createInterface: vi.fn(() => rl) }));
  vi.doMock('../src/auth.js', () => ({ AuthStore: class extends AuthStore { constructor() { super(root); } } }));
  vi.doMock('../src/config.js', () => ({ loadConfig: () => config }));
  vi.doMock('../src/client.js', () => ({ createClient }));
  vi.doMock('../src/server.js', () => ({ serve }));
  vi.doMock('../src/jobs.js', () => ({ runJob }));
  vi.doMock('../src/browser-auth.js', () => ({ browserLogin: browser }));
  vi.doMock('../src/install.js', () => ({ installClients: install }));
  vi.doMock('../src/sync.js', () => ({ SyncService: class { constructor(public client: unknown) { expect(client).toEqual({ synthetic: true }); } run = syncRun; } }));
  const module = await import('../src/cli.js');
  await vi.waitFor(() => {
    const printedResult = output.some(chunk => chunk.startsWith('{') || chunk.startsWith('learnX MCP'));
    expect(printedResult || errors.length > 0 || serve.mock.calls.length > 0 || runJob.mock.calls.length > 0).toBe(true);
    if (options.failServe) expect(fakeProcess.exitCode).toBe(1);
  });
  return { module, output: output.join(''), errors: errors.join(''), process: fakeProcess, stdin, rl, serve, runJob, browser, install, syncRun, createClient, config };
}

describe('real CLI module with owned auth and inert command boundaries', () => {
  it.each([{ args: [] }, { args: ['help'] }, { args: ['unknown'] }])('prints safe help for $args', async ({ args }) => {
    const cli = await runCli(args); expect(cli.output).toContain('learnX MCP'); expect(cli.errors).toBe('');
    expect(cli.serve).not.toHaveBeenCalled(); expect(cli.createClient).not.toHaveBeenCalled();
  });
  it('delegates serve without opening transport and worker with its ID', async () => {
    const cli = await runCli(['serve']); expect(cli.serve).toHaveBeenCalledWith(cli.config);
    const worker = await runCli(['worker', 'synthetic-job']); expect(worker.runJob).toHaveBeenCalledWith(worker.config, 'synthetic-job');
    expect(worker.output).toBe('');
  });
  it.each(['status', 'doctor'])('reports local-only %s without connecting a client', async command => {
    const cli = await runCli([command]); const value = JSON.parse(cli.output);
    expect(value).toMatchObject({ sessionValidity: 'not_checked', authentication: { configured: false }, node: realProcess.version });
    expect(cli.createClient).not.toHaveBeenCalled();
  });
  it('reports auth status and logout removes the owned session', async () => {
    await store.save(session());
    const status = await runCli(['auth', 'status']); expect(JSON.parse(status.output).method).toBe('session');
    const logout = await runCli(['auth', 'logout']); expect(JSON.parse(logout.output)).toEqual({ configured: false });
    expect(await store.load()).toBeUndefined();
  });
  it.each([
    { args: ['auth', 'browser', '--account', 'explicit', '--channel', 'chrome'], existing: false, answers: [], account: 'explicit', channel: 'chrome' },
    { args: ['auth', 'browser'], existing: true, answers: [], account: 'saved-account', channel: undefined },
    { args: ['auth', 'browser'], existing: false, answers: ['  typed-account  '], account: 'typed-account', channel: undefined },
  ])('selects browser account source $account', async test => {
    if (test.existing) await store.save(session('saved-account'));
    const cli = await runCli(test.args, { answers: test.answers });
    expect(cli.browser).toHaveBeenCalledWith(expect.any(AuthStore), test.account, test.channel);
    expect(JSON.parse(cli.output).configured).toBe(true);
    expect(cli.rl.close).toHaveBeenCalledTimes(test.answers.length);
  });
  it.each(['stdin', 'file'])('imports session through %s without network verification', async source => {
    const input = JSON.stringify(session('imported'));
    const file = path.join(root, 'synthetic-session.json'); await writeFile(file, input);
    const cli = await runCli(source === 'stdin' ? ['auth', 'import', '--stdin'] : ['auth', 'import', '--file', file], { input });
    expect(await store.load()).toMatchObject(session('imported'));
    expect(JSON.parse(cli.output)).toMatchObject({ configured: true, verified: false }); expect(deniedFetch).not.toHaveBeenCalled();
  });
  it.each([
    { args: ['auth', 'import'], input: '', code: 'AUTH_USAGE' },
    { args: ['auth', 'nonsense'], input: '', code: 'AUTH_USAGE' },
    { args: ['auth', 'import', '--stdin'], input: '{broken', code: 'OPERATION_FAILED' },
    { args: ['auth', 'import', '--stdin'], input: '{"account":"x"}', code: 'AUTH_FORMAT' },
  ])('returns redacted CLI error $code for $args', async test => {
    const cli = await runCli(test.args, { input: test.input });
    expect(JSON.parse(cli.errors).code).toBe(test.code); expect(cli.process.exitCode).toBe(1); expect(cli.output).toBe('');
    expect(await store.load()).toBeUndefined();
  });
  it('maps a missing import file to NOT_FOUND without echoing its path', async () => {
    const missing = path.join(root, 'missing-private.json'); const cli = await runCli(['auth', 'import', '--file', missing]);
    expect(JSON.parse(cli.errors).code).toBe('NOT_FOUND'); expect(cli.errors).not.toContain(missing);
  });
  it('sanitizes uncaught dependency failures and sets exitCode, not process.exit', async () => {
    const cli = await runCli(['serve'], { failServe: new Error('synthetic-private-secret') });
    expect(JSON.parse(cli.errors).code).toBe('OPERATION_FAILED'); expect(cli.errors).not.toContain('synthetic-private-secret');
  });
  it('requires a TTY for hidden password input and closes the username reader', async () => {
    const cli = await runCli(['auth', 'login'], { answers: ['user'] });
    expect(JSON.parse(cli.errors).code).toBe('TTY_REQUIRED'); expect(cli.rl.close).toHaveBeenCalledOnce();
    expect(await store.load()).toBeUndefined();
  });
  it('handles password editing, ignored controls, and restores terminal mode on return', async () => {
    const cli = await runCli(['auth', 'login'], { tty: true, answers: [' user ', ' actual-device '], keys: [
      ['a', { name: 'a' }], ['b', { name: 'b' }], ['', { name: 'backspace' }],
      ['z', { name: 'z', ctrl: true }], ['', { name: 'shift' }], ['c', { name: 'c' }], ['', { name: 'return' }],
    ] });
    expect(await store.load()).toEqual({ account: 'user', username: 'user', password: 'ac', fingerPrint: 'actual-device' });
    expect(cli.stdin.setRawMode.mock.calls).toEqual([[true], [false]]); expect(cli.stdin.listenerCount('keypress')).toBe(0);
    expect(cli.stdin.pause).toHaveBeenCalledOnce(); expect(cli.rl.close).toHaveBeenCalledTimes(2); expect(cli.output).not.toContain('ac');
  });
  it('restores terminal mode and never saves on Ctrl-C', async () => {
    const cli = await runCli(['auth', 'login'], { tty: true, answers: ['user'], keys: [['c', { name: 'c', ctrl: true }]] });
    expect(JSON.parse(cli.errors).code).toBe('CANCELLED'); expect(cli.stdin.setRawMode.mock.calls).toEqual([[true], [false]]);
    expect(cli.stdin.listenerCount('keypress')).toBe(0); expect(await store.load()).toBeUndefined();
  });
  it.each([
    { args: ['sync'], expected: { semesterId: undefined, courseId: undefined } },
    { args: ['sync', '--semester', 's', '--course', 'c', '--output', 'X:\\synthetic-output'], expected: { semesterId: 's', courseId: 'c', outputDir: 'X:\\synthetic-output' } },
  ])('passes sync flags without launching a worker $args', async test => {
    const cli = await runCli(test.args); expect(cli.syncRun).toHaveBeenCalledWith({ outputDir: cli.config.outputDir, ...test.expected });
    expect(JSON.parse(cli.output)).toEqual({ synced: true }); expect(cli.createClient).toHaveBeenCalledOnce();
  });
  it.each([
    { args: ['install'], apply: false, uninstall: false }, { args: ['install', '--apply'], apply: true, uninstall: false },
    { args: ['uninstall', 'clients', '--apply'], apply: true, uninstall: true },
  ])('passes install plan without changing client configuration $args', async test => {
    const cli = await runCli(test.args); expect(cli.install).toHaveBeenCalledWith({ apply: test.apply, uninstall: test.uninstall });
    expect(JSON.parse(cli.output)).toMatchObject({ synthetic: true });
  });
  it('validates imported structure and builds only allowlisted cookies', async () => {
    const { module } = await runCli(['help']);
    for (const raw of [null, {}, { account: 4 }, { account: '  ' }, { account: 'x', cookies: {} }, { account: 'x', cookieJar: {}, csrfToken: '' }, { account: 'x', username: 'u', password: 'p' }]) {
      await expect(module.importAuth(raw)).rejects.toMatchObject({ code: 'AUTH_FORMAT' });
    }
    const data = await module.importAuth({ account: 'cookies', csrfToken: 'synthetic', cookies: [
      { name: 'DROP', value: 'x', domain: 'outside.invalid' },
      { name: 'A', value: 'x', domain: '.learn.tsinghua.edu.cn', secure: true, httpOnly: true },
      { name: 'B', value: 'y', domain: 'id.tsinghua.edu.cn', path: '/auth' },
      { name: 'DROP2', value: 'x' },
    ] });
    expect(data.cookieJar?.cookies.map((c: any) => c.key)).toEqual(['A', 'B']); expect(data.cookieJar?.cookies[0].httpOnly).toBe(true);
    expect(await module.importAuth({ account: 'credentials', username: 'u', password: 'p', fingerPrint: 'f', fingerGenPrint: 'g', fingerGenPrint3: 'g3' })).toMatchObject({ fingerGenPrint: 'g', fingerGenPrint3: 'g3' });
  });
});

function browserFixture() {
  const page = {
    goto: vi.fn().mockResolvedValue(undefined), url: vi.fn(() => 'https://learn.tsinghua.edu.cn/f/wlxt/course'),
    content: vi.fn().mockResolvedValue('<meta name="_csrf" content="synthetic-browser-token">'),
  };
  const context = {
    pages: vi.fn(() => [page]), newPage: vi.fn().mockResolvedValue(page), cookies: vi.fn().mockResolvedValue([cookie()]),
    request: { get: vi.fn().mockResolvedValue({ ok: () => true, json: async () => ({ message: 'success', result: { id: 's' } }) }) },
  };
  boundary.browser.mockImplementation(async (_options, run) => run(context));
  return { page, context };
}

describe('real browser authentication workflow with inert browser transport', () => {
  it.each([
    { response: { ok: () => false }, expected: false },
    { response: { ok: () => true, json: async () => ({ message: 'success', result: {} }) }, expected: false },
    { response: { ok: () => true, json: async () => ({ message: 'success', result: { id: 's' } }) }, expected: true },
  ])('requires both HTTP success and semester identity $expected', async test => {
    const get = vi.fn().mockResolvedValue(test.response);
    expect(await verifyBrowserSession({ request: { get } } as any, 'a&b')).toBe(test.expected);
    expect(get.mock.calls[0][0]).toContain('_csrf=a%26b'); expect(get.mock.calls[0][1].maxRedirects).toBe(0);
  });
  it('treats rejected browser API requests as unverified', async () => {
    expect(await verifyBrowserSession({ request: { get: vi.fn().mockRejectedValue(new Error('offline')) } } as any, 'x')).toBe(false);
  });
  it.each(['<meta name="_csrf" content="meta-token">', '<input name="_csrf" value="input-token">', '<a href="/x?a=1&amp;_csrf=link-token">x</a>'])('extracts CSRF and filters cookie origins from %s', async html => {
    const data = await browserSessionData('synthetic', [cookie(), cookie({ name: 'ID', domain: '.id.tsinghua.edu.cn', secure: false, httpOnly: false, expires: 2000000000 }), cookie({ name: 'DROP', domain: 'outside.invalid' })] as any, html);
    expect(data.csrfToken).toMatch(/^(meta|input|link)-token$/);
    expect(data.cookieJar?.cookies.map((c: any) => c.key)).toEqual(['SESSION', 'ID']);
    expect(data.cookieJar?.cookies[1].expires).toBe(new Date(2000000000 * 1000).toISOString());
  });
  it('refuses a missing token or only identity-provider cookies', async () => {
    await expect(browserSessionData('x', [cookie()] as any, '<p>no token</p>')).rejects.toMatchObject({ code: 'AUTH_TOKEN' });
    await expect(browserSessionData('x', [cookie({ domain: 'id.tsinghua.edu.cn' })] as any, '<meta name="_csrf" content="x">')).rejects.toMatchObject({ code: 'AUTH_COOKIE' });
    expect(await store.version()).toBeUndefined();
  });
  it('verifies and saves the browser session through real epoch/version CAS', async () => {
    const { context } = browserFixture(); const epoch = await store.generation();
    const result = await browserLogin(store, 'synthetic-browser-account', 'chrome', { headless: true, expectedGeneration: epoch, expectedVersion: null });
    expect(result).toMatchObject({ configured: true, method: 'persistent-browser', authVersion: await store.version(), accountId: digest('synthetic-browser-account').slice(0, 16) });
    expect((await store.load())?.csrfToken).toBe('synthetic-browser-token'); expect(context.request.get).toHaveBeenCalledOnce();
    expect(boundary.browser.mock.calls[0][0]).toMatchObject({ channel: 'chrome', headless: true, initialCookies: [] });
  });
  it('restores only allowed old cookies and opens a missing first page', async () => {
    const jar = new CookieJar();
    await jar.setCookie('HOST=x; Path=/; Secure; HttpOnly', 'https://learn.tsinghua.edu.cn');
    await jar.setCookie('DOMAIN=y; Domain=.id.tsinghua.edu.cn; Path=/auth; Expires=Tue, 01 Jan 2030 00:00:00 GMT', 'https://id.tsinghua.edu.cn');
    await jar.setCookie('DROP=z; Path=/', 'https://outside.invalid');
    await store.save({ ...session(), cookieJar: jar.toJSON() });
    const { page, context } = browserFixture(); context.pages.mockReturnValueOnce([]);
    await browserLogin(store, 'synthetic', undefined, { headless: true });
    expect(context.newPage).toHaveBeenCalledOnce(); expect(page.goto).toHaveBeenCalledOnce();
    expect(boundary.browser.mock.calls[0][0].initialCookies).toEqual([
      expect.objectContaining({ name: 'HOST', domain: 'learn.tsinghua.edu.cn', expires: -1, secure: true, httpOnly: true }),
      expect.objectContaining({ name: 'DOMAIN', domain: '.id.tsinghua.edu.cn', path: '/auth', expires: Date.parse('2030-01-01') / 1000 }),
    ]);
  });
  it.each(['navigation interrupted', 'net::ERR_ABORTED', 'frame was detached'])('tolerates expected navigation interruption %s', async message => {
    const { page } = browserFixture(); page.goto.mockRejectedValueOnce(new Error(message));
    expect((await browserLogin(store, 'synthetic', undefined, { headless: true })).configured).toBe(true);
  });
  it('propagates unexpected navigation failures and does not save', async () => {
    const { page } = browserFixture(); const failure = new Error('synthetic navigation failure'); page.goto.mockRejectedValueOnce(failure);
    await expect(browserLogin(store, 'synthetic', undefined, { headless: true })).rejects.toBe(failure); expect(await store.version()).toBeUndefined();
  });
  it('converts shared BrowserError without launching a real browser', async () => {
    boundary.browser.mockRejectedValueOnce(new BrowserError('BROWSER_BUSY', 'synthetic lease busy'));
    await expect(browserLogin(store, 'synthetic')).rejects.toMatchObject({ code: 'BROWSER_BUSY', name: 'LearnError' });
  });
  it.each([true, false])('reports timeout appropriate to headless=%s without saving', async headless => {
    browserFixture(); const stderr = vi.spyOn(realProcess.stderr, 'write').mockReturnValue(true);
    await expect(browserLogin(store, 'synthetic', undefined, { headless, timeoutMs: 0 })).rejects.toMatchObject({ code: headless ? 'BROWSER_LOGIN_REQUIRED' : 'AUTH_TIMEOUT' });
    expect(stderr.mock.calls.length).toBe(headless ? 0 : 1); expect(await store.version()).toBeUndefined();
  });
  it('cancels when the browser closes before authentication', async () => {
    const { context } = browserFixture(); context.pages.mockReturnValueOnce(context.pages()).mockReturnValue([]);
    await expect(browserLogin(store, 'synthetic', undefined, { headless: true })).rejects.toMatchObject({ code: 'CANCELLED' });
  });
  it('honors an abort signal before autofill or session persistence', async () => {
    browserFixture(); const controller = new AbortController(); controller.abort();
    await expect(browserLogin(store, 'synthetic', undefined, { headless: true, signal: controller.signal })).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(boundary.autofill).not.toHaveBeenCalled(); expect(await store.version()).toBeUndefined();
  });
  it('does not attempt to solve or bypass verification in headless mode', async () => {
    browserFixture(); boundary.autofill.mockResolvedValueOnce('verification-required');
    await expect(browserLogin(store, 'synthetic', undefined, { headless: true })).rejects.toMatchObject({ code: 'BROWSER_LOGIN_REQUIRED' });
    expect(await store.version()).toBeUndefined();
  });
  it('does not open a browser after the expected generation has changed', async () => {
    const epoch = await store.generation(); await store.clear();
    await expect(browserLogin(store, 'synthetic', undefined, { headless: true, expectedGeneration: epoch })).rejects.toMatchObject({ code: 'AUTH_CHANGED' });
    expect(boundary.browser).not.toHaveBeenCalled();
  });
  it.each(['missing-token', 'missing-cookie', 'unverified', 'clicked', 'invalid-url', 'foreign-host', 'foreign-path'])('keeps %s pages unsaved until timeout', async mode => {
    const { page, context } = browserFixture(); vi.stubEnv('THU_CAMPUS_AUTOFILL_LOGIN', mode === 'clicked' ? '1' : '0');
    let now = 0; vi.spyOn(Date, 'now').mockImplementation(() => now);
    if (mode === 'missing-token') page.content.mockImplementation(async () => { now = 100; return '<p>login incomplete</p>'; });
    if (mode === 'missing-cookie') { context.cookies.mockResolvedValue([]); page.content.mockImplementation(async () => { now = 100; return '<meta name="_csrf" content="x">'; }); }
    if (mode === 'unverified') context.request.get.mockImplementation(async () => { now = 100; return { ok: () => false } as any; });
    if (mode === 'clicked') boundary.autofill.mockImplementation(async () => { now = 100; return 'clicked'; });
    if (['invalid-url', 'foreign-host', 'foreign-path'].includes(mode)) page.url.mockImplementation(() => { now = 100; return mode === 'invalid-url' ? 'not a URL' : mode === 'foreign-host' ? 'https://outside.invalid/f/wlxt/' : 'https://learn.tsinghua.edu.cn/login'; });
    await expect(browserLogin(store, 'synthetic', undefined, { headless: true, timeoutMs: 50 })).rejects.toMatchObject({ code: 'BROWSER_LOGIN_REQUIRED' });
    expect(await store.version()).toBeUndefined();
  });
  it('propagates save conflicts instead of ignoring them as incomplete pages', async () => {
    const { context } = browserFixture(); context.request.get.mockImplementation(async () => { await store.clear(); return { ok: () => true, json: async () => ({ message: 'success', result: { id: 's' } }) }; });
    await expect(browserLogin(store, 'synthetic', undefined, { headless: true })).rejects.toMatchObject({ code: 'AUTH_CHANGED' });
    expect(await store.load()).toBeUndefined();
  });
});

async function authenticatedClient(overrides = {}) {
  await store.save(session());
  return new RealClient(loadConfig({ stateDir: root, requestTimeoutMs: 1000, ...overrides }));
}
function helperFetchSemester(url = 'https://learn.tsinghua.edu.cn/test', init: RequestInit = {}) {
  boundary.methods.getCurrentSemester.mockImplementation(async () => {
    const response = await boundary.helpers.at(-1).options.fetch(url, init);
    return response.json();
  });
}

describe('RealClient network, recovery and write-safety edges', () => {
  it.each(['http://learn.tsinghua.edu.cn/x', 'https://outside.invalid/x', 'https://learn.tsinghua.edu.cn:8443/x', 'https://u@learn.tsinghua.edu.cn/x', 'https://:p@learn.tsinghua.edu.cn/x'])('rejects unsafe URL %s before fetch', value => {
    expect(() => allowedUrl(value)).toThrow(expect.objectContaining({ code: 'UNSAFE_URL' })); expect(deniedFetch).not.toHaveBeenCalled();
  });
  it.each(['https://learn.tsinghua.edu.cn:443/x', 'https://id.tsinghua.edu.cn/x'])('permits only safe HTTPS URL %s', value => {
    expect(allowedUrl(value).protocol).toBe('https:');
  });
  it('leaves failed initialization retryable when auth is imported later', async () => {
    const client = new RealClient(loadConfig({ stateDir: root }));
    await expect(client.currentSemester()).rejects.toMatchObject({ code: 'AUTH_REQUIRED' });
    await store.save(session()); expect(await client.currentSemester()).toEqual({ id: 'semester-1' });
    expect(boundary.helpers).toHaveLength(1);
  });
  it('uses credential login once and persists the refreshed jar with CAS', async () => {
    await store.save({ account: 'credential-user', username: 'u', password: 'p', fingerPrint: 'f', fingerGenPrint: 'g', fingerGenPrint3: 'g3' });
    const old = await store.version(); const client = new RealClient(loadConfig({ stateDir: root }));
    expect(await client.currentSemester()).toEqual({ id: 'semester-1' });
    expect(boundary.methods.login).toHaveBeenCalledWith('u', 'p', 'f', 'g', 'g3');
    expect(await store.version()).not.toBe(old); expect((await store.load())?.csrfToken).toBe('synthetic-refreshed-token');
  });
  it.each([
    { account: 'x' }, { account: 'x', username: 'u' }, { account: 'x', username: 'u', password: 'p' },
  ])('rejects incomplete stored login data $account', async data => {
    await store.save(data); const client = new RealClient(loadConfig({ stateDir: root }));
    await expect(client.currentSemester()).rejects.toMatchObject({ code: 'AUTH_REQUIRED' }); expect(boundary.methods.login).not.toHaveBeenCalled();
  });
  it('redacts a dependency login rejection and leaves the original version intact', async () => {
    await store.save({ account: 'x', username: 'u', password: 'p', fingerPrint: 'f' }); const version = await store.version();
    boundary.methods.login.mockRejectedValueOnce(new Error('synthetic secret payload'));
    await expect(new RealClient(loadConfig({ stateDir: root })).currentSemester()).rejects.toMatchObject({ code: 'AUTH_REQUIRED' });
    expect(await store.version()).toBe(version);
  });
  it('invalidates helper and identity after an account switch', async () => {
    const client = await authenticatedClient(); await client.currentSemester(); const first = client.identity;
    await store.save(session('another-account')); await client.currentSemester();
    expect(client.identity).not.toBe(first); expect(boundary.helpers).toHaveLength(2);
    await store.clear(); await expect(client.currentSemester()).rejects.toMatchObject({ code: 'AUTH_REQUIRED' }); expect(client.identity).toBe('');
  });
  it.each([
    { status: 303, method: 'PUT', expected: 'GET' }, { status: 301, method: 'POST', expected: 'GET' },
    { status: 302, method: 'POST', expected: 'GET' }, { status: 307, method: 'POST', expected: 'POST' },
    { status: 308, method: 'GET', expected: 'GET' }, { status: 301, method: 'PUT', expected: 'PUT' },
  ])('follows $status safely, changing $method only when required', async test => {
    const client = await authenticatedClient(); helperFetchSemester(undefined, { method: test.method, body: test.method === 'GET' ? undefined : 'payload' });
    deniedFetch.mockResolvedValueOnce(new Response(null, { status: test.status, headers: { location: '/final' } })).mockResolvedValueOnce(Response.json({ id: 'redirected' }));
    expect(await client.currentSemester()).toEqual({ id: 'redirected' });
    expect(deniedFetch.mock.calls[1][0]).toBe('https://learn.tsinghua.edu.cn/final');
    expect(deniedFetch.mock.calls[1][1]).toMatchObject({ redirect: 'manual', method: test.expected });
    if (test.expected === 'GET') expect(deniedFetch.mock.calls[1][1].body).toBeUndefined();
  });
  it('returns a redirect with no location and rejects a cross-origin location without following it', async () => {
    const client = await authenticatedClient(); helperFetchSemester();
    deniedFetch.mockResolvedValueOnce(new Response('{"id":"no-location"}', { status: 302 }));
    expect(await client.currentSemester()).toEqual({ id: 'no-location' });
    deniedFetch.mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: 'https://outside.invalid/' } }));
    await expect(client.currentSemester()).rejects.toMatchObject({ code: 'UNSAFE_URL' }); expect(deniedFetch).toHaveBeenCalledTimes(2);
  });
  it('bounds same-origin redirect chains to ten requests', async () => {
    const client = await authenticatedClient(); helperFetchSemester();
    deniedFetch.mockImplementation(async () => new Response(null, { status: 302, headers: { location: '/again' } }));
    await expect(client.currentSemester()).rejects.toMatchObject({ code: 'REDIRECT_LIMIT' }); expect(deniedFetch).toHaveBeenCalledTimes(10);
  });
  it('rejects auth changes between ready and an actual request', async () => {
    const client = await authenticatedClient();
    boundary.methods.getCurrentSemester.mockImplementation(async () => { await store.clear(); return boundary.helpers.at(-1).options.fetch('https://learn.tsinghua.edu.cn/test'); });
    await expect(client.currentSemester()).rejects.toMatchObject({ code: 'AUTH_CHANGED' }); expect(deniedFetch).not.toHaveBeenCalled();
  });
  it('paginates through the library fetch boundary using real list-page logic', async () => {
    const client = await authenticatedClient(); helperFetchSemester('https://learn.tsinghua.edu.cn/b/test/pageList?page=1&size=2');
    deniedFetch.mockResolvedValueOnce(Response.json({ resultList: [{ id: 'one' }], total: 1 }));
    expect(await client.currentSemester()).toMatchObject({ resultList: [{ id: 'one' }] }); expect(deniedFetch).toHaveBeenCalledOnce();
  });
  it.each(['TypeError', 'TimeoutError'])('retries a transient %s read at most twice', async name => {
    const client = await authenticatedClient(); const error = name === 'TypeError' ? new TypeError('temporary') : Object.assign(new Error('temporary'), { name });
    boundary.methods.getCurrentSemester.mockRejectedValueOnce(error).mockRejectedValueOnce(error).mockResolvedValueOnce({ id: 'recovered' });
    expect(await client.currentSemester()).toEqual({ id: 'recovered' }); expect(boundary.methods.getCurrentSemester).toHaveBeenCalledTimes(3);
  });
  it('does not retry persistent transient failures or ordinary application errors forever', async () => {
    const client = await authenticatedClient(); const error = new TypeError('temporary'); boundary.methods.getCurrentSemester.mockRejectedValue(error);
    await expect(client.currentSemester()).rejects.toBe(error); expect(boundary.methods.getCurrentSemester).toHaveBeenCalledTimes(3);
    boundary.methods.getCurrentSemester.mockReset().mockRejectedValue(new Error('ordinary rejection'));
    await expect(client.currentSemester()).rejects.toThrow('ordinary rejection'); expect(boundary.methods.getCurrentSemester).toHaveBeenCalledOnce();
  });
  it.each(['<meta name="_csrf" content="new-meta">', '<input name="_csrf" value="new-input">', '<a href="/x?a=1&amp;_csrf=new-link">x</a>'])('refreshes CSRF for a stale read using %s, without credential login', async html => {
    const client = await authenticatedClient(); boundary.methods.getCurrentSemester.mockRejectedValueOnce({ reason: 'not logged in or login timeout' }).mockResolvedValueOnce({ id: 'after-refresh' });
    deniedFetch.mockResolvedValueOnce(new Response(html));
    expect(await client.currentSemester()).toEqual({ id: 'after-refresh' });
    expect((await store.load())?.csrfToken).toMatch(/^new-/); expect(boundary.methods.login).not.toHaveBeenCalled();
    expect(boundary.methods.getCurrentSemester).toHaveBeenCalledTimes(2);
  });
  it.each(['http-error', 'foreign-response', 'login-html', 'no-token'])('does not pretend session refreshed after %s', async mode => {
    const client = await authenticatedClient(); boundary.methods.getCurrentSemester.mockRejectedValueOnce(new LearnError('AUTH_REQUIRED', 'stale'));
    const response = new Response(mode === 'login-html' ? '<input type="password">' : '<p>no token</p>', { status: mode === 'http-error' ? 403 : 200 });
    if (mode === 'foreign-response') Object.defineProperty(response, 'url', { value: 'https://outside.invalid/' });
    deniedFetch.mockResolvedValueOnce(response);
    await expect(client.currentSemester()).rejects.toMatchObject({ code: 'AUTH_REQUIRED' }); expect(boundary.methods.login).not.toHaveBeenCalled();
  });
  it('normalizes all list kinds and course name/teacher aliases', async () => {
    const client = await authenticatedClient();
    boundary.methods.getSemesterIdList.mockResolvedValue(['s1', 's2']);
    boundary.methods.getCourseList.mockResolvedValue([{ id: 'c', chineseName: '中文课', teacherName: '教师' }, { id: 'd', name: 'Existing', chineseName: '备用' }]);
    expect(await client.semesters()).toEqual(['s1', 's2']); expect(await client.courses('s')).toMatchObject([{ name: '中文课', teacher: '教师' }, { name: 'Existing' }]);
    const methods: Record<Kind, string> = { notification: 'getNotificationList', file: 'getFileList', homework: 'getHomeworkList', discussion: 'getDiscussionList', question: 'getAnsweredQuestionList', questionnaire: 'getQuestionnaireList' };
    for (const kind of Object.keys(methods) as Kind[]) {
      boundary.methods[methods[kind]].mockResolvedValue([{ id: kind, title: 'Synthetic title', description: '<p>List body</p>', url: 'https://learn.tsinghua.edu.cn/f/wlxt/detail' }]);
      if (kind === 'discussion' || kind === 'question') deniedFetch.mockResolvedValueOnce(new Response('<div class="discussion-content">Detail body<img src="/asset.png"></div>'));
      const result = (await client.contents('c', kind))[0];
      expect(result).toMatchObject({ id: kind, courseId: 'c', kind }); expect(boundary.methods[methods[kind]]).toHaveBeenCalledWith('c');
      if (kind === 'discussion' || kind === 'question') { expect(result.body).toContain('Detail body'); expect(result.completeness).toBe('partial'); expect(result.attachments).toHaveLength(1); }
      else expect(result.body).toContain('List body');
    }
  });
  it('keeps a bad percent-encoded inline filename instead of failing the whole detail', async () => {
    const client = await authenticatedClient(); boundary.methods.getDiscussionList.mockResolvedValue([{ id: 'd', title: 'Summary', url: 'https://learn.tsinghua.edu.cn/f/wlxt/detail' }]);
    deniedFetch.mockResolvedValueOnce(new Response('<div class="discussion-content"><img src="/%zz.png"></div>'));
    const item = (await client.contents('c', 'discussion'))[0];
    expect(item.completeness).toBe('partial');
    expect(item.attachments.map(a => a.name)).toContain('%zz.png');
    expect(item.warnings?.join('')).not.toContain('详情抓取失败');
  });
  it.each(['status', 'header-limit', 'stream-limit', 'null-body'])('handles download %s boundary without saving an invalid attachment', async mode => {
    const client = await authenticatedClient({ maxDownloadBytes: 3 });
    const response = mode === 'status' ? new Response(null, { status: 403 }) : mode === 'header-limit' ? new Response('x', { headers: { 'content-length': '4' } }) : mode === 'stream-limit' ? new Response('four') : new Response(null);
    deniedFetch.mockResolvedValueOnce(response); const result = client.download({ id: 'a', name: 'a.bin', url: 'https://learn.tsinghua.edu.cn/a' });
    if (mode === 'null-body') expect(await result).toHaveLength(0);
    else await expect(result).rejects.toMatchObject({ code: mode === 'status' ? 'DOWNLOAD_FAILED' : 'DOWNLOAD_LIMIT' });
    expect(deniedFetch).toHaveBeenCalledOnce();
  });
  it('maps an aborted download to timeout and forwards the owned AbortSignal', async () => {
    const client = await authenticatedClient({ requestTimeoutMs: 10 });
    deniedFetch.mockImplementation(async (_url, init) => new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })));
    await expect(client.download({ id: 'a', name: 'a.bin', url: 'https://learn.tsinghua.edu.cn/a' })).rejects.toMatchObject({ code: 'DOWNLOAD_TIMEOUT' });
    expect(deniedFetch).toHaveBeenCalledOnce();
  });
  it('returns matching student homework and rejects missing IDs before upload', async () => {
    const client = await authenticatedClient(); boundary.methods.getHomeworkList.mockResolvedValue([{ id: 'student', baseId: 'teacher', title: 'work', submitted: false }]);
    expect((await client.homework('c', 'student')).id).toBe('student');
    await expect(client.submit('c', 'teacher', 'body')).rejects.toMatchObject({ code: 'NOT_FOUND' }); expect(boundary.methods.submitHomework).not.toHaveBeenCalled();
  });
  it.each([false, true])('submits once, with attachment=%s, and no credential reauthentication provider', async attachment => {
    const client = await authenticatedClient(); boundary.methods.getHomeworkList.mockResolvedValue([{ id: 'student', title: 'work' }]);
    await client.submit('c', 'student', 'synthetic body', attachment ? { name: 'answer.txt', bytes: new Uint8Array([65, 66]) } : undefined);
    const args = boundary.methods.submitHomework.mock.calls[0]; expect(args[0]).toBe('student'); expect(args[1]).toBe('synthetic body'); expect(args[3]).toBe(false);
    if (attachment) { expect(args[2].filename).toBe('answer.txt'); expect(await args[2].content.text()).toBe('AB'); } else expect(args[2]).toBeUndefined();
    expect(boundary.methods.submitHomework).toHaveBeenCalledOnce(); expect(boundary.helpers[0].options).not.toHaveProperty('credentialProvider');
  });
  it.each(['operation failed', 'network'])('never replays a rejected %s submission', async reason => {
    const client = await authenticatedClient(); boundary.methods.getHomeworkList.mockResolvedValue([{ id: 'student', title: 'work' }]);
    const error = reason === 'operation failed' ? { reason } : new TypeError('connection dropped'); boundary.methods.submitHomework.mockRejectedValue(error);
    const result = client.submit('c', 'student', 'body');
    if (reason === 'operation failed') await expect(result).rejects.toMatchObject({ code: 'SUBMISSION_REJECTED' }); else await expect(result).rejects.toBe(error);
    expect(boundary.methods.submitHomework).toHaveBeenCalledOnce(); expect(boundary.methods.login).not.toHaveBeenCalled();
  });
  it('checks identity again after homework lookup before uploading', async () => {
    const client = await authenticatedClient();
    boundary.methods.getHomeworkList.mockImplementation(async () => { client.identity = 'concurrent-account'; return [{ id: 'student', title: 'work' }]; });
    await expect(client.submit('c', 'student', 'body')).rejects.toMatchObject({ code: 'AUTH_CHANGED' }); expect(boundary.methods.submitHomework).not.toHaveBeenCalled();
  });
});

async function statusSession() {
  const jar = new CookieJar(); await jar.setCookie('S=synthetic; Path=/; Secure; HttpOnly', 'https://learn.tsinghua.edu.cn');
  await store.save({ ...session(), cookieJar: jar.toJSON() });
  return loadConfig({ stateDir: root, mock: false });
}
const statusHtml = (marker = '<meta name="_csrf" content="synthetic">') => `${marker}<a class="user-log">Synthetic private user</a>`;

describe('read-only status protocol and redaction', () => {
  it('never fetches for verify=false, credential-only auth, or an empty jar', async () => {
    const config = await statusSession();
    expect(await learnStatus(config, { verify: false, store })).toMatchObject({ verified: false, code: 'UNVERIFIED' });
    await store.save({ account: 'x', username: 'u', password: 'p' });
    expect(await learnStatus(config, { store })).toMatchObject({ authentication: { configured: true }, code: 'UNVERIFIED' });
    await store.save(session()); expect(await learnStatus(config, { store })).toMatchObject({ code: 'UNVERIFIED' });
    expect(deniedFetch).not.toHaveBeenCalled(); expect(boundary.methods.login).not.toHaveBeenCalled();
  });
  it.each([
    { status: 401, location: undefined, code: 'AUTH_EXPIRED', validity: 'expired' },
    { status: 403, location: undefined, code: 'AUTH_EXPIRED', validity: 'expired' },
    { status: 302, location: 'https://id.tsinghua.edu.cn/login', code: 'AUTH_EXPIRED', validity: 'expired' },
    { status: 307, location: '/login', code: 'AUTH_EXPIRED', validity: 'expired' },
    { status: 302, location: '/maintenance', code: 'UPSTREAM_PROTOCOL', validity: 'unknown' },
    { status: 302, location: undefined, code: 'UPSTREAM_PROTOCOL', validity: 'unknown' },
    { status: 500, location: undefined, code: 'UPSTREAM_HTTP', validity: 'unknown' },
  ])('classifies HTTP $status / $location without following redirects', async test => {
    const config = await statusSession();
    deniedFetch.mockResolvedValueOnce(new Response('synthetic response', { status: test.status, headers: test.location ? { location: test.location } : {} }));
    expect(await learnStatus(config, { store })).toMatchObject({ code: test.code, sessionValidity: test.validity, verified: false, source: 'protected-api:learn-user-home' });
    expect(deniedFetch).toHaveBeenCalledOnce(); expect(deniedFetch.mock.calls[0][1]).toMatchObject({ method: 'GET', redirect: 'manual' });
  });
  it.each(['<meta name="_csrf" content="synthetic">', '<input name="_csrf" value="synthetic">', '<a href="/x?_csrf=synthetic">link</a>'])('verifies existing session using %s without exposing identity or tokens', async marker => {
    const config = await statusSession(); const before = await store.version();
    deniedFetch.mockResolvedValueOnce(new Response(statusHtml(marker)));
    const result = await learnStatus(config, { store });
    expect(result).toMatchObject({ verified: true, code: 'VERIFIED', sessionValidity: 'verified', authentication: { configured: true } });
    expect(JSON.stringify(result)).not.toContain('Synthetic private user'); expect(JSON.stringify(result)).not.toContain('synthetic');
    expect(await store.version()).toBe(before); expect(boundary.methods.login).not.toHaveBeenCalled();
  });
  it.each([
    { html: '<input type="password">', code: 'AUTH_EXPIRED' },
    { html: '<a class="user-log">User</a>', code: 'UPSTREAM_PROTOCOL' },
    { html: '<meta name="_csrf" content="synthetic">', code: 'UPSTREAM_PROTOCOL' },
  ])('does not verify incomplete page $code', async test => {
    const config = await statusSession(); deniedFetch.mockResolvedValueOnce(new Response(test.html));
    expect(await learnStatus(config, { store })).toMatchObject({ code: test.code, verified: false });
  });
  it('refuses a result obtained while authentication changed', async () => {
    const config = await statusSession();
    deniedFetch.mockImplementation(async () => { await store.clear(); return new Response(statusHtml()); });
    expect(await learnStatus(config, { store })).toMatchObject({ code: 'AUTH_CHANGED', verified: false });
  });
  it('maps protected-read failures to NETWORK_ERROR without echoing diagnostics', async () => {
    const config = await statusSession(); deniedFetch.mockRejectedValueOnce(new Error('synthetic private response'));
    const result = await learnStatus(config, { store }); expect(result).toMatchObject({ code: 'NETWORK_ERROR', sessionValidity: 'unknown' });
    expect(JSON.stringify(result)).not.toContain('synthetic private');
  });
  it('maps local read failures and explicit DPAPI failures without attempting network', async () => {
    const config = loadConfig({ stateDir: root, mock: false }); await mkdir(store.file);
    expect(await learnStatus(config, { store })).toMatchObject({ code: 'AUTH_STORAGE', authentication: { configured: false } });
    await rm(store.file, { recursive: true }); await store.save(session()); boundary.dpapi = 'error';
    expect(await learnStatus(config, { store })).toMatchObject({ code: 'AUTH_STORAGE' }); expect(deniedFetch).not.toHaveBeenCalled();
  });
  it('preserves AUTH_PLATFORM when existing storage cannot decrypt on this OS', async () => {
    const config = await statusSession(); vi.stubGlobal('process', { ...realProcess, platform: 'linux' });
    expect(await learnStatus(config, { store })).toMatchObject({ code: 'AUTH_PLATFORM', verified: false });
  });
});

async function serverFixture() {
  vi.resetModules();
  const registered = new Map<string, { config: any; handler: (args: any) => Promise<any> }>();
  const connect = vi.fn().mockResolvedValue(undefined);
  const sdkConstructor = vi.fn(); const transportConstructor = vi.fn();
  vi.doMock('@modelcontextprotocol/sdk/server/mcp.js', () => ({ McpServer: class {
    constructor(...args: any[]) { sdkConstructor(...args); }
    registerTool(name: string, config: any, handler: (args: any) => Promise<any>) { registered.set(name, { config, handler }); }
    connect = connect;
  } }));
  vi.doMock('@modelcontextprotocol/sdk/server/stdio.js', () => ({ StdioServerTransport: class { constructor() { transportConstructor(); } } }));
  const content = (id: string, submitted = false) => ({
    id, courseId: 'c1', kind: 'homework', title: `Work ${id}`, body: 'B'.repeat(150), revision: 'r', completeness: 'complete', warnings: [],
    attachments: [{ id: 'a', name: 'answer.txt', url: 'https://learn.tsinghua.edu.cn/a?_csrf=synthetic-secret' }],
    url: 'https://learn.tsinghua.edu.cn/h?_csrf=synthetic-secret',
    raw: { submitted, deadline: '2099-01-01', submitTime: submitted ? '2026-01-01' : undefined, grade: 99, gradeLevel: 'A', csrfToken: 'synthetic-secret', gradeContent: 'G'.repeat(150) },
    submittedContent: 'S'.repeat(150), submittedAttachment: { name: 'answer.txt' },
  });
  const items = [content('h1'), content('h2', true)];
  const client = {
    identity: 'synthetic', currentSemester: vi.fn().mockResolvedValue({ id: 'current' }), semesters: vi.fn().mockResolvedValue(['s1']),
    courses: vi.fn().mockResolvedValue([{ id: 'c1', name: 'Alpha', teacher: 'One' }, { id: 'c2', name: 'Beta' }, { id: 'c3', name: 'Gamma', teacher: 'Two' }]),
    contents: vi.fn().mockResolvedValue(items),
  };
  const startJob = vi.fn().mockResolvedValue({ id: 'synthetic-job', status: 'queued' });
  const getJob = vi.fn().mockResolvedValue({ status: 'complete' });
  const search = vi.fn().mockResolvedValue({ items: ['local result'] });
  const prepare = vi.fn().mockResolvedValue({ id: 'synthetic-preparation' });
  const submit = vi.fn().mockResolvedValue({ status: 'submitted' });
  const get = vi.fn().mockResolvedValue(items[1]);
  const status = vi.fn().mockResolvedValue({ verified: false, code: 'UNVERIFIED' });
  vi.doMock('../src/client.js', () => ({ createClient: vi.fn().mockResolvedValue(client) }));
  vi.doMock('../src/jobs.js', () => ({ startJob, getJob }));
  vi.doMock('../src/sync.js', () => ({ searchLocal: search }));
  vi.doMock('../src/submission.js', () => ({ SubmissionService: class { prepare = prepare; submit = submit; get = get; } }));
  vi.doMock('../src/status.js', () => ({ learnStatus: status }));
  const config = loadConfig({ stateDir: root, outputDir: path.join(root, 'downloads'), mock: false });
  const module = await import('../src/server.js'); await module.createServer(config);
  const { z } = await import('zod');
  const invoke = async (name: string, args: Record<string, unknown> = {}) => {
    const entry = registered.get(name)!;
    const result = await entry.handler(z.object(entry.config.inputSchema).parse(args));
    return { ...result, data: JSON.parse(result.content[0].text) };
  };
  return { module, registered, connect, sdkConstructor, transportConstructor, client, items, startJob, getJob, search, prepare, submit, get, status, config, invoke };
}

describe('real server tool handlers with inert SDK/worker/submission boundaries', () => {
  afterEach(() => {
    vi.doUnmock('@modelcontextprotocol/sdk/server/mcp.js');
    vi.doUnmock('@modelcontextprotocol/sdk/server/stdio.js');
  });
  it('registers safety annotations and connects only the mocked transport', async () => {
    const api = await serverFixture(); expect(api.registered.size).toBe(13);
    expect(api.registered.get('learn_submit_assignment')?.config.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true, idempotentHint: true });
    expect(api.registered.get('learn_prepare_submission')?.config.annotations.readOnlyHint).toBe(false);
    expect(api.registered.get('learn_list_contents')?.config.annotations.readOnlyHint).toBe(true);
    await api.module.serve(api.config); expect(api.connect).toHaveBeenCalledOnce(); expect(api.transportConstructor).toHaveBeenCalledOnce();
  });
  it('returns read-only status sections and current/available semester data', async () => {
    const api = await serverFixture();
    const status = (await api.invoke('learn_status', { verify: false })).data;
    expect(api.status).toHaveBeenCalledWith(api.config, { verify: false }); expect(status.sections).toHaveLength(6);
    expect(status.sections.find((s: any) => s.kind === 'discussion').completeness).toBe('partial-until-site-verified');
    expect((await api.invoke('learn_list_semesters')).data).toEqual({ current: { id: 'current' }, semesters: ['s1'] });
  });
  it('paginates courses, uses explicit semester, and filters names or teachers case-insensitively', async () => {
    const api = await serverFixture();
    expect((await api.invoke('learn_list_courses', { limit: 1 })).data).toMatchObject({ semesterId: 'current', total: 3, nextOffset: 1 });
    const filtered = (await api.invoke('learn_list_courses', { semesterId: 'explicit', query: 'tWO', offset: 0 })).data;
    expect(filtered.items.map((c: any) => c.id)).toEqual(['c3']); expect(filtered).not.toHaveProperty('nextOffset');
    expect(api.client.courses).toHaveBeenLastCalledWith('explicit');
    expect((await api.invoke('learn_list_courses', { query: 'beta' })).data.items).toHaveLength(1);
  });
  it('returns content summaries and truncated details with sensitive query parameters scrubbed', async () => {
    const api = await serverFixture();
    const list = (await api.invoke('learn_list_contents', { courseId: 'c1', kind: 'homework', limit: 1 })).data;
    expect(list).toMatchObject({ total: 2, nextOffset: 1, items: [{ id: 'h1', attachmentNames: ['answer.txt'] }] });
    expect(list.items[0]).not.toHaveProperty('body');
    const detail = (await api.invoke('learn_get_content', { courseId: 'c1', kind: 'homework', id: 'h1', maxChars: 100 })).data;
    expect(detail.body).toHaveLength(100); expect(detail.truncated).toBe(true); expect(detail.url).not.toContain('_csrf');
    expect(detail.attachments[0].url).not.toContain('synthetic-secret');
    const full = (await api.invoke('learn_get_content', { courseId: 'c1', kind: 'homework', id: 'h1' })).data;
    expect(full.truncated).toBe(false);
  });
  it('reports missing content and redacts unexpected dependency exceptions', async () => {
    const api = await serverFixture();
    expect((await api.invoke('learn_get_content', { courseId: 'c1', kind: 'homework', id: 'absent' })).data.code).toBe('NOT_FOUND');
    api.client.currentSemester.mockRejectedValueOnce(new Error('private-secret-cookie'));
    const result = await api.invoke('learn_list_semesters'); expect(result.isError).toBe(true); expect(result.data.code).toBe('OPERATION_FAILED');
    expect(JSON.stringify(result)).not.toContain('private-secret-cookie');
  });
  it('delegates sync plans and status without spawning a worker', async () => {
    const api = await serverFixture();
    await api.invoke('learn_sync_semester', {}); expect(api.startJob).toHaveBeenLastCalledWith(api.config, { outputDir: api.config.outputDir });
    const explicit = path.join(root, 'explicit-output');
    await api.invoke('learn_sync_course', { courseId: 'c1', outputDir: explicit, sections: ['homework'] });
    expect(api.startJob).toHaveBeenLastCalledWith(api.config, { courseId: 'c1', outputDir: explicit, sections: ['homework'] });
    const id = '00000000-0000-4000-8000-000000000001'; await api.invoke('learn_sync_status', { jobId: id });
    expect(api.getJob).toHaveBeenCalledWith(api.config, id); expect(boundary.spawn).not.toHaveBeenCalled();
  });
  it('selects explicit or configured output for local search with pagination', async () => {
    const api = await serverFixture(); await api.invoke('learn_search_local', { query: 'alpha' });
    expect(api.search).toHaveBeenLastCalledWith(api.config.outputDir, 'alpha', 0, 20);
    const output = path.join(root, 'other-output'); await api.invoke('learn_search_local', { query: 'beta', outputDir: output, offset: 2, limit: 3 });
    expect(api.search).toHaveBeenLastCalledWith(output, 'beta', 2, 3);
  });
  it('filters pending assignments and preserves per-course errors without losing successful courses', async () => {
    const api = await serverFixture();
    api.client.contents.mockImplementation(async courseId => { if (courseId === 'c2') throw new Error('private upstream data'); return api.items; });
    const pending = (await api.invoke('learn_list_assignments', { pendingOnly: true })).data;
    expect(pending.items.map((h: any) => h.id)).toEqual(['h1', 'h1']); expect(pending.errors).toMatchObject([{ courseId: 'c2', code: 'OPERATION_FAILED' }]);
    expect(JSON.stringify(pending)).not.toContain('private upstream data');
    const specific = (await api.invoke('learn_list_assignments', { semesterId: 'explicit', courseId: 'c1', pendingOnly: false, limit: 1 })).data;
    expect(specific).toMatchObject({ total: 2, nextOffset: 1, errors: [] });
    expect(api.client.courses).toHaveBeenLastCalledWith('explicit');
  });
  it('delegates preparation/submission and truncates returned submission feedback', async () => {
    const api = await serverFixture();
    await api.invoke('learn_prepare_submission', { courseId: 'c1', homeworkId: 'h1', content: 'body' });
    expect(api.prepare).toHaveBeenCalledWith({ courseId: 'c1', homeworkId: 'h1', content: 'body', overwrite: false });
    const id = '00000000-0000-4000-8000-000000000001'; await api.invoke('learn_submit_assignment', { preparationId: id }); expect(api.submit).toHaveBeenCalledWith(id);
    const result = (await api.invoke('learn_get_submission', { courseId: 'c1', homeworkId: 'h2', maxChars: 100 })).data;
    expect(result.submittedContent).toHaveLength(100); expect(result.gradeContent).toHaveLength(100); expect(result.grade).toBe(99); expect(result.submittedAttachment.name).toBe('answer.txt');
    api.get.mockResolvedValueOnce({ ...api.items[0], submittedContent: undefined, raw: {} });
    const empty = (await api.invoke('learn_get_submission', { courseId: 'c1', homeworkId: 'h1' })).data; expect(empty).not.toHaveProperty('submittedContent'); expect(empty).not.toHaveProperty('gradeContent');
  });
  it('enforces actual tool input schemas before calling any business dependency', async () => {
    const api = await serverFixture();
    await expect(api.invoke('learn_list_contents', { courseId: 'c1', kind: 'unsupported' })).rejects.toThrow();
    await expect(api.invoke('learn_sync_status', { jobId: 'not-a-uuid' })).rejects.toThrow();
    await expect(api.invoke('learn_list_courses', { limit: 101 })).rejects.toThrow();
    expect(api.client.contents).not.toHaveBeenCalled(); expect(api.getJob).not.toHaveBeenCalled(); expect(api.client.courses).not.toHaveBeenCalled();
  });
});
