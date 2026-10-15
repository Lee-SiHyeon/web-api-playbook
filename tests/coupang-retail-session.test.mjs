import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {ProtectedStore} from '../lib/protected-store.mjs';
import {calculateCoupangSignatureDigest,parseCoupangSignature,renewCoupangSignature} from '../lib/retail/coupang-signature.mjs';
import {COUPANG_RETAIL_STORE,RETAIL_COOKIE_NAMES,RETAIL_CONTEXT_LIMIT_MS,createCoupangRetailState,searchCoupangRetail} from '../lib/retail/coupang-retail-session.mjs';
import {buildCoupangRscInput} from '../lib/retail/coupang-rsc.mjs';
const fixtures=new URL('./fixtures/coupang/',import.meta.url);
const vectors=JSON.parse(await readFile(new URL('signature-v3-vectors.json',fixtures),'utf8')).vectors;
const listing=JSON.parse(await readFile(new URL('retail-rsc-list.json',fixtures),'utf8'));
const frame='c:'+JSON.stringify(['$',null,null,listing])+'\n';

test('native signer matches 16 independent original-SDK vectors across timestamp parity and preserves opaque context',()=>{
  for(const v of vectors){assert.equal(calculateCoupangSignatureDigest(v.payload,v.query,v.time),v.digest);parseCoupangSignature(v.encoded);}
  const before=parseCoupangSignature(vectors[0].encoded),renewed=renewCoupangSignature(vectors[0].encoded,{now:1700001000001,nonce:'f'.repeat(32)});
  const after=parseCoupangSignature(renewed.value);assert.equal(after.c4,before.c4);assert.equal(after.c6,before.c6);
  assert.equal(Number(after.c9),Number(before.c9)+1);assert.notEqual(after.s1,before.s1);assert.equal(renewed.contextRenewed,false);
  const tampered=Buffer.from(Buffer.from(vectors[0].encoded,'base64').toString('utf8').replace('c3=1700000000000','c3=1700000000001')).toString('base64');
  assert.throws(()=>parseCoupangSignature(tampered),{code:'COUPANG_SIGNATURE_MISMATCH'});
});

test('RSC inputs are locally derived, deterministic, query-scoped and contain no captured nonce',()=>{
  const a=buildCoupangRscInput('무선마우스'),b=buildCoupangRscInput('키보드');
  assert.equal(new URL(a.url).searchParams.get('_rsc'),new URL(b.url).searchParams.get('_rsc'));
  assert.equal(new URL(a.headers.referer).searchParams.get('q'),'무선마우스');
  assert.equal(new URL(a.url).searchParams.get('sorter'),'salePriceAsc');
  for(const q of ['',null,'bad\nquery','a'.repeat(101)])assert.throws(()=>buildCoupangRscInput(q));
});

async function setup(t){
  const directory=await mkdtemp(path.join(os.tmpdir(),'coupang-retail-test-'));
  t.after(()=>rm(directory,{recursive:true,force:true}));
  const store=new ProtectedStore({provider:'memory',directory}),now=Date.now();
  const signature=renewCoupangSignature(vectors[0].encoded,{now:now-120000,nonce:'b'.repeat(32)});
  const cookies=RETAIL_COOKIE_NAMES.map(name=>({name,value:name==='x-cp-s'?signature.value:'SYNTHETIC_'+name,
    domain:'.coupang.com',path:'/',secure:true,httpOnly:false,expires:(now+600000)/1000}));
  const state=createCoupangRetailState(cookies);state.session.cookieJar.cookies.find(c=>c.key==='x-cp-s').expires=new Date(now-1000).toISOString();
  store.write(COUPANG_RETAIL_STORE,JSON.stringify(state));return {store,state};
}

test('fresh bootstrap accepts observed bm_mi absence but still rejects missing required or duplicate cookies',()=>{
  const now=Date.now(),signature=renewCoupangSignature(vectors[0].encoded,{now,nonce:'c'.repeat(32)});
  const cookies=RETAIL_COOKIE_NAMES.filter(name=>name!=='bm_mi').map(name=>({name,
    value:name==='x-cp-s'?signature.value:'SYNTHETIC_'+name,domain:'.coupang.com',path:'/',secure:true,
    httpOnly:false,expires:(now+600000)/1000}));
  const state=createCoupangRetailState(cookies);
  assert.equal(state.session.cookieJar.cookies.length,11);
  assert.equal(state.session.cookieJar.cookies.some(c=>c.key==='bm_mi'),false);
  for(const name of RETAIL_COOKIE_NAMES.filter(name=>name!=='bm_mi'))
    assert.throws(()=>createCoupangRetailState(cookies.filter(c=>c.name!==name)),{code:'COUPANG_RETAIL_IMPORT_INCOMPLETE'});
  assert.throws(()=>createCoupangRetailState([...cookies,cookies[0]]),{code:'COUPANG_RETAIL_IMPORT_INCOMPLETE'});
});

