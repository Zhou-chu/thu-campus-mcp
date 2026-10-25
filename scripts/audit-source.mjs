import {execFileSync} from 'node:child_process';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {root} from '../lib/services.mjs';
const git = (...args) => execFileSync('git',args,{cwd:root,maxBuffer:32*1024*1024});
const names = git('ls-files','--cached','--others','--exclude-standard','-z').toString('utf8').split('\0').filter(Boolean);
const rules = [
  ['private-key',/-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/],
  ['github-token',/\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})\b/],
  ['model-key',/\bsk-(?:proj-|ant-)?[A-Za-z0-9_-]{32,}/],
  ['session-cookie',/\b(?:JSESSIONID|CASTGC|TGC)=[A-Za-z0-9._-]{24,}/],
];
const findings = [];
function scan(text,location) { for (const [rule,regex] of rules) if (regex.test(text)) findings.push({location,rule}); }
for (const name of names) {
  if (/(?:^|\/)(?:node_modules|dist|downloads|\.local|\.superpowers)(?:\/|$)|(?:^|\/)\.env(?:$|\.)|\.dpapi$/i.test(name)) findings.push({location:name,rule:'private-or-generated-path'});
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
