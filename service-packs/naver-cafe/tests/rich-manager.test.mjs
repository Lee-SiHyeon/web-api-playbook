import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {NaverCafeManager} from '../lib/manager.mjs';
import {richDocument,cafeText,cafeTable,documentText} from '../lib/editor-document.mjs';

async function fixture(t,{badRepresentative=false}={}){
 const journalDir=await mkdtemp(path.join(tmpdir(),'cafe-manager-'));t.after(()=>rm(journalDir,{recursive:true,force:true}));
 const context={cafeId:'31796283',cafeSlug:'lifehackailab'},options={open:true,naverOpen:true,externalOpen:true,enableComment:true,enableScrap:true,enableCopy:true,useAutoSource:false,cclTypes:[]};
 const model=richDocument([cafeText('원래 본문'),cafeTable(['열'],[['행']]),{'@ctype':'image',id:'i',src:'https://cafeptthumb-phinf.pstatic.net/i.png?type=w1',internalResource:true,represent:true}]);
 let stored=JSON.stringify(richDocument([cafeText('원래 본문')])),body='원래 본문',writes=0,payload;
 const editor=()=>({userId:'fixture-owner',article:{articleId:'6',writerId:'fixture-owner',contentJson:stored,parentId:0,headId:4,tagList:['현재태그']},selectedMenu:{menu:{menuId:9},selectedHead:{headId:0}},options});
 const session={managerRequest:async(op,args)=>{
  if(op==='articleEditor')return {data:{result:editor()}};
  assert.equal(op,'articleUpdate');writes++;payload=args.article;stored=payload.contentJson;body=documentText(JSON.parse(stored).document.components);return {data:{result:{}},evidence:{httpStatus:200}};
 },request:async(op)=>({data:{result:op==='article'?{article:{contentHtml:'<img src="https://cafeptthumb-phinf.pstatic.net/i.png">'}}:{articleList:[{articleId:6,representImage:badRepresentative?'https://cafeptthumb-phinf.pstatic.net/banner.png':'https://cafeptthumb-phinf.pstatic.net/i.png'}]}}})};
 const reader={list:async()=>({articles:[{articleId:'6',menuId:'9',subject:'제목'}],hasNext:false}),article:async()=>({article:{subject:'제목',contentText:body}})};
 const manager=new NaverCafeManager({session,reader,context,journalDir});
 const input={articleId:'6',expectedSubject:'제목',contentJson:JSON.stringify(model)};
 return {manager,input,get writes(){return writes;},get payload(){return payload;}};
}
test('rich owner readback preserves tags, head and options and checks the list representative; repeat reconciles without resend',async t=>{
 const f=await fixture(t);const result=await f.manager.updatePost(f.input);assert.equal(result.richDocumentVerified,true);assert.equal(result.representativeSet,true);
 assert.deepEqual(f.payload.tagList,['현재태그']);assert.equal(f.payload.headId,4);assert.equal(f.payload.menuId,9);assert.equal(f.payload.open,true);
 const again=await f.manager.updatePost(f.input);assert.equal(again.alreadyDone,true);assert.equal(f.writes,1);
});
test('wrong list representative stops verification and never sends an uncertain update twice',async t=>{
 const f=await fixture(t,{badRepresentative:true});await assert.rejects(f.manager.updatePost(f.input),{code:'NEEDS_RECONCILIATION'});
 await assert.rejects(f.manager.updatePost(f.input),{code:'NEEDS_RECONCILIATION'});assert.equal(f.writes,1);
});
