import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {collectIntake,matchReviewRevision,mergeIntake} from '../src/intake-collector.mjs';

test('paginated intake persists only hashes and bounded metadata, never raw comment identity or text',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'automation-intake-'));const calls=[];
 const pages=[
  {totalCount:2,items:[{id:11,entryId:215,parent:null,comment:'Synthetic contact request',author:'Synthetic Person',ip:'192.0.2.1'}]},
  {totalCount:2,items:[{id:12,entryId:999,parent:11,comment:'Unrelated synthetic comment',author:'Another Person'}]}
 ];
 try{
  const result=await collectIntake(directory,['215'],{TISTORY_BLOG_ORIGIN:'https://sample-blog.tistory.com',TISTORY_COOKIE:'synthetic-cookie'},{uuid:()=> 'synthetic',now:()=>new Date('2026-10-02T00:00:00Z'),fetchImpl:async(url,options)=>{
   calls.push({url,options});const data=pages[calls.length-1];return {status:200,headers:new Headers({'content-type':'application/json'}),json:async()=>data};
  }});
  assert.equal(result.paginationComplete,true);assert.equal(result.pagesRead,2);assert.equal(result.openCandidates,1);
  assert.equal(calls[0].url,'https://sample-blog.tistory.com/manage/comments.json');assert.equal(calls[1].url,'https://sample-blog.tistory.com/manage/comments.json?page=2');
  assert.equal(calls[0].options.headers.cookie,'synthetic-cookie');assert.equal(calls[0].options.redirect,'manual');
  const saved=await readFile(result.file,'utf8'),state=JSON.parse(saved);
  assert.equal(Object.keys(state.records).length,1);assert.equal(state.records['tistory-comment-11'].rawContentPersisted,false);
  assert.equal(saved.includes('Synthetic contact request'),false);assert.equal(saved.includes('Synthetic Person'),false);assert.equal(saved.includes('192.0.2.1'),false);
  const task={commentId:'11',postId:'215',bodyHash:state.records['tistory-comment-11'].bodyHash};
  assert.equal(matchReviewRevision(task,pages[0].items[0]).status,'current-revision');
  assert.equal(matchReviewRevision(task,null).status,'not_observed');
  assert.equal(matchReviewRevision(task,{...pages[0].items[0],comment:'Changed synthetic comment'}).status,'changed');
 }finally{await rm(directory,{recursive:true,force:true});}
});

test('intake deduplicates unchanged revisions, excludes unrelated posts and reopens changed text',()=>{
 const source={totalCount:'2',items:[{id:1,entryId:215,comment:'Synthetic service request',parent:null},{id:2,entryId:99,comment:'Unrelated'}]};
 const first=mergeIntake({records:{}},source,['215'],'2026-10-01T00:00:00.000Z');
 assert.equal(first.lastPoll.added,1);assert.equal(Object.keys(first.records).length,1);assert.equal(JSON.stringify(first).includes('Synthetic service request'),false);
 const same=mergeIntake(first,source,['215'],'2026-10-02T00:00:00.000Z');assert.equal(same.lastPoll.added,0);
 same.records['tistory-comment-1'].status='reviewed';source.items[0].comment='Changed synthetic request';
 const changed=mergeIntake(same,source,['215'],'2026-10-03T00:00:00.000Z');
 assert.equal(changed.lastPoll.changed,1);assert.equal(changed.records['tistory-comment-1'].status,'needs_review');assert.equal(changed.records['tistory-comment-1'].priorReview.status,'reviewed');
 assert.throws(()=>matchReviewRevision({commentId:'1',postId:'215',bodyHash:'x'},{id:1,entryId:99,comment:'wrong post'}),/source mismatch/);
});
