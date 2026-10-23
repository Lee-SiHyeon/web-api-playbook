#!/usr/bin/env python3
"""Capture the two task-owned public-share reads, replay them directly, and restore the task page."""

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
GROK_ROLE = 'codex-grok-core-20261006'
ORIGIN = 'https://gemini.google.com'
BATCH_PATH = '/_/BardChatUi/data/batchexecute'
PUBLIC_LIST_RPC = 'OXxBcc'
PUBLIC_READ_RPC = 'ujx1Bf'
TASK_TITLE = 'Codex API verified text 20261006'
TASK_MARKER = 'PROTOCOL42'
NODE = '/home/worker/.npm/_npx/387698761821791d/node_modules/node/bin/node'
NODE_HELPER = REPO / 'scripts/gemini-share-public-read-once.mjs'
NODE_ROUTE_HELPER = REPO / 'scripts/gemini-task-route-id-once.mjs'
NODE_REVOKE_HELPER = REPO / 'scripts/gemini-share-revoke-once.mjs'
NODE_ANONYMOUS_HELPER = REPO / 'scripts/gemini-share-anonymous-check-once.mjs'
CONTRACT_PATH = REPO / 'discovery/observed-contract.json'
RECEIPT_PATH = REPO / 'verification/one-shot/gemini-share-public-read-capture-2026-10-06.json'
FORBIDDEN_HEADERS = {'cookie', 'authorization', 'proxy-authorization', 'host', 'content-length'}
SHARE_ID_RE = re.compile(r'^[A-Za-z0-9._~-]{8,256}$')


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


def fail_closed(route):
    try:
        route.abort('aborted')
    except Exception:
        pass


def request_rpc(request):
    parsed = urllib.parse.urlsplit(request.url)
    query = urllib.parse.parse_qs(parsed.query, keep_blank_values=True)
    if parsed.hostname != 'gemini.google.com' or parsed.path != BATCH_PATH:
        return None, None
    ids = query.get('rpcids', [])
    if len(ids) != 1:
        return None, None
    form_pairs = urllib.parse.parse_qsl(request.post_data or '', keep_blank_values=True)
    form = dict(form_pairs)
    if not isinstance(form.get('f.req'), str):
        return None, None
    outer = json.loads(form['f.req'])
    call = outer[0][0]
    args = json.loads(call[1])
    if not isinstance(call, list) or len(call) != 4 or not isinstance(args, list):
        return None, None
    return ids[0], {'parsed': parsed, 'query': query, 'formPairs': form_pairs, 'call': call, 'args': args}


def count_exact(value, expected, depth=0, budget=None):
    if budget is None:
        budget = {'nodes': 0}
    budget['nodes'] += 1
    if budget['nodes'] > 100_000 or depth > 24:
        return 0
    if isinstance(value, str):
        matches = 1 if value == expected else 0
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


def shape(value, depth=0):
    if depth > 8:
        return 'depth_limit'
    if value is None:
        return 'null'
    if isinstance(value, bool):
        return 'boolean'
    if isinstance(value, (int, float)):
        return 'number'
    if isinstance(value, str):
        return {'type': 'string', 'length': len(value)}
    if isinstance(value, list):
        return {'type': 'array', 'length': len(value), 'items': [shape(item, depth + 1) for item in value[:10]]}
    if isinstance(value, dict):
        return {'type': 'object', 'fieldCount': len(value)}
    return 'unsupported'


def captured_request(request, base_request, share_id):
    rpc_id, decoded = request_rpc(request)
    if rpc_id != PUBLIC_READ_RPC or decoded is None:
        raise SafeFailure('PUBLIC_SHARE_REQUEST_PARSE_FAILED')
    parsed = decoded['parsed']
    call = decoded['call']
    args = decoded['args']
    query_keys = [name for name, _ in urllib.parse.parse_qsl(parsed.query, keep_blank_values=True)]
    body_fields = [name for name, _ in decoded['formPairs']]
    headers = {str(name).lower(): str(value) for name, value in request.headers.items()}
    allowed_headers = {str(name).lower() for name in base_request.get('headerNames', [])}
    header_names = sorted(name for name in headers if name in allowed_headers and name not in FORBIDDEN_HEADERS)
    request_header_values = {name: headers[name] for name in header_names}
    content_type = headers.get('content-type', '').lower()
    if (request.method.upper() != 'POST' or parsed.scheme != 'https'
            or parsed.hostname != 'gemini.google.com' or parsed.path != BATCH_PATH
            or query_keys != base_request.get('queryKeys')
            or body_fields != base_request.get('bodyFieldNames')
            or content_type != str(base_request.get('contentType', '')).lower()
            or call[0] != PUBLIC_READ_RPC or call[2:] != [None, 'generic']
            or count_exact(args, share_id) != 1):
        raise SafeFailure('PUBLIC_SHARE_REQUEST_SHAPE_MISMATCH')
    if not header_names or 'content-type' not in header_names:
        raise SafeFailure('PUBLIC_SHARE_REQUEST_HEADERS_INVALID')
    return {
        'rpcId': PUBLIC_READ_RPC,
        'args': args,
        'requestHeaderValues': request_header_values,
        'request': {
            'method': request.method.upper(),
            'origin': f'{parsed.scheme}://{parsed.netloc}',
            'path': parsed.path,
            'queryKeys': query_keys,
            'headerNames': header_names,
            'contentType': content_type,
            'bodyFieldNames': body_fields,
        },
        'metadata': {
            'method': request.method.upper(),
            'path': parsed.path,
            'rpcId': PUBLIC_READ_RPC,
            'queryKeys': query_keys,
            'headerNames': header_names,
            'formFieldNames': body_fields,
            'contentType': content_type,
            'bodyBytes': len((request.post_data or '').encode('utf-8')),
            'argsShape': shape(args),
            'shareIdOccurrenceCount': 1,
            'rpcCallTailShape': shape(call[2:]),
        },
    }


def dynamic_template(value, share_id, depth=0, counter=None):
    if counter is None:
        counter = {'replacements': 0}
    if depth > 24:
        raise SafeFailure('PUBLIC_SHARE_ARGS_TOO_DEEP')
    if value == share_id and isinstance(value, str):
        counter['replacements'] += 1
        return '{{shareId}}'
    if isinstance(value, str):
        if value and (value == TASK_TITLE or TASK_MARKER in value
                      or '://' in value or '@' in value
                      or re.fullmatch(r'c_[0-9a-f]{16}', value)
                      or len(value) > 64):
            raise SafeFailure('PUBLIC_SHARE_ARGS_CONTAIN_UNSAFE_LITERAL')
        if value not in {'', 'generic'}:
            raise SafeFailure('PUBLIC_SHARE_ARGS_UNCLASSIFIED_LITERAL')
        return value
    if isinstance(value, list):
        return [dynamic_template(item, share_id, depth + 1, counter) for item in value]
    if isinstance(value, dict):
        return {key: dynamic_template(item, share_id, depth + 1, counter) for key, item in value.items()}
    if value is None or isinstance(value, (bool, int, float)):
        return value
    raise SafeFailure('PUBLIC_SHARE_ARGS_UNSUPPORTED_VALUE')


def url_share_id(raw):
    parsed = urllib.parse.urlsplit(raw)
    segments = [part for part in parsed.path.split('/') if part]
    if (parsed.scheme != 'https' or parsed.hostname != 'gemini.google.com'
            or parsed.query or parsed.fragment or len(segments) != 2
            or segments[0] != 'share' or not SHARE_ID_RE.fullmatch(segments[1])):
        raise SafeFailure('COPIED_SHARE_LINK_UNSUPPORTED')
    return segments[1]


