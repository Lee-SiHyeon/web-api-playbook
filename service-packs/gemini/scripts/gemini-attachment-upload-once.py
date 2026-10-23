#!/usr/bin/env python3
"""Capture one new Gemini file-upload init request under Fetch guard, then direct-replay it once."""

import base64
import datetime
import fcntl
import hashlib
import json
import os
import pathlib
import re
import shutil
import subprocess
import sys
import tempfile
import time
import traceback
import urllib.parse

from playwright.sync_api import sync_playwright


REPO = pathlib.Path(__file__).resolve().parent.parent
RUNTIME = pathlib.Path.home() / '.nad-scratch' / 'provider-runtime-20261005'
OWNER_FILE = RUNTIME / 'runtime-owner.json'
ROLE_FILE = RUNTIME / 'page-role-registry.json'
ROLE_LOCK = RUNTIME / 'page-role-registry.lock'
PAGE_ROLE = 'codex-gemini-uploads-20261006'
EXPECTED_ACCOUNT_SHA256 = '23e57131977ce522bacf6649eb27538770828a890f7a65589ec4f0960a84b3d7'
CALLER_INTENT = 'gemini-attachment-upload-verification-20261006-v1'
FILE_NAME = 'api-protocol42.txt'
FILE_CONTENT = b'PROTOCOL42:42\n'
FILE_PATH = RUNTIME / FILE_NAME
CONTRACT_FILE = REPO / 'discovery' / 'observed-contract.json'
RECEIPT_FILE = REPO / 'discovery' / 'gemini-attachment-upload-direct-2026-10-06.json'
SERVICE_ORIGIN = 'https://gemini.google.com'
UPLOAD_ORIGIN = 'https://push.clients6.google.com'
READ_RPC_IDS = {
    'MaZiqc', 'hNvQHb', 'ESY5D', 'otAQ7b', 'unqWSc', 'OXxBcc', 'sJBwce', 'DYBcR',
    'whPPme', 'GPRiHf', 'maGuAc', 'VxUbXb', 'V8rlHe', 'aPya6c', 'cYRIkd', 'ozz5Z',
    'K4WWud', 'I4z33b', 'o30O0e', 'Bsxleb', 'ku4Jyf', 'XhaU0b', 'qpEbW', 'MyzX6c',
}


class SafeFailure(Exception):
    def __init__(self, code, details=None):
        self.code = code
        self.details = details or {}


CURRENT_STAGE = 'startup'


def read_json(path):
    return json.loads(path.read_text(encoding='utf-8'))


def write_json_atomic(path, value):
    fd, temp = tempfile.mkstemp(prefix=path.name + '.', suffix='.tmp', dir=str(path.parent))
    try:
        os.fchmod(fd, 0o600)
        with os.fdopen(fd, 'w', encoding='utf-8') as stream:
            json.dump(value, stream, ensure_ascii=False, indent=2)
            stream.write('\n')
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temp, path)
    except Exception:
        pathlib.Path(temp).unlink(missing_ok=True)
        raise


def persist_attempt_receipt(attempt):
    prior_attempts = []
    if RECEIPT_FILE.exists():
        prior = read_json(RECEIPT_FILE)
        if prior.get('callerIntent') == CALLER_INTENT:
            prior_attempts = prior.get('attempts') if isinstance(prior.get('attempts'), list) else [prior]
    attempts = prior_attempts + [attempt]
    direct_count = sum(
        item.get('directApi', {}).get('directDispatchCount', 0)
        for item in attempts if isinstance(item, dict) and isinstance(item.get('directApi'), dict)
    )
    document = {
        'schema': 1,
        'service': 'gemini-web',
        'operation': 'attachment_upload',
        'callerIntent': CALLER_INTENT,
        'attemptCount': len(attempts),
        'directUploadDispatchCount': direct_count,
        'attempts': attempts,
        'rawBodiesOrCredentialValuesPersisted': False,
        'rawOwnerEmailPersisted': False,
    }
    write_json_atomic(RECEIPT_FILE, document)
    return document


