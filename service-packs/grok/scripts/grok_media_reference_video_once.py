#!/usr/bin/env python3
"""One-shot normal-SDK image-to-video capture and guarded direct submission.

The prompt, private asset identifiers, SSO value, SDK headers, request body and
URLs are accepted or acquired in memory only. The receipt contains hashes,
counts, status, byte proof and duration, never those private values.
"""

import asyncio
import fcntl
import hashlib
import importlib.util
import json
import os
import re
import tempfile
import uuid
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlencode, urlsplit

from playwright.async_api import async_playwright

HOME = Path('/home/worker')
RUNTIME = HOME / '.nad-scratch' / 'provider-runtime-20261005'
REPO = HOME / 'work' / 'provider-login-20261004' / 'grok-web-xhr-client'
ROLE = 'codex-grok-media-20261006'
EXPECTED_OWNER_SHA = '23e57131977ce522bacf6649eb27538770828a890f7a65589ec4f0960a84b3d7'
IMAGE_RECEIPT = REPO / 'verification' / 'grok-media-image-live-2026-10-06.json'
IMAGE_RECONCILIATION = REPO / 'verification' / 'grok-media-readback-reconcile-2026-10-06.json'
VIDEO_READBACK = REPO / 'verification' / 'grok-media-video-readback-2026-10-06.json'
INTENT_FILE = HOME / '.nad-scratch' / 'grok-web-xhr-client' / 'media-intents.json'
OPERATION_FILE = HOME / '.nad-scratch' / 'grok-web-xhr-client' / 'operations.json'
CAPTURE_RECEIPT = REPO / 'verification' / 'grok-media-video-image-reference-capture-2026-10-06.json'
LIVE_RECEIPT = REPO / 'verification' / 'grok-media-video-image-reference-live-2026-10-06.json'
ARTIFACT_ROOT = HOME / 'artifacts' / 'grok-media-20261006'
ARTIFACT_NAME = 'video-image-reference-01.mp4'
NODE = '/home/worker/.local/bin/node'
CFFI_PYTHON = '/home/worker/work/web-api-playbook-inpock-20261004/.venv-oliveyoung/bin/python'
CLI = REPO / 'src' / 'cli.mjs'
SAFE_ORDINARY_HEADERS = {
    'accept', 'accept-language', 'content-type', 'origin', 'referer', 'user-agent',
    'sec-ch-ua', 'sec-ch-ua-mobile', 'sec-ch-ua-platform', 'sec-fetch-dest', 'sec-fetch-mode', 'sec-fetch-site',
}
SAFE_SDK_HEADERS = {'x-statsig-id', 'x-xai-request-id'}
PROMPT_LIMIT = 4000
MAX_CAPTURE_BODY = 64 * 1024
MAX_CHILD_OUTPUT = 2 * 1024 * 1024
RESET_VERIFIED = False
SAVED_UI_STATE = None
FAILURE_DIAGNOSTICS = {}

_guard_spec = importlib.util.spec_from_file_location('grok_media_capture_guard', REPO / 'scripts' / 'grok_media_capture_guard.py')
_guard_module = importlib.util.module_from_spec(_guard_spec)
_guard_spec.loader.exec_module(_guard_module)
explicitly_observed_read = _guard_module.explicitly_observed_read


def sha(value):
    return hashlib.sha256(value.encode('utf-8')).hexdigest()


def now_iso():
    return datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z')


def safe_path_class(url):
    path = urlsplit(url).path
    if path == '/rest/app-chat/conversations/new':
        return 'create-conversation'
    if re.fullmatch(r'/rest/app-chat/conversations/[A-Za-z0-9._~-]{8,256}/responses', path):
        return 'conversation-responses'
    return 'other'


def atomic_receipt(path, value, *, replace=False):
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    if (path.exists() or path.is_symlink()) and not replace:
        raise RuntimeError('RECEIPT_ALREADY_EXISTS')
    fd, tmp = tempfile.mkstemp(prefix=f'.{path.stem}.', dir=str(path.parent))
    try:
        with os.fdopen(fd, 'w', encoding='utf-8') as out:
            os.fchmod(out.fileno(), 0o600)
            json.dump(value, out, indent=2, ensure_ascii=False)
            out.write('\n')
            out.flush()
            os.fsync(out.fileno())
        os.replace(tmp, path)
    finally:
        try:
            os.unlink(tmp)
        except FileNotFoundError:
            pass


def child_env():
    allowed = {'PATH', 'HOME', 'LANG', 'LC_ALL', 'TMPDIR', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'REQUESTS_CA_BUNDLE'}
    env = {key: value for key, value in os.environ.items() if key in allowed}
    env['GROK_CHROME_PYTHON'] = CFFI_PYTHON
    return env


def safe_cli_packet(stdout, stderr, returncode):
    result = None
    try:
        parsed = json.loads(stdout.decode('utf-8'))
        allowed = {
            'operation', 'generationMode', 'ownerVerified', 'state', 'writeRequestsSent', 'readbackVerified',
            'httpStatus', 'responseContentType', 'responseBytes', 'responseShape', 'transportEvidence',
            'responseBodySha256',
            'paymentOrUpgradeSignal', 'assetCount', 'mediaVerifications', 'correlation', 'stage',
            'directVideoCreateRequestsSent', 'reasonCode', 'errorCode', 'noWireProofPersisted',
            'intentRecoveryRecorded', 'sameIntentPreparedForRecovery', 'helperErrorCode', 'persistenceErrorCode',
            'attemptNumber', 'mainFetchCallCount', 'requestStarted', 'responseReceived',
        }
        if isinstance(parsed, dict):
            result = {key: parsed[key] for key in allowed if key in parsed}
    except Exception:
        pass
    if result is None:
        result = {}
    error_code = None
    stderr_text = stderr.decode('utf-8', 'replace')
    for line in reversed(stderr_text.splitlines()):
        try:
            packet = json.loads(line.strip())
        except Exception:
            continue
        error = packet.get('error', {}) if isinstance(packet, dict) else {}
        code = error.get('code') if isinstance(error, dict) else None
        details = error.get('details') if isinstance(error, dict) else None
        if isinstance(details, dict):
            for key in ('stage', 'status', 'contentType', 'challengeDetected', 'securitySignal', 'retryAfterSeconds',
                        'requestStarted', 'responseReceived', 'responseBytesRead', 'helperErrorCode', 'errorClass',
                        'persistenceErrorCode', 'proofPersisted', 'responseBodySha256', 'mainFetchCallCount'):
                value = details.get(key)
                if key == 'stage' and isinstance(value, str) and re.fullmatch(r'[a-z][a-z0-9_]{1,63}', value): result[key] = value
                elif key == 'status' and isinstance(value, int) and 100 <= value <= 599: result['httpStatus'] = value
                elif key == 'contentType' and (value is None or isinstance(value, str) and len(value) <= 128): result['responseContentType'] = value
                elif key == 'challengeDetected' and isinstance(value, bool): result[key] = value
                elif key in {'requestStarted', 'responseReceived', 'proofPersisted'} and isinstance(value, bool): result[key] = value
                elif key == 'responseBytesRead' and isinstance(value, int) and 0 <= value <= 2 * 1024 * 1024: result[key] = value
                elif key == 'mainFetchCallCount' and isinstance(value, int) and 0 <= value <= 1:
                    result[key] = value
                    if value == 0:
                        result['writeRequestsSent'] = 0
                        result['state'] = 'pre_dispatch_failed'
                elif key == 'responseBodySha256' and isinstance(value, str) and re.fullmatch(r'[a-f0-9]{64}', value): result[key] = value
                elif key == 'helperErrorCode' and isinstance(value, str) and re.fullmatch(r'[A-Z][A-Z0-9_]{0,63}', value): result[key] = value
                elif key == 'errorClass' and (value is None or isinstance(value, str) and re.fullmatch(r'[A-Za-z][A-Za-z0-9]{0,63}', value)): result[key] = value
                elif key == 'persistenceErrorCode' and (value is None or isinstance(value, str) and re.fullmatch(r'[A-Z][A-Z0-9_]{0,63}', value)): result[key] = value
                elif key == 'securitySignal' and (value is None or isinstance(value, str) and re.fullmatch(r'[A-Z0-9_]{1,80}', value)):
                    result[key] = value
                elif key == 'retryAfterSeconds' and isinstance(value, (int, float)) and 0 <= value <= 86400:
                    result[key] = value
        if isinstance(code, str) and re.fullmatch(r'[A-Z][A-Z0-9_]{0,63}', code):
            error_code = code
            break
    result['processExitCode'] = returncode
    if error_code:
        result['errorCode'] = error_code
    return result


