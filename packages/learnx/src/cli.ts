#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { createInterface } from 'node:readline/promises';
import { emitKeypressEvents } from 'node:readline';
import { stdin, stdout } from 'node:process';
import { CookieJar } from 'tough-cookie';
import { AuthStore, type AuthData } from './auth.js';
import { createClient } from './client.js';
import { loadConfig } from './config.js';
import { serve } from './server.js';
import { runJob } from './jobs.js';
import { SyncService } from './sync.js';
import { LearnError, publicError } from './types.js';

async function hidden(prompt: string): Promise<string> {
  if (!stdin.isTTY) throw new LearnError('TTY_REQUIRED', '交互登录需要本机终端；非交互请使用 auth import --stdin。');
  stdout.write(prompt); emitKeypressEvents(stdin); stdin.setRawMode(true); stdin.resume();
  return new Promise((resolve, reject) => {
    let value = '';
    const stop = () => { stdin.setRawMode(false); stdin.off('keypress', handler); stdin.pause(); stdout.write('\n'); };
    const handler = (str: string, key: { name: string; ctrl: boolean }) => {
      if (key.name === 'return') { stop(); resolve(value); }
      else if (key.ctrl && key.name === 'c') { stop(); reject(new LearnError('CANCELLED', '已取消。')); }
      else if (key.name === 'backspace') value = value.slice(0, -1);
      else if (str && !key.ctrl) value += str;
    }; stdin.on('keypress', handler);
  });
}
async function text(prompt: string) { const rl = createInterface({ input: stdin, output: stdout }); try { return (await rl.question(prompt)).trim(); } finally { rl.close(); } }
export async function importAuth(raw: any): Promise<AuthData> {
  if (!raw || typeof raw.account !== 'string' || !raw.account.trim()) throw new LearnError('AUTH_FORMAT', 'JSON 必须包含 account，以及 cookieJar/cookies + csrfToken，或 username/password/fingerPrint。');
  if (raw.cookies && !raw.cookieJar) {
    const jar = new CookieJar();
    if (!Array.isArray(raw.cookies)) throw new LearnError('AUTH_FORMAT', 'cookies 必须是浏览器导出的 Cookie 数组。');
    for (const c of raw.cookies) {
      const domain = String(c.domain || '').replace(/^\./, '');
      if (!['learn.tsinghua.edu.cn', 'id.tsinghua.edu.cn'].includes(domain)) continue;
      await jar.setCookie(`${c.name}=${c.value}; Domain=${c.domain}; Path=${c.path || '/'}${c.secure ? '; Secure' : ''}${c.httpOnly ? '; HttpOnly' : ''}`, `https://${domain}`);
    }
    raw.cookieJar = jar.toJSON();
  }
  if (!(raw.cookieJar && typeof raw.csrfToken === 'string' && raw.csrfToken) && !(raw.username && raw.password && raw.fingerPrint)) throw new LearnError('AUTH_FORMAT', '缺少有效会话的 cookieJar/cookies 与 csrfToken，或账号密码与实际设备指纹。');
  return { account: raw.account, username: raw.username, password: raw.password, fingerPrint: raw.fingerPrint, fingerGenPrint: raw.fingerGenPrint, fingerGenPrint3: raw.fingerGenPrint3, cookieJar: raw.cookieJar, csrfToken: raw.csrfToken };
}
async function main() {
  const [command = 'help', sub, ...args] = process.argv.slice(2); const config = loadConfig(); const store = new AuthStore(config.stateDir);
  const flag = (name: string) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
  const print = (value: unknown) => stdout.write(JSON.stringify(value, null, 2) + '\n');
  if (command === 'serve') { await serve(config); return; }
  if (command === 'worker') { await runJob(config, sub); return; }
  if (command === 'status' || command === 'doctor') { print({ config: { ...config, stateDir: config.stateDir }, authentication: await store.status(), sessionValidity: 'not_checked', node: process.version }); return; }
  if (command === 'auth') {
    if (sub === 'logout') { await store.clear(); print({ configured: false }); return; }
    if (sub === 'status') { print(await store.status()); return; }
    if (sub === 'browser') {
      const account = flag('--account') || await text('会话所属网络学堂账号（仅用于本地账号绑定）：');
      const { browserLogin } = await import('./browser-auth.js'); print(await browserLogin(store, account, flag('--channel') || 'msedge')); return;
    }
    let auth: AuthData;
    if (sub === 'login') {
      const username = await text('网络学堂账号：'); const password = await hidden('密码（不显示）：');
      const fingerPrint = await text('实际设备 fingerPrint（从本机已登录浏览器获取）：');
      auth = { account: username, username, password, fingerPrint };
    } else if (sub === 'import') {
      let input: string;
      if (args.includes('--stdin')) { const chunks = []; for await (const c of stdin) chunks.push(c); input = Buffer.concat(chunks).toString('utf8'); }
      else if (flag('--file')) input = await readFile(flag('--file')!, 'utf8');
      else throw new LearnError('AUTH_USAGE', '使用 auth import --file <本地会话 JSON> 或 auth import --stdin；不要把凭据写入聊天。');
      auth = await importAuth(JSON.parse(input));
    } else throw new LearnError('AUTH_USAGE', '可用命令：auth browser / login / import / status / logout');
    await store.save(auth); print({ configured: true, verified: false, message: '已使用 Windows DPAPI 保存。本机运行 sync 或查询学期可验证学校会话。' }); return;
  }
  if (command === 'sync') {
    const syncArgs = [sub, ...args].filter(Boolean); const value = (name: string) => { const i = syncArgs.indexOf(name); return i < 0 ? undefined : syncArgs[i + 1]; };
    print(await new SyncService(await createClient(config)).run({ outputDir: value('--output') || config.outputDir, semesterId: value('--semester'), courseId: value('--course') })); return;
  }
  if (command === 'install' || command === 'uninstall') {
    const { installClients } = await import('./install.js'); print(await installClients({ apply: sub === '--apply' || args.includes('--apply'), uninstall: command === 'uninstall' })); return;
  }
  stdout.write('learnX MCP\n\nnode dist/cli.js serve\nnode dist/cli.js auth browser [--account 学号] [--channel msedge|chrome]\nnode dist/cli.js auth login\nnode dist/cli.js auth import --file <会话.json>\nnode dist/cli.js auth status\nnode dist/cli.js sync --output <绝对目录> [--semester 学期ID] [--course 课程ID]\nnode dist/cli.js install [--apply]\nnode dist/cli.js uninstall [--apply]\nnode dist/cli.js doctor\n\n离线演示：先设置 LEARNX_MOCK=1；不要把密码、Cookie 或设备指纹发到聊天中。\n');
}
main().catch(error => { process.stderr.write(JSON.stringify(publicError(error)) + '\n'); process.exitCode = 1; });
