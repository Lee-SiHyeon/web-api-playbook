// Unattended API work starts with the same protected providers used by clients.
// This runner restores/checks existing sessions and selects the next auth/flow
// discovery work. It does not fabricate or submit unobserved signup requests.
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { keep, run } from './session-keeper.mjs';
import { shoppingSessionStatus } from '../lib/shopping-session-store.mjs';
import { loadNaverCookies } from '../../naver-blog-api/scripts/session-vault.mjs';
import { loadLoginControl } from '../../naver-blog-api/scripts/naver-login-state.mjs';
import { credentialExists } from '../../naver-blog-api/scripts/secure-credential-store.mjs';
import { acquireRunLock } from '../lib/process-run-lock.mjs';
import { syncScoutQueue, mergeScoutManifest, selectScoutWork, SCOUT_QUEUE } from '../lib/scout-onboarding.mjs';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const MANIFEST = new URL('../references/api-only-onboarding.json', import.meta.url);
const WEB = fileURLToPath(new URL('./web-auth.mjs', import.meta.url));
const META_AUTH = fileURLToPath(new URL('../../naver-blog-api/scripts/meta-auth-session.mjs', import.meta.url));
const code = value => typeof value === 'string' && /^[A-Z][A-Z0-9_]{0,99}$/.test(value) ? value : null;

export function classifyAuth(value = {}) {
  if (value.ok !== false && value.authenticated === true && value.ownerVerified === true) return 'authenticated';
  const reason = code(value.code) || '';
  if (/OUTCOME_UNKNOWN|RECONCIL|WRITE_UNCERTAIN/.test(reason)) return 'needs_reconciliation';
  if (/ACCOUNT_PROTECTION|SUSPEND|ACCOUNT_MISMATCH|OWNER_MISMATCH/.test(reason)) return 'account_attention';
  if (/CAPTCHA|CHALLENGE|ADDITIONAL_VERIFICATION|OTP/.test(reason) || ['otp-send','otp-verify'].includes(value.next)) return 'verification_required';
  if (/ENTITLEMENT|SPACE_NOT_ACTIVE/.test(reason)) return 'entitlement_required';
  if (/REAUTH_REQUIRED|AUTH_MISSING|COOKIES_EXPIRED|REQUIRED_COOKIES_UNAVAILABLE|HANDOFF_STALE/.test(reason)) return 'reauth_required';
  if (/PROVIDER_MISSING|SESSION_MISSING|LOGIN_MISSING|IDENTITY_MISSING/.test(reason)) return 'provider_missing';
  if (/FORBIDDEN|ACCESS_DENIED|HTTP_REJECTED|THROTTL|RATE_LIMIT/.test(reason)) return 'delivery_blocked';
  if (/PROCESS_|TIMEOUT|TRANSPORT|PLAYBOOK_NOT_INSTALLED|SESSION_BUSY|CREDENTIAL_STORE_/.test(reason)) return 'blocked_runtime';
  if (/VERIFICATION_COOKIE_UNSUPPORTED/.test(reason)) return 'verification_required';
  return 'auth_unverified';
}

function rowFromResult(definition, value, action = 'checked') {
  const state = classifyAuth(value);
  return { id: definition.id, label: definition.label, priority: definition.priority,
    authentication: state, ownerVerified: state === 'authenticated', action,
    code: code(value.code), next: ['otp-send','otp-verify'].includes(value.next) ? value.next : null,
    accountExistence: state === 'authenticated' ? 'confirmed_existing' : 'unknown',
    signup: state === 'authenticated' ? 'not_needed_existing_account' : 'inspect_existing_account_first',
    loginFlow: definition.login, signupFlow: definition.signup, nextTask: definition.nextTask,
    evidence: definition.evidence };
}

export function selectNextWork(services, limit = 2, scoutQueue = null) {
  // Authentication is a phase, not completion of the scouted collection task.
  const scouted=selectScoutWork(scoutQueue,limit).map(task=>({
    ...task,authentication:services.find(row=>row.id===task.service)?.authentication||'not_checked'}));
  const managed=new Set(scoutQueue?.services?.filter(row=>row.sourceActive!==false).map(row=>row.id)||[]);
  // One site's verification/transport boundary does not suspend all other work.
  const existing=services.filter(row => row.authentication !== 'authenticated'&&!managed.has(row.id))
    .sort((a,b)=>b.priority-a.priority || a.id.localeCompare(b.id)).slice(0,Math.max(0,limit-scouted.length))
    .map(row=>({service:row.id,stage:'login_signup_flow',status:row.authentication,
      task:row.nextTask,accountExistence:row.accountExistence,signup:row.signup,
      requiresInput:['verification_required','account_attention'].includes(row.authentication)}));
  return [...scouted,...existing];
}