async def run_cli(args, packet):
    raw = bytearray(json.dumps(packet, separators=(',', ':')).encode('utf-8'))
    if len(raw) > 8 * 1024 * 1024:
        raw[:] = b'\0' * len(raw)
        raise RuntimeError('CLI_PACKET_TOO_LARGE')
    proc = await asyncio.create_subprocess_exec(
        NODE, str(CLI), *args,
        cwd=str(REPO), stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
        env=child_env(),
    )
    try:
        stdout, stderr = await asyncio.wait_for(proc.communicate(bytes(raw)), timeout=12 * 60)
    finally:
        raw[:] = b'\0' * len(raw)
    if len(stdout) > MAX_CHILD_OUTPUT or len(stderr) > MAX_CHILD_OUTPUT:
        raise RuntimeError('CLI_OUTPUT_TOO_LARGE')
    return safe_cli_packet(stdout, stderr, proc.returncode), stdout


def ui_source_body_matches(body_text, prompt, asset_id):
    if not isinstance(body_text, str) or len(body_text.encode('utf-8')) > MAX_CAPTURE_BODY:
        return False, None
    try:
        body = json.loads(body_text)
    except Exception:
        return False, None
    media = body.get('mediaGenInput') if isinstance(body, dict) else None
    modes = list(media) if isinstance(media, dict) else []
    mode = modes[0] if len(modes) == 1 else None
    params = media.get(mode) if mode in {'imageToVideo', 'referenceToVideo'} else None
    input_assets = params.get('inputAssets') if isinstance(params, dict) else None
    fields_ok = isinstance(body, dict) and set(body) == {
        'enableImageStreaming', 'enableSideBySide', 'kind', 'mediaGenInput', 'message', 'modelName',
        'responseMetadata', 'sendFinalMetadata',
    }
    expected_input_fields = {'aspectRatio', 'duration', 'inputAssets', 'mode', 'prompt', 'resolutionName', 'skipAudio'}
    optional_use_first_frame = isinstance(params, dict) and set(params) == expected_input_fields | {'useFirstFrame'}
    input_shape_ok = isinstance(params, dict) and (set(params) == expected_input_fields or optional_use_first_frame)
    expected_meta = {'experiments': [], 'modelConfigOverride': {'modelMap': {}}}
    metadata_ok = isinstance(body, dict) and body.get('responseMetadata') == expected_meta
    profile_ok = isinstance(params, dict) and params.get('aspectRatio') == '2:3' and params.get('duration') == 6 \
        and params.get('resolutionName') == '480p' and params.get('mode') == 'custom' and params.get('skipAudio') is True \
        and ('useFirstFrame' not in params or isinstance(params.get('useFirstFrame'), bool))
    shape = {
        'topLevelFieldNames': sorted(body) if isinstance(body, dict) else [],
        'mediaGenInputModes': modes,
        'videoMode': mode,
        'inputFieldNames': sorted(params) if isinstance(params, dict) else [],
        'inputAssetCount': len(input_assets) if isinstance(input_assets, list) else 0,
        'inputAssetMatched': isinstance(input_assets, list) and asset_id in input_assets,
        'promptMatched': isinstance(params, dict) and params.get('prompt') == prompt,
        'messageMatched': isinstance(body.get('message'), str) and body.get('message') == f'{prompt} --mode=custom',
        'profile': {key: params.get(key) for key in ('aspectRatio', 'duration', 'resolutionName', 'mode', 'skipAudio')}
            if isinstance(params, dict) else {},
        'responseMetadataFieldNames': sorted(body.get('responseMetadata', {}))
            if isinstance(body.get('responseMetadata'), dict) else [],
        'exactTopLevelSchema': fields_ok,
        'exactInputSchema': input_shape_ok,
        'exactResponseMetadata': metadata_ok,
        'profileMatched': profile_ok,
        'bodyLength': len(body_text.encode('utf-8')),
        'bodySha256': sha(body_text),
    }
    matched = (
        mode in {'imageToVideo', 'referenceToVideo'}
        and isinstance(params, dict) and shape['inputAssetMatched'] and shape['promptMatched'] and shape['messageMatched']
        and body.get('modelName') == 'imagine-video-gen' and body.get('kind') == 'CONVERSATION_KIND_IMAGINE'
        and body.get('enableImageStreaming') is True and body.get('enableSideBySide') is True
        and body.get('sendFinalMetadata') is True
    )
    return matched, shape


