import { expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { AuthStore } from '../src/auth.js';
import { RealClient } from '../src/client.js';
import { loadConfig } from '../src/config.js';
it('allows an actively streaming attachment to exceed the normal request deadline', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'learnx-slow-download-'));
  await new AuthStore(root).save({ account: 'download-test', cookieJar: { version: 'tough-cookie@4.1.4', storeType: 'MemoryCookieStore', rejectPublicSuffixes: true, cookies: [] }, csrfToken: 'local-test-token' });
  let timer: ReturnType<typeof setInterval> | undefined;
  vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => new Response(new ReadableStream({
    start(controller) {
      let count = 0;
      timer = setInterval(() => { controller.enqueue(new TextEncoder().encode('x')); count++; if (count === 10) { clearInterval(timer); controller.close(); } }, 20);
      init.signal?.addEventListener('abort', () => { clearInterval(timer); controller.error(new DOMException('aborted', 'AbortError')); }, { once: true });
    },
    cancel() { clearInterval(timer); },
  }), { headers: { 'content-type': 'application/octet-stream' } }));
  try {
    const client = new RealClient(loadConfig({ stateDir: root, requestTimeoutMs: 80 }));
    const bytes = await client.download({ id: 'slow', name: 'slow.bin', url: 'https://learn.tsinghua.edu.cn/slow' });
    expect(new TextDecoder().decode(bytes)).toBe('xxxxxxxxxx');
  } finally { clearInterval(timer); vi.unstubAllGlobals(); await rm(root, { recursive: true, force: true }); }
});
