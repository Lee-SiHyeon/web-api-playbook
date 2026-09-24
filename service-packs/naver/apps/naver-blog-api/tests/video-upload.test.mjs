import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {uploadVideo,verifiedVideoComponent,reconcileVideoUpload,VIDEO_CHUNK_BYTES,validateVideoInput} from '../scripts/api/video-upload.mjs';
import {WriteJournal} from '../scripts/api/write-journal.mjs';
import {compileEditorModel,inspectEditorModel} from '../scripts/api/editor-model.mjs';
import {renderUnits} from '../scripts/gates/publication-document.mjs';
import {verifyPublicationArtifacts} from '../scripts/gates/publication-artifacts.mjs';
import {evaluatePublisherJobGate} from '../scripts/gates/publisher-gates.mjs';
import {parsePublicDocument} from '../scripts/api/public-document.mjs';
const videoId='A'.repeat(36),runtimeKey='fixture-upload-session-secret',grantToken='fixture-grant-secret';
const sha=b=>createHash('sha256').update(b).digest('hex');
function fixture(size=64){const b=Buffer.alloc(size);b.write('1a45dfa3',0,'hex');return b}
function setup(bytes,mode){
 const calls=[];
 const fetchImpl=async(url,init)=>{
  const u=new URL(url);calls.push({url,init});
  assert.equal(new Headers(init.headers).has('cookie'),false);
  const json=value=>new Response(JSON.stringify(value),{status:200,headers:{'content-type':'application/json'}});
  if(u.pathname.endsWith('/video-uploader/token'))return json({token:grantToken,type:'UPLOAD',videoId,data:{serviceId:2,userId:'blog:fixture',fileSizeLimit:8589934592}});
  assert.equal(new Headers(init.headers).has('SE-Authorization'),false);
  if(u.pathname.endsWith('/sessions')){
   if(mode==='lost-allocation')throw Error('lost');
   return json({key:runtimeKey,serviceId:2,videoId,fileName:'fixture.webm',fileSize:bytes.length,chunkSize:VIDEO_CHUNK_BYTES,chunkUpload:true,servers:[mode==='foreign'?'attacker.invalid':'warp-pr1.vod.naver.com']});
  }
  if(u.pathname==='/upload/v2/files'){
   if(mode==='lost-chunk')throw Error('lost');
   assert.equal(init.body.get('key'),runtimeKey);assert.equal(init.body.get('chunkUpload'),'true');
   return json({result:true,chunkIndex:Number(init.body.get('chunkIndex')),chunkSize:Number(init.body.get('currentChunkSize'))});
  }
  if(u.pathname==='/postman/api/v1/files'){
   assert.equal(new Headers(init.headers).get('content-type'),'text/plain');
   const q=JSON.parse(init.body).query;assert.ok(q.includes(runtimeKey));
   if(mode==='pending')return json({code:200,data:{_0_0:[]},errors:[]});
   const item=(type,data)=>({type,status:'done',data,errors:[]});
   return json({code:200,data:{_0_0:q.includes('fragment videoHeader')?
    [item('Ingest',[{videoId,encodeType:'normal'}]),item('VideoHeader',[{width:320,height:180,duration:2,rotation:0,fileSize:bytes.length}])]:
    [item('VideoHashCode',[{videoSHA256:mode==='hash-mismatch'?'0'.repeat(64):sha(bytes)}]),
     item('Thumbnails',[{type:'SCENE',timeMark:0,path:'https://phinf.pstatic.net/image.nmv/fixture_01.jpg'}]),item('Hls',[{status:'done'}])]},errors:[]});
  }
  if(u.hostname==='phinf.pstatic.net')return new Response(Buffer.from([255,216,255,217]),{headers:{'content-type':'image/jpeg'}});
  throw Error('UNEXPECTED_REQUEST');
 };
 return {calls,fetchImpl};
}
async function workspace(fn){
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'naver-video-'));
 try{await fn(new WriteJournal(dir),dir)}finally{if(path.dirname(path.resolve(dir))!==path.resolve(os.tmpdir())||!path.basename(dir).startsWith('naver-video-'))throw Error('CLEANUP_SCOPE');await fs.rm(dir,{recursive:true,force:true});}
}
const ctx=(journal,bytes)=>({journal,bytes,fileName:'fixture.webm',blogId:'testblog',appCode:'blogpc001',
 token:'x.'+Buffer.from(JSON.stringify({exp:Date.now()/1000+1000})).toString('base64url')+'.x',meta:{title:'Video fixture',ai:false}});