class AsyncMediaGuard:
    def __init__(self, cdp, asset_url, prompt, asset_id):
        self.cdp = cdp
        self.asset_url = asset_url
        self.prompt = prompt
        self.asset_id = asset_id
        self.allowed_asset_urls = {asset_url}
        self.tasks = set()
        self.blocked = []
        self.abort_errors = 0
        self.fail_request_ack_count = 0
        self.network_id_missing_count = 0
        self.browser_write_attempts = 0
        self.late_write_attempts_blocked = 0
        self.server_writes_delivered = 0
        self.web_socket_frames_seen = 0
        self.web_socket_frames_blocked = 0
        self.web_socket_frames_forwarded = 0
        self.capture = None
        self.capture_block = None
        self.capture_shape = None
        self.capture_candidates = 0
        self.matching_video_attempts = 0
        self.request_extra = {}
        self.pending_asset_headers = {}
        self.asset = {
            'attempts': 0, 'headers': {}, 'cookieNames': set(), 'response': None,
            'fromDiskCache': None, 'fromServiceWorker': None, 'protocol': None,
        }
        self.asset_network_ids = set()
        self.network_blocks = {}
        self.target_network_id = None
        self.target_cookie_names = set()
        self.target_sdk_headers = {}

    def _spawn(self, coro):
        task = asyncio.create_task(coro)
        self.tasks.add(task)
        task.add_done_callback(self.tasks.discard)

    @staticmethod
    def _cookies(headers):
        raw = next((value for key, value in headers.items() if str(key).lower() == 'cookie' and isinstance(value, str)), '')
        return {part.split('=', 1)[0].strip() for part in raw.split(';') if '=' in part}

    @staticmethod
    def _safe_headers(headers, allow_sdk=False):
        output = {}
        allowed = SAFE_ORDINARY_HEADERS | (SAFE_SDK_HEADERS if allow_sdk else set())
        for name, value in headers.items():
            normalized = str(name).lower()
            if normalized in allowed and isinstance(value, str) and value and len(value) <= 2048 \
                and not re.search(r'[\r\n\0]', value):
                output[normalized] = value
        return output

    def on_fetch_paused(self, event):
        self._spawn(self._handle_fetch_paused(event))

    async def _handle_fetch_paused(self, event):
        request = event.get('request') if isinstance(event.get('request'), dict) else {}
        request_id = event.get('requestId')
        if not isinstance(request_id, str):
            self.abort_errors += 1
            return
        url = request.get('url', '')
        method = str(request.get('method', 'GET')).upper()
        resource_type = event.get('resourceType', 'Other')
        headers = request.get('headers') if isinstance(request.get('headers'), dict) else {}
        post_data = request.get('postData')
        network_id = event.get('networkId')

        if method == 'GET' and url == self.asset_url:
            self.asset['attempts'] += 1
            if isinstance(network_id, str):
                self.asset_network_ids.add(network_id)
            self.asset['headers'].update(self._safe_headers(headers))
            self.asset['cookieNames'].update(self._cookies(headers))
            extra = self.request_extra.get(network_id, {}) if isinstance(network_id, str) else {}
            self.asset['headers'].update(extra.get('ordinaryHeaders', {}))
            self.asset['cookieNames'].update(extra.get('cookieNames', set()))
            allowed_asset_attempt = self.asset['attempts'] <= 2
        else:
            allowed_asset_attempt = False

        if allowed_asset_attempt or explicitly_observed_read(
            method, url, resource_type, post_data, headers, self.allowed_asset_urls,
        ):
            try:
                await self.cdp.send('Fetch.continueRequest', {'requestId': request_id})
            except Exception:
                self.abort_errors += 1
            return

        parsed = urlsplit(url)
        block = {
            'method': method,
            'origin': f'{parsed.scheme}://{parsed.netloc}' if parsed.scheme and parsed.netloc else None,
            'path': parsed.path,
            'networkId': network_id if isinstance(network_id, str) else None,
            'intentMatch': False,
            'ack': False,
            'responseCount': 0,
            'loadingFailedCount': 0,
        }
        if method in {'POST', 'PUT', 'PATCH', 'DELETE'}:
            self.browser_write_attempts += 1
            if self.capture is not None:
                self.late_write_attempts_blocked += 1
        capture_candidate = False
        body_match = False
        body_shape = None
        is_video_route = parsed.path == '/rest/app-chat/conversations/new' \
            or re.fullmatch(r'/rest/app-chat/conversations/[A-Za-z0-9._~-]{8,256}/responses', parsed.path) is not None
        if method == 'POST' and parsed.scheme == 'https' and parsed.hostname == 'grok.com' and is_video_route:
            self.capture_candidates += 1
            body_match, body_shape = ui_source_body_matches(post_data, self.prompt, self.asset_id)
            block['intentMatch'] = body_match
            if body_match:
                self.matching_video_attempts += 1
            if body_match and self.capture is None:
                capture_candidate = True
                self.target_network_id = network_id if isinstance(network_id, str) else None
                if not isinstance(network_id, str):
                    self.network_id_missing_count += 1
                lowered_headers = {str(key).lower(): value for key, value in headers.items()}
                self.target_sdk_headers = {name: lowered_headers[name] for name in SAFE_SDK_HEADERS
                    if isinstance(lowered_headers.get(name), str)}
                self.target_cookie_names.update(self._cookies(headers))
                self.capture = {
                    'method': method,
                    'path': parsed.path,
                    'bodyText': post_data if isinstance(post_data, str) else '',
                    'headers': dict(self.target_sdk_headers),
                    'ordinaryHeaders': self._safe_headers(headers),
                    'browserAbortVerified': False,
                    'serverWritesDelivered': 0,
                    'ssoCookieObserved': 'sso' in self.target_cookie_names,
                }
                extra = self.request_extra.get(network_id, {}) if isinstance(network_id, str) else {}
                self.capture['ordinaryHeaders'].update(extra.get('ordinaryHeaders', {}))
                self.capture['headers'].update(extra.get('sdkHeaders', {}))
                self.target_cookie_names.update(extra.get('cookieNames', set()))
                self.capture['ssoCookieObserved'] = 'sso' in self.target_cookie_names
                self.capture_shape = body_shape
        self.blocked.append(block)
        if isinstance(network_id, str):
            self.network_blocks[network_id] = block
        try:
            await self.cdp.send('Fetch.failRequest', {'requestId': request_id, 'errorReason': 'BlockedByClient'})
            block['ack'] = True
            self.fail_request_ack_count += 1
        except Exception:
            self.abort_errors += 1
        if capture_candidate and self.capture is not None:
            self.capture['browserAbortVerified'] = block['ack'] is True and isinstance(network_id, str)
            self.capture['ssoCookieObserved'] = 'sso' in self.target_cookie_names
            self.capture_block = block

    def on_request(self, event):
        request = event.get('request') if isinstance(event.get('request'), dict) else {}
        request_id = event.get('requestId')
        if request.get('url') == self.asset_url and isinstance(request_id, str):
            self.asset_network_ids.add(request_id)
            self.asset['headers'].update(self._safe_headers(request.get('headers') or {}))
            self.asset['cookieNames'].update(self._cookies(request.get('headers') or {}))

    def on_extra_info(self, event):
        request_id = event.get('requestId')
        headers = event.get('headers') if isinstance(event.get('headers'), dict) else {}
        if not isinstance(request_id, str):
            return
        normalized = {str(key).lower(): value for key, value in headers.items()}
        ordinary = self._safe_headers(headers)
        cookies = self._cookies(headers)
        sdk_headers = {name: normalized[name] for name in SAFE_SDK_HEADERS if isinstance(normalized.get(name), str)}
        self.request_extra[request_id] = {'ordinaryHeaders': ordinary, 'sdkHeaders': sdk_headers, 'cookieNames': cookies}
        if request_id in self.asset_network_ids:
            self.asset['headers'].update(ordinary)
            self.asset['cookieNames'].update(cookies)
        if request_id == self.target_network_id:
            if self.capture is not None:
                self.capture['ordinaryHeaders'].update(ordinary)
                for name in SAFE_SDK_HEADERS:
                    if isinstance(normalized.get(name), str):
                        self.capture['headers'][name] = normalized[name]
            self.target_cookie_names.update(cookies)
            if self.capture is not None:
                self.capture['ssoCookieObserved'] = 'sso' in self.target_cookie_names

    def on_response(self, event):
        request_id = event.get('requestId')
        response = event.get('response') if isinstance(event.get('response'), dict) else {}
        if request_id in self.network_blocks:
            self.network_blocks[request_id]['responseCount'] += 1
        if response.get('url') == self.asset_url:
            self.asset['response'] = {
                'status': response.get('status') if isinstance(response.get('status'), int) else None,
                'mimeType': response.get('mimeType') if isinstance(response.get('mimeType'), str) else None,
            }
            self.asset['fromDiskCache'] = response.get('fromDiskCache') is True
            self.asset['fromServiceWorker'] = response.get('fromServiceWorker') is True
            self.asset['protocol'] = response.get('protocol')

    def on_loading_failed(self, event):
        request_id = event.get('requestId')
        if request_id in self.network_blocks:
            self.network_blocks[request_id]['loadingFailedCount'] += 1

    async def quiesce_events(self):
        if self.tasks:
            await asyncio.gather(*list(self.tasks), return_exceptions=True)

    def capture_abort_proof(self):
        block = self.capture_block
        if not block:
            return {'verified': False, 'failRequestAck': False, 'networkIdPresent': False,
                'loadingFailedCount': 0, 'responseCount': 0, 'intentMatch': False}
        return {
            'verified': block['ack'] is True and isinstance(block['networkId'], str)
                and block['loadingFailedCount'] in {0, 1} and block['responseCount'] == 0 and block['intentMatch'] is True,
            'failRequestAck': block['ack'] is True,
            'networkIdPresent': isinstance(block['networkId'], str),
            'loadingFailedCount': block['loadingFailedCount'],
            'responseCount': block['responseCount'],
            'intentMatch': block['intentMatch'] is True,
            'loadingFailedMissing': block['loadingFailedCount'] == 0,
        }

    def safe_browser_proof(self):
        writes = [block for block in self.blocked if block['method'] in {'POST', 'PUT', 'PATCH', 'DELETE'}]
        return {
            'pagewideVerified': all(item['ack'] is True and item['responseCount'] == 0 for item in writes)
                and self.abort_errors == 0 and self.server_writes_delivered == 0,
            'browserMutationAttemptsBlocked': self.browser_write_attempts,
            'lateBrowserRetriesBlocked': self.late_write_attempts_blocked,
            'failRequestAckCount': self.fail_request_ack_count,
            'networkIdMissingCount': self.network_id_missing_count,
            'blockedBusinessWriteCount': len(writes),
            'matchingNativeVideoIntentAttempts': self.matching_video_attempts,
            'blockedSdkRetryAttempts': max(0, self.matching_video_attempts - 1),
            'browserServerWritesDelivered': self.server_writes_delivered,
            'blockedWriteResponses': sum(item['responseCount'] for item in writes),
            'asset': {
                'requestCount': self.asset['attempts'],
                'requestHeaderNames': sorted(self.asset['headers']),
                'ssoObserved': 'sso' in self.asset['cookieNames'],
                'response': self.asset['response'],
                'fromDiskCache': self.asset['fromDiskCache'],
                'fromServiceWorker': self.asset['fromServiceWorker'],
                'protocol': self.asset['protocol'],
            },
        }


async def target_id(context, page):
    cdp = await context.new_cdp_session(page)
    try:
        return (await cdp.send('Target.getTargetInfo')).get('targetInfo', {}).get('targetId')
    finally:
        await cdp.detach()


async def page_asset_selection(page, expected_sha, start_ms, end_ms):
    return await page.evaluate(ASSET_SELECT_SCRIPT, {
        'expectedSha': expected_sha, 'startMs': start_ms, 'endMs': end_ms, 'expectedOwnerSha': EXPECTED_OWNER_SHA,
    })


