import { expect, it } from 'vitest';
import { readDetailPages } from '../src/detail.js';
import { SyncService, searchLocal } from '../src/sync.js';
import { MockClient } from '../src/mock-client.js';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
it('preserves the first discussion page after a subsequent page fails', async () => {
  const result = await readDetailPages(async url => {
    if (url.includes('page=2')) throw new Error('timeout');
    return new Response('<div class="discussion-content">已下载主帖</div><a rel="next" href="?page=2">下一页</a>');
  }, 'https://learn.tsinghua.edu.cn/discussion');
  expect(result.body).toContain('已下载主帖'); expect(result.html).toContain('已下载主帖'); expect(result.fetchFailed).toBe(true);
});
it('retains an existing discussion archive when a later fetch loses pages', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'learnx-discussion-')); const client = new MockClient();
  try {
    const original = client.contents.bind(client);
    client.contents = async (...a) => (await original(...a)).map(c => ({ ...c, body: '上次完整正文与所有回复' }));
    await new SyncService(client).run({ outputDir: root, sections: ['discussion'] });
    client.contents = async (...a) => (await original(...a)).map(c => ({ ...c, body: '', completeness: 'partial', detailFetchFailed: true }));
    const result = await new SyncService(client).run({ outputDir: root, sections: ['discussion'] });
    expect(result.status).toBe('partial'); expect((await searchLocal(root, '上次完整正文')).total).toBe(2);
  } finally { await rm(root, { recursive: true, force: true }); }
});
