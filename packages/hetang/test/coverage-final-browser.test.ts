import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { BrowserError } from '@thu-campus/browser';
import { browserLogin } from '../src/browser-auth.js';
import { AuthStore } from '../src/auth.js';
import { loadConfig, ORIGIN } from '../src/config.js';
import { digest } from '../src/storage.js';
import { RainError } from '../src/types.js';

const boundary = vi.hoisted(() => ({ browser: vi.fn(), guard: vi.fn() }));
vi.mock('@thu-campus/browser', async original => ({
  ...await original<typeof import('@thu-campus/browser')>(),
  withBrowser: (...args: any[]) => boundary.browser(...args),
  authGuard: (...args: any[]) => boundary.guard(...args),
}));
const QA = path.resolve('D:/code/thu-campus-mcp/.local/qa-temp');
let root: string;
let load: ReturnType<typeof vi.spyOn>;
let save: ReturnType<typeof vi.spyOn>;
beforeEach(async () => {
  for (const name of ['TEMP', 'TMP', 'TMPDIR']) vi.stubEnv(name, QA);
  await fs.mkdir(QA, { recursive: true });
  root = await fs.mkdtemp(path.join(QA, 'hetang-final-browser-'));
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('Real network forbidden'); }));
  boundary.browser.mockReset().mockRejectedValue(new Error('Real browser forbidden'));
  boundary.guard.mockReset().mockResolvedValue({ epoch: 'guard-epoch', version: null });
  load = vi.spyOn(AuthStore.prototype, 'load').mockResolvedValue(undefined);
  save = vi.spyOn(AuthStore.prototype, 'saveIfCurrent').mockResolvedValue('saved-version');
  vi.spyOn(process.stderr, 'write').mockReturnValue(true);
});
afterEach(async () => {
  vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs();
  expect(path.dirname(path.resolve(root))).toBe(QA);
  expect(path.basename(root)).toMatch(/^hetang-final-browser-/);
  await fs.rm(root, { recursive: true, force: true });
});
const cfg = () => loadConfig({ stateDir: path.join(root, 'state'), outputDir: path.join(root, 'out'), mock: false });
const cookie = { name: 'sessionid', value: 'synthetic-session' };
function response(body: unknown = { code: 0, data: { userInfo: { userId: 'unit-user' } } }, headers: Record<string, string> = {}) {
  return { ok: vi.fn(() => true), text: vi.fn(async () => JSON.stringify(body)), headers: vi.fn(() => headers) };
}
function browser(options: { firstPage?: boolean; closed?: boolean; cookies?: any[]; response?: ReturnType<typeof response>; requests?: any[]; gotoError?: Error } = {}) {
  let listener: (request: any) => Promise<void>;
  let opened = options.firstPage !== false, pageChecks = 0;
  const page = { goto: vi.fn(async () => {
    if (options.gotoError) throw options.gotoError;
    for (const request of options.requests ?? []) await listener(request);
  }) };
  const context = {
    on: vi.fn((_event: string, callback: typeof listener) => { listener = callback; }),
    pages: vi.fn(() => options.closed && pageChecks++ > 0 ? [] : opened ? [page] : []),
    newPage: vi.fn(async () => { opened = true; return page; }),
    cookies: vi.fn(async () => options.cookies ?? [cookie]),
    request: { get: vi.fn(async () => options.response ?? response()) },
  };
  boundary.browser.mockImplementation(async (_options, callback) => callback(context));
  return { page, context };
}
const request = (url: string, authorization?: string) => ({ url: () => url, allHeaders: vi.fn(async () => authorization === undefined ? {} : { authorization }) });
async function expires(options: Parameters<typeof browser>[0]) {
  vi.useFakeTimers();
  const fixture = browser(options);
  const pending = expect(browserLogin(cfg(), undefined, { headless: true, timeoutMs: 1 })).rejects.toMatchObject({ code: 'BROWSER_LOGIN_REQUIRED' });
  await vi.advanceTimersByTimeAsync(2001);
  await pending;
  expect(save).not.toHaveBeenCalled();
  return fixture;
}