def install_contract(captures, share_ids):
    if len(captures) != 2 or len(share_ids) != 2:
        raise SafeFailure('PUBLIC_SHARE_CAPTURE_COUNT_INVALID')
    current = json.loads(CONTRACT_PATH.read_text(encoding='utf-8'))
    base = current.get('operations', {}).get('history_list', {}).get('request', {})
    templates = []
    for capture, share_id in zip(captures, share_ids):
        request = capture['request']
        if (request.get('method') != 'POST' or request.get('origin') != ORIGIN
                or request.get('path') != BATCH_PATH or request.get('queryKeys') != base.get('queryKeys')
                or request.get('bodyFieldNames') != base.get('bodyFieldNames')
                or request.get('contentType', '').lower() != str(base.get('contentType', '')).lower()):
            raise SafeFailure('PUBLIC_SHARE_CONTRACT_ENVELOPE_MISMATCH')
        template = dynamic_template(capture['args'], share_id)
        if count_exact(template, '{{shareId}}') != 1:
            raise SafeFailure('PUBLIC_SHARE_ARGS_TEMPLATE_INVALID')
        templates.append(template)
        response = capture['response']
        if (response.get('httpStatus') != 200 or response.get('contentType') != 'application/json'
                or response.get('rpcIdPresent') is not True or response.get('batchexecutePrefix') is not True):
            raise SafeFailure('PUBLIC_SHARE_UI_RESPONSE_UNPAIRED')
    if templates[0] != templates[1]:
        raise SafeFailure('PUBLIC_SHARE_ARGS_TEMPLATES_DISAGREE')
    first = captures[0]
    operation = {
        'observation': {'request': True, 'requestResponse': True},
        'effect': 'read',
        'request': {
            **first['request'],
            'rpcId': PUBLIC_READ_RPC,
            'rpcArgsTemplate': templates[0],
            'sharePathFamily': '/share/{id}',
        },
        'response': {
            'contentType': 'application/json',
            'framing': 'batchexecute',
            'selectorMode': 'rpc_id',
            'rpcId': PUBLIC_READ_RPC,
            'frameLengthUnit': 'utf16_code_units',
            'frameLengthOverheadUnits': 2,
        },
    }
    old = current.get('operations', {}).get('share_public_read')
    if old is not None and old.get('request', {}).get('rpcId') != PUBLIC_READ_RPC:
        raise SafeFailure('PUBLIC_SHARE_CONTRACT_CONCURRENT_CHANGE')
    if old != operation:
        current.setdefault('operations', {})['share_public_read'] = operation
        current['observedAt'] = datetime.now(timezone.utc).isoformat()
        temp = CONTRACT_PATH.with_name(CONTRACT_PATH.name + f'.share-public-read-{os.getpid()}.pending')
        descriptor = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        try:
            with os.fdopen(descriptor, 'w', encoding='utf-8') as stream:
                json.dump(current, stream, ensure_ascii=False, indent=2)
                stream.write('\n')
            os.replace(temp, CONTRACT_PATH)
        except Exception:
            try:
                temp.unlink(missing_ok=True)
            except Exception:
                pass
            raise


def guard_read_requests(page, allowed_ids, on_public_request=None, counts=None, capture_rpc_id=PUBLIC_READ_RPC):
    counts = counts if counts is not None else {'blocked': 0, 'parseFailures': 0}

    def guard(route):
        try:
            request = route.request
            if request.method.upper() in {'GET', 'HEAD', 'OPTIONS'}:
                route.continue_()
                return
            parsed = urllib.parse.urlsplit(request.url)
            ids = urllib.parse.parse_qs(parsed.query, keep_blank_values=True).get('rpcids', [])
            if parsed.hostname == 'gemini.google.com' and parsed.path == BATCH_PATH and len(ids) == 1:
                if ids[0] in allowed_ids:
                    if ids[0] == capture_rpc_id and on_public_request:
                        on_public_request(request)
                    route.continue_()
                    return
        except Exception:
            counts['parseFailures'] += 1
        counts['blocked'] += 1
        fail_closed(route)

    page.route('**/*', guard)
    return guard


def capture_task_detail_headers(page, contract, route_id):
    operation = contract.get('operations', {}).get('history_read', {})
    expected = operation.get('request', {})
    if not re.fullmatch(r'[0-9a-f]{16}', route_id):
        raise SafeFailure('TASK_DETAIL_ROUTE_ID_INVALID')
    target_conversation_id = 'c_' + route_id
    state = {'request': None, 'response': None, 'duplicate': False, 'parseFailure': False}
    counts = {'blocked': 0, 'parseFailures': 0}

    def capture_request(request):
        if state['request'] is not None:
            state['duplicate'] = True
            return
        rpc_id, decoded = request_rpc(request)
        if rpc_id != 'hNvQHb' or decoded is None:
            raise SafeFailure('TASK_DETAIL_REQUEST_PARSE_FAILED')
        parsed = decoded['parsed']
        query_keys = [name for name, _ in urllib.parse.parse_qsl(parsed.query, keep_blank_values=True)]
        body_fields = [name for name, _ in decoded['formPairs']]
        call = decoded['call']
        request_headers = {str(name).lower(): str(value) for name, value in request.headers.items()}
        api_ids = []
        pending = [decoded['args']]
        while pending and len(api_ids) < 4:
            value = pending.pop()
            if isinstance(value, str):
                if re.fullmatch(r'c_[0-9a-f]{16}', value):
                    api_ids.append(value)
                trimmed = value.strip()
                if trimmed.startswith(('[', '{')) and len(trimmed) <= 1024 * 1024:
                    try:
                        pending.append(json.loads(trimmed))
                    except Exception:
                        pass
            elif isinstance(value, list):
                pending.extend(value)
            elif isinstance(value, dict):
                pending.extend(value.values())
        if len(api_ids) != 1 or api_ids[0] != target_conversation_id:
            raise SafeFailure('TASK_DETAIL_REQUEST_ROUTE_BINDING_FAILED')
        if (request.method.upper() != 'POST' or parsed.scheme != 'https'
                or parsed.hostname != 'gemini.google.com' or parsed.path != BATCH_PATH
                or query_keys != expected.get('queryKeys') or body_fields != expected.get('bodyFieldNames')
                or call[2:] != [None, 'generic'] or count_exact(decoded['args'], target_conversation_id) != 1):
            raise SafeFailure('TASK_DETAIL_REQUEST_SHAPE_MISMATCH')
        allowed = {str(name).lower() for name in expected.get('headerNames', [])}
        safe_headers = {name: value for name, value in request_headers.items()
                        if name in allowed and name not in FORBIDDEN_HEADERS}
        if 'content-type' not in safe_headers or 'referer' not in safe_headers:
            raise SafeFailure('TASK_DETAIL_REQUEST_HEADERS_INCOMPLETE')
        state['request'] = {
            'requestObject': request,
            'headers': safe_headers,
            'metadata': {
                'rpcId': 'hNvQHb',
                'method': request.method.upper(),
                'path': parsed.path,
                'queryKeys': query_keys,
                'formFieldNames': body_fields,
                'targetConversationIdMatched': True,
                'headerNames': sorted(request_headers),
            },
        }

    def on_response(response):
        if state['request'] is None or response.request is not state['request']['requestObject']:
            return
        try:
            body = bytearray(response.body())
            state['response'] = {
                'httpStatus': response.status,
                'contentType': response.headers.get('content-type', '').split(';', 1)[0].strip().lower(),
                'responseBytes': len(body),
                'responseSha256': hashlib.sha256(body).hexdigest(),
                'rpcIdPresent': b'hNvQHb' in body,
                'batchexecutePrefix': body.startswith(b")]}'"),
            }
            for index in range(len(body)):
                body[index] = 0
        except Exception:
            state['responseFailure'] = True

    def on_detail_request(request):
        try:
            capture_request(request)
        except Exception:
            state['parseFailure'] = True
            raise

    page.on('response', on_response)
    guard = guard_read_requests(page, {'MaZiqc', 'hNvQHb'}, on_detail_request, counts, capture_rpc_id='hNvQHb')
    try:
        page.goto(f'{ORIGIN}/app/{route_id}', wait_until='domcontentloaded', timeout=30000)
        page.wait_for_function("() => document.body && document.body.innerText.includes('PROTOCOL42')", timeout=15000)
        page.wait_for_timeout(1000)
        body = page.locator('body').inner_text(timeout=5000)
        if state.get('parseFailure'):
            raise SafeFailure('TASK_DETAIL_UI_REQUEST_PARSE_FAILED')
        if state.get('duplicate'):
            raise SafeFailure('TASK_DETAIL_UI_REQUEST_DUPLICATED')
        if state.get('request') is None:
            raise SafeFailure('TASK_DETAIL_UI_REQUEST_NOT_OBSERVED')
        if state.get('responseFailure') or state.get('response') is None:
            raise SafeFailure('TASK_DETAIL_UI_RESPONSE_NOT_OBSERVED')
        if (state['response'].get('httpStatus') != 200
                or state['response'].get('contentType') != 'application/json'
                or state['response'].get('rpcIdPresent') is not True
                or state['response'].get('batchexecutePrefix') is not True):
            raise SafeFailure('TASK_DETAIL_UI_RESPONSE_UNVERIFIED')
        if TASK_MARKER not in body:
            raise SafeFailure('TASK_DETAIL_UI_TASK_MARKER_MISSING')
        return state['request']['headers'], state['request']['metadata'], state['response'], counts
    finally:
        page.unroute('**/*', guard)
        page.remove_listener('response', on_response)
        page.wait_for_timeout(300)


