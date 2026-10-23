#!/usr/bin/env python3
"""Run one guarded, owner-bound Gemini rename/share/revoke/delete lifecycle fixture."""

import ast
import copy
import hashlib
import importlib.util
import json
import os
import pathlib
import re
import shutil
import subprocess
import sys
import urllib.parse
from datetime import datetime, timedelta, timezone

from playwright.sync_api import sync_playwright


REPO = pathlib.Path(__file__).resolve().parent.parent
RUNTIME = pathlib.Path.home() / '.nad-scratch/provider-runtime-20261005'
OWNER_PATH = RUNTIME / 'runtime-owner.json'
ROLE_PATH = RUNTIME / 'page-role-registry.json'
ROLE = 'codex-gemini-lifecycle-canonical-20261006'
ORIGIN = 'https://gemini.google.com'
BATCH_PATH = '/_/BardChatUi/data/batchexecute'
EXPECTED_OWNER_SHA256 = '23e57131977ce522bacf6649eb27538770828a890f7a65589ec4f0960a84b3d7'
FIXTURE_INTENT = 'gemini-lifecycle-fixture-20261006-v1'
FIXTURE_TEXT_RECEIPT = REPO / 'verification/one-shot/gemini-lifecycle-fixture-text-2026-10-06.json'
FIXTURE_SCRIPT = REPO / 'scripts/gemini-lifecycle-fixture-once.py'
TASK_READER = REPO / 'scripts/gemini-lifecycle-task-detail-once.mjs'
TASK_SOURCE_READER = REPO / 'scripts/gemini-lifecycle-task-source-read-once.mjs'
OWNER_READER = REPO / 'scripts/gemini-lifecycle-owner-pair-once.mjs'
SETTINGS_HELPER = REPO / 'scripts/gemini-settings-update-once.py'
CLI = REPO / 'src/cli.mjs'
CONTRACT_PATH = REPO / 'discovery/observed-contract.json'
CHECKLIST_PATH = REPO / 'discovery/feature-checklist.json'
ONE_SHOT_PATH = REPO / 'verification/one-shot/gemini-lifecycle-canonical-2026-10-07.json'
SAFE_READ_RPCS = {'MaZiqc', 'hNvQHb', 'otAQ7b', 'ESY5D', 'OXxBcc', 'unqWSc', 'ujx1Bf'}
SAFE_GET_HOSTS = {
    'gemini.google.com', 'gemini.gstatic.com', 'www.gstatic.com', 'accounts.google.com',
    'lh3.googleusercontent.com', 'fonts.googleapis.com', 'fonts.gstatic.com',
}
FORBIDDEN_HEADERS = {'cookie', 'authorization', 'proxy-authorization', 'host', 'content-length'}
CALLER_INTENTS = {
    'rename': 'gemini:lifecycle:rename:fixture20261007:v1',
    'share_create': 'gemini:lifecycle:share-create:fixture20261007:v1',
    'share_revoke': 'gemini:lifecycle:share-revoke:fixture20261007:v1',
    'delete': 'gemini:lifecycle:delete:fixture20261007:v1',
}


class SafeFailure(Exception):
    def __init__(self, code, screenshot=None):
        self.code = code
        self.screenshot = screenshot


def import_module(name, path):
    sys.dont_write_bytecode = True
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def read_json(path):
    try:
        return json.loads(pathlib.Path(path).read_text(encoding='utf-8'))
    except Exception as exc:
        raise SafeFailure('LIFECYCLE_METADATA_INVALID') from exc


def sha256(raw):
    return hashlib.sha256(raw).hexdigest()


def clear_tree(value, depth=0):
    if depth > 32 or value is None:
        return
    if isinstance(value, bytearray):
        value[:] = b'\0' * len(value)
    elif isinstance(value, list):
        for index, child in enumerate(value):
            if isinstance(child, str):
                value[index] = ''
            else:
                clear_tree(child, depth + 1)
        value.clear()
    elif isinstance(value, dict):
        for key, child in list(value.items()):
            if isinstance(child, str):
                value[key] = ''
            else:
                clear_tree(child, depth + 1)
        value.clear()


def prompt_from_source():
    tree = ast.parse(FIXTURE_SCRIPT.read_text(encoding='utf-8'))
    for statement in tree.body:
        names = []
        value = None
        if isinstance(statement, ast.Assign):
            names = [target.id for target in statement.targets if isinstance(target, ast.Name)]
            value = statement.value
        elif isinstance(statement, ast.AnnAssign) and isinstance(statement.target, ast.Name):
            names = [statement.target.id]
            value = statement.value
        if 'PROMPT' in names and value is not None:
            prompt = ast.literal_eval(value)
            if isinstance(prompt, str) and prompt.strip() and len(prompt) <= 8000 and '\0' not in prompt:
                return prompt
    raise SafeFailure('LIFECYCLE_FIXTURE_PROMPT_UNAVAILABLE')


