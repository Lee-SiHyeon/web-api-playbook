#!/usr/bin/env python3
"""Capture one task-scoped Gemini text request, replay it once over HTTPS, and read it back."""

import hashlib
import json
import os
import re
import subprocess
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

from playwright.sync_api import sync_playwright


REPO = Path(__file__).resolve().parent.parent
RUNTIME = Path.home() / '.nad-scratch/provider-runtime-20261005'
OWNER_PATH = RUNTIME / 'runtime-owner.json'
ROLE_PATH = RUNTIME / 'page-role-registry.json'
GROK_VERIFY_SOURCE = RUNTIME / 'grok-client-live-verify.py'
GROK_VERIFY_SOURCE_SHA256 = 'da6d415129ac8e349b8632f1ef9defe1ca7ecf30fedb4c28abf3a519766af7bb'
EXPECTED_EMAIL_HASH_LINE = re.compile(r"^EXPECTED_EMAIL_SHA256='([a-f0-9]{64})'$", re.MULTILINE)
NODE = '/home/worker/.npm/_npx/387698761821791d/node_modules/node/bin/node'
CONTRACT_PATH = REPO / 'discovery/observed-contract.json'
RECEIPT_PATH = REPO / 'verification/one-shot/gemini-protocol-decoder-verification-2026-10-06.json'
SERVICE_ORIGIN = 'https://gemini.google.com'
GROK_ORIGIN = 'https://grok.com'
GEMINI_CORE_ROLE = 'codex-gemini-core-20261006'
GROK_CORE_ROLE = 'codex-grok-core-20261006'
CALLER_INTENT = 'gemini-protocol-decoder-verification-20261006-v1'
PROMPT = 'Reply with the sum of 17 + 25 and the label PROTOCOL42. Do not use tools or create media.'
FIRST_PAGE_HISTORY_ARGS = [28, None, [0, None, 1]]
STREAM_PATH = '/_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate'
DETAIL_PATH = '/_/BardChatUi/data/batchexecute'
FORBIDDEN_HEADERS = {'cookie', 'authorization', 'proxy-authorization', 'host', 'content-length'}
READ_RPC_IDS = {
    'CNgdBe', 'MaZiqc', 'ESY5D', 'otAQ7b', 'sJBwce', 'DYBcR', 'whPPme', 'GPRiHf',
    'maGuAc', 'Te6DCf', 'VxUbXb', 'V8rlHe', 'aPya6c', 'cYRIkd', 'ozz5Z', 'K4WWud',
    'I4z33b', 'o30O0e', 'Bsxleb', 'ku4Jyf', 'XhaU0b', 'qpEbW', 'MyzX6c',
    'hNvQHb',
}
TELEMETRY = {
    ('www.google.com', '/ccm/collect'), ('www.google.com', '/g/collect'),
    ('www.google-analytics.com', '/ccm/collect'), ('www.google-analytics.com', '/g/collect'),
    ('analytics.google.com', '/g/collect'), ('play.google.com', '/log'),
    ('gemini.google.com', '/_/BardChatUi/jserror'),
    ('gemini.google.com', '/_/BardChatUi/cspreport'),
    ('gemini.google.com', '/_/BardChatUi/cspreport/fine-allowlist'),
}


class SafeFailure(Exception):
    def __init__(self, code):
        self.code = code


def now_iso():
    return datetime.now(timezone.utc).isoformat()


def headers_without_credentials(headers):
    return {str(name).lower(): str(value) for name, value in (headers or {}).items()
            if str(name).lower() not in FORBIDDEN_HEADERS}


def add_observed_header_names(contract, operation_name, captured_headers):
    operation = contract['operations'][operation_name]
    names = set(name.lower() for name in operation['request'].get('headerNames', []))
    names.update(name.lower() for name in captured_headers if name.lower() not in FORBIDDEN_HEADERS)
    operation['request']['headerNames'] = sorted(names)


def write_contract(contract):
    contract['observedAt'] = now_iso()
    temp = CONTRACT_PATH.with_suffix('.json.pending')
    temp.write_text(json.dumps(contract, indent=2, ensure_ascii=False) + '\n')
    temp.replace(CONTRACT_PATH)


def body_from_paused(cdp, request_id, request):
    data = request.get('postData')
    if data is None:
        try:
            data = cdp.send('Fetch.getRequestPostData', {'requestId': request_id}).get('postData', '')
        except Exception:
            data = ''
    return str(data)


def parse_form(body):
    pairs = urllib.parse.parse_qsl(body, keep_blank_values=True)
    if len({name for name, _ in pairs}) != len(pairs):
        return None
    return dict(pairs)


def batch_call(body):
    form = parse_form(body)
    if not form or 'f.req' not in form:
        return None
    try:
        outer = json.loads(form['f.req'])
        if not isinstance(outer, list) or len(outer) != 1 or not isinstance(outer[0], list) or len(outer[0]) != 1:
            return None
        call = outer[0][0]
        if not isinstance(call, list) or len(call) != 4 or not isinstance(call[0], str) or not isinstance(call[1], str):
            return None
        return form, call[0], json.loads(call[1]), call
    except Exception:
        return None


def identifier_inside(value, key=''):
    if isinstance(value, dict):
        for name, child in value.items():
            normalized = re.sub(r'[^a-z0-9]', '', str(name).lower())
            if normalized in {'usercid', 'rid', 'rcid'} and child not in (None, '', [], {}):
                return True
            if identifier_inside(child, str(name)):
                return True
    elif isinstance(value, list):
        return any(identifier_inside(child, key) for child in value)
    elif isinstance(value, str):
        if re.fullmatch(r'c_[0-9a-f]{16}', value) or re.fullmatch(r'[0-9a-f]{16}', value):
            return True
        if key and re.sub(r'[^a-z0-9]', '', key.lower()) in {'usercid', 'rid', 'rcid'}:
            return bool(value)
    return False


