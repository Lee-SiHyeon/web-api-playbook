#!/usr/bin/env python3
"""Capture one authorized Gemini media request in memory, abort it in Chrome, then replay it once by HTTPS."""

import base64
import hashlib
import importlib.util
import http.client
import json
import os
import pathlib
import re
import shutil
import subprocess
import sys
import tempfile
import urllib.parse
import urllib.error
import urllib.request
from datetime import datetime, timezone

from playwright.sync_api import sync_playwright


REPO = pathlib.Path(__file__).resolve().parent.parent
RUNTIME_OWNER = pathlib.Path.home() / '.nad-scratch/provider-runtime-20261005/runtime-owner.json'
PAGE_ROLE_REGISTRY = pathlib.Path.home() / '.nad-scratch/provider-runtime-20261005/page-role-registry.json'
MEDIA_MARKER = 'codex-gemini-media-20261006'
CORE_MARKER = 'codex-gemini-core-20261006'
SERVICE_ORIGIN = 'https://gemini.google.com'
STREAM_GENERATE_PATH = '/_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate'
CALLER_INTENT = 'gemini-image-tool-verification-20261006-v1'
IMAGE_INTENT = (
    'Create one photorealistic studio still life on a plain warm-gray backdrop: '
    'a smooth teal sphere next to a matte white cube, both fully visible and separated. '
    'Use soft diffused light and clear edges, with no text, logos, or extra objects.'
)
APPROVED_ACCOUNT_SHA256 = '23e57131977ce522bacf6649eb27538770828a890f7a65589ec4f0960a84b3d7'
MEDIA_ARTIFACT_ROOT = pathlib.Path.home() / 'artifacts/gemini-media-20261006'
READ_RPC_IDS = {
    'CNgdBe', 'MaZiqc', 'ESY5D', 'otAQ7b', 'sJBwce', 'DYBcR', 'whPPme', 'GPRiHf',
    'maGuAc', 'Te6DCf', 'VxUbXb', 'V8rlHe', 'aPya6c', 'cYRIkd', 'ozz5Z', 'K4WWud',
    'I4z33b', 'o30O0e', 'Bsxleb', 'ku4Jyf', 'XhaU0b', 'qpEbW', 'MyzX6c',
}
FORBIDDEN_HEADER_NAMES = {'cookie', 'authorization', 'proxy-authorization', 'host', 'content-length'}


class SafeFailure(Exception):
    def __init__(self, code, details=None):
        self.code = code
        self.details = details


def read_json(path):
    return json.loads(path.read_text(encoding='utf-8'))


def contains_value(value, target):
    if isinstance(value, str):
        return value == target
    if isinstance(value, list):
        return any(contains_value(item, target) for item in value)
    if isinstance(value, dict):
        return any(contains_value(item, target) for item in value.values())
    return False


def shape(value, depth=0):
    if depth > 12:
        return 'depth_limit'
    if value is None:
        return 'null'
    if isinstance(value, bool):
        return 'boolean'
    if isinstance(value, (int, float)):
        return 'number'
    if isinstance(value, str):
        return 'string'
    if isinstance(value, list):
        return {'type': 'array', 'length': len(value), 'items': [shape(item, depth + 1) for item in value[:80]]}
    if isinstance(value, dict):
        return {'type': 'object', 'fields': {key: shape(item, depth + 1) for key, item in sorted(value.items())[:80]}}
    return 'unsupported'


def string_paths(value, expected, prefix=()):
    found = []
    if isinstance(value, str):
        return [list(prefix)] if value == expected else []
    if isinstance(value, list):
        for index, item in enumerate(value):
            found.extend(string_paths(item, expected, (*prefix, index)))
            if len(found) >= 100:
                break
    elif isinstance(value, dict):
        for key, item in value.items():
            found.extend(string_paths(item, expected, (*prefix, key)))
            if len(found) >= 100:
                break
    return found[:100]


def parse_media_payload(raw_body, expected_intent):
    try:
        pairs = urllib.parse.parse_qsl(raw_body.decode('utf-8'), keep_blank_values=True)
    except Exception as exc:
        raise SafeFailure('MEDIA_FORM_INVALID') from exc
    field_names = [name for name, _ in pairs]
    if len(field_names) != len(set(field_names)) or not {'at', 'f.req'}.issubset(set(field_names)):
        raise SafeFailure('MEDIA_FORM_FIELDS_MISMATCH')
    form = dict(pairs)
    if not form.get('at'):
        raise SafeFailure('MEDIA_AT_MISSING')
    try:
        outer = json.loads(form['f.req'])
    except Exception as exc:
        raise SafeFailure('MEDIA_F_REQ_OUTER_INVALID') from exc
    inner = None
    if isinstance(outer, list) and len(outer) == 2 and outer[0] is None and isinstance(outer[1], str):
        try:
            inner = json.loads(outer[1])
        except Exception:
            inner = None
    paths = string_paths(inner, expected_intent) if inner is not None else []
    prompt_match = inner is not None and bool(paths)
    if not prompt_match:
        raise SafeFailure('MEDIA_INTENT_MISMATCH')
    return {
        'fieldNames': field_names,
        'bodyBytes': len(raw_body),
        'outerShape': shape(outer),
        'innerDecoded': inner is not None,
        'innerShape': shape(inner) if inner is not None else 'not_decoded',
        'promptPaths': paths,
        'intentMatch': True,
    }


def rpc_ids_from_request(request):
    try:
        pairs = urllib.parse.parse_qsl((request.post_data_buffer or b'').decode('utf-8'), keep_blank_values=True)
        form = dict(pairs)
        outer = json.loads(form.get('f.req', ''))
        found = []

        def walk(value):
            if isinstance(value, list):
                if len(value) >= 4 and isinstance(value[0], str) and value[3] == 'generic':
                    found.append(value[0])
                for item in value:
                    walk(item)
            elif isinstance(value, str) and value[:1] in ('[', '{'):
                try:
                    walk(json.loads(value))
                except Exception:
                    pass

        walk(outer)
        return found
    except Exception:
        return []


def safe_path(path):
    result = []
    mask_next = False
    for segment in path.split('/'):
        if not segment:
            continue
        if mask_next:
            result.append('{id}')
            mask_next = False
        elif segment.lower() in {'conversations', 'conversation', 'files', 'media', 'artifacts', 'attachments', 'generations', 'projects', 'sessions'}:
            result.append(segment)
            mask_next = True
        elif re.fullmatch(r'[0-9a-fA-F-]{24,}', segment) or re.fullmatch(r'\d{5,}', segment) or (
            len(segment) > 36 and re.search('[0-9]', segment) and re.search('[A-Za-z]', segment)
        ):
            result.append('{id}')
        else:
            result.append(segment[:80])
    return '/' + '/'.join(result)


def safe_post_metadata(url, method, headers, resource_type, raw_body):
    parsed = urllib.parse.urlsplit(url)
    names = []
    try:
        content_type = next((str(value) for key, value in headers.items() if str(key).lower() == 'content-type'), '')
        if 'form' in content_type.lower():
            names = [key for key, _ in urllib.parse.parse_qsl(raw_body.decode('utf-8', 'replace'), keep_blank_values=True)]
    except Exception:
        content_type = ''
    rpc_ids = rpc_ids_from_body(raw_body) if parsed.path.endswith('/batchexecute') else []
    return {
        'method': str(method).upper(),
        'host': parsed.hostname,
        'pathFamily': safe_path(parsed.path),
        'resourceType': str(resource_type or '').lower(),
        'contentType': content_type.split(';', 1)[0].strip().lower(),
        'queryKeyNames': [key for key, _ in urllib.parse.parse_qsl(parsed.query, keep_blank_values=True)],
        'formFieldNames': names,
        'rpcIds': rpc_ids,
        'bodyBytes': len(raw_body),
    }


def is_allowed_telemetry(host, path):
    return (
        (host in {'www.google.com', 'www.google-analytics.com'} and path in {'/ccm/collect', '/g/collect'})
        or (host == 'analytics.google.com' and path == '/g/collect')
        or (host == 'play.google.com' and path == '/log')
        or path.startswith('/punctual/')
        or path.startswith('/$rpc/')
        or path.startswith('/_/BardChatUi/cspreport')
    )


def is_measurement_beacon(host, path):
    return (
        (host == 'www.google.com' and path == '/measurement/conversion')
        or (host == 'googleads.g.doubleclick.net' and path.startswith('/pagead/viewthroughconversion/'))
        or (host == 'www.google.com' and path.startswith('/pagead/1p-conversion/'))
        or (host == 'ad.doubleclick.net' and path == '/ccm/s/collect')
    )


def assert_registered_roles(registry):
    active = registry.get('activePageRoles')
    if not isinstance(active, dict):
        raise SafeFailure('PAGE_ROLE_REGISTRY_INVALID')
    markers = json.dumps(active, ensure_ascii=False)
    if MEDIA_MARKER not in markers or CORE_MARKER not in markers:
        raise SafeFailure('PAGE_ROLE_MARKER_UNREGISTERED')


def owner_from_exact_page(page):
    values = page.evaluate("""() => {
      const text = (document.body?.innerText || '') + ' ' + Array.from(document.querySelectorAll('[aria-label]'))
        .map(element => element.getAttribute('aria-label') || '').join(' ');
      return Array.from(new Set(text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\\.[A-Z]{2,}/ig) || []))
        .map(value => value.trim().toLowerCase());
    }""")
    if not isinstance(values, list) or len(values) != 1 or not isinstance(values[0], str):
        raise SafeFailure('OWNER_CANDIDATE_AMBIGUOUS')
    owner = values[0]
    digest = hashlib.sha256(owner.encode('utf-8')).hexdigest()
    if digest != APPROVED_ACCOUNT_SHA256:
        owner = ''
        raise SafeFailure('OWNER_DIGEST_MISMATCH')
    identity_receipt = read_json(REPO / 'verification/one-shot/gemini-identity-session-2026-10-06.json')
    text_receipt = read_json(REPO / 'verification/one-shot/text-generation-2026-10-06.json')
    if not (identity_receipt.get('ownerMatched') is True
            and identity_receipt.get('anonymousOwnerAbsent') is True
            and identity_receipt.get('nativeSession', {}).get('providerAuthenticatedSessionObserved') is True
            and text_receipt.get('ownerMatched') is True
            and text_receipt.get('anonymousOwnerAbsent') is True):
        owner = ''
        raise SafeFailure('GEMINI_OWNER_RECEIPT_MISMATCH')
    return owner


def verify_fresh_media_intent(actor):
    canonical = json.dumps(['gemini-web', 'image', actor.strip().lower(), CALLER_INTENT], separators=(',', ':'), ensure_ascii=False)
    intent_hash = hashlib.sha256(canonical.encode('utf-8')).hexdigest()
    roots = [
        pathlib.Path.home() / '.config/gemini-web-xhr-client/jobs',
        pathlib.Path.home() / '.nad-scratch/provider-runtime-20261005/media-dispatch-journal',
    ]
    for root in roots:
        if root.exists():
            for journal_path in root.glob('*.json'):
                try:
                    journal = read_json(journal_path)
                except Exception as error:
                    raise SafeFailure('MEDIA_JOURNAL_UNREADABLE') from error
                if journal.get('capability') != 'image':
                    continue
                if journal.get('version') == 1 and journal.get('state') not in ('reconciled', 'confirmed_rejected', 'preflight_failed'):
                    raise SafeFailure('MEDIA_LEGACY_IMAGE_OUTCOME_UNRESOLVED')
                if journal.get('version') == 2 and journal.get('intentKeyHash') == intent_hash:
                    if journal.get('state') != 'preflight_failed':
                        raise SafeFailure('MEDIA_CALLER_INTENT_ALREADY_USED')
            lock = root / 'dispatch-locks' / f'image-{intent_hash}.lock'
            if lock.exists():
                raise SafeFailure('MEDIA_CALLER_INTENT_PENDING')
    registry_path = pathlib.Path.home() / '.nad-scratch/provider-runtime-20261005/media-intents/image.intent.json'
    if registry_path.exists():
        try:
            registry = read_json(registry_path)
        except Exception as error:
            raise SafeFailure('MEDIA_INTENT_REGISTRY_UNREADABLE') from error
        prior_prompt = registry.get('intent')
        if isinstance(prior_prompt, str) and hashlib.sha256(prior_prompt.encode('utf-8')).digest() == hashlib.sha256(IMAGE_INTENT.encode('utf-8')).digest():
            raise SafeFailure('MEDIA_PROMPT_ALREADY_USED')
    receipt_path = REPO / 'discovery' / 'media-browser-capture-2026-10-06.json'
    try:
        receipt = read_json(receipt_path)
    except Exception as error:
        raise SafeFailure('MEDIA_RECEIPT_UNREADABLE') from error
    existing_runs = receipt.get('directMediaRunsByIntent', {})
    if not isinstance(existing_runs, dict):
        raise SafeFailure('MEDIA_RECEIPT_INTENT_ALREADY_RECORDED')
    prior_attempts = [
        entry for key, entry in existing_runs.items()
        if key == CALLER_INTENT or key.startswith(CALLER_INTENT + '.attempt-')
    ]
    for prior in prior_attempts:
        if (not isinstance(prior, dict)
                or prior.get('directErrorCode') not in ('HTTP_SESSION_CONTEXT_MISSING', 'MEDIA_ONESHOT_FAILED')
                or prior.get('historyReadbackVerified') is not False
                or not isinstance(prior.get('directHttp'), dict)
                or prior.get('directHttp', {}).get('directDispatchCount', 0) not in (None, 0)):
            raise SafeFailure('MEDIA_RECEIPT_INTENT_ALREADY_RECORDED')
    attempt_number = len(prior_attempts) + 1
    if attempt_number > 3:
        raise SafeFailure('MEDIA_RECEIPT_RECOVERY_LIMIT')
    audit_attempt_key = CALLER_INTENT if attempt_number == 1 else f'{CALLER_INTENT}.attempt-{attempt_number}'
    if audit_attempt_key in existing_runs:
        raise SafeFailure('MEDIA_RECEIPT_INTENT_ALREADY_RECORDED')
    for extension in ('png', 'jpg'):
        artifact = MEDIA_ARTIFACT_ROOT / f'gemini-image-teal-sphere-white-cube-20261006.direct-http.{extension}'
        if artifact.exists():
            raise SafeFailure('MEDIA_ARTIFACT_PATH_EXISTS')
    return {
        'accountDigestMatchedApproved': True,
        'existingGeminiOwnerAndTextReceiptsMatched': True,
        'journalRootsChecked': len(roots),
        'sameIntentJournalFound': False,
        'auditAttemptNumber': attempt_number,
        'auditAttemptKey': audit_attempt_key,
    }


