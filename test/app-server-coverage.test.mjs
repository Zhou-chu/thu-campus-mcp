import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import http from 'node:http';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createAppServer } from '../lib/app/server.mjs';
import { SessionStore } from '../lib/app/sessions.mjs';

const qa = path.resolve(import.meta.dirname, '../.local/qa-temp');
async function boot(t, { config: extra = {}, call, route: routeExtra = {}, keepAlive = null } = {}) {
  await mkdir(qa, { recursive: true });
  const dir = await mkdtemp(path.join(qa, 'server-edges-'));
  const calls = [];
  const config = { stateDir: dir, host: '127.0.0.1', port: 0, hostname: 'fixture-server', token: 'fixture-server-token', modelRoute: 'fixture', modelName: '', ...extra };
  const host = { describe: () => [], toolForModel: () => [], async call(name, args) {
    calls.push({ name, args });
    return call ? call(name, args) : { ok: true, data: { configured: false } };
  } };
  const route = { async status() { return { available: true, route: 'fixture' }; }, async models() { return [{ id: 'fixture-model' }]; }, ...routeExtra };
  const devices = { verify: async () => null, count: async () => 0, list: async () => [], revoke: async () => false };
  const app = createAppServer({ config, host, route, devices, sessions: new SessionStore(dir), pairing: { issue() { throw new Error('Unexpected pairing'); } }, version: 'fixture-version', keepAlive, webuiDir: path.join(dir, 'webui') });
  const url = await app.listen();
  t.after(async () => {
    await app.close();
    assert.equal(path.dirname(dir), qa);
    assert.ok(path.basename(dir).startsWith('server-edges-'));
    await rm(dir, { recursive: true, force: true });
  });
  const request = (pathname, { headers = {}, ...options } = {}) => fetch(url + pathname, { ...options, headers: { authorization: 'Bearer fixture-server-token', ...headers } });
  return { app, url, dir, calls, request };
}

test('HTTP boundaries: explicit extra origins/hosts and malformed origins use the real guard', async t => {
  const a = await boot(t, { config: { publicUrl: 'not a URL', extraHosts: ['extra.invalid'], extraOrigins: ['https://trusted.invalid'] } });
  // fetch/Undici may regenerate Host; native HTTP preserves the exact hostile header.
  const withHost = hostname => new Promise((resolve, reject) => {
    const req = http.get(a.url + '/api/tools', { headers: { host: hostname, origin: 'https://trusted.invalid', authorization: 'Bearer fixture-server-token' } }, res => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { body += chunk; });
      res.on('error', reject);
      res.on('end', () => resolve({ status: res.statusCode, json: async () => JSON.parse(body) }));
    });
    req.on('error', reject);
  });
  let r = await withHost('extra.invalid');
  assert.equal(r.status, 200);
  for (const origin of ['null', 'not-an-origin', 'https://rejected.invalid']) {
    r = await a.request('/api/tools', { headers: { origin } });
    assert.equal(r.status, 403);
    assert.equal((await r.json()).error.code, 'ORIGIN_REJECTED');
  }
  r = await withHost('rejected.invalid');
  assert.equal(r.status, 403);
  assert.equal((await r.json()).error.code, 'HOST_REJECTED');
});

test('HTTP boundaries: absent and invalid credentials cannot enter private routes', async t => {
  const a = await boot(t);
  for (const authorization of ['', 'Basic fixture', 'Bearer unknown-device']) {
    const r = await a.request('/api/tools', { headers: { authorization } });
    assert.equal(r.status, 401);
    assert.equal((await r.json()).error.code, 'AUTH_REQUIRED');
  }
  for (const pathname of ['/api/pair/redeem', '/api/pair/invite']) {
    const r = await a.request(pathname, { method: 'POST', body: '{}' });
    assert.equal(r.status, 403);
    assert.equal((await r.json()).error.code, 'PAIRING_DISABLED');
  }
  const wrongMethod = await a.request('/api/pair/redeem');
  assert.equal(wrongMethod.status, 405);
});

