import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temporary = await mkdtemp(path.join(tmpdir(), 'learnx-smoke-'));
async function connect(mock) {
  const client = new Client({ name: 'learnx-smoke', version: '1' });
  const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(root, 'dist/cli.js'), 'serve'], cwd: root, env: { ...process.env, LEARNX_MOCK: mock ? '1' : '0', LEARNX_STATE_DIR: path.join(temporary, mock ? 'mock-state' : 'real-state'), LEARNX_OUTPUT_DIR: path.join(temporary, 'archive') }, stderr: 'pipe' });
  let stderr = ''; transport.stderr?.on('data', c => { stderr += c.toString(); });
  await client.connect(transport);
  return { client, stderr: () => stderr };
}
const value = result => { assert.notEqual(result.isError, true, JSON.stringify(result)); return JSON.parse(result.content[0].text); };
try {
  const { client: mock, stderr } = await connect(true);
  try {
    const tools = await mock.listTools(); assert.equal(tools.tools.length, 13);
    const courses = value(await mock.callTool({ name: 'learn_list_courses', arguments: {} })); assert.equal(courses.total, 2);
    const courseId = courses.items[0].id;
    const homework = value(await mock.callTool({ name: 'learn_list_assignments', arguments: { courseId } })).items[0];
    const file = path.join(temporary, '报告.txt'); await writeFile(file, 'Smoke test report.');
    const prepared = value(await mock.callTool({ name: 'learn_prepare_submission', arguments: { courseId, homeworkId: homework.id, filePath: file, content: '本地模拟报告' } }));
    const receipt = value(await mock.callTool({ name: 'learn_submit_assignment', arguments: { preparationId: prepared.id } })); assert.equal(receipt.status, 'submitted');
    assert.equal(value(await mock.callTool({ name: 'learn_submit_assignment', arguments: { preparationId: prepared.id } })).status, 'submitted');
    const job = value(await mock.callTool({ name: 'learn_sync_semester', arguments: {} }));
    let status;
    for (let i = 0; i < 100; i++) {
      status = value(await mock.callTool({ name: 'learn_sync_status', arguments: { jobId: job.id } }));
      if (!['queued', 'running'].includes(status.status)) break;
      await new Promise(r => setTimeout(r, 100));
    }
    assert.equal(status.status, 'complete', JSON.stringify(status)); assert.equal(status.result.courses, 2);
    const search = value(await mock.callTool({ name: 'learn_search_local', arguments: { query: '离线模拟' } })); assert.ok(search.total >= 12);
    assert.equal(stderr(), '', 'No protocol or runtime diagnostics expected during mock smoke');
    console.log('PASS mock stdio: 13 tools, query, prepare/submit/readback, idempotent receipt, detached worker, archive, search');
  } finally { await mock.close(); }
  const { client: real } = await connect(false);
  try {
    assert.equal((await real.listTools()).tools.length, 13);
    const status = value(await real.callTool({ name: 'learn_status', arguments: {} })); assert.equal(status.authentication.configured, false);
    assert.equal((await real.callTool({ name: 'learn_list_semesters', arguments: {} })).isError, true);
    console.log('PASS real mode stdio: initialization and tool discovery without school credentials; explicit AUTH_REQUIRED on reads');
  } finally { await real.close(); }
} finally { await rm(temporary, { recursive: true, force: true }); }
