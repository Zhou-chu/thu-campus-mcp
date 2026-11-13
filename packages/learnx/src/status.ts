import fetchCookie from 'fetch-cookie';
import { CookieJar } from 'tough-cookie';
import * as cheerio from 'cheerio';
import { AuthStore, type AuthData } from './auth.js';
import type { Config } from './config.js';

const URL = 'https://learn.tsinghua.edu.cn/f/wlxt/index/course/student/';
type Store = { load(): Promise<AuthData | undefined>; version?(): Promise<string | undefined> };
/** 仅复用已有Cookie读取受保护用户首页；绝不调用RealClient的自动登录/恢复。 */
export async function learnStatus(config: Config, { verify = true, store = new AuthStore(config.stateDir) as Store, fetcher = fetch } = {}) {
  const base = { mode: config.mock ? 'mock' : 'real', verified: false, checkedAt: new Date().toISOString(), source: 'local:learn-auth-store', sessionValidity: 'unverified', code: 'UNVERIFIED' };
  if (config.mock) return { ...base, mode: 'mock', state: 'mock', source: 'mock:learnx', code: 'MOCK_MODE', authentication: { configured: true, simulation: true } };
  let configured = false, source = base.source;
  try {
    const version = await store.version?.();
    const auth = await store.load();
    configured = Boolean(auth);
    const authentication = { configured };
    if (!auth) return { ...base, authentication, code: 'AUTH_REQUIRED' };
    if (!verify || !auth.cookieJar) return { ...base, authentication };
    const jar = CookieJar.fromJSON(auth.cookieJar as any);
    if (!await jar.getCookieString(URL)) return { ...base, authentication };
    source = 'protected-api:learn-user-home';
    const response = await fetchCookie(fetcher, jar)(URL, { method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(config.requestTimeoutMs) });
    const online = { ...base, authentication, source };
    if ([401, 403].includes(response.status)) {
      await response.body?.cancel();
      return { ...online, code: 'AUTH_EXPIRED', sessionValidity: 'expired' };
    }
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location') || '';
      await response.body?.cancel();
      const login = /(?:id\.tsinghua\.edu\.cn|\/login|j_spring_security_thauth)/i.test(location);
      return { ...online, code: login ? 'AUTH_EXPIRED' : 'UPSTREAM_PROTOCOL', sessionValidity: login ? 'expired' : 'unknown' };
    }
    if (!response.ok) { await response.body?.cancel(); return { ...online, code: 'UPSTREAM_HTTP', sessionValidity: 'unknown' }; }
    const html = await response.text();
    if (/<input[^>]+(?:type=["']?password|name=["']?(?:i_pass|i_user))/i.test(html)) return { ...online, code: 'AUTH_EXPIRED', sessionValidity: 'expired' };
    const $ = cheerio.load(html);
    // 与上游getUserInfo相同的已登录用户区，另要求会话CSRF标记。不返回身份正文。
    const csrf = $('meta[name="_csrf"]').attr('content') || $('input[name="_csrf"]').attr('value') || /[?&]_csrf=([^\s"'<>&]+)/.test(html);
    if (!$('a.user-log').text().trim() || !csrf) return { ...online, code: 'UPSTREAM_PROTOCOL', sessionValidity: 'unknown' };
    if (version !== await store.version?.()) return { ...online, code: 'AUTH_CHANGED' };
    return { ...online, verified: true, code: 'VERIFIED', sessionValidity: 'verified' };
  } catch (error) {
    const raw = (error as any)?.code;
    const code = ['AUTH_STORAGE', 'AUTH_PLATFORM'].includes(raw) ? raw : source.startsWith('protected-api:') ? 'NETWORK_ERROR' : 'AUTH_STORAGE';
    return { ...base, authentication: { configured }, source, code, sessionValidity: 'unknown' };
  }
}
