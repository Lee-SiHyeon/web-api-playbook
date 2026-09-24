// Same-prompt model comparison for blog articles: generate -> record -> compose.
//
//   node workflows/model-compare/run.mjs generate --run=<dir> [--models=opus,sol] [--effort=xhigh]
//   node workflows/model-compare/run.mjs record   --run=<dir> [--models=opus,sol]
//   node workflows/model-compare/run.mjs compose  --run=<dir> [--left=opus --right=sol]
//
// <dir>/prompts.json: {"suffix":"...","cases":[{"name":"voxel-world","sourceId":"x-...","prompt":"..."}]}
// Each case is sent exactly once per model, tools disabled / read-only sandbox,
// and the answer is saved unedited. Model and effort are read back from the
// CLI's own session log, never assumed. Every number in the outputs is measured.
import {spawn,execFileSync,spawnSync} from 'node:child_process';
import {readFile,writeFile,readdir,mkdir,rm,rename} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {pathToFileURL} from 'node:url';

const MODELS={
 opus:{label:'Claude Opus 5.5',model:'claude-opus-5-5',cli:'claude'},
 sol:{label:'GPT-6 Sol',model:'gpt-6-sol',cli:'codex'},
};
const FF=process.env.FFMPEG_BIN||''; // Empty means resolve ffmpeg.exe/ffprobe.exe from PATH.
const PLAYWRIGHT=process.env.PLAYWRIGHT_MODULE||'playwright';
const CLAUDE=process.env.CLAUDE_BIN||'claude.exe';
const CODEX_JS=path.join(process.env.APPDATA||'','npm/node_modules/@openai/codex/bin/codex.js');
const sha=b=>createHash('sha256').update(b).digest('hex');
const [command,...rest]=process.argv.slice(2);
const opt=Object.fromEntries(rest.map(a=>{const m=/^--([a-z]+)=(.+)$/.exec(a);if(!m)throw Error('ARGUMENT '+a);return [m[1],m[2]];}));
if(!opt.run)throw Error('RUN_DIR_REQUIRED');
const run=path.resolve(opt.run),models=(opt.models||'opus,sol').split(',');
for(const m of models)if(!MODELS[m])throw Error('UNKNOWN_MODEL '+m);
const outDir=m=>path.join(run,'model-runs',m);
const walk=async d=>(await Promise.all((await readdir(d,{withFileTypes:true}).catch(()=>[])).map(e=>e.isDirectory()?walk(path.join(d,e.name)):[path.join(d,e.name)]))).flat();

async function claudeEffort(sessionId){
 const files=(await walk(path.join(process.env.USERPROFILE,'.claude/projects'))).filter(f=>f.endsWith(sessionId+'.jsonl'));
 const raw=files.length?await readFile(files[0],'utf8'):'';
 return [...new Set([...raw.matchAll(/"effort":"([a-z]+)"/g)].map(m=>m[1]))];
}
async function codexRollout(threadId){
 const file=(await walk(path.join(process.env.USERPROFILE,'.codex/sessions'))).find(f=>f.includes(threadId));
 if(!file)return {models:[],efforts:[]};
 const ctx=(await readFile(file,'utf8')).split('\n').map(l=>{try{return JSON.parse(l)}catch{return null}}).filter(o=>o?.type==='turn_context');
 return {models:[...new Set(ctx.map(o=>o.payload?.model))],efforts:[...new Set(ctx.map(o=>o.payload?.effort))]};
}
function exec(bin,args,cwd){
 return new Promise(resolve=>{const started=Date.now();
  const c=spawn(bin,args,{cwd,windowsHide:true,shell:false,stdio:['ignore','pipe','pipe']});
  let out='',err='';c.stdout.on('data',d=>out+=d);c.stderr.on('data',d=>err+=d);
  c.on('close',code=>resolve({code,out,err,durationMs:Date.now()-started}));});
}
async function generateOne(key,c,suffix,effort){
 const spec=MODELS[key],dir=outDir(key),prompt=c.prompt+suffix,html=path.join(dir,`${c.name}.html`);
 let answer='',models=[],efforts=[],usage={},code,durationMs,extra={};
 if(spec.cli==='claude'){
  const r=await exec(CLAUDE,['-p',prompt,'--model',spec.model,'--effort',effort,'--output-format','json','--tools',''],dir);
  ({code,durationMs}=r);let j=null;try{j=JSON.parse(r.out);}catch{}
  answer=j?.result??'';models=Object.keys(j?.modelUsage||{});usage={outputTokens:j?.usage?.output_tokens??null};
  efforts=j?.session_id?await claudeEffort(j.session_id):[];extra={sessionId:j?.session_id??null,tool:'claude -p (tools disabled)'};
 }else{
  const r=await exec(process.execPath,[CODEX_JS,'exec','-m',spec.model,'-c',`model_reasoning_effort="${effort}"`,'--skip-git-repo-check','-s','read-only','--json','-o',html,prompt],dir);
  ({code,durationMs}=r);const ev=r.out.split('\n').map(l=>{try{return JSON.parse(l)}catch{return null}}).filter(Boolean);
  const threadId=ev.find(e=>e.type==='thread.started')?.thread_id;answer=await readFile(html,'utf8').catch(()=> '');
  ({models,efforts}=threadId?await codexRollout(threadId):{models:[],efforts:[]});
  const u=ev.findLast(e=>e.type==='turn.completed')?.usage;usage={outputTokens:u?.output_tokens??null,reasoningOutputTokens:u?.reasoning_output_tokens??null};
  extra={threadId,tool:'codex exec (read-only sandbox)',commandExecutions:ev.filter(e=>e.item?.type==='command_execution').length};
 }
 await writeFile(html,answer,'utf8');
 const prov={name:c.name,sourceId:c.sourceId??null,modelKey:key,requestedModel:spec.model,requestedEffort:effort,modelsReported:models,effortsReported:efforts,
  prompt:c.prompt,promptSuffix:suffix,promptSha256:sha(prompt),exitCode:code,durationMs,...usage,...extra,
  htmlSha256:sha(answer),htmlBytes:Buffer.byteLength(answer),looksLikeHtml:/^\s*<!doctype html|^\s*<html/i.test(answer),
  verified:models.length===1&&models[0]===spec.model&&efforts.length===1&&efforts[0]===effort,editedAfterGeneration:false,checkedAt:new Date().toISOString()};
 await writeFile(path.join(dir,`${c.name}.provenance.json`),JSON.stringify(prov,null,2)+'\n');
 return {model:key,name:c.name,verified:prov.verified,modelsReported:models,effortsReported:efforts,durationMs,htmlBytes:prov.htmlBytes};
}

