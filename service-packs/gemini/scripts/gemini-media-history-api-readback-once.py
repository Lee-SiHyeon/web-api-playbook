#!/usr/bin/env python3
"""Capture a transient Gemini session, then read only the two known media tasks over direct HTTP."""

import hashlib
import importlib.util
import json
import os
import pathlib
import re
import shutil
import socket
import subprocess
import sys
import urllib.parse
from datetime import datetime, timezone

from playwright.sync_api import sync_playwright


REPO = pathlib.Path(__file__).resolve().parent.parent
RUNTIME = pathlib.Path.home() / '.nad-scratch/provider-runtime-20261005'
OWNER_PATH = RUNTIME / 'runtime-owner.json'
ROLE_PATH = RUNTIME / 'page-role-registry.json'
CONTRACT_PATH = REPO / 'discovery/observed-contract.json'
MEDIA_RECEIPT_PATH = REPO / 'discovery/media-browser-readback-2026-10-06.json'
RECEIPT_PATH = REPO / 'discovery/media-api-readback-2026-10-06.json'
SERVICE_ORIGIN = 'https://gemini.google.com'
GEMINI_MEDIA_ROLE = 'codex-gemini-media-20261006'
GROK_CORE_ROLE = 'codex-grok-core-20261006'
GROK_OWNER_HASH = '23e57131977ce522bacf6649eb27538770828a890f7a65589ec4f0960a84b3d7'
NODE = '/home/worker/.npm/_npx/387698761821791d/node_modules/node/bin/node'
NODE_SCRIPT = REPO / 'scripts/gemini-media-history-api-readback-once.mjs'
MAX_DIRECT_DETAILS = 2

sys.dont_write_bytecode = True
_smoke_spec = importlib.util.spec_from_file_location('gemini_text_smoke_helpers', REPO / 'scripts/run-linux-text-smoke.py')
_smoke = importlib.util.module_from_spec(_smoke_spec)
_smoke_spec.loader.exec_module(_smoke)
_history_spec = importlib.util.spec_from_file_location('gemini_history_readback_helpers', REPO / 'scripts/media-history-readback-once.py')
_history = importlib.util.module_from_spec(_history_spec)
_history_spec.loader.exec_module(_history)


class SafeFailure(Exception):
    def __init__(self, code):
        self.code = code


def header_subset(headers, allowed_names):
    allowed = {str(name).lower() for name in allowed_names}
    forbidden = {'cookie', 'authorization', 'proxy-authorization', 'host', 'content-length'}
    normalized = {str(name).lower(): str(value) for name, value in headers.items()}
    return {name: normalized[name] for name in sorted(allowed - forbidden) if name in normalized}


def rpc_ids(url, body):
    parsed = urllib.parse.urlsplit(url)
    values = urllib.parse.parse_qs(parsed.query, keep_blank_values=True).get('rpcids', [])
    try:
        form = urllib.parse.parse_qs(body or '', keep_blank_values=True)
        outer = json.loads(form.get('f.req', [''])[0])
        inner = json.loads(outer[1]) if isinstance(outer, list) and len(outer) == 2 and outer[0] is None and isinstance(outer[1], str) else outer
        found = []
        def walk(value, depth=0):
            if depth > 24:
                return
            if isinstance(value, list):
                if len(value) >= 4 and isinstance(value[0], str) and value[3] == 'generic':
                    found.append(value[0])
                for item in value:
                    walk(item, depth + 1)
            elif isinstance(value, dict):
                for item in value.values():
                    walk(item, depth + 1)
        walk(inner)
        return sorted(set(values + found))
    except Exception:
        return values


