import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import {NaverEditorClient} from '../../scripts/api/editor-client.mjs';
import {environmentSession} from '../../scripts/api/environment-session.mjs';
import {WriteJournal} from '../../scripts/api/write-journal.mjs';
import {verifiedVideoComponent,VIDEO_MAX_BYTES} from '../../scripts/api/video-upload.mjs';
import {runAdaptiveArticleReview} from './adaptive-article-review.mjs';
import {verifiedUploadComponent} from '../../scripts/api/media-upload.mjs';
import {sha256} from '../../scripts/gates/publication-document.mjs';
import {read,save,loadContext,assemble,verify,requireJevQuality} from './core.mjs';
import {runJevQuality} from './jev-quality.mjs';
const commands=['status','jev-quality','adaptive-gates','assemble','baseline','upload','preview','prepare','authorize','publish','readback','verify','refresh-public'];
const argv=process.argv.slice(2),command=argv.shift(),options={};
for(const arg of argv){const m=/^--([a-z-]+)=(.+)$/.exec(arg);if(!m||options[m[1]]||!['manifest','post','approved-by'].includes(m[1]))throw Error('ARGUMENT_SCOPE');options[m[1]]=m[2];}
if(command==='help'||!command){console.log('npm run republish -- <'+commands.join('|')+'|handoff> --manifest=<manifest.json> --post=<id>\nJev is required: run jev-quality before assemble/authorize/publish.\nAuthorization records existing consent only: authorize --approved-by=user.\nAuthenticated commands read {cookieHeader} from stdin; handoff is a single-use local session form.');process.exit(0);}
const manifestFile=path.resolve(options.manifest||'republish-manifest.json');
let session,input;
try{
 if(command==='handoff'){
  const {startHandoff}=await import('./session-handoff.mjs');await startHandoff({manifestFile,post:options.post});
 }else if(command==='status'){
  const m=await read(manifestFile);for(const [id,e]of Object.entries(m.posts||{})){const dir=path.resolve(path.dirname(manifestFile),e.directory);let v;try{v=await read(path.join(dir,'final-verification.json'));}catch{}console.log(JSON.stringify({id,directory:dir,verifiedAt:v?.checkedAt,passed:v?.passed??false}));}
 }else{
  if(!commands.includes(command))throw Error('COMMAND_SCOPE');
  const ctx=await loadContext(manifestFile,options.post,['publish','readback','verify','refresh-public'].includes(command));const {dir,id,blogId,job}=ctx;
  if(command==='jev-quality'){console.log(JSON.stringify(await runJevQuality({dir})));}
  else if(command==='adaptive-gates'){
   const bundle={...job.publicationBundle,document:await read(path.join(dir,'document.json')),
     claimLedger:await read(path.join(dir,'claim-ledger.json')),gatePlan:await read(path.join(dir,'gate-plan.json')),
     jevQuality:await read(path.join(dir,'jev-quality.json'))};
   try{bundle.research=await read(path.join(dir,'research-snapshot.json'));}catch(e){if(e.code!=='ENOENT')throw e;}
   const report=await runAdaptiveArticleReview({bundle});await save(path.join(dir,'adaptive-review.json'),report);
   console.log(JSON.stringify({passed:report.passed,failedChecks:report.failedChecks,nextActions:report.nextActions}));
   if(!report.passed)process.exitCode=2;
  }
  else if(command==='assemble'){console.log(JSON.stringify(await assemble(ctx)));}
  else if(command==='authorize'){
   if(options['approved-by']!=='user')throw Error('USER_AUTHORIZATION_REQUIRED');
   requireJevQuality(job);
   const code=await new Promise((resolve,reject)=>{const child=spawn(process.execPath,[fileURLToPath(new URL('../../scripts/gates/authorize-api-update.mjs',import.meta.url)),`--job=${path.join(dir,'job.json')}`,`--preflight=${path.join(dir,'preflight.json')}`,`--output=${path.join(dir,'authorized-job.json')}`,'--approved-by=user'],{stdio:'inherit',windowsHide:true});child.on('error',reject);child.on('exit',resolve);});if(code!==0)process.exitCode=2;
  }else if(command==='verify'){const v=await verify(ctx);console.log(JSON.stringify({id,passed:v.passed,checks:v.checks}));if(!v.passed)process.exitCode=2;}
  else{
   if(command!=='refresh-public'){
    const chunks=[];let size=0;for await(const chunk of process.stdin){size+=chunk.length;if(size>65536)throw Error('INPUT_LIMIT');chunks.push(chunk);}input=JSON.parse(Buffer.concat(chunks).toString());chunks.forEach(c=>c.fill(0));session=environmentSession({NAVER_COOKIE:input.cookieHeader});input.cookieHeader='';
   }
   const journal=new WriteJournal(ctx.journal),client=new NaverEditorClient({blogId,session,journal});
   if(['baseline','readback'].includes(command)){
    // Never overwrite the baseline needed to prove a completed write's preservation.
    if(command==='baseline'){try{await fs.access(path.join(dir,'owner-baseline.json'));throw Error('BASELINE_EXISTS');}catch(e){if(e.code!=='ENOENT')throw e;}}
    const owner=await client.loadEditor(id),pub=await client.readPost(id);
   await save(path.join(dir,command==='baseline'?'owner-baseline.json':'final-owner.json'),{checkedAt:new Date().toISOString(),blogId,logNo:id,model:owner.model,postConfiguration:owner.form.postConfiguration,postFormMeta:owner.form.postFormMeta});
   await save(path.join(dir,command==='baseline'?'public-baseline.json':'final-public.json'),pub);
   }else if(command==='refresh-public'){await save(path.join(dir,'final-public.json'),await client.readPost(id));}
   else if(command==='preview'){
    const {previewEditorModel}=await import('../../scripts/hybrid/editor-preview.mjs');const document=await read(path.join(dir,'document.json'));
    if(document.blogId!==blogId||String(document.logNo)!==id)throw Error('DOCUMENT_SCOPE');
    const model=await client.compilePreview(id,document);await save(path.join(dir,'compiled-model.json'),model);
    await save(path.join(dir,'native-preview.json'),await previewEditorModel({model,document,previewSourceLogNo:id,cookieHeader:session.cookieFor('https://blog.naver.com/'),baseDir:dir}));
   }else if(command==='prepare'){await save(path.join(dir,'preflight.json'),await client.prepareUpdate(job));}
   else if(command==='publish'){
   // The maintained client enforces full gates, revision binding, one-attempt journal and readback.
    requireJevQuality(job);
    const result=await client.updatePost(job,{baseDir:dir});await save(path.join(dir,'publish-receipt.json'),result);if(!result.ok||!result.readbackVerified)throw Error('PUBLICATION_UNVERIFIED');
   }else if(command==='upload'){
    const document=await read(path.join(dir,'document.json'));if(document.blogId!==blogId||String(document.logNo)!==id)throw Error('DOCUMENT_SCOPE');
    const pending=[];
    for(const block of document.blocks.filter(b=>['image','video'].includes(b.type))){
     if(block.uploadReceipt){await (block.type==='video'?verifiedVideoComponent:verifiedUploadComponent)(block.uploadReceipt,{blogId,journal});continue;}
     if(block.publishedUrl||block.type==='video'&&block.videoId)continue; // Existing owner media is validated by compilePreview, never re-uploaded implicitly.
     const file=path.resolve(dir,block.file),real=await fs.realpath(file),relative=path.relative(await fs.realpath(dir),real);if(relative.startsWith('..')||path.isAbsolute(relative))throw Error('IMAGE_PATH_SCOPE');
     if(block.type==='video'&&(await fs.stat(real)).size>VIDEO_MAX_BYTES)throw Error('VIDEO_INPUT');
     const bytes=await fs.readFile(real);if(sha256(bytes)!==block.sha256)throw Error('IMAGE_HASH');
     pending.push({block,bytes,fileName:path.basename(file)});
    }
    for(const item of pending){
      const video=item.block.type==='video',receipt=video?
        await client.uploadVideo({bytes:item.bytes,fileName:item.fileName,meta:item.block.mediaMeta||{title:item.fileName.replace(/\.(mp4|webm)$/,'').slice(0,40),ai:item.block.rights?.basis==='generated'}}):
        await client.uploadImage({bytes:item.bytes,fileName:item.fileName});
      item.block.uploadReceipt=receipt;if(video)item.block.videoId=receipt.videoId;else item.block.publishedUrl=receipt.publishedUrl;
      await save(path.join(dir,'document.json'),document);
      if(!receipt.readbackVerified)throw Error('VIDEO_PROCESSING_PENDING');
    }
   }
   console.log(JSON.stringify({id,command,ok:true}));
  }
 }
}catch(e){console.error(JSON.stringify({ok:false,code:/^[A-Z_]+$/.test(e.message)?e.message:(e.code||'REPUBLISH_FAILED')}));process.exitCode=2;}
finally{session?.clear();if(input)input.cookieHeader='';}
