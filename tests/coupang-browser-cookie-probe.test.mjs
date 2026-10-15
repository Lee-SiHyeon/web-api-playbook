import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareCookieComparison } from '../scripts/coupang-browser-cookie-probe.mjs';

const now = Date.parse('2026-10-15T03:00:00Z');
const tree = '["",{"children":["srp",{"children":["__PAGE__",{},null,null]},null,null]},null,null,true]';
const envelope = () => ({
  url:'https://www.coupang.com/np/search?q=mouse&channel=relate&sorter=salePriceAsc&_rsc=fixture',
  headers:{rsc:'1','next-url':'/srp','next-router-state-tree':encodeURIComponent(tree),accept:'*/*',
    referer:'https://www.coupang.com/np/search?q=mouse&channel=relate'},
  capturedAt:new Date(now).toISOString(),browserResponse:{status:200,mime:'text/x-component',protocol:'h2'},
  cookieHeader:'PCID=test-pcid; x-coupang-target-market=KR; x-coupang-accept-language=ko_KR; _abck=test-abck; bm_sz=test-bm; sid=test-sid'
});

test('cookie comparison isolates Akamai addition while preserving browser PCID and exact full header',()=>{
  const input=envelope(), p=prepareCookieComparison(input,now);
  assert.deepEqual(p.variants.map(v=>v.cookieNames.length),[3,5,6]);
  assert.ok(p.variants.every(v=>v.cookieHeader.startsWith('PCID=test-pcid;')));
  assert.equal(p.variants[2].cookieHeader,input.cookieHeader);
  assert.equal(p.variants[1].cookieNames.includes('sid'),false);
  assert.deepEqual(p.input.headers,input.headers);
  assert.equal('cookieHeader' in p.input,false);
});

test('reject stale captures, unavailable browser success and non-search origins before transport',()=>{
  for (const mutate of [e=>e.capturedAt=new Date(now-300001).toISOString(),
    e=>e.browserResponse.status=403,e=>e.browserResponse.mime='text/html',
    e=>e.url=e.url.replace('www.coupang.com','example.com'),
    e=>e.url=e.url.replace('/np/search','/login')]){
    const e=envelope();mutate(e);assert.throws(()=>prepareCookieComparison(e,now));
  }
});

test('reject unobserved, duplicate and injected cookie headers without echoing their values',()=>{
  for(const suffix of ['; unknown_cookie=do-not-log','; PCID=do-not-log','\r\nx-extra: do-not-log']){
    const e=envelope();e.cookieHeader+=suffix;
    assert.throws(()=>prepareCookieComparison(e,now),error=>!error.message.includes('do-not-log'));
  }
});
