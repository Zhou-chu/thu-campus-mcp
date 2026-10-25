import * as cheerio from 'cheerio';
import TurndownService from 'turndown';
import { digest, scrub } from './storage.js';
import { LearnError, type Content, type Kind, type Attachment } from './types.js';
const markdown = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced' });
markdown.addRule('learnx-math', { filter: node => node.nodeName === 'SPAN' && node.getAttribute('class') === 'learnx-math', replacement: (_content, node) => (node as HTMLElement).getAttribute('data-display') === 'block' ? `\n\n$$\n${node.textContent}\n$$\n\n` : `$${node.textContent}$` });
export const toMarkdown = (html: string) => markdown.turndown(html);
export function sanitizedHtml(source: string): string {
  const $ = cheerio.load(source, undefined, false);
  $('script').each((_, el) => {
    if (/^math\/tex/i.test($(el).attr('type') || '')) $(el).replaceWith($('<span class="learnx-math">').attr('data-display', /mode\s*=\s*display/i.test($(el).attr('type') || '') ? 'block' : 'inline').text($(el).text()));
  });
  $('script,form,input,meta,link[rel="stylesheet"]').remove();
  $('*').each((_, el) => { if ('attribs' in el) for (const attr of Object.keys(el.attribs || {})) if (/^on/i.test(attr)) $(el).removeAttr(attr); });
  return scrub({ html: $.html() }).html;
}
export function inlineResources(source: string, baseUrl: string) {
  const $ = cheerio.load(source); const attachments: Attachment[] = []; const warnings: string[] = []; const seen = new Set<string>();
  $('img[src],audio[src],video[src],source[src],a[href]').each((_, element) => {
    const el = $(element); const value = el.attr('src') || el.attr('href'); if (!value || /^(data:|#)/i.test(value)) return;
    if (element.tagName === 'a' && !/(?:download|\.(?:pdf|docx?|xlsx?|pptx?|zip|rar|7z|txt|csv|png|jpg|jpeg|gif|svg|mp4|mp3|mat|m|slx)(?:[?#]|$))/i.test(value)) return;
    let url: URL; try { url = new URL(value, baseUrl); } catch { warnings.push('有无法解析的内嵌资源。'); return; }
    if (url.protocol !== 'https:' || url.hostname !== 'learn.tsinghua.edu.cn') { warnings.push('存在外部内嵌资源，未跨站下载。'); return; }
    const canonical = scrub({ url: url.toString() }).url;
    if (seen.has(canonical)) return; seen.add(canonical);
    const filename = decodeURIComponent(url.pathname.split('/').pop() || 'inline-resource');
    attachments.push({ id: 'inline-' + digest(canonical), name: filename, url: url.toString(), role: 'inline', source: value } as Attachment);
  });
  if ($('img[srcset],source[srcset]').length) warnings.push('响应式图片 srcset 需要站点验证，已保留原始标记。');
  return { attachments, warnings };
}
export function isLoginHtml(html: string) { return /<input[^>]+(?:type=["']?password|name=["']?(?:i_pass|i_user))/i.test(html) || /(?:login_timeout|统一身份认证|用户登录)[\s\S]{0,200}(?:登录|password)/i.test(html); }
export function validateDownload(bytes: Uint8Array, contentType: string, name: string) {
  const head = new TextDecoder().decode(bytes.slice(0, 8192));
  if (isLoginHtml(head) || ((/text\/html/i.test(contentType) || /^\s*<!doctype html/i.test(head)) && !/\.html?$/i.test(name))) throw new LearnError('INVALID_DOWNLOAD', '下载返回了网页或登录页面，未保存为附件。');
}
export function extractDetail(source: string, url: string) {
  if (isLoginHtml(source)) throw new LearnError('AUTH_REQUIRED', '网络学堂会话已失效，请在本机重新登录。');
  const $ = cheerio.load(source); $('script,style,nav,header,footer,form').remove();
  let nodes = $('.tlnr,.reply-content,.discussion-content,.question-content,.answer-content');
  if (!nodes.length) nodes = $('#main-content,.main-content,.boxbox');
  const html = nodes.toArray().map(n => $.html(n)).join('\n');
  const link = $('a[rel="next"]').attr('href') || $('a').filter((_, el) => /^(下一页|下页|next)$/i.test($(el).text().trim())).first().attr('href');
  return {
    html, completeness: 'partial' as const,
    next: link && !/^javascript:/i.test(link) ? new URL(link, url).toString() : undefined,
    warnings: [html ? '已保存可识别正文和原始页面；当前站点讨论/答疑回复完整性尚未经真实账号验证。' : '未识别详情正文结构，已保留原始 HTML，不能视为完整归档。'],
  };
}
export async function readDetailPages(request: (url: string) => Promise<Response>, start: string) {
  const seen = new Set<string>(); let url: string | undefined = start; let source = '', readable = ''; let fetchFailed = false;
  const warnings = ['讨论/答疑回复完整性尚未经真实站点验证。'];
  while (url && seen.size < 30) {
    if (seen.has(url)) { warnings.push('分页链接循环。'); fetchFailed = true; break; } seen.add(url);
    try {
      const response = await request(url); if (!response.ok) throw new Error('detail status');
      const html = await response.text(); const detail = extractDetail(html, url);
      source += sanitizedHtml(html) + '\n'; readable += detail.html + '\n'; warnings.push(...detail.warnings);
      if (!detail.html) fetchFailed = true;
      url = detail.next;
    } catch { warnings.push('详情某一页抓取失败，已保留此前成功页面。'); fetchFailed = true; break; }
  }
  if (url && seen.size >= 30) { warnings.push('达到分页上限，未完整遍历。'); fetchFailed = true; }
  return { html: source, body: toMarkdown(readable), warnings: [...new Set(warnings)], fetchFailed };
}
export function normalizeContent(courseId: string, kind: Kind, raw: Record<string, any>): Content {
  const attachments: Attachment[] = [];
  const revisionRaw = scrub({ ...raw, visitCount: undefined, downloadCount: undefined, hasRead: undefined, isNew: undefined });
  const revision = digest(JSON.stringify(revisionRaw));
  for (const role of ['attachment', 'answerAttachment', 'submittedAttachment', 'gradeAttachment', 'remoteFile']) {
    const file = raw[role];
    if (file?.downloadUrl && file.name) {
      let name = String(file.name);
      const fileType = kind === 'file' && role === 'remoteFile' ? String(raw.fileType || '').replace(/^\./, '').toLowerCase() : '';
      if (/^[a-z0-9]{1,12}$/.test(fileType) && !name.toLowerCase().endsWith('.' + fileType)) name += '.' + fileType;
      attachments.push({ id: String(file.id || digest(file.downloadUrl)), name, url: file.downloadUrl, role, revision });
    }
  }
  let html = String(raw.content ?? raw.description ?? raw.question ?? '');
  for (const [key, label] of [['answerContent', '参考答案'], ['submittedContent', '已提交正文'], ['gradeContent', '批改反馈']]) {
    if (raw[key]) html += `<h2>${label}</h2>${raw[key]}`;
  }
  if (raw.detail) html += `<pre>${escapeHtml(JSON.stringify(raw.detail, null, 2))}</pre>`;
  const inline = inlineResources(html, raw.url || 'https://learn.tsinghua.edu.cn/'); attachments.push(...inline.attachments);
  html = sanitizedHtml(html);
  return {
    ...((kind === 'homework' ? { submitted: raw.submitted, deadline: raw.deadline, lateSubmissionDeadline: raw.lateSubmissionDeadline, submissionType: raw.submissionType, completionType: raw.completionType, submittedContent: raw.submittedContent, submittedAttachment: raw.submittedAttachment, submitTime: raw.submitTime } : {})),
    id: String(raw.id), courseId, kind, title: String(raw.title || raw.name || raw.id),
    body: toMarkdown(html), html, url: raw.url, revision, attachments, completeness: inline.warnings.length ? 'partial' : 'complete', warnings: inline.warnings, raw: scrub(raw),
  };
}
export function escapeHtml(text: string) { return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