test('HTTP boundaries: JSON scalar/array/empty bodies, invalid JSON and body limit', async t => {
  const a = await boot(t);
  const id = '12345678-1234-1234-1234-123456789012';
  for (const body of ['', '[]', 'null', '42']) {
    const r = await a.request(`/api/chat/${id}/confirm`, { method: 'POST', body });
    assert.equal(r.status, 400);
    assert.equal((await r.json()).error.code, 'INVALID_ARGUMENTS');
  }
  let r = await a.request(`/api/chat/${id}/confirm`, { method: 'POST', body: '{broken' });
  assert.equal(r.status, 400);
  assert.equal((await r.json()).error.code, 'INVALID_JSON');
  r = await a.request(`/api/chat/${id}/confirm`, { method: 'POST', body: JSON.stringify({ payload: 'x'.repeat(8200) }) });
  assert.equal(r.status, 413);
  assert.equal((await r.json()).error.code, 'PAYLOAD_TOO_LARGE');
});

test('HTTP boundaries: model discovery failures and meta fallback stay honest', async t => {
  for (const models of [async () => [], async () => { throw new Error('fixture model discovery unavailable'); }]) {
    const a = await boot(t, { route: { models, async status() { throw new Error('fixture offline'); } } });
    const r = await a.request('/api/models?refresh=1');
    assert.equal(r.status, 502);
    assert.equal((await r.json()).error.code, 'MODEL_DISCOVERY_FAILED');
    const meta = await (await a.request('/api/meta')).json();
    assert.equal(meta.model.available, false);
    assert.equal(meta.model.name, '');
    assert.deepEqual(meta.models, []);
    assert.equal(meta.security.publicUrl, null);
  }
});

test('HTTP boundaries: tool failure/error sanitization and invalid session methods', async t => {
  const a = await boot(t, { call: async (_name, args) => {
    if (args.throw) throw Object.assign(new Error('fixture-private-detail'), { code: args.code });
    return { ok: false, error: { code: 'FIXTURE_REJECTED', message: 'fixture rejection' }, data: { retained: true } };
  } });
  let r = await a.request('/api/tools/fixture_action', { method: 'POST', body: '{}' });
  assert.equal(r.status, 400);
  assert.deepEqual(await r.json(), { ok: false, error: { code: 'FIXTURE_REJECTED', message: 'fixture rejection' }, data: { retained: true } });
  for (const code of ['UNAVAILABLE', 'unsafe detail', '']) {
    r = await a.request('/api/tools/fixture_action', { method: 'POST', body: JSON.stringify({ throw: true, code }) });
    assert.equal(r.status, 500);
    const body = await r.text();
    assert.equal(body.includes('fixture-private-detail'), false);
    assert.equal(JSON.parse(body).error.code, code === 'UNAVAILABLE' ? code : 'APP_ERROR');
  }
  r = await a.request('/api/sessions/12345678-1234-1234-1234-123456789012', { method: 'PUT' });
  assert.equal(r.status, 404);
  r = await a.request('/api/devices/unknown', { method: 'DELETE' });
  assert.equal(r.status, 404);
  assert.equal((await r.json()).error.code, 'DEVICE_NOT_FOUND');
});

test('HTTP boundaries: static fallback, unknown MIME and versioned files are served safely', async t => {
  const a = await boot(t);
  let r = await a.request('/');
  assert.equal(r.status, 200);
  assert.match(await r.text(), /WebUI 静态文件尚未安装/);
  r = await a.request('/missing.svg');
  assert.equal(r.status, 404);
  r = await a.request('/index.html', { method: 'POST' });
  assert.equal(r.status, 405);
  await mkdir(path.join(a.dir, 'webui'), { recursive: true });
  await writeFile(path.join(a.dir, 'webui', 'index.html'), '<title>__ASSET_VERSION__</title>');
  await writeFile(path.join(a.dir, 'webui', 'fixture.unknown'), 'fixture bytes');
  r = await a.request('/unregistered-route');
  assert.equal(r.status, 200);
  assert.equal(await r.text(), '<title>fixture-version</title>');
  r = await a.request('/fixture.unknown', { method: 'HEAD' });
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('content-type'), 'application/octet-stream');
  assert.equal(await r.text(), '');
});