ASSET_SELECT_SCRIPT = """async ({expectedSha,startMs,endMs,expectedOwnerSha})=>{
 const json=async r=>{const t=await r.text();let data=null;try{data=JSON.parse(t)}catch{};return {status:r.status,bytes:new TextEncoder().encode(t).length,data}};
 const owner=await json(await fetch('/api/auth/session',{method:'GET',credentials:'same-origin',cache:'no-store',redirect:'error'}));
 const ownerEmail=owner.data?.session?.email;let ownerMatch=false;if(typeof ownerEmail==='string'){const h=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(ownerEmail.trim().toLowerCase()));ownerMatch=[...new Uint8Array(h)].map(x=>x.toString(16).padStart(2,'0')).join('')===expectedOwnerSha;}
 let assetOrigin=null;for(const s of document.scripts){const t=s.textContent||'',i=t.indexOf('ASSET_SERVER_URL');if(i<0)continue;const m=t.slice(i,i+512).replace(/\\\\/g,'').match(/https?:\\/\\/[A-Za-z0-9.-]+(?::\\d+)?/);if(m){try{const u=new URL(m[0]);if(u.protocol==='https:'&&!u.username&&!u.password&&!u.search&&!u.hash){assetOrigin=u.origin;break}}catch{}}}
 const params=new URLSearchParams({includeImagineFiles:'true',isLatest:'true',orderBy:'ORDER_BY_CREATE_TIME',pageSize:'24',source:'SOURCE_ANY'});let all=[],cursor=null,pages=0,complete=false;const cursors=new Set(),statuses=[];
 while(pages<20){if(cursor)params.set('pageToken',cursor);else params.delete('pageToken');const x=await json(await fetch('/rest/assets?'+params.toString(),{method:'GET',credentials:'same-origin',redirect:'error'}));pages++;statuses.push(x.status);if(x.status!==200||!Array.isArray(x.data?.assets))break;all.push(...x.data.assets);cursor=typeof x.data.nextPageToken==='string'&&x.data.nextPageToken?x.data.nextPageToken:null;if(!cursor){complete=true;break}if(cursors.has(cursor))break;cursors.add(cursor)}
 const ms=v=>typeof v==='number'?(v>1e10?v:v*1000):typeof v==='string'?Date.parse(v):NaN;
 const near=all.filter(a=>a&&a.mimeType==='image/jpeg'&&a.isPublic===false&&a.isModelGenerated===true&&typeof a.assetId==='string'&&typeof a.key==='string'&&typeof a.responseId==='string'&&typeof a.sourceConversationId==='string'&&ms(a.createTime)>=startMs-1000&&ms(a.createTime)<=endMs+5000);
 const convos=new Map();for(const a of near){if(convos.has(a.sourceConversationId))continue;const id=a.sourceConversationId;const d=await json(await fetch('/rest/app-chat/conversations_v2/'+encodeURIComponent(id)+'?includeTaskResult=true&includeWorkspaces=true',{method:'GET',credentials:'same-origin',redirect:'error'}));const n=await json(await fetch('/rest/app-chat/conversations/'+encodeURIComponent(id)+'/response-node',{method:'GET',credentials:'same-origin',redirect:'error'}));const rids=[...new Set((n.data?.responseNodes||[]).map(x=>x?.responseId).filter(x=>typeof x==='string'&&x.length>0&&x.length<=256))];let loaded={status:0,data:null};if(rids.length)loaded=await json(await fetch('/rest/app-chat/conversations/'+encodeURIComponent(id)+'/load-responses',{method:'POST',credentials:'same-origin',redirect:'error',headers:{'content-type':'application/json'},body:JSON.stringify({responseIds:rids})}));const c=d.data?.conversation||{};const responses=Array.isArray(loaded.data?.responses)?loaded.data.responses:[];const user=responses.filter(x=>['user','human','client'].includes(String(x?.sender||'').toLowerCase())&&typeof x?.message==='string');const unique=[...new Set(user.map(x=>x.message))];const hashes=[];for(const t of unique){const h=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(t));hashes.push([...new Uint8Array(h)].map(x=>x.toString(16).padStart(2,'0')).join(''))}const hprompt=typeof c.prompt==='string'?await crypto.subtle.digest('SHA-256',new TextEncoder().encode(c.prompt)):null;const conversationPromptSha=hprompt?[...new Uint8Array(hprompt)].map(x=>x.toString(16).padStart(2,'0')).join(''):null;const responseIds=new Set(responses.map(x=>x?.responseId).filter(x=>typeof x==='string'));convos.set(id,{detail:d.status,nodes:n.status,loaded:loaded.status,conversationMatch:c.conversationId===id,uniquePromptCount:unique.length,promptHashes:hashes,conversationPromptSha,responseIds});}
 const taskHistoryMatches=a=>{const c=convos.get(a.sourceConversationId);return c?.conversationMatch&&c.uniquePromptCount===1&&c.promptHashes.length===1&&c.promptHashes[0]===expectedSha&&(!c.conversationPromptSha||c.conversationPromptSha===expectedSha)};
 const validCandidates=near.filter(a=>taskHistoryMatches(a)&&convos.get(a.sourceConversationId).responseIds.has(a.responseId));
 const verified=complete&&owner.status===200&&ownerMatch&&typeof ownerEmail==='string'&&assetOrigin&&near.length===4&&validCandidates.length>=1;
 near.sort((a,b)=>ms(a.createTime)-ms(b.createTime)||String(a.assetId).localeCompare(String(b.assetId)));validCandidates.sort((a,b)=>ms(a.createTime)-ms(b.createTime)||String(a.assetId).localeCompare(String(b.assetId)));const chosen=validCandidates[0];let assetUrl=null;if(chosen&&assetOrigin){try{const u=/^https?:/i.test(chosen.key)?new URL(chosen.key):new URL(chosen.key.replace(/^\\//,''),assetOrigin+'/');if(u.origin===assetOrigin&&u.protocol==='https:'&&!u.search&&!u.hash&&!u.username&&!u.password&&u.pathname.startsWith('/users/')&&u.pathname.includes('/generated/')){u.searchParams.set('cache','1');assetUrl=u.href}}catch{}}
 const historyProofSummary=near.map(a=>{const c=convos.get(a.sourceConversationId)||{};return {detailStatus:c.detail,nodesStatus:c.nodes,loadStatus:c.loaded,conversationMatch:c.conversationMatch===true,uniquePromptCount:c.uniquePromptCount??0,promptHashCount:c.promptHashes?.length??0,promptHashMatches:c.promptHashes?.includes(expectedSha)===true,conversationPromptPresent:typeof c.conversationPromptSha==='string',conversationPromptMatches:!c.conversationPromptSha||c.conversationPromptSha===expectedSha,responseIdLinked:c.responseIds?.has(a.responseId)===true}});
 return {ownerStatus:owner.status,ownerBytes:owner.bytes,ownerMatch,ownerEmail,assetOrigin,listing:{pages,complete,count:all.length,uniqueIdCount:new Set(all.map(a=>a?.assetId).filter(x=>typeof x==='string')).size,pageStatuses:statuses},candidateCount:near.length,verified,historyProofSummary,candidates:near.map(a=>({assetId:a.assetId,sourceConversationId:a.sourceConversationId,responseId:a.responseId,key:a.key,createTime:a.createTime})),chosen:chosen?{assetId:chosen.assetId,sourceConversationId:chosen.sourceConversationId,responseId:chosen.responseId,key:chosen.key,createTime:chosen.createTime,assetUrl}:null};
}"""


def json_body(raw):
    if not isinstance(raw, str) or len(raw.encode('utf-8')) > MAX_CAPTURE_BODY:
        return None
    try:
        body = json.loads(raw)
        return body if isinstance(body, dict) else None
    except Exception:
        return None


async def verified_target_page(browser, role_entry, *, require_neutral=True):
    matches = []
    for context in browser.contexts:
        for page in context.pages:
            try:
                if await page.evaluate('() => window.name') == ROLE and urlsplit(page.url).hostname == 'grok.com':
                    matches.append((context, page))
            except Exception:
                pass
    if len(matches) != 1:
        raise RuntimeError('PAGE_ROLE_NOT_UNIQUE')
    context, page = matches[0]
    if await target_id(context, page) != role_entry.get('targetId'):
        raise RuntimeError('PAGE_TARGET_ID_MISMATCH')
    if require_neutral and urlsplit(page.url).path != '/imagine':
        raise RuntimeError('PAGE_ROLE_NOT_NEUTRAL')
    return context, page


def now_ms_from_iso(value):
    from datetime import datetime
    return int(datetime.fromisoformat(value.replace('Z', '+00:00')).timestamp() * 1000)


async def media_intent_state():
    data = json.loads(INTENT_FILE.read_text())
    return data.get('intents', [])


def choose_prepared_intent(entries, prompt_sha, owner_sha):
    matches = [item for item in entries if item.get('operation') == 'media.video.create'
        and item.get('payloadProfile') == 'video-image-reference-6s-480p-no-audio'
        and item.get('promptSha256') == prompt_sha and item.get('ownerIdentityDigest') == owner_sha
        and item.get('attemptNumber') == 1]
    if len(matches) > 1 or matches and matches[0].get('state') != 'prepared' \
        and not (matches[0].get('state') == 'failed' and matches[0].get('reasonCode') == 'JOURNAL_STATE_INVALID'):
        raise RuntimeError('IMAGE_REFERENCE_INTENT_ALREADY_ATTEMPTED')
    return matches[0].get('intentId') if matches else str(uuid.uuid4())