describe('real rain browser authentication with inert browser and credential boundaries', () => {
  it.each([true, false])('verifies identity, saves cookies and respects headless=%s', async headless => {
    load.mockResolvedValue({ account: 'prior', userId: 'prior', cookieHeader: ' one=1; malformed; two=x=y; ' });
    const fixture = browser({ firstPage: headless });
    const result = await browserLogin(cfg(), 'chrome', { headless, expectedGeneration: 'expected-epoch', expectedVersion: 'expected-version', expectedAccountId: digest('unit-user').slice(0, 16) });
    expect(result).toEqual({ authVersion: 'saved-version', accountId: digest('unit-user').slice(0, 16), configured: true, verified: true, protection: 'Windows-DPAPI' });
    expect(boundary.guard).toHaveBeenCalledWith(expect.any(AuthStore), { epoch: 'expected-epoch', version: 'expected-version' });
    expect(boundary.browser.mock.calls[0][0]).toMatchObject({ channel: 'chrome', initialCookies: [
      { name: 'one', value: '1', domain: 'pro.yuketang.cn', path: '/', secure: true, httpOnly: true, expires: -1 },
      { name: 'two', value: 'x=y', domain: 'pro.yuketang.cn', path: '/', secure: true, httpOnly: true, expires: -1 },
    ] });
    expect(save).toHaveBeenCalledWith({ account: 'unit-user', userId: 'unit-user', cookieHeader: 'sessionid=synthetic-session', bearerToken: undefined }, 'guard-epoch', null);
    expect(fixture.context.newPage).toHaveBeenCalledTimes(headless ? 0 : 1);
    expect(fixture.page.goto).toHaveBeenCalledWith(ORIGIN, { waitUntil: 'domcontentloaded', timeout: 60000 });
    expect(fixture.context.request.get).toHaveBeenCalledWith(ORIGIN + '/api/v3/user/basic-info', { headers: { xtbz: 'ykt', 'x-client': 'h5', Referer: ORIGIN + '/' }, timeout: 15000, failOnStatusCode: false, maxRedirects: 0 });
    expect(process.stderr.write).toHaveBeenCalledTimes(headless ? 0 : 1);
  });
  it('uses default options without inventing saved cookies', async () => {
    browser(); await expect(browserLogin(cfg())).resolves.toMatchObject({ verified: true });
    expect(boundary.browser.mock.calls[0][0].initialCookies).toEqual([]);
    expect(boundary.guard.mock.calls[0][1]).toEqual({ epoch: undefined, version: undefined });
  });
  it('accepts headless default timeout and an empty prior cookie header', async () => {
    load.mockResolvedValue({ account: 'prior', userId: 'prior', cookieHeader: '' });
    browser(); await browserLogin(cfg(), undefined, { headless: true });
    expect(save).toHaveBeenCalledOnce();
  });
  it.each([
    { data: { user_info: { user_id: 'snake' } } },
    { result: { id: 'flat' } },
    { id: 'top-level' },
  ])('accepts supported identity envelope %j', async body => {
    browser({ response: response(body) });
    await browserLogin(cfg(), undefined, { headless: true });
    const expected = 'data' in body ? 'snake' : 'result' in body ? 'flat' : 'top-level';
    expect(save.mock.calls[0][0]).toMatchObject({ account: expected, userId: expected });
  });
  it('captures only same-origin Bearer headers and survives malformed requests', async () => {
    const foreign = request('https://foreign.invalid/path', 'Bearer foreign');
    const malformed = request('not a URL', 'Bearer malformed');
    const broken = { url: () => ORIGIN, allHeaders: vi.fn(async () => { throw new Error('headers unavailable'); }) };
    browser({ requests: [foreign, malformed, broken, request(ORIGIN), request(ORIGIN, 'Basic rejected'), request(ORIGIN, 'Bearer captured-token')] });
    await browserLogin(cfg(), undefined, { headless: true });
    expect(foreign.allHeaders).not.toHaveBeenCalled(); expect(malformed.allHeaders).not.toHaveBeenCalled();
    expect(save.mock.calls[0][0].bearerToken).toBe('captured-token');
  });
  it.each(['Bearer server-token', 'bEaReR   server-token', 'server-token'])('prefers authoritative set-auth header %s', async header => {
    browser({ requests: [request(ORIGIN, 'Bearer old-token')], response: response(undefined, { 'set-auth': header }) });
    await browserLogin(cfg(), undefined, { headless: true });
    expect(save.mock.calls[0][0].bearerToken).toBe('server-token');
  });
  it('rejects a mismatched browser identity without replacing credentials', async () => {
    browser(); await expect(browserLogin(cfg(), undefined, { headless: true, expectedAccountId: 'foreign-account' })).rejects.toMatchObject({ code: 'BROWSER_ACCOUNT_MISMATCH' });
    expect(save).not.toHaveBeenCalled();
  });
  it.each(['AUTH_CHANGED', 'BROWSER_ACCOUNT_MISMATCH'])('does not swallow %s from guarded persistence', async code => {
    const failure = new RainError(code, 'synthetic conflict'); save.mockRejectedValueOnce(failure); browser();
    await expect(browserLogin(cfg(), undefined, { headless: true })).rejects.toBe(failure);
    expect(save).toHaveBeenCalledOnce();
  });
  it.each([new Error('transient save failure'), new RainError('AUTH_STORAGE', 'transient storage failure')])('retries non-conflict persistence failure %s', async failure => {
    vi.useFakeTimers(); browser(); save.mockRejectedValueOnce(failure);
    const pending = browserLogin(cfg(), undefined, { headless: true, timeoutMs: 5000 });
    await vi.advanceTimersByTimeAsync(2000);
    await expect(pending).resolves.toMatchObject({ authVersion: 'saved-version' });
    expect(save).toHaveBeenCalledTimes(2);
  });
  it('stops before browser and credential reads when the guard rejects', async () => {
    const failure = new RainError('AUTH_CHANGED', 'stale snapshot'); boundary.guard.mockRejectedValueOnce(failure);
    await expect(browserLogin(cfg())).rejects.toBe(failure);
    expect(load).not.toHaveBeenCalled(); expect(boundary.browser).not.toHaveBeenCalled();
  });
  it('propagates credential-load errors without launching a browser', async () => {
    const failure = new Error('synthetic load error'); load.mockRejectedValueOnce(failure);
    await expect(browserLogin(cfg())).rejects.toBe(failure); expect(boundary.browser).not.toHaveBeenCalled();
  });
  it('detects a closed login window', async () => {
    const fixture = browser({ closed: true });
    await expect(browserLogin(cfg(), undefined, { headless: true })).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(fixture.context.cookies).not.toHaveBeenCalled(); expect(save).not.toHaveBeenCalled();
  });
  it.each([true, false])('returns the correct immediate timeout for headless=%s', async headless => {
    const fixture = browser();
    await expect(browserLogin(cfg(), undefined, { headless, timeoutMs: 0 })).rejects.toMatchObject({ code: headless ? 'BROWSER_LOGIN_REQUIRED' : 'AUTH_TIMEOUT' });
    expect(fixture.context.cookies).not.toHaveBeenCalled(); expect(save).not.toHaveBeenCalled();
  });
  it.each([{ cookies: [] }, { cookies: [{ name: 'other', value: 'not-session' }] }, { cookies: [{ name: 'sessionid', value: '' }] }])('does not verify absent or empty session cookies %j', async options => {
    const fixture = await expires(options); expect(fixture.context.request.get).not.toHaveBeenCalled();
  });
  it('keeps waiting after a failed HTTP verification without reading its body', async () => {
    const bad = response(); bad.ok.mockReturnValue(false);
    await expires({ response: bad }); expect(bad.text).not.toHaveBeenCalled();
  });
  it.each([{ code: 7, data: { id: 'user' } }, { code: 0, data: {} }, { code: 0, data: { id: false } }])('does not persist invalid verification result %j', async body => {
    await expires({ response: response(body) });
  });
  it('waits past malformed JSON without persisting credentials', async () => {
    const bad = response(); bad.text.mockResolvedValue('{invalid'); await expires({ response: bad });
  });
  it('preserves an imprecise upstream numeric identifier as a string', async () => {
    const large = response(); large.text.mockResolvedValue('{"data":{"id":9007199254740993}}');
    browser({ response: large }); await browserLogin(cfg(), undefined, { headless: true });
    expect(save.mock.calls[0][0].userId).toBe('9007199254740993');
  });
  it.each([new Error('navigation failed'), new BrowserError('BROWSER_UNAVAILABLE', 'synthetic browser unavailable')])('propagates or translates browser error %s', async failure => {
    if (failure instanceof BrowserError) boundary.browser.mockRejectedValueOnce(failure); else browser({ gotoError: failure });
    const pending = browserLogin(cfg(), undefined, { headless: true });
    if (failure instanceof BrowserError) await expect(pending).rejects.toMatchObject({ name: 'RainError', code: failure.code, message: failure.message });
    else await expect(pending).rejects.toBe(failure);
  });
  it('propagates context cookie retrieval errors instead of saving', async () => {
    const fixture = browser(); const failure = new Error('context unavailable'); fixture.context.cookies.mockRejectedValueOnce(failure);
    await expect(browserLogin(cfg(), undefined, { headless: true })).rejects.toBe(failure); expect(save).not.toHaveBeenCalled();
  });
});