def restore_task_page(owner, page, original_url=None):
    counts = {'blocked': 0, 'parseFailures': 0}
    allowed = {'MaZiqc', 'hNvQHb', PUBLIC_LIST_RPC, 'ESY5D', 'otAQ7b', 'unqWSc'}
    guard = guard_read_requests(page, allowed, counts=counts)
    try:
        parsed = urllib.parse.urlsplit(page.url)
        body = page.locator('body').inner_text(timeout=3000)
        def task_visible():
            try:
                current = urllib.parse.urlsplit(page.url)
                text = page.locator('body').inner_text(timeout=3000)
                return (current.hostname == 'gemini.google.com' and '/app/' in current.path
                        and TASK_TITLE in text and TASK_MARKER in text)
            except Exception:
                return False

        if not task_visible():
            original = urllib.parse.urlsplit(original_url) if isinstance(original_url, str) else None
            original_is_task = bool(original and original.scheme == 'https'
                                    and original.hostname == 'gemini.google.com'
                                    and re.fullmatch(r'/app/[0-9a-f]{16}', original.path)
                                    and not original.query and not original.fragment)
            if original_is_task:
                try:
                    page.goto(original_url, wait_until='domcontentloaded', timeout=30000)
                    page.wait_for_timeout(1500)
                except Exception:
                    pass
            if not task_visible():
                try:
                    current = urllib.parse.urlsplit(page.url)
                    if current.path != '/app':
                        page.goto(ORIGIN + '/app', wait_until='domcontentloaded', timeout=30000)
                    page.wait_for_function("() => document.body && document.body.innerText.includes('Codex API verified text 20261006')", timeout=15000)
                except Exception:
                    pass
            if not task_visible():
                try:
                    page.wait_for_timeout(1500)
                except Exception:
                    pass
            if task_visible():
                return True, counts
            locator = page.get_by_text(TASK_TITLE, exact=True)
            if locator.count() < 1:
                return False, counts
            try:
                locator.first.click(timeout=10000)
                page.wait_for_function("() => document.body && document.body.innerText.includes('PROTOCOL42')", timeout=15000)
            except Exception:
                pass
        if not task_visible():
            page.wait_for_timeout(1500)
        return task_visible(), counts
    except Exception:
        return False, counts
    finally:
        page.unroute('**/*', guard)
        page.wait_for_timeout(300)


def restore_app_root(owner, page):
    counts = {'blocked': 0, 'parseFailures': 0}
    allowed = {'MaZiqc', 'hNvQHb', PUBLIC_LIST_RPC, 'ESY5D', 'otAQ7b', 'unqWSc'}
    guard = guard_read_requests(page, allowed, counts=counts)
    try:
        page.goto(ORIGIN + '/app', wait_until='domcontentloaded', timeout=30000)
        page.wait_for_timeout(1500)
        current = urllib.parse.urlsplit(page.url)
        return (current.hostname == 'gemini.google.com' and current.path == '/app'
                and page.evaluate('() => window.name') == PAGE_ROLE), counts
    except Exception:
        return False, counts
    finally:
        page.unroute('**/*', guard)
        page.wait_for_timeout(300)


def open_public_links(page, list_pair, base_request):
    counts = {'blocked': 0, 'parseFailures': 0}

    def capture_list_request(request):
        if list_pair['request'] is not None:
            list_pair['duplicate'] = True
            return
        try:
            rpc_id, decoded = request_rpc(request)
            parsed = urllib.parse.urlsplit(request.url)
            query_keys = [name for name, _ in urllib.parse.parse_qsl(parsed.query, keep_blank_values=True)]
            body_fields = [name for name, _ in decoded['formPairs']] if decoded else []
            if (rpc_id != PUBLIC_LIST_RPC or not decoded or decoded['args'] != []
                    or query_keys != base_request.get('queryKeys')
                    or body_fields != base_request.get('bodyFieldNames')):
                list_pair['parseFailure'] = True
                return
            list_pair['request'] = request
            list_pair['metadata'] = {
                'rpcId': PUBLIC_LIST_RPC,
                'method': request.method.upper(),
                'path': parsed.path,
                'queryKeys': query_keys,
                'formFieldNames': body_fields,
            }
        except Exception:
            list_pair['parseFailure'] = True

    def on_response(response):
        if response.request is not list_pair.get('request'):
            return
        try:
            body = bytearray(response.body())
            list_pair['response'] = {
                'httpStatus': response.status,
                'contentType': response.headers.get('content-type', '').split(';', 1)[0].strip().lower(),
                'responseBytes': len(body),
                'responseSha256': hashlib.sha256(body).hexdigest(),
                'rpcIdPresent': PUBLIC_LIST_RPC.encode() in body,
            }
            for index in range(len(body)):
                body[index] = 0
        except Exception:
            list_pair['responseFailure'] = True

    page.on('response', on_response)
    guard = guard_read_requests(page, {PUBLIC_LIST_RPC}, capture_list_request, counts)
    try:
        body = page.locator('body').inner_text(timeout=3000)
        surface_visible = (page.get_by_role('button', name='모든 링크 삭제', exact=True).count() == 1
                           and ('Your public links' in body or '내 공개 링크' in body))
        if not surface_visible:
            settings = page.get_by_role('button', name='설정', exact=True)
            if settings.count() != 1:
                raise SafeFailure('SETTINGS_MENU_NOT_UNIQUE')
            if settings.get_attribute('aria-expanded') != 'true':
                settings.click(timeout=10000)
            item = page.get_by_role('menuitem', name='내 공개 링크', exact=True)
            if item.count() != 1:
                raise SafeFailure('PUBLIC_LINKS_MENU_NOT_UNIQUE')
            item.click(timeout=10000, force=True)
            page.wait_for_timeout(1500)
        if page.get_by_role('button', name='모든 링크 삭제', exact=True).count() != 1:
            raise SafeFailure('OWNER_PUBLIC_LINKS_SURFACE_NOT_VISIBLE')
        titles = page.get_by_text(TASK_TITLE, exact=True)
        if titles.count() != 3:
            raise SafeFailure('TARGET_PUBLIC_LINK_ROWS_NOT_TWO')
        rows = []
        for index in (1, 2):
            row = titles.nth(index).locator('xpath=..')
            if row.get_by_role('button').count() != 2:
                raise SafeFailure('TARGET_PUBLIC_LINK_ACTIONS_NOT_TWO')
            rows.append(row)
        page.wait_for_timeout(400)
        return rows, counts
    finally:
        page.unroute('**/*', guard)
        page.remove_listener('response', on_response)
        page.wait_for_timeout(300)


