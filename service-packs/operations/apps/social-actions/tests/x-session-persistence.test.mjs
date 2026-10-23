import test from 'node:test';
import assert from 'node:assert/strict';
import { sessionPersistenceChanged, persistState, finishXSessionPersistence } from '../providers/x.mjs';
import { safeBotFailure } from '../lib/bot-diagnostics.mjs';
test('skip access timestamps but persist rotated values, expiry and CSRF headers',()=>{
  const base={cookieJar:{cookies:[{key:'auth_token',value:'synthetic-a',expires:'2030-01-01',lastAccessed:'2026-09-30'}]},headersByOrigin:{'https://api.x.com':{'x-csrf-token':'synthetic-csrf-a'}}};
  const access=structuredClone(base); access.cookieJar.cookies[0].lastAccessed='2026-10-01';
  assert.equal(sessionPersistenceChanged(base,access),false);
  for(const update of [v=>v.cookieJar.cookies[0].value='synthetic-b',v=>v.cookieJar.cookies[0].expires='2031-01-01',v=>v.headersByOrigin['https://api.x.com']['x-csrf-token']='synthetic-csrf-b']){
    const next=structuredClone(access);update(next);assert.equal(sessionPersistenceChanged(base,next),true);
  }
});
test('failed protected write does not advance the persisted session baseline', async () => {
 const state={session:{cookieJar:{cookies:[{key:'ct0',value:'synthetic-old'}]}}},prior=structuredClone(state.session);
 const next={cookieJar:{cookies:[{key:'ct0',value:'synthetic-rotated'}]},headersByOrigin:{'https://api.x.com':{'x-client-transaction-id':'synthetic-transaction'}}};
 const session={toJSON:()=>structuredClone(next)};let writes=0,persisted;
 const store={write:(_key,value)=>{writes++;if(writes===1)throw Object.assign(new Error('synthetic protected body'),{detail:{stage:'protect',timedOut:true,exitStatus:null}});persisted=JSON.parse(value);}};
 await assert.rejects(persistState(store,state,session),error=>error.code==='X_ACTION_SESSION_STORE_FAILED'&&error.receipt.store.timedOut);
 assert.deepEqual(state.session,prior);await persistState(store,state,session);assert.equal(writes,2);
 assert.equal(persisted.session.cookieJar.cookies[0].value,'synthetic-rotated');
 assert.equal(persisted.session.headersByOrigin['https://api.x.com']['x-client-transaction-id'],undefined);
 await persistState(store,state,session);assert.equal(writes,2);
});
test('cleanup failure preserves the primary uncertain-write or HTTP rejection', async () => {
 for(const code of ['X_ACTION_OUTCOME_UNKNOWN','X_ACTION_BLOCKED']){
  const primary=Object.assign(new Error(code),{code,receipt:{httpStatus:403,writeSent:code==='X_ACTION_OUTCOME_UNKNOWN'}});
  const cleanup=Object.assign(new Error('synthetic detail'),{code:'X_ACTION_SESSION_STORE_FAILED',receipt:{store:{timedOut:true,stage:'protect'}}});
  await assert.rejects((async()=>{try{throw primary;}finally{await finishXSessionPersistence(async()=>{throw cleanup;},primary);}})(),error=>error===primary);
  assert.equal(primary.receipt.httpStatus,403);assert.equal(safeBotFailure(primary).cleanupStore.timedOut,true);
 }
});
test('cleanup failure remains fatal when there was no primary error', async () => {
 const error=Object.assign(new Error('synthetic'),{code:'X_ACTION_SESSION_STORE_FAILED'});
 await assert.rejects(finishXSessionPersistence(async()=>{throw error;}),e=>e===error);
});
