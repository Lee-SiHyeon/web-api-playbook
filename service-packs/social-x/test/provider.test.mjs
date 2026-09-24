import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {openProvider} from '../src/provider.mjs';
const session={authToken:'fixture',csrfToken:'fixture',bearerToken:'fixture',origin:'https://x.com'};
const modulePath=path.resolve('fixture-provider.mjs');
test('environment credentials are passed without modifying environment',async()=>{
  const env={X_AUTH_TOKEN:'fixture',X_CSRF_TOKEN:'fixture',X_BEARER_TOKEN:'fixture'};
  const p=await openProvider({env});assert.equal(p.credentials.authToken,'fixture');await p.close();assert.deepEqual(p.credentials,{});assert.equal(env.X_AUTH_TOKEN,'fixture');
});
test('provider rejects stale and foreign-origin sessions and closes',async()=>{
  for(const invalid of [{...session,expiresAt:'2000-01-01'},{...session,origin:'https://elsewhere.invalid'}]){
    let closed=0;await assert.rejects(openProvider({modulePath,importModule:async()=>({default:{getSession:async()=>invalid,close:async()=>closed++}})}),/PROVIDER_(EXPIRED|ORIGIN)/);assert.equal(closed,1);
  }
});
test('request tokens are generated per exact method and path',async()=>{
  const calls=[];let closed=0;
  const p=await openProvider({modulePath,importModule:async()=>({default:{getSession:async()=>session,getTransactionId:async r=>{calls.push(r);return 'fixture';},close:async()=>closed++}})});
  await p.transactionProvider({method:'GET',path:'/i/api/graphql/a/UserByScreenName'});
  await p.transactionProvider({method:'POST',path:'/i/api/graphql/b/CreateTweet'});
  assert.equal(calls.length,2);assert.equal(calls[1].origin,'https://x.com');
  await assert.rejects(p.transactionProvider({method:'POST',path:'/unrelated'}),/SCOPE/);
  await p.close();await p.close();assert.equal(closed,1);
  await assert.rejects(p.transactionProvider({method:'GET',path:'/i/api/graphql/a/UserByScreenName'}),/CLOSED/);
});