def unique_intent_job(actor):
    canonical = json.dumps(['gemini-web', 'text', actor.strip().lower(), FIXTURE_INTENT], separators=(',', ':'))
    intent_hash = sha256(canonical.encode('utf-8'))
    jobs_root = pathlib.Path.home() / '.config/gemini-web-xhr-client/jobs'
    matches = []
    if jobs_root.exists():
        for path in jobs_root.glob('*.json'):
            try:
                job = json.loads(path.read_text(encoding='utf-8'))
            except Exception:
                continue
            if job.get('capability') == 'text' and job.get('version') == 2 and job.get('intentKeyHash') == intent_hash:
                matches.append(job)
    if len(matches) != 1:
        raise SafeFailure('LIFECYCLE_FIXTURE_INTENT_NOT_UNIQUE')
    job = matches[0]
    if job.get('dispatchCount') != 1 or job.get('state') != 'reconciled':
        raise SafeFailure('LIFECYCLE_FIXTURE_WRITE_NOT_RECONCILED')
    created = job.get('createdAt')
    response = job.get('responseReceivedAt') or job.get('updatedAt')
    if not isinstance(created, str) or not isinstance(response, str):
        raise SafeFailure('LIFECYCLE_FIXTURE_WINDOW_MISSING')
    return (job, datetime.fromisoformat(created.replace('Z', '+00:00')),
            datetime.fromisoformat(response.replace('Z', '+00:00')))


def verify_owned_runtime(owner, roles):
    if owner.get('taskOwned') is not True or owner.get('mode') != 'cdp_discovery_after_native_bootstrap':
        raise SafeFailure('OWNED_RUNTIME_INVALID')
    pid, port = owner.get('chromePid'), owner.get('cdpPort')
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
    role = roles.get('activePageRoles', {}).get(ROLE, {})
    if (role.get('origin') != ORIGIN or role.get('selection') != 'owned_target_id_and_exact_marker'
            or role.get('exactMarkerCount') != 1 or not role.get('targetId')):
        raise SafeFailure('LIFECYCLE_ROLE_NOT_REGISTERED')
    return port, role


def capture_session(settings, owner, role, contract):
    settings.ROLE = ROLE
    try:
        session, expected_owner, state, cookie_values = settings.capture_one_shot_session(owner, role, contract)
    except Exception as exc:
        code = exc.code if isinstance(exc, SafeFailure) else getattr(exc, 'code', None)
        raise SafeFailure(code if isinstance(code, str) and re.fullmatch(r'[A-Z][A-Z0-9_]{1,80}', code)
                          else 'LIFECYCLE_SESSION_CAPTURE_FAILED') from exc
    owner_hash = sha256(expected_owner.strip().casefold().encode('utf-8'))
    if owner_hash != EXPECTED_OWNER_SHA256:
        settings.wipe_session(session, cookie_values)
        expected_owner = ''
        raise SafeFailure('EXPECTED_OWNER_NOT_UNIQUE')
    return session, expected_owner, state, cookie_values


def run_json_child(command, packet, *, private_fd_env=None, extra_env=None, handoff_limit=16 * 1024):
    node = shutil.which('node')
    if not node:
        raise SafeFailure('NODE_RUNTIME_UNAVAILABLE')
    read_fd = write_fd = None
    env = {key: value for key, value in os.environ.items()
           if key in {'PATH', 'HOME', 'LANG', 'LC_ALL', 'TMPDIR', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'REQUESTS_CA_BUNDLE'}}
    pass_fds = ()
    if private_fd_env is not None:
        read_fd, write_fd = os.pipe()
        if extra_env:
            env.update(extra_env)
        env[private_fd_env] = str(write_fd)
        pass_fds = (write_fd,)
    process = subprocess.Popen([node, *command], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                stderr=subprocess.PIPE, cwd=REPO, env=env,
                                pass_fds=pass_fds, close_fds=True)
    if write_fd is not None:
        os.close(write_fd)
        write_fd = None
    encoded = bytearray(json.dumps(packet, separators=(',', ':')).encode('utf-8'))
    try:
        process.stdin.write(encoded)
        process.stdin.flush()
    except Exception as exc:
        raise SafeFailure('LIFECYCLE_CHILD_STDIN_FAILED') from exc
    finally:
        encoded[:] = b'\0' * len(encoded)
        process.stdin.close()
        clear_tree(packet)
    stdout_bytes, stderr_bytes = process.communicate()
    handoff = bytearray()
    if read_fd is not None:
        try:
            while True:
                chunk = os.read(read_fd, min(4096, handoff_limit - len(handoff) + 1))
                if not chunk:
                    break
                handoff.extend(chunk)
                if len(handoff) > handoff_limit:
                    raise SafeFailure('LIFECYCLE_PRIVATE_HANDOFF_TOO_LARGE')
        finally:
            os.close(read_fd)
            read_fd = None
    try:
        result = json.loads(stdout_bytes.decode('utf-8')) if stdout_bytes else None
    except Exception as exc:
        raise SafeFailure('LIFECYCLE_CHILD_OUTPUT_INVALID') from exc
    if process.returncode != 0 or not isinstance(result, dict):
        candidate = stderr_bytes.decode('utf-8', 'replace').strip()
        code = candidate if re.fullmatch(r'[A-Z][A-Z0-9_]{1,80}', candidate) else 'LIFECYCLE_CHILD_FAILED'
        raise SafeFailure(code)
    return result, handoff