def run_node(args, envelope, timeout=240, script=None):
    raw = bytearray(json.dumps(envelope, ensure_ascii=False, separators=(',', ':')).encode('utf-8'))
    env = {key: value for key, value in os.environ.items()
           if key in {'PATH', 'HOME', 'LANG', 'LC_ALL', 'TMPDIR', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'REQUESTS_CA_BUNDLE'}}
    try:
        entrypoint = Path(script) if script is not None else REPO / 'src/cli.mjs'
        completed = subprocess.run([NODE, str(entrypoint), *args], input=raw,
                                   stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                   timeout=timeout, check=False, env=env)
    finally:
        raw[:] = b'\0' * len(raw)
    if completed.returncode != 0:
        diagnostic = completed.stderr.decode('utf-8', 'replace').strip().splitlines()
        code = diagnostic[-1] if diagnostic and re.fullmatch(r'[A-Z][A-Z0-9_]{1,63}', diagnostic[-1]) else 'NODE_CLIENT_FAILED'
        raise SafeFailure(code)
    if len(completed.stdout) > 24 * 1024 * 1024:
        raise SafeFailure('NODE_RESULT_TOO_LARGE')
    try:
        result = json.loads(completed.stdout.decode('utf-8'))
    except Exception as exc:
        raise SafeFailure('NODE_RESULT_INVALID') from exc
    return result


def exact_intent_journal_count(actor):
    canonical = json.dumps(['gemini-web', 'text', actor.strip().lower(), CALLER_INTENT], separators=(',', ':'))
    intent_hash = hashlib.sha256(canonical.encode()).hexdigest()
    root = Path.home() / '.config/gemini-web-xhr-client/jobs'
    matches = []
    if root.exists():
        for path in root.glob('*.json'):
            try:
                job = json.loads(path.read_text())
            except Exception:
                continue
            if job.get('capability') == 'text' and job.get('version') == 2 and job.get('intentKeyHash') == intent_hash:
                matches.append(job)
    return len(matches), matches


def rpc_ids_from_request(url, body):
    query = urllib.parse.parse_qs(urllib.parse.urlsplit(url).query, keep_blank_values=True)
    found = [value for value in query.get('rpcids', []) if re.fullmatch(r'[A-Za-z0-9_-]{3,24}', value)]
    parsed = batch_call(body)
    if parsed:
        found.append(parsed[1])
    return list(dict.fromkeys(found))


def safe_route_path(path):
    parts = [part for part in path.split('/') if part]
    output = []
    mask_next = False
    for part in parts:
        if mask_next:
            output.append('{id}')
            mask_next = False
        elif part.lower() in {'app', 'data', 'batchexecute', 'streamgenerate', 'jserror', 'cspreport'}:
            output.append(part)
            if part.lower() == 'app' and len(parts) > 1:
                mask_next = True
        elif re.fullmatch(r'(?:[0-9a-fA-F-]{16,}|[A-Za-z0-9_-]{24,}|\d{5,})', part):
            output.append('{id}')
        else:
            output.append(part[:48])
    return '/' + '/'.join(output)


def safe_post_summary(url, method, headers, body):
    parsed = urllib.parse.urlsplit(url)
    content_type = headers.get('content-type', '').split(';', 1)[0].strip().lower()
    fields = [name for name, _ in urllib.parse.parse_qsl(body, keep_blank_values=True)] \
        if content_type == 'application/x-www-form-urlencoded' else []
    return {
        'host': parsed.hostname,
        'method': method,
        'pathFamily': safe_route_path(parsed.path),
        'queryKeyNames': [name for name, _ in urllib.parse.parse_qsl(parsed.query, keep_blank_values=True)],
        'contentType': content_type,
        'formFieldNames': fields[:12],
        'rpcIds': rpc_ids_from_request(url, body)[:12],
        'bodyBytes': len(body.encode('utf-8')),
    }


def read_static_owner_hash():
    if not GROK_VERIFY_SOURCE.is_file():
        raise SafeFailure('EXPECTED_OWNER_SOURCE_MISSING')
    source = GROK_VERIFY_SOURCE.read_bytes()
    source_sha = hashlib.sha256(source).hexdigest()
    if source_sha != GROK_VERIFY_SOURCE_SHA256:
        raise SafeFailure('EXPECTED_OWNER_SOURCE_SHA_MISMATCH')
    match = EXPECTED_EMAIL_HASH_LINE.search(source.decode('utf-8'))
    if not match:
        raise SafeFailure('EXPECTED_OWNER_HASH_MISSING')
    return match.group(1), source_sha


def runtime_and_roles():
    try:
        owner = json.loads(OWNER_PATH.read_text())
        roles = json.loads(ROLE_PATH.read_text())
    except Exception as exc:
        raise SafeFailure('OWNED_RUNTIME_METADATA_INVALID') from exc
    if owner.get('taskOwned') is not True or owner.get('mode') != 'cdp_discovery_after_native_bootstrap':
        raise SafeFailure('OWNED_RUNTIME_CHECK_FAILED')
    pid = owner.get('chromePid')
    if not isinstance(pid, int):
        raise SafeFailure('OWNED_RUNTIME_PID_INVALID')
    try:
        argv = Path(f'/proc/{pid}/cmdline').read_bytes().decode(errors='ignore').split('\0')
    except Exception as exc:
        raise SafeFailure('OWNED_CHROME_PROCESS_UNAVAILABLE') from exc
    profile = str(Path(owner['profile']).resolve())
    port = int(owner['cdpPort'])
    if f'--user-data-dir={profile}' not in argv or f'--remote-debugging-port={port}' not in argv:
        raise SafeFailure('OWNED_CHROME_PROFILE_OR_PORT_MISMATCH')
    try:
        with urllib.request.urlopen(f'http://127.0.0.1:{port}/json/version', timeout=2) as response:
            version = json.load(response)
    except Exception as exc:
        raise SafeFailure('OWNED_CDP_LISTENER_UNAVAILABLE') from exc
    if not version.get('webSocketDebuggerUrl'):
        raise SafeFailure('OWNED_CDP_LISTENER_INVALID')
    active = roles.get('activePageRoles', {})
    for marker, origin in ((GEMINI_CORE_ROLE, SERVICE_ORIGIN), (GROK_CORE_ROLE, GROK_ORIGIN)):
        role = active.get(marker, {})
        if role.get('origin') != origin or role.get('exactMarkerCount') != 1:
            raise SafeFailure('CORE_PAGE_ROLE_NOT_UNIQUE')
    return owner, roles, version.get('Browser', 'Chrome/unknown')


def page_with_marker(context, marker, origin):
    matches = []
    for page in context.pages:
        try:
            if urllib.parse.urlsplit(page.url).scheme == 'https' and urllib.parse.urlsplit(page.url).netloc == urllib.parse.urlsplit(origin).netloc \
                    and page.evaluate('() => window.name') == marker:
                matches.append(page)
        except Exception:
            continue
    if len(matches) != 1:
        raise SafeFailure('CORE_PAGE_ROLE_NOT_UNIQUE')
    return matches[0]


