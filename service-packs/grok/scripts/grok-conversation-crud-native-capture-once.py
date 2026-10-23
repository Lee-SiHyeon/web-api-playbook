#!/usr/bin/env python3
"""Capture the normal Grok empty-chat create request on one guarded owned page."""

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
CREATE_PATH = '/rest/app-chat/conversations'
SDK_URL = 'https://cdn.grok.com/_next/static/chunks/27akar72ihacg.js'
SDK_SHA256 = '8dcfb562e2b3f83f866c23c82f73503c52a409620c8830697d6cade848644759'
SDK_FUNCTION = 'chatCreateConversationRaw'
ADAPTER_FILE = RUNTIME / 'grok-public-source/205b03gn_m2ip.js'
SDK_FILE = RUNTIME / 'grok-public-source/27akar72ihacg.js'
EXPECTED_OWNER_SHA256 = '23e57131977ce522bacf6649eb27538770828a890f7a65589ec4f0960a84b3d7'
RECEIPT_PATH = REPO / 'verification/grok-conversation-create-native-capture-2026-10-06.json'
CAPTURE_TIMEOUT_SECONDS = 12
NODE_READ_POST_PATHS = {
    '/rest/models', '/rest/modes', '/rest/models/imagine/overrides',
    '/rest/connectors/list-v2', '/rest/connectors/list-available-v2',
    '/rest/connectors/finance/connections', '/rest/skills', '/rest/system-prompt/list',
}
ID_SEGMENT = re.compile(r'^[A-Za-z0-9_-]{16,}$')


class SafeFailure(Exception):
    def __init__(self, code, details=None):
        self.code = code
        self.details = details or {}


def sha256(value):
    return hashlib.sha256(value).hexdigest()


def load_json(path):
    try:
        return json.loads(path.read_text(encoding='utf-8'))
    except Exception as exc:
        raise SafeFailure('CRUD_RUNTIME_METADATA_INVALID') from exc


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
        expected = f'--user-data-dir={profile}'.encode()
        if expected not in argv:
            raise SafeFailure('OWNED_PROFILE_MISMATCH')
    except Exception as exc:
        if isinstance(exc, SafeFailure):
            raise
        raise SafeFailure('OWNED_RUNTIME_UNAVAILABLE') from exc
    return port


def update_role_registry(target_id):
    with ROLE_LOCK.open('r+') as stream:
        fcntl.flock(stream, fcntl.LOCK_EX)
        latest = load_json(ROLE_PATH)
        roles = latest.setdefault('activePageRoles', {})
        if ROLE in roles or any(value.get('targetId') == target_id for value in roles.values() if isinstance(value, dict)):
            raise SafeFailure('CRUD_ROLE_COLLISION')
        roles[ROLE] = {
            'origin': ORIGIN,
            'exactMarkerCount': 1,
            'selection': 'cdp_target_id',
            'targetId': target_id,
        }
        descriptor, temporary_name = tempfile.mkstemp(prefix='.page-role-registry-crud.', dir=RUNTIME)
        try:
            with os.fdopen(descriptor, 'w', encoding='utf-8') as output:
                os.fchmod(output.fileno(), 0o600)
                output.write(json.dumps(latest, separators=(',', ':')) + '\n')
                output.flush()
                os.fsync(output.fileno())
            os.replace(temporary_name, ROLE_PATH)
        finally:
            try:
                os.unlink(temporary_name)
            except FileNotFoundError:
                pass
            fcntl.flock(stream, fcntl.LOCK_UN)


def path_template(url):
    parsed = urllib.parse.urlsplit(url)
    segments = []
    for segment in parsed.path.split('/'):
        if ID_SEGMENT.fullmatch(segment) or re.fullmatch(r'[0-9a-fA-F]{8}-[0-9a-fA-F-]{27,}', segment):
            segments.append('{opaque}')
        else:
            segments.append(segment)
    return '/'.join(segments)


def event_type(message):
    if isinstance(message, bytes):
        return 'binary'
    try:
        parsed = json.loads(message)
        event = parsed.get('event') if isinstance(parsed, dict) else None
        value = event.get('type') if isinstance(event, dict) else None
        return value if isinstance(value, str) and re.fullmatch(r'[A-Za-z0-9._-]{1,96}', value) else 'json_unclassified'
    except Exception:
        return 'json_unclassified'


