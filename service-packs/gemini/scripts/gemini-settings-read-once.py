#!/usr/bin/env python3
"""Pair one guarded normal-UI ESY5D read with the numeric-field HTTP client read."""

import base64
import hashlib
import importlib.util
import json
import os
import pathlib
import re
import subprocess
import sys
import traceback
import urllib.parse
from datetime import datetime, timezone

from playwright.sync_api import sync_playwright


REPO = pathlib.Path(__file__).resolve().parent.parent
RUNTIME = pathlib.Path.home() / '.nad-scratch/provider-runtime-20261005'
OWNER_PATH = RUNTIME / 'runtime-owner.json'
ROLE_PATH = RUNTIME / 'page-role-registry.json'
OWNER_SOURCE = RUNTIME / 'grok-client-live-verify.py'
OWNER_SOURCE_SHA256 = 'da6d415129ac8e349b8632f1ef9defe1ca7ecf30fedb4c28abf3a519766af7bb'
EMAIL_HASH_LINE = re.compile(r"^EXPECTED_EMAIL_SHA256='([a-f0-9]{64})'$", re.MULTILINE)
SERVICE_ORIGIN = 'https://gemini.google.com'
GROK_ORIGIN = 'https://grok.com'
PAGE_ROLE = 'codex-gemini-lifecycle-20261006'
GROK_ROLE = 'codex-grok-core-20261006'
BATCH_PATH = '/_/BardChatUi/data/batchexecute'
READ_RPC_IDS = {'MaZiqc', 'otAQ7b', 'ESY5D'}
PREFERENCE_KEYS = [
    'voice_language', 'voice_name', 'enable_advanced_mode', 'enable_memory',
    'enable_personal_context', 'web_and_app_activity_enabled', 'side_nav_open_by_default',
]
FIELD_IDS = {
    'voice_language': 62, 'voice_name': 61, 'enable_advanced_mode': 39,
    'enable_memory': 25, 'enable_personal_context': 77,
    'web_and_app_activity_enabled': 93, 'side_nav_open_by_default': 41,
}
SAFE_MUTATION_KEYS = {'side_nav_open_by_default'}
SOURCE_SHA256 = 'f08ffc021617bdc00b5a302a5da9be569dfec3e8837152af7c3f6bd5be0db804'
NODE = '/home/worker/.npm/_npx/387698761821791d/node_modules/node/bin/node'
NODE_CLI = REPO / 'src/cli.mjs'
CONTRACT_PATH = REPO / 'discovery/observed-contract.json'
RECEIPT_PATH = REPO / 'verification/features/gemini-settings-read-2026-10-06.json'


class SafeFailure(Exception):
    def __init__(self, code):
        self.code = code


def read_json(path):
    try:
        return json.loads(pathlib.Path(path).read_text(encoding='utf-8'))
    except Exception as exc:
        raise SafeFailure('RUNTIME_METADATA_INVALID') from exc


def expected_owner_hash():
    try:
        source = OWNER_SOURCE.read_bytes()
    except Exception as exc:
        raise SafeFailure('OWNER_SOURCE_MISSING') from exc
    if hashlib.sha256(source).hexdigest() != OWNER_SOURCE_SHA256:
        raise SafeFailure('OWNER_SOURCE_CHANGED')
    match = EMAIL_HASH_LINE.search(source.decode('utf-8', 'replace'))
    if not match:
        raise SafeFailure('OWNER_HASH_MISSING')
    return match.group(1)


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


def page_for_role(context, marker, origin):
    matches = []
    for page in context.pages:
        try:
            current = urllib.parse.urlsplit(page.url)
            if (page.evaluate('() => window.name') == marker
                    and current.scheme == 'https' and current.netloc == urllib.parse.urlsplit(origin).netloc):
                matches.append(page)
        except Exception:
            continue
    if len(matches) != 1:
        raise SafeFailure('PAGE_ROLE_NOT_UNIQUE')
    return matches[0]