def assert_safe_pre_dispatch_recapture(intent_id, prompt_sha):
    if not LIVE_RECEIPT.exists():
        return None
    previous = json.loads(LIVE_RECEIPT.read_text())
    direct = previous.get('directSubmission') if isinstance(previous.get('directSubmission'), dict) else {}
    transport = direct.get('transportEvidence') if isinstance(direct.get('transportEvidence'), dict) else {}
    helper_no_wire = direct.get('noWireProofPersisted') is True and direct.get('intentRecoveryRecorded') is True \
        and transport.get('requestStarted') is False and transport.get('responseReceived') is False
    journal_begin_no_wire = direct.get('errorCode') == 'MEDIA_OPERATION_JOURNAL_FAILED' \
        and direct.get('stage') == 'operation_journal_begin' and direct.get('persistenceErrorCode') == 'JOURNAL_STATE_INVALID' \
        and direct.get('mainFetchCallCount') == 0 and direct.get('requestStarted') is False \
        and direct.get('responseReceived') is False
    if previous.get('directVideoCreateRequestsSent') != 0 or previous.get('intentIdSha256') != sha(intent_id) \
        or previous.get('promptSha256') != prompt_sha or previous.get('generationMode') != 'image_reference' \
        or (previous.get('finalState') or direct.get('state')) != 'pre_dispatch_failed' \
        or not (helper_no_wire or journal_begin_no_wire):
        raise RuntimeError('LIVE_VIDEO_TASK_ALREADY_DISPATCHED')
    intents = json.loads(INTENT_FILE.read_text()).get('intents', [])
    prepared = [item for item in intents if item.get('intentId') == intent_id]
    allowed_intent_state = prepared and (prepared[0].get('state') == 'prepared'
        or journal_begin_no_wire and prepared[0].get('state') == 'failed' and prepared[0].get('reasonCode') == 'JOURNAL_STATE_INVALID')
    if len(prepared) != 1 or not allowed_intent_state or prepared[0].get('attemptNumber') != 1 \
        or prepared[0].get('promptSha256') != prompt_sha or prepared[0].get('ownerIdentityDigest') != EXPECTED_OWNER_SHA \
        or prepared[0].get('payloadProfile') != 'video-image-reference-6s-480p-no-audio':
        raise RuntimeError('LIVE_VIDEO_INTENT_NOT_PREPARED')
    intent_digest = sha(f'media.video.create\n{EXPECTED_OWNER_SHA}\n{intent_id}')
    operations = json.loads(OPERATION_FILE.read_text()).get('entries', [])
    matching = [item for item in operations if item.get('contractId') == 'media.video.create'
        and item.get('intentDigest') == intent_digest]
    if not matching or len(matching) > 3:
        raise RuntimeError('LIVE_VIDEO_OPERATION_ALREADY_STARTED')
    expected_intent_id_sha = sha(intent_id)
    for item in matching:
        proof = item.get('videoNoWireProof') if isinstance(item.get('videoNoWireProof'), dict) else {}
        if item.get('state') != 'rejected' or item.get('reasonCode') != 'MEDIA_VIDEO_CFFI_PREFLIGHT_FAILED' \
            or proof.get('operation') != 'media.video.create' or proof.get('ownerIdentityDigest') != EXPECTED_OWNER_SHA \
            or proof.get('intentIdSha256') != expected_intent_id_sha or proof.get('intentDigest') != intent_digest \
            or proof.get('requestDigest') != item.get('requestDigest') or proof.get('payloadProfile') != 'video-image-reference-6s-480p-no-audio' \
            or proof.get('promptSha256') != prompt_sha or proof.get('stage') not in {'validation', 'dependency', 'session_setup'} \
            or proof.get('requestStarted') is not False or proof.get('responseReceived') is not False \
            or proof.get('httpStatus') is not None or proof.get('responseBytesRead') != 0 \
            or not isinstance(proof.get('helperErrorCode'), str) or not re.fullmatch(r'[A-Z][A-Z0-9_]{0,63}', proof['helperErrorCode']):
            raise RuntimeError('LIVE_VIDEO_NO_WIRE_RECOVERY_PROOF_INVALID')
    return 'operation_journal_begin' if journal_begin_no_wire else 'helper_no_wire'


async def build_session_context(context, asset_url, observed_headers, owner_email):
    asset_cookies = [cookie for cookie in await context.cookies([asset_url]) if cookie.get('name') == 'sso'
        and isinstance(cookie.get('value'), str) and cookie.get('value')
        and str(cookie.get('domain', '')).lstrip('.').lower() in {'grok.com', 'assets.grok.com'}
        and isinstance(cookie.get('path'), str) and asset_url.split('?', 1)[0].startswith('https://assets.grok.com' + cookie['path'])
        and cookie.get('secure') is True and cookie.get('httpOnly') is True]
    session_cookies = [cookie for cookie in await context.cookies(['https://grok.com']) if cookie.get('name') == 'sso'
        and isinstance(cookie.get('value'), str) and cookie.get('value')
        and str(cookie.get('domain', '')).lstrip('.').lower() == 'grok.com'
        and cookie.get('path') == '/' and cookie.get('secure') is True and cookie.get('httpOnly') is True]
    if len(asset_cookies) != 1 or len(session_cookies) != 1 or asset_cookies[0]['value'] != session_cookies[0]['value']:
        raise RuntimeError('CURRENT_OWNER_SSO_ASSET_BINDING_NOT_UNIQUE')
    required = {'referer', 'user-agent', 'sec-ch-ua-platform'}
    if not required.issubset(observed_headers) or observed_headers.get('origin') not in {None, 'https://grok.com'}:
        raise RuntimeError('NATIVE_ASSET_ORDINARY_HEADERS_INCOMPLETE')
    cookie = asset_cookies[0]
    session_cookie = session_cookies[0]
    captured_at = now_iso()
    session_bundle = {
        'schemaVersion': 1,
        'serviceId': 'grok-web',
        'origin': 'https://grok.com',
        'capturedAt': captured_at,
        'sourceObservationId': 'linux-native-chrome-' + str(uuid.uuid4()),
        'origins': [{
            'origin': 'https://grok.com',
            'cookies': [{
                'name': 'sso', 'value': session_cookie['value'], 'domain': 'grok.com', 'path': '/',
                'secure': True, 'httpOnly': True, 'expiresAt': None,
            }],
            'headers': [],
        }],
    }
    asset_context = {
        'schemaVersion': 1,
        'source': 'normal_ui_asset_request',
        'ownerIdentityDigest': EXPECTED_OWNER_SHA,
        'assetOrigin': 'https://assets.grok.com',
        'pathClass': '/users/*/generated/*',
        'method': 'GET',
        'observedCookieNames': ['sso'],
        'cookies': [{
            'name': 'sso', 'value': cookie['value'], 'domain': cookie['domain'], 'path': cookie['path'],
            'secure': True, 'httpOnly': True,
        }],
        'headers': dict(observed_headers),
    }
    return session_bundle, asset_context


def safe_capture_summary(capture, shape, abort, guard, source, intent_id, prompt):
    path_class = safe_path_class('https://grok.com' + capture.get('path', '/')) if capture else 'none'
    local_artifact = source.get('localArtifactProof') if isinstance(source.get('localArtifactProof'), dict) else {}
    return {
        'intentIdSha256': sha(intent_id),
        'promptSha256': sha(prompt),
        'promptLength': len(prompt),
        'generationMode': 'image_reference',
        'profileName': 'video-image-reference-6s-480p-no-audio',
        'nativeCapture': {
            'captured': capture is not None,
            'intentMatch': bool(shape and shape.get('inputAssetMatched') and shape.get('promptMatched') and shape.get('messageMatched')),
            'method': capture.get('method') if capture else None,
            'pathClass': path_class,
            'bodyLength': len(capture['bodyText'].encode('utf-8')) if capture else None,
            'bodySha256': sha(capture['bodyText']) if capture else None,
            'topLevelFieldNames': shape.get('topLevelFieldNames') if shape else [],
            'mediaGenInputModes': shape.get('mediaGenInputModes') if shape else [],
            'inputFieldNames': shape.get('inputFieldNames') if shape else [],
            'inputAssetCount': shape.get('inputAssetCount') if shape else 0,
            'inputAssetMatched': shape.get('inputAssetMatched') is True if shape else False,
            'promptMatched': shape.get('promptMatched') is True if shape else False,
            'profile': shape.get('profile') if shape else {},
            'ordinaryHeaderNames': sorted(capture.get('ordinaryHeaders', {})) if capture else [],
            'dynamicHeaderNames': sorted(capture.get('headers', {})) if capture else [],
            'ssoCookieObserved': capture.get('ssoCookieObserved') is True if capture else False,
            'abortProof': abort,
        },
        'sourceImage': {
            'taskHistoryVerified': source.get('verified') is True,
            'ownerVerified': source.get('ownerMatch') is True,
            'mimeType': 'image/jpeg',
            'createTime': source.get('chosen', {}).get('createTime'),
            'assetIdSha256': sha(source.get('chosen', {}).get('assetId', '')),
            'conversationIdSha256': sha(source.get('chosen', {}).get('sourceConversationId', '')),
            'assetServerOrigin': source.get('assetOrigin'),
            'localArtifactMappingVerified': local_artifact.get('verified') is True,
            'localArtifactSha256': local_artifact.get('sha256') if isinstance(local_artifact.get('sha256'), str)
                and re.fullmatch(r'[a-f0-9]{64}', local_artifact.get('sha256')) else None,
            'localArtifactBytes': local_artifact.get('bodyBytes') if isinstance(local_artifact.get('bodyBytes'), int)
                and 1 <= local_artifact.get('bodyBytes') <= 1024 * 1024 else None,
        },
        'browserGuard': guard.safe_browser_proof(),
        'browserWriteRequestsSent': 0,
        'promptOrPrivateIdsPersisted': False,
        'cookiesOrTokensPersisted': False,
        'rawBodiesOrFramesPersisted': False,
        'publicSharingChanged': False,
        'purchaseOrSubscriptionChanged': False,
    }