def read_grok_owner(page, expected_hash):
    try:
        email = page.evaluate("async()=>{const r=await fetch('/api/auth/session',{method:'GET',credentials:'same-origin',redirect:'error'});if(!r.ok)return null;const d=await r.json();return d&&d.session&&typeof d.session.email==='string'?d.session.email:null}")
    except Exception as exc:
        raise SafeFailure('BROWSER_IDENTITY_READ_UNAVAILABLE') from exc
    if not isinstance(email, str) or hashlib.sha256(email.strip().casefold().encode()).hexdigest() != expected_hash:
        raise SafeFailure('BROWSER_OWNER_MISMATCH')
    return email


def expected_context(contract, history_capture, text_capture):
    history_operation = contract['operations']['history_list']
    text_operation = contract['operations']['text']
    history_url = urllib.parse.urlsplit(history_capture['url'])
    history_query = urllib.parse.parse_qsl(history_url.query, keep_blank_values=True)
    history_form = parse_form(history_capture['body'])
    call = batch_call(history_capture['body'])
    if not call or call[1] != 'MaZiqc' or call[3][2] is not None or call[3][3] != 'generic':
        raise SafeFailure('HISTORY_TEMPLATE_INVALID')
    if [name for name, _ in history_query] != history_operation['request']['queryKeys'] \
            or [name for name, _ in urllib.parse.parse_qsl(history_capture['body'], keep_blank_values=True)] != history_operation['request']['bodyFieldNames']:
        raise SafeFailure('HISTORY_TEMPLATE_INVALID')
    if [name for name, _ in urllib.parse.parse_qsl(text_capture['body'], keep_blank_values=True)] != text_operation['request']['bodyFieldNames']:
        raise SafeFailure('TEXT_TEMPLATE_INVALID')
    try:
        outer = json.loads(parse_form(text_capture['body'])['f.req'])
        inner = json.loads(outer[1])
    except Exception as exc:
        raise SafeFailure('TEXT_TEMPLATE_INVALID') from exc
    if not isinstance(outer, list) or len(outer) != 2 or outer[0] is not None \
            or not isinstance(inner, list) or len(inner) != 99 \
            or not isinstance(inner[0], list) or inner[0][0] != PROMPT:
        raise SafeFailure('TEXT_INTENT_MISMATCH')
    if identifier_inside(inner[2]):
        raise SafeFailure('EXISTING_CHAT_IDENTIFIER_PRESENT')
    if not isinstance(inner[59], str) or not re.fullmatch(r'[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}', inner[59], re.I):
        raise SafeFailure('TEXT_CLIENT_ID_SHAPE_INVALID')
    query_values = dict(history_query)
    return {
        'version': 1,
        'service': contract['service'],
        'origin': SERVICE_ORIGIN,
        'capturedAt': now_iso(),
        'cookies': [],
        'headers': {},
        'requestHeaders': {
            'identity': history_capture.get('identityHeaders', {}),
            'history_list': history_capture['headers'],
            'text': text_capture['headers'],
        },
        'batchContext': {
            'at': history_form['at'],
            'fSid': query_values['f.sid'],
            'buildLabel': query_values['bl'],
            'locale': query_values['hl'],
            'requestType': query_values['rt'],
            'sourcePath': query_values['source-path'],
            'requestId': query_values['_reqid'],
            # Use the observed first page instead of a current UI cursor that
            # can point past the last visible history page.
            'historyListArgs': FIRST_PAGE_HISTORY_ARGS.copy(),
        },
    }


def parse_expected_detail_request(url, body, expected_api_id):
    parsed_url = urllib.parse.urlsplit(url)
    pairs = urllib.parse.parse_qsl(parsed_url.query, keep_blank_values=True)
    form_pairs = urllib.parse.parse_qsl(body, keep_blank_values=True)
    parsed = batch_call(body)
    if parsed is None or parsed[1] != 'hNvQHb' or len(parsed[2]) != 8 or parsed[2][0] != expected_api_id:
        return None
    expected_rest = [10, None, 1, [1], [4], None, 1]
    if parsed[2][1:] != expected_rest:
        return None
    if [name for name, _ in pairs] != ['rpcids', 'source-path', 'bl', 'f.sid', 'hl', '_reqid', 'rt'] \
            or [name for name, _ in form_pairs] != ['f.req', 'at'] or parsed[0].get('at') == '':
        return None
    return {
        'url': url,
        'headers': None,
        'query': dict(pairs),
        'bodyFields': [name for name, _ in form_pairs],
        'rpcArgsTemplate': ['{{apiConversationId}}', *parsed[2][1:]],
        'contentType': None,
    }


def call_ids_no_detail(body):
    parsed = batch_call(body)
    return [parsed[1]] if parsed else []


def install_observed_history_read_contract(contract, detail_capture):
    operation = contract['operations']['history_read']
    query = detail_capture['query']
    header_names = sorted(detail_capture['headers'].keys())
    content_type = detail_capture['headers'].get('content-type')
    if not content_type or detail_capture['responseStatus'] != 200 or detail_capture['responseMime'] != 'application/json':
        raise SafeFailure('HISTORY_DETAIL_BROWSER_PAIR_INVALID')
    request = operation['request']
    request['rpcId'] = 'hNvQHb'
    request['rpcArgsTemplate'] = detail_capture['rpcArgsTemplate']
    request['method'] = 'POST'
    request['origin'] = SERVICE_ORIGIN
    request['path'] = DETAIL_PATH
    request['queryKeys'] = list(query.keys())
    request['headerNames'] = header_names
    request['contentType'] = content_type
    request['bodyFieldNames'] = detail_capture['bodyFields']
    operation['observation'] = {'request': True, 'requestResponse': True}
    operation['effect'] = 'read'
    operation['response'] = {
        'contentType': 'application/json',
        'framing': 'batchexecute',
        'selectorMode': 'rpc_id',
        'rpcId': 'hNvQHb',
        'frameLengthUnit': 'utf16_code_units',
        'frameLengthOverheadUnits': 2,
    }
    contract['observedAt'] = now_iso()
    temp = CONTRACT_PATH.with_suffix('.json.pending')
    temp.write_text(json.dumps(contract, indent=2, ensure_ascii=False) + '\n')
    temp.replace(CONTRACT_PATH)


