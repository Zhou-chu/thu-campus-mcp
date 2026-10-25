import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
const cli = path.join(root, 'bin/thu-campus.mjs');
function run(args, env = {}) {
  return spawnSync(process.execPath, [cli, ...args], { cwd: tmpdir(), encoding: 'utf8', env: {...process.env,...env}, timeout: 30000 });
}
test('unified CLI works outside the checkout and rejects unknown services clearly', () => {
  const help = run(['--help']);
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /learnx.*cloud.*hetang/s);
  const bad = run(['not-a-service', 'serve']);
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /未知|unknown/i);
  assert.doesNotMatch(bad.stderr, /MODULE_NOT_FOUND/);
});
test('config export uses portable bundled paths and real mode while preserving state overrides', () => {
  const output = run(['config'], { HETANG_STATE_DIR: path.join(tmpdir(), 'my-rain-state') });
  assert.equal(output.status, 0, output.stderr);
  const data = JSON.parse(output.stdout).mcpServers;
  assert.deepEqual(Object.keys(data).sort(), ['hetang','learnx','thu-cloud']);
  assert.equal(data.hetang.env.HETANG_STATE_DIR, path.join(tmpdir(), 'my-rain-state'));
  assert.equal(data.hetang.env.HETANG_CLOUD_CLI, path.join(root, 'packages/thu-cloud/dist/cli.js'));
  for (const entry of Object.values(data)) {
    assert.equal(entry.command, process.execPath);
    assert(path.isAbsolute(entry.args[0]));
    assert(entry.args[0].startsWith(root));
    assert(Object.entries(entry.env).some(([k,v]) => k.endsWith('_MOCK') && v === '0'));
  }
});
test('bundled rain default points at the sibling cloud build without local overrides', async () => {
  const { loadConfig } = await import('../packages/hetang/dist/config.js');
  assert.equal(loadConfig().cloudCli, path.join(root, 'packages/thu-cloud/dist/cli.js'));
});
test('all service installation previews validate before any configuration is written', async () => {
  const temporary = await mkdtemp(path.join(tmpdir(), 'campus-install-'));
  try {
    const home = path.join(temporary, 'home');
    await mkdir(home);
    const original = JSON.stringify({mcpServers:{'thu-cloud':{command:'foreign',args:['/other/cloud.js','serve']}, keep:{command:'unchanged'}}});
    await writeFile(path.join(home,'.claude.json'), original);
    const { installBundle } = await import('../lib/install.mjs');
    await assert.rejects(installBundle({apply:true,home,harnessHome:path.join(temporary,'no-harness'),stateRoot:path.join(temporary,'state')}), /已有|conflict/i);
    assert.equal(await readFile(path.join(home,'.claude.json'),'utf8'), original);
    await assert.rejects(readFile(path.join(home,'.codex/config.toml')), {code:'ENOENT'});
  } finally { await rm(temporary,{recursive:true,force:true}); }
});
test('combined install preserves unrelated clients and registers all services idempotently', async () => {
  const temporary=await mkdtemp(path.join(tmpdir(),'campus-install-success-'));
  try {
    const home=path.join(temporary,'home'), harnessHome=path.join(temporary,'harness');
    await mkdir(home); await mkdir(path.join(home,'.codex'),{recursive:true});
    await mkdir(path.join(home,'.gemini/antigravity'),{recursive:true});
    await mkdir(path.join(harnessHome,'@wingsky-1/dsh-mcp-manager'),{recursive:true});
    await writeFile(path.join(home,'.claude.json'),JSON.stringify({theme:'keep',mcpServers:{other:{command:'untouched'}}}));
    await writeFile(path.join(home,'.codex/config.toml'),'# keep comment\nmodel="keep"\n[mcp_servers.other]\ncommand="untouched"\n');
    await writeFile(path.join(home,'.gemini/antigravity/mcp_config.json'),'{}');
    await writeFile(path.join(harnessHome,'@wingsky-1/dsh-mcp-manager/mcp.json'),JSON.stringify({version:1,servers:[{name:'other',command:'untouched'}]}));
    const {installBundle}=await import('../lib/install.mjs');
    const options={apply:true,home,harnessHome,stateRoot:path.join(temporary,'state')};
    const report=await installBundle(options);
    assert.equal(report.services.length,3);
    assert(report.services.every(s=>s.clients.length===5));
    const installed=JSON.parse(await readFile(path.join(home,'.claude.json'),'utf8'));
    assert.equal(installed.theme,'keep'); assert.equal(installed.mcpServers.other.command,'untouched');
    assert.deepEqual(Object.keys(installed.mcpServers).sort(),['hetang','learnx','other','thu-cloud']);
    assert.equal(installed.mcpServers.hetang.env.HETANG_CLOUD_CLI,path.join(root,'packages/thu-cloud/dist/cli.js'));
    const codex=await readFile(path.join(home,'.codex/config.toml'),'utf8');
    assert(codex.includes('# keep comment')); assert(codex.includes('command="untouched"'));
    const again=await installBundle(options);
    assert(again.services.every(s=>s.clients.every(c=>!c.changed)));
  } finally {await rm(temporary,{recursive:true,force:true});}
});