async function record(key){
 const dir=outDir(key),{chromium}=await import(PLAYWRIGHT==='playwright'?PLAYWRIGHT:pathToFileURL(PLAYWRIGHT).href);
 const cases=JSON.parse(await readFile(path.join(run,'prompts.json'),'utf8')).cases;
 const browser=await chromium.launch({headless:true,args:['--use-angle=d3d11','--enable-gpu','--ignore-gpu-blocklist']});
 const results=[];
 try{
  for(const c of cases){
   const seconds=c.seconds||20;let res;
   for(const warmup of [6,15,25]){ // re-record with a longer warm-up if the page stalls
    const tmp=path.join(dir,`.rec-${c.name}`);await rm(tmp,{recursive:true,force:true});await mkdir(tmp);
    const ctx=await browser.newContext({viewport:{width:1280,height:720},recordVideo:{dir:tmp,size:{width:1280,height:720}}});
    const t0=Date.now(),page=await ctx.newPage(),errors=[];
    page.on('pageerror',e=>errors.push(String(e.message).slice(0,200)));page.on('console',m=>{if(m.type()==='error')errors.push(m.text().slice(0,200));});
    const renderer=await page.evaluate(()=>{const g=document.createElement('canvas').getContext('webgl');const d=g&&g.getExtension('WEBGL_debug_renderer_info');return d?g.getParameter(d.UNMASKED_RENDERER_WEBGL):null;});
    await page.goto(pathToFileURL(path.join(dir,`${c.name}.html`)).href,{waitUntil:'load'});await page.waitForTimeout(warmup*1000);
    const start=(Date.now()-t0)/1000;
    const fps=await page.evaluate(s=>new Promise(r=>{let n=0;const a=performance.now();const f=()=>{n++;if(performance.now()-a<s*1000)requestAnimationFrame(f);else r(Math.round(n/((performance.now()-a)/1000)));};requestAnimationFrame(f);}),seconds);
    const video=page.video();await ctx.close();const out=path.join(dir,`${c.name}.mp4`);
    execFileSync(path.join(FF,'ffmpeg.exe'),['-y','-loglevel','error','-ss',String(start),'-i',await video.path(),'-t',String(seconds),'-an','-c:v','libx264','-preset','slow','-crf','20','-pix_fmt','yuv420p','-movflags','+faststart',out]);
    await rm(tmp,{recursive:true,force:true});
    const fz=spawnSync(path.join(FF,'ffmpeg.exe'),['-hide_banner','-i',out,'-vf','freezedetect=n=0.001:d=1','-map','0:v:0','-f','null','-'],{encoding:'utf8'}).stderr;
    const freezes=[...fz.matchAll(/freeze_start: ([\d.]+)/g)].map(m=>Number(m[1]));
    const duration=Number(execFileSync(path.join(FF,'ffprobe.exe'),['-v','error','-show_entries','format=duration','-of','csv=p=0',out],{encoding:'utf8'}).trim());
    res={name:c.name,file:path.basename(out),sha256:sha(await readFile(out)),renderer,warmupCutSeconds:Number(start.toFixed(2)),measuredDurationSeconds:duration,measuredFps:fps,consoleErrors:errors,freezeStarts:freezes};
    // A freeze only in the last second is usually a low-motion idle pose; earlier ones mean a stall.
    if(freezes.every(t=>t>=duration-1.5))break;
   }
   results.push(res);
  }
 }finally{await browser.close();}
 await writeFile(path.join(dir,'recordings.json'),JSON.stringify({checkedAt:new Date().toISOString(),browser:'headless Chromium, ANGLE D3D11',results},null,2)+'\n');
 return results.map(({name,measuredDurationSeconds,measuredFps,consoleErrors,freezeStarts})=>({model:key,name,measuredDurationSeconds,measuredFps,errors:consoleErrors.length,freezeStarts}));
}