async def atomic_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
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


async def read_owner_email(page):
    try:
        value = await page.evaluate("""async () => {
          const response = await fetch('/api/auth/session', {
            method: 'GET', credentials: 'same-origin', redirect: 'error', cache: 'no-store'
          });
          if (!response.ok) return {status: response.status, email: null};
          const body = await response.json();
          return {status: response.status,
            email: body && body.session && typeof body.session.email === 'string' ? body.session.email : null};
        }""")
    except Exception as exc:
        raise SafeFailure('OWNER_IDENTITY_READ_FAILED') from exc
    email = value.get('email') if isinstance(value, dict) else None
    if value.get('status') != 200 or not isinstance(email, str):
        raise SafeFailure('OWNER_IDENTITY_READ_FAILED')
    if sha256(email.strip().casefold().encode('utf-8')) != EXPECTED_OWNER_SHA256:
        raise SafeFailure('OWNER_IDENTITY_MISMATCH')
    return email


def capture_source_files():
    try:
        sdk = SDK_FILE.read_bytes()
        adapter = ADAPTER_FILE.read_bytes()
    except Exception as exc:
        raise SafeFailure('GROK_PUBLIC_SDK_SOURCE_UNAVAILABLE') from exc
    if sha256(sdk) != SDK_SHA256 or b'async chatCreateConversationRaw' not in sdk:
        raise SafeFailure('GROK_CREATE_SDK_SOURCE_MISMATCH')
    adapter_call = b'createChatConversation:async e=>b.chatApi.chatCreateConversation({body:{systemPromptName:"",temporary:!1'
    if adapter_call not in adapter:
        raise SafeFailure('GROK_CREATE_UI_ADAPTER_SOURCE_MISMATCH')
    return {
        'sourceUrl': SDK_URL,
        'sourceSha256': SDK_SHA256,
        'sourceFunctionName': SDK_FUNCTION,
        'adapterSourceUrl': 'https://cdn.grok.com/_next/static/chunks/205b03gn_m2ip.js',
        'adapterSourceSha256': sha256(adapter),
        'normalUiAdapterMatched': True,
    }


async def create_new_page(browser):
    contexts = browser.contexts
    if len(contexts) != 1:
        raise SafeFailure('OWNED_CONTEXT_COUNT_INVALID')
    context = contexts[0]
    registry = load_json(ROLE_PATH)
    registered = registry.get('activePageRoles', {}).get(ROLE)
    for existing in context.pages:
        try:
            if await existing.evaluate('() => window.name') != ROLE:
                continue
            if (not isinstance(registered, dict) or registered.get('selection') != 'cdp_target_id'
                    or not isinstance(registered.get('targetId'), str)):
                raise SafeFailure('CRUD_ROLE_REGISTRY_BINDING_INVALID')
            cdp = await context.new_cdp_session(existing)
            info = await cdp.send('Target.getTargetInfo')
            target_id = info.get('targetInfo', {}).get('targetId')
            if target_id != registered['targetId']:
                raise SafeFailure('CRUD_ROLE_TARGET_BINDING_INVALID')
            return context, existing, target_id
        except SafeFailure:
            raise
        except Exception:
            continue
    if registered is not None:
        raise SafeFailure('CRUD_REGISTERED_TARGET_NOT_FOUND')
    page = await context.new_page()
    await page.evaluate('(marker) => { window.name = marker; }', ROLE)
    cdp = await context.new_cdp_session(page)
    info = await cdp.send('Target.getTargetInfo')
    target_id = info.get('targetInfo', {}).get('targetId')
    if not isinstance(target_id, str) or len(target_id) < 8:
        raise SafeFailure('CRUD_TARGET_ID_UNAVAILABLE')
    update_role_registry(target_id)
    return context, page, target_id