def read_expected_owner(grok_page):
    try:
        email = grok_page.evaluate("""async () => {
          const response = await fetch('/api/auth/session', {
            method: 'GET', credentials: 'same-origin', redirect: 'error'
          });
          if (!response.ok) return null;
          const value = await response.json();
          return value && value.session && typeof value.session.email === 'string'
            ? value.session.email : null;
        }""")
    except Exception as exc:
        raise SafeFailure('BROWSER_OWNER_READ_FAILED') from exc
    if not isinstance(email, str) or hashlib.sha256(email.strip().casefold().encode()).hexdigest() != expected_owner_hash():
        raise SafeFailure('BROWSER_OWNER_MISMATCH')
    return email


def request_rpc(request):
    parsed = urllib.parse.urlsplit(request.url)
    if parsed.scheme != 'https' or parsed.hostname != 'gemini.google.com' or parsed.path != BATCH_PATH:
        return None, None
    query = urllib.parse.parse_qs(parsed.query, keep_blank_values=True)
    ids = query.get('rpcids', [])
    if len(ids) != 1:
        return None, None
    try:
        form = urllib.parse.parse_qs(request.post_data or '', keep_blank_values=True)
        outer = json.loads(form['f.req'][0])
        call = outer[0][0]
        args = json.loads(call[1])
        if call[0] != ids[0] or not isinstance(args, list):
            return None, None
        return ids[0], args
    except Exception:
        return None, None


def allowed_read_shape(rpc_id, args):
    if rpc_id == 'MaZiqc':
        return (len(args) == 3 and args[0] == 28 and args[1] is None
                and args[2] == [0, None, 1])
    if rpc_id == 'otAQ7b':
        return len(args) == 0
    if rpc_id == 'ESY5D':
        if len(args) != 2 or args[0] is not None or not isinstance(args[1], list):
            return False
        fields = args[1]
        return (0 < len(fields) <= 512
                and all(isinstance(field, int) and not isinstance(field, bool) and 0 <= field <= 1000 for field in fields)
                and len(set(fields)) == len(fields)
                and FIELD_IDS['side_nav_open_by_default'] in fields)
    return False


def decode_ui_settings(body):
    helper = r"""
      import { stdin, stdout } from 'node:process';
      import { parseBatchResponse, requireRpcResponse } from './src/batch-response.mjs';
      import { parsePreferenceResponse } from './src/conversation-lifecycle.mjs';
      function summarizeCandidates(root, fieldIds) {
        const found = [];
        const pending = [{ value: root, path: [], depth: 0 }];
        let visited = 0;
        while (pending.length && visited < 50000) {
          const { value, path, depth } = pending.pop();
          visited += 1;
          if (depth > 16) continue;
          if (Array.isArray(value)) {
            if (value.length > Math.max(...fieldIds)) {
              const fields = fieldIds.map((id) => {
                const item = value[id];
                return { id, type: item === undefined ? 'missing' : item === null ? 'null'
                  : Array.isArray(item) ? 'array' : typeof item,
                  ...(typeof item === 'string' ? { length: item.length } : {}) };
              });
              found.push({ path: path.slice(0, 16), length: value.length, fields });
            }
            for (let i = value.length - 1; i >= 0; i -= 1) pending.push({ value: value[i], path: [...path, i], depth: depth + 1 });
          } else if (value && typeof value === 'object') {
            for (const [key, item] of Object.entries(value)) pending.push({ value: item, path: [...path, /^\d+$/.test(key) ? Number(key) : 'field'], depth: depth + 1 });
          } else if (typeof value === 'string') {
            const trimmed = value.trimStart();
            if ((trimmed.startsWith('[') || trimmed.startsWith('{')) && trimmed.length <= 2097152) {
              try { pending.push({ value: JSON.parse(trimmed), path: [...path, 'json'], depth: depth + 1 }); } catch { /* non-JSON text */ }
            }
          }
        }
        return found.slice(0, 80);
      }
      let input = '';
      for await (const part of stdin) input += part;
      let rpc = null;
      let keys = [];
      try {
        const value = JSON.parse(input);
        keys = value.keys;
        const frames = parseBatchResponse(Buffer.from(value.bodyBase64, 'base64'), {
          lengthUnit: 'utf16_code_units', frameLengthOverheadUnits: 2,
        });
        rpc = requireRpcResponse(frames, 'ESY5D');
        stdout.write(JSON.stringify({ settings: parsePreferenceResponse(rpc.data, value.keys) }));
      } catch (error) {
        const code = typeof error?.code === 'string' && /^[A-Z][A-Z0-9_]{1,63}$/.test(error.code)
          ? error.code : 'SETTINGS_UI_DECODER_FAILED';
        const fieldMap = { voice_language: 62, voice_name: 61, enable_advanced_mode: 39,
          enable_memory: 25, enable_personal_context: 77, web_and_app_activity_enabled: 93,
          side_nav_open_by_default: 41 };
        const diagnostic = rpc && Array.isArray(keys)
          ? summarizeCandidates(rpc.data, keys.map((key) => fieldMap[key]).filter(Number.isSafeInteger))
          : undefined;
        stdout.write(JSON.stringify({ error: code, ...(diagnostic ? { diagnostic } : {}) }));
      }
    """
    if len(body) > 10 * 1024 * 1024:
        raise SafeFailure('SETTINGS_UI_RESPONSE_TOO_LARGE')
    completed = subprocess.run(
        [NODE, '--input-type=module', '-e', helper],
        input=json.dumps({'bodyBase64': base64.b64encode(body).decode('ascii'), 'keys': PREFERENCE_KEYS}),
        text=True, capture_output=True, timeout=45, cwd=REPO, check=False,
    )
    if completed.returncode != 0 or not completed.stdout:
        raise SafeFailure('SETTINGS_UI_RESPONSE_DECODE_FAILED')
    try:
        result = json.loads(completed.stdout)
    except Exception as exc:
        raise SafeFailure('SETTINGS_UI_RESPONSE_DECODE_FAILED') from exc
    completed.stdout = ''
    completed.stderr = ''
    if isinstance(result, dict) and isinstance(result.get('error'), str):
        if isinstance(result.get('diagnostic'), list):
            print(json.dumps({'candidateVectors': result['diagnostic']}, separators=(',', ':')), file=sys.stderr)
        raise SafeFailure('SETTINGS_UI_' + result['error'])
    if not isinstance(result, dict) or not isinstance(result.get('settings'), dict):
        raise SafeFailure('SETTINGS_UI_RESPONSE_DECODE_FAILED')
    return result['settings']


