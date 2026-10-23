#!/usr/bin/env python3
"""Capture a minimal owner-scoped settings session, then call the direct HTTP CLI once."""

import argparse
import hashlib
import json
import os
import pathlib
import re
import shutil
import subprocess
import sys
import urllib.parse
from datetime import datetime, timezone

from playwright.sync_api import sync_playwright
from gemini_settings_evidence import (
    build_current_login_records,
    build_current_settings_records,
    identity_snapshot,
    implementation_snapshot,
    login_bootstrap_snapshot,
)


REPO = pathlib.Path(__file__).resolve().parent.parent
RUNTIME = pathlib.Path.home() / '.nad-scratch/provider-runtime-20261005'
OWNER_PATH = RUNTIME / 'runtime-owner.json'
ROLE_PATH = RUNTIME / 'page-role-registry.json'
CONTRACT_PATH = REPO / 'discovery/observed-contract.json'
ROLE = 'codex-gemini-settings-update-20261006'
ORIGIN = 'https://gemini.google.com'
EXPECTED_EMAIL_SHA256 = '23e57131977ce522bacf6649eb27538770828a890f7a65589ec4f0960a84b3d7'
BATCH_PATH = '/_/BardChatUi/data/batchexecute'
SAFE_READ_RPCS = {'MaZiqc', 'otAQ7b', 'hNvQHb'}
EMAIL_PATTERN = re.compile(r'[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}')
LOGIN_PAIR_PATH = REPO / 'verification/feature-evidence/login--identity--owner.json'
LOGIN_FEATURE_PATH = REPO / 'verification/features/login.json'
LOGIN_ONE_SHOT_PATH = REPO / 'verification/one-shot/gemini-owner-handoff-current-2026-10-06.json'


class SafeFailure(Exception):
    def __init__(self, code):
        self.code = code


def parse_args():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=('settings-read-one', 'settings-update-test'))
    parser.add_argument('--caller-intent', default='gemini-side-nav-settings-evidence-refresh-20261006-v3')
    parser.add_argument('--runtime-owner', default=str(OWNER_PATH))
    parser.add_argument('--role-registry', default=str(ROLE_PATH))
    parser.add_argument('--contract', default=str(CONTRACT_PATH))
    return parser.parse_args()


def read_json(path):
    try:
        return json.loads(pathlib.Path(path).read_text(encoding='utf-8'))
    except Exception as exc:
        raise SafeFailure('RUNTIME_METADATA_INVALID') from exc


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
        argv = pathlib.Path(f'/proc/{pid}/cmdline').read_bytes().decode('utf-8', 'replace')
    except Exception as exc:
        raise SafeFailure('OWNED_RUNTIME_NOT_ALIVE') from exc
    if f'--user-data-dir={profile}' not in argv or f'--remote-debugging-port={port}' not in argv:
        raise SafeFailure('OWNED_PROFILE_MISMATCH')
    active = roles.get('activePageRoles', {})
    role = active.get(ROLE, {})
    if (role.get('origin') != ORIGIN or role.get('selection') != 'cdp_target_id'
            or role.get('exactMarkerCount') != 1 or not role.get('targetId')):
        raise SafeFailure('SETTINGS_PAGE_ROLE_INVALID')
    return port, role


def batch_rpc_ids(url):
    try:
        return urllib.parse.parse_qs(urllib.parse.urlsplit(url).query, keep_blank_values=True).get('rpcids', [])
    except Exception:
        return []


def filter_headers(headers, operation, contract):
    allowed = {str(name).lower() for name in contract['operations'][operation]['request']['headerNames']}
    return {
        str(name).lower(): str(value)
        for name, value in headers.items()
        if str(name).lower() in allowed
        and str(name).lower() not in {'cookie', 'authorization', 'proxy-authorization', 'host', 'content-length'}
    }


def verified_owner_from_page(page):
    emails = {match.strip().casefold() for match in EMAIL_PATTERN.findall(page.content())}
    matches = [email for email in emails
               if hashlib.sha256(email.encode('utf-8')).hexdigest() == EXPECTED_EMAIL_SHA256]
    if len(matches) != 1:
        raise SafeFailure('EXPECTED_OWNER_NOT_UNIQUE')
    return matches[0]