test('expired signature refresh reaches HTTP, stores observed rotation and deletion, and never logs secrets',async t=>{
  const {store}=await setup(t);let calls=0;
  const result=await searchCoupangRetail('무선마우스',{store,fetchImpl:async(url,init)=>{
    calls++;assert.equal(init.method,'GET');assert.equal(init.redirect,'manual');
    assert.equal(new URL(url).origin,'https://www.coupang.com');
    const header=init.headers.get('cookie');assert.match(header,/PCID=SYNTHETIC_PCID/);
    const sig=header.split('; ').find(s=>s.startsWith('x-cp-s=')).slice(7);const fields=parseCoupangSignature(sig);
    assert.ok(Date.now()-Number(fields.c3)<5000);
    const headers=new Headers({'content-type':'text/x-component'});
    headers.append('set-cookie','bm_sv=ROTATED_SENTINEL; Domain=.coupang.com; Path=/; Max-Age=7200; Secure');
    headers.append('set-cookie','bm_mi=; Domain=.coupang.com; Path=/; Max-Age=0');
    headers.append('set-cookie','ILOGIN=; Domain=.coupang.com; Path=/; Max-Age=0');
    return new Response(frame,{headers});
  }});
  assert.equal(calls,1);assert.equal(result.ok,true);assert.equal(result.data.products.length,60);
  assert.equal(result.renewal.performed,true);assert.equal(result.renewal.oldExpiredAtStart,true);
  assert.equal(result.states.live_replay,false);assert.equal(result.renewal.verifiedByRead,false);
  const state=JSON.parse(store.read(COUPANG_RETAIL_STORE));
  assert.equal(state.session.cookieJar.cookies.find(c=>c.key==='bm_sv').value,'ROTATED_SENTINEL');
  assert.equal(state.session.cookieJar.cookies.some(c=>c.key==='ILOGIN'),false);
  const serialized=JSON.stringify(result);for(const secret of ['SYNTHETIC_PCID','ROTATED_SENTINEL','c1=3&','c4='])assert.equal(serialized.includes(secret),false);
});

test('403 has one request, no automatic retry and no renewal-success claim',async t=>{
  const {store}=await setup(t);let calls=0;
  const result=await searchCoupangRetail('무선마우스',{store,fetchImpl:async()=>{calls++;return new Response('<title>Access Denied</title>',{status:403,headers:{'content-type':'text/html'}});}});
  assert.equal(calls,1);assert.equal(result.code,'COUPANG_RETAIL_HTTP_403');assert.equal(result.retries,0);
  assert.equal(result.renewal.verifiedByRead,false);assert.equal(result.states.live_replay,false);
});

test('foreign state, expired bootstrap and positive login-cookie changes are rejected without leakage',async t=>{
  const {store,state}=await setup(t);
  for(const mutate of [s=>s.session.allowedOrigins.push('https://evil.test'),s=>s.session.defaultHeaders.authorization='SECRET',
    s=>s.bootstrapAt=new Date(Date.now()-RETAIL_CONTEXT_LIMIT_MS-1000).toISOString(),s=>s.session.cookieJar.cookies[0].domain='evil.test']){
    const changed=structuredClone(state);mutate(changed);store.write(COUPANG_RETAIL_STORE,JSON.stringify(changed));
    await assert.rejects(searchCoupangRetail('mouse',{store,fetchImpl:()=>assert.fail('network')}));
  }
  store.write(COUPANG_RETAIL_STORE,JSON.stringify(state));
  const result=await searchCoupangRetail('mouse',{store,fetchImpl:async()=>new Response(frame,{headers:{'content-type':'text/x-component',
    'set-cookie':'ILOGIN=UNEXPECTED_AUTH_SECRET; Domain=.coupang.com; Path=/; Max-Age=3600'}})});
  assert.equal(result.code,'COUPANG_RETAIL_RESPONSE_COOKIE_SCOPE');assert.equal(JSON.stringify(result).includes('UNEXPECTED_AUTH_SECRET'),false);
  assert.equal(store.read(COUPANG_RETAIL_STORE).includes('UNEXPECTED_AUTH_SECRET'),false);
});

test('deleted required context and failed protected persistence cannot report successful renewal',async t=>{
  const {store,state}=await setup(t);
  const deleted=await searchCoupangRetail('mouse',{store,fetchImpl:async()=>new Response(frame,{headers:{'content-type':'text/x-component',
    'set-cookie':'PCID=; Domain=.coupang.com; Path=/; Max-Age=0'}})});
  assert.equal(deleted.ok,false);assert.equal(deleted.code,'COUPANG_RETAIL_CONTEXT_INVALIDATED');assert.equal(deleted.renewal.verifiedByRead,false);
  await assert.rejects(searchCoupangRetail('mouse',{store,fetchImpl:()=>assert.fail('network')}));
  store.write(COUPANG_RETAIL_STORE,JSON.stringify(state));
  const failedStore={directory:store.directory,read:name=>store.read(name),write:()=>{throw Object.assign(new Error('SECRET_STORAGE_ERROR'),{code:'PROTECTED_STORE_OPERATION_FAILED'});}};
  const failed=await searchCoupangRetail('mouse',{store:failedStore,fetchImpl:async()=>new Response(frame,{headers:{'content-type':'text/x-component'}})});
  assert.equal(failed.ok,false);assert.equal(failed.code,'PROTECTED_STORE_OPERATION_FAILED');assert.equal(JSON.stringify(failed).includes('SECRET_STORAGE_ERROR'),false);
});
