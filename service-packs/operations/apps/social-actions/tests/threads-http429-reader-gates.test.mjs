import test from 'node:test';
import assert from 'node:assert/strict';
import { readThreadsAccountStatus } from '../threads-account-status.mjs';
import { createThreadsInsightsClient } from '../threads-insights.mjs';
import { threadsBenefitWorkerCooldown } from '../threads-benefit-worker.mjs';
import { threadsRecognizedWaitState, threadsLocalRecoveryKind } from '../lib/threads-local-recovery.mjs';

const cooldown = () => ({ code:'META_HTTP_429_COOLDOWN',httpStatus:429,rateLimited:true,
  retryAt:Date.now()+60_000,retryAfterSeconds:60,cooldownReason:'http_429_rate_limit',deadlineSource:'server_hint' });

test('shared HTTP 429 blocks account bootstrap and preserves HTTP evidence',async()=>{
  let calls=0;
  await assert.rejects(readThreadsAccountStatus({sessionLock:async(_service,task)=>task(),readCooldown:async()=>cooldown(),
    contextLoader:async()=>{calls++;},querySender:async()=>{calls++;}}),
  {code:'META_HTTP_429_COOLDOWN',httpStatus:429,dispatchStarted:false,writeSent:false,cooldownReason:'http_429_rate_limit'});
  assert.equal(calls,0);
});

test('shared HTTP 429 blocks insights bootstrap without relabeling it GraphQL 200',async()=>{
  let calls=0;
  await assert.rejects(createThreadsInsightsClient({startDate:'2026-09-01',endDate:'2026-09-30',readCooldown:async()=>cooldown(),
    openContext:async()=>{calls++;},sendQuery:async()=>{calls++;}}),
  {code:'META_HTTP_429_COOLDOWN',httpStatus:429,dispatchStarted:false,writeSent:false,cooldownReason:'http_429_rate_limit'});
  assert.equal(calls,0);
});

test('workers preserve the saved local HTTP 429 deadline and its source after reload',()=>{
  const now=1_800_000_000_000;
  const saved={code:'META_HTTP_429_COOLDOWN',httpStatus:429,retryAt:now+120_000,
    cooldownReason:'http_429_rate_limit',deadlineSource:'local_fallback_15_minutes',fallbackMilliseconds:900_000};
  const result=threadsBenefitWorkerCooldown(saved,now);
  assert.equal(result.retryAt,saved.retryAt);
  assert.equal(result.deadlineSource,saved.deadlineSource);
  assert.equal(result.code,saved.code);
  const status={status:'cooldown',...result,retryAt:new Date(result.retryAt).toISOString()};
  assert.equal(threadsRecognizedWaitState(status,now),true);
  assert.equal(threadsLocalRecoveryKind(status,now),'dead_runtime');
});

test('an unpersisted shared HTTP 429 hold is not classified as a restartable dead runtime',()=>{
  const now=1_800_000_000_000;
  const result=threadsBenefitWorkerCooldown({code:'META_HTTP_429_COOLDOWN_PERSIST_FAILED',httpStatus:429,retryAt:now+120_000,
    cooldownReason:'http_429_rate_limit',deadlineSource:'local_fallback_15_minutes',fallbackMilliseconds:900_000},now);
  assert.equal(result.code,'META_HTTP_429_COOLDOWN_PERSIST_FAILED');
  assert.equal(threadsLocalRecoveryKind({status:'cooldown',...result,retryAt:new Date(result.retryAt).toISOString()},now),null);
});
