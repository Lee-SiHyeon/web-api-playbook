import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {metaRequest,sendMetaQuery} from '../lib/meta-bootstrap.mjs';
import {reserveThreadsRead,reserveThreadsReactionReadback,consumeThreadsReadReservation} from '../lib/threads-read-budget.mjs';
const scope={ownerId:'17824859444',handle:'fixture.person',postId:'3996994421430736442'};
const operation='BarcelonaPostPageTargetQuery';
function context(root,reservation,fetchImpl){return {
 service:'threads',handle:scope.handle,url:`https://www.threads.com/@${scope.handle}/`,createdAt:Date.now(),requestCount:0,
 readBudgetRoot:root,readBudgetLimits:{perMinute:2,perHour:2},throttleRoot:root,readBudgetReservation:reservation,fetchImpl,
 bundle:{service:'threads',owner:'lifehack__ailab',ownerId:scope.ownerId,origin:'https://www.threads.com',
  cookies:[{name:'csrftoken',value:'fixture-csrf',domain:'threads.com',path:'/',secure:true}]},
 sources:new Map([['DTSGUtils',{source:'SprinkleConfig value.charCodeAt(i)'}]]),
 document:{modules:new Map([
  ['DTSGInitialData',{token:'fixture-dtsg'}],['LSD',{token:'fixture-lsd'}],
  ['SprinkleConfig',{param_name:'jazoest',version:2,should_randomize:false}],
  ['SiteData',{haste_session:'h',pr:1,client_revision:2,hsi:3,comet_env:1,__spin_r:4,__spin_b:'trunk',__spin_t:4}],
  ['CurrentUserInitialData',{USER_ID:'0'}],['RelayAPIConfigDefaults',{actorID:scope.ownerId,customHeaders:{'x-ig-app-id':'fixture-app'}}],
 ])},
};}
async function fixture(t){
 const root=await mkdtemp(path.join(os.tmpdir(),'threads-readback-transport-'));
 t.after(()=>rm(root,{recursive:true,force:true}));
 const reservation=await reserveThreadsReactionReadback({...scope,root,limits:{perMinute:2,perHour:2}});
 await consumeThreadsReadReservation({...scope,reservation,operation:'ThreadsProfileDocumentRead'});
 return {root,reservation};
}
test('the maintained Meta transport spends the prepaid target read even when no additional quota remains',async t=>{
 const {root,reservation}=await fixture(t);let calls=0;
 await assert.rejects(reserveThreadsRead({root,limits:{perMinute:2,perHour:2},operation:'AnotherRead'}),{code:'THREADS_READ_BUDGET_WAIT'});
 const ctx=context(root,reservation,async()=>{calls++;const response=new Response(JSON.stringify({data:{fixture:true}}),{headers:{'content-type':'application/json'}});
  Object.defineProperty(response,'url',{value:'https://www.threads.com/api/graphql'});return response;});
 const request=metaRequest(ctx,operation,'12345678901234567',{postID:scope.postId});
 const result=await sendMetaQuery(ctx,request);
 assert.equal(result.payload.data.fixture,true);assert.equal(calls,1);
 assert.equal(JSON.parse(await readFile(path.join(root,'read-budget.json'),'utf8')).events.length,2);
 await assert.rejects(sendMetaQuery(ctx,request),{code:'THREADS_READ_RESERVATION_ALREADY_CONSUMED'});
 assert.equal(calls,1);
});
test('actual context owner, handle and target variables fence a ticket before transport dispatch',async t=>{
 const {root,reservation}=await fixture(t);let calls=0;
 const ctx=context(root,reservation,async()=>{calls++;throw new Error('unexpected dispatch');});
 const request=()=>metaRequest(ctx,operation,'12345678901234567',{postID:scope.postId});
 ctx.handle='other.person';await assert.rejects(sendMetaQuery(ctx,request()),{code:'THREADS_READ_RESERVATION_MISMATCH'});
 ctx.handle=scope.handle;ctx.bundle.ownerId='17824859445';await assert.rejects(sendMetaQuery(ctx,request()),{code:'THREADS_READ_RESERVATION_MISMATCH'});
 ctx.bundle.ownerId=scope.ownerId;
 await assert.rejects(sendMetaQuery(ctx,metaRequest(ctx,operation,'12345678901234567',{postID:'3996994421430736443'})),{code:'THREADS_READ_RESERVATION_MISMATCH'});
 assert.equal(calls,0);
 const ticket=JSON.parse(await readFile(path.join(root,'read-reservations',reservation.id+'.json'),'utf8'));
 assert.equal(ticket.operations[operation].consumedAt,null);assert.equal(ticket.operations[operation].consumingAt,null);
});