def capture_copy_hook(page):
    return page.evaluate("""() => {
      const clipboard = navigator.clipboard;
      if (!clipboard || typeof clipboard.writeText !== 'function') return false;
      const original = clipboard.writeText;
      window.__shareCopyValues = [];
      try {
        Object.defineProperty(clipboard, 'writeText', { configurable: true, value: async value => {
          window.__shareCopyValues.push(String(value)); return Promise.resolve();
        }});
        window.__shareCopyOriginal = original;
        return true;
      } catch { return false; }
    }""") is True


def restore_copy_hook(page):
    page.evaluate("""() => {
      const clipboard = navigator.clipboard;
      if (clipboard && window.__shareCopyOriginal) {
        Object.defineProperty(clipboard, 'writeText', { configurable: true, value: window.__shareCopyOriginal });
      }
      if (Array.isArray(window.__shareCopyValues)) window.__shareCopyValues.fill('');
      delete window.__shareCopyValues; delete window.__shareCopyOriginal;
    }""")


def copy_task_row_links(page, rows):
    raw_urls = []
    guard_counts = {'blocked': 0, 'parseFailures': 0}
    guard = guard_read_requests(page, {PUBLIC_LIST_RPC}, counts=guard_counts)
    try:
        for row_index in (1, 2):
            if not capture_copy_hook(page):
                raise SafeFailure('COPY_LINK_CAPTURE_HOOK_UNAVAILABLE')
            row = page.get_by_text(TASK_TITLE, exact=True).nth(row_index).locator('xpath=..')
            actions = row.get_by_role('button')
            if actions.count() != 2:
                raise SafeFailure('TARGET_PUBLIC_LINK_ACTIONS_CHANGED')
            before = page.evaluate('() => Array.isArray(window.__shareCopyValues) ? window.__shareCopyValues.length : 0')
            actions.nth(0).click(timeout=10000)
            page.wait_for_timeout(250)
            after = page.evaluate('() => Array.isArray(window.__shareCopyValues) ? window.__shareCopyValues.length : 0')
            if after == before and page.get_by_role('dialog').count():
                page.keyboard.press('Escape')
                page.wait_for_timeout(150)
                row = page.get_by_text(TASK_TITLE, exact=True).nth(row_index).locator('xpath=..')
                row.get_by_role('button').nth(1).click(timeout=10000)
                page.wait_for_timeout(250)
                after = page.evaluate('() => Array.isArray(window.__shareCopyValues) ? window.__shareCopyValues.length : 0')
            if after != before + 1:
                raise SafeFailure('TARGET_PUBLIC_LINK_COPY_NOT_CAPTURED')
            raw = page.evaluate('() => window.__shareCopyValues.pop() || ""')
            share_id = url_share_id(raw)
            raw_urls.append((raw, share_id))
            raw = ''
            restore_copy_hook(page)
        if len({item[1] for item in raw_urls}) != 2:
            raise SafeFailure('TARGET_PUBLIC_LINK_IDS_NOT_DISTINCT')
        return raw_urls, guard_counts
    except Exception:
        for raw, _ in raw_urls:
            raw = ''
        raise
    finally:
        try:
            restore_copy_hook(page)
        except Exception:
            pass
        if page.get_by_role('dialog').count():
            page.keyboard.press('Escape')
            page.wait_for_timeout(100)
        page.unroute('**/*', guard)
        page.wait_for_timeout(300)


def capture_task_route_suffix(session, expected_owner):
    if not pathlib.Path(NODE).is_file() or not NODE_ROUTE_HELPER.is_file():
        raise SafeFailure('NODE_TASK_ROUTE_CLIENT_MISSING')
    envelope = {'session': session, 'expectedOwner': expected_owner, 'taskTitle': TASK_TITLE}
    payload = json.dumps(envelope, separators=(',', ':')).encode('utf-8')
    read_fd, write_fd = os.pipe()
    env = dict(os.environ)
    env['GEMINI_TASK_ROUTE_ID_FD'] = str(write_fd)
    child = subprocess.Popen([NODE, str(NODE_ROUTE_HELPER)], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                             stderr=subprocess.PIPE, cwd=REPO, env=env, pass_fds=(write_fd,), close_fds=True)
    os.close(write_fd)
    try:
        stdout_bytes, stderr_bytes = child.communicate(payload, timeout=120)
        route_bytes = bytearray()
        while True:
            chunk = os.read(read_fd, 128)
            if not chunk:
                break
            route_bytes.extend(chunk)
            if len(route_bytes) > 128:
                raise SafeFailure('TASK_ROUTE_HANDOFF_TOO_LARGE')
    except Exception as exc:
        child.kill()
        child.wait(timeout=10)
        raise SafeFailure('TASK_ROUTE_CAPTURE_FAILED') from exc
    finally:
        payload = b''
        envelope['expectedOwner'] = ''
        envelope['taskTitle'] = ''
        envelope['session'] = None
        os.close(read_fd)
    if child.returncode != 0 or not stdout_bytes:
        code = 'TASK_ROUTE_CAPTURE_FAILED'
        try:
            candidate = stderr_bytes.decode('utf-8').strip()
            if re.fullmatch(r'[A-Z][A-Z0-9_]{1,63}', candidate):
                code = candidate
        except Exception:
            pass
        stdout_bytes = b''
        stderr_bytes = b''
        for index in range(len(route_bytes)):
            route_bytes[index] = 0
        raise SafeFailure(code)
    try:
        route_id = route_bytes.decode('ascii').strip()
    except Exception as exc:
        raise SafeFailure('TASK_ROUTE_HANDOFF_INVALID') from exc
    finally:
        for index in range(len(route_bytes)):
            route_bytes[index] = 0
        stdout_bytes = b''
        stderr_bytes = b''
    if not re.fullmatch(r'[0-9a-f]{16}', route_id):
        raise SafeFailure('TASK_ROUTE_HANDOFF_INVALID')
    return route_id


def capture_public_route(page, share_url, share_id, base_request):
    state = {'request': None, 'response': None, 'duplicate': False, 'parseFailure': False}
    counts = {'blocked': 0, 'parseFailures': 0}

    def capture_request(request):
        if state['request'] is not None:
            state['duplicate'] = True
            return
        state['request'] = captured_request(request, base_request, share_id)
        state['request']['requestObject'] = request

    def on_response(response):
        if state['request'] is None or response.request is not state['request'].get('requestObject'):
            return
        try:
            body = bytearray(response.body())
            state['response'] = {
                'httpStatus': response.status,
                'contentType': response.headers.get('content-type', '').split(';', 1)[0].strip().lower(),
                'responseBytes': len(body),
                'responseSha256': hashlib.sha256(body).hexdigest(),
                'rpcIdPresent': PUBLIC_READ_RPC.encode() in body,
                'batchexecutePrefix': body.startswith(b")]}'"),
            }
            for index in range(len(body)):
                body[index] = 0
        except Exception:
            state['responseFailure'] = True

    def on_public_request(request):
        try:
            capture_request(request)
        except Exception:
            state['parseFailure'] = True
            raise

    page.on('response', on_response)
    guard = guard_read_requests(page, {PUBLIC_READ_RPC}, on_public_request, counts)
    try:
        page.goto(share_url, wait_until='domcontentloaded', timeout=30000)
        page.wait_for_timeout(2500)
        body_text = page.locator('body').inner_text(timeout=5000)
        if (state.get('parseFailure') or state.get('responseFailure') or state.get('duplicate')
                or state.get('request') is None or state.get('response') is None
                or state['response'].get('httpStatus') != 200
                or state['response'].get('contentType') != 'application/json'
                or state['response'].get('rpcIdPresent') is not True
                or state['response'].get('batchexecutePrefix') is not True):
            raise SafeFailure('PUBLIC_SHARE_UI_READ_PAIR_MISSING')
        state['visibleContent'] = {
            'taskTitleVisible': TASK_TITLE in body_text,
            'taskMarkerVisible': TASK_MARKER in body_text,
        }
        request_capture = state['request']
        request_capture.pop('requestObject', None)
        return {
            'rpcId': request_capture['rpcId'],
            'args': request_capture['args'],
            'requestHeaderValues': request_capture['requestHeaderValues'],
            'request': request_capture['request'],
            'metadata': request_capture['metadata'],
            'response': state['response'],
            'visibleContent': state['visibleContent'],
        }, counts
    except Exception:
        if state.get('request'):
            state['request'].pop('requestObject', None)
        raise
    finally:
        page.unroute('**/*', guard)
        page.remove_listener('response', on_response)
        page.wait_for_timeout(300)


