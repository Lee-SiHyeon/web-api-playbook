#!/usr/bin/env python3
"""Run the captured task-only Grok conversation CRUD workflow through the main client."""

import asyncio
import fcntl
import hashlib
import json
import os
import pathlib
import re
import tempfile
import urllib.parse
from datetime import datetime, timezone

from playwright.async_api import async_playwright


REPO = pathlib.Path(__file__).resolve().parent.parent
RUNTIME = pathlib.Path.home() / '.nad-scratch/provider-runtime-20261005'
OWNER_PATH = RUNTIME / 'runtime-owner.json'
ROLE_PATH = RUNTIME / 'page-role-registry.json'
ROLE_LOCK = RUNTIME / 'page-role-registry.lock'
ROLE = 'codex-grok-conversation-crud-20261006'
ORIGIN = 'https://grok.com'
EXPECTED_OWNER_SHA256 = '23e57131977ce522bacf6649eb27538770828a890f7a65589ec4f0960a84b3d7'
NODE = '/home/worker/.npm/_npx/387698761821791d/node_modules/node/bin/node'
NODE_RUNNER = REPO / 'scripts/grok-conversation-crud-once.mjs'
CAPTURE_PATH = REPO / 'verification/grok-conversation-create-native-ui-attempt-2026-10-06.json'
WORKFLOW_PATH = REPO / 'verification/grok-conversation-crud-live-2026-10-06.json'
NODE_READ_POST_PATHS = {
    '/rest/models', '/rest/modes', '/rest/models/imagine/overrides',
    '/rest/connectors/list-v2', '/rest/connectors/list-available-v2',
    '/rest/connectors/finance/connections', '/rest/skills', '/rest/system-prompt/list',
}


class SafeFailure(Exception):
    def __init__(self, code):
        self.code = code


def sha256(value):
    return hashlib.sha256(value).hexdigest()


def load_json(path):
    try:
        return json.loads(path.read_text(encoding='utf-8'))
    except Exception as exc:
        raise SafeFailure('CRUD_READBACK_METADATA_INVALID') from exc


def verify_runtime(owner):
    if owner.get('taskOwned') is not True or owner.get('mode') != 'cdp_discovery_after_native_bootstrap':
        raise SafeFailure('OWNED_RUNTIME_INVALID')
    profile = pathlib.Path(owner.get('profile', ''))
    try:
        profile.relative_to(pathlib.Path.home() / '.nad-scratch')
    except Exception as exc:
        raise SafeFailure('OWNED_PROFILE_INVALID') from exc
    pid = owner.get('chromePid')
    port = owner.get('cdpPort')
    if not isinstance(pid, int) or not isinstance(port, int) or not 1 <= port <= 65535:
        raise SafeFailure('OWNED_RUNTIME_INVALID')
    try:
        os.kill(pid, 0)
        argv = pathlib.Path(f'/proc/{pid}/cmdline').read_bytes().split(b'\0')
        if f'--user-data-dir={profile}'.encode() not in argv:
            raise SafeFailure('OWNED_PROFILE_MISMATCH')
    except Exception as exc:
        if isinstance(exc, SafeFailure):
            raise
        raise SafeFailure('OWNED_RUNTIME_UNAVAILABLE') from exc
    return port


async def atomic_json(path, value):
    descriptor, temporary_name = tempfile.mkstemp(prefix=f'.{path.name}.', dir=path.parent)
    try:
        with os.fdopen(descriptor, 'w', encoding='utf-8') as output:
            os.fchmod(output.fileno(), 0o600)
            output.write(json.dumps(value, ensure_ascii=False, separators=(',', ':')) + '\n')
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary_name, path)
    finally:
        try:
            os.unlink(temporary_name)
        except FileNotFoundError:
            pass


async def owner_email(page):
    try:
        data = await page.evaluate("""async () => {
          const response = await fetch('/api/auth/session', {
            method:'GET', credentials:'same-origin', redirect:'error', cache:'no-store'
          });
          if (!response.ok) return {status:response.status,email:null};
          const body=await response.json();
          return {status:response.status,email:typeof body?.session?.email==='string'?body.session.email:null};
        }""")
    except Exception as exc:
        raise SafeFailure('OWNER_IDENTITY_READ_FAILED') from exc
    email = data.get('email') if isinstance(data, dict) else None
    if data.get('status') != 200 or not isinstance(email, str):
        raise SafeFailure('OWNER_IDENTITY_READ_FAILED')
    if sha256(email.strip().casefold().encode('utf-8')) != EXPECTED_OWNER_SHA256:
        raise SafeFailure('OWNER_IDENTITY_MISMATCH')
    return email


