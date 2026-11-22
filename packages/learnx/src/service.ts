/**
 * 网络学堂服务注册表：工具定义与调用的唯一来源。
 *
 * MCP 服务器（server.ts）与独立应用（lib/app/host.mjs）都从这里取工具，
 * 应用内直接调用本模块，不再经过 stdio MCP 进程与两层 JSON 序列化。
 * 外部 MCP 客户端看到的工具面保持不变。
 */
import { z } from 'zod';
import { learnStatus } from './status.js';
import { createClient } from './client.js';
import { type Config } from './config.js';
import { kinds, labels, LearnError, publicError, type Content } from './types.js';
import { scrub } from './storage.js';
import { getJob, startJob } from './jobs.js';
import { searchLocal } from './sync.js';
import { SubmissionService } from './submission.js';

const id = z.string().min(1).max(256);
const page = { offset: z.number().int().min(0).default(0), limit: z.number().int().min(1).max(100).default(20) };
const semester = { semesterId: id.optional() };
const course = { courseId: id };
const kind = z.enum(kinds);

function paginate<T>(items: T[], offset: number, limit: number) {
  return { total: items.length, offset, items: items.slice(offset, offset + limit), nextOffset: offset + limit < items.length ? offset + limit : undefined };
}
function summary(c: Content) {
  return { id: c.id, courseId: c.courseId, kind: c.kind, title: c.title, completeness: c.completeness, warnings: c.warnings, submitted: c.raw.submitted, deadline: c.raw.deadline, submitTime: c.raw.submitTime, attachmentNames: c.attachments.map(a => a.name) };
}

export type ServiceTool = {
  name: string;
  description: string;
  shape: z.ZodRawShape;
  jsonSchema: () => unknown;
  readOnly: boolean;
  destructive?: boolean;
  run: (args: any) => Promise<unknown>;
};

export type ServiceCall = { ok: true; data: unknown; image?: { data: string; mimeType: string } } | { ok: false; error: { code?: string; message?: string } };

