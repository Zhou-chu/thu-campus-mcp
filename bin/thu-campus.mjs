#!/usr/bin/env node
import {spawn} from 'node:child_process';
import {access} from 'node:fs/promises';
import {service,modulePath,serviceEnvironment,clientConfig} from '../lib/services.mjs';
const help = `清华校园 MCP 整合包\n\nnode bin/thu-campus.mjs <learnx|cloud|hetang> <服务命令>\nnode bin/thu-campus.mjs config\nnode bin/thu-campus.mjs install [--apply]\nnode bin/thu-campus.mjs uninstall [--apply]\n\n示例：node bin/thu-campus.mjs hetang auth browser\n构建：npm ci && npm run build\n三个服务独立保存认证；解题使用当前 Harness 模型。\n`;
async function main() {
  const [command,...args] = process.argv.slice(2);
  if (!command || ['help','--help','-h'].includes(command)) { process.stdout.write(help); return; }
  if (command === 'config') {
    process.stdout.write(JSON.stringify(await clientConfig(),null,2)+'\n'); return;
  }
  if (command === 'install' || command === 'uninstall') {
    if (args.some(a => a !== '--apply')) throw Object.assign(new Error('安装命令仅支持 --apply；不加该参数只预览。'),{code:'USAGE'});
    const {installBundle} = await import('../lib/install.mjs');
    process.stdout.write(JSON.stringify(await installBundle({apply:args.includes('--apply'),uninstall:command==='uninstall'}),null,2)+'\n'); return;
  }
  const selected = service(command), target = modulePath(selected);
  await access(target).catch(() => { throw Object.assign(new Error('模块尚未构建，请先执行 npm ci 和 npm run build。'),{code:'BUILD_REQUIRED'}); });
  const child = spawn(process.execPath,[target,...(args.length ? args : ['help'])],{stdio:'inherit',windowsHide:true,env:serviceEnvironment()});
  const forward = signal => { if (!child.killed) child.kill(signal); };
  const interrupt = () => forward('SIGINT'), terminate = () => forward('SIGTERM');
  process.on('SIGINT',interrupt); process.on('SIGTERM',terminate);
  const result = await new Promise((resolve,reject) => { child.once('error',reject); child.once('exit',(code,signal) => resolve(code ?? (signal ? 1 : 0))); });
  process.off('SIGINT',interrupt); process.off('SIGTERM',terminate);
  process.exitCode = result;
}
main().catch(error => {
  const code = error.code || 'BUNDLE_ERROR';
  const message = code === 'ERR_MODULE_NOT_FOUND' ? '模块尚未构建，请先执行 npm ci 和 npm run build。' : error.message;
  process.stderr.write(JSON.stringify({code,message})+'\n');
  process.exitCode = ['UNKNOWN_SERVICE','USAGE'].includes(code) ? 2 : 1;
});
