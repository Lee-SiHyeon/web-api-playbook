#!/usr/bin/env python3
"""One native capture plus one owner-bound read of an existing four-image task."""

import hashlib
import importlib.util
import json
import os
import re
import subprocess
import sys
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlsplit

HOME = Path('/home/worker')
REPO = HOME / 'work' / 'provider-login-20261004' / 'grok-web-xhr-client'
RUNTIME = HOME / '.nad-scratch' / 'provider-runtime-20261005'
ROLE = 'codex-grok-media-20261006'
OWNER_SCOPE = '23e57131977ce522bacf6649eb27538770828a890f7a65589ec4f0960a84b3d7'
NODE = '/home/worker/.local/bin/node'
NODE_RUNNER = REPO / 'scripts' / 'grok_media_image_asset_readback.mjs'
GUARD_PATH = REPO / 'scripts' / 'grok_media_capture_guard.py'
IMAGE_SOURCE_PATH = 'verification/grok-media-image-live-2026-10-06.json'
ASSET_ORIGIN = 'https://assets.grok.com'
SOURCE_CODE_FILES = (
    'scripts/grok_media_image_asset_readback.mjs', 'scripts/grok_media_image_asset_readback_once.py',
    'scripts/grok_media_capture_guard.py', 'scripts/grok_media_asset_download.py',
    'src/grok-media-api.mjs', 'src/grok-media-asset-reader.mjs', 'src/grok-media-proof-receipts.mjs',
    'src/feature-checklist.mjs', 'src/runtime.mjs', 'src/client.mjs', 'src/contracts.mjs', 'src/transport.mjs',
    'src/session.mjs', 'src/journal.mjs', 'src/nonsecret-json-store.mjs', 'src/protected-json-store.mjs',
    'src/authenticated-chrome-fetch.mjs', 'scripts/authenticated-chrome-transport.py',
    'contracts/grok-web.v1.json', 'contracts/grok-feature-checklist.v1.json',
)