def history_list_args(body, expected_rpc_id):
    form = urllib.parse.parse_qs(body or '', keep_blank_values=True)
    outer = json.loads(form.get('f.req', [''])[0])
    inner = json.loads(outer[1]) if isinstance(outer, list) and len(outer) == 2 and outer[0] is None and isinstance(outer[1], str) else outer
    found = []
    def walk(value, depth=0):
        if depth > 24:
            return
        if isinstance(value, list):
            if len(value) >= 4 and value[0] == expected_rpc_id and value[3] == 'generic':
                args = value[1]
                if isinstance(args, str):
                    args = json.loads(args)
                found.append(args)
            for item in value:
                walk(item, depth + 1)
        elif isinstance(value, dict):
            for item in value.values():
                walk(item, depth + 1)
    walk(inner)
    if len(found) != 1 or not isinstance(found[0], list) or len(found[0]) != 3:
        raise SafeFailure('HISTORY_LIST_TEMPLATE_INVALID')
    return found[0]


def path_family(path):
    return '/'.join('{id}' if len(part) > 40 or re.fullmatch(r'[0-9a-f-]{16,}', part, re.I) else part
                    for part in path.split('/'))


def write_safe_receipt(receipt):
    temp = RECEIPT_PATH.with_name(RECEIPT_PATH.name + f'.{os.getpid()}.tmp')
    descriptor = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        with os.fdopen(descriptor, 'w', encoding='utf-8') as stream:
            json.dump(receipt, stream, ensure_ascii=False, indent=2)
            stream.write('\n')
        os.replace(temp, RECEIPT_PATH)
    except Exception:
        try:
            temp.unlink(missing_ok=True)
        except Exception:
            pass
        raise


def observed_asset_inputs():
    try:
        prior = json.loads(MEDIA_RECEIPT_PATH.read_text())
    except Exception:
        return {'cdpObservedAssetOrigins': {'image': [], 'video': []},
                'preferredAssetOrigin': {}, 'cdpRedirectOrigins': {'image': [], 'video': []}}
    origins = {'image': set(), 'video': set()}
    preferred = {}
    redirects = {'image': set(), 'video': set()}
    for result in prior.get('candidateReads', []):
        for task in result.get('taskReadbacks', []):
            capability = task.get('capability')
            if capability not in origins:
                continue
            selected = task.get('selectedAssetReference')
            if isinstance(selected, dict) and isinstance(selected.get('origin'), str):
                origins[capability].add(selected['origin'])
                preferred.setdefault(capability, selected['origin'])
            for ref in task.get('taskMediaReferences', []):
                if isinstance(ref, dict) and isinstance(ref.get('origin'), str):
                    origins[capability].add(ref['origin'])
            fetch = task.get('artifactReadback') or {}
            for redirect in fetch.get('redirects', []) if isinstance(fetch, dict) else []:
                if isinstance(redirect, dict) and isinstance(redirect.get('origin'), str):
                    redirects[capability].add(redirect['origin'])
    return {
        'cdpObservedAssetOrigins': {cap: sorted(values) for cap, values in origins.items()},
        'preferredAssetOrigin': preferred,
        'cdpRedirectOrigins': {cap: sorted(values) for cap, values in redirects.items()},
    }


def prior_browser_readback_phase():
    try:
        prior = json.loads(MEDIA_RECEIPT_PATH.read_text())
    except Exception:
        return {'receiptAvailable': False, 'detailReadCount': None, 'verifiedArtifactCount': 0}
    selection = prior.get('candidateSelection') or {}
    verified = prior.get('verifiedArtifacts') or []
    video_sources = []
    for candidate in prior.get('candidateReads', []):
        for task in candidate.get('taskReadbacks', []):
            if task.get('capability') == 'video':
                fetch = task.get('artifactReadback') or {}
                if isinstance(fetch, dict):
                    video_sources.append(fetch.get('source'))
    return {
        'receiptAvailable': True,
        'detailReadCount': selection.get('totalDetailReadCountWithinAuthorization'),
        'verifiedArtifactCount': len(verified),
        'videoArtifactSource': next((source for source in video_sources if source), None),
        'imageArtifactVerified': any(item.get('capability') == 'image' for item in verified if isinstance(item, dict)),
        'receiptPath': str(MEDIA_RECEIPT_PATH.resolve()),
    }