export async function inspectOnboarding({ manifest, allowRenewal = true, exec = run,
  keeper = keep, shoppingStatus = shoppingSessionStatus, credentialStatus = credentialExists,
  scoutQueue = null, onProgress = () => {} } = {}) {
  if (!manifest || manifest.schemaVersion !== 1 || !Array.isArray(manifest.services)
    || new Set(manifest.services.map(row=>row.id)).size !== manifest.services.length) throw Error('ONBOARDING_MANIFEST_INVALID');
  const kept = await keeper({exec,allowRenewal,
    loadCookies:async()=>(await loadNaverCookies({env:{}})).cookies,
    loginControl:async()=>loadLoginControl()});
  onProgress({phase:'protected_session_keeper',services:Object.keys(kept.services)});
  const services=[];
  for (const definition of manifest.services) {
    if (!/^[a-z][a-z0-9-]*$/.test(definition.id) || !Number.isFinite(definition.priority)) throw Error('ONBOARDING_MANIFEST_INVALID');
    let result;
    if (definition.provider === 'keeper') {
      const value=kept.services[definition.id];
      result=rowFromResult(definition,{authenticated:value?.ok===true,ownerVerified:value?.ok===true,code:value?.code},value?.action);
    } else if (definition.provider === 'web-auth') {
      const status=await exec(WEB,[definition.id,'status'],{cwd:ROOT});
      const ready=status.json?.sessionStored===true || (allowRenewal && status.json?.loginStored===true);
      const response=ready ? await exec(WEB,[definition.id,allowRenewal?'ensure':'health'],{cwd:ROOT}) : null;
      const value=response?.json || {code:ready?'PROCESS_RESULT_MISSING':code(status.json?.code)||'SESSION_PROVIDER_MISSING'};
      result=rowFromResult(definition,value,ready?(allowRenewal?'ensure':'health'):'provider_check');
      result.provider={sessionStored:status.json?.sessionStored===true,loginStored:status.json?.loginStored===true,
        passwordLoginImplemented:status.json?.passwordLoginImplemented===true,
        sessionImportImplemented:['x','coupang'].includes(definition.id)};
      result.browserUsed=value.browserUsed===true;
    } else if (definition.provider === 'meta-auth') {
      if (!['instagram','threads'].includes(definition.id)) throw Error('ONBOARDING_PROVIDER_INVALID');
      let ready = false;
      let credentialStoreStatus = 'unavailable';
      try { ready = await credentialStatus(definition.id + '-auth-session'); credentialStoreStatus = 'available'; } catch {}
      const response = ready ? await exec(META_AUTH,[definition.id],{cwd:ROOT}) : null;
      const value = response?.json || {code:ready?'PROCESS_RESULT_MISSING':credentialStoreStatus === 'available'
        ? 'META_SESSION_MISSING' : 'CREDENTIAL_STORE_UNREADABLE'};
      result = rowFromResult(definition,value,ready?'protected_owner_read':'provider_check');
      result.provider = {authenticatedSessionStored:credentialStoreStatus === 'available' ? ready : null,
        credentialStoreStatus,sessionRenewalVerified:false,
        passwordLoginImplemented:false,encryptedBrowserHandoffImplemented:true};
      result.browserUsed = value.browserUsed === true;
    } else if (definition.provider === 'shopping') {
      let status; try {status=await shoppingStatus(definition.sessionKey);} catch {status={code:'PROVIDER_STATUS_FAILED'};}
      result=rowFromResult(definition,{code:status.code},'scoped_provider_check');
      result.provider={sessionStored:status.present===true,usableForReadAttempt:status.usableForAttempt===true};
      result.ownerVerified=false; // Search/review cookies never establish member login.
    } else if (definition.provider === 'discovery') {
      result=rowFromResult(definition,{code:definition.accessKind==='source_read'?'SOURCE_READ_NOT_VERIFIED':'LOGIN_FLOW_NOT_IMPLEMENTED'},'contract_review');
    } else throw Error('ONBOARDING_PROVIDER_INVALID');
    services.push(result);
    onProgress({service:result.id,authentication:result.authentication,code:result.code});
  }
  return {schemaVersion:1,kind:'api_only_onboarding',checkedAt:new Date().toISOString(),
    execution:'pure_http',scope:'protected reads and existing observed login renewal; signup discovery is queued',
    browserUsed:false,allowRenewal,credentialValuesInArtifacts:false,signupWrites:0,
    services,nextWork:selectNextWork(services,2,scoutQueue),
    verifiedServices:services.filter(row=>row.ownerVerified).map(row=>row.id)};
}

