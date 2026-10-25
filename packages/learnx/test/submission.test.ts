import { expect, it } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SubmissionService } from '../src/submission.js';
import { MockClient } from '../src/mock-client.js';
import { LearnError } from '../src/types.js';
async function setup(fn: (s: SubmissionService, c: MockClient, file: string) => Promise<void>) {
  const root = await mkdtemp(path.join(tmpdir(), 'learnx-submit-')); const c = new MockClient(); const file = path.join(root, '报告.txt'); await writeFile(file, 'version 1');
  try { await fn(new SubmissionService(c, root), c, file); } finally { await rm(root, { recursive: true, force: true }); }
}
const target = { courseId: 'mock-course-1', homeworkId: 'mock-course-1-homework-1' };
it.each([4070880000000, '4070880000000'])('accepts the server Unix millisecond deadline %s', deadline => setup(async (s, c, file) => {
  const original = c.homework.bind(c);
  c.homework = async (...a) => ({ ...await original(...a), deadline });
  const prepared = await s.prepare({ ...target, filePath: file });
  expect((await s.submit(prepared.id)).status).toBe('submitted');
}));
it.each([946684800000, NaN, Infinity, 'not-a-date'])('rejects expired or invalid server deadlines %s', deadline => setup(async (s, c, file) => {
  const original = c.homework.bind(c);
  c.homework = async (...a) => ({ ...await original(...a), deadline });
  await expect(s.prepare({ ...target, filePath: file })).rejects.toBeInstanceOf(LearnError);
}));
it('accepts a numeric late deadline only when late submission is enabled', () => setup(async (s, c, file) => {
  const original = c.homework.bind(c);
  c.homework = async (...a) => ({ ...await original(...a), deadline: '2000-01-01 00:00:00', lateSubmissionDeadline: 4070880000000, raw: { isLateSubmission: true } });
  expect((await s.prepare({ ...target, filePath: file })).id).toBeTruthy();
}));
it('binds the exact file digest and refuses a changed file', () => setup(async (s, _c, file) => {
  const p = await s.prepare({ ...target, filePath: file }); await writeFile(file, 'version 2');
  await expect(s.submit(p.id)).rejects.toThrow(/文件.*变化/);
}));
it('submits only once for repeated calls and verifies remote metadata', () => setup(async (s, c, file) => {
  let calls = 0; const upload = c.submit.bind(c); c.submit = async (...a) => { calls++; await upload(...a); };
  const p = await s.prepare({ ...target, content: 'done', filePath: file });
  const result = await s.submit(p.id); expect(result.status).toBe('submitted');
  expect((await s.submit(p.id)).status).toBe('submitted'); expect(calls).toBe(1);
  expect((await s.get(target.courseId, target.homeworkId)).submittedAttachment?.name).toBe('报告.txt');
}));
it('does not replay an upload when the outcome is unknown', () => setup(async (s, c, file) => {
  let calls = 0; c.submit = async () => { calls++; throw new Error('timeout'); };
  const p = await s.prepare({ ...target, filePath: file });
  expect((await s.submit(p.id)).status).toBe('unknown');
  expect((await s.submit(p.id)).status).toBe('unknown'); expect(calls).toBe(1);
}));
it('recovers a successful timeout by reading the server instead of retrying', () => setup(async (s, c, file) => {
  const upload = c.submit.bind(c); c.submit = async (...a) => { await upload(...a); throw new Error('timeout'); };
  const p = await s.prepare({ ...target, content: 'done', filePath: file });
  expect((await s.submit(p.id)).status).toBe('submitted');
}));
it('requires explicit overwrite and rejects late, offline, group and wrong-ID submissions', () => setup(async (s, c, file) => {
  await c.submit(target.courseId, target.homeworkId, 'old');
  await expect(s.prepare({ ...target, filePath: file })).rejects.toThrow(/覆盖/);
  await expect(s.prepare({ ...target, homeworkId: 'teacher-base-id', filePath: file })).rejects.toThrow();
  const original = c.homework.bind(c);
  c.homework = async (...a) => ({ ...await original(...a), deadline: '2000-01-01 00:00:00' });
  await expect(s.prepare({ ...target, overwrite: true, filePath: file })).rejects.toThrow(/截止/);
  c.homework = async (...a) => ({ ...await original(...a), submissionType: 0 });
  await expect(s.prepare({ ...target, overwrite: true, filePath: file })).rejects.toThrow(/在线/);
  c.homework = async (...a) => ({ ...await original(...a), completionType: 2 });
  await expect(s.prepare({ ...target, overwrite: true, filePath: file })).rejects.toThrow(/小组/);
}));
it('rejects another prepared submission after remote state changes', () => setup(async (s, _c, file) => {
  const a = await s.prepare({ ...target, filePath: file }); const b = await s.prepare({ ...target, filePath: file });
  await s.submit(a.id); await expect(s.submit(b.id)).rejects.toThrow(/状态.*变化/);
}));
it('does not assume a late date grants permission for late submission', () => setup(async (s, c, file) => {
  const original = c.homework.bind(c);
  c.homework = async (...a) => ({ ...await original(...a), deadline: '2000-01-01 00:00:00', lateSubmissionDeadline: '2099-01-01 00:00:00', raw: { isLateSubmission: false } });
  await expect(s.prepare({ ...target, filePath: file })).rejects.toThrow(/截止/);
}));
it('reports an explicit server rejection as failed without replaying it', () => setup(async (s, c, file) => {
  let calls = 0; c.submit = async () => { calls++; throw new LearnError('SUBMISSION_REJECTED', '服务器明确拒绝提交'); };
  const p = await s.prepare({ ...target, filePath: file });
  expect((await s.submit(p.id)).status).toBe('failed'); expect((await s.submit(p.id)).status).toBe('failed'); expect(calls).toBe(1);
}));
