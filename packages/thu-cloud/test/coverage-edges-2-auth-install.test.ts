import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { BrowserError } from '@thu-campus/browser';
import { browserLogin, cookieToken } from '../src/browser-auth.js';
import { AuthStore } from '../src/auth.js';
import { loadConfig } from '../src/config.js';
import { mergeJson, mergeToml, installClients } from '../src/install.js';
import { digest, readJson } from '../src/storage.js';
import { CloudError } from '../src/types.js';
import { parse } from 'smol-toml';

const boundary = vi.hoisted(() => ({ browser: vi.fn(), guard: vi.fn(), validate: vi.fn(), actualFs: undefined as any }));
vi.mock('@thu-campus/browser', async original => ({ ...await original<typeof import('@thu-campus/browser')>(), withBrowser: (...args: any[]) => boundary.browser(...args), authGuard: (...args: any[]) => boundary.guard(...args) }));
vi.mock('../src/client.js', async original => ({ ...await original<typeof import('../src/client.js')>(), validateToken: (...args: any[]) => boundary.validate(...args) }));
vi.mock('node:fs/promises', async original => { const actual = await original<typeof import('node:fs/promises')>(); boundary.actualFs = actual; return { ...actual, readFile: vi.fn(actual.readFile) }; });
const QA = path.resolve('D:/code/thu-campus-mcp/.local/qa-temp');
const TOKEN = 'unit-token-only-0123456789012345', ACCOUNT = 'offline@example.test';
let root: string;
beforeEach(async () => {
  for (const name of ['TEMP', 'TMP', 'TMPDIR']) vi.stubEnv(name, QA);
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('Real network forbidden'); }));
  await fs.mkdir(QA, { recursive: true }); root = await fs.mkdtemp(path.join(QA, 'cloud-auth-install-edges-2-'));
  boundary.browser.mockReset().mockRejectedValue(new Error('Unplanned browser launch'));
  boundary.guard.mockReset().mockResolvedValue({ epoch: 'unit-epoch', version: null });
  boundary.validate.mockReset().mockResolvedValue({ account: ACCOUNT, token: TOKEN, mode: 'account' });
  vi.mocked(fs.readFile).mockReset().mockImplementation(boundary.actualFs.readFile);
});
afterEach(async () => {
  vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs();
  expect(path.dirname(path.resolve(root))).toBe(QA); expect(path.basename(root)).toMatch(/^cloud-auth-install-edges-2-/);
  await fs.rm(root, { recursive: true, force: true });
});
const cfg = () => loadConfig({ stateDir: path.join(root, 'state'), outputDir: path.join(root, 'out'), mock: false });
function browser(options: { firstPage?: boolean; closed?: boolean; cookies?: any[]; gotoError?: Error } = {}) {
  const page = { goto: options.gotoError ? vi.fn().mockRejectedValue(options.gotoError) : vi.fn().mockResolvedValue(undefined) };
  let newPage = false, calls = 0;
  const context = {
    pages: vi.fn(() => options.closed && calls++ > 0 ? [] : (options.firstPage === false && !newPage ? [] : [page])),
    newPage: vi.fn(async () => { newPage = true; return page; }),
    cookies: vi.fn(async () => options.cookies ?? [{ name: 'seahub_auth', domain: '.cloud.tsinghua.edu.cn', value: encodeURIComponent('user@' + TOKEN) }]),
  };
  boundary.browser.mockImplementation(async (_options, callback) => callback(context));
  return { page, context };
}

