import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { atomicJson, readJson, safeSegment, guardedPath, withLock } from '../src/storage.js';
const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map(p => rm(p, { recursive: true, force: true }))); });
async function dir() { const p = await mkdtemp(path.join(tmpdir(), 'learnx-')); dirs.push(p); return p; }
describe('safe archive storage', () => {
  it('cleans Windows reserved names, traversal separators and trailing dots', () => {
    expect(safeSegment('CON')).toBe('_CON');
    expect(safeSegment('../电路:原理. ')).toBe('_电路_原理');
    expect(safeSegment('NUL.txt')).toBe('_NUL.txt');
    expect(safeSegment('a'.repeat(200)).length).toBeLessThanOrEqual(72);
  });
  it('writes complete JSON atomically', async () => {
    const p = path.join(await dir(), 'nested', 'state.json');
    await atomicJson(p, { title: '公告', n: 2 });
    expect(await readJson(p)).toEqual({ title: '公告', n: 2 });
    expect(JSON.parse(await readFile(p, 'utf8')).title).toBe('公告');
  });
  it('rejects lexical and junction escapes', async () => {
    const root = await dir(), outside = await dir();
    await expect(guardedPath(root, '../escape')).rejects.toThrow();
    await symlink(outside, path.join(root, 'link'), 'junction');
    await expect(guardedPath(root, 'link/file')).rejects.toThrow();
  });
  it('serializes shared state changes', async () => {
    const root = await dir(); let count = 0;
    await Promise.all(Array.from({ length: 4 }, () => withLock(root, async () => {
      const old = count; await new Promise(r => setTimeout(r, 15)); count = old + 1;
    })));
    expect(count).toBe(4);
  });
});
