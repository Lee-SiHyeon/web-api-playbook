import test from 'node:test';
import assert from 'node:assert/strict';
import { recoveryDecision, readRetryAt } from '../x-recovery.mjs';
import { superviseOnce } from '../x-supervisor.mjs';
import { rewardStage } from '../x-rewards.mjs';
const now=1000000;
test('reflection bootstrap incident with an attempted quote stays held without dispatch evidence',()=>{
 const status={status:'blocked',code:'X_TRANSACTION_BOOTSTRAP_FAILED',workPhase:'processing',failurePhase:'write',currentHandle:'FinFinbiz',receipt:{}};
 const state={records:{'2106350208368222266':{handle:'FinFinbiz',status:'held',mode:'quote',quoteAttemptedAt:'2026-10-04T07:38:32.569Z',code:status.code,results:{like:{readbackVerified:true}}}}};
 const before=structuredClone(state);
 assert.deepEqual(recoveryDecision({status,state,now}),{action:'hold',reason:status.code});
 assert.equal(recoveryDecision({status,state,now,alive:true}).action,'observe');
 assert.equal(recoveryDecision({status,state,now,stop:true}).action,'stop');
 assert.deepEqual(state,before);
});
test('uncertain completion notice recovery requires the exact durable batch and all member fences',()=>{
 const status={status:'blocked',code:'SERVICE_ERROR',workPhase:'notice_write',currentNoticeBatchId:'batch',receipt:{operation:'CreateTweet'}};
 const state={records:{},completionNoticeBatches:{batch:{batchId:'batch',status:'needs_reconciliation',code:'SERVICE_ERROR',members:[{id:'123',stage:'full'}]}},completionNotices:{'123':{full:'batch'}}};
 const before=structuredClone(state);
 assert.equal(recoveryDecision({status,state,now}).action,'restart');
 assert.equal(recoveryDecision({status:{...status,currentNoticeBatchId:'missing'},state,now}).action,'hold');
 assert.equal(recoveryDecision({status,state:{...state,completionNotices:{}},now}).action,'hold');
 assert.equal(recoveryDecision({status,state,now,alive:true}).action,'observe');
 assert.equal(recoveryDecision({status,state,now,stop:true}).action,'stop');
 assert.equal(recoveryDecision({status,state,now,attempts:5}).action,'hold');
 assert.equal(recoveryDecision({status:{...status,code:'X_REAUTH_REQUIRED'},state,now}).action,'hold');
 assert.deepEqual(state,before);
});
test('local session lock failure stays held and preserves reservations, unlike contention',()=>{
 const status={status:'blocked',code:'SESSION_LOCK_FAILED',workPhase:'preparing',receipt:{},currentHandle:'guest'};
 const state={records:{'123':{handle:'guest',status:'needs_reconciliation'}}};
 const before=structuredClone(state);
 assert.equal(readRetryAt({code:status.code},{now}),null);
 for(const workPhase of ['preparing','processing'])
  assert.deepEqual(recoveryDecision({status:{...status,workPhase},state,now}),{action:'hold',reason:'SESSION_LOCK_FAILED'});
 assert.deepEqual(state,before);
 assert.equal(recoveryDecision({status,state,now,alive:true}).action,'observe');
 assert.equal(recoveryDecision({status,state,now,stop:true}).action,'stop');
});
test('safe GET and local store timeouts use bounded backoff without retrying sent writes or authentication failures',()=>{
 for(const error of [{code:'X_READ_TIMEOUT'}, {code:'X_ACTION_SESSION_STORE_FAILED',receipt:{store:{timedOut:true}}}]) {
  assert.equal(readRetryAt(error,{now}),now+60000);
  assert.equal(readRetryAt(error,{now,failures:99}),now+1800000);
  assert.equal(readRetryAt(error,{now,phase:'write'}),null);
  assert.equal(readRetryAt({...error,receipt:{...error.receipt,writeSent:true}},{now}),null);
  assert.equal(readRetryAt({...error,receipt:{...error.receipt,httpStatus:403}},{now}),null);
  assert.equal(recoveryDecision({status:{status:'blocked',code:error.code,receipt:error.receipt,workPhase:'preparing'},now}).action,'restart');
  assert.equal(recoveryDecision({status:{status:'blocked',code:error.code,receipt:error.receipt,workPhase:'processing'},now}).action,'hold');
 }
 assert.equal(readRetryAt({code:'X_ACTION_SESSION_STORE_FAILED',receipt:{store:{timedOut:false}}},{now}),null);
 assert.equal(readRetryAt({code:'EPERM'},{now}),null);
 assert.equal(readRetryAt({code:'X_ACTION_SESSION_STORE_FAILED',receipt:{store:{timedOut:true},httpStatus:200,writeSent:false}},{now}),now+60000);
 assert.equal(readRetryAt({code:'X_ACTION_SESSION_STORE_FAILED',receipt:{store:{timedOut:true},httpStatus:200,writeSent:true}},{now}),null);
});
test('temporary first-party bootstrap and incomplete contract reads restart with backoff, never bypassing auth or sent writes',()=>{
 for(const code of ['X_BOOTSTRAP_UNAVAILABLE','X_MAIN_ASSET_UNAVAILABLE','X_MAIN_CONTRACT_INCOMPLETE']){
  assert.equal(readRetryAt({code},{now}),now+60000);
  assert.equal(recoveryDecision({status:{status:'blocked',code,workPhase:'preparing'},now}).action,'restart');
  assert.equal(recoveryDecision({status:{status:'blocked',code,workPhase:'preparing'},now,attempts:5}).action,'hold');
  assert.equal(readRetryAt({code,receipt:{httpStatus:403}},{now}),null);
  assert.equal(readRetryAt({code,receipt:{writeSent:true}},{now}),null);
  assert.equal(readRetryAt({code},{now,phase:'write'}),null);
  assert.equal(readRetryAt({code,receipt:{httpStatus:429,rateLimitReset:3000}},{now}),3000000);
 }
});
test('writer process identity failure stays held even with a durable account reservation',()=>{
 const status={status:'blocked',code:'SOCIAL_WRITER_IDENTITY_UNAVAILABLE',workPhase:'processing',currentHandle:'guest',httpStatus:null};
 const state={records:{'123':{handle:'guest',status:'reserved',results:{}}}};
 assert.deepEqual(recoveryDecision({status,state,now}),{action:'hold',reason:'SOCIAL_WRITER_IDENTITY_UNAVAILABLE'});
 assert.equal(readRetryAt({code:status.code},{now,phase:'write'}),null);
 assert.equal(state.records['123'].status,'reserved');
});
test('supervision launches exactly once and persists restart backoff; stop never launches',async()=>{
 let launches=0;
 const launch=async()=>{launches++;return 123;};
 const status={status:'blocked',code:'X_SEARCH_REJECTED',receipt:{httpStatus:404,mime:''}};
 const result=await superviseOnce({status},{launch,now});assert.equal(result.pid,123);assert.equal(result.attempts,1);
 await superviseOnce({status,...result},{launch,now:now+1});assert.equal(launches,1);
 await superviseOnce({status,stop:true},{launch,now});assert.equal(launches,1);
});
test('empty GraphQL 404 and JSON 404 retry with bounded backoff; HTML/auth/write failures do not',()=>{
 const error={code:'X_SEARCH_REJECTED',receipt:{httpStatus:404,mime:'',bodyBytes:0,operation:'SearchTimeline'}};
 assert.equal(readRetryAt(error,{now}),now+300000);
 assert.equal(readRetryAt(error,{now,failures:20}),now+1800000);
 assert.equal(readRetryAt({...error,receipt:{...error.receipt,mime:'text/html'}},{now}),null);
 assert.equal(readRetryAt(error,{now,phase:'write'}),null);
 assert.equal(readRetryAt({code:'X_REAUTH_REQUIRED',receipt:{httpStatus:401}},{now}),null);
 assert.equal(readRetryAt({...error,receipt:{httpStatus:429,rateLimitReset:3000}},{now}),3000000);
});
test('dead invitation worker waiting for base benefits restarts without changing reservations',()=>{
 const status={status:'waiting_for_base_benefits',failurePhase:'read',retryAt:new Date(now+60000).toISOString()};
 const state={records:{'123':{handle:'guest',status:'needs_reconciliation',replyAttemptedAt:'2026-10-06T01:00:00Z'}}};
 const before=structuredClone(state);
 assert.deepEqual(recoveryDecision({status,state,now}),{action:'restart',reason:'PROCESS_EXITED'});
 assert.deepEqual(state,before);
 assert.equal(recoveryDecision({status,state,now,alive:true}).action,'observe');
 assert.equal(recoveryDecision({status,state,now,stop:true}).action,'stop');
 assert.equal(recoveryDecision({status,state,now,deadline:now}).action,'stop');
 assert.equal(recoveryDecision({status,state,now,attempts:5}).action,'hold');
 assert.deepEqual(recoveryDecision({status,state,now,nextAttemptAt:now+1000}),{action:'wait',retryAt:now+1000});
});
test('supervisor respects stop, live PID, expiry and unknown/auth failures',()=>{
 const status={status:'blocked',code:'X_SEARCH_REJECTED',receipt:{httpStatus:404,mime:''}};
 assert.equal(recoveryDecision({status,now,alive:true}).action,'observe');
 assert.equal(recoveryDecision({status,now,stop:true}).action,'stop');
 assert.equal(recoveryDecision({status,now,deadline:now}).action,'stop');
 assert.equal(recoveryDecision({status:{status:'blocked',code:'X_REAUTH_REQUIRED'},now}).action,'hold');
 assert.equal(recoveryDecision({status:{status:'blocked',code:'UNKNOWN'},now}).action,'hold');
 assert.equal(recoveryDecision({status,now}).action,'restart');
});
test('session contention during preparation is recoverable; mutation phase is never blindly retried',()=>{
 assert.equal(readRetryAt({code:'SESSION_LOCK_BUSY'},{now}),now+60000);
 assert.equal(readRetryAt({code:'SESSION_LOCK_BUSY'},{now,phase:'write'}),null);
 assert.equal(recoveryDecision({status:{status:'blocked',code:'SESSION_LOCK_BUSY',workPhase:'preparing'},now}).action,'restart');
 assert.equal(recoveryDecision({status:{status:'blocked',code:'SESSION_LOCK_BUSY',workPhase:'processing'},now}).action,'hold');
});

