import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {collectOfficial} from '../scripts/collect-official.mjs';
const config={schemaVersion:1,allowedHosts:['arena.ai'],sources:[{id:'arena-text',url:'https://arena.ai/leaderboard/text'}]};
test('snapshot preserves raw bytes and never treats HTTP success as verified claims',async()=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'frontier-test-'));
 const result=await collectOfficial(config,dir,{fetchImpl:async(url,opts)=>{assert.equal(opts.credentials,'omit');assert.equal(opts.redirect,'manual');return new Response('raw evidence',{status:200});}});
 assert.equal(result.sources[0].usable,true);assert.equal(result.sources[0].claimsVerified,false);assert.match(result.sources[0].sha256,/^[a-f0-9]{64}$/);assert.equal(await readFile(path.join(dir,'arena-text.raw'),'utf8'),'raw evidence');
});
test('redirect and HTTP failure cannot become usable evidence',async()=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'frontier-test-'));
 const result=await collectOfficial(config,dir,{fetchImpl:async()=>new Response('blocked',{status:403})});assert.equal(result.sources[0].usable,false);assert.equal(result.sources[0].status,403);
});
test('reject duplicate IDs and out of scope hosts before fetching',async()=>{
 let calls=0;const fetchImpl=async()=>{calls++;throw Error('unreachable');};
 await assert.rejects(collectOfficial({...config,sources:[...config.sources,...config.sources]},'unused',{fetchImpl}),/SOURCE_SCOPE/);
 await assert.rejects(collectOfficial({...config,sources:[{id:'bad',url:'https://other.example/'}]},'unused',{fetchImpl}),/SOURCE_SCOPE/);assert.equal(calls,0);
});