def capture_history_context_from_request(url, body, headers, contract):
    operation = contract.get('operations', {}).get('history_list', {})
    parsed = urllib.parse.urlsplit(url)
    query_pairs = urllib.parse.parse_qsl(parsed.query, keep_blank_values=True)
    query = dict(query_pairs)
    form_pairs = urllib.parse.parse_qsl(body, keep_blank_values=True)
    form = dict(form_pairs)
    if ([name for name, _ in query_pairs] != operation.get('request', {}).get('queryKeys')
            or [name for name, _ in form_pairs] != operation.get('request', {}).get('bodyFieldNames')
            or query.get('rpcids') != 'MaZiqc' or not form.get('at')):
        raise SafeFailure('HISTORY_CONTEXT_REQUEST_MISMATCH')
    try:
        outer = json.loads(form['f.req'])
        call = outer[0][0]
        args = json.loads(call[1])
    except Exception as error:
        raise SafeFailure('HISTORY_CONTEXT_ARGS_INVALID') from error
    if (not isinstance(call, list) or len(call) != 4 or call[0] != 'MaZiqc'
            or call[2] is not None or call[3] != 'generic'
            or not isinstance(args, list) or len(args) != 3
            or not isinstance(args[0], int) or args[1] is not None
            or not isinstance(args[2], list) or len(args[2]) != 3
            or not isinstance(args[2][0], int) or args[2][1] is not None
            or not isinstance(args[2][2], int)):
        raise SafeFailure('HISTORY_CONTEXT_ARGS_INVALID')
    names = {str(name).lower(): str(value) for name, value in (headers or {}).items()}
    forbidden = {'cookie', 'authorization', 'proxy-authorization', 'host', 'content-length'}
    allowed = {str(name).lower() for name in operation.get('request', {}).get('headerNames', [])}
    captured_headers = {name: value for name, value in names.items() if name in allowed and name not in forbidden}
    required = ('f.sid', 'bl', 'hl', 'rt', 'source-path', '_reqid')
    if any(not query.get(name) for name in required) or not re.fullmatch(r'\d{1,12}', query['_reqid']):
        raise SafeFailure('HISTORY_CONTEXT_QUERY_INVALID')
    context = {
        'at': form['at'],
        'fSid': query['f.sid'],
        'buildLabel': query['bl'],
        'locale': query['hl'],
        'requestType': query['rt'],
        'sourcePath': query['source-path'],
        'requestId': query['_reqid'],
        'historyListArgs': args,
    }
    return context, captured_headers