test('session contention after a durable bonus hold resumes other accounts without releasing the affected account',()=>{
 const status={status:'blocked',code:'SESSION_LOCK_BUSY',workPhase:'processing',currentHandle:'guest',receipt:{}};
 const state={records:{'123':{handle:'guest',policyVersion:3,status:'verified',baseStatus:'verified',bonusStatus:'needs_reconciliation',results:{follow:{readbackVerified:true,following:true}}}}};
 const before=structuredClone(state);
 assert.deepEqual(recoveryDecision({status,state,now}),{action:'restart',reason:'SESSION_LOCK_BUSY'});
 assert.equal(rewardStage(state.records['123'],true),'reconciliation');
 assert.deepEqual(state,before);
 assert.equal(recoveryDecision({status:{...status,currentHandle:'other'},state,now}).action,'hold');
 assert.equal(recoveryDecision({status,state,now,stop:true}).action,'stop');
 assert.equal(recoveryDecision({status,state,now,attempts:5}).action,'hold');
 assert.deepEqual(recoveryDecision({status,state,now,nextAttemptAt:now+60000}),{action:'wait',retryAt:now+60000});
});
test('dead worker with 429 waits until the actual server reset rather than immediately restarting',()=>{
 const status={status:'blocked',code:'X_OWNER_VERIFY_FAILED',receipt:{httpStatus:429,rateLimitReset:3000}};
 assert.deepEqual(recoveryDecision({status,now}),{action:'wait',retryAt:3000000});
 assert.equal(recoveryDecision({status,now:3000001}).action,'restart');
});
test('tweet read throttled during account processing resumes after cooldown without replaying writes',()=>{
 const status={status:'blocked',code:'X_TWEET_READ_REJECTED',workPhase:'processing',httpStatus:429,retryAt:new Date(3000000).toISOString()};
 assert.deepEqual(recoveryDecision({status,now}),{action:'wait',retryAt:3000000});
 assert.equal(recoveryDecision({status,now:3000001}).action,'restart');
 assert.equal(recoveryDecision({status:{...status,receipt:{httpStatus:429,writeSent:true}},now:3000001}).action,'hold');
});
test('draft regeneration can restart, but identity errors and post-send draft errors remain held',()=>{
 assert.equal(recoveryDecision({status:{status:'blocked',workPhase:'drafting',code:'X_AI_COMMENT_INVALID'},now}).action,'restart');
 assert.equal(recoveryDecision({status:{status:'blocked',workPhase:'drafting',code:'X_AI_BATCH_OUTPUT'},now}).action,'hold');
 assert.equal(recoveryDecision({status:{status:'blocked',workPhase:'processing',code:'X_AI_COMMENT_INVALID'},now}).action,'hold');
});
test('uncertain create may resume other accounts only when affected account is durably held',()=>{
 const status={status:'blocked',code:'X_CREATE_SCHEMA',currentHandle:'guest'};
 assert.equal(recoveryDecision({status,now,state:{records:{}}}).action,'hold');
 assert.equal(recoveryDecision({status,now,state:{records:{'123':{handle:'guest',status:'reserved'}}}}).action,'restart');
 assert.equal(recoveryDecision({status,now,attempts:5}).action,'hold');
 assert.equal(recoveryDecision({status,now,state:{records:{'123':{handle:'guest',status:'verified'}}}}).action,'hold');
});
test('post-write read throttling waits for reset, then resumes other accounts only with a durable hold',()=>{
 const status={status:'blocked',code:'X_TWEET_READ_REJECTED',currentHandle:'guest',workPhase:'processing',receipt:{httpStatus:429,writeSent:true,rateLimitReset:3000}};
 const state={records:{'123':{handle:'guest',status:'verified',bonusStatus:'needs_reconciliation'}}};
 assert.equal(recoveryDecision({status,state,now}).action,'wait');
 assert.equal(recoveryDecision({status,state,now:3000001}).action,'restart');
 assert.equal(recoveryDecision({status,now:3000001}).action,'hold');
});
