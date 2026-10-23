import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { sendMetaQuery } from '../lib/meta-bootstrap.mjs';
import { hasObservedThreadsGraphqlThrottle, recordThreadsGraphqlCooldown, readThreadsSharedCooldown,
  isThreadsGraphqlThrottle, applyThreadsCooldownStatus, recordThreadsGraphqlSuccess, recordThreadsHttp429Cooldown,
  THREADS_GRAPHQL_BACKOFF, THREADS_HTTP_429_THROTTLED, THREADS_HTTP_429_PERSIST_FAILED } from '../lib/threads-graphql-throttle.mjs';
import { threadsBenefitWorkerCooldown } from '../threads-benefit-worker.mjs';

async function withRoot(run) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'threads-graphql-throttle-'));
  try { await run(root); } finally { await rm(root, { recursive: true, force: true }); }
}
const now = Date.parse('2026-10-01T01:37:04.715Z');
function response(payload, origin = 'https://www.threads.com', headers = {}) {
  const result = new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json', ...headers } });
  Object.defineProperty(result, 'url', { value: origin + '/api/graphql' });
  return result;
}
function response429(headers = {}, url = 'https://www.threads.com/api/graphql') {
  const result = new Response('rate limited', { status: 429, headers });
  Object.defineProperty(result, 'url', { value: url });
  return result;
}

test('observed numeric code is throttling; generic errors and challenges are not downgraded', () => {
  assert.equal(hasObservedThreadsGraphqlThrottle({ errors: [{ code: 1675004 }] }), true);
  assert.equal(hasObservedThreadsGraphqlThrottle({ errors: [{ extensions: { code: 1675004 } }] }), true);
  assert.equal(hasObservedThreadsGraphqlThrottle({ errors: [{ code: 1, message: 'request failed' }] }), false);
  assert.equal(hasObservedThreadsGraphqlThrottle({ errors: [{ code: 1675004, message: 'checkpoint required' }] }), false);
});

test('HTTP 200 throttling sends once and persists only safe shared deadline metadata', async () => {
  await withRoot(async root => {
    let calls = 0;
    const context = { service: 'threads', throttleRoot: root,
      bundle: { service: 'threads', origin: 'https://www.threads.com', cookies: [] },
      fetchImpl: async () => { calls++; return response({ errors: [{ code: 1675004, message: 'rate limit SECRET_SENTINEL' }] }); } };
    await assert.rejects(sendMetaQuery(context, { url: context.bundle.origin + '/api/graphql', method: 'POST',
      body: new URLSearchParams({ fb_api_req_friendly_name: 'BarcelonaPostPageTargetQuery' }) }), error => {
      assert.equal(error.code, 'META_GRAPHQL_THROTTLED'); assert.equal(error.httpStatus, 200);
      assert.equal(error.cooldownPersisted, true); assert.equal(isThreadsGraphqlThrottle(error), true); return true;
    });
    assert.equal(calls, 1);
    const raw = await readFile(path.join(root, 'graphql-cooldown.json'), 'utf8');
    assert.equal(raw.includes('SECRET_SENTINEL'), false);
    const saved = JSON.parse(raw);
    assert.equal(saved.httpStatus, 200); assert.equal(saved.providerErrorCode, 1675004);
    assert.equal(saved.deadlineSource, 'local_fallback');
    assert.equal(Date.parse(saved.retryAt) - Date.parse(saved.observedAt), 5 * 60_000);
  });
});

