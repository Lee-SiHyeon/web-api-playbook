#!/usr/bin/env python3
"""Capture a guarded Gemini upload continuation after forwarding a real API start response."""

import base64
import datetime
import fcntl
import hashlib
import json
import os
import pathlib
import re
import select
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.parse

from playwright.sync_api import sync_playwright


REPO = pathlib.Path(__file__).resolve().parent.parent
RUNTIME = pathlib.Path.home() / '.nad-scratch' / 'provider-runtime-20261005'
OWNER_FILE = RUNTIME / 'runtime-owner.json'
ROLE_FILE = RUNTIME / 'page-role-registry.json'
ROLE_LOCK = RUNTIME / 'page-role-registry.lock'
PAGE_ROLE = 'codex-gemini-uploads-offset-proof-20261006-v2'
SERVICE_ORIGIN = 'https://gemini.google.com'
UPLOAD_ORIGIN = 'https://push.clients6.google.com'
EXPECTED_ACCOUNT_SHA256 = '23e57131977ce522bacf6649eb27538770828a890f7a65589ec4f0960a84b3d7'
CALLER_INTENT = 'gemini-attachment-upload-offset-proof-20261006-v2'
FILE_NAME = 'api-offset-proof-v2.txt'
FILE_CONTENT = b'OFFSET42:12\n'
FILE_PATH = RUNTIME / FILE_NAME
CONTRACT_FILE = REPO / 'discovery' / 'observed-contract.json'
IDENTITY_EVIDENCE = REPO / 'verification' / 'one-shot' / 'gemini-identity-session-2026-10-06.json'
RECEIPT_FILE = REPO / 'discovery' / 'gemini-attachment-upload-offset-proof-2026-10-06.json'
HELPER = REPO / 'scripts' / 'gemini-attachment-upload-controlled-once.mjs'
READ_RPC_IDS = {
    'MaZiqc', 'hNvQHb', 'ESY5D', 'otAQ7b', 'unqWSc', 'OXxBcc', 'sJBwce', 'DYBcR',
    'whPPme', 'GPRiHf', 'maGuAc', 'VxUbXb', 'V8rlHe', 'aPya6c', 'cYRIkd', 'ozz5Z',
    'K4WWud', 'I4z33b', 'o30O0e', 'Bsxleb', 'ku4Jyf', 'XhaU0b', 'qpEbW', 'MyzX6c',
}


class SafeFailure(Exception):
    def __init__(self, code):
        self.code = code


def read_json(path):
    return json.loads(path.read_text(encoding='utf-8'))


def write_json_atomic(path, value):
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
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


def persist_attempt(attempt):
    attempts = []
    if RECEIPT_FILE.exists():
        prior = read_json(RECEIPT_FILE)
        if prior.get('callerIntent') != CALLER_INTENT:
            raise SafeFailure('UPLOAD_DIAGNOSTIC_RECEIPT_CONFLICT')
        attempts = prior.get('attempts') if isinstance(prior.get('attempts'), list) else []
        if any(item.get('directDispatchCount', 0) > 0 for item in attempts if isinstance(item, dict)):
            raise SafeFailure('UPLOAD_DIAGNOSTIC_INTENT_ALREADY_DISPATCHED')
    document = {
        'schema': 1,
        'service': 'gemini-web',
        'operation': 'attachment_upload',
        'callerIntent': CALLER_INTENT,
        'purpose': 'capture native finalize request after forwarding the actual direct start response',
        'attemptCount': len(attempts) + 1,
        'directDispatchCount': sum(item.get('directDispatchCount', 0) for item in attempts if isinstance(item, dict))
            + attempt.get('directDispatchCount', 0),
        'attempts': attempts + [attempt],
        'rawBodiesOrCredentialValuesPersisted': False,
        'rawOwnerEmailPersisted': False,
        'rawUploadSessionUrlPersisted': False,
    }
    write_json_atomic(RECEIPT_FILE, document)
    return document


def scrub(value):
    if isinstance(value, dict):
        for key, item in list(value.items()):
            if isinstance(item, str):
                value[key] = ''
            else:
                scrub(item)
    elif isinstance(value, list):
        for index, item in enumerate(value):
            if isinstance(item, str):
                value[index] = ''
            else:
                scrub(item)


def cookie_names(header):
    names = []
    for item in str(header or '').split(';'):
        if '=' not in item:
            continue
        name = item.split('=', 1)[0].strip()
        if re.fullmatch(r'[A-Za-z0-9_.$-]{1,128}', name):
            names.append(name)
    return sorted(set(names))


def safe_ref(raw_url):
    parsed = urllib.parse.urlsplit(raw_url)
    if parsed.scheme != 'https' or not parsed.hostname or parsed.username or parsed.password or parsed.fragment:
        raise SafeFailure('UPLOAD_SESSION_URL_INVALID')
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