async def inspect_ui_controls(page):
    try:
        return await page.evaluate("""() => {
          const visible=e=>!!(e.getClientRects().length&&getComputedStyle(e).visibility!=='hidden');
          const buttons=[...document.querySelectorAll('button,[role=button]')].filter(visible);
          const label=e=>((e.getAttribute('aria-label')||'')+' '+(e.getAttribute('data-testid')||'')+' '+(e.getAttribute('title')||'')+' '+(e.innerText||'')).toLowerCase();
          const newChats=buttons.filter(e=>/new chat|new conversation|start new chat/.test(label(e)));
          const composers=[...document.querySelectorAll('textarea,[contenteditable=true],[role=textbox]')]
            .filter(visible).filter(e=>!/(search|filter)/i.test((e.getAttribute('aria-label')||'')+' '+(e.getAttribute('placeholder')||'')));
          const sends=buttons.filter(e=>/send|submit/.test(label(e)));
          const composerEmpty=composers.length===1 ? (composers[0].isContentEditable ? !(composers[0].innerText||'').trim() : !(composers[0].value||'').trim()) : false;
          return {newChatCount:newChats.length,newChatIndex:newChats.length===1?buttons.indexOf(newChats[0]):-1,
            composerCount:composers.length,composerTag:composers.length===1?composers[0].tagName.toLowerCase():null,
            composerEmpty,sendButtonCount:sends.length,sendButtonIndex:sends.length===1?buttons.indexOf(sends[0]):-1};
        }""")
    except Exception as exc:
        raise SafeFailure('GROK_UI_CONTROL_DISCOVERY_FAILED') from exc


