// Scouting selects sources; this module carries that evidence into the API work
// frontier. It does not execute instructions or requests found in source text.
import { createHash, randomUUID } from 'node:crypto';
import { readdir, readFile, mkdir, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';

export const SCOUT_QUEUE = 'workflow-runs/api-only-onboarding/scout-queue.json';
export const STAGES = ['access_assessment','login_signup_flow','session_handoff','http_capture',
  'client_implementation','live_replay','collector_integration','complete'];
const STATES = new Set(['ready','in_progress','blocked','complete','deferred']);
const ACCEPTED = new Set(['accepted','adopted','watchlist','채택','관찰']);
const hash = value => createHash('sha256').update(value).digest('hex').slice(0,16);
const list = value => Array.isArray(value) ? value : [];
const textList = value => typeof value==='string' ? [value] : list(value);
const words = value => String(value ?? '').replace(/[\r\n\t]/g,' ').slice(0,2000);
const unique = values => [...new Set(values.filter(Boolean))];
const fail = code => {throw Error(code);};

export function publicSourceUrl(value) {
  let url; try {url=new URL(value);} catch {return null;}
  if (!['https:','http:'].includes(url.protocol) || url.username || url.password || url.port
    || !url.hostname.includes('.') || /(^|\.)(localhost|local|internal|test|invalid)$/.test(url.hostname)
    || /^[\d.]+$/.test(url.hostname) || url.hostname.includes(':')) return null;
  // Evidence URLs never retain bearer-like or tracking query values.
  for(const key of [...url.searchParams.keys()]) {
    if(/token|cookie|session|auth|password|secret|signature|api.?key|email|phone|^code$|^state$|^sig$|^key$|^utm_|^si$|^fbclid$|^gclid$/i.test(key)) url.searchParams.delete(key);
  }
  url.hash='';
  return url.href;
}

function hostOf(url) {return new URL(url).hostname.replace(/^www\./,'');}

// Only explicit evidence schemas are imported. Search rankings, arbitrary URLs
// in prose, excluded rows, and unreviewed snippets do not become account jobs.
export function extractScoutFindings(document, evidenceFile) {
  if(Array.isArray(document) || Array.isArray(document?.findings)) {
    return list(Array.isArray(document)?document:document.findings).map((row,index)=>({
      ...row,evidenceFile,evidencePointer:`${Array.isArray(document)?'':'/findings'}/${index}`
    }));
  }
  if(document?.kind==='reference_knowledge') {
    return list(document.sourceObservations).map((row,index)=>{
      const spans=new Set(list(document.evidenceSpans).filter(x=>x.observationId===row.id).map(x=>x.id));
      const claims=list(document.claims).filter(x=>list(x.evidenceSpanIds).some(id=>spans.has(id)));
      return {sourceUrl:row.canonicalUrl,title:row.title,checkedAt:row.observedAt||document.checkedAt,
        sourceType:row.platform,readCoverage:row.acquisition?.contentCoverage,summary:row.summary,
        whyUseful:claims.map(x=>x.text).join(' '),
        ontologyRefs:unique(claims.flatMap(x=>[x.subjectId,x.objectId]).filter(Boolean)).map(id=>`${document.id}#${id}`),
        disposition:row.reviewRequired?'deferred':'accepted',collectionStatus:row.httpObservation?.status||'not_integrated',
        // A documentation homepage is not proof of an account/service origin.
        apiOnlyTarget:row.apiOnlyTarget||null,
        candidateId:row.candidateId||null,evidenceFile,evidencePointer:`/sourceObservations/${index}`};
    });
  }
  if(Array.isArray(document?.sourceRecords)) {
    return document.sourceRecords.map((row,index)=>({sourceUrl:row.url,title:row.title,
      checkedAt:row.checkedAt||document.capturedOn,sourceType:row.sourceType,
      readCoverage:row.evidenceClass,summary:textList(row.observedSignals).join(' '),
      whyUseful:textList(row.ontologyUse).join(' '),ontologyRefs:document.ontologyId?[document.ontologyId]:list(row.ontologyRefs),
      sourceRefs:[`${document.snapshotId}#${row.id}`],
      disposition:row.scopeDisposition==='in_scope'?'accepted':
        ['taxonomy_only','risk_context_only','partial_scope','conditional_home'].includes(row.scopeDisposition)?'watchlist':'excluded',
      scopeLimit:row.scopeReason,collectionStatus:'source_reviewed',evidenceFile,evidencePointer:`/sourceRecords/${index}`}));
  }
  if(Array.isArray(document?.records)&&Array.isArray(document?.claims)) {
    return document.records.map((row,index)=>{
      const claims=document.claims.filter(x=>list(x.sourceIds).includes(row.id));
      return {sourceUrl:row.url,title:row.title,checkedAt:row.checkedOn||document.createdAt,
        sourceType:row.sourceType,readCoverage:row.accessResult,summary:list(row.supports).join(' '),
        whyUseful:claims.map(x=>x.consequence||x.statement).join(' '),
        ontologyRefs:document.ontologyId?[document.ontologyId]:list(row.ontologyRefs),
        sourceRefs:claims.map(x=>`${document.id}#${x.id}`),
        disposition:row.accessResult==='read'?'accepted':'deferred',
        scopeLimit:list(row.limitations).join(' '),collectionStatus:'source_reviewed',evidenceFile,evidencePointer:`/records/${index}`};
    });
  }
  return [];
}

function normalizeFinding(row) {
  if(!ACCEPTED.has(row.disposition) || row.duplicateOf || !row.whyUseful || !list(row.ontologyRefs).length) return null;
  const sourceUrl=publicSourceUrl(row.sourceUrl);
  const targetUrl=publicSourceUrl(row.apiOnlyTarget?.url||row.sourceUrl);
  if(!sourceUrl || !targetUrl || !Number.isFinite(Date.parse(row.checkedAt))) return null;
  const coverage=words(row.readCoverage);
  if(!coverage || /^(unknown|not_read|inaccessible|미확인|unread|search_snippet)$/.test(coverage)) return null;
  const finding={id:hash(`${sourceUrl}\n${targetUrl}\n${row.evidenceFile}`),
    sourceUrl,targetUrl,title:words(row.title),checkedAt:row.checkedAt,readCoverage:coverage,
    sourceType:words(row.sourceType),summary:words(row.summary),whyUseful:words(row.whyUseful),
    ontologyRefs:unique(list(row.ontologyRefs).map(words)),sourceRefs:unique(list(row.sourceRefs).map(words)),disposition:row.disposition,
    scopeLimit:words(row.scopeLimit)||null,collectionStatus:words(row.collectionStatus)||'unknown',
    capabilities:unique(list(row.apiOnlyTarget?.capabilities).map(words)),
    targetKind:row.apiOnlyTarget?.url?'service_access':'source_read',
    evidenceFile:row.evidenceFile,evidencePointer:row.evidencePointer,candidateId:words(row.candidateId)||null};
  finding.revision=hash(JSON.stringify({summary:finding.summary,whyUseful:finding.whyUseful,
    targetKind:finding.targetKind,readCoverage:finding.readCoverage,scopeLimit:finding.scopeLimit,
    ontologyRefs:[...finding.ontologyRefs].sort(),capabilities:[...finding.capabilities].sort()}));
  return finding;
}

function initialNextTask(host,kind) {
  return kind==='service_access'
    ? `${host}: 스카우팅한 서비스의 기존 client·보호 세션·기존 계정부터 점검한다. 실제 로그인·가입 필요 여부와 관측 경로를 확인해 필요한 HTTP 기능과 수집기 연결까지 진행한다.`
    : `${host}: 스카우팅한 원문을 수집할 기존 client와 세션을 확인하고 공개 읽기·HTTP 수집기 연결을 진행한다. 계정이 실제 필요한 자료일 때만 로그인·가입 흐름으로 전환한다.`;
}

export function mergeScoutQueue(previous, findings, seeds, now=new Date().toISOString(), refreshedFiles=unique(findings.map(x=>x.evidenceFile))) {
  if(previous && (previous.schemaVersion!==1 || previous.kind!=='scout_api_queue' || !Array.isArray(previous.services))) fail('SCOUT_QUEUE_INVALID');
  const services=new Map(list(previous?.services).map(row=>[row.id,structuredClone(row)]));
  for(const row of services.values())row.findings=row.findings.filter(x=>!refreshedFiles.includes(x.evidenceFile));
  let accepted=0,skipped=0,added=0;
  for(const raw of findings) {
    const finding=normalizeFinding(raw);
    if(!finding){skipped++;continue;}
    accepted++;
    const host=hostOf(finding.targetUrl);
    const seed=seeds.services.find(row=>list(row.sourceHosts).includes(host));
    const id=seed?.id||`scout-${host.replace(/[^a-z0-9]+/g,'-').slice(0,60)}-${hash(host).slice(0,8)}`;
    let service=services.get(id);
    if(!service) {
      added++;
      service={id,label:seed?.label||host,host,origins:[],seedServiceId:seed?.id||null,
        discoveredAt:now,lastSeenAt:now,priority:80,status:'ready',stage:'access_assessment',
        nextTask:initialNextTask(host,finding.targetKind),lastAttemptAt:null,retryAfter:null,blocker:null,
        history:[],completedFindings:[],findings:[]};
      services.set(id,service);
    }
    service.origins=unique([...service.origins,new URL(finding.targetUrl).origin]);
    service.lastSeenAt=now;
    // Re-reading a source must not reset a blocked/completed implementation.
    const index=service.findings.findIndex(x=>x.id===finding.id);
    if(index<0)service.findings.push(finding);else service.findings[index]=finding;
  }
  for(const row of services.values()) {
    row.sourceActive=row.findings.length>0;
    row.accessKind=row.findings.some(x=>x.targetKind==='service_access')?'service_access':'source_read';
    if(!row.lastAttemptAt && row.stage==='access_assessment')row.nextTask=initialNextTask(row.host,row.accessKind);
    const done=new Set(list(row.completedFindings).map(x=>`${x.id}@${x.revision}`));
    if(row.status==='complete'&&row.findings.some(x=>!done.has(`${x.id}@${x.revision}`))) {
      row.status='ready';row.stage='access_assessment';row.nextTask=initialNextTask(row.host,row.accessKind);
    }
  }
  return {schemaVersion:1,kind:'scout_api_queue',updatedAt:now,
    importSummary:{accepted,skipped,added},services:[...services.values()].sort((a,b)=>a.id.localeCompare(b.id))};
}

export function checkpointScoutQueue(queue, change, now=new Date().toISOString()) {
  if(!STATES.has(change.status)||!STAGES.includes(change.stage)||!change.evidenceFile||!change.nextTask) fail('SCOUT_CHECKPOINT_INVALID');
  if(change.status==='complete' && change.stage!=='complete')fail('SCOUT_CHECKPOINT_INVALID');
  if(change.status==='complete'&&(!list(change.processedFindings).length||change.processedFindings.some(x=>
    !/^[a-f0-9]{16}$/.test(x.id)||!/^[a-f0-9]{16}$/.test(x.revision))))fail('SCOUT_COMPLETED_SCOPE_REQUIRED');
  if(change.stage==='complete' && change.status!=='complete')fail('SCOUT_CHECKPOINT_INVALID');
  if(change.status==='blocked' && !change.resumeCondition)fail('SCOUT_RESUME_REQUIRED');
  if(change.retryAfter && !Number.isFinite(Date.parse(change.retryAfter)))fail('SCOUT_RETRY_DATE_INVALID');
  const updated=structuredClone(queue),row=updated.services.find(x=>x.id===change.service);
  if(!row)fail('SCOUT_SERVICE_UNKNOWN');
  row.stage=change.stage;row.status=change.status;row.nextTask=words(change.nextTask);
  row.lastAttemptAt=now;row.retryAfter=change.retryAfter||null;
  if(change.status==='complete') {
    const done=new Map([...list(row.completedFindings),...change.processedFindings].map(x=>[`${x.id}@${x.revision}`,{id:x.id,revision:x.revision}]));
    row.completedFindings=[...done.values()];
    // A late completion covers only the worker's selected evidence revision.
    // Findings added or changed during that work remain pending.
    if(row.findings.some(x=>!done.has(`${x.id}@${x.revision}`))) {
      row.status='ready';row.stage='access_assessment';row.nextTask=initialNextTask(row.host,row.accessKind);
    }
  }
  row.blocker=change.status==='blocked'?{reason:words(change.reason),resumeCondition:words(change.resumeCondition)}:null;
  row.history.push({checkedAt:now,status:change.status,stage:change.stage,evidenceFile:change.evidenceFile,
    nextTask:row.nextTask,resumeCondition:row.blocker?.resumeCondition||null,
    processedFindings:change.status==='complete'?change.processedFindings.map(x=>({id:x.id,revision:x.revision})):[]});
  updated.updatedAt=now;
  return updated;
}

export function selectScoutWork(queue, limit=2, now=new Date().toISOString()) {
  const due=list(queue?.services).filter(row=>{
    if(row.sourceActive===false || !row.findings?.length || ['complete','deferred'].includes(row.status))return false;
    if(row.retryAfter&&Date.parse(row.retryAfter)>Date.parse(now))return false;
    return row.status!=='blocked'||!!row.retryAfter;
  });
  // Resume in-progress work first. Among untouched work, the newest scouting
  // batch goes first so an old fixed priority cannot starve it.
  const time=value=>{const parsed=Date.parse(value||'');return Number.isFinite(parsed)?parsed:0;};
  due.sort((a,b)=>Number(b.status==='in_progress')-Number(a.status==='in_progress')
    || Number(!!a.lastAttemptAt)-Number(!!b.lastAttemptAt)
    || (a.lastAttemptAt&&b.lastAttemptAt?time(a.lastAttemptAt)-time(b.lastAttemptAt):0)
    || time(b.discoveredAt)-time(a.discoveredAt)
    || b.priority-a.priority || a.id.localeCompare(b.id));
  return due.slice(0,limit).map(row=>({service:row.id,label:row.label,host:row.host,
    origin:'scouting',accessKind:row.accessKind,stage:row.stage,status:row.status,task:row.nextTask,
    sourceUrls:unique(row.findings.map(x=>x.sourceUrl)),
    findingRefs:row.findings.map(x=>({id:x.id,revision:x.revision})),
    ontologyRefs:unique(row.findings.flatMap(x=>x.ontologyRefs)),
    whyUseful:unique(row.findings.map(x=>x.whyUseful)),requiresInput:row.status==='blocked'}));
}

export function mergeScoutManifest(seeds, queue) {
  const services=structuredClone(seeds.services);
  for(const row of queue.services) {
    if(row.sourceActive===false)continue;
    const known=services.find(x=>x.id===row.id);
    if(known){known.scouted=true;known.scoutStage=row.stage;continue;}
    services.push({id:row.id,label:row.label,priority:row.priority,provider:'discovery',
      sourceHosts:[row.host],scouted:true,scoutStage:row.stage,accessKind:row.accessKind,
      login:row.accessKind==='source_read'?'공개 원문과 기존 읽기 client 확인; 실제 계정 필요 시 정상 로그인 관측':'기존 계약·보호 세션·계정 여부 확인 후 실제 로그인 경로 관측',
      signup:'공개 원문 읽기에 불필요한 가입을 하지 않음; 계정이 필요한 경우 기존 계정과 실제 가입 흐름 확인',
      nextTask:row.nextTask,evidence:row.findings[0]?.evidenceFile});
  }
  return {...seeds,services};
}

async function findFiles(directory,accept) {
  let entries;try{entries=await readdir(directory,{withFileTypes:true});}catch(error){if(error.code==='ENOENT')return [];throw error;}
  const result=[];
  for(const entry of entries.sort((a,b)=>a.name.localeCompare(b.name))) {
    if(entry.isSymbolicLink())continue;
    const file=path.join(directory,entry.name);
    if(entry.isDirectory())result.push(...await findFiles(file,accept));
    else if(entry.isFile()&&accept(entry.name))result.push(file);
  }
  return result;
}

export async function loadScoutInputs(root) {
  const content=path.join(root,'apps/naver-blog-api/research/content-store');
  const files=unique([
    ...await findFiles(path.join(root,'workflow-runs'),name=>name==='scouting-findings.json'),
    ...await findFiles(path.join(root,'apps/naver-blog-api/workflow-runs'),name=>name==='scouting-findings.json'),
    ...await findFiles(path.join(content,'reference-knowledge'),name=>name.endsWith('.json')),
    ...(await readdir(content,{withFileTypes:true})).filter(x=>x.isFile()&&/source-(scan|ledger).*\.json$/.test(x.name)).map(x=>path.join(content,x.name))
  ]).sort();
  const findings=[],inputs=[],errors=[];
  for(const file of files) {
    const relative=path.relative(root,file).replaceAll('\\','/');
    try {
      const document=JSON.parse(await readFile(file,'utf8'));
      const prefix=/^(.+)-source-(?:scan|ledger)/.exec(path.basename(file))?.[1];
      if(prefix&&!document.ontologyId) {
        const ontologyFile=path.join(content,`${prefix}-ontology.v1.json`);
        try {document.ontologyId=JSON.parse(await readFile(ontologyFile,'utf8')).ontologyId;}
        catch(error){if(error.code!=='ENOENT')throw error;}
      }
      const rows=extractScoutFindings(document,relative);
      findings.push(...rows);inputs.push({path:relative,findings:rows.length});
    } catch {errors.push({path:relative,code:'SCOUT_INPUT_UNREADABLE'});}
  }
  return {findings,inputs,errors};
}

export async function readScoutQueue(root) {
  try{return JSON.parse(await readFile(path.join(root,SCOUT_QUEUE),'utf8'));}
  catch(error){if(error.code==='ENOENT')return null;throw error;}
}

export async function writeScoutQueue(root, queue) {
  const file=path.join(root,SCOUT_QUEUE),temp=`${file}.${randomUUID()}.tmp`;
  await mkdir(path.dirname(file),{recursive:true});
  await writeFile(temp,JSON.stringify(queue,null,2)+'\n',{flag:'wx'});
  await rename(temp,file);
}

export async function syncScoutQueue(root, seeds) {
  const loaded=await loadScoutInputs(root);
  const previous=await readScoutQueue(root);
  // A failed or removed source must not keep authorizing work from an old copy.
  // Preserve task history but rebuild active evidence from current readable input.
  const refreshedFiles=unique([...loaded.inputs.map(x=>x.path),...loaded.errors.map(x=>x.path),
    ...list(previous?.services).flatMap(row=>list(row.findings).map(x=>x.evidenceFile))]);
  const queue=mergeScoutQueue(previous,loaded.findings,seeds,undefined,refreshedFiles);
  await writeScoutQueue(root,queue);
  return {queue,inputs:loaded.inputs,errors:loaded.errors};
}