def select_capture_session_function():
    path = REPO / 'scripts' / 'run-linux-api.py'
    spec = importlib.util.spec_from_file_location('gemini_linux_api_runner', path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module.capture_session


def capture_browser_request_cdp(capability, intent, base_contract, *, bootstrap_only=False, readback_only=False, download_asset=True):
    target_path = '/images' if capability == 'image' else '/videos'
    state = {
        'capture': None,
        'network_id': None,
        'fetch_id': None,
        'fail_ack': False,
        'fail_count': 0,
        'loading_failed_class': 'not_observed',
        'response_count': 0,
        'unexpected_posts': 0,
        'unexpected_post_metadata': [],
        'measurement_beacons_blocked': 0,
        'measurement_path_families': set(),
        'read_rpc_by_network': {},
        'read_rpc_summaries': [],
        'preference_mutation_candidate_abort_requested_count': 0,
        'preference_mutation_candidate_abort_command_failures': 0,
        'guard_failure': None,
        'expected_asset_url': None,
        'native_asset_requests': {},
        'native_asset_request_ids': [],
        'native_asset_pending_extra': {},
        'history_context_capture': None,
        'history_context_headers': {},
        'history_context_network_id': None,
        'history_context_response_verified': False,
        'history_context_candidates': [],
        'history_context_by_network': {},
    }
    with sync_playwright() as playwright:
        owner = read_json(RUNTIME_OWNER)
        pid = owner.get('chromePid')
        if not isinstance(pid, int):
            raise SafeFailure('OWNED_RUNTIME_INVALID')
        args = pathlib.Path(f'/proc/{pid}/cmdline').read_bytes().split(b'\0')
        port = next((int(arg.split(b'=', 1)[1]) for arg in args if arg.startswith(b'--remote-debugging-port=')), None)
        if not isinstance(port, int) or not 1 <= port <= 65535:
            raise SafeFailure('OWNED_RUNTIME_PORT_MISSING')
        browser = playwright.chromium.connect_over_cdp(f'http://127.0.0.1:{port}')
        if len(browser.contexts) != 1:
            raise SafeFailure('OWNED_CONTEXT_COUNT_INVALID')
        context = browser.contexts[0]
        pages = []
        for page in context.pages:
            parsed = urllib.parse.urlsplit(page.url)
            if parsed.scheme == 'https' and parsed.hostname == 'gemini.google.com':
                try:
                    if page.evaluate('() => window.name') == MEDIA_MARKER:
                        pages.append(page)
                except Exception:
                    pass
        if len(pages) != 1:
            raise SafeFailure('MEDIA_PAGE_ROLE_AMBIGUOUS')
        page = pages[0]
        page.keyboard.press('Escape')
        cdp = context.new_cdp_session(page)
        cdp.send('Network.enable')
        cdp.send('Fetch.enable', {'patterns': [{'urlPattern': 'https://gemini.google.com/*', 'requestStage': 'Request'}]})

        def continue_request(request_id):
            try:
                cdp.send('Fetch.continueRequest', {'requestId': request_id})
            except Exception:
                state['guard_failure'] = 'FETCH_CONTINUE_FAILED'

        def fail_request(request_id):
            try:
                cdp.send('Fetch.failRequest', {'requestId': request_id, 'errorReason': 'BlockedByClient'})
                return True
            except Exception:
                state['guard_failure'] = 'FETCH_FAIL_FAILED'
                return False

        def on_paused(event):
            try:
                req = event.get('request') or {}
                url = req.get('url', '')
                parsed = urllib.parse.urlsplit(url)
                method = str(req.get('method', 'GET')).upper()
                request_id = event.get('requestId')
                if not request_id:
                    state['guard_failure'] = 'FETCH_REQUEST_ID_MISSING'
                    return
                if method in ('GET', 'HEAD', 'OPTIONS'):
                    continue_request(request_id)
                    return
                if parsed.scheme == 'https' and parsed.hostname == 'gemini.google.com' and parsed.path == STREAM_GENERATE_PATH and method == 'POST' and state['capture'] is None:
                    encoded_body = req.get('postData')
                    if encoded_body is None:
                        try:
                            encoded_body = cdp.send('Fetch.getRequestPostData', {'requestId': request_id}).get('postData', '')
                        except Exception:
                            encoded_body = ''
                    raw = str(encoded_body).encode('utf-8')
                    schema = parse_media_payload(raw, intent)
                    headers = {}
                    for name, value in (req.get('headers') or {}).items():
                        if str(name).lower() not in FORBIDDEN_HEADER_NAMES:
                            headers[str(name).lower()] = str(value)
                    network_id = event.get('networkId')
                    capture = {
                        'origin': parsed.scheme + '://' + parsed.netloc,
                        'url': url,
                        'path': parsed.path,
                        'method': method,
                        'resourceType': str(event.get('resourceType', 'xhr')).lower(),
                        'contentType': next((value for name, value in headers.items() if name.lower() == 'content-type'), ''),
                        'headers': headers,
                        'body': raw,
                        'browserAbortVerified': False,
                        'requestGuid': request_id,
                        'schema': schema,
                    }
                    state['capture'] = capture
                    state['network_id'] = network_id
                    state['fetch_id'] = request_id
                    state['fail_ack'] = fail_request(request_id)
                    capture['browserAbortVerified'] = state['fail_ack']
                    return
                if parsed.scheme == 'https' and parsed.hostname == 'gemini.google.com' and method == 'POST' and parsed.path == '/_/BardChatUi/data/batchexecute':
                    raw = str(req.get('postData') or '').encode('utf-8')
                    body_ids = rpc_ids_from_body(raw)
                    query_ids = urllib.parse.parse_qs(parsed.query, keep_blank_values=True).get('rpcids', [])
                    ids = body_ids + query_ids
                    if 'L5adhe' in ids:
                        state['preference_mutation_candidate_abort_requested_count'] += 1
                        if not fail_request(request_id):
                            state['preference_mutation_candidate_abort_command_failures'] += 1
                        return
                    decoded_form = urllib.parse.unquote_plus(raw.decode('utf-8', 'replace'))
                    contains_prompt = intent in decoded_form
                    if ids and all(rpc_id in READ_RPC_IDS for rpc_id in ids) and not contains_prompt:
                        relevant = sorted(set(rpc_id for rpc_id in ids if rpc_id in ('MaZiqc', 'otAQ7b')))
                        if relevant:
                            pairs = urllib.parse.parse_qsl(raw.decode('utf-8', 'replace'), keep_blank_values=True)
                            request_headers = req.get('headers') or {}
                            if 'MaZiqc' in relevant:
                                context_values, context_headers = capture_history_context_from_request(
                                    url, raw.decode('utf-8', 'replace'), request_headers, base_contract,
                                )
                                context_candidate = {
                                    'context': context_values,
                                    'headers': context_headers,
                                    'networkId': event.get('networkId'),
                                    'responseVerified': False,
                                    'summaryCount': None,
                                }
                                state['history_context_candidates'].append(context_candidate)
                                if event.get('networkId'):
                                    state['history_context_by_network'][event['networkId']] = context_candidate
                            entry = {
                                'rpcIds': relevant,
                                'method': method,
                                'host': parsed.hostname,
                                'pathFamily': safe_path(parsed.path),
                                'queryKeyNames': [key for key, _ in urllib.parse.parse_qsl(parsed.query, keep_blank_values=True)],
                                'headerNames': sorted(str(key).lower() for key in request_headers.keys()),
                                'formFieldNames': [key for key, _ in pairs],
                                'bodyBytes': len(raw),
                                'status': None,
                                'mime': None,
                                'responseBytes': None,
                                'responseFraming': None,
                                'responseRpcIds': [],
                                'responseShapes': [],
                            }
                            state['read_rpc_summaries'].append(entry)
                            if event.get('networkId'):
                                state['read_rpc_by_network'][event['networkId']] = entry
                        continue_request(request_id)
                        return
                if is_allowed_telemetry(parsed.hostname or '', safe_path(parsed.path)):
                    continue_request(request_id)
                    return
                if parsed.hostname == 'gemini.google.com' and parsed.path in {'/_/BardChatUi/jserror', '/_/BardChatUi/cspreport', '/_/BardChatUi/cspreport/fine-allowlist'}:
                    continue_request(request_id)
                    return
                if is_measurement_beacon(parsed.hostname or '', parsed.path):
                    state['measurement_beacons_blocked'] += 1
                    state['measurement_path_families'].add(safe_path(parsed.path))
                    fail_request(request_id)
                    return
                state['unexpected_posts'] += 1
                raw = str(req.get('postData') or '').encode('utf-8')
                state['unexpected_post_metadata'].append(safe_post_metadata(url, method, req.get('headers') or {}, event.get('resourceType'), raw))
                fail_request(request_id)
            except SafeFailure as error:
                state['guard_failure'] = error.code
                request_id = event.get('requestId')
                if request_id:
                    fail_request(request_id)
            except Exception:
                state['guard_failure'] = 'FETCH_GUARD_FAILED'
                request_id = event.get('requestId')
                if request_id:
                    fail_request(request_id)

        def on_loading_failed(event):
            if state['network_id'] and event.get('requestId') == state['network_id']:
                state['fail_count'] += 1
                error_text = event.get('errorText', '')
                if error_text == 'net::ERR_BLOCKED_BY_CLIENT':
                    state['loading_failed_class'] = 'blocked_by_client'
                elif error_text == 'net::ERR_FAILED':
                    state['loading_failed_class'] = 'net_error_failed'
                elif error_text == 'net::ERR_ABORTED':
                    state['loading_failed_class'] = 'net_error_aborted'
                else:
                    state['loading_failed_class'] = 'net_error_other'
            native = state['native_asset_requests'].get(event.get('requestId'))
            if native:
                native['loadingFailed'] = True

        def native_header_summary(headers):
            lower = {str(name).lower(): str(value) for name, value in (headers or {}).items()}
            cookie_header = lower.get('cookie', '')
            cookie_names = []
            if cookie_header:
                for pair in cookie_header.split(';'):
                    name = pair.split('=', 1)[0].strip()
                    if re.fullmatch(r'[A-Za-z0-9_.$-]{1,128}', name):
                        cookie_names.append(name)
            return {
                'headerNames': sorted(set(lower)),
                'cookieHeaderPresent': bool(cookie_header),
                'cookieNames': sorted(set(cookie_names)),
                'selectedHeaders': {
                    name: lower[name] for name in (
                        'accept', 'accept-language', 'cache-control', 'pragma', 'priority', 'referer', 'user-agent',
                        'sec-ch-ua', 'sec-ch-ua-arch', 'sec-ch-ua-bitness', 'sec-ch-ua-form-factors',
                        'sec-ch-ua-full-version', 'sec-ch-ua-full-version-list', 'sec-ch-ua-mobile',
                        'sec-ch-ua-model', 'sec-ch-ua-platform', 'sec-ch-ua-platform-version', 'sec-ch-ua-wow64',
                        'sec-fetch-dest', 'sec-fetch-mode', 'sec-fetch-site', 'sec-fetch-storage-access',
                        'x-browser-channel', 'x-browser-copyright', 'x-browser-validation', 'x-browser-year', 'x-client-data',
                    ) if name in lower
                },
            }

        def media_ref(url):
            parsed = urllib.parse.urlsplit(url)
            query_names = sorted(set(key for key, _ in urllib.parse.parse_qsl(parsed.query, keep_blank_values=True)))
            return {
                'origin': canonical_https_origin(parsed.scheme, parsed.netloc),
                'pathFamily': media_path_family(parsed.path),
                'queryKeyNames': query_names,
            }

        def media_resource_identity_digest(url):
            parsed = urllib.parse.urlsplit(url)
            resource = parsed.path.rstrip('/').rsplit('/', 1)[-1]
            # The observed Google image edge maps /gg to /rd-gg with the same
            # terminal resource segment; retain the exact query string.
            return hashlib.sha256((resource + '\0' + parsed.query).encode('utf-8')).hexdigest()

        def make_native_hop(url, method, headers):
            summary = native_header_summary(headers)
            return {
                'url': url,
                'method': method,
                'headerNames': summary['headerNames'],
                'observedHeaders': summary['selectedHeaders'],
                'cookieHeaderPresent': summary['cookieHeaderPresent'],
                'cookieNames': summary['cookieNames'],
                'extraCaptured': False,
            }

        def merge_native_extra(entry, summary):
            for index, hop in enumerate(entry.get('hops', [])):
                if hop.get('extraCaptured'):
                    continue
                hop['headerNames'] = sorted(set(hop['headerNames']) | set(summary['headerNames']))
                hop['observedHeaders'].update(summary['selectedHeaders'])
                if summary['cookieHeaderPresent']:
                    hop['cookieHeaderPresent'] = True
                    hop['cookieNames'] = sorted(set(hop['cookieNames']) | set(summary['cookieNames']))
                hop['extraCaptured'] = True
                if index == 0:
                    entry['headerNames'] = sorted(set(entry['headerNames']) | set(hop['headerNames']))
                    entry['observedHeaders'].update(hop['observedHeaders'])
                    entry['cookieHeaderPresent'] = hop['cookieHeaderPresent']
                    entry['cookieNames'] = list(hop['cookieNames'])
                else:
                    edge = entry['redirectEdges'][index - 1]
                    edge['headerNames'] = sorted(set(edge['headerNames']) | set(hop['headerNames']))
                    edge['observedHeaders'] = dict(hop['observedHeaders'])
                    edge['cookieHeaderPresent'] = hop['cookieHeaderPresent']
                    edge['cookieNames'] = list(hop['cookieNames'])
                return True
            return False

        def drain_pending_native_extra(request_id, entry):
            pending = state['native_asset_pending_extra'].get(request_id, [])
            while pending and merge_native_extra(entry, pending[0]):
                pending.pop(0)
            if not pending:
                state['native_asset_pending_extra'].pop(request_id, None)

        def on_native_request(event):
            request_id = event.get('requestId')
            request = event.get('request') or {}
            url = request.get('url')
            method = str(request.get('method', 'GET')).upper()
            if not request_id or not isinstance(url, str):
                return
            entry = state['native_asset_requests'].get(request_id)
            if entry is None:
                if url != state['expected_asset_url'] or method != 'GET':
                    return
                entry = {
                    'exactUrlMatched': True,
                    'initialUrl': url,
                    'lastUrl': url,
                    'method': method,
                    'headerNames': [],
                    'observedHeaders': {},
                    'cookieHeaderPresent': False,
                    'cookieNames': [],
                    'hops': [make_native_hop(url, method, request.get('headers') or {})],
                    'httpStatus': None,
                    'mime': None,
                    'redirectEdges': [],
                    'loadingFailed': False,
                    'loadingFinished': False,
                }
                state['native_asset_requests'][request_id] = entry
                state['native_asset_request_ids'].append(request_id)
                source_hop = entry['hops'][0]
                entry['headerNames'] = list(source_hop['headerNames'])
                entry['observedHeaders'] = dict(source_hop['observedHeaders'])
                entry['cookieHeaderPresent'] = source_hop['cookieHeaderPresent']
                entry['cookieNames'] = list(source_hop['cookieNames'])
                drain_pending_native_extra(request_id, entry)
            else:
                redirect = event.get('redirectResponse') or {}
                if redirect:
                    status = redirect.get('status')
                    if isinstance(status, int):
                        next_hop = make_native_hop(url, method, request.get('headers') or {})
                        entry['redirectEdges'].append({
                            'httpStatus': status,
                            'from': media_ref(entry['lastUrl']),
                            'to': media_ref(url),
                            'fromResourceIdentitySha256': media_resource_identity_digest(entry['lastUrl']),
                            'toResourceIdentitySha256': media_resource_identity_digest(url),
                            'observedHeaders': dict(next_hop['observedHeaders']),
                            'headerNames': list(next_hop['headerNames']),
                            'cookieHeaderPresent': next_hop['cookieHeaderPresent'],
                            'cookieNames': list(next_hop['cookieNames']),
                        })
                        entry['hops'].append(next_hop)
                        drain_pending_native_extra(request_id, entry)
                entry['lastUrl'] = url
            drain_pending_native_extra(request_id, entry)

        def on_native_extra(event):
            request_id = event.get('requestId')
            if not request_id:
                return
            summary = native_header_summary(event.get('headers') or {})
            entry = state['native_asset_requests'].get(request_id)
            if entry is None:
                if state['expected_asset_url'] is not None and len(state['native_asset_pending_extra']) < 40:
                    state['native_asset_pending_extra'].setdefault(request_id, []).append(summary)
                return
            if not merge_native_extra(entry, summary):
                state['native_asset_pending_extra'].setdefault(request_id, []).append(summary)

        def on_native_response(event):
            entry = state['native_asset_requests'].get(event.get('requestId'))
            if not entry:
                return
            response = event.get('response') or {}
            status = response.get('status')
            entry['httpStatus'] = int(status) if isinstance(status, (int, float)) and int(status) == status else None
            entry['mime'] = str(response.get('mimeType', '')).split(';', 1)[0].strip().lower()

        def on_native_finished(event):
            entry = state['native_asset_requests'].get(event.get('requestId'))
            if entry:
                entry['loadingFinished'] = True

        def on_response(event):
            if state['network_id'] and event.get('requestId') == state['network_id']:
                state['response_count'] += 1

        def on_read_response(event):
            entry = state['read_rpc_by_network'].get(event.get('requestId'))
            if entry:
                response = event.get('response') or {}
                entry['status'] = response.get('status')
                entry['mime'] = str(response.get('mimeType', '')).split(';', 1)[0].lower()
                entry['responseBytes'] = response.get('encodedDataLength')

        def on_read_finished(event):
            entry = state['read_rpc_by_network'].get(event.get('requestId'))
            if entry:
                entry['_finished'] = True

        def finalize_read_responses():
            for network_id, entry in state['read_rpc_by_network'].items():
                if not entry.pop('_finished', False):
                    entry['responseFraming'] = 'body_not_finished'
                    continue
                try:
                    result = cdp.send('Network.getResponseBody', {'requestId': network_id})
                    body = base64.b64decode(result.get('body', '')) if result.get('base64Encoded') else result.get('body', '').encode('utf-8')
                    frames, framing = parse_response_frames(body)
                    response_ids = []
                    response_shapes = []

                    def walk_response(value):
                        if isinstance(value, list):
                            if len(value) >= 3 and value[0] == 'wrb.fr' and isinstance(value[1], str):
                                response_ids.append(value[1])
                                payload = value[2]
                                if isinstance(payload, str):
                                    try:
                                        payload = json.loads(payload)
                                    except Exception:
                                        pass
                                decoded_payload = parse_nested_json(payload)
                                response_shapes.append(safe_response_shape(decoded_payload))
                                candidate = state['history_context_by_network'].get(network_id)
                                if (candidate and value[1] == 'MaZiqc'
                                        and isinstance(decoded_payload, list) and len(decoded_payload) >= 3
                                        and isinstance(decoded_payload[2], list)):
                                    candidate['summaryCount'] = len(decoded_payload[2])
                            else:
                                for child in value:
                                    walk_response(child)
                        elif isinstance(value, dict):
                            for child in value.values():
                                walk_response(child)

                    for frame in frames:
                        walk_response(frame)
                    entry['responseBytes'] = len(body)
                    entry['responseFraming'] = framing
                    entry['responseRpcIds'] = sorted(set(response_ids))
                    entry['responseShapes'] = response_shapes[:10]
                    candidate = state['history_context_by_network'].get(network_id)
                    if candidate:
                        candidate['responseVerified'] = bool(
                            entry.get('status') == 200 and 'MaZiqc' in entry['responseRpcIds']
                        )
                except Exception:
                    entry['responseFraming'] = 'body_unavailable'

            verified_contexts = [item for item in state['history_context_candidates'] if item.get('responseVerified')]
            populated_contexts = [item for item in verified_contexts if isinstance(item.get('summaryCount'), int) and item['summaryCount'] > 0]
            selected_context = (populated_contexts or verified_contexts)[-1] if (populated_contexts or verified_contexts) else None
            if selected_context:
                state['history_context_capture'] = selected_context['context']
                state['history_context_headers'] = selected_context['headers']
                state['history_context_network_id'] = selected_context['networkId']
                state['history_context_response_verified'] = True

        cdp.on('Fetch.requestPaused', on_paused)
        cdp.on('Network.loadingFailed', on_loading_failed)
        cdp.on('Network.responseReceived', on_response)
        cdp.on('Network.responseReceived', on_read_response)
        cdp.on('Network.loadingFinished', on_read_finished)
        cdp.on('Network.requestWillBeSent', on_native_request)
        cdp.on('Network.requestWillBeSentExtraInfo', on_native_extra)
        cdp.on('Network.responseReceived', on_native_response)
        cdp.on('Network.loadingFinished', on_native_finished)
        current = urllib.parse.urlsplit(page.url)
        if current.path != target_path:
            page.goto(SERVICE_ORIGIN + target_path, wait_until='domcontentloaded', timeout=30000)
            page.wait_for_timeout(4500)
        page.wait_for_timeout(4500)
        current = urllib.parse.urlsplit(page.url)
        if current.scheme != 'https' or current.hostname != 'gemini.google.com' or current.path != target_path:
            raise SafeFailure('MEDIA_ROUTE_NOT_REACHED')
        if page.evaluate('() => window.name') != MEDIA_MARKER:
            raise SafeFailure('MEDIA_PAGE_MARKER_CHANGED')
        expected_owner = owner_from_exact_page(page)
        intent_preflight = None if (bootstrap_only or readback_only) else verify_fresh_media_intent(expected_owner)
        if state['history_context_capture'] is None:
            page.goto(SERVICE_ORIGIN + '/app', wait_until='domcontentloaded', timeout=30000)
            page.wait_for_timeout(9000)
            finalize_read_responses()
            if state['guard_failure'] or state['unexpected_posts']:
                raise SafeFailure('HISTORY_CONTEXT_PREFLIGHT_GUARD_FAILED')
            if state['history_context_capture'] is None or state['history_context_response_verified'] is not True:
                raise SafeFailure('HISTORY_CONTEXT_NOT_CAPTURED')
            page.goto(SERVICE_ORIGIN + target_path, wait_until='domcontentloaded', timeout=30000)
            page.wait_for_timeout(4500)
            current = urllib.parse.urlsplit(page.url)
            if current.scheme != 'https' or current.hostname != 'gemini.google.com' or current.path != target_path:
                raise SafeFailure('MEDIA_ROUTE_NOT_REACHED_AFTER_CONTEXT_CAPTURE')
            if page.evaluate('() => window.name') != MEDIA_MARKER:
                raise SafeFailure('MEDIA_PAGE_MARKER_CHANGED')
        if bootstrap_only or readback_only:
            cookies = context.cookies(SERVICE_ORIGIN)
            allowed_cookies = set(base_contract['auth']['cookieNames'])
            cookie_map = {item['name']: item['value'] for item in cookies if item['name'] in allowed_cookies}
            if set(cookie_map) != allowed_cookies:
                raise SafeFailure('SESSION_INCOMPLETE')
            session = {
                'version': 1,
                'service': base_contract['service'],
                'origin': SERVICE_ORIGIN,
                'capturedAt': datetime.now(timezone.utc).isoformat(),
                'cookies': [{'name': name, 'value': value} for name, value in cookie_map.items()],
                'headers': {},
                'requestHeaders': {'history_list': state['history_context_headers']},
                'batchContext': state['history_context_capture'],
            }
            if download_asset:
                media_contract = base_contract.get('mediaAssetDownload') or {}
                required_names = {
                    name for edge in media_contract.get('redirectEdges', [])
                    for name in edge.get('cookieNames', [])
                }
                expected_scopes = {
                    item['name']: item for item in media_contract.get('cookieScopes', [])
                    if isinstance(item, dict) and isinstance(item.get('name'), str)
                }
                media_context_cookies = context.cookies('https://lh3.google.com/rd-gg/')
                session['mediaCookies'] = [
                    {key: item.get(key) for key in ('name', 'value', 'domain', 'path', 'secure', 'expires') if key in item}
                    for item in media_context_cookies
                    if item.get('name') in required_names
                    and item.get('domain') == expected_scopes.get(item.get('name'), {}).get('domain')
                    and item.get('path') == expected_scopes.get(item.get('name'), {}).get('path')
                    and item.get('secure') == expected_scopes.get(item.get('name'), {}).get('secure')
                ]
                media_cookie_set_complete = {item.get('name') for item in session['mediaCookies']} == required_names
            else:
                media_cookie_set_complete = True
            try:
                if not media_cookie_set_complete:
                    raise SafeFailure('MEDIA_CONTEXT_COOKIE_SET_INCOMPLETE', {
                        'expectedCookieNameCount': len(required_names),
                        'currentScopedCookieNameCount': len(session.get('mediaCookies', [])),
                    })
                result = (run_task_asset_readback_check(session, expected_owner, download_asset) if readback_only
                          else run_session_bootstrap_check(session, expected_owner))
                asset_verification = result.get('assetDownload') if isinstance(result, dict) else None
                asset_error_code = result.get('error') if isinstance(result, dict) and result.get('status') != 'verified' else None
                asset_error_details = None
                native_attempt_summary = None
                page.keyboard.press('Escape')
                current_after = urllib.parse.urlsplit(page.url)
                if current_after.scheme != 'https' or current_after.hostname != 'gemini.google.com' or current_after.path != target_path:
                    page.goto(SERVICE_ORIGIN + target_path, wait_until='domcontentloaded', timeout=30000)
                    page.wait_for_timeout(4500)
                composer = page.locator('[aria-label="Gemini 프롬프트 입력"]')
                if composer.count() == 1 and composer.is_visible():
                    composer.fill('', timeout=10000)
                page.wait_for_timeout(1200)
                current_after = urllib.parse.urlsplit(page.url)
                quiet = bool(
                    current_after.scheme == 'https' and current_after.hostname == 'gemini.google.com'
                    and current_after.path == target_path and page.evaluate('() => window.name') == MEDIA_MARKER
                    and state['guard_failure'] is None and state['unexpected_posts'] == 0
                    and state['preference_mutation_candidate_abort_command_failures'] == 0
                )
                return {
                    'mode': 'readback-only' if readback_only else 'bootstrap-only',
                    'accountDigestMatchedApproved': True,
                    'historyContextRequestCaptured': state['history_context_capture'] is not None,
                    'historyContextResponseVerified': state['history_context_response_verified'] is True,
                    'directBootstrap': None if readback_only else result,
                    'taskReadback': result if readback_only else None,
                    'selectedAssetRef': None,
                    'assetVerification': asset_verification,
                    'nativeAttemptSummary': native_attempt_summary,
                    'assetErrorCode': asset_error_code,
                    'assetErrorDetails': asset_error_details,
                    'resetQuietVerified': quiet,
                    'guardFailure': state['guard_failure'],
                    'unexpectedPostCount': state['unexpected_posts'],
                    'readOnlyRpcReceipts': state['read_rpc_summaries'][:40],
                }
            finally:
                expected_owner = ''
                for item in session.get('cookies', []):
                    item['value'] = ''
                for item in session.get('mediaCookies', []):
                    item['value'] = ''
                session.clear()
                try:
                    cdp.send('Fetch.disable')
                    cdp.send('Network.disable')
                except Exception:
                    pass
        composer = page.locator('[aria-label="Gemini 프롬프트 입력"]')
        if composer.count() != 1 or not composer.is_visible():
            raise SafeFailure('MEDIA_COMPOSER_MISSING')
        purchase = page.evaluate("""() => {const re=/(payment|billing|subscribe|subscription|trial|upgrade|구독|결제|요금제|업그레이드)/i;const ds=Array.from(document.querySelectorAll('[role=dialog],[aria-modal=true]')).filter(e=>{const r=e.getBoundingClientRect();return r.width>0&&r.height>0});const main=document.querySelector('[role=main]')||document.querySelector('main');return ds.some(e=>re.test(e.innerText||''))||!!main&&re.test(main.innerText||'')}""")
        if purchase:
            raise SafeFailure('PURCHASE_PROMPT_PRESENT')
        composer.fill(intent, timeout=10000)
        page.wait_for_timeout(600)
        if state['guard_failure'] or state['unexpected_posts']:
            raise SafeFailure(state['guard_failure'] or 'UNOBSERVED_POST_BLOCKED', {
                'blockedPostCount': state['unexpected_posts'],
                'blockedPosts': state['unexpected_post_metadata'][:10],
            })
        controls = page.evaluate("""() => Array.from(document.querySelectorAll('button')).filter(e=>{const r=e.getBoundingClientRect();return r.width>0&&r.height>0}).map(e=>({name:(e.getAttribute('aria-label')||e.getAttribute('title')||'').trim(),enabled:!e.disabled&&e.getAttribute('aria-disabled')!=='true'})).filter(x=>/(send|보내기|전송)/i.test(x.name))""")
        send = page.locator('button[aria-label="메시지 보내기"]')
        if not controls or send.count() != 1 or not send.is_visible() or not send.is_enabled():
            raise SafeFailure('MEDIA_SEND_CONTROL_DISABLED')
        send.click(timeout=10000)
        page.wait_for_timeout(8000)
        finalize_read_responses()
        capture = state['capture']
        if state['guard_failure'] or state['unexpected_posts']:
            raise SafeFailure(state['guard_failure'] or 'UNOBSERVED_POST_BLOCKED', {
                'blockedPostCount': state['unexpected_posts'],
                'blockedPosts': state['unexpected_post_metadata'][:10],
            })
        if not capture or capture.get('browserAbortVerified') is not True:
            raise SafeFailure('MEDIA_BROWSER_ABORT_UNVERIFIED', {
                'targetCaptured': bool(capture),
                'intentMatch': bool(capture and capture.get('schema', {}).get('intentMatch')),
                'fetchFailAck': state['fail_ack'],
                'networkIdPresent': state['network_id'] is not None,
                'loadingFailedCount': state['fail_count'],
                'loadingFailedClass': state['loading_failed_class'],
                'targetResponseCount': state['response_count'],
            })
        if (state['fail_ack'] is not True or state['network_id'] is None
                or state['fail_count'] != 1 or state['response_count'] != 0):
            raise SafeFailure('MEDIA_BROWSER_ABORT_UNVERIFIED', {
                'targetCaptured': True,
                'intentMatch': bool(capture.get('schema', {}).get('intentMatch')),
                'fetchFailAck': state['fail_ack'],
                'networkIdPresent': state['network_id'] is not None,
                'loadingFailedCount': state['fail_count'],
                'loadingFailedClass': state['loading_failed_class'],
                'targetResponseCount': state['response_count'],
            })
        capture['browserAbortFailureReason'] = state['loading_failed_class']
        capture['measurementBeaconCountBlocked'] = state['measurement_beacons_blocked']
        capture['measurementPathFamiliesBlocked'] = sorted(state['measurement_path_families'])
        capture['preferenceMutationCandidateAbortRequestedCount'] = state['preference_mutation_candidate_abort_requested_count']
        capture['preferenceMutationCandidateAbortCommandFailures'] = state['preference_mutation_candidate_abort_command_failures']
        capture['readOnlyRpcReceipts'] = state['read_rpc_summaries'][:40]
        allowed_cookies = set(base_contract['auth']['cookieNames'])
        cookie_map = {
            item['name']: item['value']
            for item in context.cookies(SERVICE_ORIGIN)
            if item['name'] in allowed_cookies
        }
        if set(cookie_map) != allowed_cookies:
            raise SafeFailure('SESSION_INCOMPLETE', {
                'requiredCookieCount': len(allowed_cookies),
                'capturedCookieCount': len(cookie_map),
            })
        identity_allowed = {name.lower() for name in base_contract['operations']['identity']['request']['headerNames']}
        identity_headers = {
            name: value for name, value in capture['headers'].items()
            if name.lower() in identity_allowed
        }
        capture['sessionBundle'] = {
            'version': 1,
            'service': base_contract['service'],
            'origin': SERVICE_ORIGIN,
            'capturedAt': datetime.now(timezone.utc).isoformat(),
            'cookies': [{'name': name, 'value': value} for name, value in cookie_map.items()],
            'headers': {},
            'requestHeaders': {
                'identity': identity_headers,
                'history_list': state['history_context_headers'],
            },
            'batchContext': state['history_context_capture'],
        }
        if state['unexpected_posts']:
            raise SafeFailure('UNOBSERVED_POST_BLOCKED')
        capture_schema = {
            'capability': capability,
            'method': capture['method'],
            'origin': capture['origin'],
            'pathFamily': safe_path(capture['path']),
            'queryKeys': [name for name, _ in urllib.parse.parse_qsl(urllib.parse.urlsplit(capture['url']).query, keep_blank_values=True)],
            'headerNames': sorted(capture['headers'].keys()),
            'contentType': capture['contentType'].split(';', 1)[0].strip().lower(),
            'bodyFieldNames': capture['schema']['fieldNames'],
            'bodyBytes': capture['schema']['bodyBytes'],
            'outerFReqShape': capture['schema']['outerShape'],
            'innerFReqDecoded': capture['schema']['innerDecoded'],
            'innerFReqShape': capture['schema']['innerShape'],
            'promptPaths': capture['schema']['promptPaths'],
            'intentMatch': capture['schema']['intentMatch'],
            'browserAbortVerified': capture['browserAbortVerified'],
            'browserAbortFailureReason': capture['browserAbortFailureReason'],
            'businessServerSubmission': False,
            'directHttpSubmission': True,
            'measurementBeaconCountBlocked': capture.get('measurementBeaconCountBlocked', 0),
            'measurementPathFamiliesBlocked': capture.get('measurementPathFamiliesBlocked', []),
            'readOnlyRpcReceipts': capture.get('readOnlyRpcReceipts', []),
        }
        capture['body'] = bytearray(capture['body'])
        capture_body = capture['body']
        capture.pop('schema', None)
        capture.pop('requestGuid', None)
        session = capture.pop('sessionBundle')
        direct_result = None
        direct_summary = {}
        direct_error_code = None
        private_asset_url = None
        asset_verification = None
        asset_error_code = None
        reset_quiet_verified = False
        try:
            try:
                direct_result = direct_replay(capability, capture, session, expected_owner, intent)
                direct_summary = direct_result.get('summary') or {}
                private_asset_url = direct_result.get('privateAssetUrl')
            except SafeFailure as error:
                direct_error_code = error.code
            except Exception:
                direct_error_code = 'DIRECT_HTTP_FLOW_FAILED'
            if direct_summary.get('taskReadbackVerified') is True:
                if not isinstance(private_asset_url, str) or not private_asset_url:
                    asset_error_code = 'TASK_READBACK_ASSET_REFERENCE_MISSING'
                else:
                    try:
                        asset_verification = trigger_native_task_asset_get(
                            page, cdp, context, state, capability, private_asset_url,
                            base_contract.get('assetOrigins', []),
                        )
                    except SafeFailure as error:
                        asset_error_code = error.code
                    except Exception:
                        asset_error_code = 'MEDIA_NATIVE_GET_FAILED'
            try:
                page.keyboard.press('Escape')
                current_after = urllib.parse.urlsplit(page.url)
                if current_after.scheme != 'https' or current_after.hostname != 'gemini.google.com' or current_after.path != target_path:
                    page.goto(SERVICE_ORIGIN + target_path, wait_until='domcontentloaded', timeout=30000)
                    page.wait_for_timeout(4500)
                composer_after = page.locator('[aria-label="Gemini 프롬프트 입력"]')
                if composer_after.count() == 1 and composer_after.is_visible():
                    composer_after.fill('', timeout=10000)
                page.wait_for_timeout(1600)
                current_after = urllib.parse.urlsplit(page.url)
                marker_after = page.evaluate('() => window.name') == MEDIA_MARKER
                visible_purchase_after = page.evaluate("""() => {const re=/(payment|billing|subscribe|subscription|trial|upgrade|구독|결제|요금제|업그레이드)/i;const ds=Array.from(document.querySelectorAll('[role=dialog],[aria-modal=true]')).filter(e=>{const r=e.getBoundingClientRect();return r.width>0&&r.height>0});const main=document.querySelector('[role=main]')||document.querySelector('main');return ds.some(e=>re.test(e.innerText||''))||!!main&&re.test(main.innerText||'')}""")
                reset_quiet_verified = bool(
                    current_after.scheme == 'https' and current_after.hostname == 'gemini.google.com'
                    and current_after.path == target_path and marker_after and not visible_purchase_after
                    and state['guard_failure'] is None and state['unexpected_posts'] == 0
                    and state['preference_mutation_candidate_abort_command_failures'] == 0
                    and state['fail_ack'] is True and state['fail_count'] == 1 and state['response_count'] == 0
                )
            except Exception:
                reset_quiet_verified = False
            return {
                'captureSummary': capture_schema,
                'intentPreflight': intent_preflight,
                'directSummary': direct_summary,
                'directErrorCode': direct_error_code,
                'assetVerification': asset_verification,
                'assetErrorCode': asset_error_code,
                'resetQuietVerified': reset_quiet_verified,
                'guardFailure': state['guard_failure'],
                'unexpectedPostCount': state['unexpected_posts'],
                'blockedPostMetadata': state['unexpected_post_metadata'][:10],
                'measurementBeaconCountBlocked': state['measurement_beacons_blocked'],
                'measurementPathFamiliesBlocked': sorted(state['measurement_path_families']),
                'preferenceMutationCandidateAbortRequestedCount': state['preference_mutation_candidate_abort_requested_count'],
                'preferenceMutationCandidateAbortCommandFailures': state['preference_mutation_candidate_abort_command_failures'],
                'readOnlyRpcReceipts': state['read_rpc_summaries'][:40],
            }
        finally:
            expected_owner = ''
            intent = ''
            private_asset_url = ''
            capture_body[:] = b'\0' * len(capture_body)
            for name in list(capture.get('headers', {})):
                capture['headers'][name] = ''
            capture['url'] = ''
            capture['origin'] = ''
            capture['path'] = ''
            for item in session.get('cookies', []):
                item['value'] = ''
            for name in list(session.get('headers', {})):
                session['headers'][name] = ''
            session.clear()
            try:
                cdp.send('Fetch.disable')
                cdp.send('Network.disable')
            except Exception:
                pass


def rpc_ids_from_body(raw):
    try:
        form = dict(urllib.parse.parse_qsl(raw.decode('utf-8'), keep_blank_values=True))
        outer = json.loads(form.get('f.req', ''))
        found = []

        def walk(value):
            if isinstance(value, list):
                if len(value) >= 4 and isinstance(value[0], str) and value[3] == 'generic':
                    found.append(value[0])
                for item in value:
                    walk(item)
            elif isinstance(value, str) and value[:1] in ('[', '{'):
                try:
                    walk(json.loads(value))
                except Exception:
                    pass

        walk(outer)
        return found
    except Exception:
        return []


def direct_replay(capability, capture, session, expected_owner, intent):
    preferred_node = pathlib.Path.home() / '.npm/_npx/387698761821791d/node_modules/node/bin/node'
    node = os.environ.get('NODE24_BIN') or (str(preferred_node) if preferred_node.is_file() else shutil.which('node'))
    if not node:
        raise SafeFailure('NODE_RUNTIME_MISSING')
    body = capture.pop('body')
    payload = {
        'capability': capability,
        'expectedOwner': expected_owner,
        'expectedIntent': intent,
        'callerIntent': CALLER_INTENT,
        'session': session,
        'capture': {**capture, 'bodyBase64': base64.b64encode(body).decode('ascii')},
        'journalRoot': str(pathlib.Path.home() / '.nad-scratch/provider-runtime-20261005/media-dispatch-journal'),
    }
    env = {key: os.environ[key] for key in ('PATH', 'HOME', 'LANG', 'LC_ALL', 'TMPDIR', 'SSL_CERT_FILE', 'SSL_CERT_DIR') if key in os.environ}
    env['GEMINI_MEDIA_ORCHESTRATOR'] = '1'
    command = [node, str(REPO / 'scripts' / 'media-direct-one-shot.mjs')]
    try:
        result = subprocess.run(command, input=json.dumps(payload), text=True, capture_output=True, timeout=180, env=env, check=False)
    except subprocess.TimeoutExpired as exc:
        raise SafeFailure('DIRECT_HTTP_OUTCOME_UNKNOWN') from exc
    finally:
        if isinstance(body, bytearray):
            body[:] = b'\0' * len(body)
    try:
        reply = json.loads(result.stdout)
    except Exception as exc:
        raise SafeFailure('DIRECT_HTTP_RESULT_INVALID') from exc
    if result.returncode != 0 or not isinstance(reply, dict) or reply.get('ownerMatched') is not True:
        code = reply.get('error', 'DIRECT_HTTP_FAILED') if isinstance(reply, dict) else 'DIRECT_HTTP_FAILED'
        if not re.fullmatch(r'[A-Z][A-Z0-9_]{2,63}', str(code)):
            code = 'DIRECT_HTTP_FAILED'
        raise SafeFailure(code)
    summary = reply.get('summary')
    if not isinstance(summary, dict) or summary.get('operation') != capability:
        raise SafeFailure('DIRECT_HTTP_RESULT_INVALID')
    private_asset_url = reply.get('privateAssetUrl')
    if private_asset_url is not None and not isinstance(private_asset_url, str):
        raise SafeFailure('DIRECT_HTTP_RESULT_INVALID')
    return {'summary': summary, 'privateAssetUrl': private_asset_url}


def run_session_bootstrap_check(session, expected_owner):
    preferred_node = pathlib.Path.home() / '.npm/_npx/387698761821791d/node_modules/node/bin/node'
    node = os.environ.get('NODE24_BIN') or (str(preferred_node) if preferred_node.is_file() else shutil.which('node'))
    if not node:
        return {'status': 'failed', 'error': 'NODE_RUNTIME_MISSING'}
    payload = {'mode': 'session-bootstrap-check', 'expectedOwner': expected_owner, 'session': session}
    env = {key: os.environ[key] for key in ('PATH', 'HOME', 'LANG', 'LC_ALL', 'TMPDIR', 'SSL_CERT_FILE', 'SSL_CERT_DIR') if key in os.environ}
    env['GEMINI_MEDIA_ORCHESTRATOR'] = '1'
    command = [node, str(REPO / 'scripts' / 'media-direct-one-shot.mjs')]
    try:
        process = subprocess.run(command, input=json.dumps(payload), text=True, capture_output=True, timeout=120, env=env, check=False)
    except subprocess.TimeoutExpired:
        return {'status': 'failed', 'error': 'SESSION_BOOTSTRAP_TIMEOUT'}
    finally:
        payload['expectedOwner'] = ''
        payload.clear()
    try:
        reply = json.loads(process.stdout)
    except Exception:
        return {'status': 'failed', 'error': 'SESSION_BOOTSTRAP_RESULT_INVALID'}
    if not isinstance(reply, dict):
        return {'status': 'failed', 'error': 'SESSION_BOOTSTRAP_RESULT_INVALID'}
    if process.returncode != 0:
        return {'status': 'failed', **reply}
    return {'status': 'verified', **reply}


def run_task_asset_readback_check(session, expected_owner, download_asset=False):
    preferred_node = pathlib.Path.home() / '.npm/_npx/387698761821791d/node_modules/node/bin/node'
    node = os.environ.get('NODE24_BIN') or (str(preferred_node) if preferred_node.is_file() else shutil.which('node'))
    if not node:
        return {'status': 'failed', 'error': 'NODE_RUNTIME_MISSING'}
    scratch_root = pathlib.Path.home() / '.nad-scratch' / 'tmp'
    scratch_root.mkdir(parents=True, exist_ok=True, mode=0o700)
    scratch_dir = pathlib.Path(tempfile.mkdtemp(prefix='gemini-task-media-readback-', dir=str(scratch_root))) if download_asset else None
    original_artifact = MEDIA_ARTIFACT_ROOT / 'gemini-image-teal-sphere-white-cube-20261006.direct-http.png'
    payload = {
        'mode': 'task-asset-readback-check',
        'expectedOwner': expected_owner,
        'expectedIntent': IMAGE_INTENT,
        'callerIntent': CALLER_INTENT,
        'journalRoot': str(pathlib.Path.home() / '.nad-scratch/provider-runtime-20261005/media-dispatch-journal'),
        'session': session,
    }
    if download_asset:
        payload.update({
            'downloadTaskAssetOnce': True,
            'artifactRoot': str(scratch_dir),
            'artifactName': 'gemini-task-asset-browser-free-readback.png',
            'previousArtifactPath': str(original_artifact),
        })
    env = {key: os.environ[key] for key in ('PATH', 'HOME', 'LANG', 'LC_ALL', 'TMPDIR', 'SSL_CERT_FILE', 'SSL_CERT_DIR') if key in os.environ}
    env['GEMINI_MEDIA_ORCHESTRATOR'] = '1'
    command = [node, str(REPO / 'scripts' / 'media-direct-one-shot.mjs')]
    try:
        process = subprocess.run(command, input=json.dumps(payload), text=True, capture_output=True, timeout=180, env=env, check=False)
    except subprocess.TimeoutExpired:
        return {'status': 'failed', 'error': 'TASK_READBACK_TIMEOUT'}
    finally:
        payload['expectedOwner'] = ''
        payload['expectedIntent'] = ''
        payload.clear()
        if scratch_dir is not None:
            shutil.rmtree(scratch_dir, ignore_errors=True)
    try:
        reply = json.loads(process.stdout)
    except Exception:
        return {'status': 'failed', 'error': 'TASK_READBACK_RESULT_INVALID'}
    if not isinstance(reply, dict):
        return {'status': 'failed', 'error': 'TASK_READBACK_RESULT_INVALID'}
    if process.returncode != 0:
        return {'status': 'failed', **reply}
    if download_asset:
        direct = reply.get('assetDownload')
        if (not isinstance(direct, dict)
                or direct.get('downloadAuthorization') != 'hNv_task_contract_and_current_session'
                or direct.get('browserAssetGetPerformed') is not False
                or direct.get('mimeMagicMatched') is not True
                or direct.get('independentFileReadback') is not True
                or direct.get('taskPromptMatched') is not True
                or direct.get('apiConversationIdEchoed') is not True
                or direct.get('routeBound') is not True
                or direct.get('artifact', {}).get('previousArtifactHashMatched') is not True):
            return {'status': 'failed', 'error': 'TASK_ASSET_BROWSER_FREE_DOWNLOAD_UNVERIFIED'}
        direct.get('artifact', {}).pop('path', None)
        direct['artifact']['scratchFileRemovedAfterReadback'] = True
    return {'status': 'verified', **reply}


def trigger_native_task_asset_get(page, cdp, context, state, capability, task_url, allowed_origins):
    parsed = urllib.parse.urlsplit(task_url)
    origin = canonical_https_origin(parsed.scheme, parsed.netloc)
    if (parsed.scheme != 'https' or origin not in set(allowed_origins or [])
            or parsed.username or parsed.password or parsed.fragment):
        raise SafeFailure('TASK_ASSET_ORIGIN_UNOBSERVED')
    if capability != 'image':
        raise SafeFailure('MEDIA_CAPABILITY_UNSUPPORTED')
    state['expected_asset_url'] = task_url
    try:
        cdp.send('Network.setCacheDisabled', {'cacheDisabled': True})
    except Exception:
        pass
    page.set_default_timeout(90000)
    try:
        outcome = page.evaluate("""async (url) => {
          const image = document.createElement('img');
          image.dataset.codexGeminiMediaVerification = 'once';
          image.alt = '';
          const result = await new Promise(resolve => {
            const timer = setTimeout(() => resolve({loaded:false, timedOut:true}), 75000);
            image.onload = () => { clearTimeout(timer); resolve({loaded:true, width:image.naturalWidth, height:image.naturalHeight}); };
            image.onerror = () => { clearTimeout(timer); resolve({loaded:false, timedOut:false}); };
            image.src = url;
            document.body.appendChild(image);
          });
          image.remove();
          return result;
        }""", task_url)
        page.wait_for_timeout(350)
    finally:
        try:
            page.locator('img[data-codex-gemini-media-verification="once"]').evaluate_all('(items) => items.forEach(item => item.remove())')
        except Exception:
            pass
        try:
            cdp.send('Network.setCacheDisabled', {'cacheDisabled': False})
        except Exception:
            pass

    request_ids = state['native_asset_request_ids']
    if len(request_ids) != 1:
        raise SafeFailure('MEDIA_NATIVE_GET_AMBIGUOUS' if request_ids else 'MEDIA_NATIVE_GET_NOT_OBSERVED')
    observed = state['native_asset_requests'][request_ids[0]]
    if not observed.get('exactUrlMatched') or observed.get('method') != 'GET':
        raise SafeFailure('MEDIA_NATIVE_GET_MISMATCH')
    if observed.get('loadingFailed') or not observed.get('loadingFinished'):
        raise SafeFailure('MEDIA_NATIVE_GET_INCOMPLETE')
    mime = observed.get('mime')
    if mime not in ('image/png', 'image/jpeg'):
        raise SafeFailure('MEDIA_NATIVE_MIME_NOT_PNG_OR_JPEG', {'mime': mime})
    if observed.get('httpStatus') not in (200, 206):
        raise SafeFailure('MEDIA_NATIVE_GET_REJECTED', {'httpStatus': observed.get('httpStatus')})
    native_get = {
        'exactUrlMatched': True,
        'method': 'GET',
        'origin': origin,
        'pathFamily': media_path_family(parsed.path),
        'queryKeyNames': sorted(set(key for key, _ in urllib.parse.parse_qsl(parsed.query, keep_blank_values=True))),
        'httpStatus': observed['httpStatus'],
        'mime': mime,
        'capability': capability,
        'headerNames': observed.get('headerNames', []),
        'cookieHeaderPresent': observed.get('cookieHeaderPresent') is True,
        'cookieNames': observed.get('cookieNames', []),
    }
    cookie_cookies = []
    seen_cookie_scopes = set()
    native_hops = observed.get('hops', []) or [{'url': task_url, 'cookieNames': native_get['cookieNames']}]
    for hop in native_hops:
        hop_cookie_names = set(hop.get('cookieNames', []))
        if not hop_cookie_names or not isinstance(hop.get('url'), str):
            continue
        for item in context.cookies(hop['url']):
            if item.get('name') not in hop_cookie_names:
                continue
            scope = (item.get('name'), item.get('domain'), item.get('path'), item.get('value'))
            if scope in seen_cookie_scopes:
                continue
            seen_cookie_scopes.add(scope)
            cookie_cookies.append({
                key: item.get(key)
                for key in ('name', 'value', 'domain', 'path', 'secure', 'expires')
                if key in item
            })
    extension = 'png' if mime == 'image/png' else 'jpg'
    envelope = {
        'url': task_url,
        'capability': capability,
        'observedNativeRequest': native_get,
        'observedNativeHeaders': observed.get('observedHeaders', {}),
        'cookieCookies': cookie_cookies,
        'observedRedirectEdges': observed.get('redirectEdges', []),
        'artifactRoot': str(MEDIA_ARTIFACT_ROOT),
        'artifactName': f'gemini-image-teal-sphere-white-cube-20261006.direct-http.{extension}',
    }
    try:
        result = invoke_media_download_client(envelope)
        if result.get('status') != 'verified':
            details = {key: result[key] for key in ('httpStatus', 'sourceRef') if key in result and result[key] is not None}
            raise SafeFailure(result.get('errorCode', 'MEDIA_DIRECT_DOWNLOAD_FAILED'), details)
        return {
            'nativeGet': {
                key: native_get.get(key)
                for key in ('exactUrlMatched', 'method', 'origin', 'pathFamily', 'queryKeyNames', 'httpStatus', 'mime', 'headerNames', 'cookieHeaderPresent', 'cookieNames')
            },
            'directDownload': result,
            'nativeImageLoaded': outcome.get('loaded') is True if isinstance(outcome, dict) else False,
            'nativeImageWidth': outcome.get('width') if isinstance(outcome, dict) else None,
            'nativeImageHeight': outcome.get('height') if isinstance(outcome, dict) else None,
        }
    finally:
        task_url = ''
        for item in cookie_cookies:
            item['value'] = ''
        envelope.clear()


def summarize_native_asset_attempt(state, task_url):
    ids = state.get('native_asset_request_ids', [])
    if not ids:
        return None
    entry = state.get('native_asset_requests', {}).get(ids[0])
    if not isinstance(entry, dict):
        return None
    parsed = urllib.parse.urlsplit(task_url)
    return {
        'exactUrlMatched': entry.get('exactUrlMatched') is True,
        'method': entry.get('method'),
        'origin': canonical_https_origin(parsed.scheme, parsed.netloc),
        'pathFamily': media_path_family(parsed.path),
        'queryKeyNames': sorted(set(key for key, _ in urllib.parse.parse_qsl(parsed.query, keep_blank_values=True))),
        'httpStatus': entry.get('httpStatus'),
        'mime': entry.get('mime'),
        'headerNames': entry.get('headerNames', []),
        'cookieHeaderPresent': entry.get('cookieHeaderPresent') is True,
        'cookieNames': entry.get('cookieNames', []),
        'redirectEdges': [
            {
                'httpStatus': edge.get('httpStatus'),
                'from': edge.get('from'),
                'to': edge.get('to'),
                'headerNames': edge.get('headerNames', []),
                'cookieHeaderPresent': edge.get('cookieHeaderPresent') is True,
                'cookieNames': edge.get('cookieNames', []),
            }
            for edge in entry.get('redirectEdges', [])
        ],
        'loadingFailed': entry.get('loadingFailed') is True,
        'loadingFinished': entry.get('loadingFinished') is True,
    }


def invoke_media_download_client(envelope):
    preferred_node = pathlib.Path.home() / '.npm/_npx/387698761821791d/node_modules/node/bin/node'
    node = os.environ.get('NODE24_BIN') or (str(preferred_node) if preferred_node.is_file() else shutil.which('node'))
    if not node:
        raise SafeFailure('NODE_RUNTIME_MISSING')
    command = [node, str(REPO / 'scripts' / 'gemini-media-download-once.mjs')]
    env = {key: os.environ[key] for key in ('PATH', 'HOME', 'LANG', 'LC_ALL', 'TMPDIR', 'SSL_CERT_FILE', 'SSL_CERT_DIR') if key in os.environ}
    try:
        process = subprocess.run(command, input=json.dumps(envelope), text=True, capture_output=True, timeout=180, env=env, check=False)
    except subprocess.TimeoutExpired as exc:
        raise SafeFailure('MEDIA_DIRECT_DOWNLOAD_OUTCOME_UNKNOWN') from exc
    try:
        reply = json.loads(process.stdout)
    except Exception as exc:
        raise SafeFailure('MEDIA_DIRECT_DOWNLOAD_RESULT_INVALID') from exc
    if process.returncode != 0 or not isinstance(reply, dict):
        code = reply.get('errorCode', 'MEDIA_DIRECT_DOWNLOAD_FAILED') if isinstance(reply, dict) else 'MEDIA_DIRECT_DOWNLOAD_FAILED'
        if not re.fullmatch(r'[A-Z][A-Z0-9_]{2,63}', str(code)):
            code = 'MEDIA_DIRECT_DOWNLOAD_FAILED'
        details = {}
        if isinstance(reply, dict):
            if isinstance(reply.get('httpStatus'), int): details['httpStatus'] = reply['httpStatus']
            if isinstance(reply.get('sourceRef'), dict): details['sourceRef'] = reply['sourceRef']
            if isinstance(reply.get('redirectProof'), dict): details['redirectProof'] = reply['redirectProof']
        if not details: details = None
        raise SafeFailure(code, details)
    return reply


MEDIA_SIGNATURES = {
    'image/png': lambda body: len(body) >= 8 and body[:8] == bytes([137, 80, 78, 71, 13, 10, 26, 10]),
    'image/jpeg': lambda body: len(body) >= 3 and body[:3] == bytes([255, 216, 255]),
    'image/webp': lambda body: len(body) >= 12 and body[:4] == b'RIFF' and body[8:12] == b'WEBP',
    'image/gif': lambda body: len(body) >= 6 and body[:6] in (b'GIF87a', b'GIF89a'),
    'video/mp4': lambda body: len(body) >= 12 and body[4:8] == b'ftyp',
    'video/webm': lambda body: len(body) >= 4 and body[:4] == bytes([0x1A, 0x45, 0xDF, 0xA3]),
}
MEDIA_EXTENSIONS = {
    'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif',
    'video/mp4': 'mp4', 'video/webm': 'webm',
}


def media_kind(mime):
    return 'image' if mime.startswith('image/') else 'video' if mime.startswith('video/') else 'other'


def validate_media_bytes(data, mime, expected_kind):
    normalized = str(mime or '').split(';', 1)[0].strip().lower()
    signature = MEDIA_SIGNATURES.get(normalized)
    if not signature or not signature(data) or media_kind(normalized) != expected_kind:
        return None
    return normalized


def save_media_verified(data, mime, capability):
    normalized = validate_media_bytes(data, mime, capability)
    if not normalized:
        return None
    root = pathlib.Path.home() / 'artifacts' / 'gemini-media-20261006'
    root.mkdir(parents=True, exist_ok=True, mode=0o700)
    target = root / f'gemini-{capability}-neutral-geometry-20261006.{MEDIA_EXTENSIONS[normalized]}'
    try:
        descriptor = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    except FileExistsError:
        return {'saved': False, 'reason': 'artifact_path_exists', 'mime': normalized, 'bytes': len(data)}
    try:
        with os.fdopen(descriptor, 'wb') as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
    except Exception:
        try:
            target.unlink(missing_ok=True)
        except Exception:
            pass
        return {'saved': False, 'reason': 'artifact_write_failed', 'mime': normalized, 'bytes': len(data)}
    try:
        readback = target.read_bytes()
    except Exception:
        target.unlink(missing_ok=True)
        return {'saved': False, 'reason': 'artifact_readback_failed', 'mime': normalized, 'bytes': len(data)}
    if len(readback) != len(data) or validate_media_bytes(readback, normalized, capability) != normalized:
        target.unlink(missing_ok=True)
        return {'saved': False, 'reason': 'artifact_readback_mismatch', 'mime': normalized, 'bytes': len(data)}
    return {
        'saved': True,
        'path': str(target),
        'mime': normalized,
        'bytes': len(readback),
        'magicVerified': True,
        'independentFileReadback': True,
    }


def parse_response_frames(raw):
    try:
        text = bytes(raw).decode('utf-8')
    except Exception:
        return [], 'binary'
    if text.startswith(")]}'"):
        text = text[4:]
    text = text.lstrip('\r\n \t')
    decoder = json.JSONDecoder()
    frames = []
    cursor = 0
    framed = False
    while cursor < len(text):
        while cursor < len(text) and text[cursor] in '\r\n \t':
            cursor += 1
        if cursor >= len(text):
            break
        line_end = text.find('\n', cursor)
        if line_end < 0:
            break
        header = text[cursor:line_end].strip().rstrip('\r')
        if not header.isdigit():
            break
        framed = True
        try:
            value, end = decoder.raw_decode(text, line_end + 1)
        except Exception:
            return frames, 'utf16_length_frame_parse_failed'
        frames.append(value)
        cursor = end
    if frames:
        return frames, 'utf16_length_frames' if framed else 'json'
    stripped = text.strip()
    if stripped.startswith('data:') or '\nevent:' in stripped or '\ndata:' in stripped:
        events = []
        for line in text.splitlines():
            if line.startswith('data:'):
                data = line[5:].strip()
                if not data or data == '[DONE]':
                    continue
                try:
                    events.append(json.loads(data))
                except Exception:
                    nested, _ = parse_response_frames(data.encode('utf-8'))
                    events.extend(nested)
        return events, 'sse'
    try:
        return [json.loads(stripped)], 'json'
    except Exception:
        return [], 'unclassified'


def parse_nested_json(value, depth=0):
    if depth > 18:
        return value
    if isinstance(value, str) and value[:1] in ('[', '{') and len(value) <= 2_000_000:
        try:
            return parse_nested_json(json.loads(value), depth + 1)
        except Exception:
            return value
    if isinstance(value, list):
        return [parse_nested_json(item, depth + 1) for item in value[:2000]]
    if isinstance(value, dict):
        return {key: parse_nested_json(item, depth + 1) for key, item in list(value.items())[:2000]}
    return value


def response_schema(value, depth=0):
    if depth > 12:
        return 'depth_limit'
    if value is None:
        return 'null'
    if isinstance(value, bool):
        return 'boolean'
    if isinstance(value, (int, float)):
        return 'number'
    if isinstance(value, str):
        return 'string'
    if isinstance(value, list):
        return {'type': 'array', 'length': len(value), 'items': [response_schema(item, depth + 1) for item in value[:32]]}
    if isinstance(value, dict):
        fields = {}
        for key, item in sorted(value.items())[:100]:
            safe_key = key if re.fullmatch(r'[A-Za-z_][A-Za-z0-9_.-]{0,80}', str(key)) else '{dynamic_key}'
            if re.fullmatch(r'[0-9a-fA-F-]{24,}', safe_key) or re.fullmatch(r'\d{5,}', safe_key):
                safe_key = '{dynamic_key}'
            fields[safe_key] = response_schema(item, depth + 1)
        return {'type': 'object', 'fields': fields}
    return 'unsupported'


def receipt_shape(value, depth=0):
    if depth > 4:
        return 'depth_limit'
    if value is None:
        return 'null'
    if isinstance(value, bool):
        return 'boolean'
    if isinstance(value, (int, float)):
        return 'number'
    if isinstance(value, str):
        return 'string'
    if isinstance(value, list):
        return {
            'type': 'array',
            'length': len(value),
            'items': [receipt_shape(item, depth + 1) for item in value[:4]],
        }
    if isinstance(value, dict):
        fields = {}
        for key, item in list(value.items())[:40]:
            key_text = str(key)
            if (len(key_text) > 64 or '@' in key_text
                    or re.fullmatch(r'[0-9a-fA-F-]{24,}|\d{5,}', key_text)
                    or re.search(r'(cookie|token|secret|csrf|authorization|session|signed|nonce|prompt|email|account)', key_text, re.I)):
                key_text = '{redacted_field}'
            fields[key_text] = receipt_shape(item, depth + 1)
        return {'type': 'object', 'fieldCount': len(value), 'fields': fields}
    return 'unsupported'


def collect_status_enum_fields(value, path=(), found=None, depth=0):
    if found is None:
        found = []
    if depth > 16 or len(found) >= 50:
        return found
    if isinstance(value, dict):
        for key, item in list(value.items())[:100]:
            key_text = str(key)
            child_path = (*path, key_text)
            if re.fullmatch(r'(status|status_enum|status_code|error|error_code|error_enum|reason_code|operation_status)', key_text, re.I):
                safe_path = []
                for segment in child_path:
                    if isinstance(segment, int):
                        safe_path.append(segment)
                    else:
                        text = str(segment)
                        if (len(text) > 64 or '@' in text
                                or re.fullmatch(r'[0-9a-fA-F-]{24,}|\d{5,}', text)
                                or re.search(r'(cookie|token|secret|csrf|authorization|session|signed|nonce|prompt|email|account)', text, re.I)):
                            safe_path.append('{redacted_field}')
                        else:
                            safe_path.append(re.sub(r'[^A-Za-z0-9_.-]', '_', text))
                entry = {'path': safe_path, 'valueType': receipt_shape(item)}
                if isinstance(item, str) and re.fullmatch(r'[A-Za-z][A-Za-z0-9_-]{0,47}', item):
                    entry['enumValue'] = item
                found.append(entry)
            collect_status_enum_fields(item, child_path, found, depth + 1)
    elif isinstance(value, list):
        for index, item in enumerate(value[:2000]):
            collect_status_enum_fields(item, (*path, index), found, depth + 1)
    return found


def task_job_id_field_present(value, depth=0):
    if depth > 16:
        return False
    if isinstance(value, dict):
        for key, item in list(value.items())[:100]:
            if re.search(r'(task|job|operation).*(id|key)|\b(id|job)\b', str(key), re.I):
                if item not in (None, '', [], {}):
                    return True
            if task_job_id_field_present(item, depth + 1):
                return True
    elif isinstance(value, list):
        return any(task_job_id_field_present(item, depth + 1) for item in value[:2000])
    return False


def compact_read_rpc_receipts(receipts):
    return [{
        key: entry.get(key)
        for key in ('rpcIds', 'method', 'host', 'pathFamily', 'queryKeyNames', 'headerNames',
                    'formFieldNames', 'bodyBytes', 'status', 'mime', 'responseBytes',
                    'responseFraming', 'responseRpcIds')
        if key in entry
    } for entry in receipts[:40]]


def persist_direct_media_receipt(capability, caller_intent, attempt_key, media_run):
    path = REPO / 'discovery' / 'media-browser-capture-2026-10-06.json'
    try:
        document = read_json(path)
    except Exception:
        document = {'schema': 1, 'service': 'gemini-web'}
    if (caller_intent != CALLER_INTENT or capability != 'image'
            or attempt_key != (media_run.get('intentPreflight') or {}).get('auditAttemptKey')):
        raise SafeFailure('MEDIA_RECEIPT_SCOPE_INVALID')
    runs_by_intent = document.setdefault('directMediaRunsByIntent', {})
    if not isinstance(runs_by_intent, dict) or attempt_key in runs_by_intent:
        raise SafeFailure('MEDIA_RECEIPT_INTENT_ALREADY_RECORDED')
    safe = {
        'capability': capability,
        'callerIntentId': caller_intent,
        'auditAttemptKey': attempt_key,
        'capture': media_run.get('captureSummary'),
        'ownerMatched': (media_run.get('directSummary') or {}).get('ownerMatched'),
        'directHttp': media_run.get('directSummary'),
        'directErrorCode': media_run.get('directErrorCode'),
        'historyReadbackVerified': (media_run.get('directSummary') or {}).get('taskReadbackVerified') is True,
        'nativeGet': (media_run.get('assetVerification') or {}).get('nativeGet'),
        'directDownload': (media_run.get('assetVerification') or {}).get('directDownload'),
        'assetErrorCode': media_run.get('assetErrorCode'),
        'resetQuietVerified': media_run.get('resetQuietVerified') is True,
        'guardFailure': media_run.get('guardFailure'),
        'unexpectedPostCount': media_run.get('unexpectedPostCount', 0),
        'measurementBeaconCountBlocked': media_run.get('measurementBeaconCountBlocked', 0),
        'measurementPathFamiliesBlocked': media_run.get('measurementPathFamiliesBlocked', []),
        'preferenceMutationCandidateAbortRequestedCount': media_run.get('preferenceMutationCandidateAbortRequestedCount', 0),
        'preferenceMutationCandidateAbortCommandFailures': media_run.get('preferenceMutationCandidateAbortCommandFailures', 0),
        'readOnlyRpcReceipts': compact_read_rpc_receipts(media_run.get('readOnlyRpcReceipts', [])),
        'secretsPersisted': False,
        'rawApiIdsPersisted': False,
        'taskUrlPersisted': False,
        'cookieValuesPersisted': False,
        'expectedIntentPersisted': False,
        'recordedAt': datetime.now(timezone.utc).isoformat(),
    }
    runs_by_intent[attempt_key] = safe
    write_capture = document.setdefault('writeCapture', {})
    direct_runs = []
    prior_runs = document.get('directMediaRuns', {})
    if isinstance(prior_runs, dict):
        direct_runs.extend(entry for entry in prior_runs.values() if isinstance(entry, dict))
    direct_runs.extend(entry for entry in runs_by_intent.values() if isinstance(entry, dict))
    write_capture['browserSubmissionsAbortedBeforeNetwork'] = sum(
        1 for entry in direct_runs if (entry.get('capture') or {}).get('browserAbortVerified') is True
    )
    write_capture['directHttpMutationDispatches'] = sum(
        int((entry.get('directHttp') or {}).get('directDispatchCount') or entry.get('dispatchCount') or 0)
        for entry in direct_runs
    )
    write_capture['directHttpResponsesReceived'] = sum(
        1 for entry in direct_runs
        if isinstance((entry.get('directHttp') or {}).get('httpStatus', entry.get('httpStatus')), int)
    )
    write_capture['verifiedMediaArtifactReadbacks'] = sum(
        1 for entry in direct_runs
        if ((entry.get('directDownload') or {}).get('mimeMagicMatched') is True
            and (entry.get('directDownload') or {}).get('independentFileReadback') is True)
        or ((entry.get('responseInspection') or {}).get('mediaMagicMatched') is True
            and (entry.get('responseInspection') or {}).get('artifact'))
    )
    write_capture['directMediaRunReceiptKey'] = 'directMediaRunsByIntent'
    temp = path.with_name(path.name + f'.{os.getpid()}.tmp')
    fd = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        with os.fdopen(fd, 'w', encoding='utf-8') as stream:
            json.dump(document, stream, ensure_ascii=False, indent=2)
            stream.write('\n')
        os.replace(temp, path)
    except Exception:
        try:
            temp.unlink(missing_ok=True)
        except Exception:
            pass
        raise


def persist_task_asset_readback(attempt_key, readback, asset_verification, native_attempt_summary, asset_error_code, asset_error_details, reset_quiet_verified):
    path = REPO / 'discovery' / 'media-browser-capture-2026-10-06.json'
    try:
        document = read_json(path)
    except Exception as error:
        raise SafeFailure('MEDIA_RECEIPT_UNREADABLE') from error
    runs = document.get('directMediaRunsByIntent', {})
    entry = runs.get(attempt_key) if isinstance(runs, dict) else None
    if not isinstance(entry, dict) or entry.get('callerIntentId') != CALLER_INTENT:
        raise SafeFailure('MEDIA_RECEIPT_ATTEMPT_NOT_FOUND')
    if readback.get('exactTaskMatchCount') != 1 or readback.get('exactPromptMatched') is not True:
        raise SafeFailure('MEDIA_TASK_READBACK_UNVERIFIED')
    post = entry.get('postDispatchReadback')
    if not isinstance(post, dict):
        post = {}
    post.update({
        'historyHttpStatus': readback.get('historyHttpStatus'),
        'historyRpcId': readback.get('historyRpcId'),
        'historySummaryCount': readback.get('historySummaryCount'),
        'detailReadLimit': readback.get('detailReadLimit'),
        'detailReadCount': readback.get('detailReadCount'),
        'exactTaskMatchCount': readback.get('exactTaskMatchCount'),
        'detailHttpStatus': readback.get('detailHttpStatus'),
        'detailResponseSha256': readback.get('detailResponseSha256'),
        'detailResponseCount': readback.get('detailResponseCount'),
        'exactPromptMatched': readback.get('exactPromptMatched'),
        'apiConversationIdEchoed': readback.get('apiConversationIdEchoed'),
        'routeBound': readback.get('routeBound'),
        'assetCandidateCount': readback.get('assetCandidateCount'),
        'assetCandidates': readback.get('assetCandidates', []),
        'journalReconciled': readback.get('journalReconciled') is True,
        'resetQuietVerified': reset_quiet_verified is True,
        'rawConversationIdsPersisted': False,
        'taskUrlsPersisted': False,
        'cookieValuesPersisted': False,
        'responseBodiesPersisted': False,
        'recordedAt': datetime.now(timezone.utc).isoformat(),
    })
    if native_attempt_summary is not None:
        post['nativeAttemptSummary'] = native_attempt_summary
    if asset_error_code is not None:
        post['assetErrorCode'] = asset_error_code
    if asset_error_details is not None:
        post['assetErrorDetails'] = asset_error_details
    if isinstance(asset_verification, dict):
        artifact = asset_verification.get('artifact') or {}
        post['browserFreeDownload'] = {
            'status': 'verified' if (
                asset_verification.get('downloadAuthorization') == 'hNv_task_contract_and_current_session'
                and asset_verification.get('browserAssetGetPerformed') is False
                and asset_verification.get('mimeMagicMatched') is True
                and asset_verification.get('independentFileReadback') is True
                and artifact.get('previousArtifactHashMatched') is True
            ) else 'unverified',
            'authorization': asset_verification.get('downloadAuthorization'),
            'browserAssetGetPerformed': asset_verification.get('browserAssetGetPerformed'),
            'taskBinding': asset_verification.get('taskBinding'),
            'taskPromptMatched': asset_verification.get('taskPromptMatched'),
            'apiConversationIdEchoed': asset_verification.get('apiConversationIdEchoed'),
            'routeBound': asset_verification.get('routeBound'),
            'taskAssetCandidateCount': asset_verification.get('taskAssetCandidateCount'),
            'excludedTaskCandidateCount': asset_verification.get('excludedTaskCandidateCount'),
            'httpStatus': asset_verification.get('httpStatus'),
            'contentType': asset_verification.get('contentType'),
            'mime': asset_verification.get('mime'),
            'bytes': asset_verification.get('bytes'),
            'sha256': asset_verification.get('sha256'),
            'mimeMagicMatched': asset_verification.get('mimeMagicMatched'),
            'independentFileReadback': asset_verification.get('independentFileReadback'),
            'dimensions': asset_verification.get('dimensions'),
            'independentDimensionReadback': asset_verification.get('independentDimensionReadback'),
            'credentialForwarding': asset_verification.get('credentialForwarding'),
            'redirects': asset_verification.get('redirects'),
            'artifact': {
                'filename': artifact.get('filename'),
                'mime': artifact.get('mime'),
                'bytes': artifact.get('bytes'),
                'sha256': artifact.get('sha256'),
                'magicVerified': artifact.get('magicVerified'),
                'independentFileReadback': artifact.get('independentFileReadback'),
                'previousArtifactHashMatched': artifact.get('previousArtifactHashMatched'),
                'scratchFileRemovedAfterReadback': artifact.get('scratchFileRemovedAfterReadback'),
                'dimensions': artifact.get('dimensions'),
                'independentDimensionReadback': artifact.get('independentDimensionReadback'),
            },
            'sourceUrlPersisted': False,
            'cookieValuesPersisted': False,
        }
    entry['postDispatchReadback'] = post
    write_capture = document.setdefault('writeCapture', {})
    direct_runs = []
    old_runs = document.get('directMediaRuns', {})
    if isinstance(old_runs, dict):
        direct_runs.extend(item for item in old_runs.values() if isinstance(item, dict))
    direct_runs.extend(item for item in runs.values() if isinstance(item, dict))
    write_capture['verifiedMediaArtifactReadbacks'] = sum(
        1 for item in direct_runs
        if ((item.get('directDownload') or {}).get('mimeMagicMatched') is True
            and (item.get('directDownload') or {}).get('independentFileReadback') is True)
        or ((item.get('responseInspection') or {}).get('mediaMagicMatched') is True
            and (item.get('responseInspection') or {}).get('artifact'))
        or (((item.get('postDispatchReadback') or {}).get('directDownload') or {}).get('mimeMagicMatched') is True
            and ((item.get('postDispatchReadback') or {}).get('directDownload') or {}).get('independentFileReadback') is True)
        or (((item.get('postDispatchReadback') or {}).get('browserFreeDownload') or {}).get('mimeMagicMatched') is True
            and ((item.get('postDispatchReadback') or {}).get('browserFreeDownload') or {}).get('independentFileReadback') is True)
    )
    temp = path.with_name(path.name + f'.{os.getpid()}.tmp')
    fd = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        with os.fdopen(fd, 'w', encoding='utf-8') as stream:
            json.dump(document, stream, ensure_ascii=False, indent=2)
            stream.write('\n')
        os.replace(temp, path)
    except Exception:
        try:
            temp.unlink(missing_ok=True)
        except Exception:
            pass
        raise


def safe_response_shape(value, depth=0):
    if depth > 12:
        return 'depth_limit'
    if value is None:
        return 'null'
    if isinstance(value, bool):
        return 'boolean'
    if isinstance(value, (int, float)):
        return 'number'
    if isinstance(value, str):
        return 'string'
    if isinstance(value, list):
        return {'type': 'array', 'length': len(value), 'itemTypes': [safe_response_shape(item, depth + 1) for item in value[:8]]}
    if isinstance(value, dict):
        relevant = {}
        for key, item in value.items():
            if re.search(r'(quota|plan|tier|entitle|image|video|veo|media|artifact|model|available|usage|limit|credit)', str(key), re.I):
                relevant[str(key)] = safe_response_shape(item, depth + 1)
        return {'type': 'object', 'fieldCount': len(value), 'relevantFieldTypes': relevant}
    return 'unsupported'


def capture_readonly_media_rpc_metadata():
    state = {
        'rpc_by_network': {}, 'receipts': [], 'blocked_post_families': [],
        'preference_mutation_candidate_abort_requested_count': 0,
        'preference_mutation_candidate_abort_command_failures': 0,
    }
    with sync_playwright() as playwright:
        owner = read_json(RUNTIME_OWNER)
        pid = owner.get('chromePid')
        if not isinstance(pid, int):
            raise SafeFailure('OWNED_RUNTIME_INVALID')
        args = pathlib.Path(f'/proc/{pid}/cmdline').read_bytes().split(b'\0')
        port = next((int(arg.split(b'=', 1)[1]) for arg in args if arg.startswith(b'--remote-debugging-port=')), None)
        if not isinstance(port, int) or not 1 <= port <= 65535:
            raise SafeFailure('OWNED_RUNTIME_PORT_MISSING')
        browser = playwright.chromium.connect_over_cdp(f'http://127.0.0.1:{port}')
        if len(browser.contexts) != 1:
            raise SafeFailure('OWNED_CONTEXT_COUNT_INVALID')
        context = browser.contexts[0]
        pages = []
        for page in context.pages:
            parsed = urllib.parse.urlsplit(page.url)
            if parsed.scheme == 'https' and parsed.hostname == 'gemini.google.com':
                try:
                    if page.evaluate('() => window.name') == MEDIA_MARKER:
                        pages.append(page)
                except Exception:
                    pass
        if len(pages) != 1:
            raise SafeFailure('MEDIA_PAGE_ROLE_AMBIGUOUS')
        page = pages[0]
        cdp = context.new_cdp_session(page)
        cdp.send('Network.enable')
        cdp.send('Fetch.enable', {'patterns': [{'urlPattern': '*', 'requestStage': 'Request'}]})

        def continue_request(request_id):
            try:
                cdp.send('Fetch.continueRequest', {'requestId': request_id})
            except Exception:
                pass

        def fail_request(request_id):
            try:
                cdp.send('Fetch.failRequest', {'requestId': request_id, 'errorReason': 'BlockedByClient'})
            except Exception:
                pass

        def paused(event):
            req = event.get('request') or {}
            url = req.get('url', '')
            parsed = urllib.parse.urlsplit(url)
            method = str(req.get('method', 'GET')).upper()
            request_id = event.get('requestId')
            if not request_id:
                return
            if method in ('GET', 'HEAD', 'OPTIONS'):
                continue_request(request_id)
                return
            if parsed.scheme == 'https' and parsed.hostname == 'gemini.google.com' and method == 'POST' and parsed.path == '/_/BardChatUi/data/batchexecute':
                raw = str(req.get('postData') or '').encode('utf-8')
                body_ids = rpc_ids_from_body(raw)
                query_ids = urllib.parse.parse_qs(parsed.query, keep_blank_values=True).get('rpcids', [])
                ids = body_ids + query_ids
                if 'L5adhe' in ids:
                    state['preference_mutation_candidate_abort_requested_count'] += 1
                    if not fail_request(request_id):
                        state['preference_mutation_candidate_abort_command_failures'] += 1
                    return
                if ids and all(rpc_id in READ_RPC_IDS for rpc_id in ids):
                    if 'otAQ7b' in ids:
                        pairs = urllib.parse.parse_qsl(raw.decode('utf-8', 'replace'), keep_blank_values=True)
                        headers = req.get('headers') or {}
                        entry = {
                            'rpcIds': sorted(set(rpc_id for rpc_id in ids if rpc_id == 'otAQ7b')),
                            'method': method,
                            'host': parsed.hostname,
                            'pathFamily': safe_path(parsed.path),
                            'queryKeyNames': [key for key, _ in urllib.parse.parse_qsl(parsed.query, keep_blank_values=True)],
                            'headerNames': sorted(str(key).lower() for key in headers.keys()),
                            'formFieldNames': [key for key, _ in pairs],
                            'bodyBytes': len(raw),
                            'status': None,
                            'mime': None,
                            'responseBytes': None,
                            'responseFraming': None,
                            'responseRpcIds': [],
                            'responseShapes': [],
                        }
                        state['receipts'].append(entry)
                        network_id = event.get('networkId')
                        if network_id:
                            state['rpc_by_network'][network_id] = entry
                    continue_request(request_id)
                    return
            if is_allowed_telemetry(parsed.hostname or '', safe_path(parsed.path)):
                continue_request(request_id)
                return
            if is_measurement_beacon(parsed.hostname or '', parsed.path):
                state['blocked_post_families'].append({'host': parsed.hostname, 'pathFamily': safe_path(parsed.path)})
                fail_request(request_id)
                return
            state['blocked_post_families'].append({'host': parsed.hostname, 'pathFamily': safe_path(parsed.path)})
            fail_request(request_id)

        def response_received(event):
            entry = state['rpc_by_network'].get(event.get('requestId'))
            if entry:
                response = event.get('response') or {}
                entry['status'] = response.get('status')
                entry['mime'] = str(response.get('mimeType', '')).split(';', 1)[0].lower()
                entry['responseBytes'] = response.get('encodedDataLength')

        def loading_finished(event):
            network_id = event.get('requestId')
            entry = state['rpc_by_network'].get(network_id)
            if not entry:
                return
            try:
                result = cdp.send('Network.getResponseBody', {'requestId': network_id})
                body = base64.b64decode(result.get('body', '')) if result.get('base64Encoded') else result.get('body', '').encode('utf-8')
                frames, framing = parse_response_frames(body)
                response_ids = []
                response_shapes = []

                def walk(value):
                    if isinstance(value, list):
                        if len(value) >= 3 and value[0] == 'wrb.fr' and isinstance(value[1], str):
                            response_ids.append(value[1])
                            payload = value[2]
                            if isinstance(payload, str):
                                try:
                                    payload = json.loads(payload)
                                except Exception:
                                    pass
                            response_shapes.append(safe_response_shape(parse_nested_json(payload)))
                        else:
                            for item in value:
                                walk(item)
                    elif isinstance(value, dict):
                        for item in value.values():
                            walk(item)

                for frame in frames:
                    walk(frame)
                entry['responseBytes'] = len(body)
                entry['responseFraming'] = framing
                entry['responseRpcIds'] = sorted(set(response_ids))
                entry['responseShapes'] = response_shapes[:10]
            except Exception:
                entry['responseFraming'] = 'body_unavailable'

        cdp.on('Fetch.requestPaused', paused)
        cdp.on('Network.responseReceived', response_received)
        cdp.on('Network.loadingFinished', loading_finished)
        page.keyboard.press('Escape')
        target = '/images' if urllib.parse.urlsplit(page.url).path not in ('/images', '/videos') else urllib.parse.urlsplit(page.url).path
        page.goto(SERVICE_ORIGIN + target, wait_until='domcontentloaded', timeout=30000)
        page.wait_for_timeout(10000)
        try:
            cdp.send('Fetch.disable')
            cdp.send('Network.disable')
        except Exception:
            pass
        return {
            'rpcReceipts': state['receipts'][:40],
            'blockedPostFamilies': state['blocked_post_families'][:20],
            'preferenceMutationCandidateAbortRequestedCount': state['preference_mutation_candidate_abort_requested_count'],
            'preferenceMutationCandidateAbortCommandFailures': state['preference_mutation_candidate_abort_command_failures'],
        }


def collect_media_candidates(value, capability, key_path=(), found=None, depth=0):
    if found is None:
        found = {'inline': [], 'urls': []}
    if depth > 18 or len(found['inline']) + len(found['urls']) >= 50:
        return found
    if isinstance(value, dict):
        for key, item in value.items():
            lower = str(key).lower()
            child_path = (*key_path, str(key))
            if isinstance(item, str) and re.search(r'(url|uri|download|artifact|media|image|video|source|src)', lower):
                if item.startswith('data:'):
                    match = re.match(r'^data:(image/[A-Za-z0-9.+-]+|video/[A-Za-z0-9.+-]+);base64,(.*)$', item, re.S)
                    if match:
                        try:
                            decoded = base64.b64decode(match.group(2), validate=True)
                            verified = validate_media_bytes(decoded, match.group(1), capability)
                            if verified:
                                found['inline'].append((verified, decoded, child_path))
                        except Exception:
                            pass
                elif item.startswith('https://'):
                    parsed = urllib.parse.urlsplit(item)
                    if parsed.hostname:
                        found['urls'].append((item, child_path))
            elif isinstance(item, str) and re.search(r'(data|base64|content|bytes|image|video|artifact|media)', lower) and len(item) > 512:
                try:
                    decoded = base64.b64decode(item, validate=True)
                    for mime, check in MEDIA_SIGNATURES.items():
                        if media_kind(mime) == capability and check(decoded):
                            found['inline'].append((mime, decoded, child_path))
                            break
                except Exception:
                    pass
            collect_media_candidates(item, capability, child_path, found, depth + 1)
    elif isinstance(value, list):
        for index, item in enumerate(value[:2000]):
            collect_media_candidates(item, capability, (*key_path, index), found, depth + 1)
    return found


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, response, code, message, headers, new_url):
        return None