def capture_revoke_request(page, row_index, share_id, base_request):
    state = {'requests': [], 'armed': False, 'parseFailure': False, 'abortFailure': False, 'nonTargetMutationCount': 0}
    counts = {'blocked': 0, 'parseFailures': 0}
    allowed_headers = {str(name).lower() for name in base_request.get('headerNames', [])}
    known_reads = {'MaZiqc', 'hNvQHb', PUBLIC_LIST_RPC, 'ESY5D', 'otAQ7b', 'unqWSc', PUBLIC_READ_RPC}

    def parse_delete_request(request):
        parsed = urllib.parse.urlsplit(request.url)
        query_keys = [name for name, _ in urllib.parse.parse_qsl(parsed.query, keep_blank_values=True)]
        headers = {str(name).lower(): str(value) for name, value in request.headers.items()}
        content_type = headers.get('content-type', '').lower()
        if not content_type.startswith('application/x-www-form-urlencoded'):
            raise SafeFailure('SHARE_REVOKE_CONTENT_TYPE_UNSUPPORTED')
        body_pairs = urllib.parse.parse_qsl(request.post_data or '', keep_blank_values=True)
        body_fields = [name for name, _ in body_pairs]
        form = dict(body_pairs)
        outer = json.loads(form['f.req'])
        call = outer[0][0]
        args = json.loads(call[1])
        rpc_id = urllib.parse.parse_qs(parsed.query, keep_blank_values=True).get('rpcids', [])
        if (len(rpc_id) != 1 or call[0] != rpc_id[0] or not re.fullmatch(r'[A-Za-z0-9_-]{3,24}', call[0])
                or request.method.upper() != 'POST' or parsed.scheme != 'https'
                or parsed.hostname != 'gemini.google.com' or parsed.path != BATCH_PATH
                or query_keys != base_request.get('queryKeys') or body_fields != base_request.get('bodyFieldNames')
                or not isinstance(args, list) or call[2:] != [None, 'generic']):
            raise SafeFailure('SHARE_REVOKE_REQUEST_SHAPE_MISMATCH')
        if count_exact(args, share_id) != 1:
            state['nonTargetMutationCount'] += 1
            return None
        header_names = sorted(name for name in headers if name in allowed_headers and name not in FORBIDDEN_HEADERS)
        header_values = {name: headers[name] for name in header_names}
        if content_type != str(base_request.get('contentType', '')).lower() or 'content-type' not in header_values:
            raise SafeFailure('SHARE_REVOKE_REQUEST_HEADERS_INVALID')
        return {
            'rpcId': call[0],
            'args': args,
            'rpcCallTail': call[2:],
            'requestHeaderValues': header_values,
            'request': {
                'method': request.method.upper(),
                'origin': f'{parsed.scheme}://{parsed.netloc}',
                'path': parsed.path,
                'queryKeys': query_keys,
                'headerNames': header_names,
                'contentType': content_type,
                'bodyFieldNames': body_fields,
            },
            'metadata': {
                'rpcId': call[0], 'method': request.method.upper(), 'path': parsed.path,
                'queryKeys': query_keys, 'headerNames': header_names,
                'formFieldNames': body_fields, 'contentType': content_type,
                'bodyBytes': len((request.post_data or '').encode('utf-8')),
                'argsShape': shape(args), 'shareIdOccurrenceCount': 1,
                'rpcCallTailShape': shape(call[2:]),
            },
        }

    def guard(route):
        try:
            request = route.request
            if request.method.upper() in {'GET', 'HEAD', 'OPTIONS'}:
                route.continue_()
                return
            parsed = urllib.parse.urlsplit(request.url)
            ids = urllib.parse.parse_qs(parsed.query, keep_blank_values=True).get('rpcids', [])
            if parsed.hostname == 'gemini.google.com' and parsed.path == BATCH_PATH and len(ids) == 1:
                if ids[0] in known_reads:
                    route.continue_()
                    return
                if state['armed']:
                    capture = parse_delete_request(request)
                    if capture is not None:
                        state['requests'].append(capture)
                    counts['blocked'] += 1
                    route.abort('aborted')
                    return
        except SafeFailure as exc:
            state['parseFailure'] = True
            state['parseFailureCode'] = exc.code
            counts['parseFailures'] += 1
        except Exception:
            state['parseFailure'] = True
            state['parseFailureCode'] = 'UNCLASSIFIED'
            counts['parseFailures'] += 1
        counts['blocked'] += 1
        try:
            route.abort('aborted')
        except Exception:
            state['abortFailure'] = True

    page.route('**/*', guard)
    try:
        titles = page.get_by_text(TASK_TITLE, exact=True)
        if titles.count() != 3:
            raise SafeFailure('TARGET_PUBLIC_LINK_ROWS_NOT_TWO')
        row = titles.nth(row_index).locator('xpath=..')
        actions = row.get_by_role('button')
        if actions.count() != 2:
            raise SafeFailure('TARGET_PUBLIC_LINK_ACTIONS_NOT_TWO')
        state['armed'] = True
        actions.nth(1).click(timeout=10000)
        page.wait_for_timeout(250)
        dialog = page.get_by_role('dialog')
        confirmation_button = None
        if dialog.count() == 1 and not state['requests']:
            candidates = []
            for button in dialog.get_by_role('button').all():
                try:
                    name = (button.get_attribute('aria-label') or button.get_attribute('title')
                            or button.inner_text(timeout=200)).strip()
                    if re.search(r'delete|삭제', name, re.I):
                        candidates.append(button)
                except Exception:
                    pass
            if len(candidates) != 1:
                raise SafeFailure('SHARE_REVOKE_CONFIRMATION_CONTROL_NOT_UNIQUE')
            confirmation_button = candidates[0]
            confirmation_button.click(timeout=10000)
            page.wait_for_timeout(500)
        if state['parseFailure']:
            raise SafeFailure('SHARE_REVOKE_REQUEST_PARSE_FAILED')
        if state['abortFailure']:
            raise SafeFailure('SHARE_REVOKE_REQUEST_ABORT_UNACKNOWLEDGED')
        if len(state['requests']) != 1:
            raise SafeFailure(f"SHARE_REVOKE_CAPTURE_COUNT_{len(state['requests'])}_BLOCKED_{counts['blocked']}")
        capture = state['requests'][0]
        if count_exact(capture['args'], share_id) != 1:
            raise SafeFailure('SHARE_REVOKE_TARGET_NOT_BOUND')
        if page.get_by_text(TASK_TITLE, exact=True).count() != 3:
            raise SafeFailure('SHARE_REVOKE_ABORT_DID_NOT_PRESERVE_ROW')
        return capture, {
            'deleteConfirmationControlVisible': confirmation_button is not None,
            'browserMutationReachedServer': False,
            'browserAbortAcknowledged': True,
            'blockedNonReadRequestCount': counts['blocked'],
            'guardParseFailureCount': counts['parseFailures'],
            'nonTargetMutationCount': state['nonTargetMutationCount'],
        }
    finally:
        if page.get_by_role('dialog').count():
            page.keyboard.press('Escape')
            page.wait_for_timeout(100)
        page.unroute('**/*', guard)
        page.wait_for_timeout(300)


