#!/usr/bin/env python3
"""Verify one exact Gemini video asset through a task-bound, cookie-scoped direct HTTP download."""

import importlib.util
import json
import os
import pathlib
import re
import shutil
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
HISTORY_RECEIPT_PATH = REPO / 'discovery/media-browser-readback-2026-10-06.json'
API_RECEIPT_PATH = REPO / 'discovery/media-api-readback-2026-10-06.json'
RECEIPT_PATH = REPO / 'discovery/media-asset-verify-2026-10-06.json'
SERVICE_ORIGIN = 'https://gemini.google.com'
MEDIA_ROLE = 'codex-gemini-media-20261006'
NODE = '/home/worker/.npm/_npx/387698761821791d/node_modules/node/bin/node'
NODE_DETAIL_SCRIPT = REPO / 'scripts/gemini-media-history-api-readback-once.mjs'
NODE_MEDIA_SCRIPT = REPO / 'scripts/gemini-media-download-once.mjs'
ARTIFACT_ROOT = pathlib.Path.home() / 'artifacts/gemini-media-20261006'
PREVIOUS_BROWSER_ARTIFACT = ARTIFACT_ROOT / 'gemini-video-neutral-geometry-20261006.mp4'
DIRECT_ARTIFACT_NAME = 'gemini-video-neutral-geometry-20261006.direct-http-authenticated.mp4'
EXPECTED_VIDEO_ORIGIN = 'https://contribution.usercontent.google.com'
EXPECTED_VIDEO_PATH_FAMILY = '/download'
EXPECTED_VIDEO_QUERY_KEYS = ['c', 'filename', 'opi']
MAX_DIRECT_DETAIL_READS = 1

sys.dont_write_bytecode = True
_api_spec = importlib.util.spec_from_file_location('gemini_media_api_readback', REPO / 'scripts/gemini-media-history-api-readback-once.py')
_api = importlib.util.module_from_spec(_api_spec)
_api_spec.loader.exec_module(_api)
_history_spec = importlib.util.spec_from_file_location('gemini_history_readback_helpers', REPO / 'scripts/media-history-readback-once.py')
_history = importlib.util.module_from_spec(_history_spec)
_history_spec.loader.exec_module(_history)


class SafeFailure(Exception):
    def __init__(self, code):
        self.code = code


def safe_url_ref(raw_url):
    parsed = urllib.parse.urlsplit(raw_url)
    if parsed.scheme != 'https' or not parsed.hostname or parsed.username or parsed.password or parsed.fragment:
        return None
    path = '/'.join('{id}' if len(segment) > 40 or re.fullmatch(r'[0-9a-f-]{16,}', segment, re.I)
                    else segment for segment in parsed.path.split('/'))
    return {
        'origin': parsed.scheme + '://' + parsed.netloc,
        'pathFamily': path,
        'queryKeyNames': sorted({key for key, _ in urllib.parse.parse_qsl(parsed.query, keep_blank_values=True)}),
    }


def cookie_domain_matches(cookie_domain, host):
    if not isinstance(cookie_domain, str) or not cookie_domain:
        return False
    normalized = cookie_domain.lower().lstrip('.')
    host = host.lower()
    return host == normalized or host.endswith('.' + normalized)


def cookie_path_matches(cookie_path, request_path):
    if not isinstance(cookie_path, str) or not cookie_path.startswith('/'):
        return False
    if request_path == cookie_path:
        return True
    prefix = cookie_path if cookie_path.endswith('/') else cookie_path + '/'
    return request_path.startswith(prefix)


def cookie_names_from_header(value):
    names = []
    for item in str(value or '').split(';'):
        if '=' not in item:
            continue
        name = item.split('=', 1)[0].strip()
        if name:
            names.append(name)
    return sorted(set(names))


def write_receipt(receipt):
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


def run_node(script, envelope, timeout=150):
    if not pathlib.Path(NODE).is_file():
        raise SafeFailure('NODE_RUNTIME_MISSING')
    completed = subprocess.run(
        [NODE, str(script)], input=json.dumps(envelope), text=True,
        capture_output=True, timeout=timeout, check=False,
    )
    if not completed.stdout:
        raise SafeFailure('DIRECT_HTTP_CHILD_NO_OUTPUT')
    try:
        result = json.loads(completed.stdout)
    except Exception as exc:
        raise SafeFailure('DIRECT_HTTP_CHILD_OUTPUT_INVALID') from exc
    return result, completed.returncode


