import { Learn2018Helper } from 'thu-learn-lib';
import fetchCookie from 'fetch-cookie';
import { CookieJar } from 'tough-cookie';
import * as cheerio from 'cheerio';
import { AuthStore, type AuthData } from './auth.js';
import { type Config } from './config.js';
import { digest } from './storage.js';
import { normalizeContent, readDetailPages, validateDownload, inlineResources, isLoginHtml } from './detail.js';
import { LearnError, type Attachment, type Content, type Homework, type Kind, type LearnClient } from './types.js';
import { MockClient } from './mock-client.js';
import { fetchListPages } from './pagination.js';

export function allowedUrl(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== 'https:' || !['learn.tsinghua.edu.cn', 'id.tsinghua.edu.cn'].includes(url.hostname) || (url.port && url.port !== '443') || url.username || url.password) throw new LearnError('UNSAFE_URL', '只允许访问清华网络学堂及统一认证的 HTTPS 地址。');
  return url;
}
export class RealClient implements LearnClient {
  identity = '';
  private helper?: Learn2018Helper;
  private jar?: CookieJar;
  private auth?: AuthData;
  private init?: Promise<void>;
  private authVersion?: string;
  private store: AuthStore;
  constructor(private config: Config) { this.store = new AuthStore(config.stateDir); }
  private async fetch(url: string | URL | Request, init: RequestInit = {}): Promise<Response> {
    if (this.authVersion && await this.store.version() !== this.authVersion) throw new LearnError('AUTH_CHANGED', '本机认证已变化，请重新执行操作。');
    let current = allowedUrl(String(url)).toString();
    const fetcher = fetchCookie(globalThis.fetch, this.jar!);
    for (let i = 0; i < 10; i++) {
      const response = await fetcher(current, { ...init, redirect: 'manual', signal: init.signal ?? AbortSignal.timeout(this.config.requestTimeoutMs) });
      if (![301, 302, 303, 307, 308].includes(response.status)) return response;
      const location = response.headers.get('location'); if (!location) return response;
      current = allowedUrl(new URL(location, current).toString()).toString();
      await response.body?.cancel();
      if (response.status === 303 || ((response.status === 301 || response.status === 302) && init.method === 'POST')) init = { ...init, method: 'GET', body: undefined };
    }
    throw new LearnError('REDIRECT_LIMIT', '站点重定向次数异常，请检查登录。');
  }
  private async ready(): Promise<void> {
    if (this.authVersion && await this.store.version() !== this.authVersion) {
      this.init = undefined; this.auth = undefined; this.jar = undefined; this.helper = undefined; this.authVersion = undefined; this.identity = '';
    }
    if (!this.init) this.init = this.initialize().catch(error => { this.init = undefined; throw error; });
    await this.init;
  }
  private async initialize(): Promise<void> {
    const stored = await this.store.loadVersioned(); this.auth = stored?.data; this.authVersion = stored?.version;
    if (!this.auth) throw new LearnError('AUTH_REQUIRED', '尚未登录。请在本机终端运行 node dist/cli.js auth login 或 auth import。');
    this.identity = digest(this.auth.account).slice(0, 16);
    this.jar = this.auth.cookieJar ? CookieJar.fromJSON(this.auth.cookieJar as any) : new CookieJar();
    // No credential provider: the upstream helper MUST NOT silently replay an upload after reauthentication.
    this.helper = new Learn2018Helper({ cookieJar: this.jar, fetch: this.libraryFetch.bind(this) as typeof globalThis.fetch });
    if (this.auth.cookieJar && this.auth.csrfToken) this.helper.setCSRFToken(this.auth.csrfToken);
    else await this.login();
  }
  private async libraryFetch(url: string | URL | Request, init: RequestInit = {}) {
    const value = String(url); const p = new URL(value).pathname;
    const list = /\/(?:pageList[^/]*|zyListWj|zyListYjwg|zyListYpg|yxzylist|kctlList|kcdyList|kjxxbByWlkcidAndSizeForStudent)$/.test(p);
    return list ? fetchListPages((u, i) => this.fetch(u, i), value, init) : this.fetch(url, init);
  }
  private async login() {
    if (!this.auth?.username || !this.auth.password || !this.auth.fingerPrint) throw new LearnError('AUTH_REQUIRED', '会话已失效，需要本机重新登录或重新导入会话。');
    try { await this.helper!.login(this.auth.username, this.auth.password, this.auth.fingerPrint, this.auth.fingerGenPrint, this.auth.fingerGenPrint3); }
    catch { throw new LearnError('AUTH_REQUIRED', '网络学堂登录未成功，请检查本地凭据、真实设备指纹或使用会话导入。'); }
    this.authVersion = await this.store.saveIfCurrent({ ...this.auth, cookieJar: this.jar!.toJSON(), csrfToken: this.helper!.getCSRFToken() }, this.authVersion!);
  }
  private async refreshSessionToken(): Promise<boolean> {
    // A write may rotate CSRF while the browser session remains authenticated.
    // Only refresh and retry the read operation; never replay the upload POST.
    const response = await this.fetch('https://learn.tsinghua.edu.cn/f/wlxt/index/course/student/');
    if (!response.ok || (response.url && new URL(response.url).hostname !== 'learn.tsinghua.edu.cn')) return false;
    const html = await response.text();
    if (isLoginHtml(html)) return false;
    const $ = cheerio.load(html);
    const token = $('meta[name="_csrf"]').attr('content') || $('input[name="_csrf"]').attr('value') || html.replace(/&amp;/g, '&').match(/[?&]_csrf=([^\s"'<>&]+)/)?.[1];
    if (!token) return false;
    const refreshed = { ...this.auth!, cookieJar: this.jar!.toJSON(), csrfToken: token };
    this.authVersion = await this.store.saveIfCurrent(refreshed, this.authVersion!);
    this.auth = refreshed; this.helper!.setCSRFToken(token);
    return true;
  }
  private async read<T>(fn: (helper: Learn2018Helper) => Promise<T>): Promise<T> {
    await this.ready();
    for (let attempt = 0; ; attempt++) {
      try { return await fn(this.helper!); }
      catch (error) {
        const reason = (error as any)?.reason;
        if (attempt === 0 && (reason === 'not logged in or login timeout' || (error instanceof LearnError && error.code === 'AUTH_REQUIRED'))) {
          if (!await this.refreshSessionToken()) await this.login();
          continue;
        }
        if (attempt < 2 && (error instanceof TypeError || (error as Error)?.name === 'TimeoutError')) { await new Promise(r => setTimeout(r, 300 * (attempt + 1))); continue; }
        throw error;
      }
    }
  }
  async currentSemester(): Promise<{ id: string }> { return this.read(h => h.getCurrentSemester()); }
  async semesters() { return this.read(h => h.getSemesterIdList()); }
  async courses(semesterId: string) { return (await this.read(h => h.getCourseList(semesterId))).map(c => ({ ...c, name: c.name || c.chineseName, teacher: c.teacherName })); }
  async contents(courseId: string, kind: Kind): Promise<Content[]> {
    const data = await this.read(async h => {
      switch (kind) {
        case 'notification': return h.getNotificationList(courseId);
        case 'file': return h.getFileList(courseId);
        case 'homework': return h.getHomeworkList(courseId);
        case 'discussion': return h.getDiscussionList(courseId);
        case 'question': return h.getAnsweredQuestionList(courseId);
        case 'questionnaire': return h.getQuestionnaireList(courseId);
      }
    });
    const contents: Content[] = [];
    for (const item of data) {
      const result = normalizeContent(courseId, kind, item);
      if (kind === 'discussion' || kind === 'question') {
        result.completeness = 'partial'; result.warnings = ['列表仅包含摘要，详情尚未抓取。'];
        try {
          const detail = await readDetailPages(url => this.fetchWithToken(url), result.url!);
          result.html = detail.html; result.body = detail.body; result.warnings = detail.warnings;
          result.detailFetchFailed = detail.fetchFailed; result.revision = digest(result.revision + detail.html);
          const assets = inlineResources(detail.html, result.url || 'https://learn.tsinghua.edu.cn/');
          result.attachments.push(...assets.attachments); result.warnings.push(...assets.warnings);
        } catch { result.warnings = ['详情抓取失败，仅归档列表摘要；需要真实账号验证解析结构。']; }
      }
      contents.push(result);
    }
    return contents;
  }
  private async fetchWithToken(url: string, signal?: AbortSignal) { await this.ready(); const u = allowedUrl(url); u.searchParams.set('_csrf', this.helper!.getCSRFToken()); return this.fetch(u, signal ? { signal } : {}); }
  async download(attachment: Attachment): Promise<Uint8Array> {
    await this.ready();
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const reset = () => { clearTimeout(timer); timer = setTimeout(() => controller.abort(), this.config.requestTimeoutMs); };
    reset();
    try {
      const response = await this.fetchWithToken(attachment.url, controller.signal);
      if (!response.ok) throw new LearnError('DOWNLOAD_FAILED', '附件下载失败，请检查会话及权限。');
      if (Number(response.headers.get('content-length')) > this.config.maxDownloadBytes) { await response.body?.cancel(); throw new LearnError('DOWNLOAD_LIMIT', '附件超过本地下载大小限制。'); }
      const chunks: Uint8Array[] = []; let size = 0;
      if (response.body) for await (const chunk of response.body as any as AsyncIterable<Uint8Array>) {
        reset(); size += chunk.length;
        if (size > this.config.maxDownloadBytes) throw new LearnError('DOWNLOAD_LIMIT', '附件超过本地下载大小限制。'); chunks.push(chunk);
      }
      const bytes = Buffer.concat(chunks); validateDownload(bytes, response.headers.get('content-type') || '', attachment.name);
      return bytes;
    } catch (error) {
      if (controller.signal.aborted) throw new LearnError('DOWNLOAD_TIMEOUT', '附件下载长时间无进度，请检查网络后增量重试。');
      throw error;
    } finally {
      clearTimeout(timer!);
    }
  }
  async homework(courseId: string, id: string): Promise<Homework> {
    const hw = (await this.contents(courseId, 'homework')).find(c => c.id === id);
    if (!hw) throw new LearnError('NOT_FOUND', '课程内找不到指定作业，请使用学生作业 ID。'); return hw as Homework;
  }
  async submit(courseId: string, id: string, content: string, attachment?: { name: string; bytes: Uint8Array }) {
    await this.ready(); const accountId = this.identity; await this.homework(courseId, id);
    if (accountId !== this.identity) throw new LearnError('AUTH_CHANGED', '账号已变化，未上传。');
    // Deliberately no retry wrapper around this POST.
    try { await this.helper!.submitHomework(id, content, attachment ? { filename: attachment.name, content: new Blob([Uint8Array.from(attachment.bytes)]) } : undefined, false); }
    catch (error) {
      if ((error as any)?.reason === 'operation failed') throw new LearnError('SUBMISSION_REJECTED', '服务器明确拒绝本次提交，请检查作业要求。');
      throw error;
    }
  }
}
export async function createClient(config: Config): Promise<LearnClient> { return config.mock ? new MockClient() : new RealClient(config); }