def install_revoke_contract(captures):
    if len(captures) != 2:
        raise SafeFailure('SHARE_REVOKE_CAPTURE_COUNT_INVALID')
    current = json.loads(CONTRACT_PATH.read_text(encoding='utf-8'))
    base = current.get('operations', {}).get('history_list', {}).get('request', {})
    first = captures[0]
    rpc_id = first['rpcId']
    for capture in captures:
        request = capture['request']
        if (capture.get('rpcId') != rpc_id or request.get('method') != 'POST'
                or request.get('origin') != ORIGIN or request.get('path') != BATCH_PATH
                or request.get('queryKeys') != base.get('queryKeys')
                or request.get('bodyFieldNames') != base.get('bodyFieldNames')
                or request.get('contentType', '').lower() != str(base.get('contentType', '')).lower()
                or capture.get('rpcCallTail') != [None, 'generic']):
            raise SafeFailure('SHARE_REVOKE_CONTRACT_SHAPE_MISMATCH')
    operation = {
        'observation': {'request': True, 'requestResponse': False},
        'effect': 'mutation',
        'retryPolicy': 'never',
        'request': {
            **first['request'],
            'rpcId': rpc_id,
            'rpcCallTail': first['rpcCallTail'],
        },
    }
    old = current.get('operations', {}).get('share_revoke')
    if old is not None and (old.get('request', {}).get('rpcId') != rpc_id
                            or old.get('request', {}).get('path') != BATCH_PATH):
        raise SafeFailure('SHARE_REVOKE_CONTRACT_CONCURRENT_CHANGE')
    if old != operation:
        current.setdefault('operations', {})['share_revoke'] = operation
        current['observedAt'] = datetime.now(timezone.utc).isoformat()
        temp = CONTRACT_PATH.with_name(CONTRACT_PATH.name + f'.share-revoke-{os.getpid()}.pending')
        descriptor = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        try:
            with os.fdopen(descriptor, 'w', encoding='utf-8') as stream:
                json.dump(current, stream, ensure_ascii=False, indent=2)
                stream.write('\n')
            os.replace(temp, CONTRACT_PATH)
        except Exception:
            try:
                temp.unlink(missing_ok=True)
            except Exception:
                pass
            raise


def call_direct_client(session, expected_owner, share_ids, header_values, visible_route_id):
    if not pathlib.Path(NODE).is_file() or not NODE_HELPER.is_file():
        raise SafeFailure('NODE_SHARE_PUBLIC_READ_CLIENT_MISSING')
    envelope = {
        'session': json.loads(json.dumps(session)),
        'expectedOwner': expected_owner,
        'shareIds': list(share_ids),
        'requestHeaders': [dict(headers) for headers in header_values],
        'taskTitle': TASK_TITLE,
        'taskMarker': TASK_MARKER,
        'historyRouteSuffix': visible_route_id,
    }
    payload = json.dumps(envelope, separators=(',', ':')).encode('utf-8')
    child = subprocess.Popen([NODE, str(NODE_HELPER)], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                             stderr=subprocess.PIPE, cwd=REPO, close_fds=True)
    try:
        stdout_bytes, stderr_bytes = child.communicate(payload, timeout=180)
    except Exception as exc:
        child.kill()
        child.wait(timeout=10)
        raise SafeFailure('DIRECT_SHARE_READ_CHILD_FAILED') from exc
    finally:
        payload = b''
        wipe(envelope)
    if child.returncode != 0 or not stdout_bytes:
        code = 'DIRECT_SHARE_READ_CHILD_FAILED'
        try:
            candidate = stderr_bytes.decode('utf-8').strip()
            if re.fullmatch(r'[A-Z][A-Z0-9_]{1,63}', candidate):
                code = candidate
        except Exception:
            pass
        stdout_bytes = b''
        stderr_bytes = b''
        raise SafeFailure(code)
    try:
        result = json.loads(stdout_bytes.decode('utf-8'))
    except Exception as exc:
        stdout_bytes = b''
        stderr_bytes = b''
        raise SafeFailure('DIRECT_SHARE_READ_OUTPUT_INVALID') from exc
    stdout_bytes = b''
    stderr_bytes = b''
    return result


def call_direct_revoke(session, expected_owner, title, share_ids, captures):
    if not pathlib.Path(NODE).is_file() or not NODE_REVOKE_HELPER.is_file():
        raise SafeFailure('NODE_SHARE_REVOKE_CLIENT_MISSING')
    if len(share_ids) != 2 or len(captures) != 2:
        raise SafeFailure('SHARE_REVOKE_INPUT_COUNT_INVALID')
    shares = []
    for index, (share_id, capture) in enumerate(zip(share_ids, captures), start=1):
        shares.append({
            'shareId': share_id,
            'requestCapture': json.loads(json.dumps(capture)),
            'args': json.loads(json.dumps(capture['args'])),
            'callerIntent': f'lifecycle:share:revoke:protocol42:20261006:{index}',
        })
    envelope = {
        'session': json.loads(json.dumps(session)),
        'expectedOwner': expected_owner,
        'targetConversationTitle': title,
        'shares': shares,
    }
    payload = json.dumps(envelope, separators=(',', ':')).encode('utf-8')
    child = subprocess.Popen([NODE, str(NODE_REVOKE_HELPER)], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                             stderr=subprocess.PIPE, cwd=REPO, close_fds=True)
    try:
        stdout_bytes, stderr_bytes = child.communicate(payload, timeout=180)
    except Exception as exc:
        child.kill()
        child.wait(timeout=10)
        raise SafeFailure('DIRECT_SHARE_REVOKE_CHILD_FAILED') from exc
    finally:
        payload = b''
        wipe(envelope)
    if child.returncode != 0 or not stdout_bytes:
        code = 'DIRECT_SHARE_REVOKE_CHILD_FAILED'
        try:
            candidate = stderr_bytes.decode('utf-8').strip()
            if re.fullmatch(r'[A-Z][A-Z0-9_]{1,63}', candidate):
                code = candidate
        except Exception:
            pass
        stdout_bytes = b''
        stderr_bytes = b''
        raise SafeFailure(code)
    try:
        result = json.loads(stdout_bytes.decode('utf-8'))
    except Exception as exc:
        stdout_bytes = b''
        stderr_bytes = b''
        raise SafeFailure('DIRECT_SHARE_REVOKE_OUTPUT_INVALID') from exc
    stdout_bytes = b''
    stderr_bytes = b''
    return result