def run_direct_read(session, owner_email):
    payload = {'session': session, 'preferenceKeys': PREFERENCE_KEYS}
    completed = subprocess.run(
        [NODE, str(NODE_CLI), 'settings', '--envelope-stdin', '--expect-owner', owner_email, '--output', 'json'],
        input=json.dumps(payload), text=True,
        capture_output=True, timeout=120, cwd=REPO, check=False,
    )
    payload['session'] = {}
    if completed.returncode != 0 or not completed.stdout:
        code = 'DIRECT_SETTINGS_READ_FAILED'
        try:
            error = json.loads(completed.stdout) if completed.stdout else {}
            code = error.get('code', code) if isinstance(error, dict) else code
        except Exception:
            pass
        completed.stdout = ''
        completed.stderr = ''
        raise SafeFailure(code if re.fullmatch(r'[A-Z][A-Z0-9_]{2,63}', str(code)) else 'DIRECT_SETTINGS_READ_FAILED')
    try:
        result = json.loads(completed.stdout)
    except Exception as exc:
        raise SafeFailure('DIRECT_SETTINGS_OUTPUT_INVALID') from exc
    completed.stdout = ''
    completed.stderr = ''
    return result


def capture_and_verify(owner, roles, contract):
    port = verify_runtime(owner, roles)
    if not pathlib.Path(NODE).is_file() or not NODE_CLI.is_file():
        raise SafeFailure('NODE_RUNTIME_MISSING')
    if RECEIPT_PATH.exists():
        prior = read_json(RECEIPT_PATH)
        if prior.get('schema') != 'gemini-settings-read-verification-v1':
            raise SafeFailure('SETTINGS_RECEIPT_ALREADY_EXISTS')
    owner_email = None
    session = None
    raw_ui_body = None
    ui_values = None
    direct = None
    with sync_playwright() as playwright:
        browser = playwright.chromium.connect_over_cdp(f'http://127.0.0.1:{port}')
        if len(browser.contexts) != 1:
            raise SafeFailure('OWNED_CONTEXT_COUNT_INVALID')
        context = browser.contexts[0]
        page = page_for_role(context, PAGE_ROLE, SERVICE_ORIGIN)
        grok_page = page_for_role(context, GROK_ROLE, GROK_ORIGIN)
        owner_email = read_expected_owner(grok_page)
        current_url = urllib.parse.urlsplit(page.url)
        if current_url.path != '/app' and not current_url.path.startswith('/app/'):
            owner_email = ''
            raise SafeFailure('LIFECYCLE_PAGE_PATH_INVALID')

        contract_ops = contract.get('operations', {})
        allowed_cookie_names = set(contract.get('auth', {}).get('cookieNames', []))
        history_contract = contract_ops.get('history_list', {}).get('request', {})
        identity_contract = contract_ops.get('identity', {}).get('request', {})
        if not allowed_cookie_names or not history_contract or not identity_contract:
            owner_email = ''
            raise SafeFailure('BASE_CONTRACT_MISSING')
        observed = {
            'document': None,
            'history': None,
            'settings': None,
            'blockedPosts': 0,
            'invalidAllowedRead': False,
        }

        def guard(route):
            try:
                request = route.request
                method = request.method.upper()
                if method in {'GET', 'HEAD', 'OPTIONS'}:
                    route.continue_()
                    return
                rpc_id, args = request_rpc(request)
                if rpc_id in READ_RPC_IDS and allowed_read_shape(rpc_id, args):
                    route.continue_()
                    return
                observed['blockedPosts'] += 1
            except Exception:
                observed['invalidAllowedRead'] = True
            try:
                route.abort('aborted')
            except Exception:
                observed['invalidAllowedRead'] = True

        def on_request(request):
            parsed = urllib.parse.urlsplit(request.url)
            if (request.resource_type == 'document' and parsed.scheme == 'https'
                    and parsed.hostname == 'gemini.google.com' and parsed.path.startswith('/app')):
                headers = {str(key).lower(): str(value) for key, value in request.headers.items()}
                headers = {key: value for key, value in headers.items()
                           if key in {name.lower() for name in identity_contract.get('headerNames', [])}
                           and key not in {'cookie', 'authorization', 'host', 'content-length'}}
                observed['document'] = {'request': request, 'headers': headers}
                return
            if request.resource_type not in ('xhr', 'fetch'):
                return
            rpc_id, args = request_rpc(request)
            if rpc_id == 'MaZiqc' and allowed_read_shape(rpc_id, args):
                parsed_query = urllib.parse.parse_qs(parsed.query, keep_blank_values=True)
                form = urllib.parse.parse_qs(request.post_data or '', keep_blank_values=True)
                header_names = sorted(name.lower() for name in request.headers
                                      if name.lower() in {item.lower() for item in history_contract.get('headerNames', [])})
                observed['history'] = {
                    'request': request,
                    'query': parsed_query,
                    'form': form,
                    'args': args,
                    'headers': {str(name).lower(): str(value) for name, value in request.headers.items()
                                if str(name).lower() in set(history_contract.get('headerNames', []))},
                    'headerNames': header_names,
                }
            elif rpc_id == 'ESY5D' and allowed_read_shape(rpc_id, args):
                form = urllib.parse.parse_qs(request.post_data or '', keep_blank_values=True)
                observed['settings'] = {
                    'request': request,
                    'args': args,
                    'formFieldNames': [name for name, _ in urllib.parse.parse_qsl(request.post_data or '', keep_blank_values=True)],
                    'queryKeys': [name for name, _ in urllib.parse.parse_qsl(parsed.query, keep_blank_values=True)],
                    'headerNames': sorted(name.lower() for name in request.headers
                                          if name.lower() in {item.lower() for item in contract_ops['settings_read']['request'].get('headerNames', [])}),
                    'bodyBytes': len((request.post_data or '').encode('utf-8')),
                    'form': form,
                }

        def on_response(response):
            request = response.request
            if observed['document'] and request is observed['document']['request']:
                observed['document']['status'] = response.status
                observed['document']['contentType'] = response.headers.get('content-type', '').split(';', 1)[0].lower()
            if observed['history'] and request is observed['history']['request']:
                observed['history']['status'] = response.status
                observed['history']['contentType'] = response.headers.get('content-type', '').split(';', 1)[0].lower()
            if observed['settings'] and request is observed['settings']['request']:
                try:
                    body = response.body()
                except Exception as exc:
                    raise SafeFailure('SETTINGS_UI_RESPONSE_UNAVAILABLE') from exc
                observed['settings']['status'] = response.status
                observed['settings']['contentType'] = response.headers.get('content-type', '').split(';', 1)[0].lower()
                observed['settings']['responseBytes'] = len(body)
                observed['settings']['responseSha256'] = hashlib.sha256(body).hexdigest()
                observed['settings']['responseData'] = bytearray(body)

        page.route('**/*', guard)
        page.on('request', on_request)
        page.on('response', on_response)
        try:
            page.reload(wait_until='domcontentloaded', timeout=60000)
            page.wait_for_timeout(8000)
        finally:
            page.remove_listener('request', on_request)
            page.remove_listener('response', on_response)
            page.unroute('**/*', guard)

        if not observed['document'] or observed['document'].get('status') != 200 \
                or observed['document'].get('contentType') != 'text/html':
            owner_email = ''
            raise SafeFailure('GEMINI_APP_DOCUMENT_READ_FAILED')
        history = observed['history']
        if not history or history.get('status') != 200 or history.get('contentType') != 'application/json':
            owner_email = ''
            raise SafeFailure('HISTORY_CONTEXT_CAPTURE_FAILED')
        settings = observed['settings']
        if (not settings or settings.get('status') != 200 or settings.get('contentType') != 'application/json'
                or settings.get('formFieldNames') != ['f.req', 'at'] or not settings.get('responseData')):
            owner_email = ''
            raise SafeFailure('SETTINGS_UI_PAIR_MISSING')
        selectors = settings['args'][1]
        if FIELD_IDS['side_nav_open_by_default'] not in selectors:
            owner_email = ''
            raise SafeFailure('SETTINGS_SELECTOR_NOT_CAPTURED')
        install_observed_selector_vector(selectors)

        raw_ui_body = settings.pop('responseData')
        ui_values = decode_ui_settings(bytes(raw_ui_body))
        raw_ui_body[:] = b'\0' * len(raw_ui_body)
        raw_ui_body = None
        usable_ui_values = {
            key: value for key, value in ui_values.items()
            if value.get('found') is True and value.get('type') in {'boolean', 'string'}
        }
        if not usable_ui_values:
            owner_email = ''
            raise SafeFailure('SETTINGS_UI_VALUES_UNDECODED')

        cookie_values = {item['name']: item['value'] for item in context.cookies(SERVICE_ORIGIN)
                         if item.get('name') in allowed_cookie_names}
        if set(cookie_values) != allowed_cookie_names:
            owner_email = ''
            raise SafeFailure('AUTH_COOKIE_SET_INCOMPLETE')
        query = history['query']
        form = history['form']
        if any(len(query.get(key, [])) != 1 for key in ('f.sid', 'bl', 'hl', 'rt', 'source-path', '_reqid')) \
                or len(form.get('at', [])) != 1:
            owner_email = ''
            raise SafeFailure('HISTORY_CONTEXT_INCOMPLETE')
        session = {
            'version': 1,
            'service': contract['service'],
            'origin': SERVICE_ORIGIN,
            'capturedAt': datetime.now(timezone.utc).isoformat(),
            'cookies': [{'name': name, 'value': value} for name, value in cookie_values.items()],
            'headers': {},
            'requestHeaders': {
                'identity': observed['document']['headers'],
                'history_list': history['headers'],
            },
            'batchContext': {
                'at': form['at'][0], 'fSid': query['f.sid'][0], 'buildLabel': query['bl'][0],
                'locale': query['hl'][0], 'requestType': query['rt'][0], 'sourcePath': query['source-path'][0],
                'requestId': query['_reqid'][0], 'historyListArgs': history['args'],
            },
        }
        for name in cookie_values:
            cookie_values[name] = ''
        cookie_values.clear()

        direct = run_direct_read(session, owner_email)
        session = None
        direct_settings = direct.get('settings', {})
        matching_values = {}
        for key in PREFERENCE_KEYS:
            ui_value = ui_values.get(key, {})
            direct_value = direct_settings.get(key, {})
            same = (ui_value.get('found') == direct_value.get('found')
                    and ui_value.get('type') == direct_value.get('type'))
            if same and ui_value.get('found') is True:
                same = ui_value.get('value') == direct_value.get('value')
            if same:
                matching_values[key] = direct_value
        direct_matched = (
            direct.get('ownerMatched') is True
            and direct.get('anonymousOwnerAbsent') is True
            and direct.get('credentialPropagated') is True
            and direct.get('httpStatus') == 200
            and len(matching_values) == len(PREFERENCE_KEYS)
        )
        if not direct_matched:
            diagnostics = {}
            for key in PREFERENCE_KEYS:
                ui_value = ui_values.get(key, {})
                direct_value = direct_settings.get(key, {})
                diagnostics[key] = {
                    'uiFound': ui_value.get('found') is True,
                    'uiType': ui_value.get('type'),
                    'directFound': direct_value.get('found') is True,
                    'directType': direct_value.get('type'),
                    'valueMatchedInMemory': (
                        ui_value.get('found') is True and direct_value.get('found') is True
                        and ui_value.get('value') == direct_value.get('value')
                    ),
                }
            print(json.dumps({
                'ownerMatched': direct.get('ownerMatched') is True,
                'anonymousOwnerAbsent': direct.get('anonymousOwnerAbsent') is True,
                'credentialPropagated': direct.get('credentialPropagated') is True,
                'httpStatus': direct.get('httpStatus'),
                'responseBytes': direct.get('responseBytes'),
                'requestBodyBytes': direct.get('request', {}).get('bodyBytes'),
                'dataShape': direct.get('dataShape'),
                'settings': diagnostics,
            }, separators=(',', ':')), file=sys.stderr)
            owner_email = ''
            raise SafeFailure('DIRECT_SETTINGS_VALUE_MISMATCH')
        reported_keys = sorted(
            key for key in matching_values if direct_settings.get(key, {}).get('found') is True
        )

        receipt = {
            'schema': 'gemini-settings-read-verification-v1',
            'service': 'gemini-web',
            'feature': 'settings',
            'operation': 'settings_read',
            'outcome': 'verified',
            'verifiedAt': datetime.now(timezone.utc).isoformat(),
            'executionHost': 'linux_worker',
            'pageRole': PAGE_ROLE,
            'sourceEvidence': {
                'sourceClass': 'anonymous_google_first_party_web_client',
                'moduleId': 'LQaXg',
                'bundleSha256': SOURCE_SHA256,
                'preferenceMapByteOffset': 1017753,
                'preferenceMapByteLength': 10497,
                'preferenceMapEntryCount': 247,
                'selectedFieldIds': FIELD_IDS,
            },
            'normalUiPair': {
                'pageScopedGuard': 'allow ESY5D numeric preference read and captured baseline reads; abort other POSTs',
                'requestReachedServer': True,
                'request': {
                    'method': 'POST', 'path': BATCH_PATH, 'rpcId': 'ESY5D',
                    'queryKeys': settings['queryKeys'], 'headerNames': settings['headerNames'],
                    'formFieldNames': settings['formFieldNames'], 'bodyBytes': settings['bodyBytes'],
                    'selectorCount': len(selectors), 'selectedFieldPresent': True,
                    'rawRequestValuesPersisted': False,
                },
                'response': {
                    'httpStatus': settings['status'], 'contentType': settings['contentType'],
                    'responseBytes': settings['responseBytes'], 'responseSha256': settings['responseSha256'],
                    'matchingRpcDecoded': True,
                },
                'typedRead': {
                    'keys': PREFERENCE_KEYS,
                    'reportedKeys': sorted(usable_ui_values),
                    'reportedTypes': {key: ui_values[key]['type'] for key in sorted(usable_ui_values)},
                    'valuePersisted': False,
                },
            },
            'directHttpReplay': {
                'clientEntryPoint': 'src/cli.mjs settings', 'transport': 'main_cli_direct_https',
                'rpcId': direct.get('rpcId'),
                'ownerMatched': direct.get('ownerMatched') is True,
                'anonymousOwnerAbsent': direct.get('anonymousOwnerAbsent') is True,
                'credentialPropagated': direct.get('credentialPropagated') is True,
                'httpStatus': direct.get('httpStatus'), 'responseBytes': direct.get('responseBytes'),
                'responseSha256': direct.get('responseSha256'),
                'requestedKeyCount': direct.get('requestedKeyCount'),
                'reportedKeyCount': direct.get('reportedKeyCount'),
                'typedValuesMatchNormalUi': True,
                'reportedKeys': reported_keys,
                'reportedTypes': {key: direct_settings[key]['type'] for key in reported_keys},
                'valuesPersisted': False,
            },
            'persistence': {
                'cookiesPersisted': False, 'sessionValuesPersisted': False,
                'requestValuesPersisted': False, 'responseValuesPersisted': False,
                'settingsValuesPersisted': False, 'expectedOwnerPersisted': False,
                'rawRequestOrResponseBodyPersisted': False,
            },
        }
        owner_email = ''
        for setting in direct_settings.values():
            if isinstance(setting, dict):
                setting['value'] = None
        direct = None
        ui_values = None
        if observed['settings'].get('args'):
            observed['settings']['args'] = None
        if observed['history'].get('form'):
            observed['history']['form'] = None
        if observed['history'].get('query'):
            observed['history']['query'] = None
        if observed['settings'].get('form'):
            observed['settings']['form'] = None
        return receipt


