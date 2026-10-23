import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {updateReviewedContent} from '../lib/workflows/content-update.mjs';
const hash=x=>createHash('sha256').update(x).digest('hex');
async function setup(){const root=await mkdtemp(join(tmpdir(),'content-update-'));await mkdir(join(root,'data/pilots'),{recursive:true});await writeFile(join(root,'data/pilots/review.json'),'{}');return root;}
const input={postId:'216',updateId:'layout',expectedBeforeHash:hash('old'),content:'new',reviewedContentHash:hash('new'),reviewEvidenceRef:'data/pilots/review.json'};
function fixture({timeout=false,changeTitle=false}={}){
 const post={id:'216',title:'Title',content:'old',slogan:'',visibility:20,category:1,tags:['tag'],published:1,password:'',acceptComment:1,uselessMargin:1,cclCommercial:0,cclDerive:0,daumLikeCategory:null,thumbnail:null,type:'0'};
 let puts=0;
 return {post,get puts(){return puts;},request:async(path,options={})=>{if(options.method==='PUT'){puts++;assert.equal(path,'/manage/post/216.json');assert.equal(options.body.title,'Title');assert.equal(options.body.tag,'tag');assert.equal(options.body.type,'post');post.content=options.body.content;if(changeTitle)post.title='Unexpected';if(timeout)throw Error('timeout');return {mime:'application/json',raw:'{}'};}return {mime:'text/html',raw:'post: '+JSON.stringify(post)+'\nneedCaptcha: false\npostType: \"post\"'};}};
}
test('updates content once, preserves settings and reconciles without another PUT',async()=>{const root=await setup(),f=fixture();assert.equal((await updateReviewedContent(root,input,{request:f.request})).changedThisInvocation,true);assert.equal((await updateReviewedContent(root,input,{request:f.request})).changedThisInvocation,false);assert.equal(f.puts,1);});
test('stale baseline prevents overwrite',async()=>{const root=await setup(),f=fixture();f.post.content='someone else';await assert.rejects(updateReviewedContent(root,input,{request:f.request}),/Current content changed/);assert.equal(f.puts,0);});
test('timed-out successful PUT is reconciled by reading instead of resending',async()=>{const root=await setup(),f=fixture({timeout:true});await assert.rejects(updateReviewedContent(root,input,{request:f.request}),/indeterminate/);assert.equal((await updateReviewedContent(root,input,{request:f.request})).status,'readback-verified');assert.equal(f.puts,1);});
test('metadata change cannot be concealed by a later reconciliation',async()=>{const root=await setup(),f=fixture({timeout:true,changeTitle:true});await assert.rejects(updateReviewedContent(root,input,{request:f.request}));await assert.rejects(updateReviewedContent(root,input,{request:f.request}),/Unrelated publication field/);assert.equal(f.puts,1);});