describe('real browserLogin state machine with inert browser and credential boundaries', () => {
  it.each([
    [{ name: 'other', domain: 'cloud.tsinghua.edu.cn', value: 'user@' + TOKEN }],
    [{ name: 'seahub_auth', domain: 'foreign.test', value: 'user@' + TOKEN }],
    [{ name: 'seahub_auth', domain: 'cloud.tsinghua.edu.cn', value: '%invalid' }],
    [{ name: 'seahub_auth', domain: 'cloud.tsinghua.edu.cn', value: TOKEN }],
    [{ name: 'seahub_auth', domain: 'cloud.tsinghua.edu.cn', value: 'user@short' }],
  ])('ignores invalid token cookies %j', cookie => expect(cookieToken([cookie] as any)).toBeUndefined());
  it('decodes a quoted cookie and continues past malformed candidates', () => {
    expect(cookieToken([{ name: 'seahub_auth', domain: 'cloud.tsinghua.edu.cn', value: '%' }, { name: 'seahub_auth', domain: '.cloud.tsinghua.edu.cn', value: encodeURIComponent('"name@' + TOKEN + '"') }])).toBe(TOKEN);
  });
  it.each([true, false])('saves the verified identity with headless=%s and forwards auth guard versions', async headless => {
    const f = browser({ firstPage: headless }); const save = vi.spyOn(AuthStore.prototype, 'saveIfCurrent').mockResolvedValue('new-version');
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const result = await browserLogin(cfg(), 'chrome', { headless, expectedGeneration: 'expected-epoch', expectedVersion: 'expected-version', expectedAccountId: digest(ACCOUNT).slice(0, 16) });
    expect(result).toMatchObject({ authVersion: 'new-version', accountId: digest(ACCOUNT).slice(0, 16), configured: true, mode: 'account', protection: 'Windows-DPAPI' });
    expect(boundary.guard).toHaveBeenCalledWith(expect.any(AuthStore), { epoch: 'expected-epoch', version: 'expected-version' });
    expect(save).toHaveBeenCalledWith({ account: ACCOUNT, token: TOKEN, mode: 'account' }, 'unit-epoch', null);
    expect(f.context.newPage).toHaveBeenCalledTimes(headless ? 0 : 1); expect(f.page.goto).toHaveBeenCalledWith('https://cloud.tsinghua.edu.cn', { waitUntil: 'domcontentloaded', timeout: 60000 });
    expect(stderr).toHaveBeenCalledTimes(headless ? 0 : 1); expect(boundary.browser.mock.calls[0][0]).toMatchObject({ channel: 'chrome', headless });
  });
  it('does not replace authentication belonging to another expected account', async () => {
    browser(); const save = vi.spyOn(AuthStore.prototype, 'saveIfCurrent').mockResolvedValue('unexpected');
    await expect(browserLogin(cfg(), undefined, { headless: true, expectedAccountId: 'other' })).rejects.toMatchObject({ code: 'BROWSER_ACCOUNT_MISMATCH' });
    expect(save).not.toHaveBeenCalled();
  });
  it.each([new CloudError('AUTH_CHANGED', 'changed'), new Error('local write failed')])('propagates safe-save conflicts %s instead of treating them as incomplete login', async failure => {
    browser(); vi.spyOn(AuthStore.prototype, 'saveIfCurrent').mockRejectedValueOnce(failure);
    await expect(browserLogin(cfg(), undefined, { headless: true })).rejects.toBe(failure);
  });
  it('does not open a browser after the authentication guard rejects', async () => {
    boundary.guard.mockRejectedValueOnce(new CloudError('AUTH_CHANGED', 'stale'));
    await expect(browserLogin(cfg())).rejects.toMatchObject({ code: 'AUTH_CHANGED' }); expect(boundary.browser).not.toHaveBeenCalled();
  });
  it('detects a closed login browser and does not validate a token', async () => {
    browser({ closed: true }); await expect(browserLogin(cfg(), undefined, { headless: true })).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(boundary.validate).not.toHaveBeenCalled();
  });
  it.each([true, false])('returns the correct timeout code in headless=%s without saving', async headless => {
    const f = browser({ cookies: [] }); vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const save = vi.spyOn(AuthStore.prototype, 'saveIfCurrent').mockResolvedValue('unused');
    await expect(browserLogin(cfg(), undefined, { headless, timeoutMs: 0 })).rejects.toMatchObject({ code: headless ? 'BROWSER_LOGIN_REQUIRED' : 'AUTH_TIMEOUT' });
    expect(f.context.cookies).not.toHaveBeenCalled(); expect(save).not.toHaveBeenCalled();
  });
  it.each(['AUTH_TOKEN', 'AUTH_REQUIRED'])('waits after retryable %s then accepts the newly verified token', async code => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] }); const f = browser();
    boundary.validate.mockRejectedValueOnce(new CloudError(code, 'expired')); vi.spyOn(AuthStore.prototype, 'saveIfCurrent').mockResolvedValue('saved');
    const pending = browserLogin(cfg(), undefined, { headless: true, timeoutMs: 5000 });
    await vi.waitFor(() => expect(boundary.validate).toHaveBeenCalledOnce()); await vi.advanceTimersByTimeAsync(1500);
    expect(await pending).toMatchObject({ configured: true }); expect(f.context.cookies).toHaveBeenCalledTimes(2);
  });
  it('waits through a missing cookie without invoking validation', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] }); browser({ cookies: [] });
    const pending = browserLogin(cfg(), undefined, { headless: true, timeoutMs: 1000 }); const assertion = expect(pending).rejects.toMatchObject({ code: 'BROWSER_LOGIN_REQUIRED' });
    await vi.waitFor(() => expect(boundary.browser).toHaveBeenCalled()); await vi.advanceTimersByTimeAsync(2000); await assertion; expect(boundary.validate).not.toHaveBeenCalled();
  });
  it.each([new Error('navigation failed'), new BrowserError('BROWSER_UNAVAILABLE', 'synthetic missing browser')])('propagates or maps browser failure %s', async failure => {
    if (failure instanceof BrowserError) boundary.browser.mockRejectedValueOnce(failure); else browser({ gotoError: failure });
    const promise = browserLogin(cfg(), undefined, { headless: true });
    if (failure instanceof BrowserError) await expect(promise).rejects.toMatchObject({ name: 'CloudError', code: failure.code, message: failure.message });
    else await expect(promise).rejects.toBe(failure);
  });
});

