import { expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { AuthStore } from '../src/auth.js';
import { RealClient } from '../src/client.js';
import { loadConfig } from '../src/config.js';

for (const active of [true, false]) {
  it(active
    ? 'allows an actively streaming attachment to exceed the normal request deadline'
    : 'still times out an attachment that makes no progress', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'learnx-slow-download-'));
    await new AuthStore(root).save({
      account: 'download-test',
      cookieJar: { version: 'tough-cookie@4.1.4', storeType: 'MemoryCookieStore', rejectPublicSuffixes: true, cookies: [] },
      csrfToken: 'local-test-token',
    });
    let timer: ReturnType<typeof setInterval> | undefined;
    let markStarted: () => void = () => {};
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    // Keep the 80ms production threshold under test, but do not depend on a busy
    // Windows worker scheduling real 20ms intervals on time.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
      const response = new Response(new ReadableStream({
        start(controller) {
          let count = 0;
          if (active) timer = setInterval(() => {
            controller.enqueue(new TextEncoder().encode('x'));
            if (++count === 10) { clearInterval(timer); controller.close(); }
          }, 20);
          init.signal?.addEventListener('abort', () => {
            clearInterval(timer);
            controller.error(new DOMException('aborted', 'AbortError'));
          }, { once: true });
        },
        cancel() { clearInterval(timer); },
      }), { headers: { 'content-type': 'application/octet-stream' } });
      markStarted();
      return response;
    });
    try {
      const client = new RealClient(loadConfig({ stateDir: root, requestTimeoutMs: 80 }));
      const outcome = client.download({ id: 'slow', name: 'slow.bin', url: 'https://learn.tsinghua.edu.cn/slow' })
        .then(value => ({ ok: true as const, value }), error => ({ ok: false as const, error }));
      await started;
      await vi.advanceTimersByTimeAsync(active ? 200 : 81);
      const result = await outcome;
      if (active) {
        if (!result.ok) throw result.error;
        expect(new TextDecoder().decode(result.value)).toBe('xxxxxxxxxx');
      } else {
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.error.code).toBe('DOWNLOAD_TIMEOUT');
      }
    } finally {
      clearInterval(timer);
      vi.useRealTimers();
      vi.unstubAllGlobals();
      await rm(root, { recursive: true, force: true });
    }
  });
}