def target_handoff(session, owner, prompt, start, end, reserved_title, prior_response_id_matched):
    packet = {
        'session': copy.deepcopy(session),
        'expectedOwner': owner,
        'expectedPrompt': prompt,
        'windowStart': start.isoformat(),
        'windowEnd': end.isoformat(),
        'priorResponseIdMatched': prior_response_id_matched,
        'reservedTitle': reserved_title,
    }
    result, handoff = run_json_child([str(TASK_READER)], packet,
                                     private_fd_env='GEMINI_LIFECYCLE_TARGET_FD')
    if (result.get('operation') != 'lifecycle_fixture_task_readback'
            or result.get('taskBound') is not True or result.get('windowCandidateCount') != 1
            or result.get('taskPromptMatched') is not True or result.get('apiConversationIdEchoMatched') is not True
            or result.get('routeBindingVerified') is not True or result.get('sourceTurnMatched') is not True
            or result.get('priorDirectResponseIdMatched') is not True or result.get('reservedTitleAbsent') is not True):
        for index in range(len(handoff)):
            handoff[index] = 0
        raise SafeFailure('LIFECYCLE_FIXTURE_EXACT_BINDING_FAILED')
    try:
        target = json.loads(handoff.decode('utf-8'))
    except Exception as exc:
        raise SafeFailure('LIFECYCLE_PRIVATE_TARGET_INVALID') from exc
    finally:
        handoff[:] = b'\0' * len(handoff)
    conversation_id = target.get('apiConversationId')
    title = target.get('title')
    if (not isinstance(conversation_id, str) or not re.fullmatch(r'c_[0-9a-f]{16}', conversation_id)
            or not isinstance(title, str) or not title.strip() or len(title) > 160):
        clear_tree(target)
        raise SafeFailure('LIFECYCLE_PRIVATE_TARGET_INVALID')
    return result, conversation_id, title


def source_readback(session, owner, conversation_id, prompt):
    packet = {
        'session': copy.deepcopy(session),
        'expectedOwner': owner,
        'apiConversationId': conversation_id,
        'expectedPrompt': prompt,
    }
    result, _ = run_json_child([str(TASK_SOURCE_READER)], packet)
    if result.get('operation') != 'history_read':
        raise SafeFailure('LIFECYCLE_SOURCE_READBACK_INVALID')
    return result


def owner_pair_read(session, owner):
    packet = {'session': copy.deepcopy(session), 'expectedOwner': owner}
    result, _ = run_json_child([str(OWNER_READER)], packet)
    if (result.get('operation') != 'identity' or result.get('ownerMatched') is not True
            or result.get('anonymousOwnerAbsent') is not True or result.get('httpStatus') != 200
            or result.get('anonymousHttpStatus') != 200 or result.get('credentialPropagated') is not True):
        raise SafeFailure('LIFECYCLE_OWNER_PAIR_FAILED')
    return result


def target_id(context, page):
    cdp = context.new_cdp_session(page)
    try:
        value = cdp.send('Target.getTargetInfo').get('targetInfo', {}).get('targetId')
    finally:
        cdp.detach()
    return value


def select_registered_page(context, role):
    matches = []
    for page in context.pages:
        try:
            if target_id(context, page) == role.get('targetId'):
                matches.append(page)
        except Exception:
            continue
    if len(matches) != 1:
        raise SafeFailure('LIFECYCLE_ROLE_TARGET_NOT_UNIQUE')
    page = matches[0]
    parsed = urllib.parse.urlsplit(page.url)
    if parsed.scheme not in {'https', 'http'} or parsed.hostname not in {'gemini.google.com', None}:
        raise SafeFailure('LIFECYCLE_ROLE_ORIGIN_INVALID')
    try:
        marker = page.evaluate('() => window.name')
        if marker != ROLE:
            page.evaluate('(value) => { window.name = value; }', ROLE)
        if page.evaluate('() => window.name') != ROLE or target_id(context, page) != role.get('targetId'):
            raise SafeFailure('LIFECYCLE_ROLE_MARKER_BINDING_FAILED')
    except SafeFailure:
        raise
    except Exception as exc:
        raise SafeFailure('LIFECYCLE_ROLE_MARKER_BINDING_FAILED') from exc
    return page


def decode_batch_request(request):
    parsed = urllib.parse.urlsplit(request.url)
    if parsed.scheme != 'https' or parsed.hostname != 'gemini.google.com' or parsed.path != BATCH_PATH:
        return None
    query_pairs = urllib.parse.parse_qsl(parsed.query, keep_blank_values=True)
    query_values = [value for key, value in query_pairs if key == 'rpcids']
    if len(query_values) != 1:
        return None
    raw_body = request.post_data or ''
    body_pairs = urllib.parse.parse_qsl(raw_body, keep_blank_values=True)
    form = {}
    for name, value in body_pairs:
        form.setdefault(name, []).append(value)
    if sorted(form) != ['at', 'f.req'] or len(form.get('f.req', [])) != 1:
        raise SafeFailure('LIFECYCLE_CAPTURE_FORM_INVALID')
    outer = json.loads(form['f.req'][0])
    if (not isinstance(outer, list) or len(outer) != 1 or not isinstance(outer[0], list)
            or len(outer[0]) != 1 or not isinstance(outer[0][0], list)):
        raise SafeFailure('LIFECYCLE_CAPTURE_CALL_INVALID')
    call = outer[0][0]
    if len(call) < 2 or call[0] != query_values[0] or not isinstance(call[1], str):
        raise SafeFailure('LIFECYCLE_CAPTURE_CALL_INVALID')
    args = json.loads(call[1])
    if not isinstance(args, list):
        raise SafeFailure('LIFECYCLE_CAPTURE_ARGS_INVALID')
    return {
        'parsed': parsed,
        'queryKeys': [name for name, _ in query_pairs],
        'formFieldNames': [name for name, _ in body_pairs],
        'requestBytes': len(raw_body.encode('utf-8')),
        'rpcId': query_values[0],
        'args': args,
        'rpcCallTail': call[2:],
    }


