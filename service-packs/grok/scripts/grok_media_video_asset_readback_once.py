#!/usr/bin/env python3
"""Capture one native read and replay one owner-bound, read-only video asset GET."""

import hashlib
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
EXPECTED_OWNER_SCOPE = '23e57131977ce522bacf6649eb27538770828a890f7a65589ec4f0960a84b3d7'
NODE = '/home/worker/.local/bin/node'
NODE_RUNNER = REPO / 'scripts' / 'grok_media_video_asset_readback.mjs'
GUARD_PATH = REPO / 'scripts' / 'grok_media_capture_guard.py'
ASSET_ORIGIN = 'https://assets.grok.com'
SOURCE_CODE_FILES = (
    'scripts/grok_media_video_asset_readback.mjs',
    'scripts/grok_media_video_asset_readback_once.py',
    'scripts/grok_media_capture_guard.py',
    'scripts/grok_media_asset_download.py',
    'scripts/emit-grok-media-proof.mjs',
    'src/grok-media-api.mjs',
    'src/grok-media-asset-reader.mjs',
    'src/grok-media-proof-receipts.mjs',
    'src/grok-media-intent.mjs',
    'src/feature-checklist.mjs',
    'src/runtime.mjs',
    'src/cli.mjs',
    'src/client.mjs',
    'src/contracts.mjs',
    'src/transport.mjs',
    'src/session.mjs',
    'src/journal.mjs',
    'src/nonsecret-json-store.mjs',
    'src/protected-json-store.mjs',
    'src/authenticated-chrome-fetch.mjs',
    'scripts/authenticated-chrome-transport.py',
    'contracts/grok-web.v1.json',
    'contracts/grok-feature-checklist.v1.json',
    'verification/grok-media-contract-capture-2026-10-06.json',
)

