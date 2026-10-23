import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {inspectPublication,checkPublication} from '../src/publication-health.mjs';
test('health checks surface missing markers without claiming link destination or sales verification',()=>{
 const expected={title:'Comparison',disclosure:'Commission disclosure',links:['https://link.coupang.com/a/example']};
 const bad=inspectPublication('<html>Login</html>',expected);assert.equal(bad.status,'needs_review');assert.equal(bad.missing.length,3);
 const good=inspectPublication('Comparison Commission disclosure https://link.coupang.com/a/example',expected);assert.equal(good.status,'content-markers-present');assert.ok(good.limitations.length);
});

test('public health check validates the configured blog origin and stores only a response hash',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'automation-publication-health-'));let call;
 try{
  const expected={url:'https://sample-blog.tistory.com/215',title:'Synthetic title',disclosure:'Synthetic disclosure',links:['https://link.coupang.com/a/example']};
  const result=await checkPublication(expected,directory,{blogOrigin:'https://sample-blog.tistory.com',uuid:()=> 'synthetic',now:()=>new Date('2026-10-02T00:00:00Z'),fetchImpl:async(url,options)=>{
   call={url:String(url),options};return {status:200,headers:new Headers({'content-type':'text/html; charset=utf-8'}),text:async()=>'Synthetic title Synthetic disclosure https://link.coupang.com/a/example'};
  }});
  assert.equal(call.url,expected.url);assert.equal(call.options.redirect,'manual');assert.equal(result.status,'content-markers-present');assert.equal(result.authenticated,false);assert.equal(result.verificationTraffic,true);
  const saved=await readFile(result.file,'utf8');assert.equal(saved.includes('Synthetic title'),false);assert.match(JSON.parse(saved).responseHash,/^[a-f0-9]{64}$/);
  await assert.rejects(checkPublication({...expected,url:'https://evil.example/215'},directory,{blogOrigin:'https://sample-blog.tistory.com',fetchImpl:async()=>{throw Error('must not send');}}),/Verified public post URL required/);
 }finally{await rm(directory,{recursive:true,force:true});}
});