def count_exact(value, expected, depth=0, budget=None):
    budget = budget if budget is not None else [0]
    budget[0] += 1
    if budget[0] > 100_000 or depth > 24:
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


def value_shape(value, depth=0):
    if depth > 16:
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
        return {'type': 'array', 'length': len(value), 'items': [value_shape(item, depth + 1) for item in value[:16]]}
    if isinstance(value, dict):
        return {'type': 'object', 'fieldCount': len(value)}
    return 'unsupported'


def parse_capture(request, expected_rpc, conversation_id, new_title=None, share_id=None, contract=None):
    decoded = decode_batch_request(request)
    if decoded is None or decoded['rpcId'] != expected_rpc:
        return None
    args = decoded['args']
    if expected_rpc != 'SgORbf' and count_exact(args, conversation_id) != 1:
        return None
    if new_title is not None and count_exact(args, new_title) != 1:
        raise SafeFailure('LIFECYCLE_CAPTURE_TITLE_BINDING_FAILED')
    if share_id is not None and count_exact(args, share_id) != 1:
        raise SafeFailure('LIFECYCLE_CAPTURE_SHARE_BINDING_FAILED')
    base = contract['operations']['history_list']['request']
    header_values = {str(name).lower(): str(value) for name, value in request.headers.items()}
    allowed_headers = {str(name).lower() for name in base.get('headerNames', [])}
    safe_names = sorted(name for name in header_values if name in allowed_headers and name not in FORBIDDEN_HEADERS)
    if ('content-type' not in safe_names
            or decoded['queryKeys'] != base.get('queryKeys')
            or decoded['formFieldNames'] != base.get('bodyFieldNames')):
        raise SafeFailure('LIFECYCLE_CAPTURE_ENVELOPE_MISMATCH')
    if expected_rpc == 'fuVx7':
        if header_values['content-type'].lower() != str(contract['operations']['share_create']['request']['contentType']).lower():
            raise SafeFailure('LIFECYCLE_SHARE_CAPTURE_CONTENT_TYPE_MISMATCH')
    return {
        'rpcId': expected_rpc,
        'args': args,
        'capture': {
            'rpcId': expected_rpc,
            'rpcCallTail': decoded['rpcCallTail'],
            'requestHeaderValues': {name: header_values[name] for name in safe_names},
            'request': {
                'method': request.method.upper(),
                'origin': f'{decoded["parsed"].scheme}://{decoded["parsed"].netloc}',
                'path': decoded['parsed'].path,
                'queryKeys': decoded['queryKeys'],
                'headerNames': safe_names,
                'contentType': header_values['content-type'].lower(),
                'bodyFieldNames': decoded['formFieldNames'],
            },
        },
        'metadata': {
            'rpcId': expected_rpc,
            'method': request.method.upper(),
            'path': decoded['parsed'].path,
            'queryKeys': decoded['queryKeys'],
            'headerNames': safe_names,
            'formFieldNames': decoded['formFieldNames'],
            'contentType': header_values['content-type'].lower(),
            'requestBytes': decoded['requestBytes'],
            'argsShape': value_shape(args),
            'rpcCallTailShape': value_shape(decoded['rpcCallTail']),
            'conversationIdOccurrenceCount': 0 if expected_rpc == 'SgORbf' else 1,
            'newTitleOccurrenceCount': 1 if new_title is not None else 0,
            'shareIdOccurrenceCount': 1 if share_id is not None else 0,
        },
    }


def _visible_buttons_for_title(page, title):
    selector = 'button,[role=button]'
    return page.locator(selector).evaluate_all(
        """(nodes,title) => nodes.map((element,index) => ({element,index,
          label:(element.getAttribute('aria-label')||element.getAttribute('title')||element.innerText||'').trim().replace(/\\s+/g,' ')}))
          .filter(item => item.element.getClientRects().length > 0 && item.label.includes(title)
            && /options|옵션|more|더보기/i.test(item.label))
          .map(item => ({index:item.index,disabled:item.element.disabled===true}))""",
        title,
    )


def _open_conversation_menu(page, title):
    menu = page.get_by_role('button', name='대화 작업 메뉴 열기', exact=True)
    if menu.count() == 1:
        menu.click(timeout=10000)
        return
    candidates = _visible_buttons_for_title(page, title)
    if len(candidates) != 1 or candidates[0]['disabled']:
        raise SafeFailure('LIFECYCLE_CONVERSATION_MENU_NOT_UNIQUE')
    page.locator('button,[role=button]').nth(candidates[0]['index']).click(timeout=10000, force=True)