def one_video_candidate(direct_result):
    candidates = direct_result.get('candidates') if isinstance(direct_result, dict) else None
    if not isinstance(candidates, list) or len(candidates) != 1:
        raise SafeFailure('VIDEO_TASK_DETAIL_CANDIDATE_COUNT_INVALID')
    item = candidates[0]
    if (item.get('timeWindowHint') != 'video'
            or item.get('matchedTaskCapabilities') != ['video']
            or item.get('exactTaskPromptHashMatched') is not True
            or item.get('routeBindingVerified') is not True
            or item.get('apiIdEchoedInDetail') is not True
            or item.get('httpStatus') != 200
            or item.get('rawApiIdUsedInRequest') is not True
            or item.get('prefixRemovedFromRequest') is not False):
        raise SafeFailure('VIDEO_TASK_DIRECT_DETAIL_UNVERIFIED')
    raw_url = item.pop('privateAssetUrl', None)
    ref = safe_url_ref(raw_url or '') if raw_url else None
    if (not ref or ref['origin'] != EXPECTED_VIDEO_ORIGIN
            or ref['pathFamily'] != EXPECTED_VIDEO_PATH_FAMILY
            or ref['queryKeyNames'] != EXPECTED_VIDEO_QUERY_KEYS):
        raise SafeFailure('VIDEO_TASK_ASSET_URL_CONTRACT_MISMATCH')
    return item, raw_url, ref


