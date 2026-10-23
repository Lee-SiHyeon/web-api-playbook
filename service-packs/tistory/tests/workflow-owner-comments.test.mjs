import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createPrivateOwnerComment,createPrivateOwnerReply,readOwnerComments} from '../lib/workflows/owner-comments.mjs';
import {createHash} from 'node:crypto';
const input={operationId:'synthetic',postId:'216',payload:{captcha:'',comment:'Synthetic owner test',homepage:'synthetic-home',name:'synthetic-name',password:'synthetic-secret',isSecret:true,parent:null,mentionId:null}};
const response=data=>({status:200,headers:new Headers({'content-type':'application/json'}),json:async()=>data});
test('reply binds parent revision and recovers a lost response without resend',async()=>{
 const root=await mkdtemp(join(tmpdir(),'private-reply-'));
 const parent={id:'100',entryId:'216',comment:'Synthetic question',parent:null,secret:true};
 const replyInput={...input,parentBodyHash:createHash('sha256').update(parent.comment).digest('hex'),payload:{...input.payload,parent:100}};
 let items=[parent],calls=0;
 const deps={readComments:async()=>({complete:true,items}),request:async()=>{calls++;items.push({id:'101',entryId:'216',comment:input.payload.comment,parent:'100',secret:true});throw Error('lost');}};
 assert.equal((await createPrivateOwnerReply(root,replyInput,deps)).parentId,'100');
 await createPrivateOwnerReply(root,replyInput,deps);assert.equal(calls,1);
 items[0]={...parent,comment:'Changed question'};
 await assert.rejects(createPrivateOwnerReply(root,replyInput,deps),/Parent/);assert.equal(calls,1);
});
test('stale parent blocks first send and a matching body on another parent does not prove reply success',async()=>{
 const parent={id:'100',entryId:'216',comment:'Synthetic question',parent:null};
 const replyInput={...input,parentBodyHash:createHash('sha256').update(parent.comment).digest('hex'),payload:{...input.payload,parent:100}};
 let calls=0;const root=await mkdtemp(join(tmpdir(),'private-reply-'));
 await assert.rejects(createPrivateOwnerReply(root,replyInput,{readComments:async()=>({complete:true,items:[{...parent,comment:'edited'}]}),request:async()=>{calls++;}}),/Parent/);assert.equal(calls,0);
 await assert.rejects(createPrivateOwnerReply(root,replyInput,{readComments:async()=>({complete:true,items:[parent,{id:'102',entryId:'216',parent:'999',comment:input.payload.comment,secret:true}]}),request:async()=>{calls++;}}),/unresolved/);assert.equal(calls,1);
});
test('independent snapshot reconciles all pages and rejects changing or stalled results',async()=>{
 const a={id:'1',entryId:'216',comment:'synthetic',secret:true},b={...a,id:'2'};
 let calls=[];
 const good=await readOwnerComments('synthetic',{fetchImpl:async url=>{calls.push(url);return response({totalCount:'2',items:calls.length===1?[a]:[b]});}});
 assert.equal(good.complete,true);assert.equal(good.pagesRead,2);assert.equal(good.items.length,2);assert.match(calls[1],/\?page=2$/);
 for(const second of [{totalCount:'3',items:[b]},{totalCount:'2',items:[a]},{totalCount:'2',items:[{...a,comment:'edited'}]}]){
  let n=0;await assert.rejects(readOwnerComments('synthetic',{fetchImpl:async()=>response(++n===1?{totalCount:'2',items:[a]}:second)}));
 }
 await assert.rejects(readOwnerComments('synthetic',{maxPages:1,fetchImpl:async()=>response({totalCount:'2',items:[a]})}),/budget/);
});
test('lost create response reconciles without a second POST and stores no body or secrets',async()=>{
 const root=await mkdtemp(join(tmpdir(),'private-comment-'));let calls=0,items=[];
 const deps={readComments:async()=>({complete:true,items}),request:async()=>{calls++;items=[{id:'90002',entryId:'216',comment:input.payload.comment,secret:true}];throw Error('response lost');}};
 const first=await createPrivateOwnerComment(root,input,deps);
 assert.equal(first.status,'readback-verified');
 await createPrivateOwnerComment(root,input,deps);assert.equal(calls,1);
 const text=await readFile(first.file,'utf8');
 for(const value of [input.payload.comment,input.payload.password,input.payload.name])assert.equal(text.includes(value),false);
});
test('unresolved creation is never resent, including after a new invocation',async()=>{
 const root=await mkdtemp(join(tmpdir(),'private-comment-'));let calls=0;
 const deps={readComments:async()=>({complete:true,items:[]}),request:async()=>{calls++;throw Error('timeout');}};
 await assert.rejects(createPrivateOwnerComment(root,input,deps),/unresolved/);
 await assert.rejects(createPrivateOwnerComment(root,input,deps),/unresolved/);assert.equal(calls,1);
});
test('incomplete scans and existing identical comments prevent creation',async()=>{
 for(const snapshot of [{complete:false,items:[]},{complete:true,items:[{id:'1',entryId:'216',comment:input.payload.comment,secret:true}]}]){
  const root=await mkdtemp(join(tmpdir(),'private-comment-'));let calls=0;
  await assert.rejects(createPrivateOwnerComment(root,input,{readComments:async()=>snapshot,request:async()=>{calls++;}}));assert.equal(calls,0);
 }
});