PAGE_READ = r'''async ({videoStart,videoEnd,expectedPromptSha,expectedPromptLength,expectedOwnerSha}) => {
 const digest=async value=>{if(typeof value!=='string')return null;const b=new TextEncoder().encode(value);const h=await crypto.subtle.digest('SHA-256',b);return [...new Uint8Array(h)].map(x=>x.toString(16).padStart(2,'0')).join('')};
 const take=async response=>{const text=await response.text();let data=null;try{data=JSON.parse(text)}catch{}return {status:response.status,bytes:new TextEncoder().encode(text).length,data}};
 let owner={status:0,bytes:0,match:false,email:null};
 try{const r=await fetch('/api/auth/session',{method:'GET',credentials:'same-origin',redirect:'error'});const text=await r.text();let data=null;try{data=JSON.parse(text)}catch{}const email=data?.session?.email;owner={status:r.status,bytes:new TextEncoder().encode(text).length,match:typeof email==='string'&&await digest(email.trim().toLowerCase())===expectedOwnerSha,email:typeof email==='string'?email:null}}catch{}
 const params=new URLSearchParams({includeImagineFiles:'true',isLatest:'true',orderBy:'ORDER_BY_CREATE_TIME',pageSize:'24',source:'SOURCE_ANY'});
 let cursor=null,pages=0,complete=false,all=[];const seen=new Set();
 while(pages<20){if(cursor)params.set('pageToken',cursor);else params.delete('pageToken');let response;try{response=await fetch('/rest/assets?'+params.toString(),{method:'GET',credentials:'same-origin',redirect:'error'})}catch{break}const result=await take(response);pages++;if(result.status!==200||!Array.isArray(result.data?.assets))break;for(const asset of result.data.assets)all.push({assetId:asset.assetId,responseId:asset.responseId,sourceConversationId:asset.sourceConversationId,key:asset.key,mimeType:asset.mimeType,isPublic:asset.isPublic,isModelGenerated:asset.isModelGenerated,createTime:asset.createTime});cursor=typeof result.data.nextPageToken==='string'&&result.data.nextPageToken?result.data.nextPageToken:null;if(!cursor){complete=true;break}if(seen.has(cursor))break;seen.add(cursor)}
 const ms=value=>{if(typeof value==='number')return value>10000000000?value:value*1000;if(typeof value==='string'){const n=Date.parse(value);return Number.isFinite(n)?n:null}return null};
 const candidates=all.filter(a=>a.mimeType==='video/mp4'&&a.isPublic===false&&a.isModelGenerated===true&&typeof a.assetId==='string'&&typeof a.responseId==='string'&&typeof a.sourceConversationId==='string'&&typeof a.key==='string'&&ms(a.createTime)!==null&&ms(a.createTime)>=videoStart-5000&&ms(a.createTime)<=videoEnd+5000);
 const conversations=new Map();
 for(const asset of candidates){const cid=asset.sourceConversationId;if(conversations.has(cid))continue;if(!/^[A-Za-z0-9._~-]{16,128}$/.test(cid)){conversations.set(cid,{matched:false});continue}let detail={status:0,data:null},nodes={status:0,data:null},loaded={status:0,data:null};try{detail=await take(await fetch('/rest/app-chat/conversations_v2/'+encodeURIComponent(cid)+'?includeTaskResult=true&includeWorkspaces=true',{method:'GET',credentials:'same-origin',redirect:'error'}))}catch{}try{nodes=await take(await fetch('/rest/app-chat/conversations/'+encodeURIComponent(cid)+'/response-node',{method:'GET',credentials:'same-origin',redirect:'error'}))}catch{}const ids=Array.isArray(nodes.data?.responseNodes)?[...new Set(nodes.data.responseNodes.map(x=>x?.responseId).filter(x=>typeof x==='string'&&x.length>0&&x.length<=256))]:[];if(ids.length){try{loaded=await take(await fetch('/rest/app-chat/conversations/'+encodeURIComponent(cid)+'/load-responses',{method:'POST',credentials:'same-origin',redirect:'error',headers:{'content-type':'application/json'},body:JSON.stringify({responseIds:ids})}))}catch{}}const convo=detail.data?.conversation&&typeof detail.data.conversation==='object'?detail.data.conversation:{};const responses=Array.isArray(loaded.data?.responses)?loaded.data.responses:[];const user=responses.filter(x=>['user','human','client'].includes(String(x?.sender||'').toLowerCase())&&typeof x?.message==='string').map(x=>x.message);const unique=[...new Set(user)];const exact=unique.length===1&&(await digest(unique[0])===expectedPromptSha&&unique[0].length===expectedPromptLength||unique[0].endsWith(' --mode=custom')&&unique[0].length===expectedPromptLength+14&&await digest(unique[0].slice(0,-14))===expectedPromptSha);conversations.set(cid,{detailStatus:detail.status,nodesStatus:nodes.status,loadStatus:loaded.status,conversationMatch:convo.conversationId===cid,uniquePromptCount:unique.length,exactPrompt:exact,promptSha256:exact?expectedPromptSha:null,responseIds:new Set(responses.map(x=>x?.responseId).filter(x=>typeof x==='string'))})}
 const exact=candidates.filter(a=>{const c=conversations.get(a.sourceConversationId);return c?.conversationMatch===true&&c.uniquePromptCount===1&&c.exactPrompt===true&&c.responseIds?.has(a.responseId)});
 return {owner,listing:{pages,complete,count:all.length},candidateCount:candidates.length,exactCount:exact.length,asset:exact.length===1?exact[0]:null};
}'''


def canonical_json(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=False)


def digest_bytes(value):
    return hashlib.sha256(value).hexdigest()


def source_snapshot():
    captured_at = datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z')
    hashes = {}
    for relative in SOURCE_CODE_FILES:
        target = REPO / relative
        if target.is_symlink() or not target.is_file():
            raise RuntimeError('SOURCE_FILE_INVALID')
        hashes[relative] = digest_bytes(target.read_bytes())
    return {'capturedAt': captured_at, 'codeSha256': hashes,
            'digest': digest_bytes(canonical_json(hashes).encode('utf-8'))}


