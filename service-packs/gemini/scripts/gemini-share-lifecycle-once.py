#!/usr/bin/env python3
"""Capture a guarded task-share action, dispatch it once, and pair the public-share read."""

import base64
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
SERVICE_ORIGIN = 'https://gemini.google.com'
GROK_ORIGIN = 'https://grok.com'
PAGE_ROLE = 'codex-gemini-lifecycle-20261006'
GROK_ROLE = 'codex-grok-core-20261006'
SHARE_CREATE_RPC = 'fuVx7'
SHARE_READ_RPC = 'ujx1Bf'
BATCH_PATH = '/_/BardChatUi/data/batchexecute'
TASK_TITLE = 'Codex API verified text 20261006'
TASK_MARKER = 'PROTOCOL42'
CALLER_INTENT = 'lifecycle:share:create:protocol42:20261006'
NODE = '/home/worker/.npm/_npx/387698761821791d/node_modules/node/bin/node'
NODE_SHARE = REPO / 'scripts/gemini-share-create-once.mjs'
CONTRACT_PATH = REPO / 'discovery/observed-contract.json'
RECEIPT_PATH = REPO / 'discovery/gemini-share-lifecycle-capture-2026-10-06.json'
FORBIDDEN_HEADERS = {'cookie', 'authorization', 'proxy-authorization', 'host', 'content-length'}


class SafeFailure(Exception):
    def __init__(self, code):
        self.code = code


def read_json(path):
    try:
        return json.loads(pathlib.Path(path).read_text(encoding='utf-8'))
    except Exception as exc:
        raise SafeFailure('RUNTIME_METADATA_INVALID') from exc


def import_script(name, path):
    sys.dont_write_bytecode = True
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def verify_runtime(owner, roles):
    if owner.get('taskOwned') is not True or owner.get('mode') != 'cdp_discovery_after_native_bootstrap':
        raise SafeFailure('OWNED_RUNTIME_INVALID')
    pid = owner.get('chromePid')
    port = owner.get('cdpPort')
    profile = pathlib.Path(owner.get('profile', '')).resolve()
    if not isinstance(pid, int) or not isinstance(port, int) or not 1 <= port <= 65535:
        raise SafeFailure('OWNED_RUNTIME_INVALID')
    try:
        os.kill(pid, 0)
        argv = pathlib.Path(f'/proc/{pid}/cmdline').read_bytes().decode('utf-8', 'replace').split('\0')
    except Exception as exc:
        raise SafeFailure('OWNED_RUNTIME_NOT_ALIVE') from exc
    if f'--user-data-dir={profile}' not in argv or f'--remote-debugging-port={port}' not in argv:
        raise SafeFailure('OWNED_PROFILE_MISMATCH')
    active = roles.get('activePageRoles', {})
    for marker, origin in ((PAGE_ROLE, SERVICE_ORIGIN), (GROK_ROLE, GROK_ORIGIN)):
        role = active.get(marker, {})
        if role.get('origin') != origin or role.get('exactMarkerCount') != 1:
            raise SafeFailure('PAGE_ROLE_NOT_UNIQUE')
    return port


def current_pages(context):
    gemini = []
    grok = []
    for page in context.pages:
        try:
            marker = page.evaluate('() => window.name')
            host = urllib.parse.urlsplit(page.url).hostname
            if marker == PAGE_ROLE and host == 'gemini.google.com':
                gemini.append(page)
            elif marker == GROK_ROLE and host == 'grok.com':
                grok.append(page)
        except Exception:
            continue
    if len(gemini) != 1 or len(grok) != 1:
        raise SafeFailure('ROLE_PAGE_NOT_UNIQUE')
    return gemini[0], grok[0]


