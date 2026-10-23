import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {readBudgetObservation,readBudgetNotBefore,withReadBudget,assertReadCapacity} from '../x-read-budget.mjs';
test('observed remaining capacity paces reads until the actual reset and discards private headers',()=>{
 const now=1000000;
 const budget=readBudgetObservation({status:200,headers:{'x-rate-limit-limit':'300','x-rate-limit-remaining':'150','x-rate-limit-reset':'1900',authorization:'private'}},now);
 assert.equal(budget.remaining,150);
 assert.ok(budget.nextAt>=now+6000);
 assert.ok(!JSON.stringify(budget).includes('private'));
 assert.equal(readBudgetNotBefore(budget,1900001),1900001);
 const exhausted=readBudgetObservation({status:429,headers:{'x-rate-limit-reset':'1900','retry-after':'30'}},now);
 assert.equal(readBudgetNotBefore(exhausted,now),1900000);
 const retry=readBudgetObservation({status:429,headers:{'x-rate-limit-reset':'1030','retry-after':'60'}},now);
 assert.equal(readBudgetNotBefore(retry,now+31000),now+60000);
});
test('stage capacity is checked before reserving an account and preserves the actual server reset',async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'x-read-budget-'));const now=1000000;
 try{
  await withReadBudget(async()=>({status:200,headers:{'x-rate-limit-limit':'300','x-rate-limit-remaining':'30','x-rate-limit-reset':'1900'}}),{root,owner:'fixture',operation:'TweetDetail',now:()=>now});
  await assertReadCapacity('fixture','TweetDetail',{root,now,needed:6});
  await assert.rejects(assertReadCapacity('fixture','TweetDetail',{root,now,needed:21}),e=>e.code==='X_READ_BUDGET_WAIT'&&e.receipt.rateLimitReset===1900&&e.receipt.readBudgetRetryAt===1900000);
 }finally{await rm(root,{recursive:true,force:true});}
});
test('rate observations survive a new caller without transmitting an exhausted read',async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'x-read-budget-'));
 const now=1000000;let reads=0;
 try{
  const options={root,now:()=>now,wait:async()=>{},owner:'fixture',operation:'TweetDetail'};
  await withReadBudget(async()=>{reads++;return{status:429,headers:{'x-rate-limit-reset':'1900'}};},options);
  await assert.rejects(withReadBudget(async()=>{reads++;},options),{code:'X_READ_BUDGET_WAIT'});
  assert.equal(reads,1);
 }finally{await rm(root,{recursive:true,force:true});}
});