test('raw HTTP 429 is persisted as HTTP 429 and blocks a sibling read before dispatch', async () => {
  await withRoot(async root => {
    let calls = 0;
    const context = { service:'threads', throttleRoot:root,
      bundle:{ service:'threads', origin:'https://www.threads.com', cookies:[] },
      fetchImpl:async () => { calls++; return response429({ 'retry-after':'120' }); } };
    await assert.rejects(sendMetaQuery(context,{url:context.bundle.origin+'/api/graphql',method:'POST',
      body:new URLSearchParams({fb_api_req_friendly_name:'BarcelonaPostPageTargetQuery'})}),error=>{
      assert.equal(error.code,'META_GRAPHQL_HTTP_429'); assert.equal(error.httpStatus,429);
      assert.equal(error.requestDiagnostic.httpStatus,429); assert.equal(error.dispatchStarted,true);
      assert.equal(error.writeSent,false); assert.equal(isThreadsGraphqlThrottle(error),false); return true;
    });
    const stored=JSON.parse(await readFile(path.join(root,'http429-cooldown.json'),'utf8'));
    assert.equal(stored.httpStatus,429); assert.equal(stored.deadlineSource,'server_hint');
    assert.equal(stored.providerRetryAfterSeconds,120);
    const shared=await readThreadsSharedCooldown({root});
    assert.equal(shared.code,THREADS_HTTP_429_THROTTLED); assert.equal(shared.httpStatus,429);
    assert.equal(shared.deadlineSource,'server_hint');
    await assert.rejects(sendMetaQuery({...context,fetchImpl:async()=>{calls++;throw new Error('unexpected dispatch');}},
      {url:context.bundle.origin+'/api/graphql',method:'POST',body:new URLSearchParams({fb_api_req_friendly_name:'OtherRead'})}),error=>{
      assert.equal(error.code,THREADS_HTTP_429_THROTTLED); assert.equal(error.httpStatus,429);
      assert.equal(error.requestDiagnostic.httpStatus,429); assert.equal(error.dispatchStarted,false);
      assert.equal(error.writeSent,false); return true;
    });
    assert.equal(calls,1);
  });
});

test('HTTP 429 uses a bounded local fallback for malformed hints and expires without extension', async () => {
  await withRoot(async root => {
    const first=await recordThreadsHttp429Cooldown({response:response429({'retry-after':'not-a-date','x-ratelimit-reset':'bad'}),
      operation:'ProfileRead',now,root});
    assert.equal(first.httpStatus,429); assert.equal(first.deadlineSource,'local_fallback_15_minutes');
    assert.equal(first.retryAt,now+15*60_000); assert.equal(first.fallbackMilliseconds,15*60_000);
    assert.equal(first.providerRetryAfterSeconds,undefined);
    assert.equal((await readThreadsSharedCooldown({root,now:first.retryAt-1})).retryAt,first.retryAt);
    assert.equal(await readThreadsSharedCooldown({root,now:first.retryAt}),null);
    const next=await recordThreadsHttp429Cooldown({response:response429(),operation:'ProfileRead',now:first.retryAt,root});
    assert.equal(next.retryAt,first.retryAt+15*60_000);
  });
});

test('HTTP 429 server hints retain their deadline over a shorter later hint', async () => {
  await withRoot(async root => {
    const first=await recordThreadsHttp429Cooldown({response:response429({'retry-after':'600'}),operation:'ProfileRead',now,root});
    const second=await recordThreadsHttp429Cooldown({response:response429({'retry-after':'30'}),operation:'ProfileRead',now:now+1000,root});
    assert.equal(first.retryAt,now+600_000); assert.equal(second.retryAt,first.retryAt);
    assert.equal(second.deadlineSource,'server_hint'); assert.equal(second.fallbackMilliseconds,undefined);
  });
});

test('valid HTTP-date and numeric Retry-After hints longer than a day are not shortened', async () => {
  await withRoot(async root => {
    const longDate = new Date(now + 48 * 60 * 60_000).toUTCString();
    const dateDeadline = Date.parse(longDate);
    const dateHold = await recordThreadsHttp429Cooldown({response:response429({'retry-after':longDate}),
      operation:'ProfileRead',now,root});
    assert.equal(dateHold.deadlineSource,'server_hint'); assert.equal(dateHold.retryAt,dateDeadline);
    assert.equal(dateHold.providerRetryAfterSeconds,48 * 60 * 60);
    assert.equal(await readThreadsSharedCooldown({root,now:dateDeadline}),null);
    const numericHold = await recordThreadsHttp429Cooldown({response:response429({'retry-after':'172800'}),
      operation:'ProfileRead',now:dateDeadline,root});
    assert.equal(numericHold.deadlineSource,'server_hint'); assert.equal(numericHold.retryAt,dateDeadline+48*60*60_000);
    assert.equal(numericHold.providerRetryAfterSeconds,48 * 60 * 60);
  });
});