def read_json(path):
    if path.is_symlink() or not path.is_file() or path.stat().st_size > 8 * 1024 * 1024:
        raise RuntimeError('LOCAL_EVIDENCE_INVALID')
    return json.loads(path.read_text(encoding='utf-8'))


def now_ms(value):
    if isinstance(value, (int, float)):
        return int(value if value > 10_000_000_000 else value * 1000)
    if isinstance(value, str):
        try:
            parsed = datetime.fromisoformat(value.replace('Z', '+00:00'))
            return int(parsed.timestamp() * 1000)
        except Exception:
            return None
    return None


def exact_source_run(owner_scope, intent_digest):
    candidates = []
    for path in (REPO / 'verification' / 'one-shot').glob('grok-media-video-text-source-run-*.json'):
        if path.is_symlink():
            continue
        value = read_json(path)
        if value.get('recordType') == 'grok-media-source-bound-run' and value.get('requirementId') == 'video.text-to-video' \
            and value.get('owner', {}).get('ownerScopeSha256') == owner_scope \
            and value.get('intentDigest') == intent_digest and value.get('generationMode') == 'text' \
            and value.get('directTransport', {}).get('directDispatchCount') == 1 \
            and value.get('directTransport', {}).get('attemptCount') == 1:
            candidates.append((path, value, digest_bytes(path.read_bytes())))
    if len(candidates) != 1:
        raise RuntimeError('SOURCE_VIDEO_RUN_NOT_UNIQUE')
    return candidates[0]


def select_journal_binding(owner_scope):
    intent_path = HOME / '.nad-scratch' / 'grok-web-xhr-client' / 'media-intents.json'
    operation_path = HOME / '.nad-scratch' / 'grok-web-xhr-client' / 'operations.json'
    intents = read_json(intent_path).get('intents', [])
    operations = read_json(operation_path).get('entries', [])
    matches = []
    for item in intents:
        if not isinstance(item, dict) or item.get('operation') != 'media.video.create' \
            or item.get('payloadProfile') != 'video-6s-480p-no-audio' or item.get('state') != 'completed' \
            or item.get('attemptNumber') != 1 or item.get('ownerIdentityDigest') != owner_scope \
            or not isinstance(item.get('intentId'), str) or not re.fullmatch(r'[0-9a-f-]{36}', item['intentId']):
            continue
        intent_digest = hashlib.sha256(f"media.video.create\n{owner_scope}\n{item['intentId']}".encode()).hexdigest()
        matching_operations = [entry for entry in operations if isinstance(entry, dict)
            and entry.get('contractId') == 'media.video.create' and entry.get('intentDigest') == intent_digest
            and entry.get('state') == 'completed' and entry.get('httpStatus') == 200 and entry.get('attemptCount') == 1]
        if len(matching_operations) == 1:
            matches.append((item, intent_digest, matching_operations[0]))
    if len(matches) != 1:
        raise RuntimeError('COMPLETED_VIDEO_JOURNAL_NOT_UNIQUE')
    return matches[0]


def build_asset_url(key):
    if not isinstance(key, str) or not key or len(key) > 8192 or re.search(r'[\r\n\0\\?#]', key):
        raise RuntimeError('ASSET_KEY_SCOPE_INVALID')
    if key.startswith('https://'):
        parsed = urlsplit(key)
        if parsed.scheme != 'https' or parsed.netloc != 'assets.grok.com' or parsed.query or parsed.fragment:
            raise RuntimeError('ASSET_KEY_SCOPE_INVALID')
        path = parsed.path
    elif key.startswith('/'):
        path = key
    else:
        path = '/' + key
    parsed_path = urlsplit(path)
    if not parsed_path.path.startswith('/users/') or '/generated/' not in parsed_path.path:
        raise RuntimeError('ASSET_KEY_SCOPE_INVALID')
    return ASSET_ORIGIN + parsed_path.path + '?cache=1'