async function compose(left,right){
 const cases=JSON.parse(await readFile(path.join(run,'prompts.json'),'utf8')).cases,out=path.join(run,'compare');await mkdir(out,{recursive:true});
 const font='C\\:/Windows/Fonts/malgunbd.ttf',label=t=>`drawbox=x=0:y=0:w=iw:h=64:color=black@0.55:t=fill,drawtext=fontfile='${font}':text='${t}':fontcolor=white:fontsize=34:x=24:y=14`;
 const probe=f=>Number(execFileSync(path.join(FF,'ffprobe.exe'),['-v','error','-show_entries','format=duration','-of','csv=p=0',f],{encoding:'utf8'}).trim());
 const results=[];
 for(const c of cases){
  const provs=await Promise.all([left,right].map(k=>readFile(path.join(outDir(k),`${c.name}.provenance.json`),'utf8').then(JSON.parse)));
  if(provs.some(p=>!p.verified)||provs[0].promptSha256!==provs[1].promptSha256)throw Error('UNVERIFIED_OR_DIFFERENT_PROMPT '+c.name);
  const [l,r]=[left,right].map(k=>path.join(outDir(k),`${c.name}.mp4`)),t=Math.min(probe(l),probe(r)),file=path.join(out,`${c.name}-compare.mp4`);
  const lt=`${MODELS[left].label} (${provs[0].effortsReported[0]})`,rt=`${MODELS[right].label} (${provs[1].effortsReported[0]})`;
  execFileSync(path.join(FF,'ffmpeg.exe'),['-y','-loglevel','error','-i',l,'-i',r,'-filter_complex',`[0:v]scale=960:540,setsar=1,${label(lt)}[l];[1:v]scale=960:540,setsar=1,${label(rt)}[r];[l][r]hstack=inputs=2[v]`,
   '-map','[v]','-t',String(t),'-an','-c:v','libx264','-preset','slow','-crf','21','-pix_fmt','yuv420p','-movflags','+faststart',file]);
  results.push({name:c.name,file:`compare/${c.name}-compare.mp4`,sha256:sha(await readFile(file)),durationSeconds:probe(file),left:{label:lt,sha256:sha(await readFile(l))},right:{label:rt,sha256:sha(await readFile(r))}});
 }
 await writeFile(path.join(out,'compare.json'),JSON.stringify({checkedAt:new Date().toISOString(),layout:'side by side, scaled and labeled only, trimmed to the shorter clip',results},null,2)+'\n');
 return results.map(({name,durationSeconds,left,right})=>({name,durationSeconds,left:left.label,right:right.label}));
}

if(command==='generate'){
 const {cases,suffix=''}=JSON.parse(await readFile(path.join(run,'prompts.json'),'utf8')),effort=opt.effort||'xhigh';
 for(const m of models)await mkdir(outDir(m),{recursive:true});
 const results=await Promise.all(models.flatMap(m=>cases.map(c=>generateOne(m,c,suffix,effort))));
 console.log(JSON.stringify(results));if(results.some(r=>!r.verified))process.exitCode=2;
}else if(command==='record'){
 const all=[];for(const m of models)all.push(...await record(m));console.log(JSON.stringify(all));
}else if(command==='compose'){
 console.log(JSON.stringify(await compose(opt.left||'opus',opt.right||'sol')));
}else throw Error('COMMAND generate|record|compose');
