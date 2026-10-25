import { chromium, type Cookie } from 'playwright-core';
import { CookieJar } from 'tough-cookie';
import * as cheerio from 'cheerio';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { AuthStore, type AuthData } from './auth.js';
import { LearnError } from './types.js';
export async function browserSessionData(account: string, cookies: Cookie[], html: string): Promise<AuthData> {
  const $ = cheerio.load(html);
  const token = $('meta[name="_csrf"]').attr('content') || $('input[name="_csrf"]').attr('value') || html.replace(/&amp;/g, '&').match(/[?&]_csrf=([^\s"'<>&]+)/)?.[1];
  if (!token) throw new LearnError('AUTH_TOKEN', '当前页面没有可识别的网络学堂 CSRF，会话未保存。');
  const jar = new CookieJar(); let count = 0;
  for (const c of cookies) {
    const domain = c.domain.replace(/^\./, ''); if (!['learn.tsinghua.edu.cn', 'id.tsinghua.edu.cn'].includes(domain)) continue;
    await jar.setCookie(`${c.name}=${c.value}; Domain=${c.domain}; Path=${c.path}${c.secure ? '; Secure' : ''}${c.httpOnly ? '; HttpOnly' : ''}${c.expires > 0 ? '; Expires=' + new Date(c.expires * 1000).toUTCString() : ''}`, `https://${domain}`);
    if (domain === 'learn.tsinghua.edu.cn') count++;
  }
  if (!count) throw new LearnError('AUTH_COOKIE', '没有网络学堂 Cookie，会话未保存。');
  return { account, csrfToken: token, cookieJar: jar.toJSON() };
}
export async function browserLogin(store: AuthStore, account: string, channel = 'msedge') {
  const profile = await mkdtemp(path.join(tmpdir(), 'learnx-login-'));
  let context: Awaited<ReturnType<typeof chromium.launchPersistentContext>> | undefined;
  try {
    context = await chromium.launchPersistentContext(profile, { channel, headless: false, viewport: null });
    const page = context.pages()[0] || await context.newPage();
    await page.goto('https://learn.tsinghua.edu.cn/f/wlxt/index/course/student/', { waitUntil: 'domcontentloaded', timeout: 60000 });
    process.stderr.write('请在新开的本机浏览器中完成学校登录。登录凭据不会进入聊天；最多等待 10 分钟。\n');
    const until = Date.now() + 10 * 60 * 1000;
    while (Date.now() < until) {
      if (!context.pages().length) throw new LearnError('CANCELLED', '登录浏览器已关闭。');
      for (const candidate of context.pages()) {
        const url = new URL(candidate.url()); if (url.hostname !== 'learn.tsinghua.edu.cn' || !url.pathname.includes('/f/wlxt/')) continue;
        try {
          const data = await browserSessionData(account, await context.cookies(), await candidate.content());
          await store.save(data); return { configured: true, method: 'browser-session', message: '已保存 DPAPI 保护的浏览器会话，可查询学期或同步验证。' };
        } catch (error) { if (!(error instanceof LearnError && ['AUTH_TOKEN', 'AUTH_COOKIE'].includes(error.code))) throw error; }
      }
      await new Promise(r => setTimeout(r, 1000));
    }
    throw new LearnError('AUTH_TIMEOUT', '等待登录超时，会话未保存。');
  } finally { await context?.close(); await rm(profile, { recursive: true, force: true }); }
}
