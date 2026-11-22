import { it, expect } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from '../src/server.js';
import { loadConfig } from '../src/config.js';
import { learnStatus } from '../src/status.js';

for (const mock of [false, true]) it(`learn_status接受verify且${mock ? '模拟不冒已登录' : '缺凭据不自动登录'}`, async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'learn-status-'));
  const server = await createServer(loadConfig({ stateDir: root, mock }));
  const client = new Client({ name: 'status-test', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(a); await client.connect(b);
    const schema = (await client.listTools()).tools.find(t => t.name === 'learn_status')!.inputSchema;
    expect(schema.properties).toHaveProperty('verify');
    for (const verify of [false, true]) {
      const result = await client.callTool({ name: 'learn_status', arguments: { verify } });
      expect(result.isError).not.toBe(true);
      const value = JSON.parse((result.content as any)[0].text);
      expect(value.verified).toBe(false); expect(value.code).toBe(mock ? 'MOCK_MODE' : 'AUTH_REQUIRED');
      expect(value.source).toBe(mock ? 'mock:learnx' : 'local:learn-auth-store');
      expect(value.authentication).not.toHaveProperty('accountId');
    }
  } finally { await client.close(); await server.close(); expect(path.isAbsolute(root)).toBe(true); expect(path.basename(root)).toMatch(/^learn-status-/); await rm(root, { recursive: true, force: true }); }
});

it('登录超时页面按会话过期处理，触发自动恢复而不是上游协议错误', async () => {
  const store = {
    async version() { return 'v1'; },
    async load() { return { cookieJar: { cookies: [{ key: 'JSESSIONID', value: 'stale', domain: 'learn.tsinghua.edu.cn', path: '/' }] } } as any; },
  };
  const fetcher = (async () => new Response('<!DOCTYPE html><title>登录超时</title><a href="/login">重新登录</a>', { status: 200, headers: { 'content-type': 'text/html' } })) as any;
  const out = await learnStatus(loadConfig({ stateDir: '.', mock: false }), { store, fetcher });
  expect(out.code).toBe('AUTH_EXPIRED');
  expect(out.sessionValidity).toBe('expired');
  expect(out.source).toBe('protected-api:learn-user-home');
});