async def main():
    owner = load_json(OWNER_PATH)
    roles = load_json(ROLE_PATH)
    port = verify_runtime(owner)
    if RECEIPT_PATH.exists():
        raise SafeFailure('CRUD_NATIVE_CAPTURE_RECEIPT_ALREADY_EXISTS')
    source = capture_source_files()
    state = {
        'businessHttpAbortCount': 0,
        'allowedReadPostCount': 0,
        'createRequestCount': 0,
        'createAbortAcknowledged': False,
        'capture': None,
        'captureValid': False,
        'invalidCreateCaptureCount': 0,
        'guardParseFailureCount': 0,
        'websocketInterceptCount': 0,
        'browserBusinessFrameCount': 0,
        'blockedFrameTypeCounts': {},
        'blockedHttpByOperation': {},
        'postResetHttpAbortStartCount': 0,
    }
    page = None
    context = None
    target_id = ''
    email = ''
    receipt = None
    try:
        async with async_playwright() as playwright:
            browser = await playwright.chromium.connect_over_cdp(f'http://127.0.0.1:{port}')
            context, page, target_id = await create_new_page(browser)

            async def ws_handler(websocket):
                state['websocketInterceptCount'] += 1
                def drop_page_message(message):
                    state['browserBusinessFrameCount'] += 1
                    kind = event_type(message)
                    state['blockedFrameTypeCounts'][kind] = state['blockedFrameTypeCounts'].get(kind, 0) + 1
                websocket.on_message(drop_page_message)
                try:
                    await websocket.close(code=1000, reason='grok-crud-capture-guard')
                except Exception:
                    state['guardParseFailureCount'] += 1

            async def http_guard(route):
                request = route.request
                parsed = urllib.parse.urlsplit(request.url)
                method = request.method.upper()
                path = parsed.path
                if method in {'GET', 'HEAD', 'OPTIONS'}:
                    try:
                        await route.continue_()
                    except Exception:
                        state['guardParseFailureCount'] += 1
                    return
                if (parsed.scheme == 'https' and parsed.hostname == 'grok.com' and method == 'POST'
                        and (path in NODE_READ_POST_PATHS
                             or re.fullmatch(r'/rest/app-chat/conversations/[^/]+/load-responses', path))):
                    state['allowedReadPostCount'] += 1
                    try:
                        await route.continue_()
                    except Exception:
                        state['guardParseFailureCount'] += 1
                    return
                if parsed.scheme == 'https' and parsed.hostname == 'grok.com' and method == 'POST' and path == CREATE_PATH:
                    state['createRequestCount'] += 1
                    if state['createRequestCount'] == 1:
                        try:
                            raw = request.post_data or ''
                            raw_bytes = raw.encode('utf-8')
                            body = json.loads(raw) if len(raw_bytes) <= 65_536 else None
                            header_names = sorted(str(name).lower() for name in request.headers.keys())
                            content_type = str(request.headers.get('content-type', '')).split(';', 1)[0].strip().lower()
                            body_fields = list(body.keys()) if isinstance(body, dict) else []
                            valid = (parsed.query == '' and content_type == 'application/json'
                                     and isinstance(body, dict)
                                     and body_fields == ['systemPromptName', 'temporary']
                                     and body.get('systemPromptName') == ''
                                     and body.get('temporary') is False)
                            state['capture'] = {
                                'method': method,
                                'origin': f'{parsed.scheme}://{parsed.netloc}',
                                'path': path,
                                'contentType': content_type,
                                'sourceUrl': source['sourceUrl'],
                                'sourceSha256': source['sourceSha256'],
                                'sourceFunctionName': source['sourceFunctionName'],
                                'normalUiAdapterMatched': source['normalUiAdapterMatched'],
                                'adapterSourceUrl': source['adapterSourceUrl'],
                                'adapterSourceSha256': source['adapterSourceSha256'],
                                'requestHeaderNames': header_names,
                                'cookieNames': ['sso'],
                                'browserRequestAbortConfirmed': False,
                                'browserRequestReachedProvider': False,
                                'body': body if valid else None,
                                'requestBodySha256': sha256(raw_bytes),
                                'rawRequestBodyPersisted': False,
                            }
                            state['captureValid'] = valid
                            if not valid:
                                state['invalidCreateCaptureCount'] += 1
                        except Exception:
                            state['captureValid'] = False
                            state['invalidCreateCaptureCount'] += 1
                    try:
                        await route.abort('blockedbyclient')
                        if state['createRequestCount'] == 1 and state['capture'] is not None:
                            state['capture']['browserRequestAbortConfirmed'] = True
                            state['createAbortAcknowledged'] = True
                    except Exception:
                        state['guardParseFailureCount'] += 1
                    state['businessHttpAbortCount'] += 1
                    state['blockedHttpByOperation']['conversation.create'] = state['blockedHttpByOperation'].get('conversation.create', 0) + 1
                    return
                state['businessHttpAbortCount'] += 1
                template = path_template(request.url)
                key = f'{method} {template}'
                state['blockedHttpByOperation'][key] = state['blockedHttpByOperation'].get(key, 0) + 1
                try:
                    await route.abort('blockedbyclient')
                except Exception:
                    state['guardParseFailureCount'] += 1

            await page.route('**/*', http_guard)
            await page.route_web_socket('**/*', ws_handler)
            await page.goto(ORIGIN + '/', wait_until='domcontentloaded', timeout=90_000)
            await page.wait_for_timeout(4_000)
            if await page.evaluate('() => window.name') != ROLE:
                raise SafeFailure('CRUD_ROLE_MARKER_MISMATCH')
            page_path = urllib.parse.urlsplit(page.url).path
            if page_path not in {'/', '/app'}:
                raise SafeFailure('CRUD_ROLE_NOT_ON_EMPTY_APP_ROUTE')
            email = await read_owner_email(page)
            cookie_rows = await context.cookies([ORIGIN])
            scoped_sso = [cookie for cookie in cookie_rows
                          if cookie.get('name') == 'sso'
                          and str(cookie.get('domain', '')).lstrip('.').lower() == 'grok.com'
                          and cookie.get('path') == '/' and cookie.get('secure') is True
                          and isinstance(cookie.get('value'), str) and cookie.get('value')]
            if len(scoped_sso) != 1:
                raise SafeFailure('GROK_SSO_COOKIE_SCOPE_INVALID')
            ui = await inspect_ui_controls(page)
            if ui['newChatCount'] > 1:
                raise SafeFailure('GROK_NEW_CHAT_CONTROL_AMBIGUOUS')
            if ui['newChatCount'] == 1:
                clicked = await page.evaluate("""() => {
                  const visible=e=>!!(e.getClientRects().length&&getComputedStyle(e).visibility!=='hidden');
                  const buttons=[...document.querySelectorAll('button,[role=button]')].filter(visible);
                  const label=e=>((e.getAttribute('aria-label')||'')+' '+(e.getAttribute('data-testid')||'')+' '+(e.getAttribute('title')||'')+' '+(e.innerText||'')).toLowerCase();
                  const matches=buttons.filter(e=>/new chat|new conversation|start new chat/.test(label(e)));
                  if(matches.length!==1)return {count:matches.length,clicked:false};
                  matches[0].click();return {count:1,clicked:true};
                }""")
                if clicked.get('clicked') is not True:
                    raise SafeFailure('GROK_NEW_CHAT_CONTROL_NOT_UNIQUE')
                await page.wait_for_timeout(750)
                ui = await inspect_ui_controls(page)
            if ui['composerCount'] != 1 or ui['composerEmpty'] is not True:
                raise SafeFailure('GROK_NEW_CHAT_COMPOSER_NOT_UNIQUE')
            neutral_marker = f'Grok CRUD guarded native capture {random_uuid_text()}'
            selector = '[contenteditable="true"]:visible,textarea:visible,[role="textbox"]:visible'
            composer = page.locator(selector)
            if await composer.count() != 1:
                raise SafeFailure('GROK_COMPOSER_LOCATOR_NOT_UNIQUE')
            await composer.first.fill(neutral_marker, timeout=10_000)
            entered = await composer.first.evaluate('(node,marker) => node.isContentEditable ? (node.innerText===marker) : (node.value===marker)', neutral_marker)
            if entered is not True:
                raise SafeFailure('GROK_NEUTRAL_LOCAL_COMPOSER_ENTRY_FAILED')
            ui = await inspect_ui_controls(page)
            if ui['sendButtonCount'] != 1:
                raise SafeFailure('GROK_SEND_CONTROL_NOT_UNIQUE')
            send_clicked = await page.evaluate("""() => {
              const visible=e=>!!(e.getClientRects().length&&getComputedStyle(e).visibility!=='hidden');
              const buttons=[...document.querySelectorAll('button,[role=button]')].filter(visible);
              const label=e=>((e.getAttribute('aria-label')||'')+' '+(e.getAttribute('data-testid')||'')+' '+(e.getAttribute('title')||'')+' '+(e.innerText||'')).toLowerCase();
              const matches=buttons.filter(e=>/send|submit/.test(label(e)));
              if(matches.length!==1)return {count:matches.length,clicked:false};
              matches[0].click();return {count:1,clicked:true};
            }""")
            if send_clicked.get('clicked') is not True:
                raise SafeFailure('GROK_SEND_CONTROL_NOT_UNIQUE')
            end = asyncio.get_running_loop().time() + CAPTURE_TIMEOUT_SECONDS
            while asyncio.get_running_loop().time() < end and state['createRequestCount'] == 0:
                await asyncio.sleep(0.1)
            await page.wait_for_timeout(1_500)
            if (state['createRequestCount'] != 1 or not state['createAbortAcknowledged']
                    or state['captureValid'] is not True or state['guardParseFailureCount'] != 0):
                raise SafeFailure('GROK_CREATE_NATIVE_CAPTURE_UNVERIFIED', {
                    'createRequestCount': state['createRequestCount'],
                    'createCaptureValid': state['captureValid'] is True,
                    'createAbortAcknowledged': state['createAbortAcknowledged'] is True,
                    'guardErrorCount': state['guardParseFailureCount'],
                    'websocketInterceptCount': state['websocketInterceptCount'],
                    'browserBusinessFrameCount': state['browserBusinessFrameCount'],
                    'browserBusinessHttpAbortCount': state['businessHttpAbortCount'],
                    'blockedHttpOperationCounts': state['blockedHttpByOperation'],
                    'composerControlUnique': ui['composerCount'] == 1,
                    'sendControlUnique': ui['sendButtonCount'] == 1,
                })

            after_abort_ui = await inspect_ui_controls(page)
            if after_abort_ui['composerCount'] > 1:
                raise SafeFailure('GROK_POST_ABORT_UI_AMBIGUOUS')
            await page.goto(ORIGIN + '/', wait_until='domcontentloaded', timeout=60_000)
            await page.wait_for_timeout(2_000)
            page_reset = (urllib.parse.urlsplit(page.url).scheme == 'https'
                          and urllib.parse.urlsplit(page.url).hostname == 'grok.com'
                          and urllib.parse.urlsplit(page.url).path in {'/', '/app'}
                          and await page.evaluate('() => window.name') == ROLE)
            if not page_reset:
                raise SafeFailure('GROK_CRUD_CAPTURE_PAGE_RESET_FAILED')

            capture = state['capture']
            safe_receipt = {
                'schemaVersion': 1,
                'operationId': 'conversation.create',
                'status': 'captured',
                'observedAt': datetime.now(timezone.utc).isoformat(),
                'pageRole': ROLE,
                'targetIdSha256': sha256(target_id.encode('utf-8')),
                'ownerMatched': True,
                'ownerSha256MatchedApproved': True,
                'method': 'POST',
                'pathTemplate': CREATE_PATH,
                'contentType': 'application/json',
                'exactCreateRequestCount': 1,
                'requestBodyFieldNames': ['systemPromptName', 'temporary'],
                'systemPromptNameEmpty': True,
                'temporaryFalse': True,
                'requestBodySha256': capture['requestBodySha256'],
                'requestBodyPersisted': False,
                'requestHeaderNames': capture['requestHeaderNames'],
                'cookieNames': ['sso'],
                'source': {
                    'sourceUrl': source['sourceUrl'],
                    'sourceSha256': source['sourceSha256'],
                    'sourceFunctionName': source['sourceFunctionName'],
                    'adapterSourceUrl': source['adapterSourceUrl'],
                    'adapterSourceSha256': source['adapterSourceSha256'],
                    'normalUiAdapterMatched': True,
                },
                'browserRequestAbortConfirmed': True,
                'browserRequestReachedProvider': False,
                'browserBusinessHttpAbortCount': state['businessHttpAbortCount'],
                'blockedHttpOperationCounts': state['blockedHttpByOperation'],
                'allowedReadPostCount': state['allowedReadPostCount'],
                'websocketInterceptCount': state['websocketInterceptCount'],
                'browserBusinessFrameCount': state['browserBusinessFrameCount'],
                'blockedFrameTypeCounts': state['blockedFrameTypeCounts'],
                'browserBusinessFramesDelivered': 0,
                'newChatControlCount': ui['newChatCount'],
                'composerCount': ui['composerCount'],
                'sendButtonCount': ui['sendButtonCount'],
                'neutralLocalComposerEntry': True,
                'providerTextOrGenerationDispatched': False,
                'pageResetToAppRoot': True,
                'rawConversationIdPersisted': False,
                'rawTitleOrPromptPersisted': False,
                'requestBodyPersisted': False,
                'responseBodyPersisted': False,
                'cookiesOrTokensPersisted': False,
            }
            await atomic_json(RECEIPT_PATH, safe_receipt)
            print(json.dumps({
                'status': 'captured',
                'operationId': 'conversation.create',
                'method': 'POST',
                'pathTemplate': CREATE_PATH,
                'exactCreateRequestCount': 1,
                'browserRequestReachedProvider': False,
                'browserBusinessFramesDelivered': 0,
                'nativeCapturePath': 'verification/grok-conversation-create-native-capture-2026-10-06.json',
                'pageRole': ROLE,
                'pageResetAndQuiet': True,
                'browserClosed': False,
                'contextClosed': False,
            }, separators=(',', ':')))
            capture['body'] = {}
            email = ''
            return 0
    finally:
        if page and not page.is_closed():
            try:
                await page.goto(ORIGIN + '/', wait_until='domcontentloaded', timeout=30_000)
                await page.wait_for_timeout(1_000)
            except Exception:
                pass
        if isinstance(state.get('capture'), dict):
            state['capture']['body'] = None
            state['capture'] = None
        email = ''
        target_id = ''


def random_uuid_text():
    import uuid
    return str(uuid.uuid4())


if __name__ == '__main__':
    try:
        exit_code = asyncio.run(main())
    except SafeFailure as exc:
        print(json.dumps({'status': 'needs_review', 'errorCode': exc.code, 'safeDetails': exc.details}, separators=(',', ':')))
        exit_code = 1
    except Exception as exc:
        print(f'GROK_CRUD_CAPTURE_FAILED:{type(exc).__name__}')
        exit_code = 1
    raise SystemExit(exit_code)
