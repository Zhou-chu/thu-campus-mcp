import { randomUUID } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { atomicJson, digest, readJson, scrub, withLock } from './storage.js';
import { toMarkdown } from './detail.js';
import { LearnError, type Homework, type LearnClient } from './types.js';
export interface PrepareInput { courseId: string; homeworkId: string; semesterId?: string; content?: string; filePath?: string; overwrite?: boolean }
interface Prepared {
  id: string; accountId: string; courseId: string; courseName: string; homeworkId: string; title: string;
  semesterId: string; content: string; file?: { path: string; name: string; size: number; sha256: string };
  baseline: string; overwrite: boolean; expiresAt: string; status: 'prepared' | 'submitting' | 'submitted' | 'failed' | 'unknown';
  receipt?: Record<string, unknown>;
}
const canonical = (content: string | undefined) => toMarkdown(content || '').replace(/\s+/g, ' ').trim();
function stateOf(hw: Homework) { return digest(JSON.stringify([hw.submitted, hw.submitTime, hw.submittedContent, hw.submittedAttachment])); }
function deadlineMillis(date: string | number): number {
  // thu-learn-lib returns Unix milliseconds; mock/older records may contain dates.
  if (typeof date === 'number') return Number.isFinite(date) ? date : NaN;
  const value = date.trim();
  if (/^\d+$/.test(value)) return Number(value);
  return Date.parse(/(?:Z|[+-]\d{2}:?\d{2})$/.test(value) ? value : value.replace(' ', 'T') + '+08:00');
}
function checkHomework(hw: Homework) {
  if (hw.submissionType !== 2) throw new LearnError('SUBMISSION_TYPE', '该作业不支持普通网络学堂在线提交。');
  if (hw.completionType !== 1) throw new LearnError('GROUP_UNSUPPORTED', '小组作业需要验证成员与站点提交流程，首版不代为提交。');
  const deadline = hw.raw.isLateSubmission === true && hw.lateSubmissionDeadline ? hw.lateSubmissionDeadline : hw.deadline;
  if (!deadline || !Number.isFinite(deadlineMillis(deadline))) throw new LearnError('DEADLINE_UNKNOWN', '无法确认作业截止时间，未执行提交。');
  if (deadlineMillis(deadline) < Date.now()) throw new LearnError('DEADLINE_PASSED', '作业已过允许的提交截止时间。');
}
export class SubmissionService {
  constructor(private client: LearnClient, private stateDir: string) {}
  private file(id: string) {
    if (!/^[a-f0-9-]{36}$/.test(id)) throw new LearnError('INVALID_ID', '提交 ID 无效。');
    return path.join(this.stateDir, 'submissions', id + '.json');
  }
  async prepare(input: PrepareInput) {
    if (!input.content?.trim() && !input.filePath) throw new LearnError('EMPTY_SUBMISSION', '请明确指定提交正文或本机文件。');
    const semesterId = input.semesterId || (await this.client.currentSemester()).id;
    const course = (await this.client.courses(semesterId)).find(c => c.id === input.courseId);
    if (!course) throw new LearnError('NOT_FOUND', '指定学期内没有这门课程。');
    const hw = await this.client.homework(input.courseId, input.homeworkId); checkHomework(hw);
    if (hw.submitted && !input.overwrite) throw new LearnError('OVERWRITE_REQUIRED', '该作业已有提交；覆盖需要用户明确授权，并设置 overwrite=true。');
    let file: Prepared['file'];
    if (input.filePath) {
      if (!path.isAbsolute(input.filePath)) throw new LearnError('ABSOLUTE_PATH', '提交文件必须使用用户指定的绝对路径。');
      const info = await stat(input.filePath); if (!info.isFile() || info.size > 512 * 1024 * 1024) throw new LearnError('FILE_LIMIT', '提交文件必须为普通文件且不超过 512 MiB。');
      const bytes = await readFile(input.filePath); file = { path: path.resolve(input.filePath), name: path.basename(input.filePath), size: bytes.length, sha256: digest(bytes) };
    }
    const record: Prepared = {
      id: randomUUID(), accountId: this.client.identity, semesterId, courseId: course.id, courseName: course.name,
      homeworkId: hw.id, title: hw.title, content: input.content ?? (hw.submittedContent || ''), file,
      overwrite: Boolean(input.overwrite), baseline: stateOf(hw), expiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString(), status: 'prepared',
    };
    await atomicJson(this.file(record.id), record);
    return { id: record.id, course: course.name, homework: hw.title, content: record.content, attachment: file, overwrite: record.overwrite, expiresAt: record.expiresAt, next: '用户已明确授权该具体提交时调用 learn_submit_assignment；目标或覆盖授权不清楚时先询问。' };
  }
  async submit(id: string) {
    const file = this.file(id);
    return withLock(path.join(this.stateDir, 'submission-lock'), async () => {
      const record = await readJson<Prepared>(file);
      if (!record) throw new LearnError('NOT_FOUND', '找不到准备记录。');
      // Establish current identity before trusting any persistent receipt.
      const before = await this.client.homework(record.courseId, record.homeworkId);
      if (record.accountId !== this.client.identity) throw new LearnError('ACCOUNT_MISMATCH', '当前账号与准备提交的账号不同。');
      if (record.status !== 'prepared') return record.receipt || { id, status: 'unknown', message: '先前提交已开始，禁止自动重放；请查询远端状态。' };
      if (Date.parse(record.expiresAt) < Date.now()) throw new LearnError('PREPARATION_EXPIRED', '准备记录已过期，请重新准备。');
      checkHomework(before);
      if (stateOf(before) !== record.baseline) throw new LearnError('REMOTE_CHANGED', '作业提交状态已发生变化，请重新准备。');
      let attachment: { name: string; bytes: Uint8Array } | undefined;
      if (record.file) {
        const bytes = await readFile(record.file.path);
        if (digest(bytes) !== record.file.sha256) throw new LearnError('FILE_CHANGED', '准备后文件已发生变化，请重新准备。');
        attachment = { name: record.file.name, bytes };
      }
      record.status = 'submitting'; await atomicJson(file, record);
      let uploadAccepted = false, rejected = false;
      try { await this.client.submit(record.courseId, record.homeworkId, record.content, attachment); uploadAccepted = true; }
      catch (error) { rejected = error instanceof LearnError && error.code === 'SUBMISSION_REJECTED'; /* Never replay: read back even when the response was lost. */ }
      let after: Homework | undefined;
      try { after = await this.client.homework(record.courseId, record.homeworkId); } catch { /* unknown */ }
      const changed = after && stateOf(after) !== record.baseline;
      const bodyMatches = after && canonical(after.submittedContent) === canonical(record.content);
      const attachmentMatches = after && (!record.file || after.submittedAttachment?.name === record.file.name);
      const verified = Boolean(after?.submitted && changed && bodyMatches && attachmentMatches);
      record.status = verified ? 'submitted' : rejected ? 'failed' : 'unknown';
      record.receipt = {
        id, status: record.status, course: record.courseName, homework: record.title,
        checkedAt: new Date().toISOString(), uploadAccepted, verification: 'server-metadata',
        message: verified ? '服务器提交状态、正文和附件名称已回读核验。服务器未提供文件校验和，未声称核验远端文件字节。' : rejected ? '服务器明确拒绝本次提交，未自动重试。请核对作业要求或前往网站检查。' : '无法确认提交结果。未自动重试；请查询网络学堂，避免重复提交。',
        remote: after ? { submitted: after.submitted, submitTime: after.submitTime, attachmentName: after.submittedAttachment?.name } : undefined,
      };
      await atomicJson(file, record);
      await atomicJson(path.join(this.stateDir, 'receipts', id + '.json'), scrub(record.receipt));
      return record.receipt;
    });
  }
  async get(courseId: string, homeworkId: string) { return this.client.homework(courseId, homeworkId); }
}