def capture_one_shot_session(owner, role, contract):
    port = int(owner['cdpPort'])
    state = {
        'documentHeaders': None,
        'history': None,
        'settingsRead': None,
        'settingsUpdateHeaders': None,
        'blockedPosts': 0,
        'allowedReadPosts': 0,
        'abortedPreferenceWrites': 0,
        'preferenceAbortAck': 0,
        'preferenceFailures': 0,
        'invalidObservation': False,
    }
    page = None
    request_handler = None
    response_handler = None
    guard_handler = None
    fail_handler = None
    cookie_values = {}
    session = None
    expected_owner = ''
    try:
        with sync_playwright() as playwright:
            browser = playwright.chromium.connect_over_cdp(f'http://127.0.0.1:{port}')
            if len(browser.contexts) != 1:
                raise SafeFailure('OWNED_CONTEXT_COUNT_INVALID')
            context = browser.contexts[0]

            def target_id(candidate):
                cdp = context.new_cdp_session(candidate)
                try:
                    return cdp.send('Target.getTargetInfo').get('targetInfo', {}).get('targetId')
                finally:
                    cdp.detach()

            matches = [candidate for candidate in context.pages if target_id(candidate) == role['targetId']]
            if len(matches) != 1:
                raise SafeFailure('SETTINGS_PAGE_TARGET_NOT_UNIQUE')
            page = matches[0]
            current = urllib.parse.urlsplit(page.url)
            if current.scheme != 'https' or current.hostname != 'gemini.google.com' or not current.path.startswith('/app'):
                raise SafeFailure('SETTINGS_PAGE_PATH_INVALID')
            if page.evaluate('() => window.name') != ROLE:
                page.evaluate('(marker) => { window.name = marker; }', ROLE)
            if page.evaluate('() => window.name') != ROLE or target_id(page) != role['targetId']:
                raise SafeFailure('SETTINGS_PAGE_ROLE_BINDING_FAILED')

            def guard(route):
                try:
                    request = route.request
                    parsed = urllib.parse.urlsplit(request.url)
                    if request.method.upper() in {'GET', 'HEAD', 'OPTIONS'}:
                        if parsed.hostname in {
                            'gemini.google.com', 'gemini.gstatic.com', 'www.gstatic.com',
                            'accounts.google.com', 'lh3.googleusercontent.com',
                        }:
                            route.continue_()
                        else:
                            route.abort('blockedbyclient')
                        return
                    ids = batch_rpc_ids(request.url)
                    if parsed.hostname == 'gemini.google.com' and parsed.path == BATCH_PATH and ids == ['ESY5D']:
                        form_pairs = urllib.parse.parse_qsl(request.post_data or '', keep_blank_values=True)
                        form = urllib.parse.parse_qs(request.post_data or '', keep_blank_values=True)
                        body_fields = [name for name, _ in form_pairs]
                        if body_fields != ['f.req', 'at']:
                            state['invalidObservation'] = True
                            route.abort('blockedbyclient')
                            return
                        outer = json.loads(form['f.req'][0])
                        call = outer[0][0]
                        args = json.loads(call[1])
                        if (call[0] != 'ESY5D' or len(call) != 4 or len(args) != 2
                                or args[0] is not None or not isinstance(args[1], list)):
                            state['invalidObservation'] = True
                            route.abort('blockedbyclient')
                            return
                        f_req = json.dumps([[[
                            'ESY5D', json.dumps([None, [41]], separators=(',', ':')), *call[2:],
                        ]]], separators=(',', ':'))
                        encoded = urllib.parse.urlencode([('f.req', f_req), ('at', form['at'][0])])
                        query = urllib.parse.parse_qs(parsed.query, keep_blank_values=True)
                        if [name for name, _ in urllib.parse.parse_qsl(parsed.query, keep_blank_values=True)] != contract['operations']['settings_read']['request']['queryKeys']:
                            state['invalidObservation'] = True
                            route.abort('blockedbyclient')
                            return
                        state['settingsRead'] = {
                            'query': query,
                            'at': form['at'][0],
                            'headers': filter_headers(request.headers, 'settings_read', contract),
                            'bodyFields': body_fields,
                            'bodyBytes': len(encoded),
                        }
                        route.continue_(post_data=encoded)
                        return
                    if parsed.hostname == 'gemini.google.com' and parsed.path == BATCH_PATH and ids == ['L5adhe']:
                        state['abortedPreferenceWrites'] += 1
                        if state['settingsUpdateHeaders'] is None:
                            state['settingsUpdateHeaders'] = filter_headers(request.headers, 'settings_update', contract)
                        try:
                            route.abort('blockedbyclient')
                            state['preferenceAbortAck'] += 1
                        except Exception:
                            state['invalidObservation'] = True
                        return
                    if parsed.hostname == 'gemini.google.com' and parsed.path == BATCH_PATH and len(ids) == 1 and ids[0] in SAFE_READ_RPCS:
                        state['allowedReadPosts'] += 1
                        if ids == ['MaZiqc'] and state['history'] is None:
                            pairs = urllib.parse.parse_qsl(request.post_data or '', keep_blank_values=True)
                            form = urllib.parse.parse_qs(request.post_data or '', keep_blank_values=True)
                            try:
                                outer = json.loads(form['f.req'][0])
                                call = outer[0][0]
                                args = json.loads(call[1])
                                if (call[0] != 'MaZiqc' or len(call) != 4 or not isinstance(args, list)
                                        or len(args) != 3 or not isinstance(args[0], int) or args[1] is not None
                                        or not isinstance(args[2], list) or len(args[2]) != 3
                                        or not isinstance(args[2][0], int) or args[2][1] is not None
                                        or not isinstance(args[2][2], int)):
                                    raise ValueError()
                                if args[2][0] == 0:
                                    state['history'] = {
                                        'args': args,
                                        'headers': filter_headers(request.headers, 'history_list', contract),
                                        'requestId': int(urllib.parse.parse_qs(parsed.query)['_reqid'][0]),
                                    }
                            except Exception:
                                state['invalidObservation'] = True
                        route.continue_()
                        return
                    state['blockedPosts'] += 1
                    route.abort('blockedbyclient')
                except SafeFailure:
                    state['invalidObservation'] = True
                    try:
                        route.abort('blockedbyclient')
                    except Exception:
                        pass
                except Exception:
                    state['invalidObservation'] = True
                    try:
                        route.abort('blockedbyclient')
                    except Exception:
                        pass

            def on_request(request):
                parsed = urllib.parse.urlsplit(request.url)
                if request.resource_type == 'document' and parsed.hostname == 'gemini.google.com' and parsed.path == '/app':
                    state['documentHeaders'] = filter_headers(request.headers, 'identity', contract)

            def on_failure(request):
                if batch_rpc_ids(request.url) == ['L5adhe']:
                    state['preferenceFailures'] += 1

            def on_response(response):
                if state['settingsRead'] and response.request.resource_type in {'xhr', 'fetch'}:
                    parsed = urllib.parse.urlsplit(response.url)
                    if parsed.hostname == 'gemini.google.com' and parsed.path == BATCH_PATH and batch_rpc_ids(response.url) == ['ESY5D']:
                        state['settingsRead']['status'] = response.status
                        state['settingsRead']['mime'] = response.headers.get('content-type', '').split(';', 1)[0].lower()

            guard_handler = guard
            request_handler = on_request
            response_handler = on_response
            fail_handler = on_failure
            page.route('**/*', guard_handler)
            page.route_web_socket('wss://gemini.google.com/**', lambda websocket: websocket.close(code=1000, reason='settings-session-capture'))
            page.on('request', request_handler)
            page.on('requestfailed', fail_handler)
            page.on('response', response_handler)
            page.reload(wait_until='domcontentloaded', timeout=90000)
            page.wait_for_timeout(6500)
            if page.evaluate('() => window.name') != ROLE:
                page.evaluate('(marker) => { window.name = marker; }', ROLE)
            if page.evaluate('() => window.name') != ROLE or target_id(page) != role['targetId']:
                raise SafeFailure('SETTINGS_PAGE_ROLE_BINDING_FAILED')
            if state['invalidObservation'] or not state['settingsRead'] or not state['history'] or not state['documentHeaders']:
                raise SafeFailure('SETTINGS_SESSION_CAPTURE_INCOMPLETE')
            if state['settingsRead'].get('status') != 200 or state['settingsRead'].get('mime') != 'application/json':
                raise SafeFailure('SETTINGS_READ_CAPTURE_FAILED')
            if state['abortedPreferenceWrites'] and state['preferenceAbortAck'] != state['abortedPreferenceWrites']:
                raise SafeFailure('PREFERENCE_ABORT_UNCONFIRMED')
            if state['preferenceFailures'] < state['preferenceAbortAck']:
                page.wait_for_timeout(400)
            expected_owner = verified_owner_from_page(page)
            if page.evaluate('() => window.name') != ROLE or target_id(page) != role['targetId']:
                raise SafeFailure('SETTINGS_PAGE_ROLE_BINDING_FAILED')
            cookie_names = set(contract['auth']['cookieNames'])
            captured = [cookie for cookie in context.cookies(ORIGIN) if cookie.get('name') in cookie_names]
            if {cookie.get('name') for cookie in captured} != cookie_names:
                raise SafeFailure('SESSION_COOKIE_SET_INCOMPLETE')
            cookie_values = {cookie['name']: cookie['value'] for cookie in captured}
            request_id = max(state['history']['requestId'], int(state['settingsRead']['query']['_reqid'][0])) + 1
            batch = state['settingsRead']['query']
            session = {
                'version': 1,
                'service': contract['service'],
                'origin': ORIGIN,
                'capturedAt': datetime.now(timezone.utc).isoformat(),
                'cookies': [
                    {'name': name, 'value': value}
                    for name, value in cookie_values.items()
                ],
                'headers': {},
                'requestHeaders': {
                    'identity': state['documentHeaders'],
                    'history_list': state['history']['headers'],
                    'settings_read': state['settingsRead']['headers'],
                    'settings_update': state['settingsUpdateHeaders'] or state['settingsRead']['headers'],
                },
                'batchContext': {
                    'at': state['settingsRead']['at'],
                    'fSid': batch['f.sid'][0],
                    'buildLabel': batch['bl'][0],
                    'locale': batch['hl'][0],
                    'requestType': batch['rt'][0],
                    'sourcePath': batch['source-path'][0],
                    'requestId': str(request_id),
                    'historyListArgs': state['history']['args'],
                },
            }
            page.remove_listener('request', request_handler)
            page.remove_listener('requestfailed', fail_handler)
            page.remove_listener('response', response_handler)
            page.unroute('**/*', guard_handler)
            try:
                page.unroute_web_socket('wss://gemini.google.com/**')
            except Exception:
                pass
            page.wait_for_timeout(300)
    except SafeFailure:
        raise
    except Exception as exc:
        raise SafeFailure('SETTINGS_SESSION_CAPTURE_FAILED') from exc

    if not session or not expected_owner:
        raise SafeFailure('SETTINGS_SESSION_CAPTURE_INCOMPLETE')
    return session, expected_owner, state, cookie_values