def mutation_journal_summary(actor):
    root = pathlib.Path.home() / '.config' / 'gemini-web-xhr-client' / 'jobs'
    expected = {}
    for capability in ('attachment_upload', 'attachment_upload_transfer'):
        canonical = json.dumps(
            ['gemini-web', capability, actor.strip().lower(), CALLER_INTENT], separators=(',', ':'), ensure_ascii=False,
        )
        expected[capability] = hashlib.sha256(canonical.encode('utf-8')).hexdigest()
    result = {}
    if not root.is_dir():
        return result
    for path in root.glob('*.json'):
        try:
            job = read_json(path)
        except Exception:
            continue
        capability = job.get('capability')
        if capability not in expected or job.get('intentKeyHash') != expected[capability]:
            continue
        result[capability] = {
            'state': job.get('state'),
            'dispatchCount': job.get('dispatchCount', 0),
            'httpStatus': job.get('httpStatus'),
        }
    return result


def child_read_json_line(process, timeout_seconds=150):
    ready, _, _ = select.select([process.stdout], [], [], timeout_seconds)
    if not ready:
        raise SafeFailure('UPLOAD_DIRECT_HELPER_TIMEOUT')
    line = process.stdout.readline()
    if not line or len(line) > 48 * 1024 * 1024:
        raise SafeFailure('UPLOAD_DIRECT_HELPER_PROTOCOL_INVALID')
    try:
        value = json.loads(line)
    except Exception as error:
        raise SafeFailure('UPLOAD_DIRECT_HELPER_PROTOCOL_INVALID') from error
    return value


def validate_current_cookie_jar(cookie_jar, scopes, expected_names):
    scope_by_name = {scope['name']: scope for scope in scopes}
    selected = []
    seen = set()
    for cookie in cookie_jar:
        name = cookie.get('name')
        if name not in scope_by_name:
            continue
        scope = scope_by_name[name]
        if (cookie.get('domain') != scope['domain'] or cookie.get('path') != scope['path']
                or cookie.get('secure') is not scope['secure'] or name in seen):
            raise SafeFailure('UPLOAD_COOKIE_SCOPE_MISMATCH')
        selected.append({key: cookie.get(key) for key in ('name', 'value', 'domain', 'path', 'secure', 'expires') if key in cookie})
        seen.add(name)
    if sorted(seen) != sorted(expected_names):
        raise SafeFailure('UPLOAD_CURRENT_COOKIE_SET_INCOMPLETE')
    return selected