PAGE_READ = r'''async ({imageStart,imageEnd,expectedPromptSha,expectedOwnerSha}) => {
 const digest=async value=>{if(typeof value!=='string')return null;const b=new TextEncoder().encode(value);const h=await crypto.subtle.digest('SHA-256',b);return [...new Uint8Array(h)].map(x=>x.toString(16).padStart(2,'0')).join('')};
 const take=async response=>{const text=await response.text();let data=null;try{data=JSON.parse(text)}catch{}return {status:response.status,bytes:new TextEncoder().encode(text).length,data}};
 let owner={status:0,match:false,email:null};try{const r=await fetch('/api/auth/session',{method:'GET',credentials:'same-origin',redirect:'error'});const t=await r.text();let d=null;try{d=JSON.parse(t)}catch{}const email=d?.session?.email;if(typeof email==='string'){const h=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(email.trim().toLowerCase()));owner={status:r.status,match:[...new Uint8Array(h)].map(x=>x.toString(16).padStart(2,'0')).join('')===expectedOwnerSha,email}}else owner.status=r.status}catch{}
 const params=new URLSearchParams({includeImagineFiles:'true',isLatest:'true',orderBy:'ORDER_BY_CREATE_TIME',pageSize:'24',source:'SOURCE_ANY'});let cursor=null,pages=0,complete=false,all=[];const seen=new Set();
 while(pages<20){if(cursor)params.set('pageToken',cursor);else params.delete('pageToken');let response;try{response=await fetch('/rest/assets?'+params.toString(),{method:'GET',credentials:'same-origin',redirect:'error'})}catch{break}const r=await take(response);pages++;if(r.status!==200||!Array.isArray(r.data?.assets))break;for(const a of r.data.assets)all.push({assetId:a.assetId,responseId:a.responseId,sourceConversationId:a.sourceConversationId,key:a.key,mimeType:a.mimeType,isPublic:a.isPublic,isModelGenerated:a.isModelGenerated,createTime:a.createTime});cursor=typeof r.data.nextPageToken==='string'&&r.data.nextPageToken? r.data.nextPageToken:null;if(!cursor){complete=true;break}if(seen.has(cursor))break;seen.add(cursor)}
 const ms=v=>{if(typeof v==='number')return v>1e10?v:v*1000;if(typeof v==='string'){const n=Date.parse(v);return Number.isFinite(n)?n:null}return null};
 const candidates=all.filter(a=>a.mimeType==='image/jpeg'&&a.isPublic===false&&a.isModelGenerated===true&&typeof a.assetId==='string'&&typeof a.responseId==='string'&&typeof a.sourceConversationId==='string'&&typeof a.key==='string'&&ms(a.createTime)!==null&&ms(a.createTime)>=imageStart-60000&&ms(a.createTime)<=imageEnd+60000);
 const conversations=new Map();
 for(const a of candidates){const cid=a.sourceConversationId;if(conversations.has(cid))continue;if(!/^[A-Za-z0-9._~-]{16,128}$/.test(cid)){conversations.set(cid,{matched:false});continue}let detail={status:0,data:null},nodes={status:0,data:null},loaded={status:0,data:null};try{detail=await take(await fetch('/rest/app-chat/conversations_v2/'+encodeURIComponent(cid)+'?includeTaskResult=true&includeWorkspaces=true',{method:'GET',credentials:'same-origin',redirect:'error'}))}catch{}try{nodes=await take(await fetch('/rest/app-chat/conversations/'+encodeURIComponent(cid)+'/response-node',{method:'GET',credentials:'same-origin',redirect:'error'}))}catch{}const ids=Array.isArray(nodes.data?.responseNodes)?[...new Set(nodes.data.responseNodes.map(x=>x?.responseId).filter(x=>typeof x==='string'&&x.length>0&&x.length<=256))]:[];if(ids.length){try{loaded=await take(await fetch('/rest/app-chat/conversations/'+encodeURIComponent(cid)+'/load-responses',{method:'POST',credentials:'same-origin',redirect:'error',headers:{'content-type':'application/json'},body:JSON.stringify({responseIds:ids})}))}catch{}}const convo=detail.data?.conversation&&typeof detail.data.conversation==='object'?detail.data.conversation:{};const responses=Array.isArray(loaded.data?.responses)?loaded.data.responses:[];const user=responses.filter(x=>['user','human','client'].includes(String(x?.sender||'').toLowerCase())&&typeof x?.message==='string').map(x=>x.message);const unique=[...new Set(user)];const exact=unique.length===1&&(await digest(unique[0])===expectedPromptSha||unique[0].endsWith(' --mode=custom')&&await digest(unique[0].slice(0,-14))===expectedPromptSha);conversations.set(cid,{detailStatus:detail.status,nodesStatus:nodes.status,loadStatus:loaded.status,conversationMatch:convo.conversationId===cid,uniquePromptCount:unique.length,exactPrompt:exact,responseIds:new Set(responses.map(x=>x?.responseId).filter(x=>typeof x==='string'))})}
 const conversationMatched=candidates.filter(a=>conversations.get(a.sourceConversationId)?.conversationMatch===true);
 const promptMatched=candidates.filter(a=>{const c=conversations.get(a.sourceConversationId);return c?.uniquePromptCount===1&&c.exactPrompt===true});
 const responseLinked=candidates.filter(a=>{const c=conversations.get(a.sourceConversationId);return c?.responseIds?.has(a.responseId)});
 const exact=candidates.filter(a=>{const c=conversations.get(a.sourceConversationId);return c?.conversationMatch===true&&c.uniquePromptCount===1&&c.exactPrompt===true&&c.responseIds?.has(a.responseId)});
 return {owner,listing:{pages,complete,count:all.length},candidateCount:candidates.length,conversationMatchedCount:conversationMatched.length,
   promptMatchedCount:promptMatched.length,responseLinkedCount:responseLinked.length,exactCount:exact.length,assets:exact};
}'''


def canon(value): return json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=False)
def sha(value): return hashlib.sha256(value).hexdigest()


