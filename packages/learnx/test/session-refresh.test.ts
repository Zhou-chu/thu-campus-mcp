import { expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { AuthStore } from '../src/auth.js';
import { RealClient } from '../src/client.js';
import { MockClient } from '../src/mock-client.js';
import { loadConfig } from '../src/config.js';

async function setup(fn: (client: RealClient, store: AuthStore) => Promise<void>) {
  const root = await mkdtemp(path.join(tmpdir(), 'learnx-refresh-'));
  const store = new AuthStore(root);
  await store.save({ account: 'refresh-test', cookieJar: { version: 'tough-cookie@4.1.4', storeType: 'MemoryCookieStore', rejectPublicSuffixes: true, cookies: [] }, csrfToken: 'old-token' });
  try { await fn(new RealClient(loadConfig({ stateDir: root })), store); }
  finally { vi.unstubAllGlobals(); await rm(root, { recursive: true, force: true }); }
}

it('refreshes a rotated CSRF token on readback without replaying an accepted upload', () => setup(async (client, store) => {
  let uploads = 0, reads = 0, pages = 0;
  vi.stubGlobal('fetch', async (url: string) => {
    const u = new URL(url);
    if (u.pathname.endsWith('/tjzy')) { uploads++; return Response.json({ result: 'success' }); }
    if (u.pathname === '/f/wlxt/index/course/student/') { pages++; return new Response('<meta name="_csrf" content="new-token"><title>课程</title>'); }
    reads++;
    return u.searchParams.get('_csrf') === 'new-token'
      ? Response.json({ message: 'success', result: { id: '2026-2027-1', xnxq: '2026-2027-1' } })
      : new Response('CSRF expired', { status: 403 });
  });
  client.homework = async () => new MockClient().homework('mock-course-1', 'mock-course-1-homework-1');
  await client.submit('c', 'h', 'done');
  expect((await client.currentSemester()).id).toBe('2026-2027-1');
  expect({ uploads, reads, pages }).toEqual({ uploads: 1, reads: 2, pages: 1 });
  expect((await store.load())?.csrfToken).toBe('new-token');
}));

it('does not treat a login page as an authenticated token refresh', () => setup(async (client, store) => {
  vi.stubGlobal('fetch', async (url: string) => new URL(url).pathname.startsWith('/f/')
    ? new Response('<meta name="_csrf" content="login-token"><input type="password">')
    : new Response('expired', { status: 403 }));
  await expect(client.currentSemester()).rejects.toThrow(/会话.*失效/);
  expect((await store.load())?.csrfToken).toBe('old-token');
}));

it('cannot restore a refreshed session after another process logs out', () => setup(async (client, store) => {
  vi.stubGlobal('fetch', async (url: string) => {
    if (new URL(url).pathname.startsWith('/f/')) {
      await store.clear();
      return new Response('<meta name="_csrf" content="new-token">');
    }
    return new Response('expired', { status: 403 });
  });
  await expect(client.currentSemester()).rejects.toThrow(/认证已变化/);
  expect(await store.load()).toBeUndefined();
}));