def _open_task_row_menu(page, title):
    candidates = _visible_buttons_for_title(page, title)
    if len(candidates) == 1 and not candidates[0]['disabled']:
        page.locator('button,[role=button]').nth(candidates[0]['index']).click(timeout=10000, force=True)
        return
    menu = page.get_by_role('button', name='대화 작업 메뉴 열기', exact=True)
    if menu.count() != 1:
        raise SafeFailure('LIFECYCLE_TASK_MENU_NOT_UNIQUE')
    menu.click(timeout=10000)


def _click_menu_item(page, pattern):
    labels = page.locator('button,[role=button],[role=menuitem]').evaluate_all(
        """nodes => nodes.map((element,index) => ({element,index,
          label:(element.getAttribute('aria-label')||element.getAttribute('title')||element.innerText||'').trim().replace(/\\s+/g,' ')}))
          .filter(item => item.element.getClientRects().length > 0 && new RegExp(pattern,'i').test(item.label))
          .map(item => ({index:item.index,disabled:item.element.disabled===true}))""",
        pattern.pattern,
    )
    if len(labels) != 1 or labels[0]['disabled']:
        raise SafeFailure('LIFECYCLE_MENU_ITEM_NOT_UNIQUE')
    page.locator('button,[role=button],[role=menuitem]').nth(labels[0]['index']).click(timeout=10000, force=True)


def _dialog_button(page, pattern):
    dialog = page.get_by_role('dialog')
    if dialog.count() != 1:
        raise SafeFailure('LIFECYCLE_DIALOG_NOT_UNIQUE')
    labels = dialog.locator('button,[role=button]').evaluate_all(
        """(nodes,pattern) => nodes.map((element,index) => ({element,index,
          label:(element.getAttribute('aria-label')||element.getAttribute('title')||element.innerText||'').trim().replace(/\\s+/g,' ')}))
          .filter(item => item.element.getClientRects().length > 0 && new RegExp(pattern,'i').test(item.label))
          .map(item => ({index:item.index,disabled:item.element.disabled===true}))""",
        pattern.pattern,
    )
    if len(labels) != 1 or labels[0]['disabled']:
        raise SafeFailure('LIFECYCLE_DIALOG_CONFIRM_NOT_UNIQUE')
    dialog.locator('button,[role=button]').nth(labels[0]['index']).click(timeout=10000)


def _open_public_links_surface(page):
    body = page.locator('body').inner_text(timeout=3000)
    visible = (page.get_by_role('button', name='모든 링크 삭제', exact=True).count() == 1
               and ('Your public links' in body or '내 공개 링크' in body))
    if visible:
        return
    settings = page.get_by_role('button', name='설정', exact=True)
    if settings.count() != 1:
        raise SafeFailure('LIFECYCLE_SETTINGS_MENU_NOT_UNIQUE')
    if settings.get_attribute('aria-expanded') != 'true':
        settings.click(timeout=10000)
    item = page.get_by_role('menuitem', name='내 공개 링크', exact=True)
    if item.count() != 1:
        raise SafeFailure('LIFECYCLE_PUBLIC_LINKS_MENU_NOT_UNIQUE')
    item.click(timeout=10000, force=True)
    page.wait_for_function(
        "() => document.body && (document.body.innerText.includes('Your public links') || document.body.innerText.includes('내 공개 링크'))",
        timeout=15000,
    )


def _find_public_link_row(page, title):
    titles = page.get_by_text(title, exact=True)
    matches = []
    for index in range(titles.count()):
        for depth in range(1, 5):
            selector = 'xpath=' + '/'.join(['..'] * depth)
            row = titles.nth(index).locator(selector)
            try:
                buttons = row.get_by_role('button')
                if buttons.count() == 2:
                    matches.append((index, depth))
                    break
            except Exception:
                continue
    if len(matches) != 1:
        raise SafeFailure('LIFECYCLE_PUBLIC_LINK_ROW_NOT_UNIQUE')
    index, depth = matches[0]
    row = titles.nth(index).locator('xpath=' + '/'.join(['..'] * depth))
    return row