const entry = { command: 'node-unit', args: ['D:/unit-owned/cloud/cli.js', 'serve'], env: { UNIT: '1' } };
describe('real install mergers refuse unsafe or foreign client configuration', () => {
  it.each(['null', '[]', '2', '"text"'])('rejects nonobject JSON %s', text => expect(() => mergeJson(text, entry, 'json', false)).toThrow(expect.objectContaining({ code: 'INVALID_CONFIG' })));
  it.each(['null', '[]', '2', '"bad"'])('rejects malformed mcpServers %s', value => expect(() => mergeJson('{"mcpServers":' + value + '}', entry, 'json', false)).toThrow(expect.objectContaining({ code: 'INVALID_CONFIG' })));
  it.each(['{}', '{"version":2,"servers":[]}', '{"version":1,"servers":{}}'])('rejects unsupported Harness %s', text => expect(() => mergeJson(text, entry, 'harness', false)).toThrow(expect.objectContaining({ code: 'INVALID_CONFIG' })));
  it.each(['json', 'harness'] as const)('preserves unrelated %s config and is byte-idempotent for install/uninstall', format => {
    const original = format === 'json' ? '{"keep":1,"mcpServers":{"other":{"command":"other"}}}' : '{"version":1,"servers":[{"name":"other","command":"other"}]}';
    expect(mergeJson(original, entry, format, true)).toBe(original);
    const installed = mergeJson(original, entry, format, false); expect(mergeJson(installed, entry, format, false)).toBe(installed);
    const data = JSON.parse(installed); const own = format === 'json' ? data.mcpServers['thu-cloud'] : data.servers.find((s: any) => s.name === 'thu-cloud');
    expect(own).toMatchObject(entry); const removed = JSON.parse(mergeJson(installed, entry, format, true));
    expect(format === 'json' ? removed.mcpServers['thu-cloud'] : removed.servers.find((s: any) => s.name === 'thu-cloud')).toBeUndefined();
    expect(format === 'json' ? removed.mcpServers.other.command : removed.servers[0].name).toBe('other');
  });
  it.each([false, true])('refuses foreign ownership even when uninstall=%s', uninstall => {
    for (const [text, format] of [['{"mcpServers":{"thu-cloud":{"command":"foreign","args":[]}}}', 'json'], ['{"version":1,"servers":[{"name":"thu-cloud","args":["X:/foreign.js"]}]}', 'harness']] as const) expect(() => mergeJson(text, entry, format, uninstall)).toThrow(expect.objectContaining({ code: 'INSTALL_CONFLICT' }));
    expect(() => mergeToml('[mcp_servers.thu-cloud]\nargs=["X:/foreign.js"]\n', entry, uninstall)).toThrow(expect.objectContaining({ code: 'INSTALL_CONFLICT' }));
  });
  it('preserves owner env values and Harness custom enabled flags', () => {
    const text = JSON.stringify({ version: 1, servers: [{ name: 'thu-cloud', args: entry.args, env: { KEEP: 'yes', UNIT: 'old' }, enabled: false }] });
    const desired = JSON.parse(mergeJson(text, entry, 'harness', false)).servers[0]; expect(desired).toMatchObject({ enabled: false, env: { KEEP: 'yes', UNIT: '1' } });
  });
  it('preserves unrelated TOML byte ranges, nested tables and custom own timeouts', () => {
    const other = '# keep comment\n[mcp_servers.other]\ncommand="other"\n[mcp_servers.other.env]\nX="Y"\n';
    expect(mergeToml(other, entry, true)).toBe(other);
    const installed = mergeToml(other, entry, false); expect(installed).toContain(other.trimEnd()); expect(mergeToml(installed, entry, false)).toBe(installed);
    const custom = installed.replace('startup_timeout_sec = 30', 'startup_timeout_sec = 99');
    const updated = mergeToml(custom, { ...entry, command: 'node-changed' }, false); expect((parse(updated) as any).mcp_servers['thu-cloud']).toMatchObject({ startup_timeout_sec: 99, tool_timeout_sec: 120 });
    const removed = mergeToml(updated, entry, true); expect(removed).toContain(other); expect((parse(removed) as any).mcp_servers['thu-cloud']).toBeUndefined();
  });
  it('initializes empty formats without inventing preexisting owners', () => {
    expect(JSON.parse(mergeJson('', entry, 'harness', false))).toMatchObject({ version: 1, servers: [{ name: 'thu-cloud' }] });
    expect(JSON.parse(mergeJson('', entry, 'json', false))).toHaveProperty('mcpServers.thu-cloud');
    expect(() => mergeJson('{broken', entry, 'json', false)).toThrow(SyntaxError);
  });
});