async def restore_page(page, cdp, websocket_handler, initial_state, role_entry, guard):
    global RESET_VERIFIED
    await page.goto('https://grok.com/imagine', wait_until='domcontentloaded', timeout=90_000)
    try:
        video_radio = page.get_by_role('radio', name='Video')
        image_radio = page.get_by_role('radio', name='Image')
        if initial_state.get('videoSelected') is True and await video_radio.count() == 1 \
            and await video_radio.get_attribute('aria-checked') != 'true':
            await video_radio.click(timeout=5000)
        if initial_state.get('videoSelected') is False and await image_radio.count() == 1 \
            and await image_radio.get_attribute('aria-checked') != 'true':
            await image_radio.click(timeout=5000)
        audio = page.get_by_role('button', name='Video audio')
        if initial_state.get('audioPressed') in {'true', 'false'} and await audio.count() == 1 \
            and await audio.get_attribute('aria-pressed') != initial_state['audioPressed']:
            await audio.click(timeout=5000)
        composer = page.get_by_role('textbox', name='Ask Grok anything')
        if await composer.count() == 1 and await composer.is_visible():
            await composer.fill(initial_state.get('composerText', ''), timeout=5000)
    except Exception:
        guard.abort_errors += 1
    await asyncio.sleep(5)
    await guard.quiesce_events()
    current = await page.evaluate('() => ({path:location.pathname,marker:window.name})')
    if current.get('path') != '/imagine' or current.get('marker') != ROLE:
        raise RuntimeError('SAME_TARGET_RESET_FAILED')
    if guard.abort_errors or guard.server_writes_delivered != 0:
        raise RuntimeError('GUARD_BOUNDARY_FAILED')
    await cdp.send('Fetch.disable')
    await cdp.send('Network.setCacheDisabled', {'cacheDisabled': False})
    await cdp.send('Network.setBypassServiceWorker', {'bypass': False})
    try:
        await page.unroute_web_socket('wss://grok.com/**', websocket_handler)
    except Exception:
        pass
    await cdp.detach()
    RESET_VERIFIED = True


async def emergency_reset():
    global RESET_VERIFIED
    if RESET_VERIFIED:
        return True
    try:
        owner = json.loads((RUNTIME / 'runtime-owner.json').read_text())
        registry = json.loads((RUNTIME / 'page-role-registry.json').read_text())
        role_entry = registry.get('activePageRoles', {}).get(ROLE, {})
        async with async_playwright() as playwright:
            browser = await playwright.chromium.connect_over_cdp(f"http://127.0.0.1:{int(owner['cdpPort'])}")
            context, page = await verified_target_page(browser, role_entry, require_neutral=False)
            cdp = await context.new_cdp_session(page)
            pending = set()
            ack_errors = []
            async def pause(event):
                request = event.get('request') if isinstance(event.get('request'), dict) else {}
                rid = event.get('requestId')
                if not isinstance(rid, str):
                    ack_errors.append(True); return
                if explicitly_observed_read(str(request.get('method', 'GET')).upper(), request.get('url', ''),
                    event.get('resourceType', 'Other'), request.get('postData'), request.get('headers'), set()):
                    await cdp.send('Fetch.continueRequest', {'requestId': rid})
                else:
                    await cdp.send('Fetch.failRequest', {'requestId': rid, 'errorReason': 'BlockedByClient'})
            def on_pause(event):
                task = asyncio.create_task(pause(event)); pending.add(task); task.add_done_callback(pending.discard)
            cdp.on('Fetch.requestPaused', on_pause)
            async def ws(route):
                try:
                    route.connect_to_server(); route.on_message(lambda _message: None)
                except Exception:
                    try: await route.close()
                    except Exception: pass
            await page.route_web_socket('wss://grok.com/**', ws)
            await cdp.send('Network.enable')
            await cdp.send('Fetch.enable', {'patterns': [{'urlPattern': '*', 'requestStage': 'Request'}]})
            await page.goto('https://grok.com/imagine', wait_until='domcontentloaded', timeout=90_000)
            state = SAVED_UI_STATE or {}
            try:
                video = page.get_by_role('radio', name='Video'); image = page.get_by_role('radio', name='Image')
                if state.get('videoSelected') is True and await video.count() == 1 and await video.get_attribute('aria-checked') != 'true':
                    await video.click(timeout=5000)
                if state.get('videoSelected') is False and await image.count() == 1 and await image.get_attribute('aria-checked') != 'true':
                    await image.click(timeout=5000)
                audio = page.get_by_role('button', name='Video audio')
                if state.get('audioPressed') in {'true', 'false'} and await audio.count() == 1 \
                    and await audio.get_attribute('aria-pressed') != state['audioPressed']:
                    await audio.click(timeout=5000)
                composer = page.get_by_role('textbox', name='Ask Grok anything')
                if await composer.count() == 1 and await composer.is_visible():
                    await composer.fill(state.get('composerText', ''), timeout=5000)
            except Exception:
                ack_errors.append(True)
            await asyncio.sleep(5)
            if pending:
                await asyncio.gather(*list(pending), return_exceptions=True)
            current = await page.evaluate('() => ({path:location.pathname,marker:window.name})')
            if current.get('path') != '/imagine' or current.get('marker') != ROLE or ack_errors:
                raise RuntimeError('EMERGENCY_RESET_UNVERIFIED')
            await cdp.send('Fetch.disable')
            try: await page.unroute_web_socket('wss://grok.com/**', ws)
            except Exception: pass
            await cdp.detach()
            RESET_VERIFIED = True
            return True
    except Exception:
        return False