def source_snapshot():
    captured_at = datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z')
    hashes = {}
    for relative in SOURCE_CODE_FILES:
        path = REPO / relative
        if path.is_symlink() or not path.is_file(): raise RuntimeError('SOURCE_FILE_INVALID')
        hashes[relative] = sha(path.read_bytes())
    return {'capturedAt': captured_at, 'codeSha256': hashes, 'digest': sha(canon(hashes).encode())}


def read_json(path):
    if path.is_symlink() or not path.is_file() or path.stat().st_size > 8 * 1024 * 1024: raise RuntimeError('LOCAL_EVIDENCE_INVALID')
    return json.loads(path.read_text(encoding='utf-8'))


def time_ms(value):
    if isinstance(value, (int, float)): return int(value if value > 10_000_000_000 else value * 1000)
    if isinstance(value, str):
        try: return int(datetime.fromisoformat(value.replace('Z', '+00:00')).timestamp() * 1000)
        except Exception: return None
    return None


def asset_url(key):
    if not isinstance(key, str) or not key or len(key) > 8192 or re.search(r'[\r\n\0\\?#]', key): raise RuntimeError('ASSET_KEY_SCOPE_INVALID')
    if key.startswith('https://'):
        parsed = urlsplit(key)
        if parsed.netloc != 'assets.grok.com' or parsed.query or parsed.fragment: raise RuntimeError('ASSET_KEY_SCOPE_INVALID')
        path = parsed.path
    else: path = key if key.startswith('/') else '/' + key
    if not path.startswith('/users/') or '/generated/' not in path: raise RuntimeError('ASSET_KEY_SCOPE_INVALID')
    return ASSET_ORIGIN + path + '?cache=1'


def native_probe(page, context, guard, asset):
    url = asset_url(asset['key']); guard.allow_exact_asset_read(url)
    guard.cdp.send('Network.setCacheDisabled', {'cacheDisabled': True})
    try:
        event = page.evaluate(r'''url=>new Promise(resolve=>{const image=new Image();let done=false;const finish=v=>{if(done)return;done=true;image.removeAttribute('src');resolve(v)};image.onload=()=>finish('loaded');image.onerror=()=>finish('error');setTimeout(()=>finish('timeout'),15000);image.src=url})''', url)
        page.wait_for_timeout(200)
    finally: guard.cdp.send('Network.setCacheDisabled', {'cacheDisabled': False})
    record=guard._asset_records_by_url.get(url,{})
    response=record.get('response') or {}
    headers=guard.asset_request_header_values(url)
    cookie_names=set(record.get('cookieNames',set()))
    asset_cookies=[c for c in context.cookies([url]) if c.get('name')=='sso' and c.get('value')
        and str(c.get('domain','')).lstrip('.').lower() in {'grok.com','assets.grok.com'} and c.get('path')=='/'
        and c.get('secure') is True and c.get('httpOnly') is True]
    session_cookies=[c for c in context.cookies(['https://grok.com']) if c.get('name')=='sso' and c.get('value')
        and str(c.get('domain','')).lstrip('.').lower()=='grok.com' and c.get('path')=='/'
        and c.get('secure') is True and c.get('httpOnly') is True]
    if event!='loaded' or response.get('status')!=200 or response.get('mimeType')!='image/jpeg' or record.get('requestCount')!=1 \
        or 'sso' not in cookie_names or len(asset_cookies)!=1 or len(session_cookies)!=1 \
        or asset_cookies[0]['value']!=session_cookies[0]['value'] \
        or not {'referer','user-agent','sec-ch-ua-platform'}.issubset(headers):
        raise RuntimeError('NATIVE_IMAGE_ASSET_CAPTURE_FAILED')
    asset_context={'schemaVersion':1,'source':'normal_ui_asset_request','ownerIdentityDigest':OWNER_SCOPE,
        'assetOrigin':ASSET_ORIGIN,'pathClass':'/users/*/generated/*','method':'GET','observedCookieNames':['sso'],
        'cookies':[{k:asset_cookies[0][k] for k in ('name','value','domain','path','secure','httpOnly')}],
        'headers':headers}
    session_bundle={'schemaVersion':1,'serviceId':'grok-web','origin':'https://grok.com',
        'capturedAt':datetime.now(timezone.utc).isoformat().replace('+00:00','Z'),'sourceObservationId':'linux-native-chrome-'+str(uuid.uuid4()),
        'origins':[{'origin':'https://grok.com','cookies':[{'name':'sso','value':session_cookies[0]['value'],'domain':'grok.com','path':'/',
            'secure':True,'httpOnly':True,'expiresAt':None}],'headers':[]}]}
    capture={'captureMode':'native_read_capture','pageRoleMatched':True,'intentMatched':True,'requestCaptured':True,
        'businessActionBlocked':False,'networkFailureCorrelated':False,'browserBusinessWritesDelivered':0,
        'browserResponseCount':1,'rawRequestPersisted':False,'rawResponsePersisted':False}
    return url,asset_context,session_bundle,capture