def read_owner(page, expected_scope):
    return page.evaluate("""async expected => {
      try {
        const r=await fetch('/api/auth/session',{method:'GET',credentials:'same-origin',redirect:'error'});
        const text=await r.text(); let data=null; try{data=JSON.parse(text)}catch{}
        const email=data?.session?.email;
        if(typeof email!=='string')return {status:r.status,match:false,email:null};
        const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(email.trim().toLowerCase()));
        return {status:r.status,match:[...new Uint8Array(digest)].map(x=>x.toString(16).padStart(2,'0')).join('')===expected,email};
      }catch{return {status:0,match:false,email:null}}
    }""", expected_scope)


def native_asset_capture(page, context, guard, asset):
    url = build_asset_url(asset['key'])
    guard.allow_exact_asset_read(url)
    guard.cdp.send('Network.setCacheDisabled', {'cacheDisabled': True})
    try:
        event = page.evaluate(r'''url => new Promise(resolve => {
          const video=document.createElement('video'); video.preload='metadata'; let done=false;
          const finish=value=>{if(done)return;done=true;video.removeAttribute('src');video.load();resolve(value)};
          video.onloadedmetadata=()=>finish('loaded'); video.onerror=()=>finish('error');
          setTimeout(()=>finish('timeout'),15000); video.src=url; video.load();
        })''', url)
        page.wait_for_timeout(200)
    finally:
        guard.cdp.send('Network.setCacheDisabled', {'cacheDisabled': False})
    record = guard._asset_records_by_url.get(url, {})
    response = record.get('response') or {}
    headers = guard.asset_request_header_values(url)
    cookie_names = set(record.get('cookieNames', set()))
    cookies = [cookie for cookie in context.cookies([url]) if cookie.get('name') == 'sso'
        and isinstance(cookie.get('value'), str) and cookie.get('value')
        and str(cookie.get('domain', '')).lstrip('.').lower() in {'grok.com', 'assets.grok.com'}
        and cookie.get('path') == '/' and cookie.get('secure') is True and cookie.get('httpOnly') is True]
    session_cookies = [cookie for cookie in context.cookies(['https://grok.com']) if cookie.get('name') == 'sso'
        and isinstance(cookie.get('value'), str) and cookie.get('value')
        and str(cookie.get('domain', '')).lstrip('.').lower() == 'grok.com'
        and cookie.get('path') == '/' and cookie.get('secure') is True and cookie.get('httpOnly') is True]
    required = {'referer', 'user-agent', 'sec-ch-ua-platform'}
    if event != 'loaded' or response.get('status') not in {200, 206} or response.get('mimeType') != 'video/mp4' \
        or record.get('requestCount') != 1 or 'sso' not in cookie_names or len(cookies) != 1 \
        or len(session_cookies) != 1 or cookies[0]['value'] != session_cookies[0]['value'] \
        or not required.issubset(headers):
        raise RuntimeError('NATIVE_VIDEO_ASSET_CAPTURE_FAILED')
    asset_context = {
        'schemaVersion': 1,
        'source': 'normal_ui_asset_request',
        'ownerIdentityDigest': EXPECTED_OWNER_SCOPE,
        'assetOrigin': ASSET_ORIGIN,
        'pathClass': '/users/*/generated/*',
        'method': 'GET',
        'observedCookieNames': ['sso'],
        'cookies': [{key: cookies[0][key] for key in ('name', 'value', 'domain', 'path', 'secure', 'httpOnly')}],
        'headers': headers,
    }
    session_bundle = {
        'schemaVersion': 1,
        'serviceId': 'grok-web',
        'origin': 'https://grok.com',
        'capturedAt': datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z'),
        'sourceObservationId': 'linux-native-chrome-' + str(uuid.uuid4()),
        'origins': [{
            'origin': 'https://grok.com',
            'cookies': [{
                'name': 'sso', 'value': session_cookies[0]['value'], 'domain': 'grok.com', 'path': '/',
                'secure': True, 'httpOnly': True, 'expiresAt': None,
            }],
            'headers': [],
        }],
    }
    browser_capture = {
        'captureMode': 'native_read_capture',
        'pageRoleMatched': True,
        'intentMatched': True,
        'requestCaptured': True,
        'businessActionBlocked': False,
        'networkFailureCorrelated': False,
        'browserBusinessWritesDelivered': 0,
        'browserResponseCount': 1,
        'rawRequestPersisted': False,
        'rawResponsePersisted': False,
    }
    return url, asset_context, session_bundle, browser_capture


