import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { homedir } from 'node:os';
import test from 'node:test';
import { accountPath, clearAccount, defaultAccountDir, loadAccount, maskAccount, saveAccount } from '../lib/app/account.mjs';

const tempState = async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'account-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
};
const win = { skip: process.platform !== 'win32' };

test('account: Windows DPAPI 写入二进制，读回密码但磁盘不含明文', win, async t => {
  const stateDir = await tempState(t);
  await saveAccount({ username: ' 2023000000 ', password: 'secret-pass' }, stateDir);
  const loaded = await loadAccount(stateDir);
  assert.deepEqual(loaded, { username: '2023000000', password: 'secret-pass', source: 'account' });
  const raw = await readFile(accountPath(stateDir));
  assert.equal(raw.includes(Buffer.from('secret-pass')), false);
  assert.equal(raw.includes(Buffer.from('2023000000')), false);
  assert.equal(maskAccount(loaded), '2023****00');
  assert.equal(maskAccount({ username: 'abc' }), 'a***');
  assert.equal(maskAccount(null), '');
});

test('account: 缺少字段拒绝保存，未配置时返回 null', async t => {
  const stateDir = await tempState(t);
  assert.equal(await loadAccount(stateDir), null);
  await assert.rejects(() => saveAccount({ username: '2023' }, stateDir), { code: 'ACCOUNT_INCOMPLETE' });
  assert.equal(await loadAccount(stateDir), null);
});

for (const [legacy, source] of [['account.json', 'account'], ['seat-credentials.json', 'seat-legacy']]) {
  test(`account: ${legacy} 仅在验证加密记录后迁移，清除后不会回退`, win, async t => {
    const stateDir = await tempState(t);
    const old = path.join(stateDir, legacy);
    await writeFile(old, JSON.stringify({ username: '2024000001', password: 'legacy-secret' }));
    const [loaded, again] = await Promise.all([loadAccount(stateDir), loadAccount(stateDir)]);
    assert.deepEqual(new Set([loaded.source, again.source]), new Set([source, 'account']));
    assert.equal(loaded.username, '2024000001');
    assert.equal(again.password, 'legacy-secret');
    assert.equal((await readFile(accountPath(stateDir))).includes(Buffer.from('legacy-secret')), false);
    await assert.rejects(() => readFile(old), { code: 'ENOENT' });
    await clearAccount(stateDir);
    assert.equal(await loadAccount(stateDir), null);
  });
}

test('account: 无法解密时不回退明文，不删除任何旧凭据', async t => {
  const stateDir = await tempState(t);
  await writeFile(accountPath(stateDir), Buffer.from('not-dpapi'));
  const legacy = path.join(stateDir, 'seat-credentials.json');
  const input = JSON.stringify({ username: 'fixture', password: 'fixture-secret' });
  await writeFile(legacy, input);
  await assert.rejects(() => loadAccount(stateDir), { code: 'ACCOUNT_STORAGE' });
  assert.equal(await readFile(legacy, 'utf8'), input);
});

test('account: 未设置环境变量时回退到用户状态目录，而不是当前目录', () => {
  const savedApp = process.env.THU_CAMPUS_APP_STATE_DIR;
  const savedSeat = process.env.SEAT_STATE_DIR;
  delete process.env.THU_CAMPUS_APP_STATE_DIR;
  delete process.env.SEAT_STATE_DIR;
  try {
    assert.equal(defaultAccountDir(), path.join(homedir(), '.thu-campus-mcp', 'app'));
    assert.equal(accountPath().startsWith(path.join(homedir(), '.thu-campus-mcp', 'app')), true);
  } finally {
    if (savedApp === undefined) delete process.env.THU_CAMPUS_APP_STATE_DIR; else process.env.THU_CAMPUS_APP_STATE_DIR = savedApp;
    if (savedSeat === undefined) delete process.env.SEAT_STATE_DIR; else process.env.SEAT_STATE_DIR = savedSeat;
  }
});