def scrub_strings(value):
    if isinstance(value, dict):
        for key, item in list(value.items()):
            if isinstance(item, str):
                value[key] = ''
            else:
                scrub_strings(item)
    elif isinstance(value, list):
        for index, item in enumerate(value):
            if isinstance(item, str):
                value[index] = ''
            else:
                scrub_strings(item)


def cookie_names(cookie_header):
    names = []
    for item in str(cookie_header or '').split(';'):
        if '=' not in item:
            continue
        name = item.split('=', 1)[0].strip()
        if re.fullmatch(r'[A-Za-z0-9_.$-]{1,128}', name):
            names.append(name)
    return sorted(set(names))


def safe_ref(raw_url):
    parsed = urllib.parse.urlsplit(raw_url)
    if parsed.scheme != 'https' or not parsed.hostname or parsed.username or parsed.password or parsed.fragment:
        raise SafeFailure('UPLOAD_CAPTURE_URL_INVALID')
    path_family = '/'.join(
        '{id}' if len(segment) > 40 or re.fullmatch(r'[0-9a-f-]{16,}', segment, re.I) else segment
        for segment in parsed.path.split('/')
    )
    return {
        'origin': f'https://{parsed.hostname.lower()}',
        'pathFamily': path_family,
        'queryKeyNames': sorted({key for key, _ in urllib.parse.parse_qsl(parsed.query, keep_blank_values=True)}),
    }


def node_runtime():
    preferred = pathlib.Path.home() / '.npm/_npx/387698761821791d/node_modules/node/bin/node'
    node = os.environ.get('NODE24_BIN') or (str(preferred) if preferred.is_file() else shutil.which('node'))
    if not node:
        raise SafeFailure('NODE_RUNTIME_MISSING')
    return node


def direct_client_once(expected_owner, session, capture, upload_cookies, file_info):
    node = node_runtime()
    payload = {
        'expectedOwner': expected_owner,
        'callerIntent': CALLER_INTENT,
        'session': session,
        'capture': {
            'url': capture['url'],
            'method': capture['method'],
            'contentType': capture['contentType'],
            'bodyBase64': base64.b64encode(capture['body']).decode('ascii'),
            'declaredFileBytes': capture['declaredFileBytes'],
            'headerNames': capture['headerNames'],
            'headers': dict(capture['headers']),
        },
        'uploadCookies': upload_cookies,
        'file': {
            'name': file_info['name'],
            'mimeType': file_info['mimeType'],
            'bodyBase64': base64.b64encode(FILE_CONTENT).decode('ascii'),
        },
    }
    env = {key: os.environ[key] for key in (
        'PATH', 'HOME', 'LANG', 'LC_ALL', 'TMPDIR', 'SSL_CERT_FILE', 'SSL_CERT_DIR',
    ) if key in os.environ}
    env['GEMINI_UPLOAD_ORCHESTRATOR'] = '1'
    wire = json.dumps(payload, separators=(',', ':'))
    try:
        process = subprocess.run(
            [node, str(REPO / 'scripts' / 'gemini-attachment-upload-once.mjs')],
            input=wire, text=True, capture_output=True, timeout=180, env=env, check=False,
        )
    except subprocess.TimeoutExpired as error:
        raise SafeFailure('ATTACHMENT_UPLOAD_DIRECT_OUTCOME_UNKNOWN', {'directDispatchCount': 1}) from error
    finally:
        wire = ''
        scrub_strings(payload)
        capture['body'][:] = b'\0' * len(capture['body'])
    try:
        result = json.loads(process.stdout)
    except Exception as error:
        raise SafeFailure('ATTACHMENT_UPLOAD_RESULT_INVALID') from error
    if not isinstance(result, dict):
        raise SafeFailure('ATTACHMENT_UPLOAD_RESULT_INVALID')
    if process.returncode != 0 and result.get('status') != 'failed':
        raise SafeFailure('ATTACHMENT_UPLOAD_RESULT_INVALID')
    return result