def canonical_https_origin(scheme, netloc):
    try:
        parsed = urllib.parse.urlsplit(f'{scheme}://{netloc}')
        host = parsed.hostname
        port = parsed.port
    except Exception:
        return None
    if parsed.scheme != 'https' or not host or parsed.username or parsed.password or parsed.path or parsed.query or parsed.fragment:
        return None
    host = host.lower()
    if host.endswith('.') or ':' in host:
        return None
    if port not in (None, 443):
        return None
    return 'https://' + host


def media_path_family(path):
    return '/'.join(
        '{id}' if len(segment) > 40 or re.fullmatch(r'[0-9a-f-]{16,}', segment, re.I) else segment
        for segment in path.split('/')
    )


def download_server_asset_once(url, capability, session, allowed_asset_origins):
    parsed = urllib.parse.urlsplit(url)
    if parsed.scheme != 'https' or not parsed.hostname or parsed.username or parsed.password or parsed.fragment:
        return {'status': 'asset_url_rejected', 'reason': 'scheme_or_authority'}
    origin = canonical_https_origin(parsed.scheme, parsed.netloc)
    allowed_origins = {
        canonical_https_origin(urllib.parse.urlsplit(str(value)).scheme, urllib.parse.urlsplit(str(value)).netloc)
        for value in (allowed_asset_origins or [])
    }
    if origin is None or origin not in allowed_origins:
        return {'status': 'asset_origin_blocked', 'host': parsed.hostname}
    request = urllib.request.Request(url, method='GET')
    if origin == SERVICE_ORIGIN and origin in allowed_origins:
        try:
            cookie = '; '.join(item['name'] + '=' + item['value'] for item in session['cookies'])
            request.add_header('Cookie', cookie)
        except Exception:
            return {'status': 'asset_url_rejected', 'reason': 'same_origin_session_missing'}
    opener = urllib.request.build_opener(NoRedirect())
    try:
        with opener.open(request, timeout=60) as response:
            status = response.status
            mime = response.headers.get('content-type', '').split(';', 1)[0].strip().lower()
            if status != 200:
                return {'status': 'asset_http_rejected', 'httpStatus': status, 'mime': mime}
            limit = 256 * 1024 * 1024
            declared = response.headers.get('content-length')
            if declared and declared.isdigit() and int(declared) > limit:
                return {'status': 'asset_too_large', 'httpStatus': status, 'mime': mime}
            chunks = []
            size = 0
            while True:
                chunk = response.read(1024 * 1024)
                if not chunk:
                    break
                size += len(chunk)
                if size > limit:
                    return {'status': 'asset_too_large', 'httpStatus': status, 'mime': mime}
                chunks.append(chunk)
            data = b''.join(chunks)
    except urllib.error.HTTPError as error:
        return {'status': 'asset_http_rejected', 'httpStatus': error.code}
    except Exception as error:
        return {'status': 'asset_transport_failed', 'errorClass': type(error).__name__}
    saved = save_media_verified(data, mime, capability)
    if not saved or not saved.get('saved'):
        return {'status': 'asset_format_rejected', 'httpStatus': 200, 'mime': mime, 'bytes': len(data)}
    return {'status': 'asset_verified', 'httpStatus': 200, **saved}


