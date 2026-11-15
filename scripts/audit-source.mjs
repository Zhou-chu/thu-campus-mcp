import {execFileSync} from 'node:child_process';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {root} from '../lib/services.mjs';
import {isPrivateOrGeneratedPath, scanText, PRIVATE_GENERATED_PATH_RULE} from './audit-patterns.mjs';
import {resolveExecutable,trustedEnv} from './trusted-path.mjs';
// PATH 固定到受信任目录，避免工作区/临时目录里的同名 git 被优先执行。
const gitEnv = trustedEnv();
const gitBin = resolveExecutable('git');
const git = (...args) => execFileSync(gitBin,args,{cwd:root,maxBuffer:32*1024*1024,env:gitEnv});
const names = git('ls-files','--cached','--others','--exclude-standard','-z').toString('utf8').split('\0').filter(Boolean);
const findings = [];
function scan(text,location) { for (const rule of scanText(text)) findings.push({location,rule}); }
for (const name of names) {
  if (isPrivateOrGeneratedPath(name)) findings.push({location:name,rule:PRIVATE_GENERATED_PATH_RULE});
  scan(await readFile(path.join(root,name),'utf8'),name);
}
let blobs = 0;
for (const row of git('rev-list','--objects','--all').toString('utf8').split('\n').filter(Boolean)) {
  const [sha] = row.split(' ');
  if (git('cat-file','-t',sha).toString().trim() !== 'blob') continue;
  scan(git('cat-file','blob',sha).toString('utf8'),sha); blobs++;
}
const snapshots = JSON.parse(await readFile(path.join(root,'docs/source-snapshots.json'),'utf8'));
for (const s of snapshots) {
  if (!/^[\da-f]{40}$/.test(s.sourceCommit) || !Object.keys(s.files).length) throw new Error('Invalid snapshot provenance');
  await readFile(path.join(root,'packages',s.package,'LICENSE'));
  for (const [filename,originalHash] of Object.entries(s.files)) {
    const hash=createHash('sha256').update(await readFile(path.join(root,'packages',s.package,filename))).digest('hex');
    if(hash !== (s.integrationChanges?.[filename]?.sha256 || originalHash)) findings.push({location:s.package+'/'+filename,rule:'undocumented-source-change'});
  }
}
await readFile(path.join(root,'packages/learnx/vendor/thu-learn-lib/LICENSE'));
console.log(JSON.stringify({files:names.length,historyBlobs:blobs,findings}));
if (findings.length) process.exitCode=1;