def main_inner():
    global CURRENT_STAGE
    CURRENT_STAGE = 'stable_intent_preflight'
    if RECEIPT_FILE.exists():
        prior = read_json(RECEIPT_FILE)
        if prior.get('callerIntent') == CALLER_INTENT:
            prior_attempts = prior.get('attempts') if isinstance(prior.get('attempts'), list) else [prior]
            if any((item.get('directApi') or {}).get('directDispatchCount', 0) > 0
                    for item in prior_attempts if isinstance(item, dict)):
                raise SafeFailure('ATTACHMENT_UPLOAD_INTENT_ALREADY_DISPATCHED')
    owner = read_json(OWNER_FILE)
    if owner.get('taskOwned') is not True or not isinstance(owner.get('chromePid'), int):
        raise SafeFailure('OWNED_RUNTIME_INVALID')
    process_args = pathlib.Path(f"/proc/{owner['chromePid']}/cmdline").read_bytes().split(b'\0')
    if ('--user-data-dir=' + owner['profile']).encode() not in process_args:
        raise SafeFailure('OWNED_RUNTIME_PROFILE_MISMATCH')
    contract = read_json(CONTRACT_FILE)
    upload_contract = contract.get('attachmentUpload')
    if not isinstance(upload_contract, dict):
        raise SafeFailure('UPLOAD_CONTRACT_NOT_INSTALLED')
    with open(ROLE_LOCK, 'a+') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        registry = read_json(ROLE_FILE)
        role_info = registry.get('activePageRoles', {}).get(PAGE_ROLE, {})
        if (registry.get('taskOwned') is not True or registry.get('runtimeChromePid') != owner['chromePid']
                or role_info.get('origin') != SERVICE_ORIGIN or role_info.get('exactMarkerCount') != 1):
            raise SafeFailure('UPLOAD_PAGE_ROLE_NOT_REGISTERED')
        fcntl.flock(lock, fcntl.LOCK_UN)
    if FILE_PATH.exists():
        if FILE_PATH.read_bytes() != FILE_CONTENT:
            raise SafeFailure('UPLOAD_TEST_FILE_MISMATCH')
    else:
        FILE_PATH.write_bytes(FILE_CONTENT)
        FILE_PATH.chmod(0o600)

    expected_owner = ''
    session = None
    upload_cookies = []
    capture = None
    file_info = None
    page = None
    route_handler = None
    browser_dispatch_count = 0
    blocked_requests = []
    reset_quiet_verified = False
    owner_digest_matched = False
    direct_result = None
    receipt = None
    state = None
    page = None
    route_handler = None
    reset_quiet_verified = False
    try:
        with sync_playwright() as playwright:
            CURRENT_STAGE = 'owned_cdp_connect'
            browser = playwright.chromium.connect_over_cdp(f"http://127.0.0.1:{owner['cdpPort']}")
            if len(browser.contexts) != 1:
                raise SafeFailure('OWNED_CONTEXT_COUNT_INVALID')
            context = browser.contexts[0]
            matching_pages = []
            for candidate in context.pages:
                try:
                    if candidate.evaluate('() => window.name') == PAGE_ROLE:
                        matching_pages.append(candidate)
                except Exception:
                    pass
            if len(matching_pages) != 1:
                raise SafeFailure('UPLOAD_PAGE_ROLE_AMBIGUOUS')
            page = matching_pages[0]
            if page.url != 'about:blank':
                raise SafeFailure('UPLOAD_PAGE_NOT_RESET')
            state = {
                'capture': None,
                'uploadAttemptCount': 0,
                'otherBlockedCount': 0,
                'lateRequestCount': 0,
                'lateBlockedCount': 0,
                'resetStarted': False,
            }

            def guard(route):
                request = route.request
                if state['resetStarted']:
                    state['lateRequestCount'] += 1
                parsed = urllib.parse.urlsplit(request.url)
                rpc = urllib.parse.parse_qs(parsed.query).get('rpcids', [''])[0]
                if request.method in ('GET', 'HEAD', 'OPTIONS') or (
                    parsed.hostname == 'gemini.google.com' and '/batchexecute' in parsed.path and rpc in READ_RPC_IDS
                ):
                    route.continue_()
                    return
                body = request.post_data_buffer or b''
                header_values = request.all_headers()
                metadata = {
                    'method': request.method,
                    'origin': f'{parsed.scheme}://{parsed.netloc}',
                    'pathFamily': re.sub(r'[A-Za-z0-9_-]{40,}', '{id}', parsed.path),
                    'queryKeyNames': sorted({key for key, _ in urllib.parse.parse_qsl(parsed.query, keep_blank_values=True)}),
                    'rpcId': rpc,
                    'bodyBytes': len(body),
                    'bodySha256': hashlib.sha256(body).hexdigest(),
                    'headerNames': sorted(header_values),
                }
                is_upload_start = (
                    parsed.hostname == UPLOAD_ORIGIN.removeprefix('https://')
                    and parsed.path == '/upload/'
                    and request.method == 'POST'
                    and header_values.get('x-goog-upload-command') == 'start'
                    and header_values.get('x-goog-upload-protocol') == 'resumable'
                )
                if is_upload_start:
                    state['uploadAttemptCount'] += 1
                    if state['capture'] is None:
                        state['capture'] = {
                            'url': request.url,
                            'method': request.method,
                            'contentType': header_values.get('content-type', '').split(';', 1)[0].strip().lower(),
                            'body': bytearray(body),
                            'headerNames': sorted(header_values),
                            'headers': {
                                name: value for name, value in header_values.items()
                                if name in upload_contract['source']['headerNames'] and name != 'cookie'
                            },
                            'cookieNames': cookie_names(header_values.get('cookie', '')),
                            'declaredFileBytes': int(header_values.get('x-goog-upload-header-content-length', '0') or '0'),
                            'requestMetadata': metadata,
                        }
                else:
                    state['otherBlockedCount'] += 1
                    if state['resetStarted']:
                        state['lateBlockedCount'] += 1
                blocked_requests.append(metadata)
                route.abort('blockedbyclient')

            try:
                CURRENT_STAGE = 'guard_install'
                route_handler = guard
                page.route('**/*', route_handler)
                CURRENT_STAGE = 'gemini_app_load'
                page.goto(SERVICE_ORIGIN + '/app', wait_until='domcontentloaded', timeout=60000)
                if not page.url.startswith(SERVICE_ORIGIN + '/'):
                    raise SafeFailure('GEMINI_APP_NOT_REACHED')
                page.evaluate('(marker) => window.name = marker', PAGE_ROLE)
                if page.evaluate('() => window.name') != PAGE_ROLE:
                    raise SafeFailure('UPLOAD_PAGE_MARKER_MISMATCH')
                page.wait_for_timeout(5000)
                CURRENT_STAGE = 'owner_gate'
                html = page.content()
                page_emails = re.findall(r'[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}', html)
                owner_match = next((email for email in page_emails
                    if hashlib.sha256(email.strip().casefold().encode()).hexdigest() == EXPECTED_ACCOUNT_SHA256), None)
                if not owner_match:
                    raise SafeFailure('UPLOAD_OWNER_MISMATCH')
                expected_owner = owner_match
                owner_digest_matched = True
                CURRENT_STAGE = 'upload_menu_open'
                file_inputs = page.locator('input[type=file]')
                if file_inputs.count() == 0:
                    upload_menu = page.locator('button[aria-label="업로드 및 도구"]')
                    if upload_menu.count() != 1 or not upload_menu.is_visible() or not upload_menu.is_enabled():
                        raise SafeFailure('UPLOAD_MENU_NOT_FOUND')
                    upload_menu.click()
                    CURRENT_STAGE = 'file_input_wait'
                    input_deadline = time.monotonic() + 8
                    while file_inputs.count() == 0 and time.monotonic() < input_deadline:
                        page.wait_for_timeout(250)
                file_inputs = page.locator('input[type=file]')
                if file_inputs.count() == 0:
                    raise SafeFailure('UPLOAD_FILE_INPUT_NOT_FOUND', {'fileInputCount': file_inputs.count()})
                accepted_types = file_inputs.first.get_attribute('accept') or ''
                if '.txt' not in accepted_types.lower():
                    raise SafeFailure('UPLOAD_FILE_TYPE_NOT_ACCEPTED')
                CURRENT_STAGE = 'local_file_selection'
                file_inputs.first.set_input_files(str(FILE_PATH))
                page.wait_for_timeout(1500)
                file_info = {
                    'name': FILE_NAME,
                    'size': len(FILE_CONTENT),
                    'mimeType': 'text/plain',
                    'accept': accepted_types,
                }
                CURRENT_STAGE = 'native_init_capture_validation'
                if state['capture'] is None:
                    raise SafeFailure('UPLOAD_INIT_CAPTURE_NOT_OBSERVED')
                if (file_info.get('name') != FILE_NAME or file_info.get('size') != len(FILE_CONTENT)
                        or state['capture']['requestMetadata']['origin'] != UPLOAD_ORIGIN
                        or state['capture']['requestMetadata']['pathFamily'] != '/upload/'
                        or state['capture']['contentType'] != upload_contract['source']['contentType']
                        or bytes(state['capture']['body']) != (upload_contract['source']['metadataBodyPrefix'] + FILE_NAME).encode('utf-8')
                        or state['capture']['declaredFileBytes'] != len(FILE_CONTENT)):
                    raise SafeFailure('UPLOAD_INIT_CAPTURE_MISMATCH', {
                        'fileNameMatched': file_info.get('name') == FILE_NAME,
                        'fileSizeMatched': file_info.get('size') == len(FILE_CONTENT),
                        'originMatched': state['capture']['requestMetadata']['origin'] == UPLOAD_ORIGIN,
                        'pathFamilyMatched': state['capture']['requestMetadata']['pathFamily'] == '/upload/',
                        'contentTypeMatched': state['capture']['contentType'] == upload_contract['source']['contentType'],
                        'metadataBodyMatched': bytes(state['capture']['body']) == (upload_contract['source']['metadataBodyPrefix'] + FILE_NAME).encode('utf-8'),
                        'declaredFileBytesMatched': state['capture']['declaredFileBytes'] == len(FILE_CONTENT),
                        'capturedInitBodyBytes': len(state['capture']['body']),
                        'capturedInitBodySha256': hashlib.sha256(state['capture']['body']).hexdigest(),
                    })
                expected_cookie_names = sorted(upload_contract['source']['cookieNames'])
                if state['capture']['cookieNames'] != expected_cookie_names:
                    raise SafeFailure('UPLOAD_NATIVE_COOKIE_NAME_SET_MISMATCH', {
                        'expectedCookieNameCount': len(expected_cookie_names),
                        'observedCookieNameCount': len(state['capture']['cookieNames']),
                    })
                required_auth_names = set(contract['auth']['cookieNames'])
                auth_jar = context.cookies(SERVICE_ORIGIN)
                auth_values = {item['name']: item['value'] for item in auth_jar if item.get('name') in required_auth_names}
                if set(auth_values) != required_auth_names:
                    raise SafeFailure('UPLOAD_GEMINI_SESSION_INCOMPLETE')
                session = {
                    'version': 1,
                    'service': contract['service'],
                    'origin': SERVICE_ORIGIN,
                    'capturedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(),
                    'cookies': [{'name': name, 'value': value} for name, value in auth_values.items()],
                    'headers': {},
                    'requestHeaders': {},
                }
                scope_by_name = {scope['name']: scope for scope in upload_contract['source']['cookieScopes']}
                push_jar = context.cookies(state['capture']['url'])
                selected_cookies = []
                seen = set()
                for item in push_jar:
                    name = item.get('name')
                    if name not in scope_by_name:
                        continue
                    scope = scope_by_name[name]
                    if (item.get('domain') != scope['domain'] or item.get('path') != scope['path']
                            or item.get('secure') is not scope['secure'] or name in seen):
                        raise SafeFailure('UPLOAD_COOKIE_SCOPE_MISMATCH')
                    selected_cookies.append({key: item.get(key) for key in ('name', 'value', 'domain', 'path', 'secure', 'expires') if key in item})
                    seen.add(name)
                if sorted(seen) != expected_cookie_names:
                    raise SafeFailure('UPLOAD_CURRENT_COOKIE_SET_INCOMPLETE', {
                        'expectedCookieNameCount': len(expected_cookie_names), 'currentScopedCookieNameCount': len(seen),
                    })
                upload_cookies = selected_cookies
                capture = state['capture']
                CURRENT_STAGE = 'guarded_page_reset'
                page.goto('about:blank', wait_until='domcontentloaded', timeout=30000)
                page.evaluate('(marker) => window.name = marker', PAGE_ROLE)
                state['resetStarted'] = True
                page.wait_for_timeout(1600)
                reset_before_direct = page.url == 'about:blank' and page.evaluate('() => window.name') == PAGE_ROLE
                if not reset_before_direct or state['lateRequestCount'] or state['lateBlockedCount']:
                    raise SafeFailure('UPLOAD_PAGE_RESET_QUIET_FAILED', {
                        'lateRequestCount': state['lateRequestCount'],
                        'lateBlockedRequestCount': state['lateBlockedCount'],
                    })

                CURRENT_STAGE = 'direct_client_transaction'
                direct_result = direct_client_once(expected_owner, session, capture, upload_cookies, file_info)
                CURRENT_STAGE = 'post_direct_quiet'
                page.wait_for_timeout(1600)
                reset_quiet_verified = page.url == 'about:blank' and page.evaluate('() => window.name') == PAGE_ROLE \
                    and state['lateRequestCount'] == 0 and state['lateBlockedCount'] == 0
                if not reset_quiet_verified:
                    raise SafeFailure('UPLOAD_PAGE_RESET_QUIET_FAILED', {
                        'lateRequestCount': state['lateRequestCount'],
                        'lateBlockedRequestCount': state['lateBlockedCount'],
                    })
                try:
                    page.unroute('**/*', route_handler)
                except Exception:
                    pass
                browser_upload_count = state['uploadAttemptCount']
                native_meta = capture['requestMetadata']
                direct = direct_result.get('result') if isinstance(direct_result, dict) else None
                direct_status = direct_result.get('status') if isinstance(direct_result, dict) else 'failed'
                dispatch_count = direct.get('directDispatchCount') if isinstance(direct, dict) else direct_result.get('directDispatchCount', 0)
                receipt = {
                    'schema': 1,
                    'service': 'gemini-web',
                    'operation': 'attachment_upload',
                    'callerIntent': CALLER_INTENT,
                    'recordedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(),
                    'ownerDigestMatchedApproved': owner_digest_matched,
                    'file': {
                        'name': FILE_NAME,
                        'mimeType': file_info['mimeType'],
                        'bytes': len(FILE_CONTENT),
                        'sha256': hashlib.sha256(FILE_CONTENT).hexdigest(),
                    },
                    'nativeCapture': {
                        'method': native_meta['method'],
                        'origin': native_meta['origin'],
                        'pathFamily': native_meta['pathFamily'],
                        'queryKeyNames': native_meta['queryKeyNames'],
                        'bodyBytes': native_meta['bodyBytes'],
                        'bodySha256': native_meta['bodySha256'],
                        'bodyContentType': capture['contentType'],
                        'bodyContainsExactFilename': True,
                        'headerNames': native_meta['headerNames'],
                        'ordinaryCookieNames': capture['cookieNames'],
                        'protocol': capture['headers'].get('x-goog-upload-protocol'),
                        'command': capture['headers'].get('x-goog-upload-command'),
                        'declaredFileBytes': capture['declaredFileBytes'],
                        'browserInitAttemptCount': browser_upload_count,
                        'browserDispatchCount': 0,
                    },
                    'directApi': {
                        'status': direct_status,
                        'errorCode': direct_result.get('errorCode') if isinstance(direct_result, dict) and direct_result.get('status') == 'failed' else None,
                        'errorStage': direct_result.get('stage') if isinstance(direct_result, dict) else None,
                        'directDispatchCount': dispatch_count,
                        'httpRequestCount': direct.get('httpRequestCount', direct_result.get('httpRequestCount')) if isinstance(direct, dict) else direct_result.get('httpRequestCount'),
                        'result': direct,
                        'rawUploadUrlPersisted': False,
                        'rawResponseBodiesPersisted': False,
                        'cookieValuesPersisted': False,
                    },
                    'cleanup': {
                        'cancelSupportedByObservedGeminiUiContract': False,
                        'cancelAttempted': False,
                        'conversationMessageSent': False,
                        'newTestFileOnly': True,
                    },
                    'guardLifecycle': {
                        'resetBeforeDirectApi': True,
                        'resetQuietVerifiedThroughDisconnect': reset_quiet_verified,
                        'lateBlockedRequestCount': state['lateBlockedCount'],
                        'browserClosed': False,
                        'contextClosed': False,
                    },
                    'rawBodiesOrCredentialValuesPersisted': False,
                    'rawOwnerEmailPersisted': False,
                }
                CURRENT_STAGE = 'safe_receipt_write'
                persist_attempt_receipt(receipt)
                return {
                'status': direct_status,
                'errorCode': direct_result.get('errorCode') if isinstance(direct_result, dict) and direct_result.get('status') == 'failed' else None,
                    'receiptPath': str(RECEIPT_FILE),
                    'ownerDigestMatchedApproved': owner_digest_matched,
                    'nativeBrowserDispatchCount': 0,
                    'browserInitAttemptCount': browser_upload_count,
                    'directDispatchCount': dispatch_count,
                    'directHttpRequestCount': receipt['directApi']['httpRequestCount'],
                    'uploadedFileReadbackVerified': bool(direct and direct.get('uploadedFileReadbackVerified')),
                    'fileBytes': len(FILE_CONTENT),
                    'fileSha256': hashlib.sha256(FILE_CONTENT).hexdigest(),
                    'cancelSupported': False,
                    'cancelAttempted': False,
                    'resetQuietVerified': reset_quiet_verified,
                    'receiptPersisted': True,
                }
            finally:
                if page is not None:
                    try:
                        if page.url != 'about:blank' or page.evaluate('() => window.name') != PAGE_ROLE:
                            page.goto('about:blank', wait_until='domcontentloaded', timeout=30000)
                            page.evaluate('(marker) => window.name = marker', PAGE_ROLE)
                            if state is not None:
                                state['resetStarted'] = True
                        page.wait_for_timeout(1600)
                        reset_quiet_verified = page.url == 'about:blank' and page.evaluate('() => window.name') == PAGE_ROLE \
                            and (state is None or (state.get('lateRequestCount', 0) == 0 and state.get('lateBlockedCount', 0) == 0))
                    finally:
                        if route_handler is not None:
                            try:
                                page.unroute('**/*', route_handler)
                            except Exception:
                                pass

    finally:
        expected_owner = ''
        if capture and isinstance(capture.get('body'), bytearray):
            capture['body'][:] = b'\0' * len(capture['body'])
        if isinstance(session, dict):
            for item in session.get('cookies', []):
                item['value'] = ''
            session.clear()
        if isinstance(upload_cookies, list):
            for item in upload_cookies:
                item['value'] = ''
            upload_cookies.clear()
        try:
            FILE_PATH.unlink(missing_ok=True)
        except Exception:
            pass


def main():
    try:
        result = main_inner()
        sys.stdout.write(json.dumps(result, ensure_ascii=False) + '\n')
        return 0 if result.get('status') in ('verified', 'start_rejected', 'server_response_needs_readback') else 3
    except SafeFailure as error:
        sys.stdout.write(json.dumps({'status': 'failed', 'errorCode': error.code, 'details': error.details}, ensure_ascii=False) + '\n')
        return 3
    except Exception as error:
        script_frames = [frame for frame in traceback.extract_tb(error.__traceback__)
            if frame.filename.endswith('gemini-attachment-upload-once.py')] if error.__traceback__ else []
        frame = script_frames[-1] if script_frames else None
        sys.stdout.write(json.dumps({
            'status': 'failed',
            'errorCode': 'ATTACHMENT_UPLOAD_RUNNER_FAILED',
            'errorClass': type(error).__name__,
            'stage': CURRENT_STAGE,
            **({'errorLine': frame.lineno, 'errorFunction': frame.name} if frame else {}),
        }) + '\n')
        return 3


if __name__ == '__main__':
    sys.exit(main())