def safe_output(value):
    allowed = {
        'schemaVersion', 'status', 'errorCode', 'stage', 'sourceSnapshotSha256', 'sourceCodeSnapshotAt',
        'sourceStableThroughReadback', 'ownerVerified', 'sourceVideoIntentJournalLinked', 'taskAssetMatched',
        'httpStatus', 'mimeType', 'bodyBytes', 'artifactSha256', 'magicVerified', 'independentFileReadback',
        'videoDurationSeconds', 'artifactReceiptPath', 'sourceRunPath', 'sourceRunSha256', 'sourceLinkPath',
        'sourceLinkSha256', 'operationId', 'directReadMayHaveStarted',
    }
    return {key: value[key] for key in allowed if key in value}


def main():
    snapshot = source_snapshot()
    stage = 'preflight'
    guard = None
    browser = None
    secrets = []
    read_failure = {}
    try:
        owner_runtime = read_json(RUNTIME / 'runtime-owner.json')
        role_registry = read_json(RUNTIME / 'page-role-registry.json')
        role = role_registry.get('activePageRoles', {}).get(ROLE, {})
        if role.get('origin') != 'https://grok.com' or role.get('exactMarkerCount') != 1 \
            or role.get('selection') != 'cdp_target_id' or not isinstance(role.get('targetId'), str):
            raise RuntimeError('MEDIA_PAGE_ROLE_NOT_UNIQUE')
        browser_pid = int(owner_runtime.get('chromePid', 0))
        supervisor_pid = int(owner_runtime.get('supervisorPid', 0))
        profile = str(Path(owner_runtime['profile']).resolve())
        args = Path(f'/proc/{browser_pid}/cmdline').read_bytes().decode(errors='ignore').split('\0')
        if owner_runtime.get('taskOwned') is not True or not Path(f'/proc/{browser_pid}').exists() \
            or not Path(f'/proc/{supervisor_pid}').exists() or f'--user-data-dir={profile}' not in args:
            raise RuntimeError('OWNED_RUNTIME_INVALID')
        intents = read_json(HOME / '.nad-scratch' / 'grok-web-xhr-client' / 'media-intents.json').get('intents', [])
        operations = read_json(HOME / '.nad-scratch' / 'grok-web-xhr-client' / 'operations.json').get('entries', [])
        source_bindings = []
        for intent in intents:
            if intent.get('operation') != 'media.video.create' or intent.get('state') != 'completed' \
                or intent.get('attemptNumber') != 1 or intent.get('ownerIdentityDigest') != EXPECTED_OWNER_SCOPE \
                or intent.get('payloadProfile') != 'video-6s-480p-no-audio':
                continue
            intent_digest = hashlib.sha256(f"media.video.create\n{EXPECTED_OWNER_SCOPE}\n{intent.get('intentId')}".encode()).hexdigest()
            source_run = exact_source_run(EXPECTED_OWNER_SCOPE, intent_digest)
            matched_ops = [entry for entry in operations if entry.get('contractId') == 'media.video.create'
                and entry.get('intentDigest') == intent_digest and entry.get('state') == 'completed'
                and entry.get('httpStatus') == 200 and entry.get('attemptCount') == 1
                and entry.get('requestDigest') == source_run[1].get('requestDigest')]
            if len(matched_ops) == 1 and intent.get('promptSha256') == source_run[1].get('promptSha256'):
                source_bindings.append((intent, intent_digest, matched_ops[0], source_run))
        if len(source_bindings) != 1:
            raise RuntimeError('COMPLETED_VIDEO_SOURCE_BINDING_NOT_UNIQUE')
        intent, intent_digest, operation, source_run_tuple = source_bindings[0]
        source_path, source_run, source_run_sha = source_run_tuple
        if intent.get('promptLength') is None or not isinstance(intent.get('promptLength'), int):
            raise RuntimeError('VIDEO_INTENT_PROMPT_LENGTH_MISSING')
        operation_start = now_ms(operation.get('createdAt'))
        if operation_start is None:
            raise RuntimeError('VIDEO_OPERATION_TIME_INVALID')

        from playwright.sync_api import sync_playwright
        import importlib.util
        guard_spec = importlib.util.spec_from_file_location('grok_media_capture_guard', GUARD_PATH)
        guard_module = importlib.util.module_from_spec(guard_spec)
        sys.modules[guard_spec.name] = guard_module
        guard_spec.loader.exec_module(guard_module)
        with sync_playwright() as playwright:
            stage = 'connect_owned_page'
            browser = playwright.chromium.connect_over_cdp(f"http://127.0.0.1:{int(owner_runtime['cdpPort'])}")
            pages = []
            for context in browser.contexts:
                for page in context.pages:
                    try:
                        if page.evaluate('() => window.name') != ROLE:
                            continue
                        cdp = context.new_cdp_session(page)
                        try:
                            info = cdp.send('Target.getTargetInfo').get('targetInfo', {})
                        finally:
                            cdp.detach()
                        if info.get('targetId') == role.get('targetId'):
                            pages.append(page)
                    except Exception:
                        pass
            if len(pages) != 1:
                raise RuntimeError('MEDIA_PAGE_ROLE_NOT_UNIQUE')
            page = pages[0]
            context = page.context
            current_path = urlsplit(page.url).path
            if current_path != '/imagine':
                if current_path in {'', '/', 'blank'} or re.fullmatch(r'/imagine/post/[A-Za-z0-9._~-]{1,256}', current_path):
                    page.goto('https://grok.com/imagine', wait_until='domcontentloaded', timeout=20_000)
                if urlsplit(page.url).path != '/imagine':
                    raise RuntimeError('MEDIA_PAGE_ROUTE_INVALID')
            guard = guard_module.GrokMediaCaptureGuard(page, ROLE, operation='media.video.create', quiet_window_ms=5000)
            stage = 'arm_read_only_page_guard'
            guard.arm()
            stage = 'verify_current_owner_and_task_history'
            readback = page.evaluate(PAGE_READ, {
                'videoStart': operation_start - 5_000,
                'videoEnd': int(time.time() * 1000) + 5_000,
                'expectedPromptSha': source_run['promptSha256'],
                'expectedPromptLength': intent['promptLength'],
                'expectedOwnerSha': EXPECTED_OWNER_SCOPE,
            })
            if readback.get('owner', {}).get('status') != 200 or readback.get('owner', {}).get('match') is not True \
                or not isinstance(readback.get('owner', {}).get('email'), str) \
                or readback.get('listing', {}).get('complete') is not True or readback.get('exactCount') != 1:
                raise RuntimeError('NATIVE_TASK_READBACK_NOT_UNIQUE')
            asset = readback.get('asset')
            if not isinstance(asset, dict) or asset.get('mimeType') != 'video/mp4' \
                or asset.get('isPublic') is not False or asset.get('isModelGenerated') is not True:
                raise RuntimeError('NATIVE_TASK_ASSET_INVALID')
            owner_email = readback['owner']['email']
            secrets.append(owner_email)
            if not isinstance(asset.get('assetId'), str):
                raise RuntimeError('NATIVE_TASK_ASSET_ID_MISSING')
            secrets.append(asset['assetId'])

            stage = 'capture_exact_native_asset_get'
            native_url, asset_context, session_bundle, browser_capture = native_asset_capture(page, context, guard, asset)
            secrets.append(native_url)
            secrets.append(asset_context['cookies'][0]['value'])
            secrets.append(session_bundle['origins'][0]['cookies'][0]['value'])
            packet = {
                'assetId': asset['assetId'],
                'assetRequestContext': asset_context,
                'browserCapture': browser_capture,
                'expectedIdentity': owner_email,
                'outputName': f"video-direct-01-readback-{uuid.uuid4().hex[:8]}.mp4",
                'promptLength': intent['promptLength'],
                'sessionBundle': session_bundle,
                'sourceRunPath': source_path.relative_to(REPO).as_posix(),
                'sourceRunSha256': source_run_sha,
                'sourceSnapshotSha256': snapshot['digest'],
            }
            stage = 'direct_read_only_asset_download'
            raw = bytearray(json.dumps(packet, separators=(',', ':'), ensure_ascii=False).encode('utf-8'))
            if len(raw) > 256 * 1024:
                raise RuntimeError('NODE_PACKET_SIZE_LIMIT')
            env = {key: value for key, value in os.environ.items()
                if key in {'PATH', 'HOME', 'LANG', 'LC_ALL', 'TMPDIR', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'REQUESTS_CA_BUNDLE'}}
            env['GROK_CHROME_PYTHON'] = '/home/worker/work/web-api-playbook-inpock-20261004/.venv-oliveyoung/bin/python'
            env['GROK_CURRENT_OWNER_PROOF_PATH'] = 'verification/grok-feature-live-receipts/auth-owner.read.json'
            completed = subprocess.run([NODE, str(NODE_RUNNER)], cwd=str(REPO), input=bytes(raw),
                stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, env=env, timeout=180, check=False)
            for index in range(len(raw)):
                raw[index] = 0
            if len(completed.stdout) > 16 * 1024:
                raise RuntimeError('NODE_RESULT_SIZE_LIMIT')
            try:
                result = json.loads(completed.stdout.decode('utf-8'))
            except Exception:
                raise RuntimeError('NODE_RESULT_INVALID')
            if completed.returncode != 0 or result.get('status') != 'verified':
                code = result.get('errorCode') if isinstance(result.get('errorCode'), str) else 'ASSET_READBACK_FAILED'
                if isinstance(result.get('stage'), str) and re.fullmatch(r'[a-z][a-z0-9_]{1,63}', result['stage']):
                    stage = 'node_' + result['stage']
                read_failure = {
                    'operationId': result.get('operationId') if isinstance(result.get('operationId'), str)
                        and re.fullmatch(r'[a-z][a-z0-9._-]{0,95}', result['operationId']) else None,
                    'httpStatus': result.get('httpStatus') if isinstance(result.get('httpStatus'), int)
                        and 100 <= result['httpStatus'] <= 599 else None,
                    'directReadMayHaveStarted': result.get('directReadMayHaveStarted') is True,
                }
                raise RuntimeError(code)

            stage = 'restore_owned_page_and_quiet_window'
            guard.mark_task_terminal('completed')
            guard_receipt = guard.close_read_only_after_quiescence()
            if guard_receipt.get('cleanPageRestored') is not True or guard_receipt.get('browserServerWritesDelivered') != 0:
                raise RuntimeError('MEDIA_GUARD_CLOSE_UNVERIFIED')
            if guard_receipt.get('assetBrowserRequests', [{}])[0].get('requestCount') != 1:
                raise RuntimeError('NATIVE_ASSET_CAPTURE_COUNT_INVALID')
            print(json.dumps(safe_output(result), separators=(',', ':')), flush=True)
            return 0
    except Exception as error:
        code = error.args[0] if error.args and isinstance(error.args[0], str) and re.fullmatch(r'[A-Z][A-Z0-9_]{0,63}', error.args[0]) else 'VIDEO_ASSET_READBACK_FAILED'
        print(json.dumps({'schemaVersion': 1, 'status': 'failed', 'stage': stage, 'errorCode': code,
            'sourceSnapshotSha256': snapshot.get('digest'), **read_failure}, separators=(',', ':')), flush=True)
        return 1
    finally:
        if guard is not None and getattr(guard, 'active', False):
            try:
                guard.mark_task_terminal('needs_review')
                guard.close_read_only_after_quiescence()
            except Exception:
                pass
        for value in secrets:
            if isinstance(value, str):
                value = ''


if __name__ == '__main__':
    raise SystemExit(main())
