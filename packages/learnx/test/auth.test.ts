import { it, expect, vi } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { AuthStore } from '../src/auth.js';
import { RealClient } from '../src/client.js';
import { loadConfig } from '../src/config.js';
it('persists credentials protected and exposes only a redacted status', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'learnx-auth-'));
  try {
    const store = new AuthStore(dir);
    expect((await store.status()).configured).toBe(false);
    await store.save({ account: 'test-account', username: 'test-account', password: 'local-test-secret', fingerPrint: 'actual-fingerprint' });
    expect((await store.load())?.password).toBe('local-test-secret');
    expect(await readFile(store.file, 'utf8')).not.toContain('local-test-secret');
    const status = JSON.stringify(await store.status());
    expect(status).not.toContain('local-test-secret'); expect(status).not.toContain('actual-fingerprint');
    expect((await store.status()).configured).toBe(true);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
it('invalidates active clients after local logout or account switch', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'learnx-revoke-'));
  vi.stubGlobal('fetch', async () => Response.json({ message: 'success', result: { id: '2026-2027-1', xnxq: '2026-2027-1' } }));
  try {
    const store = new AuthStore(dir);
    const data = (account: string) => ({ account, cookieJar: { version: 'tough-cookie@4.1.4', storeType: 'MemoryCookieStore', rejectPublicSuffixes: true, cookies: [] }, csrfToken: 'local-test-token' });
    await store.save(data('A')); const client = new RealClient(loadConfig({ stateDir: dir }));
    await client.currentSemester(); const previousIdentity = client.identity;
    await store.clear(); await expect(client.currentSemester()).rejects.toThrow(/登录/);
    await store.save(data('B')); await client.currentSemester(); expect(client.identity).not.toBe(previousIdentity);
  } finally { vi.unstubAllGlobals(); await rm(dir, { recursive: true, force: true }); }
});
it('refuses to resurrect credentials when another process logged out or switched account', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'learnx-cas-'));
  try {
    const store = new AuthStore(dir); await store.save({ account: 'A', username: 'A', password: 'old' });
    const version = await store.version(); await store.clear();
    await expect(store.saveIfCurrent({ account: 'A', username: 'A', password: 'old' }, version!)).rejects.toThrow();
    expect(await store.load()).toBeUndefined();
  } finally { await rm(dir, { recursive: true, force: true }); }
});