def request_capture(request, contract):
    parsed = urllib.parse.urlsplit(request.url)
    if parsed.scheme != 'https' or parsed.hostname != 'gemini.google.com' or parsed.path != BATCH_PATH:
        return None
    query_pairs = urllib.parse.parse_qsl(parsed.query, keep_blank_values=True)
    query_keys = [name for name, _ in query_pairs]
    query_values = urllib.parse.parse_qs(parsed.query, keep_blank_values=True)
    if query_values.get('rpcids') != [SHARE_CREATE_RPC]:
        return None
    raw_body = request.post_data or ''
    body_pairs = urllib.parse.parse_qsl(raw_body, keep_blank_values=True)
    body_fields = [name for name, _ in body_pairs]
    form = urllib.parse.parse_qs(raw_body, keep_blank_values=True)
    try:
        outer = json.loads(form['f.req'][0])
        call = outer[0][0]
        args = json.loads(call[1])
    except Exception:
        raise SafeFailure('SHARE_REQUEST_SHAPE_INVALID')
    if not isinstance(call, list) or len(call) < 2 or call[0] != SHARE_CREATE_RPC or not isinstance(args, list):
        raise SafeFailure('SHARE_REQUEST_SHAPE_INVALID')
    base = contract.get('operations', {}).get('history_list', {}).get('request', {})
    allowed_headers = {name.lower() for name in base.get('headerNames', [])}
    headers = {str(name).lower(): str(value) for name, value in request.headers.items()}
    header_values = {
        name: value for name, value in headers.items()
        if name in allowed_headers and name not in FORBIDDEN_HEADERS
    }
    header_names = sorted(name for name in headers if name in allowed_headers and name not in FORBIDDEN_HEADERS)
    content_type = headers.get('content-type', '').lower()
    return {
        'rpcId': SHARE_CREATE_RPC,
        'args': args,
        'capture': {
            'rpcId': SHARE_CREATE_RPC,
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
        },
        'metadata': {
            'method': request.method.upper(),
            'path': parsed.path,
            'rpcId': SHARE_CREATE_RPC,
            'queryKeys': query_keys,
            'headerNames': header_names,
            'formFieldNames': body_fields,
            'contentType': content_type,
            'bodyBytes': len(raw_body.encode('utf-8')),
            'argsShape': shape(args),
            'rpcCallTailShape': shape(call[2:]),
            'rpcCallTailSafeToPersist': all(value is None or value == 'generic' for value in call[2:]),
        },
    }


def shape(value, depth=0):
    if depth > 5:
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
        return {'type': 'array', 'length': len(value), 'items': [shape(item, depth + 1) for item in value[:8]]}
    if isinstance(value, dict):
        return {'type': 'object', 'fieldCount': len(value)}
    return 'unsupported'


def count_exact(value, target, depth=0, budget=None):
    if budget is None:
        budget = {'nodes': 0}
    budget['nodes'] += 1
    if budget['nodes'] > 50_000 or depth > 20:
        return 0
    if isinstance(value, str):
        return 1 if value == target else 0
    if isinstance(value, list):
        return sum(count_exact(item, target, depth + 1, budget) for item in value)
    if isinstance(value, dict):
        return sum(count_exact(item, target, depth + 1, budget) for item in value.values())
    return 0


def install_share_contract(capture):
    current = read_json(CONTRACT_PATH)
    request = capture['request']
    tail = capture.get('rpcCallTail')
    if not isinstance(tail, list) or not all(value is None or value == 'generic' for value in tail):
        raise SafeFailure('SHARE_CALL_TAIL_NOT_SAFE_TO_PERSIST')
    base = current.get('operations', {}).get('history_list', {}).get('request', {})
    if (request.get('method') != 'POST' or request.get('origin') != SERVICE_ORIGIN
            or request.get('path') != BATCH_PATH or request.get('queryKeys') != base.get('queryKeys')
            or str(request.get('contentType', '')).lower() != str(base.get('contentType', '')).lower()
            or request.get('bodyFieldNames') != base.get('bodyFieldNames')
            or capture.get('rpcId') != SHARE_CREATE_RPC):
        raise SafeFailure('SHARE_CAPTURE_CONTRACT_MISMATCH')
    operation = {
        'observation': {'request': True, 'requestResponse': False},
        'effect': 'mutation',
        'retryPolicy': 'never',
        'request': {
            'method': request['method'],
            'origin': request['origin'],
            'path': request['path'],
            'queryKeys': request['queryKeys'],
            'headerNames': request['headerNames'],
            'contentType': request['contentType'],
            'bodyFieldNames': request['bodyFieldNames'],
            'rpcId': SHARE_CREATE_RPC,
            'rpcCallTail': capture['rpcCallTail'],
        },
    }
    old = current.get('operations', {}).get('share_create')
    if old is not None and (old.get('request', {}).get('rpcId') != SHARE_CREATE_RPC
                            or old.get('request', {}).get('path') != BATCH_PATH):
        raise SafeFailure('SHARE_CONTRACT_CONCURRENT_CHANGE')
    if old != operation:
        current.setdefault('operations', {})['share_create'] = operation
        current['observedAt'] = datetime.now(timezone.utc).isoformat()
        temp = CONTRACT_PATH.with_name(CONTRACT_PATH.name + f'.share-{os.getpid()}.pending')
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