async def main():
    raw = bytearray(await asyncio.to_thread(lambda: __import__('sys').stdin.buffer.read(16 * 1024)))
    try:
        packet = json.loads(raw.decode('utf-8'))
    except Exception:
        raw[:] = b'\0' * len(raw)
        raise RuntimeError('TASK_INPUT_INVALID')
    raw[:] = b'\0' * len(raw)
    if not isinstance(packet, dict) or set(packet) - {'prompt', 'captureOnly'}:
        raise RuntimeError('TASK_INPUT_INVALID')
    prompt = packet.get('prompt')
    capture_only = packet.get('captureOnly') is True
    if not isinstance(prompt, str) or not prompt.strip() or len(prompt) > PROMPT_LIMIT or '\0' in prompt:
        raise RuntimeError('TASK_PROMPT_INVALID')
    prompt = prompt.strip()
    if capture_only and CAPTURE_RECEIPT.exists():
        raise RuntimeError('CAPTURE_RECEIPT_ALREADY_EXISTS')

    owner = json.loads((RUNTIME / 'runtime-owner.json').read_text())
    registry = json.loads((RUNTIME / 'page-role-registry.json').read_text())
    role_entry = registry.get('activePageRoles', {}).get(ROLE, {})
    if owner.get('taskOwned') is not True or role_entry.get('origin') != 'https://grok.com' \
        or role_entry.get('exactMarkerCount') != 1 or role_entry.get('selection') != 'cdp_target_id' \
        or not role_entry.get('targetId'):
        raise RuntimeError('PAGE_ROLE_NOT_REGISTERED')
    chrome_proc = Path('/proc') / str(owner.get('chromePid'))
    supervisor_proc = Path('/proc') / str(owner.get('supervisorPid'))
    cmdline = chrome_proc.joinpath('cmdline').read_bytes().decode('utf-8', 'ignore').split('\0')
    if not chrome_proc.exists() or not supervisor_proc.exists() or '--user-data-dir=' + str(owner['profile']) not in cmdline:
        raise RuntimeError('OWNED_RUNTIME_MISMATCH')

    image_receipt = json.loads(IMAGE_RECEIPT.read_text())
    image_reconciliation = json.loads(IMAGE_RECONCILIATION.read_text())
    video_readback = json.loads(VIDEO_READBACK.read_text())
    if image_reconciliation.get('image', {}).get('generationAttributionVerified') is not True \
        or image_reconciliation.get('image', {}).get('byteDownloadVerified') is not True \
        or video_readback.get('state') != 'outcome_unknown' or video_readback.get('readbackVerified') is not False:
        raise RuntimeError('AUTHORITATIVE_MEDIA_STATE_INVALID')
    image_intents = json.loads(INTENT_FILE.read_text()).get('intents', [])
    image_intent = next((item for item in image_intents if item.get('operation') == 'media.image.create'
        and item.get('state') == 'completed' and item.get('payloadProfile') == 'image-quality2-native-batch4'), None)
    old_text_video = next((item for item in image_intents if item.get('operation') == 'media.video.create'
        and item.get('payloadProfile') == 'video-6s-480p-no-audio'), None)
    if not image_intent or not old_text_video or old_text_video.get('state') != 'outcome_unknown':
        raise RuntimeError('OLD_MEDIA_INTENT_BOUNDARY_INVALID')
    start_ms = now_ms_from_iso(image_intent['createdAt'])
    end_ms = now_ms_from_iso(image_receipt['observedAt'])
    prompt_sha = sha(prompt)
    intent_id = choose_prepared_intent(image_intents, prompt_sha, EXPECTED_OWNER_SHA)
    pre_dispatch_recovery_kind = None
    if not capture_only:
        pre_dispatch_recovery_kind = assert_safe_pre_dispatch_recapture(intent_id, prompt_sha)

    async with async_playwright() as playwright:
        browser = await playwright.chromium.connect_over_cdp(f"http://127.0.0.1:{int(owner['cdpPort'])}")
        contexts = [context for context in browser.contexts]
        if len(contexts) != 1:
            raise RuntimeError('OWNED_CONTEXT_COUNT_INVALID')
        context, page = await verified_target_page(browser, role_entry)
        initial_state = await page.evaluate('''()=>{const video=[...document.querySelectorAll('[role=radio]')].find(x=>(x.getAttribute('aria-label')||x.innerText||'').trim()==='Video');const audio=[...document.querySelectorAll('button')].find(x=>(x.getAttribute('aria-label')||x.innerText||'').trim()==='Video audio');const composer=document.querySelector('[role=textbox]');return {videoSelected:video?.getAttribute('aria-checked')==='true',audioPressed:audio?.getAttribute('aria-pressed')??null,composerText:composer?.innerText??''}}''')
        global SAVED_UI_STATE
        SAVED_UI_STATE = initial_state
        source = await page_asset_selection(page, image_receipt['promptSha256'], start_ms, end_ms)
        if source.get('ownerStatus') != 200 or source.get('ownerMatch') is not True \
            or source.get('ownerEmail') is None or source.get('verified') is not True \
            or source.get('candidateCount') != 4 or not source.get('chosen', {}).get('assetUrl'):
            FAILURE_DIAGNOSTICS['imageSourceProof'] = {
                'ownerStatus': source.get('ownerStatus'), 'ownerBytes': source.get('ownerBytes'),
                'ownerMatch': source.get('ownerMatch') is True, 'ownerEmailPresent': isinstance(source.get('ownerEmail'), str),
                'assetOriginPresent': isinstance(source.get('assetOrigin'), str),
                'listing': source.get('listing'), 'candidateCount': source.get('candidateCount'),
                'historyVerified': source.get('verified') is True, 'historyProofSummary': source.get('historyProofSummary'),
                'chosenAssetUrlPresent': bool(source.get('chosen', {}).get('assetUrl')),
            }
            raise RuntimeError('EXACT_OWNER_IMAGE_TASK_NOT_VERIFIED')
        asset_url = source['chosen']['assetUrl']
        asset_id = source['chosen']['assetId']
        source_conversation_id = source['chosen']['sourceConversationId']
        cdp = await context.new_cdp_session(page)
        guard = AsyncMediaGuard(cdp, asset_url, prompt, asset_id)
        cdp.on('Fetch.requestPaused', guard.on_fetch_paused)
        cdp.on('Network.requestWillBeSent', guard.on_request)
        cdp.on('Network.requestWillBeSentExtraInfo', guard.on_extra_info)
        cdp.on('Network.responseReceived', guard.on_response)
        cdp.on('Network.loadingFailed', guard.on_loading_failed)

        async def websocket_handler(route):
            try:
                route.connect_to_server()
                def drop(_message):
                    guard.web_socket_frames_seen += 1
                    guard.web_socket_frames_blocked += 1
                route.on_message(drop)
            except Exception:
                try:
                    await route.close()
                except Exception:
                    pass

        await page.route_web_socket('wss://grok.com/**', websocket_handler)
        await cdp.send('Network.enable')
        await cdp.send('Network.setCacheDisabled', {'cacheDisabled': True})
        await cdp.send('Network.setBypassServiceWorker', {'bypass': True})
        await cdp.send('Fetch.enable', {'patterns': [{'urlPattern': '*', 'requestStage': 'Request'}]})
        post_url = 'https://grok.com/imagine/post/' + asset_id + '?' + urlencode({
            'scope': 'asset', 'conversation': source_conversation_id,
        })
        await page.goto(post_url, wait_until='domcontentloaded', timeout=90_000)
        await asyncio.sleep(1)
        use_text = page.get_by_text('Use', exact=True)
        try:
            await use_text.wait_for(state='visible', timeout=15_000)
        except Exception:
            raise RuntimeError('SOURCE_IMAGE_USE_CONTROL_NOT_VISIBLE')
        if await use_text.count() != 1:
            raise RuntimeError('SOURCE_IMAGE_USE_CONTROL_NOT_UNIQUE')
        await use_text.click(timeout=5000)
        mode_controls = await page.evaluate("""()=>{const visible=e=>{const r=e.getBoundingClientRect();return r.width>0&&r.height>0};return [...document.querySelectorAll('[aria-label],[aria-checked]')].filter(e=>{const label=(e.getAttribute('aria-label')||e.innerText||'').trim();return label==='Video'||label==='Image'}).map(e=>({tag:e.tagName,role:e.getAttribute('role'),aria:e.getAttribute('aria-label'),checked:e.getAttribute('aria-checked'),visible:visible(e)})).slice(0,12)}""")
        video_radio = page.locator('[aria-label="Video"]')
        try:
            await video_radio.wait_for(state='visible', timeout=15_000)
        except Exception:
            FAILURE_DIAGNOSTICS['videoModeControlCandidates'] = mode_controls
            FAILURE_DIAGNOSTICS['videoModeLocatorCount'] = await video_radio.count()
            raise RuntimeError('VIDEO_MODE_CONTROL_NOT_VISIBLE')
        video_count = await video_radio.count()
        FAILURE_DIAGNOSTICS['videoModeControlCandidates'] = mode_controls
        FAILURE_DIAGNOSTICS['videoModeLocatorCount'] = video_count
        if video_count != 1 or not await video_radio.is_visible():
            raise RuntimeError('VIDEO_MODE_CONTROL_NOT_UNIQUE')
        if await video_radio.get_attribute('aria-checked') != 'true':
            await video_radio.click(timeout=5000)
        if await video_radio.get_attribute('aria-checked') != 'true':
            raise RuntimeError('VIDEO_MODE_NOT_SELECTED')
        audio_button = page.get_by_role('button', name='Video audio')
        if await audio_button.count() != 1 or not await audio_button.is_visible():
            raise RuntimeError('VIDEO_AUDIO_CONTROL_NOT_UNIQUE')
        audio_initial = await audio_button.get_attribute('aria-pressed')
        if audio_initial == 'true':
            await audio_button.click(timeout=5000)
        if await audio_button.get_attribute('aria-pressed') != 'false':
            raise RuntimeError('VIDEO_AUDIO_PROFILE_NOT_SELECTED')
        resolution = page.get_by_role('button', name='Video resolution')
        duration = page.get_by_role('button', name='Video duration')
        if await resolution.count() != 1 or await duration.count() != 1:
            raise RuntimeError('VIDEO_PROFILE_CONTROLS_NOT_UNIQUE')
        resolution_text = (await resolution.inner_text()).strip()
        duration_text = (await duration.inner_text()).strip()
        if resolution_text != '480p' or duration_text != '6s':
            raise RuntimeError('VIDEO_PROFILE_DEFAULTS_NOT_SUPPORTED')
        composer = page.get_by_role('textbox', name='Ask Grok anything')
        if await composer.count() != 1 or not await composer.is_visible():
            raise RuntimeError('VIDEO_COMPOSER_NOT_UNIQUE')
        await composer.fill(prompt, timeout=15_000)
        await asyncio.sleep(250 / 1000)

        capture_started = True
        FAILURE_DIAGNOSTICS['visibleTaskButtons'] = await page.evaluate("""()=>{const root=document.querySelector('main')||document.body;const visible=e=>{const r=e.getBoundingClientRect();return r.width>0&&r.height>0};return [...root.querySelectorAll('button,[role=button]')].filter(visible).map(e=>({text:(e.innerText||'').trim().replace(/\\s+/g,' ').slice(0,48),aria:(e.getAttribute('aria-label')||'').slice(0,48),title:(e.getAttribute('title')||'').slice(0,48),testid:(e.getAttribute('data-testid')||'').slice(0,48),disabled:!!e.disabled,role:e.getAttribute('role')})).slice(-24)}""")
        submit = page.get_by_role('button', name='Make video', exact=True)
        if await submit.count() != 1 or not await submit.is_visible() or await submit.is_disabled():
            raise RuntimeError('MAKE_VIDEO_CONTROL_NOT_READY')
        await submit.click(timeout=5000)
        deadline = asyncio.get_running_loop().time() + 20
        while guard.capture is None and asyncio.get_running_loop().time() < deadline:
            await asyncio.sleep(0.05)
        if guard.capture is None:
            raise RuntimeError('NATIVE_IMAGE_REFERENCE_REQUEST_NOT_CAPTURED')
        await asyncio.sleep(1.5)
        await guard.quiesce_events()
        guard.capture['intentId'] = intent_id
        guard.capture['browserAbortVerified'] = guard.capture_abort_proof()['verified']
        guard.capture['serverWritesDelivered'] = guard.server_writes_delivered
        guard.capture['ssoCookieObserved'] = 'sso' in guard.target_cookie_names
        abort = guard.capture_abort_proof()
        body_match, body_shape = ui_source_body_matches(guard.capture['bodyText'], prompt, asset_id)
        FAILURE_DIAGNOSTICS['nativeCapture'] = {
            'pathClass': safe_path_class('https://grok.com' + guard.capture.get('path', '/')),
            'bodyShape': body_shape,
            'abortProof': abort,
            'dynamicHeaderNames': sorted(guard.capture.get('headers', {})),
            'ordinaryHeaderNames': sorted(guard.capture.get('ordinaryHeaders', {})),
            'ssoCookieObserved': guard.capture.get('ssoCookieObserved') is True,
            'matchingSdkAttempts': guard.matching_video_attempts,
        }

        native_read = guard.safe_browser_proof()['asset']
        if native_read.get('response', {}).get('status') != 200 or native_read.get('response', {}).get('mimeType') != 'image/jpeg' \
            or native_read.get('fromDiskCache') is True or native_read.get('fromServiceWorker') is True \
            or native_read.get('ssoObserved') is not True:
            raise RuntimeError('NATIVE_SOURCE_IMAGE_READ_NOT_BOUND')
        session_bundle, asset_context = await build_session_context(context, asset_url, guard.asset['headers'], source['ownerEmail'])
        if asset_context.get('assetOrigin') != source.get('assetOrigin') or source.get('assetOrigin') != 'https://assets.grok.com':
            raise RuntimeError('ASSET_SERVER_ORIGIN_MISMATCH')

        existing = json.loads(INTENT_FILE.read_text()).get('intents', [])
        if intent_id not in [item.get('intentId') for item in existing]:
            prepare_packet = {
                'operation': 'media.video.create',
                'payloadProfile': 'video-image-reference-6s-480p-no-audio',
                'prompt': prompt,
                'sessionBundle': session_bundle,
                'expectedIdentity': source['ownerEmail'],
                'intentId': intent_id,
            }
            prepared, _prepared_stdout = await run_cli(
                ['media', 'intent-prepare', '--session-stdin', '--python', CFFI_PYTHON], prepare_packet,
            )
            FAILURE_DIAGNOSTICS['intentPrepareResult'] = {
                key: prepared.get(key) for key in ('errorCode', 'processExitCode', 'state', 'attemptNumber', 'ownerVerified')
                if key in prepared
            }
            if prepared.get('state') != 'prepared' or prepared.get('attemptNumber') != 1 \
                or prepared.get('ownerVerified') is not True:
                raise RuntimeError('IMAGE_REFERENCE_INTENT_PREPARE_FAILED')
        else:
            intent = next(item for item in existing if item.get('intentId') == intent_id)
            allowed_intent_state = intent.get('state') == 'prepared' \
                or pre_dispatch_recovery_kind == 'operation_journal_begin' \
                and intent.get('state') == 'failed' and intent.get('reasonCode') == 'JOURNAL_STATE_INVALID'
            if not allowed_intent_state or intent.get('attemptNumber') != 1 \
                or intent.get('promptSha256') != prompt_sha or intent.get('ownerIdentityDigest') != EXPECTED_OWNER_SHA \
                or intent.get('payloadProfile') != 'video-image-reference-6s-480p-no-audio':
                raise RuntimeError('IMAGE_REFERENCE_INTENT_REUSE_MISMATCH')

        if not body_match or abort.get('verified') is not True or guard.capture.get('ssoCookieObserved') is not True \
            or set(guard.capture.get('headers', {})) != SAFE_SDK_HEADERS:
            raise RuntimeError('NATIVE_IMAGE_REFERENCE_CAPTURE_NOT_VERIFIED')
        supported_direct_route = guard.capture.get('path') == '/rest/app-chat/conversations/new' \
            and body_shape.get('videoMode') == 'imageToVideo' and body_shape.get('exactTopLevelSchema') is True \
            and body_shape.get('exactInputSchema') is True and body_shape.get('exactResponseMetadata') is True \
            and body_shape.get('profileMatched') is True

        if capture_only or not supported_direct_route:
            capture_receipt = {
                'schemaVersion': 1,
                'operation': 'media.video.create.image_reference.capture',
                'observedAt': now_iso(),
                'ownerVerified': True,
                'sourceImageTaskVerified': True,
                'assetServerConfig': {'present': True, 'origin': asset_context['assetOrigin'],
                    'source': 'current_page_first_party_inline_bootstrap'},
                'assetNativeRead': {
                    'status': native_read['response']['status'], 'mimeType': native_read['response']['mimeType'],
                    'fromDiskCache': native_read['fromDiskCache'], 'fromServiceWorker': native_read['fromServiceWorker'],
                    'protocol': native_read['protocol'], 'ssoCookieObserved': True,
                    'ordinaryHeaderNames': native_read['requestHeaderNames'],
                },
                'intentIdSha256': sha(intent_id),
                **safe_capture_summary(guard.capture, body_shape, abort, guard, source, intent_id, prompt),
                'supportedDirectRoute': supported_direct_route,
                'directVideoCreateRequestsSent': 0,
                'automaticRetries': 0,
            }
            atomic_receipt(CAPTURE_RECEIPT, capture_receipt)
            final = capture_receipt
        else:
            # We have captured one exact native imageToVideo request and its CDP Request-stage abort ACK.
            video_packet = {
                'sessionBundle': session_bundle,
                'expectedIdentity': source['ownerEmail'],
                'prompt': prompt,
                'capturedRequest': guard.capture,
                'assetRequestContext': asset_context,
                'generationMode': 'image_reference',
                'referenceAssetId': asset_id,
                'referencePromptSha256': image_receipt['promptSha256'],
            }
            submission, _submission_stdout = await run_cli(
                ['media', 'video-submit', '--session-stdin', '--confirm', '--intent-id', intent_id,
                 '--python', CFFI_PYTHON, '--output', 'json'], video_packet,
            )
            write_count = submission.get('writeRequestsSent')
            direct_write_count = write_count if write_count in (0, 1) else None
            output = {
                'schemaVersion': 1,
                'operation': 'media.video.create.image_reference.direct_live',
                'observedAt': now_iso(),
                'ownerVerified': True,
                'sourceImageTaskVerified': True,
                'assetServerConfig': {'present': True, 'origin': asset_context['assetOrigin'],
                    'source': 'current_page_first_party_inline_bootstrap'},
                'assetNativeRead': {
                    'status': native_read['response']['status'], 'mimeType': native_read['response']['mimeType'],
                    'fromDiskCache': native_read['fromDiskCache'], 'fromServiceWorker': native_read['fromServiceWorker'],
                    'protocol': native_read['protocol'], 'ssoCookieObserved': True,
                    'ordinaryHeaderNames': native_read['requestHeaderNames'],
                },
                'intentIdSha256': sha(intent_id),
                **safe_capture_summary(guard.capture, body_shape, abort, guard, source, intent_id, prompt),
                'directSubmission': submission,
                'finalState': submission.get('state'),
                'directVideoCreateRequestsSent': direct_write_count,
                'automaticRetries': 0,
                'promptPersisted': False,
                'rawIdsKeysUrlsPersisted': False,
                'cookiesOrTokensPersisted': False,
                'rawFramesPersisted': False,
                'publicSharingChanged': False,
                'purchaseOrSubscriptionChanged': False,
            }
            atomic_receipt(LIVE_RECEIPT, output, replace=LIVE_RECEIPT.exists())
            final = output

        # The safe response audit is already atomic. Now reset and restore the original UI preferences.
        await restore_page(page, cdp, websocket_handler, initial_state, role_entry, guard)
        for origin in session_bundle.get('origins', []):
            for cookie in origin.get('cookies', []):
                cookie['value'] = ''
        for cookie in asset_context.get('cookies', []):
            cookie['value'] = ''
        guard.capture['bodyText'] = ''
        for mapping in (guard.capture.get('headers', {}), guard.capture.get('ordinaryHeaders', {})):
            for key in list(mapping):
                mapping[key] = ''
        prompt = ''
        source['ownerEmail'] = ''
        print(json.dumps(final, separators=(',', ':')), flush=True)


def print_safe_failure(error, reset_verified):
    code = getattr(error, 'code', None)
    if not isinstance(code, str) or not re.fullmatch(r'[A-Z][A-Z0-9_]{0,63}', code):
        code = str(error) if isinstance(error, RuntimeError) and re.fullmatch(r'[A-Z][A-Z0-9_]{0,63}', str(error)) else 'MEDIA_REFERENCE_VIDEO_RUN_FAILED'
    print(json.dumps({'state': 'preflight_failed', 'errorCode': code, 'sameTargetResetVerified': reset_verified,
        'diagnostics': FAILURE_DIAGNOSTICS,
        'rawPromptOrIDsPersisted': False}), flush=True)


if __name__ == '__main__':
    try:
        asyncio.run(main())
    except Exception as error:
        reset_verified = asyncio.run(emergency_reset())
        print_safe_failure(error, reset_verified)
        raise SystemExit(2)
