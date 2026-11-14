import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createWindowsZip } from '../scripts/windows-zip.mjs';

test('ZIP rejects absent, non-string and relative paths before spawning', () => {
  const absolute = path.resolve('zip-input');
  for (const args of [undefined, {sourcePath: null, destinationPath: absolute}, {sourcePath: absolute, destinationPath: null}, {sourcePath: 'relative', destinationPath: absolute}, {sourcePath: absolute, destinationPath: 'relative'}])
    assert.throws(() => createWindowsZip(args), /absolute paths/);
});
test('ZIP passes Unicode, spaces and apostrophes as literal native arguments', () => {
  const sourcePath = path.resolve("space 中文 ' source");
  const destinationPath = path.resolve("output 中文 '.zip");
  let called = false;
  createWindowsZip({sourcePath, destinationPath}, (exe, args, options) => {
    called = true; assert.equal(exe, 'powershell.exe');
    assert.equal(args.at(-3), sourcePath); assert.equal(args.at(-1), destinationPath);
    assert.ok(args.includes('-File')); assert.ok(!args.includes('-Command'));
    assert.equal(options.stdio, 'inherit'); assert.equal(options.windowsHide, true);
  });
  assert.equal(called, true);
});
test('ZIP propagates native writer failure instead of publishing success', () => {
  const sourcePath = path.resolve('source'), destinationPath = path.resolve('target.zip');
  assert.throws(() => createWindowsZip({sourcePath,destinationPath}, () => { throw new Error('native failure'); }), /native failure/);
});
test('Windows compressed folders enumerate and actually extract native ZIP', {skip:process.platform !== 'win32'}, async t => {
  const temporary = await mkdtemp(path.join(tmpdir(), 'campus-zip 中文 '));
  t.after(() => rm(temporary, {recursive:true,force:true}));
  const sourcePath=path.join(temporary,'source'), destinationPath=path.join(temporary,'compatible.zip'), out=path.join(temporary,'extracted');
  await mkdir(path.join(sourcePath,'nested'),{recursive:true}); await mkdir(out);
  await writeFile(path.join(sourcePath,'notes.txt'),'native Windows ZIP\n');
  await writeFile(path.join(sourcePath,'nested','中文.txt'),'中文内容\n');
  await writeFile(path.join(sourcePath,'.keep'),'hidden-name\n');
  createWindowsZip({sourcePath,destinationPath});
  const quoted = s => "'"+s.replaceAll("'","''")+"'";
  const command = `$ErrorActionPreference='Stop'; $s=New-Object -ComObject Shell.Application; $z=$s.NameSpace(${quoted(destinationPath)}); if($z.Items().Count -ne 3){throw 'Unexpected Windows ZIP entries'}; $d=$s.NameSpace(${quoted(out)}); $d.CopyHere($z.Items(),1044); $until=(Get-Date).AddSeconds(15); while(-not (Test-Path -LiteralPath ${quoted(path.join(out,'nested','中文.txt'))})){if((Get-Date) -gt $until){throw 'Windows extraction timeout'};Start-Sleep -Milliseconds 50}; Write-Output 'WINDOWS_SHELL_EXTRACTED'`;
  const result=execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-STA','-Command',command],{encoding:'utf8',windowsHide:true});
  assert.match(result,/WINDOWS_SHELL_EXTRACTED/);
  assert.equal(await readFile(path.join(out,'nested','中文.txt'),'utf8'),'中文内容\n');
  assert.equal(await readFile(path.join(out,'notes.txt'),'utf8'),'native Windows ZIP\n');
  assert.equal(await readFile(path.join(out,'.keep'),'utf8'),'hidden-name\n');
});
