import assert from 'node:assert/strict';
import {mkdtemp,cp,symlink,rm,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {root,services} from '../lib/services.mjs';
const temporary = await mkdtemp(path.join(tmpdir(),'campus bundle 测试 '));
const moved = path.join(temporary,'renamed campus');
const clients=[];
try {
  await mkdir(moved);
  for (const name of ['bin','lib','packages']) await cp(path.join(root,name),path.join(moved,name),{recursive:true,filter:p=>!p.split(path.sep).includes('node_modules')&&!p.split(path.sep).includes('downloads')});
  await symlink(path.join(root,'node_modules'),path.join(moved,'node_modules'),process.platform==='win32'?'junction':'dir');
  let count=0;
  for(const s of services) {
    const client=new Client({name:'bundle-relocation-smoke',version:'1'});
    clients.push(client);
    await client.connect(new StdioClientTransport({command:process.execPath,args:[path.join(moved,'bin/thu-campus.mjs'),s.name,'serve'],cwd:temporary,env:{...process.env,[s.prefix+'_MOCK']:'1',[s.prefix+'_STATE_DIR']:path.join(temporary,'state',s.name),[s.prefix+'_OUTPUT_DIR']:path.join(temporary,'output',s.name),HETANG_CLOUD_CLI:''},stderr:'pipe'}));
    const tools=(await client.listTools()).tools;
    assert.equal(tools.length,s.count);
    const statusTool={learnx:'learn_status',cloud:'cloud_status',hetang:'rain_status'}[s.name];
    const status=await client.callTool({name:statusTool,arguments:{}});
    assert(!status.isError,JSON.stringify(status.structuredContent));
    const data=status.structuredContent || JSON.parse(status.content.find(c=>c.type==='text').text);
    assert.equal(data.mode || (data.config?.mock && 'mock'),'mock');
    count+=tools.length;
    await client.close();
  }
  const {pathToFileURL}=await import('node:url');
  const {loadConfig}=await import(pathToFileURL(path.join(moved,'packages/hetang/dist/config.js')).href);
  assert.equal(loadConfig().cloudCli,path.join(moved,'packages/thu-cloud/dist/cli.js'));
  console.log(`PASS: relocated Unicode/space path, shared installed dependencies, three unified stdio commands and ${count} mock tools; bundled cloud path.`);
} finally {
  for(const c of clients) await c.close().catch(()=>{});
  await rm(temporary,{recursive:true,force:true,maxRetries:5,retryDelay:200});
}
