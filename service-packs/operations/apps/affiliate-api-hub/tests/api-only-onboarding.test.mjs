import test from 'node:test';
import assert from 'node:assert/strict';
import { inspectOnboarding, classifyAuth, selectNextWork } from '../scripts/api-only-onboarding.mjs';

const definition=(id,provider,extra={})=>({id,provider,label:id,priority:80,login:'observed login',signup:'inspect existing account',nextTask:'discover flow',...extra});
const noKeeper=async()=>({services:{}});

test('authentication needs an affirmative owner read; access denial is not expired login or missing account',()=>{
  assert.equal(classifyAuth({ok:true}), 'auth_unverified');
  assert.equal(classifyAuth({authenticated:true}), 'auth_unverified');
  assert.equal(classifyAuth({ok:false,authenticated:true,ownerVerified:true}), 'auth_unverified');
  assert.equal(classifyAuth({authenticated:true,ownerVerified:true}), 'authenticated');
  assert.equal(classifyAuth({code:'AUTH_FORBIDDEN'}),'delivery_blocked');
  assert.equal(classifyAuth({code:'LOGIN_OUTCOME_UNKNOWN'}),'needs_reconciliation');
  assert.equal(classifyAuth({next:'otp-verify'}),'verification_required');
});

test('read sessions and anonymous Threads state never imply a member account',async()=>{
  const manifest={schemaVersion:1,services:[definition('gmarket','shopping',{sessionKey:'gmarket-search'}),definition('threads','discovery')]};
  const result=await inspectOnboarding({manifest,keeper:noKeeper,
    shoppingStatus:async()=>({present:true,usableForAttempt:true,authenticatedOwnerVerified:false}),credentialStatus:async()=>true});
  assert.equal(result.verifiedServices.length,0);
  for(const service of result.services) {
    assert.equal(service.ownerVerified,false);
    assert.equal(service.accountExistence,'unknown');
    assert.equal(service.signup,'inspect_existing_account_first');
  }
});

test('ready providers reach the real consumer and only approved metadata reaches evidence',async()=>{
  const calls=[];
  const result=await inspectOnboarding({manifest:{schemaVersion:1,services:[definition('x','web-auth')]},keeper:noKeeper,
    exec:async(file,args)=>{
      calls.push(args);
      return {exitCode:0,json:args[1]==='status'?{sessionStored:true}:{ok:true,authenticated:true,ownerVerified:true,browserUsed:false,
        cookie:'fixture-private',email:'private@example.test',unknownData:{secret:'fixture-private'}}};
    }});
  assert.deepEqual(calls,[['x','status'],['x','ensure']]);
  assert.deepEqual(result.verifiedServices,['x']);
  assert.equal(result.services[0].signup,'not_needed_existing_account');
  assert.ok(!JSON.stringify(result).includes('fixture-private'));
  assert.ok(!JSON.stringify(result).includes('private@example.test'));
});

test('check-only uses health and a missing provider does not attempt signup or login',async()=>{
  const calls=[];
  const result=await inspectOnboarding({manifest:{schemaVersion:1,services:[definition('x','web-auth'),definition('myrealtrip','web-auth')]},keeper:noKeeper,allowRenewal:false,
    exec:async(file,args)=>{calls.push(args);return {json:args[1]==='status'?{sessionStored:args[0]==='x',loginStored:true}:{code:'REAUTH_REQUIRED'}};}});
  assert.deepEqual(calls,[['x','status'],['x','health'],['myrealtrip','status']]);
  assert.equal(result.services[1].accountExistence,'unknown');
  assert.equal(result.signupWrites,0);
});

test('one unresolved site does not hide the next independent auth flow',()=>{
  const tasks=selectNextWork([{id:'x',priority:99,authentication:'authenticated'},
    {id:'threads',priority:100,authentication:'auth_unverified'}, {id:'gmarket',priority:98,authentication:'auth_unverified'}]);
  assert.deepEqual(tasks.map(x=>x.service),['threads','gmarket']);
});

test('Meta provider runs a protected read and never treats stored state alone as login',async()=>{
  const manifest={schemaVersion:1,services:[definition('threads','meta-auth')]};
  const calls=[];
  const result=await inspectOnboarding({manifest,keeper:noKeeper,credentialStatus:async()=>true,
    exec:async(file,args)=>{calls.push(args);return {json:{authenticated:true,ownerVerified:true,browserUsed:false}};}});
  assert.deepEqual(calls,[['threads']]);assert.deepEqual(result.verifiedServices,['threads']);
  const missing=await inspectOnboarding({manifest,keeper:noKeeper,credentialStatus:async()=>false,
    exec:async()=>{throw Error('must not attempt login');}});
  assert.equal(missing.services[0].authentication,'provider_missing');
});
