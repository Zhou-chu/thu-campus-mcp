import { expect, it } from 'vitest';
import { extractDetail, validateDownload, normalizeContent } from '../src/detail.js';
import { createClient } from '../src/client.js';
import { loadConfig } from '../src/config.js';
it('extracts content and reply text while excluding scripts and navigation', () => {
  const d = extractDetail('<nav>导航</nav><div class="discussion-content"><p>主帖</p><script>bad()</script></div><div class="reply-content">回答</div><a rel="next" href="?page=2">下一页</a>', 'https://learn.tsinghua.edu.cn/thread');
  expect(d.html).toContain('主帖'); expect(d.html).toContain('回答'); expect(d.html).not.toContain('bad()'); expect(d.html).not.toContain('导航');
  expect(d.next).toBe('https://learn.tsinghua.edu.cn/thread?page=2');
  expect(d.completeness).toBe('partial');
});
it('rejects login HTML instead of reporting content or a successful file download', () => {
  const html = '<html><form action="/login"><input name="i_user"><input type="password" name="i_pass"></form></html>';
  expect(() => extractDetail(html, 'https://learn.tsinghua.edu.cn/login')).toThrow();
  expect(() => validateDownload(new TextEncoder().encode(html), 'text/html', 'report.pdf')).toThrow();
});
it('preserves student homework ID instead of the teacher base ID', () => {
  const c = normalizeContent('course-1', 'homework', { id: 'student-42', baseId: 'teacher-9', title: '作业', description: '<p>要求</p>', submitted: false, deadline: '2099-01-01 00:00:00', attachment: { id: 'a', name: '要求.pdf', downloadUrl: 'https://learn.tsinghua.edu.cn/a' } });
  expect(c.id).toBe('student-42'); expect(c.attachments[0].name).toBe('要求.pdf'); expect(c.body).toContain('要求');
});
it('discovers inline images and attachment links needed for offline reading', () => {
  const c = normalizeContent('c', 'homework', { id: 'h', title: '电路图', url: 'https://learn.tsinghua.edu.cn/f/task', description: '<p>分析此图</p><img src="/diagram.png?_csrf=secret"><a href="/b/file/downloadFile?wjid=abc">补充数据</a>' });
  expect(c.attachments).toHaveLength(2);
  expect(c.attachments.some(a => a.url.includes('diagram.png'))).toBe(true);
  expect(c.attachments.some(a => a.url.includes('downloadFile'))).toBe(true);
});
it('retains MathJax formula source while stripping active scripts', () => {
  const c = normalizeContent('c', 'homework', { id: 'h', title: '公式题', description: '<script type="math/tex; mode=display">v=L\\frac{di}{dt}</script><script>alert(1)</script>' });
  expect(c.body).toContain('v=L'); expect(c.body).toContain('frac'); expect(c.html).not.toContain('alert(1)');
});
it('uses the declared file type when a course-file title lacks its extension', () => {
  const item = normalizeContent('c', 'file', { id: 'f', title: '1.绪论', fileType: 'pptx', remoteFile: { id: 'a', name: '1.绪论', downloadUrl: 'https://learn.tsinghua.edu.cn/file' } });
  expect(item.attachments[0].name).toBe('1.绪论.pptx');
});
it('starts mock without credentials and supports a verifiable upload', async () => {
  const client = await createClient(loadConfig({ mock: true }));
  const semester = await client.currentSemester(); const courses = await client.courses(semester.id);
  const hw = (await client.contents(courses[0].id, 'homework'))[0];
  await client.submit(courses[0].id, hw.id, '已完成', { name: 'report.txt', bytes: new TextEncoder().encode('data') });
  const result = await client.homework(courses[0].id, hw.id);
  expect(result.submitted).toBe(true); expect(result.submittedAttachment?.name).toBe('report.txt');
});