def capture_ui_action(owner, role, contract, *, action, conversation_id, route_id, prompt,
                      old_title=None, new_title=None, share_id=None):
    port = owner.get('cdpPort')
    state = {
        'capture': None, 'requestObject': None, 'targetCount': 0, 'abortAckCount': 0,
        'targetFailureCount': 0, 'targetResponseCount': 0, 'unknownBlockedCount': 0,
        'blockedGetCount': 0,
        'parseFailureCount': 0, 'nonTargetMutationCount': 0, 'resetVerified': False,
        'failureScreenshot': None,
    }
    page = None
    route_installed = False
    active_guard = None
    expected_rpc = {'rename': 'MUAZcd', 'delete': 'GzXR5e', 'share_create': 'fuVx7',
                    'share_revoke': 'SgORbf'}[action]

    def request_failed(request):
        if request is state['requestObject']:
            state['targetFailureCount'] += 1

    def response_seen(response):
        if response.request is state['requestObject']:
            state['targetResponseCount'] += 1

    def guard(route):
        request = route.request
        try:
            parsed = urllib.parse.urlsplit(request.url)
            if request.method.upper() in {'GET', 'HEAD', 'OPTIONS'}:
                if parsed.hostname in SAFE_GET_HOSTS:
                    route.continue_()
                else:
                    state['blockedGetCount'] += 1
                    route.abort('blockedbyclient')
                return
            rpc_ids = urllib.parse.parse_qs(parsed.query, keep_blank_values=True).get('rpcids', [])
            if (parsed.hostname == 'gemini.google.com' and parsed.path == BATCH_PATH
                    and len(rpc_ids) == 1 and rpc_ids[0] in SAFE_READ_RPCS):
                route.continue_()
                return
            if parsed.hostname == 'gemini.google.com' and parsed.path == BATCH_PATH and rpc_ids == [expected_rpc]:
                state['targetCount'] += 1
                if state['targetCount'] > 1:
                    state['nonTargetMutationCount'] += 1
                captured = parse_capture(request, expected_rpc, conversation_id, new_title, share_id, contract)
                if captured is None:
                    state['nonTargetMutationCount'] += 1
                elif state['capture'] is None:
                    state['capture'] = captured
                    state['requestObject'] = request
                try:
                    route.abort('aborted')
                    state['abortAckCount'] += 1
                except Exception:
                    state['parseFailureCount'] += 1
                return
        except SafeFailure:
            state['parseFailureCount'] += 1
        except Exception:
            state['parseFailureCount'] += 1
        state['unknownBlockedCount'] += 1
        try:
            route.abort('blockedbyclient')
        except Exception:
            state['parseFailureCount'] += 1

    try:
        with sync_playwright() as playwright:
            browser = playwright.chromium.connect_over_cdp(f'http://127.0.0.1:{port}')
            if len(browser.contexts) != 1:
                raise SafeFailure('OWNED_CONTEXT_COUNT_INVALID')
            context = browser.contexts[0]
            page = select_registered_page(context, role)
            page.on('requestfailed', request_failed)
            page.on('response', response_seen)
            page.route('**/*', guard)
            route_installed = True
            active_guard = guard

            if action == 'share_revoke':
                if urllib.parse.urlsplit(page.url).path != '/app':
                    page.goto(ORIGIN + '/app', wait_until='domcontentloaded', timeout=60000)
                _open_public_links_surface(page)
                row = _find_public_link_row(page, old_title)
                actions = row.get_by_role('button')
                if actions.count() != 2:
                    raise SafeFailure('LIFECYCLE_PUBLIC_LINK_ACTION_COUNT_INVALID')
                actions.nth(1).click(timeout=10000)
                page.wait_for_timeout(400)
                if not state['capture'] and page.get_by_role('dialog').count() == 1:
                    _dialog_button(page, re.compile(r'delete|삭제', re.I))
            else:
                page.goto(f'{ORIGIN}/app/{route_id}', wait_until='domcontentloaded', timeout=60000)
                page.wait_for_function(
                    '(value) => document.body && document.body.innerText.includes(value)',
                    arg=prompt, timeout=25000,
                )
                if old_title is not None:
                    page.wait_for_function(
                        '(value) => document.body && document.body.innerText.includes(value)',
                        arg=old_title, timeout=15000,
                    )
                if action == 'rename':
                    _open_task_row_menu(page, old_title)
                    _click_menu_item(page, re.compile(r'rename|제목|이름|수정', re.I))
                    page.wait_for_function("() => document.querySelector('[role=dialog] input')", timeout=10000)
                    inputs = page.locator('[role=dialog] input')
                    if inputs.count() != 1 or inputs.input_value(timeout=5000) != old_title:
                        raise SafeFailure('LIFECYCLE_RENAME_INPUT_NOT_BOUND')
                    inputs.fill(new_title, timeout=8000)
                    _dialog_button(page, re.compile(r'rename|update|save|제목|이름 변경|저장', re.I))
                elif action == 'share_create':
                    _open_conversation_menu(page, old_title)
                    _click_menu_item(page, re.compile(r'share|공유', re.I))
                    page.wait_for_timeout(500)
                    if not state['capture'] and page.get_by_role('dialog').count() == 1:
                        create_buttons = page.get_by_role('dialog').locator('button,[role=button]').evaluate_all(
                            """(nodes,pattern) => nodes.map((element,index) => ({element,index,
                              label:(element.getAttribute('aria-label')||element.getAttribute('title')||element.innerText||'').trim().replace(/\\s+/g,' ')}))
                              .filter(item => item.element.getClientRects().length > 0 && new RegExp(pattern,'i').test(item.label))
                              .map(item => ({index:item.index,disabled:item.element.disabled===true}))""",
                            r'create|generate|링크 만들기|링크 생성',
                        )
                        if len(create_buttons) == 1 and not create_buttons[0]['disabled']:
                            page.get_by_role('dialog').locator('button,[role=button]').nth(create_buttons[0]['index']).click(timeout=10000)
                elif action == 'delete':
                    _open_task_row_menu(page, old_title)
                    _click_menu_item(page, re.compile(r'delete|삭제', re.I))
                    page.wait_for_timeout(400)
                    if not state['capture'] and page.get_by_role('dialog').count() == 1:
                        _dialog_button(page, re.compile(r'delete|삭제', re.I))

            page.wait_for_timeout(900)
            if state['capture'] is None or state['targetCount'] != 1 or state['abortAckCount'] != 1:
                raise SafeFailure('LIFECYCLE_UI_REQUEST_CAPTURE_NOT_UNIQUE')
            if state['targetFailureCount'] != 1 or state['targetResponseCount'] != 0:
                raise SafeFailure('LIFECYCLE_BROWSER_ABORT_NOT_CONFIRMED')
            if state['parseFailureCount'] != 0 or state['nonTargetMutationCount'] != 0:
                raise SafeFailure('LIFECYCLE_GUARD_OR_TARGET_BINDING_FAILED')
            if state['unknownBlockedCount'] != 0:
                raise SafeFailure('LIFECYCLE_UNKNOWN_UI_POST_BLOCKED')
            if action == 'share_revoke':
                row = _find_public_link_row(page, old_title)
                if row.count() != 1:
                    raise SafeFailure('LIFECYCLE_REVOKE_ROW_NOT_PRESERVED_AFTER_ABORT')
                page.goto(ORIGIN + '/app', wait_until='domcontentloaded', timeout=60000)
                page.wait_for_timeout(2000)
                if urllib.parse.urlsplit(page.url).path != '/app':
                    raise SafeFailure('LIFECYCLE_APP_RESET_FAILED')
            else:
                page.goto(ORIGIN + '/app', wait_until='domcontentloaded', timeout=60000)
                page.wait_for_timeout(2000)
                parsed_page = urllib.parse.urlsplit(page.url)
                if parsed_page.hostname != 'gemini.google.com' or parsed_page.path != '/app':
                    raise SafeFailure('LIFECYCLE_APP_RESET_FAILED')
            if target_id(context, page) != role.get('targetId') or page.evaluate('() => window.name') != ROLE:
                raise SafeFailure('LIFECYCLE_ROLE_CHANGED')
            state['resetVerified'] = True
            page.remove_listener('requestfailed', request_failed)
            page.remove_listener('response', response_seen)
            page.unroute('**/*', guard)
            route_installed = False
            return state['capture'], {
                'browserRequestAborted': True,
                'browserResponseCount': state['targetResponseCount'],
                'requestFailedCount': state['targetFailureCount'],
                'abortAckCount': state['abortAckCount'],
                'unknownPostBlockedCount': state['unknownBlockedCount'],
                'blockedGetCount': state['blockedGetCount'],
                'guardParseFailureCount': state['parseFailureCount'],
                'taskRouteBound': True,
                'pageResetVerified': True,
            }
    except SafeFailure as exc:
        if page is not None:
            try:
                scratch = pathlib.Path.home() / '.nad-scratch/tmp'
                scratch.mkdir(parents=True, exist_ok=True)
                shot = scratch / f'gemini-lifecycle-{action}-blocked-20261007.png'
                page.screenshot(path=str(shot), full_page=False, timeout=5000)
                os.chmod(shot, 0o600)
                exc.screenshot = str(shot)
            except Exception:
                pass
        raise
    except Exception as exc:
        raise SafeFailure(f'LIFECYCLE_UI_{action.upper()}_CAPTURE_FAILED') from exc
    finally:
        if page is not None and route_installed:
            try:
                if urllib.parse.urlsplit(page.url).path != '/app':
                    page.goto(ORIGIN + '/app', wait_until='domcontentloaded', timeout=60000)
                page.wait_for_timeout(1000)
            except Exception:
                pass
            try:
                page.unroute('**/*', active_guard)
                page.wait_for_timeout(250)
            except Exception:
                pass


