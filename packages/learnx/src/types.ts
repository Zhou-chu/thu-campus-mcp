export const kinds = ['notification', 'homework', 'file', 'discussion', 'question', 'questionnaire'] as const;
export type Kind = typeof kinds[number];
export const labels: Record<Kind, string> = { notification: '公告', homework: '作业', file: '课程文件', discussion: '课程讨论', question: '课程答疑', questionnaire: '课程问卷' };
export type Completeness = 'complete' | 'partial' | 'unsupported';
export interface Course { id: string; name: string; teacher?: string; [key: string]: unknown }
export interface Attachment { id: string; name: string; url: string; revision?: string; size?: number; role?: string; source?: string }
export interface Content {
  id: string; courseId: string; kind: Kind; title: string; body: string; html?: string;
  url?: string; revision: string; attachments: Attachment[]; completeness: Completeness;
  warnings?: string[]; raw: Record<string, any>;
  detailFetchFailed?: boolean;
}
export interface Homework extends Content {
  kind: 'homework'; submitted: boolean; submittedContent?: string; submittedAttachment?: { name: string; id?: string };
  submitTime?: string; deadline?: string | number; lateSubmissionDeadline?: string | number; submissionType?: number; completionType?: number;
}
export interface LearnClient {
  identity: string;
  currentSemester(): Promise<{ id: string }>;
  semesters(): Promise<string[]>;
  courses(semesterId: string): Promise<Course[]>;
  contents(courseId: string, kind: Kind): Promise<Content[]>;
  download(attachment: Attachment): Promise<Uint8Array>;
  homework(courseId: string, id: string): Promise<Homework>;
  submit(courseId: string, id: string, content: string, attachment?: { name: string; bytes: Uint8Array }): Promise<void>;
}
export class LearnError extends Error {
  constructor(public code: string, message: string) { super(message); this.name = 'LearnError'; }
}
export function publicError(error: unknown): { code: string; message: string } {
  if (error instanceof LearnError) return { code: error.code, message: error.message };
  const code = (error as { code?: string })?.code;
  return { code: code === 'ENOENT' ? 'NOT_FOUND' : 'OPERATION_FAILED', message: code === 'ENOENT' ? '本地文件不存在。' : '操作失败；请检查网络、会话及本地配置后重试。诊断不会输出凭据。' };
}