def find_history_items(data):
    return data[2] if isinstance(data, list) and len(data) > 2 and isinstance(data[2], list) else []


def exact_detail_rpc(value):
    found = []
    stack = [value]
    budget = 0
    while stack and budget < 100_000:
        budget += 1
        current = stack.pop()
        if isinstance(current, list):
            if len(current) >= 3 and current[0] == 'wrb.fr' and current[1] == 'hNvQHb':
                found.append(current)
                continue
            stack.extend(reversed(current))
        elif isinstance(current, dict):
            stack.extend(reversed(list(current.values())))
    return found


def safely_write_receipt(receipt):
    RECEIPT_PATH.parent.mkdir(parents=True, exist_ok=True)
    temp = RECEIPT_PATH.with_suffix('.json.pending')
    temp.write_text(json.dumps(receipt, indent=2, ensure_ascii=False) + '\n')
    os.chmod(temp, 0o600)
    temp.replace(RECEIPT_PATH)


def force_quiet_reset(owner):
    """Reconnect only to the owned browser, install a write block, and return core to /app."""
    try:
        with sync_playwright() as playwright:
            port = int(owner['cdpPort'])
            browser = playwright.chromium.connect_over_cdp(f'http://127.0.0.1:{port}')
            if len(browser.contexts) != 1:
                return False
            context = browser.contexts[0]
            page = page_with_marker(context, GEMINI_CORE_ROLE, SERVICE_ORIGIN)
            cdp = context.new_cdp_session(page)
            cdp.send('Fetch.enable', {'patterns': [{'urlPattern': '*', 'requestStage': 'Request'}]})

            def quiet_guard(event):
                request = event.get('request') or {}
                request_id = event.get('requestId')
                if not request_id:
                    return
                method = str(request.get('method', 'GET')).upper()
                if method in {'GET', 'HEAD', 'OPTIONS'}:
                    try: cdp.send('Fetch.continueRequest', {'requestId': request_id})
                    except Exception: pass
                else:
                    try: cdp.send('Fetch.failRequest', {'requestId': request_id, 'errorReason': 'BlockedByClient'})
                    except Exception: pass

            cdp.on('Fetch.requestPaused', quiet_guard)
            page.goto(f'{SERVICE_ORIGIN}/app', wait_until='domcontentloaded', timeout=45000)
            page.wait_for_timeout(1500)
            quiet = urllib.parse.urlsplit(page.url).path == '/app'
            try: cdp.send('Fetch.disable')
            except Exception: pass
            return quiet
    except Exception:
        return False


