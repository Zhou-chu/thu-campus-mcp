import { afterEach, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SyncService, searchLocal } from '../src/sync.js';
import { MockClient } from '../src/mock-client.js';
import { normalizeContent } from '../src/detail.js';
const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map(p => rm(p, { recursive: true, force: true }))); });
async function setup() { const root = await mkdtemp(path.join(tmpdir(), 'learnx-sync-')); dirs.push(root); return { root, client: new MockClient() }; }
it('archives six sections with attachments, skips identical downloads and repairs corrupted ones', async () => {
  const { root, client } = await setup(); let downloads = 0;
  const original = client.download.bind(client); client.download = async a => { downloads++; return original(a); };
  const sync = new SyncService(client); const a = await sync.run({ outputDir: root });
  expect(a.status).toBe('complete'); expect(a.courses).toBe(2); expect(downloads).toBe(6);
  const manifest = JSON.parse(await readFile(path.join(root, '2026-2027-1', 'manifest.json'), 'utf8'));
  const course = Object.values(manifest.courses)[0] as any;
  expect(Object.keys(course.sections)).toHaveLength(6);
  const attachment = Object.values(course.sections.homework.items)[0] as any;
  const file = path.join(root, '2026-2027-1', attachment.attachments[0].path);
  expect(await readFile(file, 'utf8')).toBe('mock attachment\n');
  await sync.run({ outputDir: root }); expect(downloads).toBe(6);
  await writeFile(file, 'broken'); await sync.run({ outputDir: root }); expect(downloads).toBe(7);
  expect((await searchLocal(root, '离线模拟')).total).toBeGreaterThan(0);
});
it('reports per-section failures and preserves prior data rather than treating failure as deletion', async () => {
  const { root, client } = await setup(); const sync = new SyncService(client);
  await sync.run({ outputDir: root }); const original = client.contents.bind(client);
  client.contents = async (id, kind) => { if (kind === 'file') throw new Error('offline'); return original(id, kind); };
  const result = await sync.run({ outputDir: root });
  expect(result.status).toBe('partial'); expect(result.errors).toHaveLength(2);
  const manifest = JSON.parse(await readFile(path.join(root, '2026-2027-1', 'manifest.json'), 'utf8'));
  const course = Object.values(manifest.courses)[0] as any;
  expect(Object.keys(course.sections.file.items)).toHaveLength(1);
});
it('keeps locally archived remote-deleted items and never clears user notes', async () => {
  const { root, client } = await setup(); const sync = new SyncService(client);
  await sync.run({ outputDir: root }); await writeFile(path.join(root, 'user-note.md'), '保留笔记');
  client.contents = async () => [];
  await sync.run({ outputDir: root });
  expect(await readFile(path.join(root, 'user-note.md'), 'utf8')).toBe('保留笔记');
  const manifest = JSON.parse(await readFile(path.join(root, '2026-2027-1', 'manifest.json'), 'utf8'));
  const course = Object.values(manifest.courses)[0] as any;
  expect((Object.values(course.sections.homework.items)[0] as any).remoteMissing).toBe(true);
});
it('does not persist session tokens in Markdown body', async () => {
  const { root, client } = await setup();
  const original = client.contents.bind(client);
  client.contents = async (...a) => (await original(...a)).map(c => ({ ...c, body: c.body + '\n[link](https://learn.tsinghua.edu.cn/file?_csrf=private-value&x=1)' }));
  await new SyncService(client).run({ outputDir: root });
  const found = await searchLocal(root, 'private-value'); expect(found.total).toBe(0);
});
it('downloads an inline diagram and rewrites Markdown and HTML to a local asset', async () => {
  const { root, client } = await setup();
  client.contents = async (courseId, kind) => [normalizeContent(courseId, kind, { id: 'diagram-homework', title: '图示题', description: '<img alt="电路图" src="/diagram.png?_csrf=private-image-token&amp;x=1">' })];
  await new SyncService(client).run({ outputDir: root, sections: ['homework'] });
  const manifest = JSON.parse(await readFile(path.join(root, '2026-2027-1', 'manifest.json'), 'utf8'));
  const saved: any = (Object.values((Object.values(manifest.courses)[0] as any).sections.homework.items))[0];
  expect(saved.attachments).toHaveLength(1);
  const directory = path.join(root, '2026-2027-1', saved.directory);
  const body = await readFile(path.join(directory, 'content.md'), 'utf8'); const html = await readFile(path.join(directory, 'source.html'), 'utf8');
  expect(body).toContain('![电路图](附件/diagram__'); expect(body).not.toContain('private-image-token');
  expect(html).toContain('src="附件/diagram__'); expect(html).not.toContain('private-image-token');
});
it('migrates a managed attachment name without downloading unchanged bytes again', async () => {
  const { root, client } = await setup(); let downloads = 0, renamed = false;
  const download = client.download.bind(client), contents = client.contents.bind(client);
  client.download = async a => { downloads++; return download(a); };
  client.contents = async (...a) => (await contents(...a)).map(c => ({ ...c, attachments: c.attachments.map(file => ({ ...file, name: renamed ? '课件.pptx' : '课件' })) }));
  const service = new SyncService(client); await service.run({ outputDir: root, sections: ['file'] });
  expect(downloads).toBe(2); renamed = true; await service.run({ outputDir: root, sections: ['file'] });
  expect(downloads).toBe(2);
  const manifest = JSON.parse(await readFile(path.join(root, '2026-2027-1', 'manifest.json'), 'utf8'));
  const item: any = Object.values((Object.values(manifest.courses)[0] as any).sections.file.items)[0];
  expect(item.attachments[0].path.endsWith('.pptx')).toBe(true);
});