def capture_native_asset_get(raw_asset_url):
    owner = json.loads(OWNER_PATH.read_text())
    roles = json.loads(ROLE_PATH.read_text())
    role = roles.get('activePageRoles', {}).get(MEDIA_ROLE)
    if (owner.get('taskOwned') is not True or owner.get('mode') != 'cdp_discovery_after_native_bootstrap'
            or not isinstance(role, dict) or role.get('origin') != SERVICE_ORIGIN or role.get('exactMarkerCount') != 1):
        raise SafeFailure('OWNED_MEDIA_RUNTIME_NOT_VERIFIED')
    owner_pid = owner.get('chromePid')
    supervisor_pid = owner.get('supervisorPid')
    port = owner.get('cdpPort')
    if not all(isinstance(value, int) for value in (owner_pid, supervisor_pid, port)):
        raise SafeFailure('OWNED_MEDIA_RUNTIME_INVALID')
    try:
        os.kill(owner_pid, 0)
        os.kill(supervisor_pid, 0)
    except Exception as exc:
        raise SafeFailure('OWNED_MEDIA_RUNTIME_NOT_ALIVE') from exc
    owner_profile = pathlib.Path(owner.get('profile', '')).resolve()
    command_line = pathlib.Path(f'/proc/{owner_pid}/cmdline').read_bytes().decode('utf-8', 'replace').split('\0')
    if f'--user-data-dir={owner_profile}' not in command_line or f'--remote-debugging-port={port}' not in command_line:
        raise SafeFailure('OWNED_MEDIA_PROFILE_MISMATCH')
    expected_ref = safe_url_ref(raw_asset_url)
    if not expected_ref or expected_ref['origin'] != EXPECTED_VIDEO_ORIGIN:
        raise SafeFailure('VIDEO_ASSET_HOST_NOT_EXACT')
    state = {
        'sourceRequestId': None,
        'sourceRequestSeen': False,
        'requestMethod': None,
        'requestHeaderNames': set(),
        'cookieHeaderNames': set(),
        'cookieHeaderPresent': False,
        'sourceCookieHeadersCaptured': False,
        'earlyExtraHeaders': {},
        'responseStatus': None,
        'responseMime': None,
        'responseBytes': None,
        'responseHeaderNames': [],
        'redirectEdges': [],
    }
    cookies_for_asset = None
    with sync_playwright() as playwright:
        browser = playwright.chromium.connect_over_cdp(f'http://127.0.0.1:{port}')
        if len(browser.contexts) != 1:
            raise SafeFailure('OWNED_CONTEXT_COUNT_INVALID')
        context = browser.contexts[0]
        page_matches = []
        for page in context.pages:
            try:
                marker = page.evaluate('() => window.name')
                parsed = urllib.parse.urlsplit(page.url)
                if marker == MEDIA_ROLE and parsed.scheme == 'https' and parsed.hostname == 'gemini.google.com':
                    page_matches.append(page)
            except Exception:
                continue
        if len(page_matches) != 1:
            raise SafeFailure('MEDIA_PAGE_ROLE_NOT_UNIQUE')
        page = page_matches[0]
        if urllib.parse.urlsplit(page.url).path != '/app':
            raise SafeFailure('MEDIA_PAGE_NOT_AT_APP')

        cdp = context.new_cdp_session(page)
        cdp.send('Network.enable')
        cdp.send('Network.setCacheDisabled', {'cacheDisabled': True})
        cdp.send('Fetch.enable', {'patterns': [{'urlPattern': '*', 'requestStage': 'Request'}]})

        def summarize_extra_headers(headers):
            normalized = {str(key).lower(): str(value) for key, value in (headers or {}).items()}
            cookie_header = normalized.get('cookie')
            return {
                'headerNames': sorted(normalized),
                'cookieHeaderPresent': cookie_header is not None,
                'cookieNames': cookie_names_from_header(cookie_header),
            }

        def capture_extra_headers(summary):
            state['requestHeaderNames'].update(summary.get('headerNames', []))
            state['cookieHeaderPresent'] = summary.get('cookieHeaderPresent') is True
            state['cookieHeaderNames'].update(summary.get('cookieNames', []))

        def on_request(event):
            request = event.get('request') or {}
            request_url = str(request.get('url', ''))
            request_id = event.get('requestId')
            method = str(request.get('method', 'GET')).upper()
            parsed = urllib.parse.urlsplit(request_url)
            redirect = event.get('redirectResponse')
            if isinstance(redirect, dict) and isinstance(redirect.get('url'), str):
                if request_id == state.get('sourceRequestId') or redirect['url'] == raw_asset_url:
                    from_ref = safe_url_ref(redirect['url'])
                    to_ref = safe_url_ref(request_url)
                    if from_ref and to_ref:
                        state['redirectEdges'].append({
                            'httpStatus': redirect.get('status'),
                            'from': from_ref,
                            'to': to_ref,
                        })
            if request_url == raw_asset_url and method == 'GET':
                state['sourceRequestId'] = request_id
                state['sourceRequestSeen'] = True
                state['requestMethod'] = method
                state['requestHeaderNames'].update(str(key).lower() for key in (request.get('headers') or {}))
                early = state['earlyExtraHeaders'].get(request_id)
                if early is not None and not state['sourceCookieHeadersCaptured']:
                    capture_extra_headers(early)
                    state['sourceCookieHeadersCaptured'] = True

        def on_extra(event):
            request_id = event.get('requestId')
            summary = summarize_extra_headers(event.get('headers') or {})
            if request_id != state.get('sourceRequestId'):
                state['earlyExtraHeaders'][request_id] = summary
                return
            if state['sourceCookieHeadersCaptured']:
                return
            capture_extra_headers(summary)
            state['sourceCookieHeadersCaptured'] = True

        def on_response(event):
            if event.get('requestId') != state.get('sourceRequestId'):
                return
            response = event.get('response') or {}
            state['responseStatus'] = response.get('status')
            state['responseMime'] = str(response.get('mimeType', '')).split(';', 1)[0].strip().lower()
            state['responseBytes'] = response.get('encodedDataLength')
            state['responseHeaderNames'] = sorted(str(key).lower() for key in (response.get('headers') or {}))

        def on_paused(event):
            request = event.get('request') or {}
            request_id = event.get('requestId')
            method = str(request.get('method', 'GET')).upper()
            url = str(request.get('url', ''))
            if url == raw_asset_url and method == 'GET':
                state['requestHeaderNames'].update(str(key).lower() for key in (request.get('headers') or {}))
                cdp.send('Fetch.continueRequest', {'requestId': request_id})
                return
            if method in ('GET', 'HEAD', 'OPTIONS'):
                cdp.send('Fetch.continueRequest', {'requestId': request_id})
                return
            cdp.send('Fetch.failRequest', {'requestId': request_id, 'errorReason': 'BlockedByClient'})

        cdp.on('Network.requestWillBeSent', on_request)
        cdp.on('Network.requestWillBeSentExtraInfo', on_extra)
        cdp.on('Network.responseReceived', on_response)
        cdp.on('Fetch.requestPaused', on_paused)
        page.evaluate('''url => new Promise(resolve => {
          const element = document.createElement('video');
          element.preload = 'metadata';
          element.muted = true;
          element.style.position = 'fixed';
          element.style.width = '1px';
          element.style.height = '1px';
          element.style.opacity = '0';
          let settled = false;
          const finish = value => {
            if (settled) return;
            settled = true;
            element.remove();
            resolve(value);
          };
          element.addEventListener('loadedmetadata', () => finish('metadata'), { once: true });
          element.addEventListener('error', () => finish('error'), { once: true });
          document.body.appendChild(element);
          element.src = url;
          element.load();
          setTimeout(() => finish('timeout'), 12000);
        })''', raw_asset_url)
        page.wait_for_timeout(1200)
        if not state['sourceRequestSeen'] or not state['responseStatus']:
            try:
                cdp.send('Fetch.disable')
                cdp.send('Network.disable')
                cdp.detach()
            except Exception:
                pass
            raise SafeFailure('TASK_NATIVE_ASSET_GET_NOT_OBSERVED')
        # This is the single asset-origin cookie acquisition authorized for this workflow.
        cookies_for_asset = context.cookies([raw_asset_url])
        try:
            cdp.send('Fetch.disable')
            cdp.send('Network.disable')
            cdp.detach()
        except Exception:
            pass
    parsed = urllib.parse.urlsplit(raw_asset_url)
    applicable = []
    now = datetime.now(timezone.utc).timestamp()
    for cookie in cookies_for_asset or []:
        if (cookie.get('name') not in state['cookieHeaderNames']
                or not cookie_domain_matches(cookie.get('domain'), parsed.hostname or '')
                or not cookie_path_matches(cookie.get('path'), parsed.path)):
            continue
        expires = cookie.get('expires')
        if isinstance(expires, (int, float)) and expires > 0 and expires <= now:
            continue
        applicable.append({
            'name': cookie.get('name'),
            'value': cookie.get('value'),
            'domain': cookie.get('domain'),
            'path': cookie.get('path'),
            'secure': cookie.get('secure'),
            'expires': expires,
            'sameSite': cookie.get('sameSite'),
        })
    applicable_names = sorted({item['name'] for item in applicable if item.get('value') is not None})
    if applicable_names != sorted(state['cookieHeaderNames']):
        raise SafeFailure('NATIVE_COOKIE_DOMAIN_SCOPE_MISMATCH')
    ref = safe_url_ref(raw_asset_url)
    redirects = state['redirectEdges'][:3]
    redirect_origins = sorted({edge['to']['origin'] for edge in redirects
                               if edge.get('to', {}).get('origin') and edge['to']['origin'] != ref['origin']})
    observed = {
        'exactUrlMatched': True,
        'method': state['requestMethod'],
        'origin': ref['origin'],
        'pathFamily': ref['pathFamily'],
        'queryKeyNames': ref['queryKeyNames'],
        'httpStatus': state['responseStatus'],
        'mime': state['responseMime'],
        'capability': 'video',
        'headerNames': sorted(state['requestHeaderNames']),
        'responseHeaderNames': state['responseHeaderNames'],
        'cookieHeaderPresent': state['cookieHeaderPresent'],
        'cookieNames': sorted(state['cookieHeaderNames']),
        'responseBytes': state['responseBytes'],
        'usedNetworkResponseBody': False,
    }
    return observed, applicable, redirects, redirect_origins


