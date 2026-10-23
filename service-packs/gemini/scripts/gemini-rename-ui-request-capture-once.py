#!/usr/bin/env python3
"""Capture a normal rename request while aborting it before it reaches Gemini."""

import hashlib
import importlib.util
import json
import os
import pathlib
import re
import sys
import urllib.parse
from datetime import datetime, timezone

from playwright.sync_api import sync_playwright


REPO = pathlib.Path(__file__).resolve().parent.parent
RUNTIME = pathlib.Path.home() / '.nad-scratch/provider-runtime-20261005'
OWNER_PATH = RUNTIME / 'runtime-owner.json'
ROLE_PATH = RUNTIME / 'page-role-registry.json'
PAGE_ROLE = 'codex-gemini-lifecycle-20261006'
ORIGIN = 'https://gemini.google.com'
BATCH_PATH = '/_/BardChatUi/data/batchexecute'
RENAME_RPC = 'MUAZcd'
TASK_TITLE = 'Codex API verified text 20261006'
TASK_MARKER = 'PROTOCOL42'
CAPTURE_VARIANT = os.environ.get('GEMINI_RENAME_CAPTURE_VARIANT', 'latest')
TEMP_TITLE = {
    'a': 'Codex rename probe A 20261006',
    'b': 'Codex rename probe B 20261006',
    'latest': 'Codex rename probe 20261006',
}.get(CAPTURE_VARIANT, '')
CONTRACT_PATH = REPO / 'discovery/observed-contract.json'
RECEIPT_NAME = 'gemini-rename-ui-request-capture-2026-10-06.json' if CAPTURE_VARIANT == 'latest' else f'gemini-rename-ui-request-capture-{CAPTURE_VARIANT}-2026-10-06.json'
RECEIPT_PATH = REPO / 'verification/one-shot' / RECEIPT_NAME
STATIC_COMPARE_PATH = REPO / 'verification/one-shot/gemini-rename-static-argument-proof-2026-10-06.json'
ALLOWED_READ_IDS = {'MaZiqc', 'hNvQHb', 'otAQ7b', 'ESY5D', 'OXxBcc'}
SAFE_HEADER_NAMES = {
    'accept', 'content-type', 'origin', 'referer', 'sec-ch-ua', 'sec-ch-ua-arch',
    'sec-ch-ua-bitness', 'sec-ch-ua-form-factors', 'sec-ch-ua-full-version',
    'sec-ch-ua-full-version-list', 'sec-ch-ua-mobile', 'sec-ch-ua-model',
    'sec-ch-ua-platform', 'sec-ch-ua-platform-version', 'sec-ch-ua-wow64',
    'user-agent', 'x-goog-ext-525001261-jspb', 'x-goog-ext-73010989-jspb',
    'x-same-domain',
}


class SafeFailure(Exception):
    def __init__(self, code):
        self.code = code


def import_script(name, path):
    sys.dont_write_bytecode = True
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def wipe(value, depth=0):
    if depth > 24 or value is None:
        return
    if isinstance(value, list):
        for index, child in enumerate(value):
            if isinstance(child, str):
                value[index] = ''
            else:
                wipe(child, depth + 1)
        value.clear()
    elif isinstance(value, dict):
        for key, child in list(value.items()):
            if isinstance(child, str):
                value[key] = ''
            else:
                wipe(child, depth + 1)
        value.clear()


def decode_batch_request(request):
    parsed = urllib.parse.urlsplit(request.url)
    if parsed.scheme != 'https' or parsed.hostname != 'gemini.google.com' or parsed.path != BATCH_PATH:
        return None
    query_pairs = urllib.parse.parse_qsl(parsed.query, keep_blank_values=True)
    ids = [value for key, value in query_pairs if key == 'rpcids']
    if len(ids) != 1:
        return None
    body = request.post_data or ''
    form_pairs = urllib.parse.parse_qsl(body, keep_blank_values=True)
    form = {}
    for name, value in form_pairs:
        form.setdefault(name, []).append(value)
    if sorted(form) != ['at', 'f.req'] or len(form.get('f.req', [])) != 1:
        return None
    outer = json.loads(form['f.req'][0])
    if (not isinstance(outer, list) or len(outer) != 1 or not isinstance(outer[0], list)
            or len(outer[0]) != 1 or not isinstance(outer[0][0], list)):
        return None
    call = outer[0][0]
    if len(call) < 2 or call[0] != ids[0] or not isinstance(call[1], str):
        return None
    args = json.loads(call[1])
    if not isinstance(args, list):
        return None
    return {
        'queryKeys': [name for name, _ in query_pairs],
        'formFieldNames': [name for name, _ in form_pairs],
        'requestBytes': len(body.encode('utf-8')),
        'rpcId': ids[0], 'args': args, 'rpcCallTail': call[2:],
    }


