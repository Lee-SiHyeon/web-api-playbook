import test from 'node:test';import assert from 'node:assert/strict';
import {fetchProfilePosts,parseThreadsPayload,decodeViews} from '../src/public.mjs';
import {res,profileHtml,post} from './helpers.mjs';
test('profile read bootstraps anonymously then replays the preloaded query',async()=>{
  const calls=[];
  const fetchImpl=async(url,opt={})=>{calls.push({url,opt});
    if(calls.length===1)return res(200,profileHtml('me'),{setCookie:['csrftoken=abc; Path=/; Max-Age=3600']});
    return res(200,'for (;;);'+JSON.stringify({data:{a:[post('me','AbCdE1','1234567890123','hello'),post('other','ZzZzZ9','1234567890124','x')]}}));};
  const r=await fetchProfilePosts('me',5,{fetchImpl});
  assert.equal(r.items.length,1);assert.equal(r.items[0].text,'hello');assert.equal(r.fullTimeline,false);
  assert.equal(calls[1].url,'https://www.threads.com/api/graphql');
  const body=new URLSearchParams(calls[1].opt.body);assert.equal(body.get('doc_id'),'123');assert.equal(calls[1].opt.headers['x-csrftoken'],'abc');
  assert.equal(r.receipt.executionMode,'pure_http');assert.ok(!JSON.stringify(r.receipt).includes('abc'));
});
test('quoted older posts are not promoted',()=>{
  const items=parseThreadsPayload([{a:post('me','AbCdE1','1234567890123','mine')}],'me');assert.equal(items.length,1);
  assert.throws(()=>parseThreadsPayload([{a:{wrap:{x:1}}}],'me'),/UNAVAILABLE/);
});
test('views keep null as null',()=>{
  assert.deepEqual(decodeViews(JSON.stringify({data:{media:{text_post_app_info:{impression_count:null}}}})),{views:null,availability:'not_provided_by_server'});
  assert.throws(()=>decodeViews('{}'),/SCHEMA/);
});
test('bootstrap failure and 429 are explicit',async()=>{
  await assert.rejects(fetchProfilePosts('me',5,{fetchImpl:async()=>res(302,'')}),/BOOTSTRAP_HTTP/);
  let n=0;await assert.rejects(fetchProfilePosts('me',5,{fetchImpl:async()=>++n===1?res(200,profileHtml('me'),{setCookie:['csrftoken=a']}):res(429,'{}')}),/RATE_LIMITED/);
});
