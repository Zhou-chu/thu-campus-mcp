import { expect, it } from 'vitest';
import { browserSessionData } from '../src/browser-auth.js';
it('extracts a real session including HttpOnly cookies without exposing them in tool parameters', async () => {
  const data = await browserSessionData('local-user', [{ name: 'JSESSIONID', value: 'local-cookie', domain: 'learn.tsinghua.edu.cn', path: '/', secure: true, httpOnly: true, expires: -1, sameSite: 'Lax' }], '<a href="/b/course?x=1&amp;_csrf=local-csrf">课表</a>');
  expect(data.csrfToken).toBe('local-csrf'); expect(data.cookieJar?.cookies[0].httpOnly).toBe(true);
  expect(data.password).toBeUndefined();
});
