import {readFile,writeFile,mkdir} from 'node:fs/promises';
import path from 'node:path';
import {root} from '../lib/services.mjs';
const lock = JSON.parse(await readFile(path.join(root,'package-lock.json'),'utf8'));
const rows = [];
for (const [location, entry] of Object.entries(lock.packages)) {
  if (!location.includes('node_modules/') || entry.link) continue;
  let metadata;
  try { metadata = JSON.parse(await readFile(path.join(root,location,'package.json'),'utf8')); }
  catch (e) { if (e.code === 'ENOENT' && entry.optional) continue; throw e; }
  rows.push({name:metadata.name,version:metadata.version,license:metadata.license || entry.license || 'UNSPECIFIED',development:Boolean(entry.dev),optional:Boolean(entry.optional),location,
    repository:typeof metadata.repository === 'string' ? metadata.repository : metadata.repository?.url || metadata.homepage || ''});
}
// Optional native packages vary by host. Include their lockfile metadata for a stable cross-host inventory.
for (const [location,entry] of Object.entries(lock.packages)) {
  if (!location.includes('node_modules/') || entry.link || rows.some(r => r.location === location)) continue;
  rows.push({name:entry.name || location.split('node_modules/').at(-1),version:entry.version,license:entry.license || 'UNSPECIFIED',development:Boolean(entry.dev),optional:Boolean(entry.optional),location,repository:''});
}
// All entries use lock metadata for reproducible output on clean installs across supported platforms.
for (const row of rows) {
  const locked = lock.packages[row.location];
  row.license = locked.license || row.license;
  delete row.repository;
}
rows.sort((a,b) => a.location < b.location ? -1 : a.location > b.location ? 1 : 0);
const json = JSON.stringify({lockfileVersion:lock.lockfileVersion,packages:rows},null,2)+'\n';
const md = '# npm dependency licenses\n\nGenerated from the root package-lock.json. Includes runtime, development and optional platform dependencies. Module source licenses and vendored thu-learn-lib are recorded separately in THIRD_PARTY_NOTICES.md.\n\n| Package | Version | License | Scope |\n| --- | --- | --- | --- |\n'+rows.map(r => `| ${r.name} | ${r.version} | ${r.license} | ${r.development ? 'development' : 'runtime'}${r.optional ? ', optional' : ''} |`).join('\n')+'\n';
const check = process.argv.includes('--check');
for (const [filename,content] of [['dependency-licenses.json',json],['DEPENDENCIES.md',md]]) {
  const file = path.join(root,'docs',filename);
  if (check) {
    if (await readFile(file,'utf8') !== content) throw new Error(`${filename} is stale; run npm run licenses`);
  } else { await mkdir(path.dirname(file),{recursive:true}); await writeFile(file,content); }
}
console.log(`${check ? 'Verified' : 'Generated'} ${rows.length} locked npm dependency license records.`);
