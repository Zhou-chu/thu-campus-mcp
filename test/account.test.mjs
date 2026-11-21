import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { accountPath, clearAccount, loadAccount, maskAccount, saveAccount } from '../lib/app/account.mjs';

const tempState = () => mkdtemp(path.join(tmpdir(), 'account-test-'));

test('account: 保存后权限 600 且能读回，掩码不暴露密码', async () => {
  const stateDir = await tempState();
  await saveAccount({ username: ' 2023000000 ', password: 'secret-pass' }, stateDir);
  const loaded = await loadAccount(stateDir);
  assert.equal(loaded.username, '2023000000', '学号去掉首尾空格');
  assert.equal(loaded.source, 'account');
  const raw = await readFile(accountPath(stateDir), 'utf8');
  assert.match(raw, /secret-pass/);
  assert.equal(maskAccount(loaded), '2023****00');
  assert.equal(maskAccount({ username: 'abc' }), 'a***');
  assert.equal(maskAccount(null), '');
});

test('account: 缺少字段拒绝保存，未配置时返回 null', async () => {
  const stateDir = await tempState();
  assert.equal(await loadAccount(stateDir), null);
  await assert.rejects(() => saveAccount({ username: '2023' }, stateDir), error => error.code === 'ACCOUNT_INCOMPLETE');
  assert.equal(await loadAccount(stateDir), null);
});

test('account: 老用户从座位凭据自动迁移读取', async () => {
  const stateDir = await tempState();
  await writeFile(path.join(stateDir, 'seat-credentials.json'), JSON.stringify({ username: '2024000001', password: 'legacy' }), 'utf8');
  const loaded = await loadAccount(stateDir);
  assert.equal(loaded.username, '2024000001');
  assert.equal(loaded.password, 'legacy');
  assert.equal(loaded.source, 'seat-legacy');
  await clearAccount(stateDir);
  const cleared = await loadAccount(stateDir);
  assert.equal(cleared.source, 'seat-legacy', '清除统一账号后仍可回退旧凭据');
});
