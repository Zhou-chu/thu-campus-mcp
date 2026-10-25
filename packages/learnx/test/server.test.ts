import { expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer } from '../src/server.js';
import { loadConfig } from '../src/config.js';
async function session(mock: boolean, run: (client: Client) => Promise<void>) {
  const root = await mkdtemp(path.join(tmpdir(), 'learnx-server-')); const [a, b] = InMemoryTransport.createLinkedPair();
  const server = await createServer(loadConfig({ mock, stateDir: root, outputDir: path.join(root, 'downloads') }));
  const client = new Client({ name: 'behavior-test', version: '1' });
  try { await server.connect(a); await client.connect(b); await run(client); }
  finally { await client.close(); await server.close(); await rm(root, { recursive: true, force: true }); }
}
it('exposes 13 tools without requiring a school login at initialization', () => session(false, async c => {
  const tools = await c.listTools(); expect(tools.tools).toHaveLength(13);
  expect(tools.tools.find(t => t.name === 'learn_submit_assignment')?.annotations?.readOnlyHint).toBe(false);
  const result = await c.callTool({ name: 'learn_status', arguments: {} }); expect(result.isError).not.toBe(true);
  const status = JSON.parse((result.content as any)[0].text); expect(status.authentication.configured).toBe(false);
  const fail = await c.callTool({ name: 'learn_list_semesters', arguments: {} }); expect(fail.isError).toBe(true);
  expect(JSON.stringify(fail)).toContain('AUTH_REQUIRED');
}));
it('filters mock courses and returns clear errors for unknown content', () => session(true, async c => {
  const result = await c.callTool({ name: 'learn_list_courses', arguments: { query: '电路' } });
  expect(JSON.parse((result.content as any)[0].text).items).toHaveLength(1);
  const fail = await c.callTool({ name: 'learn_get_content', arguments: { courseId: 'mock-course-1', kind: 'homework', id: 'wrong' } });
  expect(fail.isError).toBe(true);
}));