export function reportMarkdown(result) {
  const safe=value=>String(value??'').replace(/[|\r\n]/g,' ');
  return [result.kind==='api_only_scout_intake'?'# 스카우팅 → API-only 작업 인계':'# API-only 로그인·가입 준비', '', `확인: ${result.checkedAt}`, '',
    ...(result.scouting?[
      `스카우팅 대상 ${result.scouting.totalServices}개 호스트 · 기존 seed 밖 ${result.scouting.newToSeedRegistry}개 · 이번 신규 편입 ${result.scouting.added}개`,
      `입력 오류 ${result.scouting.errors.length}건 · 정본 큐: ${result.scouting.queuePath}`, '',
      ...(result.authenticationChecked===false?['이 실행은 큐 편입만 수행했습니다. 로그인·가입·HTTP 수집은 실행하지 않았습니다.','']:[])
    ]:[]),
    '| 서비스 | 실제 인증 | 기존 계정 | 다음 단계 |','|---|---|---|---|',
    ...result.services.map(row=>`| ${safe(row.label)} | ${row.authentication} | ${row.accountExistence} | ${safe(row.nextTask)} |`),'',
    '## 우선 작업','',...result.nextWork.flatMap(row=>[
      `- ${row.service} / ${row.stage}: ${row.task}`,
      ...(row.ontologyRefs?.length?[`  - 온톨로지: ${row.ontologyRefs.map(safe).join(', ')}`]:[])
    ]),'',
    '보호 조회 성공만 기존 계정 확인으로 기록한다. 저장 세션 부재·검색 성공·로그인 실패는 미가입의 근거가 아니다.',
    '이 실행의 신규 가입 요청은 0건이다. 가입 흐름은 실제 화면·요청·완료 조회를 관측한 뒤 구현한다.',''].join('\n');
}

async function main() {
  const args=process.argv.slice(2);
  if(args.some(arg=>!['--check-only','--queue-only'].includes(arg)&&!arg.startsWith('--out=')) || args.filter(arg=>arg.startsWith('--out=')).length>1) throw Error('ONBOARDING_ARGUMENT_INVALID');
  const output=args.find(arg=>arg.startsWith('--out='))?.slice(6);
  if(!output) throw Error('ONBOARDING_OUTPUT_REQUIRED');
  const out=path.resolve(output);
  // Reserve a fresh run and avoid overlapping scheduled or manual runs.
  const state=path.join(ROOT,'workflow-runs','api-only-onboarding');
  const release=await acquireRunLock(state);
  try {
    await mkdir(out);
    const seeds=JSON.parse(await readFile(MANIFEST,'utf8'));
    const scout=await syncScoutQueue(ROOT,seeds);
    const manifest=mergeScoutManifest(seeds,scout.queue);
    const result=args.includes('--queue-only') ? {
      schemaVersion:1,kind:'api_only_scout_intake',checkedAt:new Date().toISOString(),
      execution:'local_queue_sync',authenticationChecked:false,browserUsed:false,signupWrites:0,
      services:[],verifiedServices:[],nextWork:selectNextWork([],2,scout.queue)
    } : await inspectOnboarding({manifest,scoutQueue:scout.queue,allowRenewal:!args.includes('--check-only'),
      onProgress:row=>console.log(JSON.stringify({progress:row}))});
    result.scouting={queuePath:SCOUT_QUEUE,inputs:scout.inputs,errors:scout.errors,
      ...scout.queue.importSummary,totalServices:scout.queue.services.filter(row=>row.sourceActive).length,
      newToSeedRegistry:scout.queue.services.filter(row=>row.sourceActive&&!row.seedServiceId).length};
    await writeFile(path.join(out,'scout-queue.json'),JSON.stringify(scout.queue,null,2)+'\n',{flag:'wx'});
    await writeFile(path.join(out,'onboarding.json'),JSON.stringify(result,null,2)+'\n',{flag:'wx'});
    await writeFile(path.join(out,'report.md'),reportMarkdown(result),{flag:'wx'});
    await writeFile(path.join(out,'next-work.json'),JSON.stringify(result.nextWork,null,2)+'\n',{flag:'wx'});
    console.log(JSON.stringify({ok:true,out,scouting:result.scouting,verifiedServices:result.verifiedServices,nextWork:result.nextWork}));
  } finally {
    await release();
  }
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href) main().catch(error=>{
  console.error(JSON.stringify({ok:false,code:code(error.code||error.message)||'ONBOARDING_FAILED'}));process.exitCode=1;
});