def write_receipt(receipt):
    RECEIPT_PATH.parent.mkdir(parents=True, exist_ok=True)
    temp = RECEIPT_PATH.with_name(RECEIPT_PATH.name + f'.settings-{os.getpid()}.pending')
    descriptor = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
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


def install_observed_selector_vector(selectors):
    if (not isinstance(selectors, list) or len(selectors) < 7 or len(selectors) > 512
            or any(not isinstance(value, int) or isinstance(value, bool) or value < 0 or value > 1000 for value in selectors)
            or len(set(selectors)) != len(selectors)
            or any(FIELD_IDS[key] not in selectors for key in PREFERENCE_KEYS)):
        raise SafeFailure('SETTINGS_SELECTOR_VECTOR_INVALID')
    current = read_json(CONTRACT_PATH)
    request = current.get('operations', {}).get('settings_read', {}).get('request', {})
    if (request.get('rpcId') != 'ESY5D'
            or request.get('rpcArgsTemplate') != [None, '{{preferenceFieldIds}}']):
        raise SafeFailure('SETTINGS_CONTRACT_CONCURRENT_CHANGE')
    if request.get('preferenceFieldIds') == selectors:
        return
    current['operations']['settings_read']['request']['preferenceFieldIds'] = list(selectors)
    current['observedAt'] = datetime.now(timezone.utc).isoformat()
    temp = CONTRACT_PATH.with_name(CONTRACT_PATH.name + f'.settings-{os.getpid()}.pending')
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


def main():
    try:
        owner = read_json(OWNER_PATH)
        roles = read_json(ROLE_PATH)
        contract = read_json(REPO / 'discovery/observed-contract.json')
        receipt = capture_and_verify(owner, roles, contract)
        write_receipt(receipt)
        print(json.dumps({
            'outcome': receipt['outcome'],
            'feature': receipt['feature'],
            'operation': receipt['operation'],
            'normalUiPair': True,
            'directHttpRead': True,
            'typedValueMatched': True,
            'receipt': str(RECEIPT_PATH),
        }, separators=(',', ':')))
        return 0
    except SafeFailure as exc:
        print(exc.code, file=sys.stderr)
        return 1
    except Exception as exc:
        safe_type = type(exc).__name__
        last = traceback.extract_tb(exc.__traceback__)[-1] if exc.__traceback__ else None
        location = f'{last.name}:{last.lineno}' if last else 'unknown'
        print('SETTINGS_READ_VERIFICATION_FAILED:' + safe_type + ':' + location, file=sys.stderr)
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
