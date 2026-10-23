import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,readFile,readdir,rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { executeJournaled } from '../lib/journal.mjs';

async function isolatedJournal(run) {
  const root=await mkdtemp(path.join(os.tmpdir(),'threads-dispatch-stop-'));
  const previous=process.env.LOCALAPPDATA;process.env.LOCALAPPDATA=root;
  const ready={service:'threads',operation:'follow',target:'fixture_target',normalizedTarget:'17890000123456781',
    ownerFingerprint:'fixture',ready:true,auth:{ownerVerified:true}};
  try { await run({root,ready,input:{service:'threads',operation:'follow',target:'fixture_target'}}); }
  finally {
    if(previous===undefined)delete process.env.LOCALAPPDATA;else process.env.LOCALAPPDATA=previous;
    const resolved=path.resolve(root);
    assert.ok(resolved.startsWith(path.resolve(os.tmpdir())+path.sep)&&path.basename(resolved).startsWith('threads-dispatch-stop-'));
    await rm(resolved,{recursive:true,force:true});
  }
}

test('an explicit false dispatch guard is verified unsent and does not retain a pending reservation',async()=>{
  await isolatedJournal(async({root,ready,input})=>{
    let mutations=0;
    const provider={prepare:async()=>ready,execute:async(_input,{beforeWrite})=>{
      await beforeWrite(ready);mutations++;
    }};
    const receipt=await executeJournaled(input,provider,{beforeWrite:async()=>false});
    assert.equal(mutations,0);assert.equal(receipt.code,'SOCIAL_ACTION_STOPPED_BEFORE_WRITE');
    assert.equal(receipt.notSentVerified,true);assert.equal(receipt.dispatchStarted,false);
    assert.equal(receipt.needs_reconciliation,false);assert.equal(receipt.mutationCount,0);
    assert.equal((await readdir(path.join(root,'affiliate-content-operations/social-actions/pending'))).length,0);
  });
});

for(const failure of ['after_dispatch','duplicate_barrier'])test(`${failure} retains the original attempt and blocks a second mutation`,async()=>{
  await isolatedJournal(async({root,ready,input})=>{
    let mutations=0;
    const provider={prepare:async()=>ready,execute:async(_input,{beforeWrite})=>{
      await beforeWrite(ready);mutations++;
      if(failure==='duplicate_barrier')await beforeWrite(ready);
      else throw Object.assign(new Error(),{code:'THREADS_TEST_TRANSPORT_AMBIGUOUS'});
    }};
    const receipt=await executeJournaled(input,provider,{beforeWrite:async()=>true});
    assert.equal(mutations,1);assert.equal(receipt.status,'outcome_unknown');
    assert.equal(receipt.needs_reconciliation,true);assert.equal(receipt.mutationCount,1);
    assert.notEqual(receipt.notSentVerified,true);
    const original=JSON.parse(await readFile(receipt.journalPath,'utf8'));
    assert.equal(original.attempts,1);assert.equal(original.status,'needs_reconciliation');
    assert.equal((await readdir(path.join(root,'affiliate-content-operations/social-actions/pending'))).length,1);
    const later=await executeJournaled(input,provider,{beforeWrite:async()=>true});
    assert.equal(later.code,'SOCIAL_PENDING_ACTION_RECONCILE_FIRST');assert.equal(mutations,1);
    assert.deepEqual(JSON.parse(await readFile(receipt.journalPath,'utf8')),original);
  });
});

test('STOP during a follow preflight blocks dispatch and preserves an affirmative zero-send journal',async()=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'threads-dispatch-stop-'));
  const previous=process.env.LOCALAPPDATA;
  process.env.LOCALAPPDATA=root;
  try {
    let stopped=false,mutations=0;
    const ready={service:'threads',operation:'follow',target:'fixture_target',normalizedTarget:'17890000123456781',
      ownerFingerprint:'fixture',ready:true,auth:{ownerVerified:true}};
    const provider={prepare:async()=>ready,execute:async(_input,{beforeWrite})=>{
      stopped=true; // A slow preflight finishes after the owner has stopped the bot.
      await beforeWrite(ready);
      mutations++;
      return {...ready,success:true,readbackVerified:true,mutationCount:1,currentState:{following:true}};
    }};
    const receipt=await executeJournaled({service:'threads',operation:'follow',target:'fixture_target'},provider,
      {beforeWrite:async()=>{if(stopped)throw Object.assign(new Error(),{code:'THREADS_BENEFIT_STOPPED'});return true;}});
    assert.equal(mutations,0);
    assert.equal(receipt.status,'not_sent');
    assert.equal(receipt.notSentVerified,true);
    assert.equal(receipt.mutationCount,0);
    assert.equal(receipt.writeSent,false);
    assert.equal(receipt.dispatchStarted,false);
    assert.equal(receipt.needs_reconciliation,false);
    const original=JSON.parse(await readFile(receipt.journalPath,'utf8'));
    assert.equal(original.attempts,0);
    assert.equal(original.notSentVerified,true);
    assert.equal((await readdir(path.join(root,'affiliate-content-operations/social-actions/pending'))).length,0);

    const later=await executeJournaled({service:'threads',operation:'follow',target:'fixture_target'},provider,
      {beforeWrite:async()=>true});
    assert.equal(later.success,true);
    assert.equal(mutations,1);
    assert.notEqual(later.journalPath,receipt.journalPath);
    assert.deepEqual(JSON.parse(await readFile(receipt.journalPath,'utf8')),original);
  } finally {
    if(previous===undefined)delete process.env.LOCALAPPDATA;else process.env.LOCALAPPDATA=previous;
    const resolved=path.resolve(root);
    assert.ok(resolved.startsWith(path.resolve(os.tmpdir())+path.sep)&&path.basename(resolved).startsWith('threads-dispatch-stop-'));
    await rm(resolved,{recursive:true,force:true});
  }
});
