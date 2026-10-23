import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readdir,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {acquireRunLock} from '../lib/process-run-lock.mjs';

test('an active run is not replaced and releasing the owner allows restart',async()=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'api-run-lock-'));
  try {
    const release=await acquireRunLock(dir);
    await assert.rejects(acquireRunLock(dir),/ONBOARDING_RUN_LOCKED/);
    assert.equal((await readdir(dir)).length,1);
    await release();
    await (await acquireRunLock(dir))();
    assert.equal((await readdir(dir)).length,0);
  } finally {await rm(dir,{recursive:true});}
});

test('dead process locks are recovered without replaying a saved operation',async()=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'api-run-lock-'));
  try {
    await writeFile(path.join(dir,'active.lock'),JSON.stringify({pid:987654}));
    await writeFile(path.join(dir,'active-987654-00000000-0000-0000-0000-000000000000.lock'),'{}');
    const release=await acquireRunLock(dir,{isAlive:()=>false});
    assert.equal((await readdir(dir)).length,1);
    await release();
  } finally {await rm(dir,{recursive:true});}
});