def safe_cli_result(stdout_text, action, caller_intent=''):
    try:
        result = json.loads(stdout_text)
    except Exception as exc:
        raise SafeFailure('SETTINGS_CLI_OUTPUT_INVALID') from exc
    if action == 'settings-read-one':
        value = result.get('result', {})
        return {
            'operation': 'settings_read',
            'ownerMatched': result.get('ownerMatched') is True,
            'anonymousOwnerAbsent': result.get('anonymousOwnerAbsent') is True,
            'outputStatus': result.get('outputStatus'),
            'sessionContextRefreshed': result.get('sessionContextRefreshed') is True,
            'preferenceKey': value.get('preferenceKey'),
            'found': value.get('found') is True,
            'valueType': value.get('valueType'),
            'value': value.get('value') if value.get('found') is True else None,
            'httpStatus': value.get('httpStatus'),
            'responseBytes': value.get('responseBytes'),
            'responseSha256': value.get('responseSha256'),
            'requestFieldIds': value.get('request', {}).get('preferenceFieldIds'),
            'identityRead': value.get('identityRead'),
            'credentialPropagated': value.get('credentialPropagated') is True,
            'request': value.get('request'),
        }
    value = result.get('result', {})
    applied = value.get('applied', {})
    restored = value.get('restored', {})
    baseline = value.get('baselineRead', {})
    return {
        'operation': 'settings_update',
        'ownerMatched': result.get('ownerMatched') is True,
        'anonymousOwnerAbsent': result.get('anonymousOwnerAbsent') is True,
        'outputStatus': result.get('outputStatus'),
        'callerIntentCorrelationId': value.get('callerIntentCorrelationId') or caller_intent,
        'preferenceKey': value.get('preferenceKey'),
        'baselineValue': value.get('baselineValue'),
        'testValue': value.get('testValue'),
        'writesSent': value.get('writesSent'),
        'restoredToBaseline': value.get('restoredToBaseline') is True,
        'baselineRead': {
            'operation': baseline.get('operation'),
            'rpcId': baseline.get('rpcId'),
            'httpStatus': baseline.get('httpStatus'),
            'contentType': baseline.get('contentType'),
            'responseBytes': baseline.get('responseBytes'),
            'responseSha256': baseline.get('responseSha256'),
            'credentialPropagated': baseline.get('credentialPropagated'),
            'request': baseline.get('request'),
            'found': baseline.get('found'),
            'valueType': baseline.get('valueType'),
            'value': baseline.get('value'),
            'identityRead': baseline.get('identityRead'),
        },
        'ownerIdentityEvidence': restored.get('readback', {}).get('identityRead'),
        'apply': {
            'outcome': applied.get('outcome'),
            'request': applied.get('request'),
            'httpStatus': applied.get('dispatch', {}).get('httpStatus'),
            'contentType': applied.get('dispatch', {}).get('response', {}).get('contentType'),
            'responseBytes': applied.get('dispatch', {}).get('responseBytes'),
            'responseSha256': applied.get('dispatch', {}).get('responseSha256'),
            'dispatchCount': applied.get('dispatch', {}).get('dispatchCount'),
            'responseRpcMatched': applied.get('dispatch', {}).get('responseRpcMatched'),
            'providerErrorFieldOne': applied.get('dispatch', {}).get('providerErrorFieldOne'),
            'readbackValue': applied.get('readback', {}).get('value'),
            'readbackMatched': applied.get('readback', {}).get('matchedRequestedValue'),
            'readbackHttpStatus': applied.get('readback', {}).get('httpStatus'),
            'readbackContentType': applied.get('readback', {}).get('contentType'),
            'readbackResponseBytes': applied.get('readback', {}).get('responseBytes'),
            'readbackResponseSha256': applied.get('readback', {}).get('responseSha256'),
            'readbackRequest': applied.get('readback', {}).get('request'),
            'readbackRpcId': applied.get('readback', {}).get('rpcId'),
            'readbackIdentityRead': applied.get('readback', {}).get('identityRead'),
            'journalState': applied.get('dispatch', {}).get('journalState'),
        },
        'restore': {
            'outcome': restored.get('outcome'),
            'request': restored.get('request'),
            'httpStatus': restored.get('dispatch', {}).get('httpStatus'),
            'contentType': restored.get('dispatch', {}).get('response', {}).get('contentType'),
            'responseBytes': restored.get('dispatch', {}).get('responseBytes'),
            'responseSha256': restored.get('dispatch', {}).get('responseSha256'),
            'dispatchCount': restored.get('dispatch', {}).get('dispatchCount'),
            'responseRpcMatched': restored.get('dispatch', {}).get('responseRpcMatched'),
            'providerErrorFieldOne': restored.get('dispatch', {}).get('providerErrorFieldOne'),
            'readbackValue': restored.get('readback', {}).get('value'),
            'readbackMatched': restored.get('readback', {}).get('matchedRequestedValue'),
            'readbackHttpStatus': restored.get('readback', {}).get('httpStatus'),
            'readbackContentType': restored.get('readback', {}).get('contentType'),
            'readbackResponseBytes': restored.get('readback', {}).get('responseBytes'),
            'readbackResponseSha256': restored.get('readback', {}).get('responseSha256'),
            'readbackRequest': restored.get('readback', {}).get('request'),
            'readbackRpcId': restored.get('readback', {}).get('rpcId'),
            'readbackIdentityRead': restored.get('readback', {}).get('identityRead'),
            'journalState': restored.get('dispatch', {}).get('journalState'),
        },
        'automaticRetry': False,
    }


