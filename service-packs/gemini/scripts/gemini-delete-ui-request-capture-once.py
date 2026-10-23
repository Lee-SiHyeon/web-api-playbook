#!/usr/bin/env python3
"""Capture the normal Gemini delete request while aborting the mutation."""

import hashlib
import importlib.util
import json
import os
import pathlib
import re
import subprocess
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
DELETE_RPC = 'GzXR5e'
TASK_TITLE = 'Codex API verified text 20261006'
TASK_MARKER = 'PROTOCOL42'
NODE = '/home/worker/.npm/_npx/387698761821791d/node_modules/node/bin/node'
NODE_ROUTE_HELPER = REPO / 'scripts/gemini-task-route-id-once.mjs'
CONTRACT_PATH = REPO / 'discovery/observed-contract.json'
RECEIPT_PATH = REPO / 'verification/one-shot/gemini-delete-ui-request-capture-2026-10-06.json'
ALLOWED_READ_IDS = {'MaZiqc', 'hNvQHb', 'otAQ7b', 'ESY5D', 'OXxBcc'}
SAFE_HEADER_NAMES = {
    'accept', 'content-type', 'origin', 'referer', 'sec-ch-ua', 'sec-ch-ua-arch',
    'sec-ch-ua-bitness', 'sec-ch-ua-form-factors', 'sec-ch-ua-full-version',
    'sec-ch-ua-full-version-list', 'sec-ch-ua-mobile', 'sec-ch-ua-model',
    'sec-ch-ua-platform', 'sec-ch-ua-platform-version', 'sec-ch-ua-wow64',
    'user-agent', 'x-goog-ext-525001261-jspb', 'x-goog-ext-73010989-jspb',
    'x-same-domain',
}
FORBIDDEN_HEADERS = {'cookie', 'authorization', 'host', 'content-length'}
CID_RE = re.compile(r'^c_[0-9a-f]{16}$')


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


def count_exact(value, expected, depth=0, budget=None):
    budget = budget if budget is not None else [0]
    budget[0] += 1
    if budget[0] > 50000 or depth > 24:
        return 0
    if isinstance(value, str):
        matched = int(value == expected)
        candidate = value.strip()
        if candidate.startswith(('[', '{')) and len(candidate) <= 2 * 1024 * 1024:
            try:
                return matched + count_exact(json.loads(candidate), expected, depth + 1, budget)
            except Exception:
                return matched
        return matched
    if isinstance(value, list):
        return sum(count_exact(item, expected, depth + 1, budget) for item in value)
    if isinstance(value, dict):
        return sum(count_exact(item, expected, depth + 1, budget) for item in value.values())
    return 0


def value_shape(value, conversation_id, depth=0):
    if depth > 16:
        return 'depth_limit'
    if value is None:
        return 'null'
    if isinstance(value, bool):
        return 'boolean'
    if isinstance(value, (int, float)):
        return 'number'
    if isinstance(value, str):
        return {'type': 'string', 'length': len(value), 'targetMatched': value == conversation_id}
    if isinstance(value, list):
        return {'type': 'array', 'length': len(value), 'items': [value_shape(item, conversation_id, depth + 1) for item in value[:16]]}
    if isinstance(value, dict):
        return {'type': 'object', 'fieldCount': len(value)}
    return 'unsupported'


def decode_batch_request(request):
    parsed = urllib.parse.urlsplit(request.url)
    if (parsed.scheme != 'https' or parsed.hostname != 'gemini.google.com'
            or parsed.path != BATCH_PATH):
        return None
    query_pairs = urllib.parse.parse_qsl(parsed.query, keep_blank_values=True)
    rpc_ids = [value for key, value in query_pairs if key == 'rpcids']
    if len(rpc_ids) != 1:
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
    if len(call) < 2 or call[0] != rpc_ids[0] or not isinstance(call[1], str):
        return None
    args = json.loads(call[1])
    if not isinstance(args, list):
        return None
    return {
        'parsed': parsed,
        'queryKeys': [name for name, _ in query_pairs],
        'formFieldNames': [name for name, _ in form_pairs],
        'bodyBytes': len(body.encode('utf-8')),
        'rpcId': rpc_ids[0],
        'args': args,
        'rpcCallTail': call[2:],
    }


def allowed_read(decoded, conversation_id):
    return bool(decoded and decoded['rpcId'] in ALLOWED_READ_IDS)