def run_lifecycle_mutation(session, owner, action, conversation_id, *, request_capture=None,
                           args=None, new_title=None, verification_query=None,
                           share_id=None, target_title=None, expected_remaining=None):
    envelope = {
        'session': copy.deepcopy(session),
        'expectedOwner': owner,
        'action': action,
        'confirmed': True,
        'callerIntent': CALLER_INTENTS[action],
    }
    if action != 'share_revoke':
        envelope['targetConversationId'] = conversation_id
    if request_capture is not None:
        envelope['requestCapture'] = copy.deepcopy(request_capture)
    if args is not None:
        envelope['args'] = copy.deepcopy(args)
    if action == 'rename':
        envelope['newTitle'] = new_title
        envelope['verificationQuery'] = verification_query
        envelope['rpcId'] = 'MUAZcd'
    elif action == 'delete':
        envelope['verificationQuery'] = verification_query
        envelope['rpcId'] = 'GzXR5e'
    elif action == 'share_create':
        envelope['targetConversationTitle'] = target_title
        envelope['expectedInitialTaskLinkCount'] = 0
        envelope['rpcId'] = 'fuVx7'
    elif action == 'share_revoke':
        envelope['targetShareId'] = share_id
        envelope['targetConversationTitle'] = target_title
        envelope['expectedRemainingTaskLinkCount'] = expected_remaining
        envelope['rpcId'] = 'SgORbf'
    else:
        clear_tree(envelope)
        raise SafeFailure('LIFECYCLE_ACTION_INVALID')
    private_fd_env = 'GEMINI_SHARE_URL_FD' if action == 'share_create' else None
    extra_env = {'GEMINI_SHARE_LINK_HANDOFF': '1'} if action == 'share_create' else None
    result, link_bytes = run_json_child(
        [str(CLI), 'lifecycle-mutation', '--envelope-stdin', '--confirm', '--output=metadata'],
        envelope, private_fd_env=private_fd_env, extra_env=extra_env,
    )
    share_url = ''
    share_id_value = ''
    if action == 'share_create':
        try:
            share_url = link_bytes.decode('utf-8').strip()
        except Exception as exc:
            link_bytes[:] = b'\0' * len(link_bytes)
            raise SafeFailure('LIFECYCLE_SHARE_LINK_HANDOFF_INVALID') from exc
        finally:
            link_bytes[:] = b'\0' * len(link_bytes)
        parsed = urllib.parse.urlsplit(share_url)
        segments = [part for part in parsed.path.split('/') if part]
        if (parsed.scheme != 'https' or parsed.hostname not in {'gemini.google.com', 'g.co'}
                or parsed.query or parsed.fragment or len(segments) != 2 or segments[0] != 'share'
                or not re.fullmatch(r'[A-Za-z0-9._~-]{8,256}', segments[1])):
            share_url = ''
            raise SafeFailure('LIFECYCLE_SHARE_URL_SHAPE_UNSUPPORTED')
        share_id_value = segments[1]
        share_url = ''
        if result.get('operation') != 'share_create' or result.get('dispatchCount') != 1:
            share_id_value = ''
            raise SafeFailure('LIFECYCLE_SHARE_CREATE_READBACK_FAILED')
    elif result.get('operation') != action or result.get('readbackVerified') is not True:
        raise SafeFailure(f'LIFECYCLE_{action.upper()}_READBACK_FAILED')
    return result, share_id_value