def call_anonymous_share_check(session, share_urls, request_headers):
    if not pathlib.Path(NODE).is_file() or not NODE_ANONYMOUS_HELPER.is_file():
        raise SafeFailure('NODE_ANONYMOUS_SHARE_CHECK_MISSING')
    envelope = {
        'shareUrls': list(share_urls),
        'taskTitle': TASK_TITLE,
        'taskMarker': TASK_MARKER,
        'batchContext': json.loads(json.dumps(session['batchContext'])),
        'requestHeaders': [json.loads(json.dumps(headers)) for headers in request_headers],
    }
    payload = json.dumps(envelope, separators=(',', ':')).encode('utf-8')
    child = subprocess.Popen([NODE, str(NODE_ANONYMOUS_HELPER)], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                             stderr=subprocess.PIPE, cwd=REPO, close_fds=True)
    try:
        stdout_bytes, stderr_bytes = child.communicate(payload, timeout=120)
    except Exception as exc:
        child.kill()
        child.wait(timeout=10)
        raise SafeFailure('ANONYMOUS_SHARE_CHECK_FAILED') from exc
    finally:
        payload = b''
        wipe(envelope)
    if child.returncode != 0 or not stdout_bytes:
        code = 'ANONYMOUS_SHARE_CHECK_FAILED'
        try:
            candidate = stderr_bytes.decode('utf-8').strip()
            if re.fullmatch(r'[A-Z][A-Z0-9_]{1,63}', candidate):
                code = candidate
        except Exception:
            pass
        stdout_bytes = b''
        stderr_bytes = b''
        raise SafeFailure(code)
    try:
        result = json.loads(stdout_bytes.decode('utf-8'))
    except Exception as exc:
        stdout_bytes = b''
        stderr_bytes = b''
        raise SafeFailure('ANONYMOUS_SHARE_CHECK_OUTPUT_INVALID') from exc
    stdout_bytes = b''
    stderr_bytes = b''
    return result


def write_receipt(receipt):
    RECEIPT_PATH.parent.mkdir(parents=True, exist_ok=True)
    temp = RECEIPT_PATH.with_name(RECEIPT_PATH.name + f'.public-read-{os.getpid()}.pending')
    descriptor = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
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