def main_inner():
    if RECEIPT_FILE.exists():
        prior = read_json(RECEIPT_FILE)
        if prior.get('callerIntent') == CALLER_INTENT:
            attempts = prior.get('attempts') if isinstance(prior.get('attempts'), list) else []
            if any(item.get('directDispatchCount', 0) > 0 for item in attempts if isinstance(item, dict)):
                raise SafeFailure('UPLOAD_DIAGNOSTIC_INTENT_ALREADY_DISPATCHED')

    identity_evidence = read_json(IDENTITY_EVIDENCE)
    if (identity_evidence.get('ownerMatched') is not True or identity_evidence.get('anonymousOwnerAbsent') is not True
            or identity_evidence.get('credentialPropagated') is not True):
        raise SafeFailure('EXISTING_GEMINI_OWNER_EVIDENCE_MISMATCH')
    contract = read_json(CONTRACT_FILE)
    upload_contract = contract.get('attachmentUpload')
    if not isinstance(upload_contract, dict):
        raise SafeFailure('UPLOAD_CONTRACT_NOT_INSTALLED')
    owner = read_json(OWNER_FILE)
    if owner.get('taskOwned') is not True or not isinstance(owner.get('chromePid'), int):
        raise SafeFailure('OWNED_RUNTIME_INVALID')
    process_args = pathlib.Path(f"/proc/{owner['chromePid']}/cmdline").read_bytes().split(b'\0')
    if ('--user-data-dir=' + owner['profile']).encode() not in process_args:
        raise SafeFailure('OWNED_RUNTIME_PROFILE_MISMATCH')
    with open(ROLE_LOCK, 'a+') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        registry = read_json(ROLE_FILE)
        role_info = registry.get('activePageRoles', {}).get(PAGE_ROLE, {})
        if (registry.get('taskOwned') is not True or registry.get('runtimeChromePid') != owner['chromePid']
                or role_info.get('origin') != SERVICE_ORIGIN or role_info.get('exactMarkerCount') != 1
                or not isinstance(role_info.get('targetId'), str) or len(role_info.get('targetId')) < 8):
            raise SafeFailure('UPLOAD_PAGE_ROLE_NOT_REGISTERED')
        registered_target_id = role_info['targetId']
        fcntl.flock(lock, fcntl.LOCK_UN)

    if FILE_PATH.exists():
        if FILE_PATH.read_bytes() != FILE_CONTENT:
            raise SafeFailure('UPLOAD_TEST_FILE_MISMATCH')
    else:
        FILE_PATH.write_bytes(FILE_CONTENT)
        FILE_PATH.chmod(0o600)

    state = {
        'nativeStartCount': 0,
        'nativeContinuationCount': 0,
        'otherBlockedCount': 0,
        'lateRequestCount': 0,
        'lateBlockedCount': 0,
        'resetStarted': False,
        'routeHandlerError': None,
        'startCapture': None,
        'continuationCapture': None,
        'startEvent': None,
        'startResponseSummary': None,
        'directResult': None,
        'directDispatchCount': 0,
        'child': None,
        'session': None,
        'uploadCookies': None,
        'expectedOwner': '',
        'resetQuiet': False,
        'mutationJournal': {},
        'targetIdMatch': False,
    }
    blocked_requests = []
    receipt_written = False
    page = None
    context = None
    browser = None
    route_handler = None
    error_code = None

    def finish_child_if_running(send_eof=False):
        process = state.get('child')
        if process is None:
            return
        if send_eof and process.poll() is None:
            try:
                process.stdin.close()
            except Exception:
                pass
        if process.poll() is None:
            try:
                process.wait(timeout=75)
            except subprocess.TimeoutExpired:
                process.terminate()
                try:
                    process.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait(timeout=5)
        for stream in (process.stdin, process.stdout):
            try:
                if stream and not stream.closed:
                    stream.close()
            except Exception:
                pass

    try:
        with sync_playwright() as playwright:
            browser = playwright.chromium.connect_over_cdp(f"http://127.0.0.1:{owner['cdpPort']}")
            if len(browser.contexts) != 1:
                raise SafeFailure('OWNED_CONTEXT_COUNT_INVALID')
            context = browser.contexts[0]

            def target_id_for(candidate):
                session = context.new_cdp_session(candidate)
                try:
                    info = session.send('Target.getTargetInfo').get('targetInfo', {})
                    return info.get('targetId')
                finally:
                    session.detach()

            target_pages = []
            for candidate in context.pages:
                try:
                    if target_id_for(candidate) == registered_target_id:
                        target_pages.append(candidate)
                except Exception:
                    pass
            if len(target_pages) != 1:
                raise SafeFailure('UPLOAD_PAGE_TARGET_ID_NOT_FOUND')
            page = target_pages[0]
            if page.url != 'about:blank':
                raise SafeFailure('UPLOAD_PAGE_NOT_RESET')
            if page.evaluate('() => window.name') != PAGE_ROLE:
                page.evaluate('(marker) => window.name = marker', PAGE_ROLE)
            if page.evaluate('() => window.name') != PAGE_ROLE or target_id_for(page) != registered_target_id:
                raise SafeFailure('UPLOAD_PAGE_ROLE_TARGET_BINDING_FAILED')
            state['targetIdMatch'] = True

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
                header_values = request.all_headers()
                body = request.post_data_buffer or b''
                is_start = (
                    parsed.hostname == 'push.clients6.google.com' and parsed.path == '/upload/'
                    and request.method == 'POST' and header_values.get('x-goog-upload-command') == 'start'
                    and header_values.get('x-goog-upload-protocol') == 'resumable'
                )
                if is_start:
                    state['nativeStartCount'] += 1
                    if state['nativeStartCount'] == 1:
                        state['startCapture'] = {
                            'url': request.url,
                            'method': request.method,
                            'contentType': header_values.get('content-type', '').split(';', 1)[0].strip().lower(),
                            'body': bytearray(body),
                            'headerNames': sorted(header_values),
                            'headers': {name: value for name, value in header_values.items()
                                if name in upload_contract['source']['headerNames'] and name != 'cookie'},
                            'cookieNames': cookie_names(header_values.get('cookie', '')),
                            'declaredFileBytes': int(header_values.get('x-goog-upload-header-content-length', '0') or '0'),
                        }
                        capture = state['startCapture']
                        expected_body = (upload_contract['source']['metadataBodyPrefix'] + FILE_NAME).encode('utf-8')
                        if (capture['contentType'] != upload_contract['source']['contentType']
                                or bytes(capture['body']) != expected_body or capture['declaredFileBytes'] != len(FILE_CONTENT)
                                or capture['cookieNames'] != sorted(upload_contract['source']['cookieNames'])
                                or capture['headerNames'] != sorted(upload_contract['source']['headerNames'])):
                            route.abort('blockedbyclient')
                            raise SafeFailure('UPLOAD_NATIVE_START_CAPTURE_MISMATCH')
                        push_jar = context.cookies(capture['url'])
                        state['uploadCookies'] = validate_current_cookie_jar(
                            push_jar, upload_contract['source']['cookieScopes'], upload_contract['source']['cookieNames'],
                        )
                        node = node_runtime()
                        env = {key: os.environ[key] for key in (
                            'PATH', 'HOME', 'LANG', 'LC_ALL', 'TMPDIR', 'SSL_CERT_FILE', 'SSL_CERT_DIR',
                        ) if key in os.environ}
                        env['GEMINI_UPLOAD_SESSION_ORCHESTRATOR'] = '1'
                        process = subprocess.Popen(
                            [node, str(HELPER)], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                            stderr=subprocess.DEVNULL, text=True, bufsize=1, env=env,
                        )
                        state['child'] = process
                        payload = {
                            'expectedOwner': state['expectedOwner'], 'callerIntent': CALLER_INTENT,
                            'session': state['session'],
                            'capture': {
                                'url': capture['url'], 'method': capture['method'], 'contentType': capture['contentType'],
                                'bodyBase64': base64.b64encode(capture['body']).decode('ascii'),
                                'declaredFileBytes': capture['declaredFileBytes'],
                                'headerNames': list(capture['headerNames']), 'headers': dict(capture['headers']),
                            },
                            'uploadCookies': state['uploadCookies'],
                            'file': {'name': FILE_NAME, 'mimeType': 'text/plain',
                                'bodyBase64': base64.b64encode(FILE_CONTENT).decode('ascii')},
                        }
                        wire = json.dumps(payload, separators=(',', ':'))
                        try:
                            process.stdin.write(wire + '\n')
                            process.stdin.flush()
                        finally:
                            wire = ''
                            scrub(payload)
                            capture['body'][:] = b'\0' * len(capture['body'])
                        event = child_read_json_line(process)
                        if event.get('event') == 'complete':
                            state['directResult'] = event.get('result')
                            state['directDispatchCount'] = state['directResult'].get('directDispatchCount', 0)
                            route.abort('blockedbyclient')
                            scrub(event)
                            raise SafeFailure('UPLOAD_DIRECT_START_REJECTED')
                        if event.get('event') == 'error':
                            state['directResult'] = {
                                key: event.get(key) for key in (
                                    'errorCode', 'directDispatchCount', 'startDispatchCount', 'transferDispatchCount',
                                    'httpRequestCount', 'stage', 'httpStatus', 'queryReadback',
                                ) if key in event
                            }
                            state['directDispatchCount'] = state['directResult'].get('directDispatchCount', 0)
                            route.abort('blockedbyclient')
                            scrub(event)
                            raise SafeFailure(state['directResult'].get('errorCode', 'UPLOAD_DIRECT_START_FAILED'))
                        if event.get('event') != 'start-response' or event.get('httpStatus') != 200:
                            state['directResult'] = event
                            state['directDispatchCount'] = event.get('directDispatchCount', 0)
                            route.abort('blockedbyclient')
                            scrub(event)
                            raise SafeFailure('UPLOAD_DIRECT_START_RESPONSE_INVALID')
                        session_ref = safe_ref(event.get('uploadUrl', ''))
                        if session_ref['origin'] != UPLOAD_ORIGIN or session_ref['pathFamily'] != '/upload/' \
                                or not {'upload_id', 'upload_protocol'}.issubset(set(session_ref['queryKeyNames'])):
                            route.abort('blockedbyclient')
                            scrub(event)
                            raise SafeFailure('UPLOAD_SESSION_URL_UNOBSERVED')
                        response_body = bytearray(base64.b64decode(event.get('responseBodyBase64', ''), validate=True))
                        response_headers = event.get('responseHeaders')
                        if not isinstance(response_headers, dict):
                            route.abort('blockedbyclient')
                            response_body[:] = b'\0' * len(response_body)
                            scrub(event)
                            raise SafeFailure('UPLOAD_DIRECT_START_RESPONSE_INVALID')
                        state['startEvent'] = {'uploadUrl': event['uploadUrl'], 'sessionUrlRef': session_ref}
                        state['startResponseSummary'] = {
                            'httpStatus': event['httpStatus'],
                            'responseHeaderNames': sorted(response_headers),
                            'responseBytes': len(response_body),
                        }
                        state['directDispatchCount'] = 1
                        route.fulfill(status=200, headers=response_headers, body=bytes(response_body))
                        response_body[:] = b'\0' * len(response_body)
                        scrub(event)
                        return
                    state['otherBlockedCount'] += 1
                    route.abort('blockedbyclient')
                    return

                start_event = state['startEvent']
                is_continuation = (
                    start_event is not None and parsed.hostname == 'push.clients6.google.com'
                    and request.method == 'POST' and request.url == start_event.get('uploadUrl')
                    and header_values.get('x-goog-upload-command') == 'upload, finalize'
                )
                if is_continuation:
                    state['nativeContinuationCount'] += 1
                    route.abort('blockedbyclient')
                    if state['nativeContinuationCount'] != 1:
                        state['otherBlockedCount'] += 1
                        return
                    state['continuationCapture'] = {
                        'url': request.url,
                        'method': request.method,
                        'headerNames': sorted(header_values),
                        'headers': dict(header_values),
                        'body': bytearray(body),
                        'bodyBytes': len(body),
                        'bodySha256': hashlib.sha256(body).hexdigest(),
                        'command': header_values.get('x-goog-upload-command'),
                        'offset': header_values.get('x-goog-upload-offset'),
                        'cookieNames': cookie_names(header_values.get('cookie', '')),
                    }
                    captured = state['continuationCapture']
                    continuation_payload = {
                        'continuationCapture': {
                            'url': captured['url'], 'method': captured['method'],
                            'headerNames': list(captured['headerNames']), 'headers': dict(captured['headers']),
                            'bodyBase64': base64.b64encode(captured['body']).decode('ascii'),
                        },
                    }
                    wire = json.dumps(continuation_payload, separators=(',', ':'))
                    try:
                        child = state['child']
                        child.stdin.write(wire + '\n')
                        child.stdin.flush()
                    finally:
                        wire = ''
                        scrub(continuation_payload)
                        captured['body'][:] = b'\0' * len(captured['body'])
                        for name in list(captured['headers']):
                            captured['headers'][name] = ''
                    event = child_read_json_line(state['child'])
                    if event.get('event') == 'complete':
                        state['directResult'] = event.get('result')
                        state['directDispatchCount'] = state['directResult'].get('directDispatchCount', 0)
                    else:
                        state['directResult'] = event
                        state['directDispatchCount'] = event.get('directDispatchCount', 1)
                    return

                state['otherBlockedCount'] += 1
                if state['resetStarted']:
                    state['lateBlockedCount'] += 1
                blocked_requests.append({
                    'method': request.method,
                    'origin': f'{parsed.scheme}://{parsed.netloc}',
                    'pathFamily': re.sub(r'[A-Za-z0-9_-]{40,}', '{id}', parsed.path),
                    'queryKeyNames': sorted({key for key, _ in urllib.parse.parse_qsl(parsed.query, keep_blank_values=True)}),
                    'bodyBytes': len(body),
                    'bodySha256': hashlib.sha256(body).hexdigest(),
                    'headerNames': sorted(header_values),
                })
                route.abort('blockedbyclient')

            def guarded_route(route):
                try:
                    return guard(route)
                except Exception as error:
                    code = error.code if isinstance(error, SafeFailure) else 'UPLOAD_ROUTE_HANDLER_FAILED'
                    state['routeHandlerError'] = code
                    try:
                        route.abort('blockedbyclient')
                    except Exception:
                        pass
                    return None

            route_handler = guarded_route
            page.route('**/*', route_handler)
            page.goto(SERVICE_ORIGIN + '/app', wait_until='domcontentloaded', timeout=60000)
            if not page.url.startswith(SERVICE_ORIGIN + '/'):
                raise SafeFailure('GEMINI_APP_NOT_REACHED')
            page.evaluate('(marker) => window.name = marker', PAGE_ROLE)
            if page.evaluate('() => window.name') != PAGE_ROLE or target_id_for(page) != registered_target_id:
                raise SafeFailure('UPLOAD_PAGE_MARKER_MISMATCH')
            page.wait_for_timeout(4500)
            page_html = page.content()
            found_owner = next((email for email in re.findall(r'[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}', page_html)
                if hashlib.sha256(email.strip().casefold().encode()).hexdigest() == EXPECTED_ACCOUNT_SHA256), None)
            page_html = ''
            if not found_owner:
                raise SafeFailure('UPLOAD_OWNER_MISMATCH')
            state['expectedOwner'] = found_owner
            required_auth_names = set(contract['auth']['cookieNames'])
            auth_jar = context.cookies(SERVICE_ORIGIN)
            auth_values = {cookie['name']: cookie['value'] for cookie in auth_jar if cookie.get('name') in required_auth_names}
            if set(auth_values) != required_auth_names:
                raise SafeFailure('UPLOAD_GEMINI_SESSION_INCOMPLETE')
            state['session'] = {
                'version': 1, 'service': contract['service'], 'origin': SERVICE_ORIGIN,
                'capturedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(),
                'cookies': [{'name': name, 'value': value} for name, value in auth_values.items()],
                'headers': {}, 'requestHeaders': {},
            }
            inputs = page.locator('input[type=file]')
            if inputs.count() == 0:
                menu = page.locator('button[aria-label="업로드 및 도구"]')
                if menu.count() != 1 or not menu.is_visible() or not menu.is_enabled():
                    raise SafeFailure('UPLOAD_MENU_NOT_FOUND')
                menu.click()
                deadline = time.monotonic() + 8
                while inputs.count() == 0 and time.monotonic() < deadline:
                    page.wait_for_timeout(250)
            inputs = page.locator('input[type=file]')
            if inputs.count() == 0:
                raise SafeFailure('UPLOAD_FILE_INPUT_NOT_FOUND')
            if '.txt' not in (inputs.first.get_attribute('accept') or '').lower():
                raise SafeFailure('UPLOAD_FILE_TYPE_NOT_ACCEPTED')
            inputs.first.set_input_files(str(FILE_PATH))
            page.wait_for_timeout(3500)
            if state['routeHandlerError']:
                raise SafeFailure(state['routeHandlerError'])
            if state['startCapture'] is None or state['startEvent'] is None:
                raise SafeFailure('UPLOAD_INIT_CAPTURE_NOT_OBSERVED')
            if state['continuationCapture'] is None:
                raise SafeFailure('UPLOAD_NATIVE_CONTINUATION_NOT_OBSERVED')
            if state['directResult'] is None:
                raise SafeFailure('UPLOAD_DIRECT_TRANSFER_RESULT_MISSING')

            page.goto('about:blank', wait_until='domcontentloaded', timeout=30000)
            page.evaluate('(marker) => window.name = marker', PAGE_ROLE)
            state['resetStarted'] = True
            page.wait_for_timeout(1600)
            state['resetQuiet'] = page.url == 'about:blank' and page.evaluate('() => window.name') == PAGE_ROLE \
                and target_id_for(page) == registered_target_id \
                and state['lateRequestCount'] == 0 and state['lateBlockedCount'] == 0
            if not state['resetQuiet']:
                raise SafeFailure('UPLOAD_PAGE_RESET_QUIET_FAILED')

            start = state['startCapture']
            finalize = state['continuationCapture']
            start_event = state['startEvent']
            start_response_summary = state['startResponseSummary']
            direct = state['directResult']
            state['mutationJournal'] = mutation_journal_summary(state['expectedOwner'])
            journal_dispatch_count = sum(item.get('dispatchCount', 0) for item in state['mutationJournal'].values())
            if journal_dispatch_count != direct.get('directDispatchCount'):
                raise SafeFailure('UPLOAD_JOURNAL_DISPATCH_MISMATCH')
            native_finalize_ref = safe_ref(finalize['url'])
            attempt = {
                'recordedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(),
                'directDispatchCount': direct.get('directDispatchCount', 0),
                'ownerDigestMatchedApproved': True,
                'historicalOwnerEvidenceMatched': True,
                'file': {
                    'name': FILE_NAME, 'mimeType': 'text/plain', 'bytes': len(FILE_CONTENT),
                    'sha256': hashlib.sha256(FILE_CONTENT).hexdigest(),
                },
                'nativeStart': {
                    'method': start['method'], 'origin': UPLOAD_ORIGIN, 'pathFamily': '/upload/',
                    'queryKeyNames': [], 'bodyBytes': len(start['body']),
                    'bodySha256': hashlib.sha256((upload_contract['source']['metadataBodyPrefix'] + FILE_NAME).encode()).hexdigest(),
                    'headerNames': start['headerNames'], 'ordinaryCookieNames': start['cookieNames'],
                    'protocol': start['headers'].get('x-goog-upload-protocol'),
                    'command': start['headers'].get('x-goog-upload-command'),
                    'declaredFileBytes': start['declaredFileBytes'], 'browserDispatchCount': 0,
                },
                'directStart': {
                    **start_response_summary,
                    'sessionUrlRef': start_event['sessionUrlRef'],
                },
                'nativeContinuation': {
                    'method': finalize['method'], 'origin': native_finalize_ref['origin'],
                    'pathFamily': native_finalize_ref['pathFamily'], 'queryKeyNames': native_finalize_ref['queryKeyNames'],
                    'headerNames': finalize['headerNames'], 'ordinaryCookieNames': finalize['cookieNames'],
                    'bodyBytes': finalize['bodyBytes'], 'bodySha256': finalize['bodySha256'],
                    'command': finalize['command'], 'offset': finalize['offset'],
                    'browserDispatchCount': 0,
                },
                'directApi': {
                    'status': direct.get('status'), 'directDispatchCount': direct.get('directDispatchCount', 1),
                    'startDispatchCount': direct.get('startDispatchCount', 1),
                    'transferDispatchCount': direct.get('transferDispatchCount', 0),
                    'httpRequestCount': direct.get('httpRequestCount'),
                    'continuationHeaderNames': direct.get('continuationHeaderNames'),
                    'cookieNamesForwardedToStart': direct.get('cookieNamesForwardedToStart'),
                    'cookieNamesForwardedToContinuation': direct.get('cookieNamesForwardedToContinuation'),
                    'continuationOffset': direct.get('continuationOffset'),
                    'continuationBodyBytes': direct.get('continuationBodyBytes'),
                    'continuationBodySha256': direct.get('continuationBodySha256'),
                    'start': direct.get('start'), 'upload': direct.get('upload'), 'query': direct.get('query'),
                    'uploadedFileReadbackVerified': direct.get('uploadedFileReadbackVerified', False),
                    'journalReconciled': direct.get('journalReconciled', False),
                    'rawUploadUrlPersisted': False, 'rawResponseBodiesPersisted': False,
                    'cookieValuesPersisted': False,
                },
                'mutationJournal': state['mutationJournal'],
                'cleanup': {
                    'cancelSupportedByObservedGeminiUiContract': False, 'cancelAttempted': False,
                    'conversationMessageSent': False, 'testFileOnly': True,
                },
                'guardLifecycle': {
                    'realStartResponseForwardedToNativeRequest': True,
                    'nativeContinuationAbortedBeforeDelivery': True,
                    'registeredTargetIdMatched': state['targetIdMatch'],
                    'resetQuietVerifiedThroughDisconnect': state['resetQuiet'],
                    'lateBlockedRequestCount': state['lateBlockedCount'],
                    'browserClosed': False, 'contextClosed': False,
                },
                'blockedNonReadOnlyRequestCount': state['otherBlockedCount'],
                'rawBodiesOrCredentialValuesPersisted': False,
                'rawOwnerEmailPersisted': False,
                'rawUploadSessionUrlPersisted': False,
            }
            persist_attempt(attempt)
            receipt_written = True
            finish_child_if_running(send_eof=True)
            return {
                'status': direct.get('status'), 'receiptPath': str(RECEIPT_FILE),
                'directDispatchCount': attempt['directApi']['directDispatchCount'],
                'startDispatchCount': attempt['directApi']['startDispatchCount'],
                'transferDispatchCount': attempt['directApi']['transferDispatchCount'],
                'nativeStartBrowserDispatchCount': 0, 'nativeContinuationBrowserDispatchCount': 0,
                'uploadedFileReadbackVerified': attempt['directApi']['uploadedFileReadbackVerified'],
                'resetQuietVerified': state['resetQuiet'], 'receiptPersisted': True,
            }
    except SafeFailure as error:
        error_code = error.code
        raise
    finally:
        if context is not None and browser is not None:
            try:
                same_target_pages = [candidate for candidate in context.pages
                    if target_id_for(candidate) == registered_target_id]
                if len(same_target_pages) != 1:
                    raise SafeFailure('UPLOAD_PAGE_TARGET_ID_NOT_FOUND_DURING_RESET')
                page = same_target_pages[0]
                if page.url != 'about:blank' or page.evaluate('() => window.name') != PAGE_ROLE:
                    page.goto('about:blank', wait_until='domcontentloaded', timeout=30000)
                    state['resetStarted'] = True
                if page.evaluate('() => window.name') != PAGE_ROLE:
                    page.evaluate('(marker) => window.name = marker', PAGE_ROLE)
                if page.evaluate('() => window.name') != PAGE_ROLE or target_id_for(page) != registered_target_id:
                    raise SafeFailure('UPLOAD_PAGE_ROLE_TARGET_BINDING_FAILED')
                page.wait_for_timeout(1600)
                state['resetQuiet'] = page.url == 'about:blank' and page.evaluate('() => window.name') == PAGE_ROLE \
                    and target_id_for(page) == registered_target_id \
                    and state['lateRequestCount'] == 0 and state['lateBlockedCount'] == 0
            except Exception:
                state['resetQuiet'] = False
            if route_handler is not None:
                try:
                    page.unroute('**/*', route_handler)
                except Exception:
                    pass
        finish_child_if_running(send_eof=True)
        if not receipt_written and (state['directDispatchCount'] > 0 or state['startCapture'] is not None):
            if state.get('expectedOwner'):
                state['mutationJournal'] = mutation_journal_summary(state['expectedOwner'])
                state['directDispatchCount'] = max(
                    state['directDispatchCount'],
                    sum(item.get('dispatchCount', 0) for item in state['mutationJournal'].values()),
                )
            start = state.get('startCapture') or {}
            finalize = state.get('continuationCapture') or {}
            direct = state.get('directResult') or {}
            attempt = {
                'recordedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(),
                'directDispatchCount': max(state['directDispatchCount'], direct.get('directDispatchCount', 0)),
                'ownerDigestMatchedApproved': bool(state['expectedOwner']),
                'historicalOwnerEvidenceMatched': True,
                'failureCode': error_code or 'UPLOAD_DIAGNOSTIC_INCOMPLETE',
                'file': {'name': FILE_NAME, 'mimeType': 'text/plain', 'bytes': len(FILE_CONTENT),
                    'sha256': hashlib.sha256(FILE_CONTENT).hexdigest()},
                'nativeStart': {
                    'method': start.get('method'), 'origin': UPLOAD_ORIGIN, 'pathFamily': '/upload/',
                    'bodyBytes': len(start.get('body') or b''),
                    'bodySha256': hashlib.sha256((upload_contract['source']['metadataBodyPrefix'] + FILE_NAME).encode()).hexdigest(),
                    'headerNames': start.get('headerNames', []), 'ordinaryCookieNames': start.get('cookieNames', []),
                    'browserDispatchCount': 0,
                },
                'directStart': ({
                    **state['startResponseSummary'],
                    'sessionUrlRef': state['startEvent']['sessionUrlRef'],
                } if state.get('startResponseSummary') and state.get('startEvent') else None),
                'nativeContinuation': {
                    'headerNames': finalize.get('headerNames', []), 'bodyBytes': finalize.get('bodyBytes'),
                    'bodySha256': finalize.get('bodySha256'), 'command': finalize.get('command'),
                    'offset': finalize.get('offset'), 'browserDispatchCount': 0,
                },
                'directApi': {
                    'status': direct.get('status', 'failed'),
                    'directDispatchCount': state['directDispatchCount'],
                    'startDispatchCount': direct.get('startDispatchCount', state['directDispatchCount']),
                    'transferDispatchCount': direct.get('transferDispatchCount', 0),
                    'httpRequestCount': direct.get('httpRequestCount'),
                    'errorCode': direct.get('errorCode') or error_code,
                    'stage': direct.get('stage'), 'httpStatus': direct.get('httpStatus'),
                    'continuationHeaderNames': direct.get('continuationHeaderNames'),
                    'cookieNamesForwardedToStart': direct.get('cookieNamesForwardedToStart'),
                    'cookieNamesForwardedToContinuation': direct.get('cookieNamesForwardedToContinuation'),
                    'continuationOffset': direct.get('continuationOffset'),
                    'continuationBodyBytes': direct.get('continuationBodyBytes'),
                    'continuationBodySha256': direct.get('continuationBodySha256'),
                    'start': direct.get('start'), 'upload': direct.get('upload'), 'query': direct.get('query'),
                    'uploadedFileReadbackVerified': direct.get('uploadedFileReadbackVerified', False),
                    'journalReconciled': direct.get('journalReconciled', False),
                    'queryReadback': direct.get('queryReadback'),
                    'rawUploadUrlPersisted': False, 'rawResponseBodiesPersisted': False,
                    'cookieValuesPersisted': False,
                },
                'mutationJournal': state['mutationJournal'],
                'guardLifecycle': {
                    'registeredTargetIdMatched': state['targetIdMatch'],
                    'resetQuietVerifiedThroughDisconnect': state['resetQuiet'],
                    'lateBlockedRequestCount': state['lateBlockedCount'],
                    'browserClosed': False, 'contextClosed': False,
                },
                'cleanup': {'cancelSupportedByObservedGeminiUiContract': False,
                    'cancelAttempted': False, 'conversationMessageSent': False},
                'rawBodiesOrCredentialValuesPersisted': False,
                'rawOwnerEmailPersisted': False,
                'rawUploadSessionUrlPersisted': False,
            }
            try:
                persist_attempt(attempt)
            except Exception:
                pass
        if isinstance(state.get('startCapture', {}).get('body'), bytearray):
            state['startCapture']['body'][:] = b'\0' * len(state['startCapture']['body'])
        if isinstance(state.get('startCapture'), dict):
            state['startCapture']['url'] = ''
            for name in list(state['startCapture'].get('headers', {})):
                state['startCapture']['headers'][name] = ''
        if isinstance(state.get('continuationCapture', {}).get('body'), bytearray):
            state['continuationCapture']['body'][:] = b'\0' * len(state['continuationCapture']['body'])
        if isinstance(state.get('continuationCapture'), dict):
            state['continuationCapture']['url'] = ''
            for name in list(state['continuationCapture'].get('headers', {})):
                state['continuationCapture']['headers'][name] = ''
        if isinstance(state.get('session'), dict):
            for item in state['session'].get('cookies', []):
                item['value'] = ''
            state['session'].clear()
        if isinstance(state.get('uploadCookies'), list):
            scrub(state['uploadCookies'])
        state['expectedOwner'] = ''
        event = state.get('startEvent')
        if event:
            scrub(event)
        if FILE_PATH.exists():
            FILE_PATH.unlink(missing_ok=True)


def main():
    try:
        result = main_inner()
        sys.stdout.write(json.dumps(result, ensure_ascii=False) + '\n')
        return 0 if result.get('status') == 'verified' else 3
    except SafeFailure as error:
        sys.stdout.write(json.dumps({'status': 'failed', 'errorCode': error.code}) + '\n')
        return 3
    except Exception as error:
        sys.stdout.write(json.dumps({'status': 'failed', 'errorCode': 'UPLOAD_DIAGNOSTIC_RUNNER_FAILED',
            'errorClass': type(error).__name__}) + '\n')
        return 3


if __name__ == '__main__':
    sys.exit(main())
