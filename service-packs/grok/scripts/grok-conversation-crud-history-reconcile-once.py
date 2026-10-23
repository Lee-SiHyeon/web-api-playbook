#!/usr/bin/env python3
"""Recheck the post-soft-delete owner history without another conversation write."""

import asyncio
import json
import os
import pathlib
import re
import tempfile
import urllib.parse

from playwright.async_api import async_playwright


REPO = pathlib.Path(__file__).resolve().parent.parent
RUNTIME = pathlib.Path.home() / '.nad-scratch/provider-runtime-20261005'
OWNER_PATH = RUNTIME / 'runtime-owner.json'
ROLE_PATH = RUNTIME / 'page-role-registry.json'
ROLE = 'codex-grok-conversation-crud-20261006'
ORIGIN = 'https://grok.com'
EXPECTED_OWNER_SHA256 = '23e57131977ce522bacf6649eb27538770828a890f7a65589ec4f0960a84b3d7'
NODE = '/home/worker/.npm/_npx/387698761821791d/node_modules/node/bin/node'
NODE_RUNNER = REPO / 'scripts/grok-conversation-crud-history-reconcile-once.mjs'
WORKFLOW_PATH = REPO / 'verification/grok-conversation-crud-live-2026-10-06.json'
RECONCILE_PATH = REPO / 'verification/grok-conversation-crud-history-reconciliation-2026-10-06.json'
READ_POST_PATHS = {
    '/rest/models', '/rest/modes', '/rest/models/imagine/overrides',
    '/rest/connectors/list-v2', '/rest/connectors/list-available-v2',
    '/rest/connectors/finance/connections', '/rest/skills', '/rest/system-prompt/list',
}


class SafeFailure(Exception):
    def __init__(self, code):
        self.code = code


def load_json(path):
    try:
        return json.loads(path.read_text(encoding='utf-8'))
    except Exception as exc:
        raise SafeFailure('CRUD_RECONCILE_METADATA_INVALID') from exc


def verify_runtime(owner):
    if owner.get('taskOwned') is not True or owner.get('mode') != 'cdp_discovery_after_native_bootstrap':
        raise SafeFailure('OWNED_RUNTIME_INVALID')
    profile = pathlib.Path(owner.get('profile', ''))
    try:
        profile.relative_to(pathlib.Path.home() / '.nad-scratch')
    except Exception as exc:
        raise SafeFailure('OWNED_PROFILE_INVALID') from exc
    pid, port = owner.get('chromePid'), owner.get('cdpPort')
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
    descriptor, temporary = tempfile.mkstemp(prefix=f'.{path.name}.', dir=path.parent)
    try:
        with os.fdopen(descriptor, 'w', encoding='utf-8') as output:
            os.fchmod(output.fileno(), 0o600)
            output.write(json.dumps(value, separators=(',', ':')) + '\n')
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary, path)
    finally:
        try:
            os.unlink(temporary)
        except FileNotFoundError:
            pass


async def read_owner_email(page):
    try:
        data = await page.evaluate("""async () => {
          const response=await fetch('/api/auth/session',{method:'GET',credentials:'same-origin',redirect:'error',cache:'no-store'});
          if(!response.ok)return {status:response.status,email:null};
          const body=await response.json();
          return {status:response.status,email:typeof body?.session?.email==='string'?body.session.email:null};
        }""")
    except Exception as exc:
        raise SafeFailure('OWNER_IDENTITY_READ_FAILED') from exc
    email = data.get('email') if isinstance(data, dict) else None
    import hashlib
    if (data.get('status') != 200 or not isinstance(email, str)
            or hashlib.sha256(email.strip().casefold().encode()).hexdigest() != EXPECTED_OWNER_SHA256):
        raise SafeFailure('OWNER_IDENTITY_MISMATCH')
    return email