describe('real installer transactions in owned synthetic client homes only', () => {
  async function homes(all = false) {
    const home = path.join(root, 'home'), harnessHome = path.join(root, 'harness'), stateDir = path.join(root, 'state');
    await fs.mkdir(home); if (all) { await fs.mkdir(path.join(home, '.gemini/antigravity'), { recursive: true }); await fs.writeFile(path.join(home, '.gemini/antigravity/mcp_config.json'), '{}'); await fs.mkdir(harnessHome); }
    return { home, harnessHome, stateDir };
  }
  it('previews all five detected clients, applies with backups, rechecks idempotence, and uninstalls only owned entries', async () => {
    const options = await homes(true); await fs.writeFile(path.join(options.home, '.claude.json'), '{"keep":true}');
    const preview = await installClients(options); expect(preview.clients).toHaveLength(5); expect(preview.clients.every(c => c.status === 'planned' && !c.applied)).toBe(true);
    expect(await fs.readFile(path.join(options.home, '.claude.json'), 'utf8')).toBe('{"keep":true}');
    const applied = await installClients({ ...options, apply: true }); expect(applied.clients.every(c => c.status === 'configured' && c.applied)).toBe(true);
    const claude = applied.clients.find(c => c.client === 'Claude Code')!; expect(await fs.readFile(claude.backup!, 'utf8')).toBe('{"keep":true}');
    expect(await readJson(path.join(options.stateDir, 'installation.json'))).toMatchObject({ action: 'install', apply: true });
    const same = await installClients({ ...options, apply: true }); expect(same.clients.every(c => c.status === 'unchanged' && !c.changed && !c.applied)).toBe(true);
    const removed = await installClients({ ...options, apply: true, uninstall: true }); expect(removed.clients.every(c => c.status === 'removed')).toBe(true);
    expect(await readJson(path.join(options.home, '.claude.json'))).toEqual({ keep: true, mcpServers: {} });
  });
  it('validates every target before mutating the first client', async () => {
    const options = await homes(); await fs.mkdir(path.join(options.home, '.codex')); await fs.writeFile(path.join(options.home, '.codex/config.toml'), '[broken');
    await expect(installClients({ ...options, apply: true })).rejects.toThrow();
    await expect(fs.readFile(path.join(options.home, '.claude.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readJson(path.join(options.stateDir, 'installation.json'))).resolves.toBeUndefined();
  });
  it('aborts on configuration changes between preview and locked write', async () => {
    const options = await homes(); const target = path.join(options.home, '.claude.json'); await fs.writeFile(target, '{}'); let reads = 0;
    vi.mocked(fs.readFile).mockImplementation(async (...args: any[]) => { if (args[0] === target && ++reads === 2) return '{"concurrent":true}' as any; return boundary.actualFs.readFile(...args); });
    await expect(installClients({ ...options, apply: true })).rejects.toMatchObject({ code: 'CONFIG_CHANGED' });
    expect(await boundary.actualFs.readFile(target, 'utf8')).toBe('{}'); expect((await fs.readdir(options.home)).filter(name => name.includes('backup'))).toEqual([]);
  });
  it('uninstall preview on absent configs does not create client files', async () => {
    const options = await homes(); const report = await installClients({ ...options, uninstall: true });
    expect(report.action).toBe('uninstall'); expect(report.clients.every(c => c.status === 'unchanged')).toBe(true); expect(await fs.readdir(options.home)).toEqual([]);
  });
});
