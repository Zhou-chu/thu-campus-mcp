import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import lockfile from 'proper-lockfile';
import { LearnError } from './types.js';
export const digest = (data: string | Uint8Array) => createHash('sha256').update(data).digest('hex');
export function safeSegment(input: string): string {
  let value = input.normalize('NFC').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/^[. ]+|[. ]+$/g, '').replace(/^_+/, '_');
  if (!value) value = '_';
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(value)) value = '_' + value;
  if (value.length > 72) value = value.slice(0, 59) + '__' + digest(input).slice(0, 11);
  return value;
}
export function stableName(title: string, id: string): string { return `${safeSegment(title).slice(0, 45)}__${digest(id).slice(0, 12)}`; }
function inside(root: string, target: string) { const relative = path.relative(root, target); return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative)); }
export async function guardedPath(root: string, relative: string): Promise<string> {
  const base = path.resolve(root), target = path.resolve(base, relative);
  if (!inside(base, target)) throw new LearnError('UNSAFE_PATH', '路径超出允许目录。');
  await mkdir(base, { recursive: true });
  const realBase = await realpath(base);
  let current = base;
  for (const segment of path.relative(base, target).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    try {
      const stat = await lstat(current);
      if (stat.isSymbolicLink() || !inside(realBase, await realpath(current))) throw new LearnError('UNSAFE_PATH', '输出路径包含链接或目录穿越。');
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  return target;
}
export async function atomicWrite(file: string, data: string | Uint8Array): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(temp, data, { mode: 0o600 });
    // Retry only an identical local atomic replacement while Windows readers release it.
    for (let attempt = 0; ; attempt++) {
      try { await rename(temp, file); break; }
      catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (process.platform !== 'win32' || !['EPERM', 'EACCES', 'EBUSY'].includes(code || '') || attempt >= 19) throw error;
        await new Promise(resolve => setTimeout(resolve, Math.min(10 * 2 ** attempt, 200)));
      }
    }
  }
  finally { await rm(temp, { force: true }); }
}
export async function atomicJson(file: string, data: unknown): Promise<void> { await atomicWrite(file, JSON.stringify(data, null, 2) + '\n'); }
export async function readJson<T = any>(file: string): Promise<T | undefined> {
  try { return JSON.parse(await readFile(file, 'utf8')) as T; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
}
export async function withLock<T>(directory: string, fn: () => Promise<T>): Promise<T> {
  await mkdir(directory, { recursive: true });
  const release = await lockfile.lock(directory, { stale: 120000, update: 10000, retries: { retries: 30, minTimeout: 50, maxTimeout: 1000 } });
  try { return await fn(); } finally { await release(); }
}
export function scrub<T>(data: T): T {
  return JSON.parse(JSON.stringify(data, (key, value) => {
    if (/password|cookie|csrf|fingerprint|fingergen|authorization|token/i.test(key)) return undefined;
    if (typeof value === 'string' && /^https?:\/\//i.test(value)) {
      const u = new URL(value); for (const k of [...u.searchParams.keys()]) if (/csrf|token|ticket|session/i.test(k)) u.searchParams.delete(k);
      return u.toString();
    }
    return typeof value === 'string' ? value.replace(/([?&]|&amp;)(?:_csrf|ticket|access_token|sessionid)=[^\s"'<>;&)\]]+(?:(&amp;|&))?/gi, (_match, prefix, next) => next ? prefix : '') : value;
  }));
}
