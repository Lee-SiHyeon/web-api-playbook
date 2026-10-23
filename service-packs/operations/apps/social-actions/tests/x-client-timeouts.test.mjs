import test from 'node:test';
import assert from 'node:assert/strict';
import { SOCIAL_REQUEST_TIMEOUTS } from '../lib/request-timeouts.mjs';
import { loadOptionalPeerModule } from './helpers/optional-peer.mjs';

const peer = await loadOptionalPeerModule('SNS_X_ROOT', 'src/client.mjs');

test('local X request timeout policy stays explicit and bounded', () => {
  assert.deepEqual(SOCIAL_REQUEST_TIMEOUTS, {
    read: 90_000, publicAsset: 60_000, write: 120_000, ai: 180_000,
    sessionLock: 600_000, readiness: 300_000,
  });
  assert.equal(Object.isFrozen(SOCIAL_REQUEST_TIMEOUTS), true);
});

test('peer X direct client uses maintained deadlines with one-shot writes', { skip: peer.skip }, async()=>{
  const { XClient } = peer.module;
  const base={authToken:'fixture-auth',csrfToken:'fixture-csrf',bearerToken:'fixture-bearer',
    contracts:{operations:{UserByScreenName:{queryId:'test',features:{}},CreateTweet:{queryId:'test',features:{}}}}};
  const deadlines=[],timeout=AbortSignal.timeout;let calls=0;
  AbortSignal.timeout=milliseconds=>{deadlines.push(milliseconds);return new AbortController().signal;};
  try{
    const client=new XClient({...base,requestTimeouts:SOCIAL_REQUEST_TIMEOUTS,fetchImpl:async()=>{calls++;return new Response('{"data":{}}',{headers:{'content-type':'application/json'}});}});
    await client.request('UserByScreenName',{});await client.request('CreateTweet',{});
    assert.deepEqual(deadlines,[90_000,120_000]);assert.equal(calls,2);
    assert.throws(()=>new XClient({...base,requestTimeouts:{read:0,write:120_000}}),/REQUEST_TIMEOUT_INVALID/);
  }finally{AbortSignal.timeout=timeout;}
});