def capture_normal_share_request(page, contract):
    captured = []
    abort_failures = []
    parse_failures = []

    def guard(route):
        try:
            request = route.request
            if request.method.upper() in {'GET', 'HEAD', 'OPTIONS'}:
                route.continue_()
                return
            result = request_capture(request, contract)
            if result is not None:
                captured.append(result)
        except Exception as exc:
            parse_failures.append(type(exc).__name__)
        try:
            route.abort('aborted')
        except Exception:
            abort_failures.append(True)

    page.route('**/*', guard)
    try:
        if page.get_by_role('dialog').count():
            page.keyboard.press('Escape')
            page.wait_for_timeout(150)
        menu = page.get_by_role('button', name='대화 작업 메뉴 열기', exact=True)
        if menu.count() != 1:
            raise SafeFailure('TASK_CONVERSATION_MENU_NOT_UNIQUE')
        menu.click(timeout=10000)
        page.wait_for_timeout(100)
        share = page.get_by_role('menuitem', name='대화 공유', exact=True)
        if share.count() != 1:
            raise SafeFailure('SHARE_MENUITEM_NOT_UNIQUE')
        share.click(timeout=10000)
        page.wait_for_timeout(500)
        if parse_failures:
            raise SafeFailure('SHARE_UI_REQUEST_PARSE_FAILED')
        if len(captured) != 1 or abort_failures:
            raise SafeFailure('SHARE_UI_REQUEST_NOT_UNIQUE_OR_ABORT_UNACKNOWLEDGED')
        if page.get_by_role('dialog').count() != 1:
            raise SafeFailure('SHARE_UI_DIALOG_NOT_PRESENT')
        return captured[0]
    finally:
        page.unroute('**/*', guard)
        page.wait_for_timeout(300)


def direct_share_create(session, owner_email, conversation_id, captured):
    if not pathlib.Path(NODE).is_file() or not NODE_SHARE.is_file():
        raise SafeFailure('NODE_SHARE_CLIENT_MISSING')
    envelope = {
        'session': session,
        'expectedOwner': owner_email,
        'conversationId': conversation_id,
        'callerIntent': CALLER_INTENT,
        'confirmed': True,
        'rpcId': captured['rpcId'],
        'args': captured['args'],
        'requestCapture': captured['capture'],
        'shareUrlHandoff': True,
    }
    share_read_fd, share_write_fd = os.pipe()
    env = dict(os.environ)
    env['GEMINI_SHARE_LINK_HANDOFF'] = '1'
    env['GEMINI_SHARE_URL_FD'] = str(share_write_fd)
    child = subprocess.Popen(
        [NODE, str(NODE_SHARE)], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        cwd=REPO, env=env, pass_fds=(share_write_fd,), close_fds=True,
    )
    os.close(share_write_fd)
    try:
        stdout_bytes, stderr_bytes = child.communicate(json.dumps(envelope).encode('utf-8'), timeout=150)
    except Exception:
        child.kill()
        child.wait(timeout=10)
        os.close(share_read_fd)
        raise SafeFailure('SHARE_CREATE_CHILD_FAILED')
    envelope['expectedOwner'] = ''
    envelope['session'] = {}
    envelope['args'] = []
    envelope['requestCapture'] = {}
    try:
        share_url_bytes = bytearray()
        while True:
            chunk = os.read(share_read_fd, 4096)
            if not chunk:
                break
            share_url_bytes.extend(chunk)
            if len(share_url_bytes) > 16 * 1024:
                raise SafeFailure('SHARE_URL_HANDOFF_TOO_LARGE')
    finally:
        os.close(share_read_fd)
    if child.returncode != 0 or not stdout_bytes:
        code = 'SHARE_CREATE_CHILD_FAILED'
        try:
            value = json.loads(stdout_bytes.decode('utf-8')) if stdout_bytes else {}
            code = value.get('code', code) if isinstance(value, dict) else code
        except Exception:
            pass
        raise SafeFailure(code if re.fullmatch(r'[A-Z][A-Z0-9_]{1,63}', str(code)) else 'SHARE_CREATE_CHILD_FAILED')
    try:
        summary = json.loads(stdout_bytes.decode('utf-8'))
    except Exception as exc:
        raise SafeFailure('SHARE_CREATE_OUTPUT_INVALID') from exc
    share_url = share_url_bytes.decode('utf-8').strip()
    for index in range(len(share_url_bytes)):
        share_url_bytes[index] = 0
    if share_url:
        parsed = urllib.parse.urlsplit(share_url)
        if parsed.scheme != 'https' or parsed.hostname not in {'gemini.google.com', 'g.co'}:
            share_url = ''
    return summary, share_url