export async function createService(config: Config) {
  const client = await createClient(config);
  const submissions = new SubmissionService(client, config.stateDir);
  const tools: ServiceTool[] = [];

  const tool = (name: string, description: string, shape: z.ZodRawShape, run: (args: any) => Promise<unknown>, readOnly = true, destructive = false) => {
    tools.push({ name, description, shape, jsonSchema: () => z.toJSONSchema(z.object(shape), { io: "input", unrepresentable: "any" }), readOnly, destructive, run });
  };

  tool('learn_status', '只读验证已有网络学堂会话；verify=false仅查本地配置，不自动登录，不返回身份、Cookie或指纹。', { verify: z.boolean().default(true) }, async a => ({
    ...await learnStatus(config, { verify: a.verify }),
    sections: kinds.map(k => ({ kind: k, name: labels[k], completeness: ['discussion', 'question'].includes(k) ? 'partial-until-site-verified' : 'requires-live-verification' })),
    authCommand: 'node dist/cli.js auth login 或 auth import；在本机终端执行。',
  }));
  tool('learn_list_semesters', '查询网络学堂当前学期和账号可访问学期。', {}, async () => ({ current: await client.currentSemester(), semesters: await client.semesters() }));
  tool('learn_list_courses', '列出指定学期课程，可按中文名称或教师搜索；返回稳定课程 ID。', { ...semester, ...page, query: z.string().max(200).optional() }, async a => {
    const sid = a.semesterId || (await client.currentSemester()).id;
    const courses = (await client.courses(sid)).filter(c => !a.query || `${c.name} ${c.teacher || ''}`.toLowerCase().includes(a.query.toLowerCase()));
    return { semesterId: sid, ...paginate(courses, a.offset, a.limit) };
  });
  tool('learn_list_contents', '分页列出一门课某专栏的内容摘要，详情用 learn_get_content。', { ...course, kind, ...page }, async a => paginate((await client.contents(a.courseId, a.kind)).map(summary), a.offset, a.limit));
  tool('learn_get_content', '读取公告、作业、课程文件、讨论、答疑或问卷正文及附件信息。partial 表示不完整。', { ...course, kind, id, maxChars: z.number().int().min(100).max(40000).default(12000) }, async a => {
    const item = (await client.contents(a.courseId, a.kind)).find(c => c.id === a.id);
    if (!item) throw new LearnError('NOT_FOUND', '该课程专栏中找不到指定内容。');
    return { ...summary(item), body: item.body.slice(0, a.maxChars), truncated: item.body.length > a.maxChars, attachments: item.attachments, url: item.url };
  });
  const syncShape = { ...semester, outputDir: z.string().max(1024).optional(), sections: z.array(kind).min(1).max(6).optional() };
  tool('learn_sync_semester', '后台增量同步本学期全部课程到指定绝对目录；返回任务 ID，使用 learn_sync_status 查询结果。', syncShape, async a => startJob(config, { ...a, outputDir: a.outputDir || config.outputDir }), false);
  tool('learn_sync_course', '后台增量同步指定课程及可选专栏；保留本地已有文件。', { ...syncShape, ...course }, async a => startJob(config, { ...a, outputDir: a.outputDir || config.outputDir }), false);
  tool('learn_sync_status', '查询后台同步进度、成功/失败状态及各专栏完整性。', { jobId: z.string().uuid() }, async a => getJob(config, a.jobId));
  tool('learn_search_local', '搜索已下载的课程正文，返回本机文件路径与摘要。', { query: z.string().min(1).max(200), outputDir: z.string().max(1024).optional(), ...page }, async a => searchLocal(a.outputDir || config.outputDir, a.query, a.offset, a.limit));
  tool('learn_list_assignments', '查询作业期限、要求摘要、提交与批改状态；可限定课程或只看未交。', { ...semester, courseId: id.optional(), pendingOnly: z.boolean().default(false), ...page }, async a => {
    const sid = a.semesterId || (await client.currentSemester()).id;
    const courses = (await client.courses(sid)).filter(c => !a.courseId || c.id === a.courseId);
    const items = []; const errors = [];
    for (const c of courses) { try { for (const h of await client.contents(c.id, 'homework')) if (!a.pendingOnly || !h.raw.submitted) items.push({ ...summary(h), course: c.name, grade: h.raw.grade, gradeLevel: h.raw.gradeLevel }); } catch (error) { errors.push({ courseId: c.id, ...publicError(error) }); } }
    return { ...paginate(items, a.offset, a.limit), errors };
  });
  tool('learn_prepare_submission', '准备提交但不上传：校验用户指定的本机绝对文件路径和正文，固定 SHA-256、课程与学生作业 ID，15 分钟有效。已有提交的覆盖需用户授权。', { ...semester, ...course, homeworkId: id, content: z.string().max(200000).optional(), filePath: z.string().max(1024).optional(), overwrite: z.boolean().default(false) }, async a => submissions.prepare(a), false);
  tool('learn_submit_assignment', '将准备 ID 绑定的正文与文件上传到明确作业并回读核验。仅在用户明确授权该具体提交后调用；unknown 不自动重试。', { preparationId: z.string().uuid() }, async a => submissions.submit(a.preparationId), false, true);
  tool('learn_get_submission', '回读作业的服务器提交状态、正文、附件和批改信息，用于核验或处理结果不明的上传。', { ...course, homeworkId: id, maxChars: z.number().int().min(100).max(20000).default(8000) }, async a => {
    const h = await submissions.get(a.courseId, a.homeworkId);
    return { ...summary(h), submittedContent: h.submittedContent?.slice(0, a.maxChars), submittedAttachment: h.submittedAttachment, grade: h.raw.grade, gradeContent: h.raw.gradeContent?.slice(0, a.maxChars) };
  });

  const byName = new Map(tools.map(item => [item.name, item]));

  return {
    tools,
    async call(name: string, args: Record<string, unknown> = {}): Promise<ServiceCall> {
      const entry = byName.get(name);
      if (!entry) return { ok: false, error: { code: 'UNKNOWN_TOOL', message: '没有这个网络学堂工具。' } };
      try {
        const data = scrub(await entry.run(args ?? {}));
        return { ok: true, data };
      } catch (error) {
        return { ok: false, error: publicError(error) as { code?: string; message?: string } };
      }
    },
  };
}

export type LearnxService = Awaited<ReturnType<typeof createService>>;