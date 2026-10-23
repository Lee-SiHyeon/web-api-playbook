import test from 'node:test';import assert from 'node:assert/strict';import path from 'node:path';
import {openProvider} from '../src/provider.mjs';
const session={owner:'me',cookies:{sessionid:'s',csrftoken:'c',ds_user_id:'42'},lsd:'l',appId:'238260118697367',origin:'https://www.threads.com'};
const modulePath=path.resolve('fixture-provider.mjs');
test('env fallback is read without modifying env and is wiped on close',async()=>{
  const env={THREADS_OWNER:'me',THREADS_SESSIONID:'s',THREADS_CSRFTOKEN:'c',THREADS_DS_USER_ID:'42',THREADS_LSD:'l',THREADS_APP_ID:'1'};
  const p=await openProvider({env});assert.equal(p.credentials.ownerId,'42');await p.close();assert.deepEqual(p.credentials,{});assert.equal(env.THREADS_SESSIONID,'s');
});
test('rejects relative module, stale, foreign-origin and incomplete sessions',async()=>{
  await assert.rejects(openProvider({modulePath:'rel.mjs'}),/ABSOLUTE/);
  for(const bad of [{...session,expiresAt:'2000-01-01'},{...session,origin:'https://evil.invalid'},{...session,cookies:{...session.cookies,sessionid:''}},{...session,lsd:undefined}]){
    let closed=0;await assert.rejects(openProvider({modulePath,importModule:async()=>({default:{getSession:async()=>bad,close:async()=>closed++}})}),/PROVIDER_/);assert.equal(closed,1);}
});
test('credentials are released only for the exact write route on the Threads origin',async()=>{
  const p=await openProvider({modulePath,importModule:async()=>({default:{getSession:async()=>session}})});
  const h=p.headersFor('https://www.threads.com/api/v1/media/configure_text_only_post/');assert.match(h.cookie,/sessionid=s/);assert.equal(h['X-CSRFToken'],'c');
  for(const u of ['https://threads.com/api/v1/media/configure_text_only_post/','https://www.threads.com/api/graphql','https://cdn.example/x','https://www.threads.com/api/v1/media/configure_text_only_post/?a=1'])assert.throws(()=>p.headersFor(u),/SCOPE/);
  await p.close();assert.throws(()=>p.headersFor('https://www.threads.com/api/v1/media/configure_text_only_post/'),/CLOSED/);
});