def count_exact(value, expected, depth=0, budget=None):
    budget = budget if budget is not None else [0]
    budget[0] += 1
    if budget[0] > 100000 or depth > 24:
        return 0
    if isinstance(value, str):
        matches = int(value == expected)
        candidate = value.strip()
        if candidate.startswith(('[', '{')) and len(candidate) <= 2 * 1024 * 1024:
            try:
                return matches + count_exact(json.loads(candidate), expected, depth + 1, budget)
            except Exception:
                return matches
        return matches
    if isinstance(value, list):
        return sum(count_exact(item, expected, depth + 1, budget) for item in value)
    if isinstance(value, dict):
        return sum(count_exact(item, expected, depth + 1, budget) for item in value.values())
    return 0


def value_shape(value, conversation_id, new_title, depth=0):
    if depth > 16:
        return 'depth_limit'
    if value is None:
        return 'null'
    if isinstance(value, bool):
        return 'boolean'
    if isinstance(value, (int, float)):
        return 'number'
    if isinstance(value, str):
        return {'type': 'string', 'length': len(value), 'conversationIdMatched': value == conversation_id,
                'newTitleMatched': value == new_title}
    if isinstance(value, list):
        return {'type': 'array', 'length': len(value),
                'items': [value_shape(item, conversation_id, new_title, depth + 1) for item in value[:16]]}
    if isinstance(value, dict):
        return {'type': 'object', 'fieldCount': len(value)}
    return 'unsupported'


def normalized_args_template(value, conversation_id, new_title, depth=0):
    if depth > 16:
        raise SafeFailure('RENAME_ARGS_TEMPLATE_TOO_DEEP')
    if isinstance(value, str):
        if value == conversation_id:
            return '{{conversationId}}'
        if value == new_title:
            return '{{newTitle}}'
        if (len(value) <= 16 and re.fullmatch(r'[A-Za-z0-9_-]+', value)
                and not re.fullmatch(r'c_[0-9a-f]{16}', value)):
            return {'$literal': value}
        raise SafeFailure('RENAME_STATIC_ARGUMENT_NOT_SAFE_TO_PERSIST')
    if isinstance(value, list):
        return [normalized_args_template(item, conversation_id, new_title, depth + 1) for item in value]
    if isinstance(value, dict):
        return {key: normalized_args_template(item, conversation_id, new_title, depth + 1)
                for key, item in value.items()}
    return value


def static_argument_fingerprints(value, conversation_id, new_title, path=(), depth=0):
    if depth > 16:
        raise SafeFailure('RENAME_ARGS_TEMPLATE_TOO_DEEP')
    if isinstance(value, str):
        if value in {conversation_id, new_title}:
            return []
        return [{'path': list(path), 'length': len(value),
                 'sha256': hashlib.sha256(value.encode('utf-8')).hexdigest()}]
    if isinstance(value, list):
        return [record for index, item in enumerate(value)
                for record in static_argument_fingerprints(item, conversation_id, new_title, (*path, index), depth + 1)]
    if isinstance(value, dict):
        return [record for key, item in value.items()
                for record in static_argument_fingerprints(item, conversation_id, new_title, (*path, 'field'), depth + 1)]
    return []


def write_receipt(receipt):
    RECEIPT_PATH.parent.mkdir(parents=True, exist_ok=True)
    temporary = RECEIPT_PATH.with_name(RECEIPT_PATH.name + f'.rename-capture-{os.getpid()}.pending')
    descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    try:
        with os.fdopen(descriptor, 'w', encoding='utf-8') as stream:
            json.dump(receipt, stream, ensure_ascii=False, indent=2)
            stream.write('\n')
        os.replace(temporary, RECEIPT_PATH)
    except Exception:
        try:
            temporary.unlink(missing_ok=True)
        except Exception:
            pass
        raise


