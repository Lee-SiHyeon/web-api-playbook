import { readFile,writeFile,mkdir,open,unlink } from 'node:fs/promises';
import { writeBotJson } from './lib/bot-json-store.mjs';
import { captureBotFailure,recordBotFailure,recordBotEvent,safeBotFailure } from './lib/bot-diagnostics.mjs';
import { readBotProcessPresence,botWorkerPresence,botProcessKey } from './lib/bot-process-presence.mjs';
import { withSessionLock } from '../tistory-api/lib/lock.mjs';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL,fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { recoveryDecision } from './x-recovery.mjs';
const base=path.join(process.env.LOCALAPPDATA,'affiliate-content-operations');
const root=path.join(base,'x-supervisor');
const json=async(file,fallback)=>{try{return JSON.parse(await readFile(file,'utf8'));}catch(e){if(e.code==='ENOENT')return fallback;throw e;}};
const exists=async file=>{try{await readFile(file);return true;}catch(e){if(e.code==='ENOENT')return false;throw e;}};
const save=(file,value)=>writeBotJson('x-supervisor',file,value);
export function supervisorWorkerReport(previous,result,current) {
 const next={...previous,...result,...current};
 if(result.action==='observe'&&current.workerAlive) {
  if(previous.reason)next.lastRecoveryReason=previous.reason;
  for(const key of ['reason','retryAt','nextAttemptAt'])delete next[key];
 }
 return next;
}
export function supervisorShouldFinish(workers,{indefinite=false,allStopped=false}={}) {
 return (!indefinite||allStopped)&&Object.values(workers).every(worker=>worker.action==='stop'&&!worker.workerAlive);
}
export function supervisorObservationFailure(previous,error,now=Date.now()) {
 return {...previous,action:'observation_failed',reason:'X_MONITOR_STATUS_UNREADABLE',workerAlive:null,
  observationFailure:safeBotFailure(error),checkedAt:new Date(now).toISOString()};
}
export function supervisorWorkerSpecs(sourcePath,{reflection={},quickfact={},quickfactBlog={}}={}) {
 const specs=[
  {name:'x-invite-bot',script:'x-invite-worker.mjs',args:['run',path.resolve(sourcePath)]},
  {name:'x-followback-bot',script:'x-followback-bot.mjs',args:['run']},
 ];
 if(reflection.enabled===true)specs.push({name:'x-reflection-bot',script:'x-reflection-worker.mjs',args:['run']});
 if(quickfact.enabled===true)specs.push({name:'x-quickfact-bot',script:'x-quickfact-worker.mjs',args:['run']});
 if(quickfactBlog.enabled===true)specs.push({name:'x-quickfact-blog-bot',script:'x-quickfact-blog-worker.mjs',args:['run']});
 return specs;
}
export async function superviseOnce(snapshot,{launch,now=Date.now()}={}) {
 if(!snapshot.stop&&snapshot.identityPending)return {action:'identity_pending',attempts:snapshot.attempts||0};
 if(!snapshot.stop&&snapshot.startupPending)return {action:'observe',reason:'startup_pending',attempts:snapshot.attempts||0};
 const decision=recoveryDecision({...snapshot,now});
 if(decision.action!=='restart')return {...decision,attempts:snapshot.attempts||0};
 const pid=await launch();
 const attempts=(snapshot.attempts||0)+1;
 return {...decision,pid,attempts,restartedAt:new Date(now).toISOString(),nextAttemptAt:now+Math.min(1800000,300000*2**(attempts-1))};
}
export async function main(command='status',sourcePath) {
 await mkdir(root,{recursive:true});
 const file=path.join(root,'status.json'),lockFile=path.join(root,'supervisor.lock'),stopFile=path.join(root,'STOP');
 if(command==='status'){console.log(JSON.stringify(await json(file,{status:'not_started'})));return;}
 if(command==='stop'){await writeFile(stopFile,'stop');return;}
 if(command!=='run'||!sourcePath)throw Object.assign(new Error(),{code:'X_SUPERVISOR_INPUT'});
 if(process.argv.includes('--recover')&&await exists(stopFile))return;
 const source=await json(sourcePath,null);if(source?.owner!=='lifehack__ailab'||!Array.isArray(source.candidates))throw Object.assign(new Error(),{code:'X_SUPERVISOR_SOURCE'});
 const nonce=randomUUID();
 await withSessionLock(async()=>{
  if(process.argv.includes('--recover')&&await exists(stopFile))throw Object.assign(new Error(),{code:'X_SUPERVISOR_USER_STOPPED'});
  const old=await json(lockFile,null),spec={script:'x-supervisor.mjs'};
  const presence=await readBotProcessPresence([{spec,pid:old?.pid}]);
  if(presence.get(botProcessKey(spec,old?.pid))!==false)throw Object.assign(new Error(),{code:'X_SUPERVISOR_ALREADY_RUNNING'});
  await unlink(lockFile).catch(e=>{if(e.code!=='ENOENT')throw e;});
  const lock=await open(lockFile,'wx');await lock.writeFile(JSON.stringify({pid:process.pid,nonce}));await lock.close();
 },{lockPath:path.join(root,'supervisor-acquire.lock'),timeoutMs:30_000});
 if(!process.argv.includes('--recover'))await unlink(stopFile).catch(e=>{if(e.code!=='ENOENT')throw e;});
 const persisted=await json(file,{});
 const indefinite=process.argv.includes('--indefinite')||persisted.indefinite===true;
 const report={status:'running',pid:process.pid,startedAt:new Date().toISOString(),indefinite,workers:persisted.workers||{}};
 const reflection=await json(path.join(base,'x-reflection-bot','state.json'),{});
 const quickfact=await json(path.join(base,'x-quickfact-bot','state.json'),{});
 const quickfactBlog=await json(path.join(base,'x-quickfact-blog-bot','state.json'),{});
 const specs=supervisorWorkerSpecs(sourcePath,{reflection,quickfact,quickfactBlog});
 for(const spec of specs)spec.args.push('--recover');
 if(indefinite)for(const spec of specs)spec.args.push('--indefinite');
 try {
 while(!await exists(stopFile)) {
  const inputs=await Promise.all(specs.map(async spec=>{
   try{return {spec,status:await json(path.join(base,spec.name,'status.json'),{}),state:await json(path.join(base,spec.name,'state.json'),{records:{}})};}
   catch(error){return {spec,error};}
  }));
  const presence=await readBotProcessPresence(inputs.filter(input=>!input.error).flatMap(({spec,status})=>[
   {spec,pid:status.pid},{spec,pid:report.workers[spec.name]?.pid},
  ]));
  for(const {spec,status,state,error} of inputs) {
   if(await exists(stopFile))break;
   const previous=report.workers[spec.name]||{};
   if(error){
    report.workers[spec.name]=supervisorObservationFailure(previous,error);
    report.logging=await recordBotFailure('x-supervisor',root,error,{worker:spec.name,phase:'health_check',code:'X_MONITOR_STATUS_UNREADABLE'});
    await save(file,report);continue;
   }
   try {
   const dir=path.join(base,spec.name);
   const deadline=indefinite?Infinity:previous.deadline||Date.parse(status.expiresAt||'')||Date.parse(status.startedAt||'')+86400000;
   const view=botWorkerPresence(spec,status,previous,presence),workerAlive=view.workerAlive;
   if(previous.workerAlive===true&&workerAlive===false&&!['stopped','expired'].includes(status.status))await recordBotEvent('x-supervisor',root,{event:'worker_exit',worker:spec.name,pid:status.pid,runStartedAt:status.startedAt,code:status.code||'BOT_WORKER_EXITED',status:status.status,phase:'health_check',failure:status.diagnostic||status.failure});
   const writeFailure=['X_CREATE_SCHEMA','SERVICE_ERROR','WRITE_UNKNOWN','SNS_JOURNAL_RECONCILIATION_REQUIRED','X_AI_COMMENT_INVALID','X_AI_TIMEOUT','X_AI_CALL_FAILED','X_AI_OUTPUT_INVALID'].includes(previous.reason);
   const healthy=workerAlive&&(writeFailure?status.lastCompletedHandle&&status.lastCompletedHandle!==previous.lastCompletedHandle:status.lastScanAt&&status.lastScanAt!==previous.lastScanAt);
   const snapshot={status,state,alive:workerAlive,identityPending:view.identityPending,startupPending:view.startupPending,stop:await exists(path.join(dir,'STOP')),deadline,attempts:healthy?0:previous.attempts||0,nextAttemptAt:previous.nextAttemptAt||0};
   if(Date.now()>=deadline&&workerAlive)await writeFile(path.join(dir,'STOP'),'supervisor deadline');
   const result=await superviseOnce(snapshot,{launch:async()=>{
    const child=spawn(process.execPath,[path.join(path.dirname(fileURLToPath(import.meta.url)),spec.script),...spec.args],{windowsHide:true,detached:true,stdio:'ignore',cwd:process.cwd()});
    child.once('exit',(exitCode,signal)=>{void recordBotEvent('x-supervisor',root,{event:'worker_exit',worker:spec.name,code:'BOT_WORKER_EXITED',phase:'child_exit',exitCode,signal});});
    await new Promise((resolve,reject)=>{child.once('spawn',resolve);child.once('error',reject);});child.unref();return child.pid;
   }});
   report.workers[spec.name]=supervisorWorkerReport(previous,result,{pid:result.pid||view.pid,deadline,lastScanAt:status.lastScanAt||null,lastCompletedHandle:status.lastCompletedHandle||null,workerAlive:result.action==='restart'?null:workerAlive,identityPending:view.identityPending,workerStatus:result.action==='restart'?'starting':status.status,code:status.code||null,checkedAt:new Date().toISOString()});
   delete report.workers[spec.name].observationFailure;
   }catch(error){
    report.workers[spec.name]=supervisorObservationFailure(previous,error);
    report.logging=await recordBotFailure('x-supervisor',root,error,{worker:spec.name,phase:'health_check',code:'X_MONITOR_STATUS_UNREADABLE'});
   }
   await save(file,report);
  }
  if(supervisorShouldFinish(report.workers,{indefinite,allStopped:await Promise.all(specs.map(spec=>exists(path.join(base,spec.name,'STOP')))).then(values=>values.every(Boolean))}))break;
  await delay(30000);
 }
 report.status='stopped';
 }catch(e){captureBotFailure(report,e);report.status='blocked';report.code=e.code||'X_SUPERVISOR_FAILED';throw e;}
 finally{report.finishedAt=new Date().toISOString();await save(file,report);const current=await json(lockFile,null);if(current?.pid===process.pid&&current.nonce===nonce)await unlink(lockFile);}
}
if(process.argv[1]&&pathToFileURL(path.resolve(process.argv[1])).href===import.meta.url)main(process.argv[2],process.argv[3]).catch(async e=>{const logging=await recordBotFailure('x-supervisor',root,e,{phase:'worker_entry'});console.log(JSON.stringify({code:e.code||'X_SUPERVISOR_FAILED',logging}));process.exitCode=2;});