def public_share_read(session, share_id):
    packet = {'session': copy.deepcopy(session), 'shareId': share_id}
    result, _ = run_json_child(
        [str(CLI), 'public-share-read', '--envelope-stdin', '--output=json'], packet,
    )
    if result.get('operation') != 'share_public_read':
        if 'data' in result:
            clear_tree(result['data'])
        raise SafeFailure('LIFECYCLE_ANONYMOUS_READ_INVALID')
    return result


def contains_text(value, needle, *, substring=False, depth=0, budget=None):
    budget = budget if budget is not None else [0]
    budget[0] += 1
    if budget[0] > 100_000 or depth > 24:
        return False
    if isinstance(value, str):
        if (needle in value) if substring else (value == needle):
            return True
        candidate = value.strip()
        if candidate.startswith(('[', '{')) and len(candidate) <= 2 * 1024 * 1024:
            try:
                return contains_text(json.loads(candidate), needle, substring=substring, depth=depth + 1, budget=budget)
            except Exception:
                return False
        return False
    if isinstance(value, list):
        return any(contains_text(item, needle, substring=substring, depth=depth + 1, budget=budget) for item in value)
    if isinstance(value, dict):
        return any(contains_text(item, needle, substring=substring, depth=depth + 1, budget=budget) for item in value.values())
    return False


def safe_error_signal(value, depth=0, budget=None):
    budget = budget if budget is not None else [0]
    budget[0] += 1
    if budget[0] > 100_000 or depth > 24:
        return False
    if isinstance(value, str):
        candidate = value.strip()
        if re.search(r'not found|not available|not authorized|permission denied|deleted|unavailable|error|revoked|존재하지|사용할 수 없|삭제|권한', candidate, re.I):
            return True
        if candidate.startswith(('[', '{')) and len(candidate) <= 2 * 1024 * 1024:
            try:
                return safe_error_signal(json.loads(candidate), depth + 1, budget)
            except Exception:
                return False
    elif isinstance(value, list):
        return any(safe_error_signal(item, depth + 1, budget) for item in value)
    elif isinstance(value, dict):
        if any(re.search(r'error|status|reason|unavailable|not_found', str(key), re.I) for key in value):
            return True
        return any(safe_error_signal(item, depth + 1, budget) for item in value.values())
    return False


def empty_public_payload(value, depth=0, budget=None):
    budget = budget if budget is not None else [0]
    budget[0] += 1
    if budget[0] > 100_000 or depth > 24:
        return False
    if value is None:
        return True
    if isinstance(value, (str, int, float, bool)):
        return value == ''
    if isinstance(value, list):
        return all(empty_public_payload(item, depth + 1, budget) for item in value)
    if isinstance(value, dict):
        return all(empty_public_payload(item, depth + 1, budget) for item in value.values())
    return False


def wipe_cli_data(value):
    if isinstance(value, dict):
        if isinstance(value.get('data'), (dict, list)):
            clear_tree(value['data'])
            value['data'] = None


def persist_new_json(path, value):
    path = pathlib.Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    encoded = bytearray((json.dumps(value, ensure_ascii=True, indent=2) + '\n').encode('utf-8'))
    try:
        descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    except FileExistsError as exc:
        encoded[:] = b'\0' * len(encoded)
        raise SafeFailure('LIFECYCLE_RECEIPT_ALREADY_EXISTS') from exc
    try:
        with os.fdopen(descriptor, 'wb') as stream:
            stream.write(encoded)
            stream.flush()
            os.fsync(stream.fileno())
    finally:
        encoded[:] = b'\0' * len(encoded)
    return sha256(path.read_bytes())