def capture_route_suffix(session, owner_email, text_helper, share_capture_module):
    return share_capture_module.capture_task_route_suffix(session, owner_email)


def call_task_route_helper(session, expected_owner):
    api_helper = import_script('delete_capture_api_helper', REPO / 'scripts/run-linux-api.py')
    text_helper = import_script('delete_capture_text_helper', REPO / 'scripts/run-linux-text-smoke.py')
    share_capture = import_script('delete_capture_share_helper', REPO / 'scripts/gemini-share-public-route-capture-once.py')
    return capture_route_suffix(session, expected_owner, text_helper, share_capture)


def write_receipt(receipt):
    RECEIPT_PATH.parent.mkdir(parents=True, exist_ok=True)
    temporary = RECEIPT_PATH.with_name(RECEIPT_PATH.name + f'.delete-capture-{os.getpid()}.pending')
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


def main():
    session = None
    expected_owner = ''
    conversation_id = ''
    route_id = ''
    capture = None
    request_header_values = None
    page = None
    guard_attached = False
    audit = {'blockedNonReadRequestCount': 0, 'guardParseFailureCount': 0, 'allowedReadRequestCount': 0}
    stage = 'runtime'
    try:
        owner = json.loads(OWNER_PATH.read_text(encoding='utf-8'))
        roles = json.loads(ROLE_PATH.read_text(encoding='utf-8'))
        api_helper = import_script('delete_capture_api_helper_session', REPO / 'scripts/run-linux-api.py')
        text_helper = import_script('delete_capture_text_helper_session', REPO / 'scripts/run-linux-text-smoke.py')
        read_helper = import_script('delete_capture_owner_helper', REPO / 'scripts/gemini-share-list-read-once.py')
        expected_hash, _ = text_helper.read_static_owner_hash()
        contract = json.loads(CONTRACT_PATH.read_text(encoding='utf-8'))
        stage = 'session_capture'
        session, expected_owner, _ = read_helper.capture_session(owner, roles, contract, api_helper, text_helper, expected_hash)
        stage = 'task_route_identity'
        route_id = call_task_route_helper(session, expected_owner)
        conversation_id = 'c_' + route_id
        route_id_digest = hashlib.sha256(conversation_id.encode('ascii')).hexdigest()
        target_request_count = 0
        duplicate_target_request = False
        capture_failed = False
        request_header_values = None

        def guard(route):
            nonlocal target_request_count, duplicate_target_request, capture_failed, capture, request_header_values
            try:
                request = route.request
                if request.method.upper() in {'GET', 'HEAD', 'OPTIONS'}:
                    route.continue_()
                    return
                decoded = decode_batch_request(request)
                if decoded and decoded['rpcId'] == DELETE_RPC:
                    target_request_count += 1
                    if target_request_count > 1:
                        duplicate_target_request = True
                    matched = count_exact(decoded['args'], conversation_id) == 1
                    header_map = {str(key).lower(): str(value) for key, value in request.headers.items()}
                    names = sorted(name for name in header_map if name in SAFE_HEADER_NAMES)
                    if (not matched or request.method.upper() != 'POST'
                            or decoded['queryKeys'] != contract['operations']['history_list']['request']['queryKeys']
                            or decoded['formFieldNames'] != contract['operations']['history_list']['request']['bodyFieldNames']
                            or request.headers.get('content-type', '').split(';', 1)[0].strip().lower()
                                != 'application/x-www-form-urlencoded'):
                        capture_failed = True
                    elif capture is None:
                        request_header_values = {name: header_map[name] for name in names}
                        capture = {
                            'rpcId': DELETE_RPC,
                            'request': {
                                'method': request.method.upper(),
                                'origin': ORIGIN,
                                'path': BATCH_PATH,
                                'queryKeys': decoded['queryKeys'],
                                'headerNames': names,
                                'contentType': request.headers.get('content-type', '').strip(),
                                'formFieldNames': decoded['formFieldNames'],
                            },
                            'rpcCallTail': decoded['rpcCallTail'],
                            'argsShape': value_shape(decoded['args'], conversation_id),
                            'argsSha256': hashlib.sha256(json.dumps(decoded['args'], ensure_ascii=False, separators=(',', ':')).encode('utf-8')).hexdigest(),
                            'targetConversationOccurrenceCount': 1,
                            'requestBytes': decoded['bodyBytes'],
                            'requestHeaderValuesPersisted': False,
                            'rawArgumentsPersisted': False,
                        }
                    try:
                        route.abort('aborted')
                    except Exception:
                        capture_failed = True
                    return
                if allowed_read(decoded, conversation_id):
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
            pages = [page for page in context.pages if page.evaluate('() => window.name') == PAGE_ROLE]
            if len(pages) != 1:
                raise SafeFailure('ROLE_PAGE_NOT_UNIQUE')
            page = pages[0]
            page.route('**/*', guard)
            guard_attached = True
            try:
                stage = 'task_route_open'
                page.goto(f'{ORIGIN}/app/{route_id}', wait_until='domcontentloaded', timeout=60000)
                stage = 'task_render_wait'
                page.wait_for_function(
                    "({title,marker}) => document.body && document.body.innerText.includes(title) && document.body.innerText.includes(marker)",
                    arg={'title': TASK_TITLE, 'marker': TASK_MARKER}, timeout=30000,
                )
                task_options = page.locator('button,[role=button]').evaluate_all(
                    """(nodes,title) => nodes.map((element,index) => ({element,index,
                      label:(element.getAttribute('aria-label')||element.getAttribute('title')||element.innerText||'').trim().replace(/\\s+/g,' ')}))
                      .filter(item => item.element.getClientRects().length > 0
                        && item.label.includes(title) && /options|옵션|more|더보기/i.test(item.label))
                      .map(item => ({index:item.index,disabled:item.element.disabled===true,
                        role:item.element.getAttribute('role')||item.element.tagName,
                        ariaLabelLength:(item.element.getAttribute('aria-label')||'').length,
                        titleLength:(item.element.getAttribute('title')||'').length,
                        textLength:(item.element.innerText||'').trim().length}))""",
                    TASK_TITLE,
                )
                if len(task_options) != 1 or task_options[0]['disabled']:
                    raise SafeFailure(f'TASK_OPTIONS_CONTROL_COUNT_{len(task_options)}')
                stage = 'open_task_menu'
                page.locator('button,[role=button]').nth(task_options[0]['index']).click(timeout=8000, force=True)
                delete_items = page.locator('button,[role=button],[role=menuitem]').evaluate_all(
                    """nodes => nodes.map((element,index) => ({element,index,
                      label:(element.getAttribute('aria-label')||element.getAttribute('title')||element.innerText||'').trim().replace(/\\s+/g,' ')}))
                      .filter(item => item.element.getClientRects().length > 0
                        && /삭제|delete/i.test(item.label))
                      .map(item => ({index:item.index,disabled:item.element.disabled===true,
                        role:item.element.getAttribute('role')||item.element.tagName,
                        labelLength:item.label.length}))"""
                )
                if len(delete_items) != 1 or delete_items[0]['disabled']:
                    raise SafeFailure(f'TASK_DELETE_MENU_ITEM_COUNT_{len(delete_items)}')
                stage = 'open_delete_confirmation'
                page.locator('button,[role=button],[role=menuitem]').nth(delete_items[0]['index']).click(timeout=8000)
                confirm_buttons = page.locator('[role=dialog] button,[role=dialog] [role=button]').evaluate_all(
                    """nodes => nodes.map((element,index) => ({element,index,
                      label:(element.getAttribute('aria-label')||element.getAttribute('title')||element.innerText||'').trim().replace(/\\s+/g,' ')}))
                      .filter(item => item.element.getClientRects().length > 0
                        && /삭제|delete/i.test(item.label))
                      .map(item => ({index:item.index,disabled:item.element.disabled===true,
                        labelLength:item.label.length}))"""
                )
                if len(confirm_buttons) != 1 or confirm_buttons[0]['disabled']:
                    raise SafeFailure(f'TASK_DELETE_CONFIRM_CONTROL_COUNT_{len(confirm_buttons)}')
                stage = 'abort_delete_request'
                page.locator('[role=dialog] button,[role=dialog] [role=button]').nth(confirm_buttons[0]['index']).click(timeout=8000)
                page.wait_for_timeout(1000)
                if target_request_count != 1 or capture is None or duplicate_target_request or capture_failed:
                    raise SafeFailure('TASK_DELETE_REQUEST_CAPTURE_FAILED')
                if audit['guardParseFailureCount'] != 0:
                    raise SafeFailure('TASK_DELETE_GUARD_PARSE_FAILURE')
                if page.get_by_role('dialog').count():
                    page.keyboard.press('Escape')
                    page.wait_for_timeout(200)
                stage = 'task_post_abort_readback'
                page.goto(f'{ORIGIN}/app/{route_id}', wait_until='domcontentloaded', timeout=60000)
                page.wait_for_function(
                    "({title,marker}) => document.body && document.body.innerText.includes(title) && document.body.innerText.includes(marker)",
                    arg={'title': TASK_TITLE, 'marker': TASK_MARKER}, timeout=30000,
                )
                task_present_after_abort = True
                stage = 'restore_app_root'
                page.goto(f'{ORIGIN}/app', wait_until='domcontentloaded', timeout=60000)
                page.wait_for_timeout(5000)
                page_restored = urllib.parse.urlsplit(page.url).path == '/app' and page.evaluate('() => window.name') == PAGE_ROLE
            finally:
                if guard_attached and page:
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
            'schema': 'gemini-delete-ui-request-capture-v1',
            'service': 'gemini-web',
            'feature': 'delete',
            'operation': 'delete',
            'outcome': 'normal_ui_request_captured_browser_mutation_aborted',
            'capturedAt': datetime.now(timezone.utc).isoformat(),
            'executionHost': 'linux_worker',
            'pageRole': PAGE_ROLE,
            'sourceMapping': {'rpcId': DELETE_RPC, 'operationName': 'DeleteConversation', 'mappingClass': 'normal_ui_capture_plus_first_party_source_candidate'},
            'targetBinding': {'ownerMatched': True, 'exactTaskTitleSelectedOnce': True, 'taskPromptMarkerVisible': True,
                              'apiConversationIdBoundToRoute': True, 'conversationIdSha256': route_id_digest,
                              'targetOccurrenceCountInDeleteArgs': 1, 'rawConversationIdPersisted': False},
            'request': capture,
            'guard': {'browserDeleteRequestReachedServer': False, 'browserAbortAcknowledged': True,
                      'targetRequestCaptureCount': target_request_count, **audit},
            'postAbortReadback': {'sameTaskRouteRestored': True, 'exactTitleVisible': True,
                                  'promptMarkerVisible': True, 'serverMutationObserved': False},
            'browserPageRestored': page_restored,
            'directMutation': {'dispatchCount': 0, 'deferredUntilTaskDeleteLast': True},
            'persistence': {'requestHeaderValuesPersisted': False, 'rawArgumentsPersisted': False,
                            'cookiesPersisted': False, 'sessionValuesPersisted': False,
                            'conversationIdsPersisted': False, 'promptOrAssistantTextPersisted': False,
                            'rawRequestOrResponseBodyPersisted': False},
        }
        if isinstance(request_header_values, dict):
            for key in list(request_header_values):
                request_header_values[key] = ''
            request_header_values.clear()
        stage = 'write_receipt'
        write_receipt(receipt)
        print(json.dumps({'outcome': receipt['outcome'], 'rpcId': DELETE_RPC,
                          'targetOccurrenceCount': 1, 'browserRequestReachedServer': False,
                          'taskPresentAfterAbort': True, 'pageRestored': page_restored,
                          'receipt': str(RECEIPT_PATH)}, separators=(',', ':')))
        return 0
    except SafeFailure as exc:
        print(exc.code, file=sys.stderr)
        return 1
    except Exception as exc:
        print('TASK_DELETE_UI_CAPTURE_FAILED:' + stage + ':' + type(exc).__name__, file=sys.stderr)
        return 1
    finally:
        if guard_attached and page:
            try:
                if urllib.parse.urlsplit(page.url).path != '/app':
                    page.route('**/*', guard)
                    page.goto(f'{ORIGIN}/app', wait_until='domcontentloaded', timeout=60000)
                    page.wait_for_timeout(5000)
                    page.unroute('**/*', guard)
            except Exception:
                pass
        wipe(session)
        session = None
        expected_owner = ''
        conversation_id = ''
        route_id = ''
        if isinstance(capture, dict):
            wipe(capture)
        if isinstance(request_header_values, dict):
            for key in list(request_header_values):
                request_header_values[key] = ''
            request_header_values.clear()


if __name__ == '__main__':
    raise SystemExit(main())