def inspect_response_in_memory(raw, content_type, capability, session, allowed_asset_origins):
    normalized_mime = str(content_type or '').split(';', 1)[0].strip().lower()
    if validate_media_bytes(raw, normalized_mime, capability):
        asset = save_media_verified(raw, normalized_mime, capability)
        return {
            'bodyBytes': len(raw),
            'mime': normalized_mime,
            'framing': 'direct_media',
            'responseShape': 'binary',
            'mediaMagicMatched': bool(asset and asset.get('magicVerified')),
            'artifact': asset,
            'assetUrlCandidateCount': 0,
            'statusErrorEnums': [],
            'taskJobIdFieldPresent': False,
        }
    frames, framing = parse_response_frames(raw)
    decoded = [parse_nested_json(frame) for frame in frames]
    schema = [receipt_shape(frame) for frame in decoded[:20]]
    status_error_enums = []
    for frame in decoded:
        collect_status_enum_fields(frame, found=status_error_enums)
    task_id_field_present = any(task_job_id_field_present(frame) for frame in decoded)
    candidates = {'inline': [], 'urls': []}
    for frame in decoded:
        collect_media_candidates(frame, capability, found=candidates)
    if candidates['inline']:
        mime, data, _path = candidates['inline'][0]
        artifact = save_media_verified(data, mime, capability)
        return {
            'bodyBytes': len(raw),
            'mime': normalized_mime,
            'framing': framing,
            'responseShape': schema[:10],
            'statusErrorEnums': status_error_enums[:50],
            'taskJobIdFieldPresent': task_id_field_present,
            'mediaMagicMatched': True,
            'artifact': artifact,
            'assetUrlCandidateCount': len(candidates['urls']),
        }
    if candidates['urls']:
        url, _path = candidates['urls'][0]
        parsed = urllib.parse.urlsplit(url)
        query_names = [key for key, _ in urllib.parse.parse_qsl(parsed.query, keep_blank_values=True)]
        path = safe_path(parsed.path)
        asset = download_server_asset_once(url, capability, session, allowed_asset_origins)
        return {
            'bodyBytes': len(raw),
            'mime': normalized_mime,
            'framing': framing,
            'responseShape': schema[:10],
            'statusErrorEnums': status_error_enums[:50],
            'taskJobIdFieldPresent': task_id_field_present,
            'mediaMagicMatched': asset.get('status') == 'asset_verified',
            'assetUrlCandidateCount': len(candidates['urls']),
            'assetHost': parsed.hostname,
            'assetPathFamily': path,
            'assetQueryKeyNames': query_names,
            'assetDownload': asset,
            'taskJobIdFieldPresent': task_id_field_present,
        }
    return {
        'bodyBytes': len(raw),
        'mime': normalized_mime,
        'framing': framing,
        'responseShape': schema[:10],
        'statusErrorEnums': status_error_enums[:50],
        'taskJobIdFieldPresent': task_id_field_present,
        'mediaMagicMatched': False,
        'artifact': None,
        'assetUrlCandidateCount': 0,
    }