def run_cli(action, session, expected_owner, caller_intent, contract_path,
            expected_source_snapshot=None, expected_identity_snapshot=None,
            expected_login_snapshot=None):
    node = shutil.which('node')
    if not node:
        raise SafeFailure('NODE_RUNTIME_UNAVAILABLE')
    packet = {
        'session': session,
        'preferenceKey': 'side_nav_open_by_default',
    }
    if action == 'settings-update-test':
        packet['baselineValue'] = True
    command = [node, str(REPO / 'src/cli.mjs'), action, '--envelope-stdin', '--expect-owner', expected_owner]
    if action == 'settings-update-test':
        command.extend(['--caller-intent', caller_intent, '--confirm'])
    source_before = implementation_snapshot(REPO, contract_path)
    identity_before = identity_snapshot(REPO, contract_path)
    login_source_before = login_bootstrap_snapshot(REPO)
    if ((expected_source_snapshot is not None and source_before != expected_source_snapshot)
            or (expected_identity_snapshot is not None and identity_before != expected_identity_snapshot)
            or (expected_login_snapshot is not None and login_source_before != expected_login_snapshot)):
        for cookie in packet.get('session', {}).get('cookies', []):
            cookie['value'] = ''
        packet.clear()
        raise SafeFailure('SETTINGS_SOURCE_PREFLIGHT_FAILED')
    owner_hash_before = hashlib.sha256(expected_owner.strip().casefold().encode('utf-8')).hexdigest()
    try:
        completed = subprocess.run(
            command,
            input=json.dumps(packet, separators=(',', ':')),
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=180,
            check=False,
        )
    finally:
        for cookie in packet.get('session', {}).get('cookies', []):
            cookie['value'] = ''
        packet.clear()
    if completed.returncode != 0:
        code = next((line for line in completed.stderr.splitlines() if re.fullmatch(r'[A-Z][A-Z0-9_]{1,63}', line)), 'SETTINGS_CLI_FAILED')
        raise SafeFailure(code)
    result = safe_cli_result(completed.stdout, action, caller_intent)
    completed.stdout = ''
    completed.stderr = ''
    owner_hash_after = hashlib.sha256(expected_owner.strip().casefold().encode('utf-8')).hexdigest()
    result['_producerEvidence'] = {
        'sourceBeforeImports': source_before,
        'sourceAfterRun': implementation_snapshot(REPO, contract_path),
        'identitySourceBeforeImports': identity_before,
        'identitySourceAfterRun': identity_snapshot(REPO, contract_path),
        'loginSourceBeforeImports': login_source_before,
        'loginSourceAfterRun': login_bootstrap_snapshot(REPO),
        'expectedOwnerSha256': owner_hash_before,
        'expectedOwnerSha256AfterRun': owner_hash_after,
        'expectedOwnerImmutable': owner_hash_before == owner_hash_after == EXPECTED_EMAIL_SHA256,
    }
    result['_producerEvidence']['sourceSnapshotStable'] = (
        result['_producerEvidence']['sourceBeforeImports'] == result['_producerEvidence']['sourceAfterRun']
        and result['_producerEvidence']['identitySourceBeforeImports'] == result['_producerEvidence']['identitySourceAfterRun']
        and result['_producerEvidence']['loginSourceBeforeImports'] == result['_producerEvidence']['loginSourceAfterRun']
    )
    expected_owner = ''
    return result