const options=fetchImpl=>({fetchImpl,maxPolls:3,pollIntervalMs:0,sleep:async()=>{}});
test('HTTP video upload chunks, source hash, thumbnail and native caption remain bound without secrets',async()=>workspace(async(journal,dir)=>{
 const bytes=fixture(VIDEO_CHUNK_BYTES+31),f=setup(bytes),r=await uploadVideo(ctx(journal,bytes),options(f.fetchImpl));
 assert.equal(r.readbackVerified,true);assert.equal(r.sourceHashVerified,true);
 assert.equal(f.calls.filter(c=>c.url.endsWith('/upload/v2/files')).length,2);
 const disk=await fs.readFile(path.join(dir,(await fs.readdir(dir))[0]),'utf8');
 for(const secret of [runtimeKey,grantToken])assert.equal(disk.includes(secret),false);
 const component=await verifiedVideoComponent(r,{journal,blogId:'testblog',fetchImpl:f.fetchImpl});
 const model={document:{components:[{'@ctype':'documentTitle',title:[{'@ctype':'paragraph',nodes:[{'@ctype':'textNode',value:'Old'}]}]}]}};
 const document={blogId:'testblog',title:'New',blocks:[{type:'video',videoId,sha256:r.sha256},{type:'paragraph',presentation:'caption',text:'A native video caption.'}]};
 const compiled=compileEditorModel(model,document,{uploadedComponents:[component]});
 assert.deepEqual(inspectEditorModel(compiled).units,renderUnits(document));
 assert.equal(compiled.document.components.filter(c=>c['@ctype']==='video').length,1);
 const reconciled=await reconcileVideoUpload({blogId:'testblog',sha256:r.sha256,fileName:r.fileName,journal},options(f.fetchImpl));
 assert.equal(reconciled.videoId,videoId);
 const postCount=f.calls.filter(c=>c.init.method==='POST').length;
 await assert.rejects(uploadVideo(ctx(journal,bytes),options(f.fetchImpl)),/WRITE_ALREADY_ATTEMPTED/);
 assert.equal(f.calls.filter(c=>c.init.method==='POST').length,postCount);
}));
for(const mode of ['lost-allocation','lost-chunk','foreign','hash-mismatch'])test('video failure is journaled without automatic resubmission: '+mode,async()=>workspace(async(journal)=>{
 const bytes=fixture(),f=setup(bytes,mode);await assert.rejects(uploadVideo(ctx(journal,bytes),options(f.fetchImpl)));
 const count=f.calls.length;await assert.rejects(uploadVideo(ctx(journal,bytes),options(f.fetchImpl)),/WRITE_ALREADY_ATTEMPTED/);assert.equal(f.calls.length,count);
 if(mode==='foreign')assert.equal(f.calls.some(c=>c.url.includes('attacker')),false);
}));
test('processing pending is not a verified upload; process restart requires its runtime session',async()=>workspace(async(journal)=>{
 const bytes=fixture(),f=setup(bytes,'pending'),r=await uploadVideo(ctx(journal,bytes),options(f.fetchImpl));
 assert.equal(r.readbackVerified,false);assert.equal(r.state,'processing_pending');
 await assert.rejects(verifiedVideoComponent(r,{blogId:'testblog',journal,fetchImpl:f.fetchImpl}),/UNVERIFIED/);
 await assert.rejects(reconcileVideoUpload({blogId:'testblog',sha256:r.sha256,fileName:r.fileName,journal},options(f.fetchImpl)),/RUNTIME_SESSION_REQUIRED/);
}));
test('video input rejects extension/signature/path mismatch',()=>{
 assert.throws(()=>validateVideoInput(fixture(),'fixture.mp4'),/CONTAINER/);
 assert.throws(()=>validateVideoInput(fixture(),'../fixture.webm'),/VIDEO_INPUT/);
 const mp4=Buffer.alloc(64);mp4.write('ftyp',4);assert.equal(validateVideoInput(mp4,'fixture.mp4'),'video/mp4');
});
test('public video observation uses module id and excludes ephemeral playback keys',async()=>{
 const fragment=await fs.readFile(new URL('./fixtures/public-video-component.html',import.meta.url),'utf8');
 const html='<html><head><meta property="og:url" content="https://blog.naver.com/testblog/123456"><meta property="og:title" content="Video"></head><body><div id="post-view123456"><div class="se-main-container"><div class="se-component se-video">'+fragment+'</div></div></div></body></html>';
 const o=parsePublicDocument(html,{url:'https://blog.naver.com/PostView.naver?blogId=testblog&logNo=123456'});
 assert.equal(o.videoResources.length,1);assert.equal(o.units[0].type,'video');assert.equal(JSON.stringify(o).includes('inkey'),false);
});

test('publisher gate accepts the video block and verifies its actual source bytes',async()=>workspace(async(journal,dir)=>{
 const bytes=fixture(),file='fixture.webm';await fs.writeFile(path.join(dir,file),bytes);
 const video={type:'video',file,sha256:sha(bytes),videoId};
 const job={bodyBlocks:[video],publish:true,dryRun:false,publicationBundle:{document:{blocks:[]}}};
 let result=await evaluatePublisherJobGate(job,{baseDir:dir,checkReviewFiles:false});
 assert.equal(result.checks.blocksSupported,true);
 assert.equal(result.checks.videoFilesVerified,true);
 video.sha256='0'.repeat(64);
 result=await evaluatePublisherJobGate(job,{baseDir:dir,checkReviewFiles:false});
 assert.equal(result.checks.videoFilesVerified,false);
}));

test('dynamic original-media proof checks the actual source artifact bytes',async()=>workspace(async(journal,dir)=>{
 const bytes=fixture();await fs.writeFile(path.join(dir,'source.webm'),bytes);await fs.writeFile(path.join(dir,'published.webm'),bytes);
 const media={type:'video',file:'published.webm',sha256:sha(bytes),sourceId:'creator',sourceArtifact:{sourceFile:'source.webm',sourceSha256:sha(bytes),sourcePageUrl:'https://creator.example/demo'}};
 const bundle={format:'ai_research_article',gatePlan:{},document:{blocks:[media]},research:{sources:[{id:'creator',url:'https://creator.example/demo'}]}};
 const first=await verifyPublicationArtifacts(bundle,{baseDir:dir});assert.equal(first.checks.adaptiveOriginalMedia0Verified,true);
 await fs.writeFile(path.join(dir,'source.webm'),Buffer.alloc(64));
 const second=await verifyPublicationArtifacts(bundle,{baseDir:dir});assert.equal(second.checks.adaptiveOriginalMedia0Verified,false);
}));