def main():
    try:
        owner = read_json(OWNER_PATH)
        roles = read_json(ROLE_PATH)
        port = verify_runtime(owner, roles)
        if RECEIPT_PATH.exists():
            existing = read_json(RECEIPT_PATH)
            if existing.get('schema') != 'gemini-share-lifecycle-capture-v1':
                raise SafeFailure('SHARE_RECEIPT_ALREADY_EXISTS')
        contract = read_json(CONTRACT_PATH)
        api_helper = import_script('gemini_linux_api_share_helper', REPO / 'scripts/run-linux-api.py')
        text_helper = import_script('gemini_text_owner_share_helper', REPO / 'scripts/run-linux-text-smoke.py')
        expected_hash, _ = text_helper.read_static_owner_hash()
        target_url = None
        target_conversation_id = None
        with sync_playwright() as playwright:
            browser = playwright.chromium.connect_over_cdp(f'http://127.0.0.1:{port}')
            if len(browser.contexts) != 1:
                raise SafeFailure('OWNED_CONTEXT_COUNT_INVALID')
            context = browser.contexts[0]
            page = current_pages(context)[0]
            grok_page = current_pages(context)[1]
            if page.get_by_role('dialog').count():
                dialog_text = page.get_by_role('dialog').inner_text(timeout=3000).lower()
                if 'copy' not in dialog_text and '링크' not in dialog_text and '공유' not in dialog_text:
                    raise SafeFailure('UNEXPECTED_TASK_DIALOG_OPEN')
                page.keyboard.press('Escape')
                page.wait_for_timeout(200)
            target_url = page.url
            parsed_page = urllib.parse.urlsplit(target_url)
            route_id = parsed_page.path.rsplit('/', 1)[-1] if parsed_page.path.startswith('/app/') else ''
            if not re.fullmatch(r'[0-9a-f]{16}', route_id):
                raise SafeFailure('TASK_ROUTE_ID_INVALID')
            target_conversation_id = 'c_' + route_id
            s = context.new_cdp_session(page)
            try:
                s.send('Accessibility.enable')
                tree = s.send('Accessibility.getFullAXTree')
                names = [(node.get('name') or {}).get('value', '') for node in tree.get('nodes', [])]
            finally:
                s.detach()
            if not any(TASK_MARKER in name for name in names if isinstance(name, str)):
                raise SafeFailure('TASK_MARKER_NOT_ON_PAGE')
            expected_owner = text_helper.read_grok_owner(grok_page, expected_hash)
            captured = capture_normal_share_request(page, contract)
            if count_exact(captured['args'], target_conversation_id) != 1:
                raise SafeFailure('SHARE_TARGET_NOT_BOUND_TO_TASK')
            if os.environ.get('GEMINI_SHARE_CAPTURE_ONLY') == '1':
                tail = captured['capture']['rpcCallTail']
                print(json.dumps({
                    'outcome': 'request_capture_only',
                    'operation': 'share_create',
                    'request': captured['metadata'],
                    'targetBoundExactlyOnce': True,
                    'rpcCallTailSafeToPersist': all(value is None or value == 'generic' for value in tail),
                    'dynamicTargetPersisted': False,
                }, separators=(',', ':')))
                return 0
            # Session capture uses the existing read-only allowlist and keeps all values in this process.
            def quiet_guard(route):
                try:
                    if route.request.method.upper() in {'GET', 'HEAD', 'OPTIONS'}:
                        route.continue_()
                        return
                except Exception:
                    pass
                try:
                    route.abort('aborted')
                except Exception:
                    pass
            page.route('**/*', quiet_guard)
            try:
                page.goto(SERVICE_ORIGIN + '/app', wait_until='domcontentloaded', timeout=30000)
            finally:
                page.unroute('**/*', quiet_guard)
                page.wait_for_timeout(300)
        roles = read_json(ROLE_PATH)
        owner = read_json(OWNER_PATH)
        session = api_helper.capture_session(owner, roles, contract, PAGE_ROLE)
        install_share_contract(captured['capture'])
        summary, share_url = direct_share_create(session, expected_owner, target_conversation_id, captured)
        for cookie in session.get('cookies', []):
            cookie['value'] = ''
        session = None
        receipt = {
            'schema': 'gemini-share-lifecycle-capture-v1',
            'service': 'gemini-web',
            'feature': 'share',
            'operation': 'share_create',
            'outcome': 'created_pending_readback' if share_url else 'direct_response_without_link_handoff',
            'verifiedAt': datetime.now(timezone.utc).isoformat(),
            'executionHost': 'linux_worker',
            'pageRole': PAGE_ROLE,
            'sourceMapping': {'sourceClass': 'anonymous_google_first_party_web_client', 'rpcId': SHARE_CREATE_RPC, 'operationName': 'CreateSharedConversation'},
            'browserCapture': {
                'requestCaptured': True, 'browserMutationReachedServer': False,
                'browserAbortAcknowledged': True, 'request': captured['metadata'],
                'rawArgsOrBodyPersisted': False,
            },
            'directMutation': {
                'transport': 'main_client_https', 'rpcId': summary.get('rpcId'),
                'ownerMatched': summary.get('ownerMatched') is True,
                'anonymousOwnerAbsent': summary.get('anonymousOwnerAbsent') is True,
                'preflightConversationIdMatched': summary.get('preflightConversationIdMatched') is True,
                'preflightRouteBindingVerified': summary.get('preflightRouteBindingVerified') is True,
                'dispatchCount': 1, 'retryPolicy': 'never',
                'httpStatus': summary.get('mutationHttpStatus'),
                'responseBytes': summary.get('mutationResponseBytes'),
                'responseSha256': summary.get('mutationResponseSha256'),
                'responseRpcDecoded': summary.get('responseRpcDecoded') is True,
                'shareLinkReturnedInMemory': bool(share_url),
                'shareLinkPersistedOrPrinted': False,
                'journalState': 'response_received_unreconciled',
                'journalId': summary.get('journalId'),
                'intentKeyHash': summary.get('intentKeyHash'),
                'wireBodyDigest': summary.get('wireBodyDigest'),
            },
            'persistence': {
                'cookiesPersisted': False, 'sessionValuesPersisted': False,
                'requestValuesPersisted': False, 'responseValuesPersisted': False,
                'shareLinkPersisted': False, 'targetConversationIdPersisted': False,
                'rawRequestOrResponseBodyPersisted': False,
            },
        }
        RECEIPT_PATH.parent.mkdir(parents=True, exist_ok=True)
        temp = RECEIPT_PATH.with_name(RECEIPT_PATH.name + f'.share-{os.getpid()}.pending')
        descriptor = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(descriptor, 'w', encoding='utf-8') as stream:
            json.dump(receipt, stream, ensure_ascii=False, indent=2)
            stream.write('\n')
        os.replace(temp, RECEIPT_PATH)
        if share_url:
            # The ephemeral link is intentionally neither persisted nor emitted in stdout.
            parsed = urllib.parse.urlsplit(share_url)
            link_ref = {'host': parsed.hostname, 'pathFamily': '/share/{id}' if '/share/' in parsed.path else '/sharing', 'tokenLength': len(parsed.path.rsplit('/', 1)[-1])}
        else:
            link_ref = None
        print(json.dumps({
            'outcome': receipt['outcome'], 'operation': receipt['operation'],
            'httpStatus': receipt['directMutation']['httpStatus'],
            'responseRpcDecoded': receipt['directMutation']['responseRpcDecoded'],
            'shareLinkReference': link_ref,
            'receipt': str(RECEIPT_PATH),
        }, separators=(',', ':')))
        return 0
    except SafeFailure as exc:
        print(exc.code, file=sys.stderr)
        return 1
    except Exception as exc:
        import traceback
        last = traceback.extract_tb(exc.__traceback__)[-1] if exc.__traceback__ else None
        location = f'{last.name}:{last.lineno}' if last else 'unknown'
        print('SHARE_LIFECYCLE_FAILED:' + type(exc).__name__ + ':' + location, file=sys.stderr)
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