def json_bytes(value):
    return (json.dumps(value, ensure_ascii=True, indent=2) + '\n').encode('utf-8')


def sha256_bytes(value):
    return hashlib.sha256(value).hexdigest()


def write_new_json(path, value):
    path = pathlib.Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    encoded = json_bytes(value)
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        with os.fdopen(descriptor, 'wb') as stream:
            stream.write(encoded)
            stream.flush()
            os.fsync(stream.fileno())
    except Exception:
        try:
            path.unlink()
        except OSError:
            pass
        raise
    return sha256_bytes(encoded)


def replace_generated_json(path, value):
    path = pathlib.Path(path)
    encoded = json_bytes(value)
    temporary = path.with_name(path.name + '.refresh.tmp')
    try:
        descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(descriptor, 'wb') as stream:
            stream.write(encoded)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    finally:
        try:
            temporary.unlink()
        except FileNotFoundError:
            pass
    return sha256_bytes(encoded)


def replace_json_with_backup(path, value, backup_path):
    path = pathlib.Path(path)
    backup_path = pathlib.Path(backup_path)
    backup_path.parent.mkdir(parents=True, exist_ok=True)
    old_bytes = path.read_bytes()
    descriptor = os.open(backup_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(descriptor, 'wb') as stream:
        stream.write(old_bytes)
        stream.flush()
        os.fsync(stream.fileno())
    encoded = json_bytes(value)
    temporary = path.with_name(path.name + '.settings-refresh.tmp')
    try:
        descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(descriptor, 'wb') as stream:
            stream.write(encoded)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    finally:
        try:
            temporary.unlink()
        except FileNotFoundError:
            pass
    return sha256_bytes(encoded), sha256_bytes(old_bytes)


def identity_feature_receipt(contract_hash, identity_code, identity_pair_hash):
    path = 'verification/feature-evidence/identity--identity--owner.json'
    return {
        'schema': 'gemini-feature-live-receipt-v1',
        'service': 'gemini-web',
        'featureId': 'identity',
        'outcome': 'verified',
        'checkedAt': datetime.now(timezone.utc).isoformat(),
        'evidenceClass': 'direct_http_live',
        'transport': 'direct_http',
        'executionHost': 'linux_worker',
        'mocked': False,
        'publicOnly': False,
        'authenticatedOwnerVerified': True,
        'secretsPersisted': False,
        'contractSha256': contract_hash,
        'implementationFiles': identity_code['implementationFiles'],
        'implementationSetSha256': identity_code['implementationSetSha256'],
        'ownerIdentityEvidence': {
            'path': path,
            'sha256': identity_pair_hash,
            'implementationFiles': identity_code['implementationFiles'],
            'implementationSetSha256': identity_code['implementationSetSha256'],
        },
        'operationEvidence': [{
            'operationId': 'identity', 'caseId': 'owner', 'path': path,
            'sha256': identity_pair_hash,
        }],
    }


def live_settings_receipt(result, producer, browser_state):
    return {
        'schema': 'gemini-settings-update-live-verification-v2',
        'service': 'gemini-web',
        'operation': 'settings_update',
        'recordedAt': datetime.now(timezone.utc).isoformat(),
        'executionHost': 'linux_worker',
        'pageRole': ROLE,
        'ownerProbe': {
            'ownerMatched': result.get('ownerMatched') is True,
            'anonymousOwnerAbsent': result.get('anonymousOwnerAbsent') is True,
            'expectedOwnerSha256': producer['expectedOwnerSha256'],
            'expectedOwnerSha256AfterRun': producer['expectedOwnerSha256AfterRun'],
            'expectedOwnerImmutableDuringCli': producer['expectedOwnerImmutable'],
            'expectedOwnerPersisted': False,
        },
        'sourceBeforeImports': producer['sourceBeforeImports'],
        'sourceAfterRun': producer['sourceAfterRun'],
        'sourceSnapshotStable': producer['sourceSnapshotStable'],
        'identitySourceBeforeImports': producer['identitySourceBeforeImports'],
        'identitySourceAfterRun': producer['identitySourceAfterRun'],
        'controlledTest': {
            'operation': result.get('operation'),
            'outcome': result.get('outputStatus'),
            'callerIntentCorrelationId': result.get('callerIntentCorrelationId'),
            'preferenceKey': result.get('preferenceKey'),
            'baselineValue': result.get('baselineValue'),
            'testValue': result.get('testValue'),
            'writesSent': result.get('writesSent'),
            'restoredToBaseline': result.get('restoredToBaseline'),
            'baselineRead': result.get('baselineRead'),
            'apply': result.get('apply'),
            'restore': result.get('restore'),
            'automaticRetry': False,
        },
        'browserCapture': {
            'startupPreferenceWritesAborted': browser_state.get('abortedPreferenceWrites', 0),
            'startupPreferenceAbortAcknowledged': browser_state.get('preferenceAbortAck', 0),
            'browserBusinessWrites': browser_state.get('businessWritesFromBrowser', 0),
            'otherPostsBlocked': browser_state.get('blockedPosts', 0),
        },
        'persistence': {
            'expectedOwnerPersisted': False,
            'emailPersisted': False,
            'cookiesPersisted': False,
            'tokensPersisted': False,
            'requestValuesPersisted': False,
            'responseValuesPersisted': False,
            'requestBodiesPersisted': False,
            'responseBodiesPersisted': False,
        },
    }


def preflight_login_paths(contract_hash, identity_code, expected_owner_sha256):
    if LOGIN_PAIR_PATH.exists() or LOGIN_FEATURE_PATH.exists() or LOGIN_ONE_SHOT_PATH.exists():
        raise SafeFailure('LOGIN_EVIDENCE_ALREADY_EXISTS')
    identity_pair_path = REPO / 'verification/feature-evidence/identity--identity--owner.json'
    identity_receipt_path = REPO / 'verification/features/identity.json'
    settings_live_path = REPO / 'verification/one-shot/gemini-settings-update-live-v2-2026-10-06.json'
    try:
        pair_bytes = identity_pair_path.read_bytes()
        identity_receipt = json.loads(identity_receipt_path.read_text(encoding='utf-8'))
        settings_live = json.loads(settings_live_path.read_text(encoding='utf-8'))
        pair = json.loads(pair_bytes.decode('utf-8'))
    except Exception as exc:
        raise SafeFailure('LOGIN_OWNER_IDENTITY_EVIDENCE_MISSING') from exc
    owner_ref = identity_receipt.get('ownerIdentityEvidence', {})
    pair_hash = hashlib.sha256(pair_bytes).hexdigest()
    if (identity_receipt.get('contractSha256') != contract_hash
            or owner_ref.get('path') != 'verification/feature-evidence/identity--identity--owner.json'
            or owner_ref.get('sha256') != pair_hash
            or owner_ref.get('implementationSetSha256') != identity_code.get('implementationSetSha256')
            or pair.get('identityMatchVerified') is not True
            or pair.get('response', {}).get('status') != 200
            or settings_live.get('ownerProbe', {}).get('expectedOwnerSha256') != expected_owner_sha256
            or settings_live.get('sourceSnapshotStable') is not True
            or settings_live.get('canonicalEvidence', {}).get('identityPairSha256') != pair_hash):
        raise SafeFailure('LOGIN_OWNER_IDENTITY_EVIDENCE_STALE')
    return owner_ref


def persist_login_evidence(read_result, producer, browser_state, expected_owner_sha256, owner_ref):
    if not producer.get('sourceSnapshotStable') or not producer.get('expectedOwnerImmutable'):
        raise SafeFailure('LOGIN_SOURCE_PREFLIGHT_FAILED')
    try:
        records = build_current_login_records(
            read_result={**read_result, 'contractSha256': producer['sourceBeforeImports']['contractSha256']},
            source_stable=producer['sourceSnapshotStable'],
            owner_sha256_before=producer['expectedOwnerSha256'],
            owner_sha256_after=producer['expectedOwnerSha256AfterRun'],
            login_source_before=producer['loginSourceBeforeImports'],
            login_source_after=producer['loginSourceAfterRun'],
            identity_source=producer['identitySourceBeforeImports'],
            existing_owner_identity_ref=owner_ref,
            expected_owner_sha256=expected_owner_sha256,
            session_handoff_verified=read_result.get('sessionContextRefreshed') is True,
            native_browser_profile=True,
        )
    except (KeyError, TypeError, ValueError) as exc:
        raise SafeFailure('LOGIN_EVIDENCE_PREFLIGHT_FAILED') from exc
    pair_bytes = json_bytes(records['identityPair'])
    pair_hash = sha256_bytes(pair_bytes)
    receipt = records['receipt']
    receipt['operationEvidence'][0]['sha256'] = pair_hash
    feature_bytes = json_bytes(receipt)
    feature_hash = sha256_bytes(feature_bytes)
    direct_identity = read_result['identityRead']
    one_shot = {
        'schema': 'gemini-current-owner-handoff-live-v1',
        'service': 'gemini-web',
        'operation': 'login_session_handoff',
        'recordedAt': datetime.now(timezone.utc).isoformat(),
        'executionHost': 'linux_worker',
        'pageRole': ROLE,
        'ownerProbe': {
            'ownerMatched': read_result.get('ownerMatched') is True,
            'anonymousOwnerAbsent': read_result.get('anonymousOwnerAbsent') is True,
            'expectedOwnerSha256': producer['expectedOwnerSha256'],
            'expectedOwnerSha256AfterRun': producer['expectedOwnerSha256AfterRun'],
            'expectedOwnerImmutable': producer['expectedOwnerImmutable'],
            'expectedOwnerPersisted': False,
        },
        'providerAuthenticatedSessionObserved': True,
        'nativeBrowserProfile': True,
        'sessionHandoffVerified': read_result.get('sessionContextRefreshed') is True,
        'passwordSubmittedToProviderApi': False,
        'challengeBypassUsed': False,
        'sourceBeforeImports': producer['sourceBeforeImports'],
        'sourceAfterRun': producer['sourceAfterRun'],
        'identitySourceBeforeImports': producer['identitySourceBeforeImports'],
        'identitySourceAfterRun': producer['identitySourceAfterRun'],
        'loginSourceBeforeImports': producer['loginSourceBeforeImports'],
        'loginSourceAfterRun': producer['loginSourceAfterRun'],
        'sourceStableDuringExecution': producer['sourceSnapshotStable'],
        'identityHttpStatus': direct_identity.get('httpStatus'),
        'identityResponseBytes': direct_identity.get('responseBytes'),
        'identityResponseSha256': direct_identity.get('responseSha256'),
        'identityAnonymousHttpStatus': direct_identity.get('anonymousHttpStatus'),
        'identityCredentialPropagated': direct_identity.get('credentialPropagated') is True,
        'preferenceReadHttpStatus': read_result.get('httpStatus'),
        'preferenceReadResponseBytes': read_result.get('responseBytes'),
        'preferenceReadResponseSha256': read_result.get('responseSha256'),
        'startupPreferenceWritesAborted': browser_state.get('abortedPreferenceWrites', 0),
        'startupPreferenceAbortAcknowledged': browser_state.get('preferenceAbortAck', 0),
        'browserBusinessWrites': 0,
        'identityEvidence': {
            'path': owner_ref['path'],
            'sha256': owner_ref['sha256'],
        },
        'canonicalEvidence': {
            'loginReceiptPath': 'verification/features/login.json',
            'loginReceiptSha256': feature_hash,
            'loginPairPath': records['pairPath'],
            'loginPairSha256': pair_hash,
        },
        'persistence': {
            'expectedOwnerPersisted': False,
            'emailPersisted': False,
            'cookiesPersisted': False,
            'tokensPersisted': False,
            'requestValuesPersisted': False,
            'responseValuesPersisted': False,
            'requestBodiesPersisted': False,
            'responseBodiesPersisted': False,
        },
    }
    pair_digest = write_new_json(LOGIN_PAIR_PATH, records['identityPair'])
    if pair_digest != pair_hash:
        raise SafeFailure('LOGIN_PAIR_HASH_MISMATCH')
    feature_digest = write_new_json(LOGIN_FEATURE_PATH, receipt)
    if feature_digest != feature_hash:
        raise SafeFailure('LOGIN_RECEIPT_HASH_MISMATCH')
    one_shot_digest = write_new_json(LOGIN_ONE_SHOT_PATH, one_shot)
    return {
        'status': 'verified',
        'loginReceiptPath': str(LOGIN_FEATURE_PATH.relative_to(REPO)),
        'loginReceiptSha256': feature_digest,
        'loginPairPath': str(LOGIN_PAIR_PATH.relative_to(REPO)),
        'loginPairSha256': pair_digest,
        'oneShotPath': str(LOGIN_ONE_SHOT_PATH.relative_to(REPO)),
        'oneShotSha256': one_shot_digest,
    }


def receipt_paths_preflight(source_snapshot):
    required_existing = [
        REPO / 'verification/feature-evidence/identity--identity--owner.json',
        REPO / 'verification/features/identity.json',
    ]
    if any(not path.is_file() for path in required_existing):
        raise SafeFailure('SETTINGS_IDENTITY_EVIDENCE_MISSING')
    settings_paths = [
        REPO / 'verification/feature-evidence/settings--settings_read--before.json',
        REPO / 'verification/feature-evidence/settings--settings_update--update.json',
        REPO / 'verification/feature-evidence/settings--settings_read--after.json',
        REPO / 'verification/features/settings.json',
        REPO / 'verification/one-shot/gemini-settings-update-live-v2-2026-10-06.json',
        REPO / 'verification/one-shot/gemini-identity-pair-prior-to-settings-refresh-'
        f"{source_snapshot['implementationSetSha256'][:12]}.json",
        REPO / 'verification/one-shot/gemini-identity-receipt-prior-to-settings-refresh-'
        f"{source_snapshot['implementationSetSha256'][:12]}.json",
    ]
    if any(path.exists() for path in settings_paths):
        raise SafeFailure('SETTINGS_EVIDENCE_ALREADY_EXISTS')


def login_paths_preflight():
    if LOGIN_PAIR_PATH.exists() or LOGIN_FEATURE_PATH.exists() or LOGIN_ONE_SHOT_PATH.exists():
        raise SafeFailure('LOGIN_EVIDENCE_ALREADY_EXISTS')


def persist_current_settings_evidence(result, producer, browser_state):
    if not producer.get('sourceSnapshotStable') or not producer.get('expectedOwnerImmutable'):
        raise SafeFailure('SETTINGS_EVIDENCE_PREFLIGHT_FAILED')
    try:
        records = build_current_settings_records(
            run=result,
            source_before_imports=producer['sourceBeforeImports'],
            source_after_run=producer['sourceAfterRun'],
            identity_before_imports=producer['identitySourceBeforeImports'],
            expected_owner_sha256=producer['expectedOwnerSha256'],
            expected_owner_immutable=producer['expectedOwnerImmutable'],
            browser_writes=browser_state.get('businessWritesFromBrowser', 0),
        )
    except (KeyError, TypeError, ValueError) as exc:
        raise SafeFailure('SETTINGS_EVIDENCE_PREFLIGHT_FAILED') from exc

    identity_pair_path = REPO / 'verification/feature-evidence/identity--identity--owner.json'
    identity_receipt_path = REPO / 'verification/features/identity.json'
    settings_pair_paths = {
        'beforePair': REPO / 'verification/feature-evidence/settings--settings_read--before.json',
        'updatePair': REPO / 'verification/feature-evidence/settings--settings_update--update.json',
        'afterPair': REPO / 'verification/feature-evidence/settings--settings_read--after.json',
    }
    settings_receipt_path = REPO / 'verification/features/settings.json'
    identity_backup = REPO / 'verification/one-shot' / (
        f"gemini-identity-pair-prior-to-settings-refresh-{producer['sourceBeforeImports']['implementationSetSha256'][:12]}.json"
    )
    identity_receipt_backup = REPO / 'verification/one-shot' / (
        f"gemini-identity-receipt-prior-to-settings-refresh-{producer['sourceBeforeImports']['implementationSetSha256'][:12]}.json"
    )
    targets = [*settings_pair_paths.values(), settings_receipt_path, identity_backup, identity_receipt_backup]
    if any(path.exists() for path in targets):
        raise SafeFailure('SETTINGS_EVIDENCE_ALREADY_EXISTS')
    identity_digest = sha256_bytes(json_bytes(records['identityPair']))
    new_pair_hashes = {name: sha256_bytes(json_bytes(records[name])) for name in settings_pair_paths}
    receipt = records['settingsReceipt']
    receipt['ownerIdentityEvidence']['sha256'] = identity_digest
    for reference, name in zip(receipt['operationEvidence'], settings_pair_paths, strict=True):
        reference['sha256'] = new_pair_hashes[name]
    current_identity_receipt = identity_feature_receipt(
        producer['sourceBeforeImports']['contractSha256'],
        producer['identitySourceBeforeImports'], identity_digest,
    )
    receipt_bytes = json_bytes(receipt)
    receipt_digest = sha256_bytes(receipt_bytes)
    for path in settings_pair_paths.values():
        path.parent.mkdir(parents=True, exist_ok=True)
    for name, path in settings_pair_paths.items():
        write_new_json(path, records[name])
    replaced_pair_digest, old_pair_digest = replace_json_with_backup(identity_pair_path, records['identityPair'], identity_backup)
    if replaced_pair_digest != identity_digest:
        raise SafeFailure('SETTINGS_IDENTITY_EVIDENCE_HASH_MISMATCH')
    try:
        _, old_identity_receipt_digest = replace_json_with_backup(
            identity_receipt_path, current_identity_receipt, identity_receipt_backup,
        )
    except Exception:
        raise SafeFailure('SETTINGS_IDENTITY_EVIDENCE_UPDATE_FAILED')
    settings_receipt_digest = write_new_json(settings_receipt_path, receipt)
    return {
        'status': 'verified',
        'settingsReceiptPath': str(settings_receipt_path.relative_to(REPO)),
        'settingsReceiptSha256': settings_receipt_digest,
        'identityPairPath': str(identity_pair_path.relative_to(REPO)),
        'identityPairSha256': identity_digest,
        'replacedIdentityPairSha256': old_pair_digest,
        'identityReceiptBackupSha256': old_identity_receipt_digest,
        'identityBackupPaths': {
            'pair': str(identity_backup.relative_to(REPO)),
            'receipt': str(identity_receipt_backup.relative_to(REPO)),
        },
        'pairPaths': {name: str(path.relative_to(REPO)) for name, path in settings_pair_paths.items()},
        'pairSha256': new_pair_hashes,
    }


def wipe_session(session, cookie_values):
    for cookie in session.get('cookies', []):
        cookie['value'] = ''
    session['cookies'] = []
    session['headers'] = {}
    session['requestHeaders'] = {}
    session['batchContext'] = {}
    cookie_values.clear()


def main():
    args = parse_args()
    if pathlib.Path(args.contract).resolve() != CONTRACT_PATH.resolve():
        raise SafeFailure('SETTINGS_CONTRACT_PATH_BLOCKED')
    if args.action == 'settings-update-test' and not re.fullmatch(r'[A-Za-z0-9_-]{12,100}', args.caller_intent):
        raise SafeFailure('SETTINGS_INTENT_INVALID')
    owner = read_json(args.runtime_owner)
    roles = read_json(args.role_registry)
    port, role = verify_runtime(owner, roles)
    contract = read_json(args.contract)
    if (contract.get('service') != 'gemini-web'
            or 'settings_read' not in contract.get('operations', {})
            or 'settings_update' not in contract.get('operations', {})):
        raise SafeFailure('SETTINGS_CONTRACT_INVALID')
    session = None
    cookie_values = {}
    expected_owner = ''
    state = {}
    try:
        if args.action == 'settings-read-one':
            login_paths_preflight()
        session, expected_owner, state, cookie_values = capture_one_shot_session(owner, role, contract)
        preflight_snapshot = implementation_snapshot(REPO, args.contract)
        preflight_identity = identity_snapshot(REPO, args.contract)
        preflight_login = login_bootstrap_snapshot(REPO)
        if preflight_snapshot['contractSha256'] != implementation_snapshot(REPO, CONTRACT_PATH)['contractSha256']:
            raise SafeFailure('SETTINGS_SOURCE_PREFLIGHT_FAILED')
        if args.action == 'settings-update-test':
            receipt_paths_preflight(preflight_snapshot)
        login_owner_ref = None
        if args.action == 'settings-read-one':
            expected_owner_sha = hashlib.sha256(expected_owner.strip().casefold().encode('utf-8')).hexdigest()
            login_owner_ref = preflight_login_paths(
                preflight_snapshot['contractSha256'], preflight_identity, expected_owner_sha,
            )
        result = run_cli(args.action, session, expected_owner,
                         args.caller_intent if args.action == 'settings-update-test' else '', args.contract,
                         expected_source_snapshot=preflight_snapshot,
                         expected_identity_snapshot=preflight_identity,
                         expected_login_snapshot=preflight_login)
        producer = result.pop('_producerEvidence')
        live_receipt_path = REPO / 'verification/one-shot/gemini-settings-update-live-v2-2026-10-06.json'
        canonical_status = None
        if args.action == 'settings-update-test':
            live_receipt = live_settings_receipt(result, producer, state)
            live_receipt_sha = write_new_json(live_receipt_path, live_receipt)
            if result.get('outputStatus') == 'verified_and_restored':
                try:
                    canonical_status = persist_current_settings_evidence(result, producer, state)
                except SafeFailure as error:
                    canonical_status = {'status': 'not_written', 'reason': error.code}
            else:
                canonical_status = {'status': 'not_written', 'reason': 'SETTINGS_LIVE_OUTCOME_UNVERIFIED'}
            live_receipt['canonicalEvidence'] = canonical_status
            live_receipt_sha = replace_generated_json(live_receipt_path, live_receipt)
        elif args.action == 'settings-read-one':
            try:
                canonical_status = persist_login_evidence(
                    result, producer, state, producer['expectedOwnerSha256'], login_owner_ref,
                )
            except SafeFailure as error:
                canonical_status = {'status': 'not_written', 'reason': error.code}
        summary = {
            'executionHost': 'linux_worker',
            'pageRole': ROLE,
            'pageTargetRegistered': True,
            'uiOwnerHashMatched': True,
            'settingsReadSelectorSent': [41],
            'browserPreferenceUpdatesAborted': state.get('abortedPreferenceWrites', 0),
            'browserPreferenceAbortAcknowledged': state.get('preferenceAbortAck', 0),
            'businessWritesFromBrowser': 0,
            'otherPostsBlocked': state.get('blockedPosts', 0),
            'result': result,
            'ownerSha256': producer.get('expectedOwnerSha256'),
            'ownerImmutable': producer.get('expectedOwnerImmutable'),
            'sourceBeforeImports': producer.get('sourceBeforeImports'),
            'sourceAfterRun': producer.get('sourceAfterRun'),
            'sourceSnapshotStable': producer.get('sourceSnapshotStable'),
            'loginSourceBeforeImports': producer.get('loginSourceBeforeImports'),
            'loginSourceAfterRun': producer.get('loginSourceAfterRun'),
            'liveReceiptPath': str(live_receipt_path.relative_to(REPO)) if args.action == 'settings-update-test' else None,
            'liveReceiptSha256': live_receipt_sha if args.action == 'settings-update-test' else None,
            'canonicalEvidence': canonical_status,
            'cookiesPersisted': False,
            'tokensPersisted': False,
            'requestBodiesPersisted': False,
            'responseBodiesPersisted': False,
        }
        print(json.dumps(summary, separators=(',', ':')))
    finally:
        if session:
            wipe_session(session, cookie_values)
        expected_owner = ''


if __name__ == '__main__':
    try:
        main()
    except SafeFailure as error:
        print(error.code)
        raise SystemExit(1)
    except Exception:
        print('SETTINGS_UPDATE_RUN_FAILED')
        raise SystemExit(1)