def frame_type(message):
    if isinstance(message, bytes):
        return 'binary'
    try:
        value = json.loads(message)
        event = value.get('event') if isinstance(value, dict) else None
        kind = event.get('type') if isinstance(event, dict) else None
        return kind if isinstance(kind, str) and re.fullmatch(r'[A-Za-z0-9._-]{1,96}', kind) else 'json_unclassified'
    except Exception:
        return 'json_unclassified'


async def main():
    capture_receipt = load_json(CAPTURE_PATH)
    roles = load_json(ROLE_PATH)
    owner = load_json(OWNER_PATH)
    port = verify_runtime(owner)
    source_fragment = load_json(REPO / 'contracts/grok-conversation-create-source-fragment-2026-10-06.json')
    role = roles.get('activePageRoles', {}).get(ROLE)
    if (not isinstance(role, dict) or role.get('origin') != ORIGIN
            or role.get('exactMarkerCount') != 1 or role.get('selection') != 'cdp_target_id'
            or not isinstance(role.get('targetId'), str)
            or capture_receipt.get('status') != 'normal_ui_request_not_observed'
            or capture_receipt.get('normalUiRequestObserved') is not False
            or capture_receipt.get('exactCreateRequestCount') != 0
            or capture_receipt.get('lastGuardedProbe', {}).get('browserBusinessFramesDelivered') != 0
            or capture_receipt.get('requestBodyPersisted') is not None
            or capture_receipt.get('sourceBodyValuesPersisted') is not False):
        raise SafeFailure('CRUD_CAPTURE_RECEIPT_NOT_VERIFIED')

    state = {'httpAbortCount': 0, 'allowedReadPostCount': 0, 'wsInterceptCount': 0,
             'browserFrameCount': 0, 'frameTypes': {}, 'httpOperations': {}, 'guardErrors': 0}
    page = None
    email = ''
    packet = None
    try:
        async with async_playwright() as playwright:
            browser = await playwright.chromium.connect_over_cdp(f'http://127.0.0.1:{port}')
            if len(browser.contexts) != 1:
                raise SafeFailure('OWNED_CONTEXT_COUNT_INVALID')
            context = browser.contexts[0]
            matches = []
            for candidate in context.pages:
                try:
                    if await candidate.evaluate('() => window.name') == ROLE:
                        matches.append(candidate)
                except Exception:
                    continue
            if len(matches) != 1:
                raise SafeFailure('CRUD_ROLE_PAGE_NOT_UNIQUE')
            page = matches[0]
            target_info = await (await context.new_cdp_session(page)).send('Target.getTargetInfo')
            target_id = target_info.get('targetInfo', {}).get('targetId')
            if target_id != role['targetId']:
                raise SafeFailure('CRUD_ROLE_TARGET_MISMATCH')

            def ws_guard(websocket):
                state['wsInterceptCount'] += 1
                def drop(message):
                    state['browserFrameCount'] += 1
                    kind = frame_type(message)
                    state['frameTypes'][kind] = state['frameTypes'].get(kind, 0) + 1
                websocket.on_message(drop)
                try:
                    websocket.close(code=1000, reason='grok-crud-direct-guard')
                except Exception:
                    state['guardErrors'] += 1

            async def http_guard(route):
                request = route.request
                parsed = urllib.parse.urlsplit(request.url)
                method = request.method.upper()
                if method in {'GET', 'HEAD', 'OPTIONS'}:
                    try:
                        await route.continue_()
                    except Exception:
                        state['guardErrors'] += 1
                    return
                if (parsed.scheme == 'https' and parsed.hostname == 'grok.com' and method == 'POST'
                        and (parsed.path in NODE_READ_POST_PATHS
                             or re.fullmatch(r'/rest/app-chat/conversations/[^/]+/load-responses', parsed.path))):
                    state['allowedReadPostCount'] += 1
                    try:
                        await route.continue_()
                    except Exception:
                        state['guardErrors'] += 1
                    return
                state['httpAbortCount'] += 1
                path = parsed.path
                if any(re.fullmatch(pattern, path) for pattern in (
                    r'/rest/app-chat/conversations/[^/]+',
                    r'/rest/app-chat/conversations/soft/[^/]+',
                    r'/rest/app-chat/conversations/[^/]+/responses',
                )):
                    path = '/rest/app-chat/conversations/{opaque}'
                key = f'{method} {path}'
                state['httpOperations'][key] = state['httpOperations'].get(key, 0) + 1
                try:
                    await route.abort('blockedbyclient')
                except Exception:
                    state['guardErrors'] += 1

            await page.route('**/*', http_guard)
            await page.route_web_socket('**/*', ws_guard)
            parsed_page = urllib.parse.urlsplit(page.url)
            if parsed_page.scheme != 'https' or parsed_page.hostname != 'grok.com':
                await page.goto(ORIGIN + '/', wait_until='domcontentloaded', timeout=60_000)
                await page.wait_for_timeout(1_500)
                parsed_page = urllib.parse.urlsplit(page.url)
            if parsed_page.scheme != 'https' or parsed_page.hostname != 'grok.com':
                raise SafeFailure('CRUD_ROLE_ORIGIN_INVALID')
            email = await owner_email(page)
            cookie_rows = await context.cookies([ORIGIN])
            sso = [cookie for cookie in cookie_rows
                   if cookie.get('name') == 'sso'
                   and str(cookie.get('domain', '')).lstrip('.').lower() == 'grok.com'
                   and cookie.get('path') == '/' and cookie.get('secure') is True
                   and isinstance(cookie.get('value'), str) and cookie.get('value')]
            if len(sso) != 1:
                raise SafeFailure('GROK_SSO_COOKIE_SCOPE_INVALID')
            cookie = sso[0]
            operation = next((item for item in source_fragment.get('operations', [])
                              if item.get('id') == 'conversation.create'), None)
            adapter = next((item for item in source_fragment.get('sourceAssets', [])
                            if item.get('adapterFunctionName') == 'createChatConversation'), None)
            if (source_fragment.get('fragmentId') != 'grok-conversation-create-source-contract'
                    or not isinstance(operation, dict) or not isinstance(adapter, dict)
                    or capture_receipt.get('status') != 'normal_ui_request_not_observed'
                    or capture_receipt.get('exactCreateRequestCount') != 0
                    or source_fragment.get('body', {}).get('sourceBodySha256') != capture_receipt.get('sourceBodySha256')):
                raise SafeFailure('CRUD_SOURCE_CONTRACT_RECEIPT_INVALID')
            body = {'systemPromptName': '', 'temporary': False}
            source = {
                'sourceMode': 'first_party_sdk_contract',
                'normalUiRequestObserved': False,
                'normalUiAdapterMatched': True,
                'sourceUrl': operation['evidence']['sourceUrl'],
                'sourceSha256': operation['evidence']['sourceSha256'],
                'sourceFunctionName': operation['evidence']['sourceFunctionName'],
                'adapterSourceUrl': adapter['sourceUrl'],
                'adapterSourceSha256': adapter['sourceSha256'],
                'body': body,
                'sourceBodySha256': source_fragment['body']['sourceBodySha256'],
            }
            session_bundle = {
                'schemaVersion': 1,
                'serviceId': 'grok-web',
                'origin': ORIGIN,
                'capturedAt': datetime.now(timezone.utc).isoformat(),
                'sourceObservationId': 'grok-conversation-crud-native-capture-20261006',
                'origins': [{
                    'origin': ORIGIN,
                    'cookies': [{
                        'name': 'sso', 'value': cookie['value'], 'origin': ORIGIN,
                        'domain': str(cookie.get('domain') or 'grok.com').lstrip('.'),
                        'path': cookie.get('path') or '/', 'secure': bool(cookie.get('secure')),
                        'httpOnly': bool(cookie.get('httpOnly')),
                    }],
                    'headers': [],
                }],
            }
            packet = {'expectedIdentity': email, 'sessionBundle': session_bundle, 'createSource': source}
            await page.goto('about:blank', wait_until='load', timeout=30_000)
            await page.evaluate('(marker) => { window.name = marker; }', ROLE)
            await page.wait_for_timeout(2_000)
            if page.url != 'about:blank' or await page.evaluate('() => window.name') != ROLE:
                raise SafeFailure('CRUD_ROLE_BLANK_RESET_FAILED')
            wire = bytearray(json.dumps(packet, separators=(',', ':')).encode('utf-8'))
            try:
                process = await asyncio.create_subprocess_exec(
                    NODE, str(NODE_RUNNER), stdin=asyncio.subprocess.PIPE,
                    stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL,
                )
                try:
                    output, _ = await asyncio.wait_for(process.communicate(bytes(wire)), timeout=600)
                except asyncio.TimeoutError:
                    process.kill()
                    await process.wait()
                    raise SafeFailure('CRUD_DIRECT_RUNNER_TIMEOUT')
            finally:
                wire[:] = b'\0' * len(wire)
                cookie['value'] = ''
                email = ''
                sso.clear()
                session_bundle['origins'][0]['cookies'].clear()
                source['body'] = {}
            if len(output) > 64 * 1024:
                raise SafeFailure('CRUD_DIRECT_RUNNER_OUTPUT_INVALID')
            try:
                summary = json.loads(output.decode('utf-8'))
            except Exception as exc:
                raise SafeFailure('CRUD_DIRECT_RUNNER_OUTPUT_INVALID') from exc
            if not isinstance(summary, dict) or summary.get('operationId') != 'conversation.crud':
                raise SafeFailure('CRUD_DIRECT_RUNNER_OUTPUT_INVALID')

            await page.wait_for_timeout(2_000)
            reset_verified = page.url == 'about:blank' and await page.evaluate('() => window.name') == ROLE
            if not reset_verified or state['guardErrors'] != 0:
                raise SafeFailure('CRUD_DIRECT_PAGE_RESET_FAILED')
            try:
                await page.unroute('**/*', http_guard)
            except Exception:
                state['guardErrors'] += 1
            if not WORKFLOW_PATH.exists():
                print(json.dumps({
                    **summary,
                    'sameTargetResetAndQuiet': True,
                    'browserClosed': False,
                    'contextClosed': False,
                    'workflowReceiptPersisted': False,
                }, separators=(',', ':')))
                return 1
            try:
                receipt = load_json(WORKFLOW_PATH)
                receipt['browserGuardAndReset'] = {
                    'httpGuardInstalledBeforeDirectWriter': True,
                    'webSocketGuardInstalledBeforeDirectWriter': True,
                    'httpAbortCount': state['httpAbortCount'],
                    'blockedHttpOperationCounts': state['httpOperations'],
                    'allowedReadPostCount': state['allowedReadPostCount'],
                    'websocketInterceptCount': state['wsInterceptCount'],
                    'browserBusinessFrameCount': state['browserFrameCount'],
                    'browserBusinessFramesDelivered': 0,
                    'blockedFrameTypeCounts': state['frameTypes'],
                    'sameTargetResetToBlank': True,
                    'sameMarkerPreserved': True,
                    'quietWaitMs': 2_000,
                    'browserClosed': False,
                    'contextClosed': False,
                }
                await atomic_json(WORKFLOW_PATH, receipt)
            except FileNotFoundError:
                pass
            print(json.dumps({
                **summary,
                'sameTargetResetAndQuiet': True,
                'browserClosed': False,
                'contextClosed': False,
                'rawTargetIdPersisted': False,
            }, separators=(',', ':')))
            return 0 if summary.get('status') == 'verified' else 1
    finally:
        if page and not page.is_closed():
            try:
                if page.url != 'about:blank':
                    await page.goto('about:blank', wait_until='load', timeout=30_000)
                    await page.evaluate('(marker) => { window.name = marker; }', ROLE)
                    await page.wait_for_timeout(1_000)
            except Exception:
                pass
        if packet:
            packet['expectedIdentity'] = ''
            session_bundle = packet.get('sessionBundle')
            if isinstance(session_bundle, dict):
                origins = session_bundle.get('origins')
                if isinstance(origins, list):
                    for origin in origins:
                        for cookie in origin.get('cookies', []) if isinstance(origin, dict) else []:
                            if isinstance(cookie, dict):
                                cookie['value'] = ''
            packet['createSource'] = None
        email = ''


if __name__ == '__main__':
    try:
        raise SystemExit(asyncio.run(main()))
    except SafeFailure as exc:
        print(exc.code)
        raise SystemExit(1)
    except Exception as exc:
        print(f'GROK_CONVERSATION_CRUD_DIRECT_FAILED:{type(exc).__name__}')
        raise SystemExit(1)