def write_json_atomic(path, value, suffix):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + f'.{suffix}-{os.getpid()}.pending')
    descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    try:
        with os.fdopen(descriptor, 'w', encoding='utf-8') as stream:
            json.dump(value, stream, ensure_ascii=False, indent=2)
            stream.write('\n')
        os.replace(temporary, path)
    except Exception:
        try:
            temporary.unlink(missing_ok=True)
        except Exception:
            pass
        raise


def install_verified_edit_contract(captured_template, capture):
    current = json.loads(CONTRACT_PATH.read_text(encoding='utf-8'))
    current_operation = current.get('operations', {}).get('edit')
    if not current_operation or current_operation.get('request', {}).get('rpcId') != RENAME_RPC:
        raise SafeFailure('EDIT_CONTRACT_CONCURRENT_CHANGE')
    wire = capture['request']
    request = {
        'method': wire['method'], 'origin': wire['origin'], 'path': wire['path'],
        'queryKeys': wire['queryKeys'], 'headerNames': wire['headerNames'],
        'contentType': wire['contentType'], 'bodyFieldNames': wire['formFieldNames'],
        'rpcId': RENAME_RPC, 'rpcArgsTemplate': captured_template,
        'rpcCallTail': capture['rpcCallTail'],
    }
    current.setdefault('operations', {})['edit'] = {
        'observation': {'request': True, 'requestResponse': False},
        'effect': 'mutation', 'retryPolicy': 'never', 'request': request,
    }
    current['observedAt'] = datetime.now(timezone.utc).isoformat()
    write_json_atomic(CONTRACT_PATH, current, 'rename-args-template')
    fragment = json.loads((REPO / 'discovery/gemini-lifecycle-contract-fragment-2026-10-06.json').read_text(encoding='utf-8'))
    operation = fragment['operations']['conversation_rename']
    operation['browserCapture']['rpcArgsTemplate'] = captured_template
    operation['browserCapture']['staticArgumentInvariantAcrossTwoNormalCaptures'] = True
    operation['browserCapture']['staticArgumentProofPath'] = 'verification/one-shot/gemini-rename-static-argument-proof-2026-10-06.json'
    operation['status'] = 'request_only_contract_installed_from_two_matching_normal_ui_captures_prior_direct_readback_verified'
    write_json_atomic(REPO / 'discovery/gemini-lifecycle-contract-fragment-2026-10-06.json', fragment, 'rename-args-template')