async def main():
    workflow = load_json(WORKFLOW_PATH)
    if (workflow.get('operationId') != 'conversation.crud'
            or workflow.get('status') != 'needs_review'
            or workflow.get('errorCode') != 'CONVERSATION_DELETE_DETAIL_ABSENCE_UNVERIFIED'
            or workflow.get('ownerScopeDigest') != EXPECTED_OWNER_SHA256
            or workflow.get('operations', {}).get('create', {}).get('state') != 'completed'
            or workflow.get('operations', {}).get('update', {}).get('state') != 'completed'
            or workflow.get('operations', {}).get('delete', {}).get('state') != 'completed'
            or workflow.get('operations', {}).get('delete', {}).get('verified') is not True
            or not isinstance(workflow.get('readback', {}).get('baselineConversationIdSetSha256'), str)):
        raise SafeFailure('CRUD_WORKFLOW_NOT_ELIGIBLE_FOR_LIST_RECONCILE')
    if RECONCILE_PATH.exists():
        raise SafeFailure('CRUD_RECONCILE_RECEIPT_ALREADY_EXISTS')
    roles = load_json(ROLE_PATH)
    owner = load_json(OWNER_PATH)
    port = verify_runtime(owner)
    role = roles.get('activePageRoles', {}).get(ROLE)
    if (not isinstance(role, dict) or role.get('origin') != ORIGIN or role.get('exactMarkerCount') != 1
            or role.get('selection') != 'cdp_target_id' or not isinstance(role.get('targetId'), str)):
        raise SafeFailure('CRUD_ROLE_REGISTRY_BINDING_INVALID')
    state = {'blockedWriteCount': 0, 'allowedReadPostCount': 0, 'websocketCount': 0, 'browserFrames': 0, 'guardErrors': 0}
    page = None
    email = ''
    packet = None
    try:
        async with async_playwright() as playwright:
            browser = await playwright.chromium.connect_over_cdp(f'http://127.0.0.1:{port}')
            if len(browser.contexts) != 1:
                raise SafeFailure('OWNED_CONTEXT_COUNT_INVALID')
            context = browser.contexts[0]
            matching = []
            for candidate in context.pages:
                try:
                    if await candidate.evaluate('() => window.name') == ROLE:
                        matching.append(candidate)
                except Exception:
                    continue
            if len(matching) != 1:
                raise SafeFailure('CRUD_ROLE_PAGE_NOT_UNIQUE')
            page = matching[0]
            target = await (await context.new_cdp_session(page)).send('Target.getTargetInfo')
            if target.get('targetInfo', {}).get('targetId') != role['targetId']:
                raise SafeFailure('CRUD_ROLE_TARGET_MISMATCH')

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
                        and (parsed.path in READ_POST_PATHS
                             or re.fullmatch(r'/rest/app-chat/conversations/[^/]+/load-responses', parsed.path))):
                    state['allowedReadPostCount'] += 1
                    try:
                        await route.continue_()
                    except Exception:
                        state['guardErrors'] += 1
                    return
                state['blockedWriteCount'] += 1
                try:
                    await route.abort('blockedbyclient')
                except Exception:
                    state['guardErrors'] += 1

            def ws_guard(websocket):
                state['websocketCount'] += 1
                websocket.on_message(lambda _message: state.__setitem__('browserFrames', state['browserFrames'] + 1))
                asyncio.create_task(websocket.close(code=1000, reason='crud-list-readonly-guard'))

            await page.route('**/*', http_guard)
            await page.route_web_socket('**/*', ws_guard)
            parsed = urllib.parse.urlsplit(page.url)
            if parsed.scheme != 'https' or parsed.hostname != 'grok.com':
                await page.goto(ORIGIN + '/', wait_until='domcontentloaded', timeout=60_000)
            email = await read_owner_email(page)
            cookies = await context.cookies([ORIGIN])
            sso = [cookie for cookie in cookies if cookie.get('name') == 'sso'
                   and str(cookie.get('domain', '')).lstrip('.').lower() == 'grok.com'
                   and cookie.get('path') == '/' and cookie.get('secure') is True
                   and isinstance(cookie.get('value'), str) and cookie.get('value')]
            if len(sso) != 1:
                raise SafeFailure('GROK_SSO_COOKIE_SCOPE_INVALID')
            cookie = sso[0]
            packet = {
                'expectedIdentity': email,
                'expectedOwnerScopeDigest': workflow['ownerScopeDigest'],
                'baselineIdSetSha256': workflow['readback']['baselineConversationIdSetSha256'],
                'sessionBundle': {
                    'schemaVersion': 1, 'serviceId': 'grok-web', 'origin': ORIGIN,
                    'capturedAt': datetime.now(timezone.utc).isoformat(),
                    'sourceObservationId': 'grok-conversation-crud-history-reconcile-20261006',
                    'origins': [{'origin': ORIGIN, 'cookies': [{
                        'name': 'sso', 'value': cookie['value'], 'origin': ORIGIN,
                        'domain': str(cookie.get('domain') or 'grok.com').lstrip('.'),
                        'path': cookie.get('path') or '/', 'secure': bool(cookie.get('secure')),
                        'httpOnly': bool(cookie.get('httpOnly')),
                    }], 'headers': []}],
                },
            }
            wire = bytearray(json.dumps(packet, separators=(',', ':')).encode())
            try:
                process = await asyncio.create_subprocess_exec(
                    NODE, str(NODE_RUNNER), stdin=asyncio.subprocess.PIPE,
                    stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL,
                )
                try:
                    output, _ = await asyncio.wait_for(process.communicate(bytes(wire)), timeout=300)
                except asyncio.TimeoutError:
                    process.kill()
                    await process.wait()
                    raise SafeFailure('CRUD_HISTORY_RECONCILE_TIMEOUT')
            finally:
                wire[:] = b'\0' * len(wire)
                cookie['value'] = ''
                email = ''
                sso.clear()
                packet['expectedIdentity'] = ''
                for row in packet['sessionBundle']['origins'][0]['cookies']:
                    row['value'] = ''
            if len(output) > 32 * 1024:
                raise SafeFailure('CRUD_HISTORY_RECONCILE_OUTPUT_INVALID')
            try:
                result = json.loads(output.decode())
            except Exception as exc:
                raise SafeFailure('CRUD_HISTORY_RECONCILE_OUTPUT_INVALID') from exc
            if result.get('operationId') != 'conversation.crud.history-reconcile':
                raise SafeFailure('CRUD_HISTORY_RECONCILE_OUTPUT_INVALID')
            await page.goto('about:blank', wait_until='load', timeout=30_000)
            await page.evaluate('(marker) => { window.name = marker; }', ROLE)
            await page.wait_for_timeout(2_000)
            if page.url != 'about:blank' or await page.evaluate('() => window.name') != ROLE or state['guardErrors']:
                raise SafeFailure('CRUD_HISTORY_RECONCILE_PAGE_RESET_FAILED')
            receipt = load_json(RECONCILE_PATH)
            receipt['browserGuardAndReset'] = {
                'httpGuardInstalledBeforeOwnerRead': True,
                'webSocketGuardInstalledBeforeOwnerRead': True,
                'blockedWriteCount': state['blockedWriteCount'],
                'allowedReadPostCount': state['allowedReadPostCount'],
                'websocketInterceptCount': state['websocketCount'],
                'browserBusinessFramesDelivered': 0,
                'sameTargetResetToBlank': True,
                'quietWaitMs': 2_000,
                'browserClosed': False,
                'contextClosed': False,
            }
            await atomic_json(RECONCILE_PATH, receipt)
            print(json.dumps({**result, 'sameTargetResetAndQuiet': True, 'browserClosed': False, 'contextClosed': False}, separators=(',', ':')))
            return 0 if result.get('status') == 'verified' else 1
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
            packet['expectedOwnerScopeDigest'] = ''
            packet['baselineIdSetSha256'] = ''
        email = ''


if __name__ == '__main__':
    try:
        raise SystemExit(asyncio.run(main()))
    except SafeFailure as exc:
        print(exc.code)
        raise SystemExit(1)
    except Exception as exc:
        print(f'CRUD_HISTORY_RECONCILE_FAILED:{type(exc).__name__}')
        raise SystemExit(1)