test('HTTP 429 persistence failure fails closed locally and retains truthful status', async () => {
  await withRoot(async root => {
    await assert.rejects(recordThreadsHttp429Cooldown({response:response429({'retry-after':'90'}),operation:'ProfileRead',
      now,root,persist:async()=>{throw new Error('disk unavailable');}}),error=>{
      assert.equal(error.code,THREADS_HTTP_429_PERSIST_FAILED); assert.equal(error.httpStatus,429);
      assert.equal(error.cooldownPersisted,false); assert.equal(error.retryAt,now+90_000); return true;
    });
    const local=await readThreadsSharedCooldown({root,now:now+1});
    assert.equal(local.code,THREADS_HTTP_429_PERSIST_FAILED); assert.equal(local.httpStatus,429);
    assert.equal(local.cooldownPersisted,false); assert.equal(local.retryAt,now+90_000);
  });
});

test('challenge and Instagram rejection behavior are preserved without a shared cooldown', async () => {
  await withRoot(async root => {
    for (const [service, payload, code] of [
      ['threads', { errors: [{ code: 1675004, message: 'captcha challenge' }] }, 'META_INTERACTION_REQUIRED'],
      ['threads', { errors: [{ code: 123 }] }, 'META_GRAPHQL_REJECTED'],
      ['instagram', { errors: [{ code: 1675004 }] }, 'META_GRAPHQL_REJECTED'],
    ]) {
      const origin = service === 'threads' ? 'https://www.threads.com' : 'https://www.instagram.com';
      const context = { service, throttleRoot: root, bundle: { service, origin, cookies: [] },
        fetchImpl: async () => response(payload, origin) };
      await assert.rejects(sendMetaQuery(context, { url: origin + '/api/graphql', method: 'POST',
        body: new URLSearchParams({ fb_api_req_friendly_name: 'TestRead' }) }), { code });
      assert.equal(await readThreadsSharedCooldown({ root }), null);
    }
  });
});

test('shared deadline survives restart, never shortens, and expires without another fallback delay', async () => {
  await withRoot(async root => {
    const first = await recordThreadsGraphqlCooldown({ response: response({}, undefined, { 'retry-after': '1800' }), now, root, operation: 'TestRead' });
    assert.equal(first.retryAt, now + 1800_000);
    const second = await recordThreadsGraphqlCooldown({ response: response({}), now: now + 1000, root, operation: 'TestRead' });
    assert.equal(second.retryAt, first.retryAt);
    assert.equal((await readThreadsSharedCooldown({ root, now: now + 100_000 })).retryAt, first.retryAt);
    assert.equal(await readThreadsSharedCooldown({ root, now: first.retryAt }), null);
  });
});

test('HTTP 200 deadline stays HTTP 200 in worker cooldown handling', () => {
  const error = { code: 'META_GRAPHQL_THROTTLED', httpStatus: 200, retryAt: now + 200_000,
    deadlineSource: 'local_fallback_15_minutes' };
  const cooldown = threadsBenefitWorkerCooldown(error, now);
  assert.equal(cooldown.httpStatus, 200); assert.equal(cooldown.retryAt, error.retryAt);
  const status = {};
  applyThreadsCooldownStatus(status, cooldown);
  assert.equal(status.code, error.code); assert.equal(status.httpStatus, 200);
  assert.equal(status.cooldownReason, 'graphql_200_rate_limit');
  applyThreadsCooldownStatus(status, { httpStatus: 429, retryAt: now + 60_000 });
  assert.equal(status.httpStatus, 429); assert.equal(status.code, THREADS_HTTP_429_THROTTLED);
  assert.equal(status.cooldownReason, 'http_429_rate_limit');
  assert.equal(threadsBenefitWorkerCooldown({ code: 'META_GRAPHQL_REJECTED', httpStatus: 200 }, now), null);
});

test('HTTP 429 status receipts retain their real code and reason without GraphQL labels', () => {
  const status={};
  applyThreadsCooldownStatus(status,{code:THREADS_HTTP_429_THROTTLED,httpStatus:429,retryAt:now+90_000,
    cooldownReason:'http_429_rate_limit',deadlineSource:'server_hint'});
  assert.equal(status.code,THREADS_HTTP_429_THROTTLED); assert.equal(status.httpStatus,429);
  assert.equal(status.cooldownReason,'http_429_rate_limit'); assert.equal(status.deadlineSource,'server_hint');
  assert.equal(status.providerErrorCode,undefined);
});