def main():
    session = None
    expected_owner = ''
    conversation_id = ''
    route_id = ''
    request_header_values = None
    captured = None
    normalized_template = None
    static_fingerprints = None
    page = None
    guard_attached = False
    dialog_metadata = None
    dialog_handler = None
    audit = {'blockedNonReadRequestCount': 0, 'guardParseFailureCount': 0, 'allowedReadRequestCount': 0}
    stage = 'runtime'
    try:
        if CAPTURE_VARIANT not in {'a', 'b', 'latest'} or not TEMP_TITLE:
            raise SafeFailure('RENAME_CAPTURE_VARIANT_INVALID')
        owner = json.loads(OWNER_PATH.read_text(encoding='utf-8'))
        roles = json.loads(ROLE_PATH.read_text(encoding='utf-8'))
        api_helper = import_script('rename_capture_api_helper', REPO / 'scripts/run-linux-api.py')
        text_helper = import_script('rename_capture_text_helper', REPO / 'scripts/run-linux-text-smoke.py')
        read_helper = import_script('rename_capture_owner_helper', REPO / 'scripts/gemini-share-list-read-once.py')
        share_capture = import_script('rename_capture_route_helper', REPO / 'scripts/gemini-share-public-route-capture-once.py')
        expected_hash, _ = text_helper.read_static_owner_hash()
        contract = json.loads(CONTRACT_PATH.read_text(encoding='utf-8'))
        stage = 'session_capture'
        session, expected_owner, _ = read_helper.capture_session(owner, roles, contract, api_helper, text_helper, expected_hash)
        route_id = share_capture.capture_task_route_suffix(session, expected_owner)
        conversation_id = 'c_' + route_id
        conversation_id_digest = hashlib.sha256(conversation_id.encode('ascii')).hexdigest()
        target_request_count = 0
        duplicate_request = False
        capture_failed = False

        def guard(route):
            nonlocal target_request_count, duplicate_request, capture_failed, request_header_values, captured, normalized_template, static_fingerprints
            try:
                request = route.request
                if request.method.upper() in {'GET', 'HEAD', 'OPTIONS'}:
                    route.continue_()
                    return
                decoded = decode_batch_request(request)
                if decoded and decoded['rpcId'] == RENAME_RPC:
                    target_request_count += 1
                    duplicate_request = duplicate_request or target_request_count > 1
                    id_count = count_exact(decoded['args'], conversation_id)
                    title_count = count_exact(decoded['args'], TEMP_TITLE)
                    headers = {str(key).lower(): str(value) for key, value in request.headers.items()}
                    names = sorted(name for name in headers if name in SAFE_HEADER_NAMES)
                    if (id_count != 1 or title_count != 1 or request.method.upper() != 'POST'
                            or decoded['queryKeys'] != contract['operations']['history_list']['request']['queryKeys']
                            or decoded['formFieldNames'] != contract['operations']['history_list']['request']['bodyFieldNames']
                            or request.headers.get('content-type', '').split(';', 1)[0].strip().lower()
                                != 'application/x-www-form-urlencoded'):
                        capture_failed = True
                    elif captured is None:
                        request_header_values = {name: headers[name] for name in names}
                        normalized_template = normalized_args_template(decoded['args'], conversation_id, TEMP_TITLE)
                        static_fingerprints = static_argument_fingerprints(decoded['args'], conversation_id, TEMP_TITLE)
                        if (count_exact(decoded['args'], conversation_id) != 1
                                or count_exact(decoded['args'], TEMP_TITLE) != 1):
                            capture_failed = True
                            route.abort('aborted')
                            return
                        captured = {
                            'rpcId': RENAME_RPC,
                            'request': {
                                'method': request.method.upper(), 'origin': ORIGIN, 'path': BATCH_PATH,
                                'queryKeys': decoded['queryKeys'], 'headerNames': names,
                                'contentType': request.headers.get('content-type', '').strip(),
                                'formFieldNames': decoded['formFieldNames'],
                            },
                            'rpcCallTail': decoded['rpcCallTail'],
                            'argsShape': value_shape(decoded['args'], conversation_id, TEMP_TITLE),
                            'rpcArgsTemplateShape': value_shape(normalized_template, conversation_id, TEMP_TITLE),
                            'staticArgumentFingerprints': static_fingerprints,
                            'argsSha256': hashlib.sha256(json.dumps(decoded['args'], ensure_ascii=False, separators=(',', ':')).encode('utf-8')).hexdigest(),
                            'conversationIdOccurrenceCount': id_count,
                            'newTitleOccurrenceCount': title_count,
                            'requestBytes': decoded['requestBytes'],
                            'requestHeaderValuesPersisted': False,
                            'rpcArgsTemplatePersisted': False,
                            'rawArgumentsPersisted': False,
                        }
                    try:
                        route.abort('aborted')
                    except Exception:
                        capture_failed = True
                    return
                if decoded and decoded['rpcId'] in ALLOWED_READ_IDS:
                    audit['allowedReadRequestCount'] += 1
                    route.continue_()
                    return
            except Exception:
                audit['guardParseFailureCount'] += 1
            audit['blockedNonReadRequestCount'] += 1
            try:
                route.abort('aborted')
            except Exception:
                audit['guardParseFailureCount'] += 1

        with sync_playwright() as playwright:
            browser = playwright.chromium.connect_over_cdp(f"http://127.0.0.1:{owner['cdpPort']}")
            if len(browser.contexts) != 1:
                raise SafeFailure('OWNED_CONTEXT_COUNT_INVALID')
            context = browser.contexts[0]
            pages = [candidate for candidate in context.pages if candidate.evaluate('() => window.name') == PAGE_ROLE]
            if len(pages) != 1:
                raise SafeFailure('ROLE_PAGE_NOT_UNIQUE')
            page = pages[0]
            page.route('**/*', guard)
            guard_attached = True
            def handle_dialog(dialog):
                nonlocal dialog_metadata, capture_failed
                default_value = getattr(dialog, 'default_value', '') or ''
                if dialog.type == 'prompt' and default_value == TASK_TITLE:
                    dialog_metadata = {'type': 'prompt', 'prefillMatchedTaskTitle': True,
                                       'defaultValueLength': len(default_value)}
                    dialog.accept(TEMP_TITLE)
                else:
                    dialog_metadata = {'type': dialog.type, 'prefillMatchedTaskTitle': False,
                                       'defaultValueLength': len(default_value)}
                    capture_failed = True
                    dialog.dismiss()
            dialog_handler = handle_dialog
            page.on('dialog', dialog_handler)
            try:
                if urllib.parse.urlsplit(page.url).path != '/app':
                    raise SafeFailure('PAGE_NOT_APP_ROOT')
                stage = 'sidebar_task_row'
                page.wait_for_function(
                    'title => document.body && document.body.innerText.includes(title)',
                    arg=TASK_TITLE, timeout=15000,
                )
                selector = 'button,[role=button]'
                task_options = page.locator(selector).evaluate_all(
                    """(nodes,title) => nodes.map((e,index)=>({e,index,label:(e.getAttribute('aria-label')||e.getAttribute('title')||e.innerText||'').trim().replace(/\\s+/g,' ')}))
                      .filter(x=>x.e.getClientRects().length>0&&x.label.includes(title)&&/options|옵션|more|더보기/i.test(x.label))
                      .map(x=>({index:x.index,disabled:x.e.disabled===true}))""", TASK_TITLE,
                )
                if len(task_options) != 1 or task_options[0]['disabled']:
                    raise SafeFailure(f'TASK_OPTIONS_CONTROL_COUNT_{len(task_options)}')
                stage = 'open_task_menu'
                page.locator(selector).nth(task_options[0]['index']).click(force=True, timeout=8000)
                page.wait_for_timeout(250)
                rename_items = page.locator('button,[role=button],[role=menuitem]').evaluate_all(
                    """nodes=>nodes.map((e,index)=>({e,index,label:(e.getAttribute('aria-label')||e.getAttribute('title')||e.innerText||'').trim().replace(/\\s+/g,' ')}))
                      .filter(x=>x.e.getClientRects().length>0&&/rename|title|name|제목|이름|수정/i.test(x.label))
                      .map(x=>({index:x.index,disabled:x.e.disabled===true}))"""
                )
                if len(rename_items) != 1 or rename_items[0]['disabled']:
                    raise SafeFailure(f'TASK_RENAME_MENU_ITEM_COUNT_{len(rename_items)}')
                stage = 'open_rename_dialog'
                menu_selector = 'button,[role=button],[role=menuitem]'
                page.locator(menu_selector).nth(rename_items[0]['index']).click(force=True, timeout=8000)
                page.wait_for_function("() => !!document.querySelector('[role=dialog] input')", timeout=5000)
                input_selector = '[role=dialog] input'
                if page.locator(input_selector).count() != 1:
                    raise SafeFailure('TASK_RENAME_INPUT_COUNT_NOT_UNIQUE')
                old_input = page.locator(input_selector).input_value()
                unicodedata = __import__('unicodedata')
                if unicodedata.normalize('NFKC', old_input).strip() != unicodedata.normalize('NFKC', TASK_TITLE).strip():
                    raise SafeFailure('TASK_RENAME_BEFORE_VALUE_NOT_BOUND_TO_TASK')
                scratch = pathlib.Path.home() / '.nad-scratch/tmp'
                scratch.mkdir(parents=True, exist_ok=True)
                page.locator('[role=dialog]').screenshot(path=str(scratch / 'gemini-lifecycle-rename-dialog.png'), timeout=5000)
                stage = 'fill_temporary_title'
                page.locator(input_selector).fill(TEMP_TITLE, timeout=8000)
                button_selector = '[role=dialog] button'
                dialog_buttons = page.locator(button_selector).evaluate_all(
                    """nodes=>nodes.map((e,index)=>({e,index,label:(e.getAttribute('aria-label')||e.getAttribute('title')||e.innerText||'').trim().replace(/\\s+/g,' ')}))
                      .filter(x=>x.e.getClientRects().length>0&&/rename|update|title|제목|이름 변경/i.test(x.label))
                      .map(x=>({index:x.index,disabled:x.e.disabled===true}))"""
                )
                if len(dialog_buttons) != 1 or dialog_buttons[0]['disabled']:
                    raise SafeFailure(f'TASK_RENAME_CONFIRM_BUTTON_COUNT_{len(dialog_buttons)}')
                stage = 'abort_rename_request'
                page.locator(button_selector).nth(dialog_buttons[0]['index']).click(timeout=8000)
                stage = 'abort_rename_request'
                page.wait_for_timeout(1000)
                if target_request_count != 1 or captured is None or duplicate_request or capture_failed:
                    raise SafeFailure('TASK_RENAME_REQUEST_CAPTURE_FAILED')
                if audit['guardParseFailureCount'] != 0:
                    raise SafeFailure('TASK_RENAME_GUARD_PARSE_FAILURE')
                stage = 'task_identity_readback_after_abort'
                route_after_abort = share_capture.capture_task_route_suffix(session, expected_owner)
                if route_after_abort != route_id:
                    raise SafeFailure('TASK_ROUTE_CHANGED_AFTER_ABORTED_RENAME')
                stage = 'restore_app_root'
                page.goto(f'{ORIGIN}/app', wait_until='domcontentloaded', timeout=60000)
                page.wait_for_function('title => document.body && document.body.innerText.includes(title)',
                                       arg=TASK_TITLE, timeout=15000)
                page.wait_for_timeout(5000)
                page_restored = urllib.parse.urlsplit(page.url).path == '/app' and page.evaluate('() => window.name') == PAGE_ROLE
                task_present_after_abort = True
            finally:
                if guard_attached and page:
                    if dialog_handler:
                        try:
                            page.remove_listener('dialog', dialog_handler)
                        except Exception:
                            audit['guardParseFailureCount'] += 1
                    try:
                        if urllib.parse.urlsplit(page.url).path != '/app':
                            page.goto(f'{ORIGIN}/app', wait_until='domcontentloaded', timeout=60000)
                        page.wait_for_timeout(5000)
                    except Exception:
                        pass
                    try:
                        page.unroute('**/*', guard)
                        page.wait_for_timeout(500)
                    except Exception:
                        audit['guardParseFailureCount'] += 1

        if not page_restored or not task_present_after_abort or audit['guardParseFailureCount'] != 0:
            raise SafeFailure('TASK_PAGE_RESTORE_OR_GUARD_FAILED')
        receipt = {
            'schema': 'gemini-rename-ui-request-capture-v1',
            'service': 'gemini-web', 'feature': 'edit', 'operation': 'edit',
            'outcome': 'normal_ui_request_captured_browser_mutation_aborted',
            'capturedAt': datetime.now(timezone.utc).isoformat(), 'executionHost': 'linux_worker',
            'pageRole': PAGE_ROLE,
            'captureVariant': CAPTURE_VARIANT,
            'sourceMapping': {'rpcId': RENAME_RPC, 'operationName': 'UpdateConversation',
                              'mappingClass': 'normal_ui_capture_plus_first_party_batch_request'},
            'normalUiControl': dialog_metadata or {'type':'dom_dialog','prefillMatchedTaskTitle':True},
            'targetBinding': {'ownerMatched': True, 'exactTaskTitleSelectedOnce': True,
                              'taskPromptMarkerPreviouslyVerified': True, 'apiConversationIdBoundToRoute': True,
                              'conversationIdSha256': conversation_id_digest,
                              'conversationIdOccurrenceCount': 1, 'newTitleOccurrenceCount': 1,
                              'rawConversationIdPersisted': False, 'newTitlePersisted': False},
            'request': captured,
            'guard': {'browserRenameRequestReachedServer': False, 'browserAbortAcknowledged': True,
                      'targetRequestCaptureCount': target_request_count, **audit},
            'postAbortReadback': {'sameApiConversationIdBoundToHistoryTitle': True,
                                  'originalTitleVisible': True, 'serverMutationObserved': False},
            'browserPageRestored': page_restored,
            'directMutation': {'dispatchCount': 0, 'priorDirectRenameUnchanged': True},
            'persistence': {'requestHeaderValuesPersisted': False, 'rawArgumentsPersisted': False,
                            'cookiesPersisted': False, 'sessionValuesPersisted': False,
                            'conversationIdsPersisted': False, 'promptOrAssistantTextPersisted': False,
                            'rawRequestOrResponseBodyPersisted': False, 'temporaryTitlePersisted': False},
        }
        if CAPTURE_VARIANT == 'b':
            stage = 'compare_static_argument_captures'
            first_path = REPO / 'verification/one-shot/gemini-rename-ui-request-capture-a-2026-10-06.json'
            if not first_path.is_file() or not isinstance(normalized_template, list):
                raise SafeFailure('RENAME_STATIC_ARGUMENT_BASELINE_MISSING')
            first = json.loads(first_path.read_text(encoding='utf-8'))
            first_request = first.get('request', {})
            first_fingerprints = first_request.get('staticArgumentFingerprints')
            current_fingerprints = captured.get('staticArgumentFingerprints')
            if (first.get('outcome') != 'normal_ui_request_captured_browser_mutation_aborted'
                    or first.get('sourceMapping', {}).get('rpcId') != RENAME_RPC
                    or first.get('targetBinding', {}).get('conversationIdSha256') != conversation_id_digest
                    or first_fingerprints != current_fingerprints
                    or not isinstance(first_fingerprints, list) or len(first_fingerprints) != 1
                    or first_fingerprints[0].get('length') != 5
                    or first_request.get('argsSha256') == captured.get('argsSha256')):
                raise SafeFailure('RENAME_STATIC_ARGUMENT_NOT_INVARIANT')
            proof = {
                'schema': 'gemini-rename-static-argument-proof-v1',
                'service': 'gemini-web', 'feature': 'edit', 'operation': 'edit',
                'outcome': 'static_argument_stable_across_two_normal_ui_captures',
                'verifiedAt': datetime.now(timezone.utc).isoformat(),
                'pageRole': PAGE_ROLE,
                'sourceMapping': {'rpcId': RENAME_RPC, 'operationName': 'UpdateConversation'},
                'captureCount': 2,
                'sameConversationIdDigest': True,
                'differentProposedTitlePayloadDigests': True,
                'sameStaticArgumentFingerprints': True,
                'staticArgumentCount': len(current_fingerprints),
                'staticArguments': current_fingerprints,
                'staticLiteralValuePersistedInReceipt': False,
                'browserMutationReachedServer': False,
                'directMutationDispatchCount': 0,
                'requestResponsePaired': False,
                'rawArgumentsPersisted': False,
                'requestOrResponseBodyPersisted': False,
            }
            write_json_atomic(STATIC_COMPARE_PATH, proof, 'static-argument-proof')
            stage = 'install_verified_edit_contract'
            install_verified_edit_contract(normalized_template, captured)
            receipt['staticArgumentInvariantAcrossCaptures'] = True
            receipt['staticArgumentProofPath'] = str(STATIC_COMPARE_PATH.relative_to(REPO))
            receipt['normalizedContractTemplateInstalled'] = True
        elif CAPTURE_VARIANT == 'a':
            receipt['staticArgumentBaselineCaptured'] = True
        if isinstance(request_header_values, dict):
            for key in list(request_header_values):
                request_header_values[key] = ''
            request_header_values.clear()
        write_receipt(receipt)
        print(json.dumps({'outcome': receipt['outcome'], 'rpcId': RENAME_RPC,
                          'targetAndNewTitleBoundOnce': True, 'browserRequestReachedServer': False,
                          'taskPresentAfterAbort': True, 'pageRestored': page_restored,
                          'receipt': str(RECEIPT_PATH)}, separators=(',', ':')))
        return 0
    except SafeFailure as exc:
        print(exc.code, file=sys.stderr)
        return 1
    except Exception as exc:
        code = getattr(exc, 'code', None)
        suffix = code if isinstance(code, str) and re.fullmatch(r'[A-Z][A-Z0-9_]{1,63}', code) else type(exc).__name__
        print('TASK_RENAME_UI_CAPTURE_FAILED:' + stage + ':' + suffix, file=sys.stderr)
        return 1
    finally:
        wipe(session)
        session = None
        expected_owner = ''
        conversation_id = ''
        route_id = ''
        if isinstance(captured, dict):
            wipe(captured)
        if isinstance(request_header_values, dict):
            for key in list(request_header_values):
                request_header_values[key] = ''
            request_header_values.clear()
        if page and not guard_attached:
            try:
                if urllib.parse.urlsplit(page.url).path != '/app':
                    page.goto(f'{ORIGIN}/app', wait_until='domcontentloaded', timeout=60000)
            except Exception:
                pass


if __name__ == '__main__':
    raise SystemExit(main())