def main():
    if RECEIPT_PATH.exists():
        raise SafeFailure('RECEIPT_ALREADY_EXISTS')
    owner = json.loads(OWNER_PATH.read_text())
    roles = json.loads(ROLE_PATH.read_text())
    contract = json.loads(CONTRACT_PATH.read_text())
    expected_owner, session, bootstrap, visible_route_ids = _api.capture_transient_session_and_list_context(contract, owner, roles)
    goal = _history.load_task_goals().get('video')
    if not goal:
        raise SafeFailure('VIDEO_DISPATCH_WINDOW_MISSING')
    asset_inputs = _api.observed_asset_inputs()
    envelope = {
        'session': session,
        'expectedOwner': expected_owner,
        'windows': {'video': {'start': goal['windowStart'], 'end': goal['windowEnd'], 'midpoint': goal['goalEpoch']}},
        'visibleRouteIds': visible_route_ids,
        **asset_inputs,
        'maxDetailReads': MAX_DIRECT_DETAIL_READS,
        'allowPrivateAssetUrlPipe': True,
        'skipAssetFetch': True,
    }
    direct_detail, return_code = run_node(NODE_DETAIL_SCRIPT, envelope)
    if return_code != 0 or direct_detail.get('phase') != 'direct_http_history_readback':
        raise SafeFailure('VIDEO_DIRECT_DETAIL_FAILED')
    detail, raw_asset_url, raw_asset_ref = one_video_candidate(direct_detail)
    native_get, scoped_cookies, redirect_edges, redirect_origins = capture_native_asset_get(raw_asset_url)
    if native_get.get('mime') != 'video/mp4':
        raise SafeFailure('NATIVE_VIDEO_MIME_MISMATCH')
    allowed_origins = sorted({raw_asset_ref['origin'], *redirect_origins})
    asset_envelope = {
        'url': raw_asset_url,
        'capability': 'video',
        'observedNativeRequest': native_get,
        'cookieCookies': scoped_cookies,
        'observedRedirectEdges': redirect_edges,
        'allowedOrigins': allowed_origins,
        'artifactRoot': str(ARTIFACT_ROOT),
        'artifactName': DIRECT_ARTIFACT_NAME,
        'previousArtifactPath': str(PREVIOUS_BROWSER_ARTIFACT),
    }
    downloaded, asset_return_code = run_node(NODE_MEDIA_SCRIPT, asset_envelope)
    if asset_return_code != 0:
        downloaded.setdefault('status', 'direct_http_media_download_failed')
    # Strip the one-time URL before constructing any persisted or user-visible object.
    safe_direct_detail = {key: value for key, value in direct_detail.items() if key != 'candidates'}
    safe_direct_detail['candidate'] = detail
    receipt = {
        'schema': 'gemini-media-asset-verification-v1',
        'service': 'gemini-web',
        'operation': 'history_read_plus_media_download',
        'recordedAt': datetime.now(timezone.utc).isoformat(),
        'priorPhases': {
            'uiDetailReadCount': 5,
            'directHttpDetailReadCount': 2,
            'priorVideoArtifactSource': 'browser_network',
            'priorUiReceiptPath': str(HISTORY_RECEIPT_PATH.resolve()),
            'priorDirectHttpReceiptPath': str(API_RECEIPT_PATH.resolve()),
        },
        'thisPhase': {
            'authorizedAdditionalVideoDetailReads': MAX_DIRECT_DETAIL_READS,
            'actualDirectVideoDetailReads': 1,
            'browserDetailReads': 0,
            'directHistoryList': (direct_detail.get('directHistoryList') or {}),
            'videoTaskDirectDetail': detail,
            'nativeAssetGetDiscovery': {
                **native_get,
                'cookieDomainScopes': [
                    {key: cookie.get(key) for key in ('name', 'domain', 'path', 'secure', 'sameSite')}
                    for cookie in scoped_cookies
                ],
                'redirectEdges': redirect_edges,
                'networkResponseBodyRead': False,
            },
            'directHttpAssetDownload': downloaded,
        },
        'overallDetailReadAccounting': {
            'priorUiDetailReads': 5,
            'priorDirectHttpDetailReads': 2,
            'thisPhaseDirectHttpDetailReads': 1,
            'totalDetailReads': 8,
        },
        'persistence': {
            'rawConversationIdsPersisted': False,
            'signedAssetUrlPersisted': False,
            'cookieValuesPersisted': False,
            'authorizationHeaderValuesPersisted': False,
            'rawResponseBodiesPersisted': False,
            'networkResponseBodyReadByBrowser': False,
        },
    }
    write_receipt(receipt)
    print(json.dumps({
        'status': downloaded.get('status'),
        'ownerMatched': direct_detail.get('ownerMatched'),
        'anonymousOwnerAbsent': direct_detail.get('anonymousOwnerAbsent'),
        'nativeGet': {key: native_get.get(key) for key in ('origin', 'pathFamily', 'queryKeyNames', 'httpStatus', 'mime', 'cookieNames', 'headerNames')},
        'directHttpAssetDownload': downloaded,
        'receiptPath': str(RECEIPT_PATH.resolve()),
    }, ensure_ascii=False))
    return 0 if downloaded.get('status') == 'verified' else 3


if __name__ == '__main__':
    try:
        raise SystemExit(main())
    except SafeFailure as error:
        print(json.dumps({'status': 'stopped', 'code': error.code}, ensure_ascii=False))
        raise SystemExit(2)
    except Exception as error:
        print(json.dumps({'status': 'stopped', 'code': 'MEDIA_ASSET_VERIFY_FAILED',
                          'errorClass': type(error).__name__}, ensure_ascii=False))
        raise SystemExit(2)