def main():
    snapshot=source_snapshot(); stage='preflight'; guard=None; secret_values=[]; read_diag={}
    try:
        source_receipt_path=REPO/IMAGE_SOURCE_PATH; image_source=read_json(source_receipt_path); source_receipt_sha=sha(source_receipt_path.read_bytes())
        if image_source.get('operation')!='media.image.create' or image_source.get('ownerVerified') is not True \
            or image_source.get('ownerMatchesExpected') is not True or image_source.get('nativeBatchFourVerified') is not True \
            or image_source.get('nativeProfileVerified') is not True or image_source.get('writeRequestsSent')!=1 \
            or not re.fullmatch(r'[a-f0-9]{64}',str(image_source.get('promptSha256'))): raise RuntimeError('IMAGE_SOURCE_RECEIPT_INVALID')
        operations=read_json(HOME/'.nad-scratch/grok-web-xhr-client/operations.json').get('entries',[])
        matches=[e for e in operations if e.get('contractId')=='media.image.create' and e.get('state')=='completed'
            and e.get('httpStatus')==101 and e.get('attemptCount')==1 and e.get('reasonCode')=='MEDIA_ASSET_READBACK_VERIFIED'
            and time_ms(e.get('createdAt')) is not None and abs(time_ms(e['createdAt'])-time_ms(image_source['observedAt']))<=120_000]
        if len(matches)!=1: raise RuntimeError('IMAGE_OPERATION_JOURNAL_NOT_UNIQUE')
        operation=matches[0]; intent_digest=operation.get('intentDigest'); request_digest=operation.get('requestDigest')
        if not re.fullmatch(r'[a-f0-9]{64}',str(intent_digest)) or not re.fullmatch(r'[a-f0-9]{64}',str(request_digest)):
            raise RuntimeError('IMAGE_OPERATION_BINDING_INVALID')
        operation_start=time_ms(operation.get('createdAt'))
        owner_runtime=read_json(RUNTIME/'runtime-owner.json'); roles=read_json(RUNTIME/'page-role-registry.json')
        role=roles.get('activePageRoles',{}).get(ROLE,{})
        if role.get('origin')!='https://grok.com' or role.get('exactMarkerCount')!=1 or role.get('selection')!='cdp_target_id' or not role.get('targetId'):
            raise RuntimeError('MEDIA_PAGE_ROLE_NOT_UNIQUE')
        proc_args=Path(f"/proc/{owner_runtime.get('chromePid',0)}/cmdline").read_bytes().decode(errors='ignore').split('\0')
        if owner_runtime.get('taskOwned') is not True or not Path(f"/proc/{owner_runtime.get('chromePid',0)}").exists() \
            or not Path(f"/proc/{owner_runtime.get('supervisorPid',0)}").exists() \
            or f"--user-data-dir={Path(owner_runtime['profile']).resolve()}" not in proc_args: raise RuntimeError('OWNED_RUNTIME_INVALID')
        from playwright.sync_api import sync_playwright
        spec=importlib.util.spec_from_file_location('grok_media_capture_guard',GUARD_PATH);module=importlib.util.module_from_spec(spec);sys.modules[spec.name]=module;spec.loader.exec_module(module)
        with sync_playwright() as playwright:
            stage='connect_owned_page';browser=playwright.chromium.connect_over_cdp(f"http://127.0.0.1:{int(owner_runtime['cdpPort'])}");pages=[]
            for context in browser.contexts:
                for page in context.pages:
                    try:
                        if page.evaluate('() => window.name')!=ROLE:continue
                        cdp=context.new_cdp_session(page)
                        try:info=cdp.send('Target.getTargetInfo').get('targetInfo',{})
                        finally:cdp.detach()
                        if info.get('targetId')==role['targetId']:pages.append(page)
                    except Exception:pass
            if len(pages)!=1:raise RuntimeError('MEDIA_PAGE_ROLE_NOT_UNIQUE')
            page=pages[0];context=page.context;current=urlsplit(page.url).path
            if current!='/imagine':
                if current in {'','/','blank'} or re.fullmatch(r'/imagine/post/[A-Za-z0-9._~-]{1,256}',current):page.goto('https://grok.com/imagine',wait_until='domcontentloaded',timeout=20000)
                if urlsplit(page.url).path!='/imagine':raise RuntimeError('MEDIA_PAGE_ROUTE_INVALID')
            guard=module.GrokMediaCaptureGuard(page,ROLE,operation='media.image.create',quiet_window_ms=5000)
            stage='arm_read_only_page_guard';guard.arm()
            stage='verify_current_owner_and_task_history'
            readback=page.evaluate(PAGE_READ,{'imageStart':operation_start,'imageEnd':operation_start,
                'expectedPromptSha':image_source['promptSha256'],'expectedOwnerSha':OWNER_SCOPE})
            read_diag={'ownerStatus':readback.get('owner',{}).get('status'),'ownerMatched':readback.get('owner',{}).get('match') is True,
                'assetPages':readback.get('listing',{}).get('pages'),'assetListComplete':readback.get('listing',{}).get('complete') is True,
                'assetCount':readback.get('listing',{}).get('count'),'imageCandidateCount':readback.get('candidateCount'),
                'conversationMatchedCount':readback.get('conversationMatchedCount'),'promptMatchedCount':readback.get('promptMatchedCount'),
                'responseLinkedCount':readback.get('responseLinkedCount'),'exactTaskAssetCount':readback.get('exactCount')}
            exact_assets=readback.get('assets',[])
            exact_count=readback.get('exactCount')
            if readback.get('owner',{}).get('status')!=200 or readback.get('owner',{}).get('match') is not True \
                or readback.get('listing',{}).get('complete') is not True or not isinstance(exact_count,int) \
                or exact_count<1 or exact_count>4 or len(exact_assets)!=exact_count:
                raise RuntimeError('NATIVE_IMAGE_TASK_READBACK_NOT_UNIQUE')
            asset=min(exact_assets,key=lambda a:hashlib.sha256(a['assetId'].encode()).hexdigest())
            if asset.get('mimeType')!='image/jpeg' or asset.get('isPublic') is not False or asset.get('isModelGenerated') is not True:
                raise RuntimeError('NATIVE_IMAGE_ASSET_INVALID')
            owner_email=readback['owner'].get('email');secret_values.extend([owner_email,asset.get('assetId')])
            stage='capture_exact_native_image_get';native_url,asset_context,session_bundle,browser_capture=native_probe(page,context,guard,asset)
            secret_values.extend([native_url,asset_context['cookies'][0]['value'],session_bundle['origins'][0]['cookies'][0]['value']])
            owner_receipt=read_json(REPO/'verification/grok-feature-live-receipts/auth-owner.read.json')
            owner_digest=hashlib.sha256(canon(owner_receipt).encode()).hexdigest()
            owner_path=f'verification/owner-proofs/{owner_digest}.json';owner_proof=read_json(REPO/owner_path)
            if owner_proof.get('ownerScopeSha256')!=OWNER_SCOPE:raise RuntimeError('OWNER_PROOF_SCOPE_MISMATCH')
            packet={'assetId':asset['assetId'],'assetRequestContext':asset_context,'browserCapture':browser_capture,
                'currentExactTaskAssetCount':exact_count,'expectedIdentity':owner_email,
                'imageSourceReceiptPath':IMAGE_SOURCE_PATH,'imageSourceReceiptSha256':source_receipt_sha,
                'operationIntentDigest':intent_digest,'operationRequestDigest':request_digest,
                'outputName':f'image-01-readback-{uuid.uuid4().hex[:8]}.jpg','ownerProof':{
                    'canonicalSha256':owner_digest,'identityReceiptSha256':owner_digest,'ownerScopeSha256':OWNER_SCOPE,
                    'proofPath':owner_path,'sameAuthenticatedOwner':True,'verified':True},
                'sessionBundle':session_bundle,'sourceSnapshotSha256':snapshot['digest']}
            stage='direct_read_only_asset_download';raw=bytearray(json.dumps(packet,separators=(',',':'),ensure_ascii=False).encode())
            if len(raw)>256*1024:raise RuntimeError('NODE_PACKET_SIZE_LIMIT')
            env={k:v for k,v in os.environ.items() if k in {'PATH','HOME','LANG','LC_ALL','TMPDIR','SSL_CERT_FILE','SSL_CERT_DIR','REQUESTS_CA_BUNDLE'}}
            env['GROK_CHROME_PYTHON']='/home/worker/work/web-api-playbook-inpock-20261004/.venv-oliveyoung/bin/python';env['GROK_CURRENT_OWNER_PROOF_PATH']='verification/grok-feature-live-receipts/auth-owner.read.json'
            proc=subprocess.run([NODE,str(NODE_RUNNER)],cwd=str(REPO),input=bytes(raw),stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,env=env,timeout=180,check=False)
            for i in range(len(raw)):raw[i]=0
            if len(proc.stdout)>16*1024:raise RuntimeError('NODE_RESULT_SIZE_LIMIT')
            try:result=json.loads(proc.stdout.decode())
            except Exception:raise RuntimeError('NODE_RESULT_INVALID')
            if proc.returncode!=0 or result.get('status')!='verified':
                if isinstance(result.get('stage'),str) and re.fullmatch(r'[a-z][a-z0-9_]{1,63}',result['stage']):stage='node_'+result['stage']
                raise RuntimeError(result.get('errorCode') if isinstance(result.get('errorCode'),str) else 'IMAGE_ASSET_READBACK_FAILED')
            stage='restore_owned_page_and_quiet_window';guard.mark_task_terminal('completed');closed=guard.close_read_only_after_quiescence()
            if closed.get('cleanPageRestored') is not True or closed.get('browserServerWritesDelivered')!=0:raise RuntimeError('MEDIA_GUARD_CLOSE_UNVERIFIED')
            if not any(item.get('requestCount')==1 for item in closed.get('assetBrowserRequests',[])):raise RuntimeError('NATIVE_ASSET_CAPTURE_COUNT_INVALID')
            print(json.dumps({k:result.get(k) for k in ('status','requirementId','sourceSnapshotSha256','sourceStableThroughReadback','ownerVerified','taskBoundAssetCount','httpStatus','mimeType','bodyBytes','assetSha256','magicVerified','independentFileReadback','receiptPath','runPath','runSha256','linkPath')},separators=(',',':')))
            return 0
    except Exception as error:
        code=error.args[0] if error.args and isinstance(error.args[0],str) and re.fullmatch(r'[A-Z][A-Z0-9_]{0,63}',error.args[0]) else 'IMAGE_ASSET_READBACK_FAILED'
        print(json.dumps({'status':'failed','stage':stage,'errorCode':code,'sourceSnapshotSha256':snapshot['digest'],
            'directReadMayHaveStarted':stage=='node_asset_download' or stage=='node_artifact_file_readback',**read_diag},separators=(',',':')))
        return 1
    finally:
        if guard is not None and getattr(guard,'active',False):
            try:guard.mark_task_terminal('needs_review');guard.close_read_only_after_quiescence()
            except Exception:pass
        for value in secret_values:
            if isinstance(value,str):value=''


if __name__=='__main__':
    raise SystemExit(main())
