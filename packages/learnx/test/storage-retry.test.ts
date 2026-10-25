import {it,expect,vi,afterEach} from 'vitest';
import {mkdtemp,rename,rm,readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {atomicJson,readJson} from '../src/storage.js';
vi.mock('node:fs/promises',async original=>{
  const actual=await original<typeof import('node:fs/promises')>();
  return {...actual,rename:vi.fn(actual.rename)};
});
afterEach(()=>vi.mocked(rename).mockReset());
it.skipIf(process.platform!=='win32')('recovers atomic replacement from transient Windows reader sharing violations',async()=>{
  const directory=await mkdtemp(path.join(tmpdir(),'learnx-replace-'));
  try {
    const file=path.join(directory,'job.json');
    await atomicJson(file,{status:'running'});
    vi.mocked(rename).mockClear();
    vi.mocked(rename).mockRejectedValueOnce(Object.assign(new Error('sharing'),{code:'EPERM'})).mockRejectedValueOnce(Object.assign(new Error('busy'),{code:'EBUSY'}));
    await atomicJson(file,{status:'complete'});
    expect(await readJson(file)).toEqual({status:'complete'});
    expect(rename).toHaveBeenCalledTimes(3);
    expect(await readdir(directory)).toEqual(['job.json']);
  } finally {await rm(directory,{recursive:true,force:true});}
});
it('does not retry unrelated filesystem failures or replace the previous valid job',async()=>{
  const directory=await mkdtemp(path.join(tmpdir(),'learnx-replace-'));
  try {
    const file=path.join(directory,'job.json');
    await atomicJson(file,{status:'running'});
    vi.mocked(rename).mockClear();
    vi.mocked(rename).mockRejectedValueOnce(Object.assign(new Error('io failure'),{code:'EIO'}));
    await expect(atomicJson(file,{status:'complete'})).rejects.toMatchObject({code:'EIO'});
    expect(rename).toHaveBeenCalledTimes(1);
    expect(await readJson(file)).toEqual({status:'running'});
    expect(await readdir(directory)).toEqual(['job.json']);
  } finally {await rm(directory,{recursive:true,force:true});}
});
it.skipIf(process.platform!=='win32')('bounds persistent Windows sharing failures and preserves previous data',async()=>{
  const directory=await mkdtemp(path.join(tmpdir(),'learnx-replace-'));
  try {
    const file=path.join(directory,'job.json');
    await atomicJson(file,{status:'running'});
    vi.mocked(rename).mockClear();
    vi.mocked(rename).mockRejectedValue(Object.assign(new Error('denied'),{code:'EACCES'}));
    await expect(atomicJson(file,{status:'complete'})).rejects.toMatchObject({code:'EACCES'});
    expect(vi.mocked(rename).mock.calls.length).toBeGreaterThan(1);
    expect(vi.mocked(rename).mock.calls.length).toBeLessThanOrEqual(20);
    expect(await readJson(file)).toEqual({status:'running'});
    expect(await readdir(directory)).toEqual(['job.json']);
  } finally {await rm(directory,{recursive:true,force:true});}
});
