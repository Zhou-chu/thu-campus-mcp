import { it, expect } from 'vitest';
import { parse } from 'smol-toml';
import { mkdtemp, readFile, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { mergeJson, mergeToml, installClients } from '../src/install.js';
const entry = { command: 'C:/Program Files/nodejs/node.exe', args: ['D:/code/learnX_MCP/dist/cli.js', 'serve'], env: { LEARNX_MOCK: '0' } };
it('preserves unrelated JSON config and installs idempotently', () => {
  const before = JSON.stringify({ theme: 'dark', mcpServers: { old: { command: 'old', env: { KEY: 'preserve-test-value' } } } });
  const after = mergeJson(before, entry, 'json', false);
  expect(JSON.parse(after).mcpServers.old.env.KEY).toBe('preserve-test-value'); expect(JSON.parse(after).theme).toBe('dark');
  expect(mergeJson(after, entry, 'json', false)).toBe(after);
  const removed = JSON.parse(mergeJson(after, entry, 'json', true)); expect(removed.mcpServers.learnx).toBeUndefined(); expect(removed.mcpServers.old.command).toBe('old');
});
it('preserves TOML comments and existing nested server env during install and uninstall', () => {
  const before = '# user settings\nmodel = "test-model"\n[mcp_servers.old]\ncommand = "old"\n[mcp_servers.old.env]\nKEY = "preserve-test-value"\n';
  const after = mergeToml(before, entry, false);
  expect(after).toContain(before); expect((parse(after) as any).mcp_servers.old.env.KEY).toBe('preserve-test-value');
  expect(mergeToml(after, entry, false)).toBe(after);
  expect((parse(mergeToml(after, entry, true)) as any).mcp_servers.old.command).toBe('old');
});
it('uses the actual Harness manager versioned server array format', () => {
  const before = JSON.stringify({ version: 1, servers: [{ name: 'old', transport: 'stdio', command: 'old' }], disabledTools: { old: ['x'] } });
  const after = JSON.parse(mergeJson(before, entry, 'harness', false));
  expect(after.servers.find((s: any) => s.name === 'learnx').transport).toBe('stdio'); expect(after.servers).toHaveLength(2);
  expect(after.disabledTools.old).toEqual(['x']);
});
it('rejects invalid config and refuses to replace another project using the same name', () => {
  expect(() => mergeJson('{broken', entry, 'json', false)).toThrow();
  expect(() => mergeJson('{"mcpServers":{"learnx":{"command":"other","args":["other.js"]}}}', entry, 'json', false)).toThrow();
});
it('preserves user disable policies when reinstalling its own server', () => {
  const own = { ...entry, enabled: false, disabled_tools: ['learn_submit_assignment'] };
  const toml = `[mcp_servers.learnx]\ncommand = ${JSON.stringify(entry.command)}\nargs = ${JSON.stringify(entry.args)}\nenabled = false\ndisabled_tools = ["learn_submit_assignment"]\n`;
  const parsed = parse(mergeToml(toml, entry, false)) as any;
  expect(parsed.mcp_servers.learnx.enabled).toBe(false); expect(parsed.mcp_servers.learnx.disabled_tools).toEqual(['learn_submit_assignment']);
  const harness = JSON.stringify({ version: 1, servers: [{ name: 'learnx', transport: 'stdio', ...entry, enabled: false, disabledTools: ['learn_submit_assignment'] }] });
  const result = JSON.parse(mergeJson(harness, entry, 'harness', false));
  expect(result.servers[0].enabled).toBe(false); expect(result.servers[0].disabledTools).toEqual(['learn_submit_assignment']);
  expect(JSON.parse(mergeJson(JSON.stringify({ mcpServers: { learnx: own } }), entry, 'json', false)).mcpServers.learnx.enabled).toBe(false);
});
it('backs up original client configurations before applying changes', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'learnx-install-'));
  try {
    const home = path.join(root, 'home'); await mkdir(home); const file = path.join(home, '.claude.json');
    await writeFile(file, '{"custom":42}\n');
    const results = await installClients({ home, harnessHome: path.join(root, 'harness'), stateDir: path.join(root, 'state'), apply: true });
    const result = results.clients.find(c => c.client === 'Claude Code')!;
    expect(await readFile(result.backup!, 'utf8')).toBe('{"custom":42}\n');
    expect(JSON.parse(await readFile(file, 'utf8')).custom).toBe(42);
    const again = await installClients({ home, harnessHome: path.join(root, 'harness'), stateDir: path.join(root, 'state'), apply: true });
    expect(again.clients.find(c => c.client === 'Claude Code')?.changed).toBe(false);
  } finally { await rm(root, { recursive: true, force: true }); }
});
