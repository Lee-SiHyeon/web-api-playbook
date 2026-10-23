import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { reserveThreadsRead, reserveThreadsReactionReadback } from '../lib/threads-read-budget.mjs';
import { readThreadsPublicActor, writeThreadsPublicActor, THREADS_PUBLIC_PROFILE_CACHE_TTL_MS } from '../lib/threads-public-profile-cache.mjs';
import { threadsBenefitWorkerCooldown } from '../threads-benefit-worker.mjs';
import { applyThreadsCooldownStatus } from '../lib/threads-graphql-throttle.mjs';

async function withRoot(prefix, run) {
  const root=await mkdtemp(path.join(os.tmpdir(),prefix));
  try { await run(root); } finally { await rm(root,{recursive:true,force:true}); }
}

test('shared read reservations enforce a cross-worker minute budget and resume at its deadline',async()=>{
  await withRoot('threads-read-budget-',async root=>{
    const limits={perMinute:2,perHour:3};
    assert.equal((await reserveThreadsRead({operation:'ProfileRead',root,now:100_000,limits})).reserved,true);
    await reserveThreadsRead({operation:'RelationshipRead',root,now:100_010,limits});
    await assert.rejects(reserveThreadsRead({operation:'ProfileRead',root,now:100_020,limits}),error=>{
      assert.equal(error.code,'THREADS_READ_BUDGET_WAIT');
      assert.equal(error.dispatchStarted,false);assert.equal(error.writeSent,false);
      assert.equal(error.retryAt,160_000);return true;
    });
    const before=JSON.parse(await readFile(path.join(root,'read-budget.json'),'utf8'));
    assert.equal(before.events.length,2);
    await reserveThreadsRead({operation:'ProfileRead',root,now:160_000,limits});
    const after=JSON.parse(await readFile(path.join(root,'read-budget.json'),'utf8'));
    assert.equal(after.events.length,3);assert.equal(JSON.stringify(after).includes('cookie'),false);
  });
});

test('shared budget waits become resumable worker cooldown status',()=>{
  const retryAt=500_000;
  const cooldown=threadsBenefitWorkerCooldown({code:'THREADS_READ_BUDGET_WAIT',retryAt,receipt:{localBudget:true,readBudgetRetryAt:retryAt}},100_000);
  assert.equal(cooldown.code,'THREADS_READ_BUDGET_WAIT');assert.equal(cooldown.retryAt,retryAt);
  assert.equal(cooldown.httpStatus,undefined,'a local budget wait did not receive an HTTP response');
  const status={};applyThreadsCooldownStatus(status,cooldown);
  assert.equal(status.status,'waiting_for_read_budget');assert.equal(status.deadlineSource,'local_budget');
  assert.equal(status.httpStatus,undefined);
});

test('a small backwards clock adjustment cannot erase an already charged read',async()=>{
  await withRoot('threads-budget-clock-',async root=>{
    const limits={perMinute:1,perHour:2};
    await reserveThreadsRead({operation:'ProfileRead',root,now:100020,limits});
    await assert.rejects(reserveThreadsRead({operation:'ProfileRead',root,now:100010,limits}),
      error=>error.code==='THREADS_READ_BUDGET_WAIT' && error.retryAt===160020);
    assert.deepEqual(JSON.parse(await readFile(path.join(root,'read-budget.json'),'utf8')).events,[100020]);
  });
});

test('benefit and outreach share public actor/profile snapshots for ten minutes',async()=>{
  await withRoot('threads-public-profile-cache-',async root=>{
    const now=Date.parse('2026-10-01T00:00:00Z'),handle='fixture.person';
    const profile={handle,posts:[{id:'3998102096557632423',code:'Dd85Wi-FOtU',author:handle,
      url:`https://www.threads.com/@${handle}/post/Dd85Wi-FOtU`,text:'public fixture',publishedAt:'2026-10-01T00:00:00Z'}],
      pinnedPosts:[],fullTimeline:true,coverage:'complete',pinState:'not_exposed'};
    await writeThreadsPublicActor({handle,id:'12345678901',ownerId:'17824859444',
      relationship:{following:false,outgoingRequest:false,blocking:false},followsOwner:true,private:false,profile},{root,now});
    const benefitRead=await readThreadsPublicActor(handle,{root,now:now+1000,requireProfile:true});
    const outreachRead=await readThreadsPublicActor(handle,{root,now:now+2000});
    assert.equal(benefitRead.id,'12345678901');assert.equal(benefitRead.profile.posts[0].text,'public fixture');
    assert.equal(outreachRead.relationship.outgoingRequest,false);
    assert.equal(await readThreadsPublicActor(handle,{root,now:now+THREADS_PUBLIC_PROFILE_CACHE_TTL_MS,requireProfile:true}),null);
    const cache=await readFile(path.join(root,(await import('node:crypto')).createHash('sha256').update(handle).digest('hex'),'snapshot.json'),'utf8');
    assert.equal(cache.includes('cookie'),false);assert.equal(cache.includes('csrf'),false);
  });
});

test('a short per-minute wait is waited out in place; an hour-window wait still throws',async()=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'threads-budget-inline-'));
  try{
    const limits={perMinute:2,perHour:3};const slept=[];
    await reserveThreadsRead({operation:'ProfileRead',root,limits,maxInlineWaitMs:75_000});
    await reserveThreadsRead({operation:'ProfileRead',root,limits,maxInlineWaitMs:75_000});
    const realNow=Date.now;let offset=0;Date.now=()=>realNow()+offset;
    try{
      const third=await reserveThreadsRead({operation:'ProfileRead',root,limits,maxInlineWaitMs:75_000,sleep:async ms=>{slept.push(ms);offset+=ms;}});
      assert.equal(third.reserved,true);assert.equal(slept.length,1);assert.ok(slept[0]>50_000&&slept[0]<=61_000);
      await assert.rejects(reserveThreadsRead({operation:'ProfileRead',root,limits,maxInlineWaitMs:75_000,sleep:async ms=>{offset+=ms;}}),
        error=>error.code==='THREADS_READ_BUDGET_WAIT');
    }finally{Date.now=realNow;}
  }finally{await rm(root,{recursive:true,force:true});}
});

test('the reaction readback pair waits for both short-deadline slots instead of restarting its preflight',async()=>{
 await withRoot('threads-readback-inline-',async root=>{
  const limits={perMinute:2,perHour:4};
  await reserveThreadsRead({root,limits,operation:'BeforeRead'});
  await reserveThreadsRead({root,limits,operation:'BeforeRead'});
  const realNow=Date.now;let offset=0;const sleeps=[];
  Date.now=()=>realNow()+offset;
  try{
   const options={root,limits,ownerId:'17824859444',handle:'fixture.person',postId:'3996994421430736442',maxInlineWaitMs:75000,
    sleep:async ms=>{sleeps.push(ms);offset+=ms;}};
   const ticket=await reserveThreadsReactionReadback(options);
   assert.ok(ticket.id);assert.equal(sleeps.length,1);assert.ok(sleeps[0]>50000&&sleeps[0]<61000);
   await assert.rejects(reserveThreadsReactionReadback(options),{code:'THREADS_READ_BUDGET_WAIT'});
   assert.equal(sleeps.length,1,'a long hourly wait is left to the worker');
  }finally{Date.now=realNow;}
 });
});