test('malformed shared metadata fails closed', async () => {
  await withRoot(async root => {
    await writeFile(path.join(root, 'graphql-cooldown.json'), JSON.stringify({ retryAt: '2099-01-01' }));
    await assert.rejects(readThreadsSharedCooldown({ root, now }), { code: 'THREADS_THROTTLE_STATE_INVALID' });
  });
});

test('all Threads GraphQL callers fail before dispatch during a shared hold, including mutations', async () => {
  await withRoot(async root => {
    const held = await recordThreadsGraphqlCooldown({ response: response({}), root, operation: 'ProfileRead' });
    const before = await readFile(path.join(root, 'graphql-cooldown.json'), 'utf8');
    let requests = 0;
    const context = { service:'threads', throttleRoot:root, bundle:{ origin:'https://www.threads.com', service:'threads', cookies:[] },
      fetchImpl: async () => { requests++; throw new Error('unexpected dispatch'); } };
    for (const operation of ['ProfileRead', 'OtherRead', 'useTHFollowMutationFollowMutation']) {
      await assert.rejects(sendMetaQuery(context, { url:context.bundle.origin+'/api/graphql', method:'POST',
        body:new URLSearchParams({ fb_api_req_friendly_name:operation }) }), error => {
        assert.equal(error.code, 'META_GRAPHQL_THROTTLED'); assert.equal(error.retryAt, held.retryAt);
        assert.equal(error.writeSent, false); assert.equal(error.requestDiagnostic.writeSent, false);
        assert.equal(error.requestDiagnostic.stage, 'cooldown_gate'); return true;
      });
    }
    assert.equal(requests,0);
    assert.equal(await readFile(path.join(root, 'graphql-cooldown.json'), 'utf8'),before,'local holds never extend the provider deadline');
  });
});

test('local-only retry waits persist across restarts and cap at fifteen minutes', async () => {
  await withRoot(async root => {
    let clock = now;
    for (const [index, minutes] of [5,10,15,15,15].entries()) {
      const held = await recordThreadsGraphqlCooldown({ response:response({}), now:clock, root, operation:'ProfileRead' });
      assert.equal(held.retryAt-clock,minutes*60_000);
      assert.equal(held.consecutiveThrottles,index+1);
      assert.equal((await readThreadsSharedCooldown({ root, now:clock+1 })).retryAt,held.retryAt);
      clock=held.retryAt;
    }
  });
});

test('a provider retry hint controls repeated throttles instead of the local backoff', async () => {
  await withRoot(async root => {
    const first = await recordThreadsGraphqlCooldown({ response:response({}), now, root, operation:'ProfileRead' });
    const hinted = await recordThreadsGraphqlCooldown({ response:response({},undefined,{'retry-after':'120'}),
      now:first.retryAt,root,operation:'ProfileRead' });
    assert.equal(hinted.retryAt-first.retryAt,120_000); assert.equal(hinted.deadlineSource,'server_hint');
    assert.equal(hinted.consecutiveThrottles,2);
  });
});

test('late or unrelated successes do not clear the hold; one successful page does not reset repeat history', async () => {
  await withRoot(async root => {
    const first=await recordThreadsGraphqlCooldown({ response:response({}), now, root, operation:'ProfileRead' });
    assert.equal(await recordThreadsGraphqlSuccess({ operation:'ProfileRead',requestStartedAt:now-1,now:now+1000,root }),false);
    assert.equal(await recordThreadsGraphqlSuccess({ operation:'OtherRead',requestStartedAt:first.retryAt,now:first.retryAt,root }),false);
    assert.equal(await recordThreadsGraphqlSuccess({ operation:'ProfileRead',requestStartedAt:first.retryAt,now:first.retryAt,root }),false);
    const repeated=await recordThreadsGraphqlCooldown({ response:response({}),now:first.retryAt+1000,root,operation:'ProfileRead' });
    assert.equal(repeated.consecutiveThrottles,2); assert.equal(repeated.retryAt-(first.retryAt+1000),10*60_000);
    await recordThreadsGraphqlSuccess({ operation:'ProfileRead',requestStartedAt:repeated.retryAt,now:repeated.retryAt,root });
    const stableAt=repeated.retryAt+THREADS_GRAPHQL_BACKOFF.stableRecoveryMilliseconds;
    assert.equal(await recordThreadsGraphqlSuccess({ operation:'ProfileRead',requestStartedAt:stableAt,now:stableAt,root }),true);
    const fresh=await recordThreadsGraphqlCooldown({ response:response({}),now:stableAt+1000,root,operation:'ProfileRead' });
    assert.equal(fresh.consecutiveThrottles,1); assert.equal(fresh.retryAt-(stableAt+1000),5*60_000);
  });
});