def capture_transient_session_and_list_context(contract, owner, roles):
    pid = owner.get('chromePid')
    port = owner.get('cdpPort')
    if (owner.get('taskOwned') is not True or owner.get('mode') != 'cdp_discovery_after_native_bootstrap'
            or not isinstance(pid, int) or not isinstance(port, int)):
        raise SafeFailure('OWNED_RUNTIME_INVALID')
    supervisor = owner.get('supervisorPid')
    if not isinstance(supervisor, int):
        raise SafeFailure('OWNED_SUPERVISOR_INVALID')
    try:
        os.kill(pid, 0)
        os.kill(supervisor, 0)
        with socket.create_connection(('127.0.0.1', port), timeout=1):
            pass
    except Exception as exc:
        raise SafeFailure('OWNED_CDP_RUNTIME_UNAVAILABLE') from exc
    profile = pathlib.Path(owner.get('profile', '')).resolve()
    process_cmdline = pathlib.Path(f'/proc/{pid}/cmdline').read_bytes().decode('utf-8', 'replace').split('\0')
    if f'--user-data-dir={profile}' not in process_cmdline or f'--remote-debugging-port={port}' not in process_cmdline:
        raise SafeFailure('OWNED_RUNTIME_MISMATCH')
    role = roles.get('activePageRoles', {}).get(GEMINI_MEDIA_ROLE)
    if (not isinstance(role, dict) or role.get('origin') != SERVICE_ORIGIN or role.get('exactMarkerCount') != 1):
        raise SafeFailure('MEDIA_PAGE_ROLE_NOT_UNIQUE')
    allowed_cookie_names = set(contract['auth']['cookieNames'])
    history_op = contract['operations']['history_list']
    read_op = contract['operations']['history_read']
    identity_op = contract['operations']['identity']
    captured = {
        'contextRequest': None, 'contextResponse': None, 'blockedDetailCount': 0,
        'bodyTargets': {}, 'networkInfo': {}, 'fetchPausedCount': 0,
        'networkRequestCount': 0, 'geminiPostCount': 0, 'observedRpcIds': set(),
    }

    with sync_playwright() as playwright:
        browser = playwright.chromium.connect_over_cdp(f'http://127.0.0.1:{port}')
        if len(browser.contexts) != 1:
            raise SafeFailure('OWNED_CONTEXT_COUNT_INVALID')
        context = browser.contexts[0]
        page_matches = []
        grok_matches = []
        for page in context.pages:
            try:
                marker = page.evaluate('() => window.name')
                url = urllib.parse.urlsplit(page.url)
                if marker == GEMINI_MEDIA_ROLE and url.scheme == 'https' and url.hostname == 'gemini.google.com':
                    page_matches.append(page)
                elif marker == GROK_CORE_ROLE and url.scheme == 'https' and url.hostname == 'grok.com':
                    grok_matches.append(page)
            except Exception:
                continue
        if len(page_matches) != 1 or len(grok_matches) != 1:
            raise SafeFailure('OWNED_PAGE_ROLE_NOT_UNIQUE')
        page = page_matches[0]
        expected_owner_hash, _source_hash = _smoke.read_static_owner_hash()
        if expected_owner_hash != GROK_OWNER_HASH:
            raise SafeFailure('EXPECTED_OWNER_HASH_CHANGED')
        expected_owner = _smoke.read_grok_owner(grok_matches[0], expected_owner_hash)

        cdp = context.new_cdp_session(page)
        cdp.send('Network.enable')
        cdp.send('Fetch.enable', {'patterns': [{'urlPattern': '*', 'requestStage': 'Request'}]})

        def on_network_request(event):
            captured['networkRequestCount'] += 1
            request = event.get('request') or {}
            url = str(request.get('url', ''))
            parsed = urllib.parse.urlsplit(url)
            request_id = event.get('requestId')
            if request_id:
                captured['networkInfo'][request_id] = {'url': url, 'path': parsed.path}

        def on_network_response(event):
            request_id = event.get('requestId')
            if request_id not in captured['bodyTargets']:
                return
            response = event.get('response') or {}
            captured['contextResponse'] = {
                'status': response.get('status'),
                'mime': str(response.get('mimeType', '')).split(';', 1)[0].strip().lower(),
                'responseBytes': response.get('encodedDataLength'),
            }

        def on_paused(event):
            captured['fetchPausedCount'] += 1
            request = event.get('request') or {}
            url = str(request.get('url', ''))
            parsed = urllib.parse.urlsplit(url)
            request_id = event.get('requestId')
            network_id = event.get('networkId')
            method = str(request.get('method', 'GET')).upper()
            if method in ('GET', 'HEAD', 'OPTIONS'):
                cdp.send('Fetch.continueRequest', {'requestId': request_id})
                return
            if parsed.scheme != 'https' or parsed.hostname != 'gemini.google.com' \
                    or parsed.path != '/_/BardChatUi/data/batchexecute' or method != 'POST':
                cdp.send('Fetch.failRequest', {'requestId': request_id, 'errorReason': 'BlockedByClient'})
                return
            body = str(request.get('postData', ''))
            if not body:
                try:
                    body = cdp.send('Fetch.getRequestPostData', {'requestId': request_id}).get('postData', '')
                except Exception:
                    body = ''
            ids = rpc_ids(url, body)
            if parsed.hostname == 'gemini.google.com' and method == 'POST':
                captured['geminiPostCount'] += 1
            captured['observedRpcIds'].update(ids)
            allowed = bool(ids) and all(rpc_id in _history.media.READ_RPC_IDS for rpc_id in ids)
            if 'hNvQHb' in ids:
                captured['blockedDetailCount'] += 1
            query_pairs = urllib.parse.parse_qsl(parsed.query, keep_blank_values=True)
            form_pairs = urllib.parse.parse_qsl(body, keep_blank_values=True)
            if (allowed and query_pairs and [key for key, _ in query_pairs] == history_op['request']['queryKeys']
                    and [key for key, _ in form_pairs] == history_op['request']['bodyFieldNames']):
                list_args = [28, None, [0, None, 1]]
                if 'MaZiqc' in ids:
                    try:
                        list_args = history_list_args(body, history_op['response']['rpcId'])
                    except SafeFailure:
                        pass
                query_pairs = urllib.parse.parse_qsl(parsed.query, keep_blank_values=True)
                captured['contextRequest'] = {
                    'url': url, 'body': body, 'headers': request.get('headers') or {},
                    'args': list_args, 'rpcIds': ids,
                }
                if network_id:
                    captured['bodyTargets'][network_id] = True
                cdp.send('Fetch.continueRequest', {'requestId': request_id})
                return
            cdp.send('Fetch.failRequest', {'requestId': request_id, 'errorReason': 'BlockedByClient'})

        cdp.on('Network.requestWillBeSent', on_network_request)
        cdp.on('Network.responseReceived', on_network_response)
        cdp.on('Fetch.requestPaused', on_paused)
        try:
            if urllib.parse.urlsplit(page.url).path == '/app':
                page.reload(wait_until='domcontentloaded', timeout=60_000)
            else:
                page.goto(SERVICE_ORIGIN + '/app', wait_until='domcontentloaded', timeout=60_000)
            page.wait_for_timeout(8_000)
        finally:
            try:
                cdp.send('Fetch.disable')
                cdp.send('Network.disable')
            except Exception:
                pass
            try:
                cdp.detach()
            except Exception:
                pass
        if page.evaluate('() => window.name') != GEMINI_MEDIA_ROLE:
            raise SafeFailure('MEDIA_PAGE_MARKER_CHANGED')
        if urllib.parse.urlsplit(page.url).path != '/app':
            raise SafeFailure('MEDIA_PAGE_DID_NOT_RESET_TO_APP')
        if captured.get('failure'):
            raise SafeFailure(captured['failure'])
        history = captured.get('contextRequest')
        response = captured.get('contextResponse')
        if not history:
            print(json.dumps({
                'status': 'bootstrap_observation',
                'fetchPausedCount': captured['fetchPausedCount'],
                'networkRequestCount': captured['networkRequestCount'],
                'geminiPostCount': captured['geminiPostCount'],
                'observedRpcIds': sorted(captured['observedRpcIds']),
                'blockedDetailCount': captured['blockedDetailCount'],
            }, ensure_ascii=False))
            raise SafeFailure('CURRENT_BATCH_CONTEXT_REQUEST_NOT_CAPTURED')
        if not response:
            raise SafeFailure('CURRENT_BATCH_CONTEXT_RESPONSE_NOT_CAPTURED')
        if response.get('status') != 200 or response.get('mime') != 'application/json':
            raise SafeFailure('CURRENT_BATCH_CONTEXT_RESPONSE_INVALID')
        visible_route_ids = _history.visible_app_link_ids(page)
        query = urllib.parse.parse_qs(urllib.parse.urlsplit(history['url']).query, keep_blank_values=True)
        form = urllib.parse.parse_qs(history['body'], keep_blank_values=True)
        cookies = context.cookies([SERVICE_ORIGIN])
        values = {item.get('name'): item.get('value') for item in cookies
                  if item.get('name') in allowed_cookie_names and isinstance(item.get('value'), str)}
        if set(values) != allowed_cookie_names:
            raise SafeFailure('SESSION_COOKIE_ALLOWLIST_INCOMPLETE')
        read_headers = header_subset(history['headers'], read_op['request']['headerNames'])
        list_headers = header_subset(history['headers'], history_op['request']['headerNames'])
        identity_headers = header_subset(captured.get('documentHeaders', {}), identity_op['request']['headerNames'])
        session = {
            'version': 1,
            'service': contract['service'],
            'origin': SERVICE_ORIGIN,
            'capturedAt': datetime.now(timezone.utc).isoformat(),
            'cookies': [{'name': name, 'value': value} for name, value in values.items()],
            'headers': {},
            'requestHeaders': {
                'identity': identity_headers,
                'history_list': list_headers,
                'history_read': read_headers,
            },
            'batchContext': {
                'at': form['at'][0],
                'fSid': query['f.sid'][0],
                'buildLabel': query['bl'][0],
                'locale': query['hl'][0],
                'requestType': query['rt'][0],
                'sourcePath': query['source-path'][0],
                'requestId': query['_reqid'][0],
                'historyListArgs': history['args'],
            },
        }
        safe_context = {
            'uiBatchContextStatus': response['status'],
            'uiBatchContextMime': response['mime'],
            'uiBatchContextResponseBytes': response.get('responseBytes'),
            'uiBatchContextRpcIds': history['rpcIds'],
            'uiBatchContextResponseBodyCaptured': False,
            'headerNames': sorted(read_headers),
            'formFieldNames': [key for key, _ in urllib.parse.parse_qsl(history['body'], keep_blank_values=True)],
            'queryKeyNames': [key for key, _ in urllib.parse.parse_qsl(urllib.parse.urlsplit(history['url']).query, keep_blank_values=True)],
            'blockedBrowserDetailRequests': captured['blockedDetailCount'],
            'visibleHistoryRouteCount': len(visible_route_ids),
        }
        # Session, token, cookie, request values and list body remain only in this process memory.
        return expected_owner, session, safe_context, visible_route_ids