def main():
    session = None
    expected_owner = ''
    raw_links = []
    share_ids = []
    captures = []
    try:
        owner = json.loads(OWNER_PATH.read_text(encoding='utf-8'))
        roles = json.loads(ROLE_PATH.read_text(encoding='utf-8'))
        api_helper = import_script('share_public_api_helper', REPO / 'scripts/run-linux-api.py')
        text_helper = import_script('share_public_owner_helper', REPO / 'scripts/run-linux-text-smoke.py')
        read_helper = import_script('share_public_list_helper', REPO / 'scripts/gemini-share-list-read-once.py')
        expected_hash, _ = text_helper.read_static_owner_hash()
        contract = json.loads(CONTRACT_PATH.read_text(encoding='utf-8'))
        base_request = contract['operations']['history_list']['request']

        role_registry = json.loads(ROLE_PATH.read_text(encoding='utf-8'))
        owner = json.loads(OWNER_PATH.read_text(encoding='utf-8'))
        session, expected_owner, _ = read_helper.capture_session(
            owner, role_registry, contract, api_helper, text_helper, expected_hash,
        )
        route_id = capture_task_route_suffix(session, expected_owner)
        session.setdefault('requestHeaders', {})['history_read'] = session.get('requestHeaders', {}).get('history_list', {})
        original_url = ORIGIN + '/app'

        list_pair = {'request': None, 'response': None, 'duplicate': False}
        with sync_playwright() as playwright:
            browser = playwright.chromium.connect_over_cdp(f"http://127.0.0.1:{owner['cdpPort']}")
            if len(browser.contexts) != 1:
                raise SafeFailure('OWNED_CONTEXT_COUNT_INVALID')
            context = browser.contexts[0]
            matches = [page for page in context.pages if page.evaluate('() => window.name') == PAGE_ROLE]
            if len(matches) != 1:
                raise SafeFailure('ROLE_PAGE_NOT_UNIQUE')
            page = matches[0]
            rows, list_guard_counts = open_public_links(page, list_pair, base_request)
            raw_links, copy_guard_counts = copy_task_row_links(page, rows)
            share_ids = [share_id for _, share_id in raw_links]
            captures = []
            header_values = []
            for raw_url, share_id in raw_links:
                capture, counts = capture_public_route(page, raw_url, share_id, base_request)
                captures.append(capture)
                header_values.append(capture['requestHeaderValues'])
            task_page_restored, restoration_counts = restore_app_root(owner, page)

        if not task_page_restored:
            raise SafeFailure('TASK_PAGE_RESTORE_AFTER_PUBLIC_READ_FAILED')
        # Persist only a tokenized args template and the captured non-sensitive request/response contract.
        install_contract(captures, share_ids)
        if not re.fullmatch(r'[0-9a-f]{16}', route_id):
            raise SafeFailure('TASK_ROUTE_SUFFIX_INVALID')
        direct = call_direct_client(session, expected_owner, share_ids, header_values, route_id)
        if (direct.get('ownerMatched') is not True or direct.get('anonymousOwnerAbsent') is not True
                or direct.get('taskConversationCount') != 1 or direct.get('taskConversationDetailBound') is not True
                or direct.get('taskRouteSuffixMatchesHistoryId') is not True
                or direct.get('taskMarkerInHistoryDetail') is not True or direct.get('ownerTaskRowCount') != 2
                or not isinstance(direct.get('shares'), list) or len(direct['shares']) != 2):
            raise SafeFailure('DIRECT_SHARE_CONTENT_BINDING_FAILED')
        if any(item.get('taskContentMatchesConversationDetail') is not True
               or item.get('taskMarkerPresent') is not True
               or item.get('ownerMatched') is not True
               or item.get('httpStatus') != 200 for item in direct['shares']):
            raise SafeFailure('PUBLIC_SHARE_NOT_BOUND_TO_TASK_CONTENT')

        revoke_list_pair = {'request': None, 'response': None, 'duplicate': False}
        revoke_captures = []
        revoke_capture_metadata = []
        with sync_playwright() as playwright:
            browser = playwright.chromium.connect_over_cdp(f"http://127.0.0.1:{owner['cdpPort']}")
            if len(browser.contexts) != 1:
                raise SafeFailure('OWNED_CONTEXT_COUNT_INVALID')
            context = browser.contexts[0]
            matches = [page for page in context.pages if page.evaluate('() => window.name') == PAGE_ROLE]
            if len(matches) != 1:
                raise SafeFailure('ROLE_PAGE_NOT_UNIQUE')
            page = matches[0]
            revoke_rows, revoke_list_guard_counts = open_public_links(page, revoke_list_pair, base_request)
            fresh_links, revoke_copy_guard_counts = copy_task_row_links(page, revoke_rows)
            fresh_ids = [share_id for _, share_id in fresh_links]
            if len(fresh_ids) != 2 or set(fresh_ids) != set(share_ids):
                raise SafeFailure('REVOKE_TARGETS_DIFFER_FROM_VERIFIED_PUBLIC_READS')
            for row_index, share_id in zip((1, 2), fresh_ids):
                capture, metadata = capture_revoke_request(page, row_index, share_id, base_request)
                revoke_captures.append(capture)
                revoke_capture_metadata.append(metadata)
            if revoke_captures[0]['rpcId'] != revoke_captures[1]['rpcId']:
                raise SafeFailure('SHARE_REVOKE_RPC_ID_MISMATCH')
            install_revoke_contract(revoke_captures)
            task_page_restored, restoration_counts = restore_app_root(owner, page)
        if not task_page_restored:
            raise SafeFailure('APP_ROOT_RESTORE_AFTER_REVOKE_CAPTURE_FAILED')

        direct_revoke = call_direct_revoke(session, expected_owner, TASK_TITLE, fresh_ids, revoke_captures)
        direct_revoke_verified = (direct_revoke.get('readbackVerified') is True
                                  and direct_revoke.get('directDispatchCount') == 2
                                  and direct_revoke.get('finalTotalShareCount') == 7
                                  and direct_revoke.get('finalTaskLinkCount') == 0
                                  and all(item.get('journalReconciled') is True for item in direct_revoke.get('results', [])))
        headers_by_id = {share_id: capture['requestHeaderValues']
                         for share_id, capture in zip(share_ids, captures)}
        anonymous_urls = [raw_url for raw_url, _ in fresh_links]
        anonymous_headers = [headers_by_id[share_id] for _, share_id in fresh_links]
        anonymous = call_anonymous_share_check(session, anonymous_urls, anonymous_headers)
        anonymous_verified = (anonymous.get('allCookiesOmitted') is True
                              and anonymous.get('allAuthorizationOmitted') is True
                              and anonymous.get('allAnonymousReadsRejected') is True)
        revoke_feature_verified = direct_revoke_verified and anonymous_verified

        ui_list_response = list_pair.get('response') or {}
        receipt = {
            'schema': 'gemini-public-shared-conversation-read-v1',
            'service': 'gemini-web',
            'feature': 'share',
            'operation': 'share_public_read',
            'outcome': 'verified' if revoke_feature_verified else 'partial',
            'verifiedAt': datetime.now(timezone.utc).isoformat(),
            'executionHost': 'linux_worker',
            'pageRole': PAGE_ROLE,
            'sourceMapping': {'sourceClass': 'anonymous_google_first_party_web_client', 'rpcId': PUBLIC_READ_RPC, 'operationName': 'GetSharedConversation'},
            'taskBinding': {
                'titleRowCount': 2,
                'historyTitleMatchedExactlyOnce': direct.get('taskConversationCount') == 1,
                'historyDetailConversationIdBound': direct.get('taskConversationDetailBound') is True,
                'taskApiRouteSuffixBound': direct.get('taskRouteSuffixMatchesHistoryId') is True,
                'historyResponseEchoesConversationId': direct.get('historyResponseEchoesConversationId') is True,
                'historyPromptMarkerPresent': direct.get('taskMarkerInHistoryDetail') is True,
                'historyTaskContentDigest': direct.get('historyTaskContentDigest'),
                'ownerListCount': direct.get('ownerShareCount'),
                'ownerRowsMatchedExactly': direct.get('ownerTaskRowCount') == 2,
                'rawConversationIdPersisted': False,
            },
            'ownerListUiPair': {
                'rpcId': PUBLIC_LIST_RPC,
                'capturedInThisRun': bool(list_pair.get('request') and list_pair.get('response')),
                'httpStatus': ui_list_response.get('httpStatus'),
                'contentType': ui_list_response.get('contentType'),
                'responseBytes': ui_list_response.get('responseBytes'),
                'responseSha256': ui_list_response.get('responseSha256'),
                'request': list_pair.get('metadata'),
                'currentUiTargetRowsVisible': 2,
            },
            'directTaskDetailReadback': {
                'rpcId': 'hNvQHb',
                'httpStatus': direct.get('historyDetailHttpStatus'),
                'responseBytes': direct.get('historyDetailResponseBytes'),
                'responseSha256': direct.get('historyDetailResponseSha256'),
                'rpcMatchCount': direct.get('historyDetailRpcMatchCount'),
                'conversationIdEchoMatched': direct.get('historyResponseEchoesConversationId') is True,
                'contentMarkerMatched': direct.get('taskMarkerInHistoryDetail') is True,
            },
            'normalUiCaptures': [
                {
                    'request': capture['metadata'],
                    'response': capture['response'],
                    'taskTitleVisible': capture['visibleContent']['taskTitleVisible'],
                    'taskMarkerVisible': capture['visibleContent']['taskMarkerVisible'],
                    'shareIdPersisted': False,
                    'shareUrlPersisted': False,
                    'rawRequestOrResponsePersisted': False,
                }
                for capture in captures
            ],
            'directReadbacks': direct['shares'],
            'revokeCapture': {
                'rpcId': revoke_captures[0]['rpcId'],
                'browserDispatchCount': 0,
                'browserMutationReachedServer': False,
                'capturedForTwoVerifiedRows': len(revoke_captures) == 2,
                'requestCaptures': [capture['metadata'] for capture in revoke_captures],
                'confirmations': revoke_capture_metadata,
                'shareIdsPersisted': False,
                'requestArgumentsPersisted': False,
                'directDispatchPending': False,
            },
            'directRevocations': direct_revoke,
            'anonymousReadback': anonymous,
            'revokeAndAnonymousVerification': {
                'directOwnerListRestoredToBaseline7': direct_revoke_verified,
                'targetRowsAbsentFromOwnerList': direct_revoke.get('finalTaskLinkCount') == 0,
                'bothPublicShareUrlsRejectedWithoutCookies': anonymous_verified,
            },
            'browserPageRestored': True,
            'readOnlyGuards': {
                'listBlockedNonReadRequestCount': list_guard_counts['blocked'],
                'listGuardParseFailureCount': list_guard_counts['parseFailures'],
                'copyBlockedNonReadRequestCount': copy_guard_counts['blocked'],
                'copyGuardParseFailureCount': copy_guard_counts['parseFailures'],
                'revokeListBlockedNonReadRequestCount': revoke_list_guard_counts['blocked'],
                'revokeListGuardParseFailureCount': revoke_list_guard_counts['parseFailures'],
                'revokeCopyBlockedNonReadRequestCount': revoke_copy_guard_counts['blocked'],
                'revokeCopyGuardParseFailureCount': revoke_copy_guard_counts['parseFailures'],
                'revokeRequestCaptureBlockedPostCount': sum(item['blockedNonReadRequestCount'] for item in revoke_capture_metadata),
                'revokeRequestCaptureGuardParseFailureCount': sum(item['guardParseFailureCount'] for item in revoke_capture_metadata),
                'pageRestorationBlockedNonReadRequestCount': restoration_counts['blocked'],
                'pageRestorationGuardParseFailureCount': restoration_counts['parseFailures'],
                'unrelatedShareRowsModified': False,
            },
            'persistence': {
                'expectedOwnerPersisted': False,
                'sessionValuesPersisted': False,
                'shareIdsPersisted': False,
                'shareUrlsPersisted': False,
                'conversationIdsPersisted': False,
                'promptOrAssistantTextPersisted': False,
                'rawRequestOrResponseBodyPersisted': False,
            },
        }
        write_receipt(receipt)
        print(json.dumps({
            'outcome': receipt['outcome'],
            'operation': receipt['operation'],
            'taskRows': receipt['taskBinding']['titleRowCount'],
            'publicReadsVerified': sum(1 for item in direct['shares'] if item.get('taskContentMatchesConversationDetail')),
            'directShareRevokes': direct_revoke.get('directDispatchCount'),
            'baselineShareCountRestored': direct_revoke.get('finalTotalShareCount'),
            'anonymousLinksRejected': anonymous_verified,
            'browserPageRestored': receipt['browserPageRestored'],
            'receipt': str(RECEIPT_PATH),
        }, separators=(',', ':')))
        direct = None
        return 0 if revoke_feature_verified else 2
    except SafeFailure as exc:
        print(exc.code, file=sys.stderr)
        return 1
    except Exception as exc:
        import traceback
        frames = traceback.extract_tb(exc.__traceback__)
        last = frames[-1] if frames else None
        place = f'{last.name}:{last.lineno}' if last else 'unknown'
        print(f'SHARE_PUBLIC_ROUTE_CAPTURE_FAILED:{type(exc).__name__}:{place}', file=sys.stderr)
        return 1
    finally:
        for index in range(len(raw_links)):
            raw_links[index] = ('', '')
        wipe(session)
        session = None
        expected_owner = ''
        original_url = ''
        route_id = ''
        wipe(captures)
        wipe(locals().get('revoke_captures', []))
        wipe(header_values if 'header_values' in locals() else [])
        share_ids.clear()
        wipe(locals().get('fresh_links', []))
        if 'list_pair' in locals():
            list_pair['request'] = None


if __name__ == '__main__':
    raise SystemExit(main())