def main():
    expected_hash, source_sha = read_static_owner_hash()
    owner, roles, browser_version = runtime_and_roles()
    contract = json.loads(CONTRACT_PATH.read_text())
    intent_hash_count = 0
    expected_owner = None
    browser = None
    cdp = None
    page = None
    guard_enabled = False
    receipt_owned = False
    capture_attempts = []
    state = {
        'phase': 'bootstrap', 'history': None, 'text': None, 'detail': None,
        'streamAttempts': 0, 'unknownPosts': 0, 'measurementPosts': 0,
        'streamResponseCount': 0, 'streamLoadingFailed': [], 'guardFailure': None,
        'historyByNetwork': {}, 'documentHeaders': {}, 'detailByNetwork': {},
        'expectedApiId': None, 'unknownPostSummaries': [], 'unknownPostAbortFailures': 0,
        'preferenceMutationCandidateAbortRequestedCount': 0,
        'preferenceMutationCandidateAbortCommandFailures': 0,
    }
    receipt = {
        'schema': 'gemini-live-one-shot-receipt-v1', 'service': 'gemini-web', 'operation': 'text',
        'taskIntent': CALLER_INTENT, 'outcome': 'needs_review', 'executionHost': 'linux_worker',
        'transport': 'direct_https', 'observedAt': now_iso(),
        'ownerMatched': False, 'anonymousOwnerAbsent': False,
        'sourceVerification': {'expectedOwnerSourceSha256': source_sha, 'staticOwnerHashVerified': False},
        'browserCapture': {'pageRoleMatched': False, 'requestObserved': False, 'requestAbortAck': False,
                           'networkIdMatched': False, 'loadingFailedCount': 0, 'responseCount': 0,
                           'exactPromptMatch': False, 'newTaskChatIdentifierCheck': False},
        'directDispatch': {'count': 0, 'retryCount': 0, 'httpStatus': None, 'responseDecoded': False},
        'readback': {'browserPairMatched': False, 'directDetailStatus': None, 'promptMatched': False,
                     'assistantMarkerMatched': False, 'responseIdMatched': False,
                     'ownerMatched': False, 'anonymousOwnerAbsent': False},
        'mutationJournal': {'intentRecordCount': 0, 'dispatchCount': 0, 'state': 'not_started'},
        'captureAttempts': capture_attempts,
        'persistence': {'credentialsPersisted': False, 'cookiesPersisted': False, 'tokensPersisted': False,
                        'requestBodyPersisted': False, 'responseBodyPersisted': False,
                        'conversationIdentifiersPersisted': False, 'rawPromptPersisted': False},
    }

    try:
        if RECEIPT_PATH.exists():
            try:
                previous = json.loads(RECEIPT_PATH.read_text())
            except Exception as exc:
                raise SafeFailure('EXISTING_RECEIPT_INVALID') from exc
            if (previous.get('taskIntent') != CALLER_INTENT or previous.get('outcome') != 'needs_review'
                    or previous.get('directDispatch', {}).get('count') != 0
                    or previous.get('mutationJournal', {}).get('intentRecordCount') != 0):
                raise SafeFailure('RECEIPT_ALREADY_EXISTS')
            receipt_owned = True
            capture_attempts.extend(previous.get('captureAttempts', []))
            capture_attempts.append({
                'attempt': len(capture_attempts) + 1,
                'outcome': 'capture_stopped_before_direct_dispatch',
                'failureCode': previous.get('failureCode', 'PRIOR_CAPTURE_INCOMPLETE'),
                'directDispatchCount': 0,
            })
        else:
            receipt_owned = True
        receipt['captureAttempts'] = capture_attempts
        with sync_playwright() as playwright:
            port = int(owner['cdpPort'])
            browser = playwright.chromium.connect_over_cdp(f'http://127.0.0.1:{port}')
            if len(browser.contexts) != 1:
                raise SafeFailure('OWNED_CONTEXT_COUNT_INVALID')
            context = browser.contexts[0]
            core = page_with_marker(context, GEMINI_CORE_ROLE, SERVICE_ORIGIN)
            page = core
            grok = page_with_marker(context, GROK_CORE_ROLE, GROK_ORIGIN)
            if urllib.parse.urlsplit(core.url).path != '/app':
                raise SafeFailure('GEMINI_CORE_PAGE_NOT_BLANK_APP')
            expected_owner = read_grok_owner(grok, expected_hash)
            receipt['sourceVerification']['staticOwnerHashVerified'] = True
            intent_hash_count, prior = exact_intent_journal_count(expected_owner)
            if intent_hash_count:
                raise SafeFailure('TASK_INTENT_ALREADY_USED')
            receipt['browserCapture']['pageRoleMatched'] = True
            cdp = context.new_cdp_session(core)
            cdp.send('Network.enable')
            cdp.send('Fetch.enable', {'patterns': [{'urlPattern': '*', 'requestStage': 'Request'}]})
            guard_enabled = True

            def continue_request(request_id):
                try:
                    cdp.send('Fetch.continueRequest', {'requestId': request_id})
                except Exception:
                    state['guardFailure'] = 'FETCH_CONTINUE_FAILED'

            def abort_request(request_id):
                try:
                    cdp.send('Fetch.failRequest', {'requestId': request_id, 'errorReason': 'BlockedByClient'})
                    return True
                except Exception:
                    state['guardFailure'] = 'FETCH_FAIL_FAILED'
                    return False

            def on_request(event):
                request = event.get('request') or {}
                url = request.get('url', '')
                parsed = urllib.parse.urlsplit(url)
                if parsed.hostname == 'gemini.google.com' and parsed.path == '/app' and event.get('type') == 'Document':
                    state['documentHeaders'] = headers_without_credentials(request.get('headers'))

            def on_response(event):
                request_id = event.get('requestId')
                response = event.get('response') or {}
                if state.get('text') and request_id == state['text'].get('networkId'):
                    state['streamResponseCount'] += 1
                detail = state['detailByNetwork'].get(request_id)
                if detail:
                    detail['responseStatus'] = int(response.get('status', 0))
                    detail['responseMime'] = str(response.get('mimeType', '')).split(';', 1)[0].strip().lower()
                    detail['encodedBytes'] = int(response.get('encodedDataLength', 0) or 0)
                history = state['historyByNetwork'].get(request_id)
                if history:
                    history['responseStatus'] = int(response.get('status', 0))
                    history['responseMime'] = str(response.get('mimeType', '')).split(';', 1)[0].strip().lower()

            def on_loading_failed(event):
                if state.get('text') and event.get('requestId') == state['text'].get('networkId'):
                    # Keep only the event count as proof; CDP errorText is diagnostic.
                    state['streamLoadingFailed'].append(True)

            def on_finished(event):
                request_id = event.get('requestId')
                if request_id in state['detailByNetwork']:
                    state['detailByNetwork'][request_id]['loadingFinished'] = True
                history = state['historyByNetwork'].get(request_id)
                if history:
                    history['loadingFinished'] = True

            def on_paused(event):
                request = event.get('request') or {}
                request_id = event.get('requestId')
                network_id = event.get('networkId')
                url = request.get('url', '')
                parsed = urllib.parse.urlsplit(url)
                method = str(request.get('method', 'GET')).upper()
                if not request_id:
                    state['guardFailure'] = 'FETCH_REQUEST_ID_MISSING'
                    return
                if method in {'GET', 'HEAD', 'OPTIONS'}:
                    continue_request(request_id)
                    return
                body = body_from_paused(cdp, request_id, request)
                safe_headers = headers_without_credentials(request.get('headers'))
                if (parsed.scheme == 'https' and parsed.hostname == 'gemini.google.com'
                        and parsed.path == DETAIL_PATH and method == 'POST'
                        and rpc_ids_from_request(url, body) == ['L5adhe']):
                    state['preferenceMutationCandidateAbortRequestedCount'] += 1
                    if not abort_request(request_id):
                        state['preferenceMutationCandidateAbortCommandFailures'] += 1
                    return
                if parsed.scheme == 'https' and parsed.hostname == 'gemini.google.com' and parsed.path == STREAM_PATH and method == 'POST':
                    state['streamAttempts'] += 1
                    capture = None
                    try:
                        contract_request = contract['operations']['text']['request']
                        query_pairs = urllib.parse.parse_qsl(parsed.query, keep_blank_values=True)
                        forms = urllib.parse.parse_qsl(body, keep_blank_values=True)
                        outer = json.loads(parse_form(body)['f.req'])
                        inner = json.loads(outer[1])
                        exact = (
                            state['phase'] == 'text_capture' and len(query_pairs) == len(contract_request['queryKeys'])
                            and [name for name, _ in query_pairs] == contract_request['queryKeys']
                            and [name for name, _ in forms] == contract_request['bodyFieldNames']
                            and isinstance(outer, list) and len(outer) == 2 and outer[0] is None
                            and isinstance(inner, list) and len(inner) == 99 and inner[0][0] == PROMPT
                        )
                        capture = {'url': url, 'method': method, 'body': body, 'headers': safe_headers,
                                   'networkId': network_id, 'exactIntent': exact}
                    except Exception:
                        capture = {'url': url, 'method': method, 'body': body, 'headers': safe_headers,
                                   'networkId': network_id, 'exactIntent': False}
                    if state['text'] is None:
                        state['text'] = capture
                        state['text']['requestId'] = request_id
                        state['text']['failAck'] = abort_request(request_id)
                    else:
                        abort_request(request_id)
                    return
                if parsed.scheme == 'https' and parsed.hostname == 'gemini.google.com' and parsed.path == DETAIL_PATH and method == 'POST':
                    rpcids = rpc_ids_from_request(url, body)
                    if rpcids == ['MaZiqc']:
                        if state['history'] is None:
                            state['history'] = {'url': url, 'method': method, 'body': body,
                                                'headers': safe_headers, 'networkId': network_id}
                            if network_id:
                                state['historyByNetwork'][network_id] = state['history']
                        continue_request(request_id)
                        return
                    if rpcids == ['hNvQHb'] and state['expectedApiId']:
                        candidate = parse_expected_detail_request(url, body, state['expectedApiId'])
                        if candidate and state['detail'] is None:
                            state['detail'] = candidate
                            state['detail']['headers'] = safe_headers
                            state['detail']['contentType'] = safe_headers.get('content-type')
                            state['detail']['requestId'] = request_id
                            state['detail']['networkId'] = network_id
                            if network_id:
                                state['detailByNetwork'][network_id] = state['detail']
                            continue_request(request_id)
                            return
                        abort_request(request_id)
                        return
                    if rpcids and all(rpc_id in READ_RPC_IDS for rpc_id in rpcids):
                        continue_request(request_id)
                        return
                host = parsed.hostname or ''
                path = parsed.path
                if (host, path) in TELEMETRY or (
                    host in {'gemini.google.com', 'www.google.com', 'www.google-analytics.com', 'analytics.google.com', 'play.google.com'}
                    and (path.startswith('/punctual/') or path.startswith('/$rpc/'))
                ):
                    state['measurementPosts'] += 1
                    continue_request(request_id)
                    return
                state['unknownPosts'] += 1
                if len(state['unknownPostSummaries']) < 6:
                    state['unknownPostSummaries'].append(safe_post_summary(url, method, safe_headers, body))
                if not abort_request(request_id):
                    state['unknownPostAbortFailures'] += 1

            cdp.on('Network.requestWillBeSent', on_request)
            cdp.on('Network.responseReceived', on_response)
            cdp.on('Network.loadingFailed', on_loading_failed)
            cdp.on('Network.loadingFinished', on_finished)
            cdp.on('Fetch.requestPaused', on_paused)

            core.reload(wait_until='domcontentloaded', timeout=90000)
            core.wait_for_timeout(9000)
            if urllib.parse.urlsplit(core.url).path != '/app' or state['history'] is None:
                raise SafeFailure('CURRENT_HISTORY_TEMPLATE_NOT_CAPTURED')
            history_response = state['history']
            if not isinstance(history_response.get('networkId'), str):
                raise SafeFailure('HISTORY_NETWORK_ID_MISSING')
            # Verify the read-only bootstrap completed before any text request is triggered.
            core.wait_for_timeout(2000)
            if history_response.get('responseStatus') != 200 or history_response.get('responseMime') != 'application/json' \
                    or not history_response.get('loadingFinished'):
                raise SafeFailure('CURRENT_HISTORY_RESPONSE_NOT_PAIRED')

            box = core.get_by_role('textbox', name='Gemini 프롬프트 입력')
            if box.count() != 1 or not box.evaluate("e => (e.innerText||e.value||'').trim()==='' "):
                raise SafeFailure('NEW_TASK_CHAT_COMPOSER_NOT_EMPTY_OR_UNAVAILABLE')
            state['phase'] = 'text_capture'
            box.fill(PROMPT)
            box.press('Enter')
            core.wait_for_timeout(5000)
            if state['text'] is None or not state['text'].get('exactIntent') or not state['text'].get('failAck'):
                raise SafeFailure('TEXT_REQUEST_CAPTURE_OR_ABORT_FAILED')
            core.wait_for_timeout(1500)
            capture = state['text']
            if state['streamAttempts'] != 1 or not capture.get('networkId'):
                raise SafeFailure('TEXT_STREAM_ATTEMPT_COUNT_INVALID')
            if len(state['streamLoadingFailed']) != 1 or state['streamResponseCount'] != 0:
                raise SafeFailure('TEXT_REQUEST_NETWORK_ABORT_NOT_CONFIRMED')
            if state['unknownPostAbortFailures']:
                raise SafeFailure('UNCLASSIFIED_BUSINESS_POST_ABORT_NOT_CONFIRMED')

            base = expected_context(contract, history_response, capture)
            base['requestHeaders']['identity'] = state['documentHeaders']

            # The current captured browser names extend the safe operation
            # allowlists; only names are persisted, while values stay in stdin.
            add_observed_header_names(contract, 'identity', state['documentHeaders'])
            add_observed_header_names(contract, 'history_list', history_response['headers'])
            add_observed_header_names(contract, 'text', capture['headers'])
            write_contract(contract)
            cookies = context.cookies([SERVICE_ORIGIN])
            allowed_cookie_names = set(contract['auth']['cookieNames'])
            cookie_values = {cookie.get('name'): cookie.get('value') for cookie in cookies
                             if cookie.get('name') in allowed_cookie_names and isinstance(cookie.get('value'), str)}
            if set(cookie_values) != allowed_cookie_names:
                raise SafeFailure('GEMINI_SESSION_COOKIE_SET_INCOMPLETE')
            base['cookies'] = [{'name': name, 'value': value} for name, value in cookie_values.items()]
            receipt['browserCapture'].update({
                'requestObserved': True, 'requestAbortAck': bool(capture['failAck']),
                'networkIdMatched': True, 'loadingFailedCount': len(state['streamLoadingFailed']),
                'responseCount': state['streamResponseCount'], 'exactPromptMatch': True,
                'newTaskChatIdentifierCheck': True, 'currentCookieCount': len(cookie_values),
                'currentHistoryReadPaired': True,
                'preferenceMutationCandidateAbortRequestedCount': state['preferenceMutationCandidateAbortRequestedCount'],
                'preferenceMutationCandidateAbortCommandFailures': state['preferenceMutationCandidateAbortCommandFailures'],
            })
            receipt['browserCapture']['ancillaryPostsAborted'] = state['unknownPosts']
            receipt['browserCapture']['ancillaryPostFamilies'] = state['unknownPostSummaries']
            receipt['anonymousOwnerAbsent'] = True

            capture_envelope = {'session': base, 'capturedRequest': {
                'url': capture['url'], 'method': capture['method'], 'body': capture['body'], 'headers': capture['headers'],
            }, 'prompt': PROMPT}
            text_result = run_node(['text', '--envelope-stdin', '--expect-owner', expected_owner,
                                    '--caller-intent', CALLER_INTENT, '--confirm', '--output=json'], capture_envelope)
            receipt['ownerMatched'] = bool(text_result.get('ownerMatched'))
            receipt['anonymousOwnerAbsent'] = bool(text_result.get('anonymousOwnerAbsent'))
            receipt['directDispatch'].update({
                'count': text_result.get('directDispatchCount', 0),
                'retryCount': text_result.get('retryCount', 0),
                'httpStatus': text_result.get('httpStatus'),
                'contentType': text_result.get('responseContentType'),
                'responseBytes': text_result.get('responseBytes'),
                'responseSha256': text_result.get('responseSha256'),
                'responseDecoded': bool(text_result.get('responseDecoded')),
                'browserResponseContractCaptured': bool(text_result.get('responseContractCaptured')),
                'responseFraming': text_result.get('responseFraming'),
                'nullSelectorFrameCount': text_result.get('nullSelectorFrameCount'),
                'mainCandidateChunkCount': text_result.get('mainCandidateChunkCount'),
                'requestBodyMatchesCapturedSha256': hashlib.sha256(capture['body'].encode()).hexdigest()
                    == text_result.get('wireBodySha256'),
            })
            receipt['historyListReadback'] = {
                'beforeHttpStatus': text_result.get('beforeHistoryStatus'),
                'afterHttpStatus': text_result.get('afterHistoryStatus'),
                'newConversationCount': text_result.get('newConversationCount'),
                'promptMatched': bool(text_result.get('promptMatched')),
                'conversationIdMatched': bool(text_result.get('conversationIdMatched')),
            }
            if text_result.get('requestSent') is not True or text_result.get('directDispatchCount') != 1 \
                    or text_result.get('retryCount') != 0 or text_result.get('httpStatus') != 200:
                raise SafeFailure('DIRECT_TEXT_DISPATCH_NOT_CONFIRMED')
            response_api_id = text_result.get('conversationId')
            before_items = find_history_items(text_result.get('beforeHistoryData'))
            after_items = find_history_items(text_result.get('afterHistoryData'))
            before_ids = {row[0] for row in before_items if isinstance(row, list) and row and isinstance(row[0], str)}
            new_ids = [row[0] for row in after_items if isinstance(row, list) and row and isinstance(row[0], str) and row[0] not in before_ids]
            if len(new_ids) != 1 or not re.fullmatch(r'c_[0-9a-f]{16}', new_ids[0]):
                raise SafeFailure('NEW_CONVERSATION_ID_NOT_UNIQUE')
            api_id_source = 'stream_response_id' if response_api_id == new_ids[0] else 'baseline_history_new_id'
            api_id = new_ids[0]
            receipt['historyListReadback']['conversationIdSource'] = api_id_source
            route_id = api_id[2:]
            if len(route_id) != 16:
                raise SafeFailure('CONVERSATION_ROUTE_BINDING_INVALID')
            state['expectedApiId'] = api_id
            detail_url = f'{SERVICE_ORIGIN}/app/{route_id}'
            core.goto(detail_url, wait_until='domcontentloaded', timeout=90000)
            core.wait_for_timeout(9000)
            if not state.get('detail') or not state['detail'].get('networkId'):
                raise SafeFailure('HISTORY_DETAIL_BROWSER_REQUEST_NOT_CAPTURED')
            core.wait_for_timeout(2500)
            detail = state['detail']
            if detail.get('responseStatus') != 200 or detail.get('responseMime') != 'application/json' \
                    or not detail.get('loadingFinished'):
                raise SafeFailure('HISTORY_DETAIL_BROWSER_PAIR_INVALID')
            contract['operations']['history_read']['request']['rpcArgsTemplate'] = detail['rpcArgsTemplate']
            add_observed_header_names(contract, 'history_read', detail['headers'])
            contract['operations']['history_read']['request']['bodyFieldNames'] = detail['bodyFields']
            contract['operations']['history_read']['request']['contentType'] = detail['contentType']
            contract['operations']['history_read']['request']['queryKeys'] = list(detail['query'].keys())
            contract['operations']['history_read']['response'] = {
                'contentType': detail['responseMime'], 'framing': 'batchexecute',
                'selectorMode': 'rpc_id', 'rpcId': 'hNvQHb',
                'frameLengthUnit': 'utf16_code_units', 'frameLengthOverheadUnits': 2,
            }
            contract['operations']['history_read']['observation'] = {'request': True, 'requestResponse': True}
            contract['operations']['history_read']['effect'] = 'read'
            write_contract(contract)
            receipt['readback']['browserPairMatched'] = True
            receipt['readback']['browserHttpStatus'] = detail['responseStatus']
            receipt['readback']['browserResponseBytes'] = detail.get('encodedBytes')
            receipt['readback']['rpcArgsTemplateInstalled'] = True

            # The captured page context is transient. Reuse only the observed
            # header values and the fresh route/query template for direct read.
            read_session = base
            read_session['requestHeaders']['history_read'] = detail['headers']
            read_session['batchContext']['sourcePath'] = detail['query']['source-path']
            read_session['batchContext']['requestId'] = detail['query']['_reqid']
            read_session['batchContext']['locale'] = detail['query']['hl']
            read_session['batchContext']['requestType'] = detail['query']['rt']
            read_envelope = {
                'session': read_session,
                'apiConversationId': api_id,
                'visibleRouteId': route_id,
                'expectedIntent': PROMPT,
            }
            if isinstance(text_result.get('responseId'), str):
                read_envelope['expectedResponseId'] = text_result['responseId']
            detail_result = run_node(['history', 'read', '--envelope-stdin', '--expect-owner', expected_owner,
                                      '--caller-intent', CALLER_INTENT], read_envelope)
            receipt['readback'].update({
                'directDetailStatus': detail_result.get('httpStatus'),
                'directDetailResponseBytes': detail_result.get('responseBytes'),
                'directDetailResponseSha256': detail_result.get('responseSha256'),
                'apiRouteBindingVerified': bool(detail_result.get('apiRouteBindingVerified')),
                'promptMatched': bool(detail_result.get('promptMatched')),
                'assistantMarkerMatched': bool(detail_result.get('assistantMarkerMatched')),
                'responseIdMatched': bool(detail_result.get('responseIdMatched')),
                'detailResponseCount': detail_result.get('detailResponseCount'),
                'ownerMatched': bool(detail_result.get('ownerMatched')),
                'anonymousOwnerAbsent': bool(detail_result.get('anonymousOwnerAbsent')),
            })
            journal_count, journal_jobs = exact_intent_journal_count(expected_owner)
            journal_job = journal_jobs[0] if len(journal_jobs) == 1 else {}
            receipt['mutationJournal'] = {'intentRecordCount': journal_count,
                                          'dispatchCount': journal_job.get('dispatchCount', 0),
                                          'state': journal_job.get('state', 'missing'),
                                          'resultCategory': 'history_detail_readback' if detail_result.get('journalReconciled') else None}
            receipt['persistence'] = {'credentialsPersisted': False, 'cookiesPersisted': False, 'tokensPersisted': False,
                                      'requestBodyPersisted': False, 'responseBodyPersisted': False,
                                      'conversationIdentifiersPersisted': False, 'rawPromptPersisted': False}
            complete = (
                receipt['ownerMatched'] and receipt['anonymousOwnerAbsent']
                and receipt['browserCapture']['requestObserved'] and receipt['browserCapture']['requestAbortAck']
                and receipt['browserCapture']['networkIdMatched'] and receipt['browserCapture']['loadingFailedCount'] == 1
                and receipt['browserCapture']['responseCount'] == 0 and receipt['browserCapture']['exactPromptMatch']
                and receipt['browserCapture']['newTaskChatIdentifierCheck']
                and receipt['directDispatch']['count'] == 1 and receipt['directDispatch']['retryCount'] == 0
                and receipt['directDispatch']['httpStatus'] == 200 and receipt['directDispatch']['responseDecoded']
                and receipt['directDispatch']['requestBodyMatchesCapturedSha256']
                and detail_result.get('outputStatus') == 'verified' and detail_result.get('journalReconciled') is True
                and detail_result.get('ownerMatched') is True and detail_result.get('anonymousOwnerAbsent') is True
                and intent_hash_count == 0 and journal_count == 1
                and journal_job.get('dispatchCount') == 1 and journal_job.get('state') == 'reconciled'
            )

            # Drop captured request and result bodies, IDs, prompt, and session
            # values after their checks; the receipt contains only safe facts.
            if isinstance(capture, dict):
                capture['body'] = ''
                capture['url'] = ''
                capture['headers'].clear()
            if isinstance(history_response, dict):
                history_response['body'] = ''
                history_response['url'] = ''
                history_response['headers'].clear()
            if isinstance(detail, dict):
                detail['url'] = ''
                detail['headers'].clear()
                detail['query'].clear()
            for cookie in base.get('cookies', []):
                cookie['value'] = ''
            base['cookies'].clear()
            base['headers'].clear()
            base['requestHeaders'].clear()
            base['batchContext'].clear()
            read_envelope.clear()
            text_result.clear()
            detail_result.clear()
            state['history'] = None
            state['text'] = None
            state['detail'] = None
            state['historyByNetwork'].clear()
            state['detailByNetwork'].clear()
            state['documentHeaders'].clear()
            state['expectedApiId'] = None
            api_id = None
            route_id = None
            expected_owner = None

            # Reset to the original empty app route while the Fetch guard is
            # still active. No browser/context/page close is issued.
            state['phase'] = 'quiet_reset'
            core.goto(f'{SERVICE_ORIGIN}/app', wait_until='domcontentloaded', timeout=90000)
            core.wait_for_timeout(5000)
            receipt['browserCapture']['ancillaryPostsAborted'] = state['unknownPosts']
            receipt['browserCapture']['ancillaryPostFamilies'] = state['unknownPostSummaries']
            if urllib.parse.urlsplit(core.url).path != '/app' or state['unknownPostAbortFailures']:
                raise SafeFailure('QUIET_RESET_NOT_CONFIRMED')
            cdp.send('Fetch.disable')
            guard_enabled = False
            receipt['browserCapture']['quietResetVerified'] = True
            complete = complete and receipt['browserCapture']['quietResetVerified']
            receipt['outcome'] = 'verified' if complete else 'needs_review'
            receipt['observedAt'] = now_iso()
            safely_write_receipt(receipt)
            print(json.dumps({'status': receipt['outcome'], 'receipt': str(RECEIPT_PATH),
                              'ownerMatched': receipt['ownerMatched'], 'directDispatchCount': receipt['directDispatch']['count'],
                              'historyDetailReadback': receipt['readback']['directDetailStatus'],
                              'journalState': receipt['mutationJournal']['state']}, separators=(',', ':')))
            return 0 if complete else 1
    except SafeFailure as error:
        receipt['failureCode'] = error.code
        receipt['outcome'] = 'needs_review'
        receipt['observedAt'] = now_iso()
        if expected_owner and receipt_owned:
            # Preserve the evidence boundary while leaving any one-shot journal intact.
            count, jobs = exact_intent_journal_count(expected_owner)
            if count:
                receipt['directDispatch']['count'] = max((job.get('dispatchCount', 0) for job in jobs), default=0)
            receipt['mutationJournal'] = {
                'intentRecordCount': count,
                'dispatchCount': max((job.get('dispatchCount', 0) for job in jobs), default=0),
                'state': max(jobs, key=lambda job: job.get('updatedAt', ''))['state'] if jobs else 'unknown',
            }
            try:
                safely_write_receipt(receipt)
            except Exception:
                pass
        print(json.dumps({'status': 'stopped', 'code': error.code,
                          'dispatchCount': receipt['directDispatch'].get('count', 0),
                          'unclassifiedPosts': state['unknownPostSummaries']}, separators=(',', ':')))
        return 2
    except Exception:
        receipt['failureCode'] = 'UNCLASSIFIED_FAILURE'
        receipt['outcome'] = 'needs_review'
        receipt['observedAt'] = now_iso()
        if expected_owner and receipt_owned:
            try:
                count, jobs = exact_intent_journal_count(expected_owner)
                if count:
                    receipt['directDispatch']['count'] = max((job.get('dispatchCount', 0) for job in jobs), default=0)
                    receipt['mutationJournal'] = {
                        'intentRecordCount': count,
                        'dispatchCount': max((job.get('dispatchCount', 0) for job in jobs), default=0),
                        'state': max(jobs, key=lambda job: job.get('updatedAt', ''))['state'],
                    }
                    safely_write_receipt(receipt)
            except Exception:
                pass
        print(json.dumps({'status': 'stopped', 'code': 'UNCLASSIFIED_FAILURE', 'dispatchCount': receipt['directDispatch'].get('count', 0)}, separators=(',', ':')))
        return 2
    finally:
        if guard_enabled and cdp is not None:
            # The original Playwright driver has already disconnected here;
            # reattach by the verified marker and reset under a fresh block.
            force_quiet_reset(owner)


if __name__ == '__main__':
    raise SystemExit(main())
