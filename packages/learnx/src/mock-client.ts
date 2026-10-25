import { digest } from './storage.js';
import { normalizeContent } from './detail.js';
import { kinds, LearnError, type LearnClient, type Content, type Homework, type Kind } from './types.js';
export class MockClient implements LearnClient {
  identity = 'mock-user';
  private uploads = new Map<string, { content: string; name?: string; time: string }>();
  async currentSemester() { return { id: '2026-2027-1' }; }
  async semesters() { return ['2026-2027-1']; }
  async courses(_semester: string) { return [{ id: 'mock-course-1', name: '示例电路原理', teacher: '示例教师' }, { id: 'mock-course-2', name: '示例信号与系统', teacher: '示例教师' }]; }
  async contents(courseId: string, kind: Kind): Promise<Content[]> {
    if (!courseId.startsWith('mock-course-')) throw new LearnError('NOT_FOUND', '课程不存在。');
    const file = { id: `${kind}-attachment`, name: kind === 'file' ? '课件.txt' : '附件.txt', downloadUrl: 'https://learn.tsinghua.edu.cn/mock/attachment' };
    const raw: Record<string, any> = { id: `${courseId}-${kind}-1`, title: `${kind === 'homework' ? '第三次作业' : kind === 'discussion' ? '课程交流' : kind === 'notification' ? '开课通知' : kind === 'file' ? '第一讲课件' : kind === 'question' ? '示例答疑' : '教学问卷'}`, content: '<p>这是离线模拟数据，不代表真实课程。</p>', publishTime: '2026-10-22 09:00:00' };
    if (kind === 'homework') Object.assign(raw, { submitted: false, deadline: '2099-12-31 23:59:59', submissionType: 2, completionType: 1, attachment: file, baseId: 'teacher-base-id' });
    if (kind === 'file') Object.assign(raw, { remoteFile: file, rawSize: 14, category: { id: 'lectures', title: '课件' } });
    if (kind === 'notification') raw.attachment = file;
    const upload = this.uploads.get(raw.id);
    if (upload) Object.assign(raw, { submitted: true, submittedContent: upload.content, submitTime: upload.time, submittedAttachment: upload.name ? { id: digest(upload.name), name: upload.name } : undefined });
    return [normalizeContent(courseId, kind, raw)];
  }
  async download(_attachment: unknown) { return new TextEncoder().encode('mock attachment\n'); }
  async homework(courseId: string, id: string): Promise<Homework> {
    const result = (await this.contents(courseId, 'homework')).find(h => h.id === id);
    if (!result) throw new LearnError('NOT_FOUND', '作业不存在。'); return result as Homework;
  }
  async submit(courseId: string, id: string, content: string, attachment?: { name: string; bytes: Uint8Array }) {
    await this.homework(courseId, id); this.uploads.set(id, { content, name: attachment?.name, time: new Date().toISOString() });
  }
}