def main():
    if RECEIPT_PATH.exists():
        raise SafeFailure('RECEIPT_ALREADY_EXISTS')
    owner = json.loads(OWNER_PATH.read_text())
    roles = json.loads(ROLE_PATH.read_text())
    contract = json.loads(CONTRACT_PATH.read_text())
    expected_owner, session, bootstrap, visible_route_ids = capture_transient_session_and_list_context(contract, owner, roles)
    goals = _history.load_task_goals()
    if set(goals) != {'image', 'video'}:
        raise SafeFailure('EXPECTED_MEDIA_WINDOWS_MISSING')
    windows = {
        capability: {
            'start': goal['windowStart'],
            'end': goal['windowEnd'],
            'midpoint': goal['goalEpoch'],
        }
        for capability, goal in goals.items()
    }
    asset_inputs = observed_asset_inputs()
    node = NODE if pathlib.Path(NODE).is_file() else shutil.which('node')
    if not node:
        raise SafeFailure('NODE_RUNTIME_MISSING')
    request_envelope = {
        'session': session,
        'expectedOwner': expected_owner,
        'windows': windows,
        'visibleRouteIds': visible_route_ids,
        **asset_inputs,
    }
    child = subprocess.run(
        [node, str(NODE_SCRIPT)],
        input=json.dumps(request_envelope),
        text=True,
        capture_output=True,
        timeout=180,
        check=False,
    )
    if child.returncode != 0 and not child.stdout:
        raise SafeFailure('DIRECT_HTTP_CHILD_FAILED')
    try:
        direct = json.loads(child.stdout)
    except Exception as exc:
        raise SafeFailure('DIRECT_HTTP_CHILD_OUTPUT_INVALID') from exc
    receipt = {
        'schema': 'gemini-media-api-readback-v1',
        'service': 'gemini-web',
        'operation': 'history_read',
        'executionHost': 'linux_worker',
        'readbackTransport': 'direct_https_gemini_web_client',
        'browserUse': {
            'sessionBootstrap': 'owned_profile_gemini_read_only_batch_context',
            'historyDetailReads': 0,
            'artifactResponseBodiesReadByBrowser': False,
            'browserUsedForDetailExecution': False,
        },
        'priorUiReadbackPhase': prior_browser_readback_phase(),
        'browserBootstrap': bootstrap,
        'directHttp': direct,
        'detailReadAccounting': {
            'priorUiDetailReads': prior_browser_readback_phase().get('detailReadCount'),
            'additionalDirectHttpDetailReads': (direct.get('directHistoryList') or {}).get('detailReadCount', 0),
            'directHttpDetailReadLimit': MAX_DIRECT_DETAILS,
        },
        'directAssetCredentialPolicy': 'no cookies or Gemini credentials sent to asset origins',
        'persistence': {
            'credentialsPersisted': False,
            'cookiesPersisted': False,
            'tokensPersisted': False,
            'rawApiIdsPersisted': False,
            'expectedTaskTextPersisted': False,
            'signedUrlValuesPersisted': False,
            'detailResponseBodiesPersisted': False,
        },
        'recordedAt': datetime.now(timezone.utc).isoformat(),
    }
    write_safe_receipt(receipt)
    print(json.dumps({
        'status': direct.get('phase'),
        'ownerMatched': direct.get('ownerMatched'),
        'anonymousOwnerAbsent': direct.get('anonymousOwnerAbsent'),
        'directHistoryList': direct.get('directHistoryList'),
        'candidates': direct.get('candidates', []),
        'receiptPath': str(RECEIPT_PATH.resolve()),
    }, ensure_ascii=False))
    return 0


if __name__ == '__main__':
    try:
        raise SystemExit(main())
    except SafeFailure as error:
        print(json.dumps({'status': 'stopped', 'code': error.code}, ensure_ascii=False))
        raise SystemExit(2)
    except Exception as error:
        print(json.dumps({'status': 'stopped', 'code': 'MEDIA_API_READBACK_FAILED',
                          'errorClass': type(error).__name__}, ensure_ascii=False))
        raise SystemExit(2)