def scrub_json_strings(value):
    if isinstance(value, dict):
        for key, item in list(value.items()):
            if isinstance(item, str):
                value[key] = ''
            else:
                scrub_json_strings(item)
    elif isinstance(value, list):
        for index, item in enumerate(value):
            if isinstance(item, str):
                value[index] = ''
            else:
                scrub_json_strings(item)


def main():
    stage = 'input'
    incoming = {}
    raw = bytearray()
    try:
        raw.extend(sys.stdin.buffer.read(65537))
        if len(raw) > 65536:
            raise SafeFailure('INPUT_TOO_LARGE')
        try:
            incoming = json.loads(raw.decode('utf-8'))
        except Exception as error:
            raise SafeFailure('INPUT_INVALID') from error
        finally:
            raw[:] = b'\0' * len(raw)
        if isinstance(incoming, dict) and incoming.get('mode') in {
            'bootstrap-only', 'task-readback-metadata-only', 'task-asset-readback-only',
        } and set(incoming) == {'mode'}:
            runtime_owner = read_json(RUNTIME_OWNER)
            if runtime_owner.get('taskOwned') is not True or not isinstance(runtime_owner.get('chromePid'), int):
                raise SafeFailure('OWNED_RUNTIME_INVALID')
            role_registry = read_json(PAGE_ROLE_REGISTRY)
            assert_registered_roles(role_registry)
            contract = read_json(REPO / 'discovery' / 'observed-contract.json')
            mode = incoming['mode']
            readback_only = mode in ('task-readback-metadata-only', 'task-asset-readback-only')
            download_asset = mode == 'task-asset-readback-only'
            stage = 'read_only_task_hNv_readback' if readback_only else 'read_only_session_bootstrap'
            result = capture_browser_request_cdp(
                'image', IMAGE_INTENT, contract,
                bootstrap_only=not readback_only,
                readback_only=readback_only,
                download_asset=download_asset,
            )
            readback = result.get('taskReadback') or {}
            task_readback_ready = bool(
                readback.get('status') == 'verified'
                and readback.get('exactTaskMatchCount') == 1
                and readback.get('exactPromptMatched') is True
                and readback.get('apiConversationIdEchoed') is True
                and readback.get('routeBound') is True
            )
            download = result.get('assetVerification') or {}
            download_ready = bool(download.get('status') == 'verified'
                                  and download.get('downloadAuthorization') == 'hNv_task_contract_and_current_session'
                                  and download.get('browserAssetGetPerformed') is False
                                  and download.get('mimeMagicMatched') is True
                                  and download.get('independentFileReadback') is True
                                  and (download.get('artifact') or {}).get('previousArtifactHashMatched') is True)
            ready = bool(
                (result.get('directBootstrap') or {}).get('status') == 'verified'
                if not readback_only else task_readback_ready
            ) and result.get('historyContextRequestCaptured') is True \
                and result.get('historyContextResponseVerified') is True \
                and result.get('resetQuietVerified') is True
            if download_asset:
                ready = ready and download_ready
            receipt_persisted = False
            receipt_error_code = None
            if download_asset and task_readback_ready:
                try:
                    persist_task_asset_readback(
                        f'{CALLER_INTENT}.attempt-3', readback,
                        result.get('assetVerification'), result.get('nativeAttemptSummary'), result.get('assetErrorCode'),
                        result.get('assetErrorDetails'),
                        result.get('resetQuietVerified'),
                    )
                    receipt_persisted = True
                except SafeFailure as error:
                    receipt_error_code = error.code
                except Exception:
                    receipt_error_code = 'MEDIA_RECEIPT_WRITE_FAILED'
                ready = ready and receipt_persisted
            output = {
                'status': ('verified' if download_asset and ready else 'ready' if ready else 'incomplete'),
                'service': 'gemini-web',
                'mode': mode,
                **result,
                'businessWriteSent': False,
                'mutationDispatchCount': 0,
                'sessionValuesPersisted': False,
                'historyIdentifiersPersisted': False,
                'responseBodiesPersisted': False,
                'receiptPersisted': receipt_persisted,
                'receiptErrorCode': receipt_error_code,
            }
            sys.stdout.write(json.dumps(output, ensure_ascii=False) + '\n')
            return 0 if ready else 3
        if (not isinstance(incoming, dict)
                or set(incoming) - {'capability', 'callerIntent', 'intent'}
                or incoming.get('capability') != 'image'
                or incoming.get('callerIntent', CALLER_INTENT) != CALLER_INTENT
                or incoming.get('intent', IMAGE_INTENT) != IMAGE_INTENT):
            raise SafeFailure('INPUT_INVALID')
        runtime_owner = read_json(RUNTIME_OWNER)
        if runtime_owner.get('taskOwned') is not True or not isinstance(runtime_owner.get('chromePid'), int):
            raise SafeFailure('OWNED_RUNTIME_INVALID')
        role_registry = read_json(PAGE_ROLE_REGISTRY)
        assert_registered_roles(role_registry)
        contract = read_json(REPO / 'discovery' / 'observed-contract.json')
        stage = 'guarded_capture_direct_readback'
        media_run = capture_browser_request_cdp('image', IMAGE_INTENT, contract)
        direct_summary = media_run.get('directSummary') or {}
        asset_verification = media_run.get('assetVerification') or {}
        direct_download = asset_verification.get('directDownload') or {}
        task_readback_verified = direct_summary.get('taskReadbackVerified') is True
        asset_download_verified = (direct_download.get('status') == 'verified'
                                   and direct_download.get('mimeMagicMatched') is True
                                   and direct_download.get('independentFileReadback') is True)
        complete = task_readback_verified and asset_download_verified and media_run.get('resetQuietVerified') is True
        receipt_persisted = False
        receipt_error_code = None
        try:
            persist_direct_media_receipt(
                'image', CALLER_INTENT,
                (media_run.get('intentPreflight') or {}).get('auditAttemptKey'),
                media_run,
            )
            receipt_persisted = True
        except SafeFailure as error:
            receipt_error_code = error.code
        except Exception:
            receipt_error_code = 'MEDIA_RECEIPT_WRITE_FAILED'
        complete = complete and receipt_persisted
        stage = 'receipt_complete'
        output = {
            'status': 'verified' if complete else 'incomplete',
            'service': 'gemini-web',
            'operation': 'image',
            'callerIntentId': CALLER_INTENT,
            'auditAttemptKey': (media_run.get('intentPreflight') or {}).get('auditAttemptKey'),
            'accountDigestMatchedApproved': (media_run.get('intentPreflight') or {}).get('accountDigestMatchedApproved') is True,
            'existingGeminiOwnerAndTextReceiptsMatched': (media_run.get('intentPreflight') or {}).get('existingGeminiOwnerAndTextReceiptsMatched') is True,
            'capture': media_run.get('captureSummary'),
            'directHttp': direct_summary,
            'directErrorCode': media_run.get('directErrorCode'),
            'historyReadbackVerified': task_readback_verified,
            'nativeGet': asset_verification.get('nativeGet'),
            'directDownload': direct_download or None,
            'assetErrorCode': media_run.get('assetErrorCode'),
            'resetQuietVerified': media_run.get('resetQuietVerified') is True,
            'guardFailure': media_run.get('guardFailure'),
            'unexpectedPostCount': media_run.get('unexpectedPostCount', 0),
            'blockedPostMetadata': media_run.get('blockedPostMetadata', []),
            'measurementBeaconCountBlocked': media_run.get('measurementBeaconCountBlocked', 0),
            'preferenceMutationCandidateAbortRequestedCount': media_run.get('preferenceMutationCandidateAbortRequestedCount', 0),
            'preferenceMutationCandidateAbortCommandFailures': media_run.get('preferenceMutationCandidateAbortCommandFailures', 0),
            'receiptPersisted': receipt_persisted,
            'receiptErrorCode': receipt_error_code,
            'rawPromptPersisted': False,
            'rawTaskUrlPersisted': False,
            'conversationIdsPersisted': False,
            'cookieValuesPersisted': False,
            'responseBodiesPersisted': False,
        }
        sys.stdout.write(json.dumps(output, ensure_ascii=False) + '\n')
        return 0 if complete else 3
    except SafeFailure as error:
        output = {'status': 'stopped', 'code': error.code, 'stage': stage}
        if isinstance(error.details, dict):
            output['safeDetails'] = error.details
        sys.stdout.write(json.dumps(output, ensure_ascii=False) + '\n')
        return 2
    except Exception as error:
        sys.stdout.write(json.dumps({'status': 'stopped', 'code': 'MEDIA_DIRECT_FLOW_FAILED', 'stage': stage, 'errorClass': type(error).__name__}) + '\n')
        return 2
    finally:
        raw[:] = b'\0' * len(raw)
        scrub_json_strings(incoming)


if __name__ == '__main__':
    raise SystemExit(main())
