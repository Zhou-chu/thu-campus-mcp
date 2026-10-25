import path from 'node:path';
import { readFile, readdir, mkdir, rename } from 'node:fs/promises';
import { atomicJson, atomicWrite, digest, guardedPath, readJson, safeSegment, scrub, stableName, withLock } from './storage.js';
import { kinds, labels, LearnError, publicError, type Content, type Kind, type LearnClient } from './types.js';

interface SavedAttachment { id: string; path: string; sha256: string; size: number; revision: string }
interface SavedItem { id: string; title: string; directory: string; revision: string; completeness: string; attachments: SavedAttachment[]; remoteMissing?: boolean }
interface SavedSection { status: string; items: Record<string, SavedItem>; error?: ReturnType<typeof publicError> }
interface SavedCourse { id: string; name: string; directory: string; sections: Partial<Record<Kind, SavedSection>> }
interface Manifest { version: 1; accountId: string; semesterId: string; updatedAt: string; courses: Record<string, SavedCourse> }
export interface SyncOptions { outputDir: string; semesterId?: string; courseId?: string; sections?: Kind[] }
export interface SyncResult { status: 'complete' | 'partial'; semesterId: string; directory: string; courses: number; added: number; updated: number; skipped: number; errors: { courseId: string; kind: string; code: string; message: string }[] }
export class SyncService {
  constructor(private client: LearnClient) {}
  async run(options: SyncOptions, progress?: (info: unknown) => Promise<void>): Promise<SyncResult> {
    const semesterId = options.semesterId || (await this.client.currentSemester()).id;
    const courses = (await this.client.courses(semesterId)).filter(c => !options.courseId || c.id === options.courseId);
    if (options.courseId && !courses.length) throw new LearnError('NOT_FOUND', '该学期内找不到指定课程。');
    const root = await guardedPath(options.outputDir, safeSegment(semesterId)); await mkdir(root, { recursive: true });
    return withLock(root, async () => {
      const file = await guardedPath(root, 'manifest.json');
      const previous = await readJson<Manifest>(file);
      if (previous && previous.accountId !== this.client.identity) throw new LearnError('ACCOUNT_MISMATCH', '该目录属于另一账号，请换一个输出目录。');
      const manifest: Manifest = previous || { version: 1, accountId: this.client.identity, semesterId, updatedAt: '', courses: {} };
      const report: SyncResult = { status: 'complete', semesterId, directory: root, courses: courses.length, added: 0, updated: 0, skipped: 0, errors: [] };
      for (const course of courses) {
        const saved: SavedCourse = manifest.courses[course.id] || { id: course.id, name: course.name, directory: stableName(course.name, course.id), sections: {} };
        saved.name = course.name; manifest.courses[course.id] = saved;
        const coursePath = await guardedPath(root, saved.directory); await mkdir(coursePath, { recursive: true });
        await atomicJson(await guardedPath(root, path.join(saved.directory, 'course.json')), scrub(course));
        for (const kind of options.sections || [...kinds]) {
          const old = saved.sections[kind];
          const sectionPath = path.join(saved.directory, labels[kind]);
          await mkdir(await guardedPath(root, sectionPath), { recursive: true });
          try {
            const contents = await this.client.contents(course.id, kind);
            if (this.client.identity !== manifest.accountId) throw new LearnError('ACCOUNT_MISMATCH', '同步期间账号变化，已停止写入该账号的新内容。');
            const section: SavedSection = { status: 'complete', items: { ...old?.items } };
            const seen = new Set<string>();
            for (const content of contents) {
              seen.add(content.id);
              try {
                const result = await this.saveContent(root, sectionPath, content, old?.items[content.id], manifest.accountId);
                section.items[content.id] = result.item;
                report[result.change]++;
                if (content.completeness !== 'complete') section.status = 'partial';
              } catch (error) {
                section.status = 'partial'; report.errors.push({ courseId: course.id, kind, ...publicError(error) });
              }
            }
            for (const id of Object.keys(section.items)) if (!seen.has(id)) section.items[id] = { ...section.items[id], remoteMissing: true };
            saved.sections[kind] = section;
            if (section.status !== 'complete') report.status = 'partial';
          } catch (error) {
            saved.sections[kind] = { status: 'failed', items: old?.items || {}, error: publicError(error) };
            report.errors.push({ courseId: course.id, kind, ...publicError(error) }); report.status = 'partial';
          }
          manifest.updatedAt = new Date().toISOString(); await atomicJson(file, scrub(manifest));
          await progress?.({ course: course.name, courseId: course.id, section: labels[kind], ...report });
        }
      }
      const index = [`# ${semesterId} 课程归档`, '', `同步时间：${manifest.updatedAt}`, `本次状态：${report.status}`, '', ...Object.values(manifest.courses).map(c => `- [${c.name}](${c.directory}/course.json)`), '', '以 manifest.json 中的专栏状态与 completeness 为准；partial 不代表完整抓取。'].join('\n');
      await atomicWrite(await guardedPath(root, 'index.md'), index);
      return report;
    });
  }
  private async saveContent(root: string, section: string, content: Content, old: SavedItem | undefined, accountId: string) {
    if (old && content.detailFetchFailed) {
      await atomicJson(await guardedPath(root, path.join(old.directory, 'last-attempt.json')), { status: 'partial', time: new Date().toISOString(), warnings: content.warnings });
      return { item: { ...old, completeness: 'partial' }, change: 'skipped' as const };
    }
    const category = content.kind === 'file' && content.raw.category ? stableName(String(content.raw.category.title), String(content.raw.category.id)) : '';
    const directory = old?.directory || path.join(section, category, stableName(content.title, content.id));
    await mkdir(await guardedPath(root, directory), { recursive: true });
    const attachments: SavedAttachment[] = []; let changed = !old || old.revision !== content.revision;
    let body = content.body, html = content.html || '';
    for (const attachment of content.attachments) {
      const ext = path.extname(attachment.name).replace(/[^.a-zA-Z0-9]/g, '').slice(0, 16);
      const localName = stableName(path.basename(attachment.name, path.extname(attachment.name)), attachment.id) + ext;
      const relative = path.join(directory, '附件', localName); const absolute = await guardedPath(root, relative);
      const prior = old?.attachments.find(a => a.id === attachment.id);
      let hash = '', size = 0, valid = false;
      if (prior && prior.revision === (attachment.revision || content.revision)) {
        for (const candidate of [...new Set([relative, prior.path])]) {
          const existing = await guardedPath(root, candidate);
          try { const bytes = await readFile(existing); hash = digest(bytes); size = bytes.length; valid = hash === prior.sha256; } catch { /* try previous managed path or re-download */ }
          if (valid) {
            if (candidate !== relative) { await mkdir(path.dirname(absolute), { recursive: true }); await rename(existing, absolute); changed = true; }
            break;
          }
        }
      }
      if (!valid) {
        const bytes = await this.client.download(attachment);
        if (this.client.identity !== accountId) throw new LearnError('ACCOUNT_MISMATCH', '附件下载期间账号变化，未写入新文件。');
        if (attachment.size !== undefined && bytes.length !== attachment.size) throw new LearnError('DOWNLOAD_SIZE', '附件大小与服务器声明不符，未覆盖已有文件。');
        hash = digest(bytes); size = bytes.length; await atomicWrite(absolute, bytes); changed = true;
      }
      attachments.push({ id: attachment.id, path: relative, sha256: hash, size, revision: attachment.revision || content.revision });
      for (const value of [attachment.url, scrub({ url: attachment.url }).url, attachment.source, attachment.source ? scrub({ text: attachment.source }).text : undefined].filter(Boolean) as string[]) {
        body = body.split(value).join(`附件/${localName}`); html = html.split(value).join(`附件/${localName}`);
      }
      body += `\n\n- 附件 [${attachment.name}](附件/${localName})`;
    }
    const text = `# ${content.title}\n\n完整性：${content.completeness}\n${(content.warnings || []).map(w => `> ${w}`).join('\n')}\n\n${body}\n`;
    await atomicWrite(await guardedPath(root, path.join(directory, 'content.md')), scrub({ text }).text);
    if (content.html) await atomicWrite(await guardedPath(root, path.join(directory, 'source.html')), scrub({ html }).html);
    await atomicJson(await guardedPath(root, path.join(directory, 'metadata.json')), scrub(content));
    return { item: { id: content.id, title: content.title, directory, revision: content.revision, completeness: content.completeness, attachments } as SavedItem, change: !old ? 'added' as const : changed ? 'updated' as const : 'skipped' as const };
  }
}
export async function searchLocal(root: string, query: string, offset = 0, limit = 20) {
  const hits: { path: string; excerpt: string }[] = []; let scanned = 0;
  async function walk(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (scanned >= 20000) return;
      if (entry.isSymbolicLink() || entry.name.startsWith('.')) continue;
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) await walk(file);
      else if (entry.name === 'content.md') {
        scanned++; const text = await readFile(file, 'utf8'); const index = text.toLocaleLowerCase().indexOf(query.toLocaleLowerCase());
        if (index >= 0) hits.push({ path: file, excerpt: text.slice(Math.max(0, index - 80), index + 200) });
      }
    }
  }
  try { await walk(path.resolve(root)); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  return { total: hits.length, offset, items: hits.slice(offset, offset + limit), truncated: scanned >= 20000 };
}