test('an existing v1 cooldown migrates without moving its active deadline', async () => {
  await withRoot(async root => {
    await writeFile(path.join(root,'graphql-cooldown.json'),JSON.stringify({ schemaVersion:1,service:'threads',owner:'lifehack__ailab',
      code:'META_GRAPHQL_THROTTLED',httpStatus:200,providerErrorCode:1675004,operation:'ProfileRead',
      observedAt:new Date(now).toISOString(),retryAt:new Date(now+15*60_000).toISOString(),deadlineSource:'local_fallback_15_minutes' }));
    const active=await recordThreadsGraphqlCooldown({ response:response({}),now:now+1000,root,operation:'ProfileRead' });
    assert.equal(active.retryAt,now+15*60_000);
    const repeated=await recordThreadsGraphqlCooldown({ response:response({}),now:active.retryAt,root,operation:'ProfileRead' });
    assert.equal(repeated.consecutiveThrottles,2); assert.equal(repeated.retryAt-active.retryAt,10*60_000);
  });
});

test('the saved legacy two-hour fallback stays readable and only a fresh refusal receives the new cap', async () => {
  await withRoot(async root => {
    const until = now + 2 * 60 * 60_000;
    await writeFile(path.join(root,'graphql-cooldown.json'),JSON.stringify({ schemaVersion:1,service:'threads',owner:'lifehack__ailab',
      code:'META_GRAPHQL_THROTTLED',httpStatus:200,providerErrorCode:1675004,operation:'ProfileRead',consecutiveThrottles:4,
      observedAt:new Date(now).toISOString(),retryAt:new Date(until).toISOString(),deadlineSource:'local_backoff',fallbackMilliseconds:7_200_000 }));
    assert.equal((await readThreadsSharedCooldown({ root, now: now + 1 })).retryAt,until);
    const fresh = await recordThreadsGraphqlCooldown({ response:response({}),now:until,root,operation:'ProfileRead' });
    assert.equal(fresh.consecutiveThrottles,5); assert.equal(fresh.retryAt-until,15*60_000);
  });
});

test('concurrent expiry probes serialize before the cooldown check so only the first refusal is sent', async () => {
  await withRoot(async root => {
    let requests = 0;
    const context = { service:'threads', throttleRoot:root, bundle:{ origin:'https://www.threads.com', service:'threads', cookies:[] },
      fetchImpl: async () => { requests++; await new Promise(resolve => setTimeout(resolve,40)); return response({ errors:[{ code:1675004 }] }); } };
    const request = () => ({ url:context.bundle.origin+'/api/graphql', method:'POST',
      body:new URLSearchParams({ fb_api_req_friendly_name:'ProfileRead' }) });
    const results = await Promise.allSettled([sendMetaQuery(context,request()),sendMetaQuery(context,request())]);
    assert.equal(requests,1);
    assert.ok(results.every(result => result.status === 'rejected' && result.reason.code === 'META_GRAPHQL_THROTTLED'));
    // Filesystem lease acquisition can complete in either caller's order.
    // Verify the losing request was blocked before dispatch, rather than
    // assuming the second promise necessarily loses the race.
    const gated = results.map(result => result.reason).filter(reason => reason.dispatchStarted === false);
    assert.equal(gated.length,1);
    assert.equal(gated[0].writeSent,false);
  });
});
