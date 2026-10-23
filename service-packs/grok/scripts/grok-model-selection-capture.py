"""Read the current Grok mode selector through a task-owned guarded Chrome tab.

Only the source-derived model-list reads pass. Other API reads are blocked to
keep the discovery page from loading conversation history; every mutating HTTP
request and every page-originated WebSocket frame is dropped before delivery.
The script intentionally never closes the shared browser or its context.
"""

import fcntl
import hashlib
import json
import os
import re
import tempfile
import time
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlsplit

from playwright.sync_api import sync_playwright


BASE = Path('/home/worker/.nad-scratch/provider-runtime-20261005')
OWNER_PATH = BASE / 'runtime-owner.json'
ROLE_PATH = BASE / 'page-role-registry.json'
ROLE = 'codex-grok-models-20261006'
ORIGIN = 'https://grok.com'
ROOT = Path(__file__).resolve().parents[1]
RECEIPT_PATH = ROOT / 'verification/grok-model-selection-live-2026-10-06.json'
WRITE_METHODS = {'POST', 'PUT', 'PATCH', 'DELETE'}
STATIC_TYPES = {'document', 'font', 'image', 'media', 'script', 'stylesheet'}
STATIC_HOSTS = {'grok.com', 'cdn.grok.com', 'assets.grok.com', 'fonts.googleapis.com', 'fonts.gstatic.com'}
MODE_ID = re.compile(r'^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$')
TEXT_LIMIT = 2_000


def _safe_text(value, limit=TEXT_LIMIT):
    if isinstance(value, str) and value.strip() and len(value) <= limit and not re.search(r'[\r\n\0]', value):
        return value.strip()
    return None


def _normalize_mode_catalog(payload):
    if not isinstance(payload, dict) or not isinstance(payload.get('modes'), list) or len(payload['modes']) > 500:
        return None
    modes = []
    seen = set()
    for mode in payload['modes']:
        if not isinstance(mode, dict):
            return None
        mode_id = mode.get('id')
        title = _safe_text(mode.get('title'), 512)
        if not isinstance(mode_id, str) or not MODE_ID.fullmatch(mode_id) or not title or mode_id in seen:
            return None
        seen.add(mode_id)
        availability = mode.get('availability')
        if availability is not None and not isinstance(availability, dict):
            return None
        available = availability.get('available') if isinstance(availability, dict) else None
        if available is not None and not isinstance(available, bool):
            return None
        option = {'id': mode_id, 'title': title, 'available': available}
        for field in ('description', 'badgeText', 'iconHint'):
            value = _safe_text(mode.get(field), 512 if field != 'description' else TEXT_LIMIT)
            if value is not None:
                option[field] = value
        if isinstance(availability, dict):
            requirements = availability.get('requiresUpgrade')
            if isinstance(requirements, dict):
                tier = _safe_text(requirements.get('minimumSubscriptionTier'), 128)
                if tier:
                    option['minimumSubscriptionTier'] = tier
        modes.append(option)
    default_mode_id = payload.get('defaultModeId')
    if default_mode_id is not None and (not isinstance(default_mode_id, str) or not MODE_ID.fullmatch(default_mode_id)):
        return None
    return {'defaultModeId': default_mode_id, 'modes': modes}


def _path_class(path):
    if path == '/rest/modes':
        return 'model-modes'
    if path == '/rest/models':
        return 'public-models'
    if path.startswith('/rest/app-chat/conversations'):
        return 'conversation-api'
    if path.startswith('/rest/assets'):
        return 'asset-api'
    if path.startswith('/rest/'):
        return 'other-rest-api'
    if path.startswith('/api/'):
        return 'other-api'
    return 'other'


def _field_names(post_data):
    if not isinstance(post_data, str) or len(post_data.encode('utf-8', errors='ignore')) > 64 * 1024:
        return []
    try:
        value = json.loads(post_data)
    except Exception:
        return []
    return sorted(str(key)[:80] for key in value) if isinstance(value, dict) else []


def _safe_mode_ui(page):
    return page.evaluate("""() => {
      const visible = e => !!(e.getClientRects().length && getComputedStyle(e).visibility !== 'hidden');
      const clean = value => (value || '').replace(/\\s+/g, ' ').trim().slice(0, 512);
      const root = document.querySelector('[data-query-bar-mode-select]');
      const trigger = root ? [...root.querySelectorAll('button,[role=button]')].filter(visible) : [];
      const menus = [...document.querySelectorAll('[role=menu],[role=listbox],[role=dialog]')].filter(visible);
      const itemSelector = '[role=menuitem],[role=menuitemradio],[role=menuitemcheckbox],[role=option],[role=radio],[role=menu] button,[role=listbox] button';
      const items = menus.flatMap(menu => [...menu.querySelectorAll(itemSelector)].filter(visible));
      const label = e => clean(e.innerText || e.getAttribute('aria-label') || e.getAttribute('title'));
      return {
        selectorContainerCount: document.querySelectorAll('[data-query-bar-mode-select]').length,
        triggerCount: trigger.length,
        triggerLabel: trigger.length === 1 ? label(trigger[0]) : null,
        triggerExpanded: trigger.length === 1 ? trigger[0].getAttribute('aria-expanded') : null,
        menuContainerCount: menus.length,
        menuItems: items.map(e => ({
          label: label(e),
          role: e.getAttribute('role') || e.tagName.toLowerCase(),
          selected: e.getAttribute('aria-selected') === 'true' || e.getAttribute('aria-checked') === 'true',
          disabled: e.getAttribute('aria-disabled') === 'true' || !!e.disabled
        })).filter(e => e.label)
      };
    }""")


def _write_receipt(receipt):
    RECEIPT_PATH.parent.mkdir(parents=True, exist_ok=True)
    fd, temp_path = tempfile.mkstemp(prefix='.grok-model-selection-', suffix='.json', dir=RECEIPT_PATH.parent)
    try:
        with os.fdopen(fd, 'w', encoding='utf-8') as stream:
            json.dump(receipt, stream, indent=2, ensure_ascii=False)
            stream.write('\n')
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temp_path, RECEIPT_PATH)
    finally:
        try:
            os.unlink(temp_path)
        except FileNotFoundError:
            pass


def main():
    owner = json.loads(OWNER_PATH.read_text(encoding='utf-8'))
    if owner.get('taskOwned') is not True or int(owner.get('cdpPort', 0)) != 55093:
        raise SystemExit('TASK_OWNED_RUNTIME_REQUIRED')
    chrome_pid = int(owner['chromePid'])
    command_line = Path(f'/proc/{chrome_pid}/cmdline').read_bytes().decode(errors='ignore').split('\0')
    profile_arg = f"--user-data-dir={Path(owner['profile']).resolve()}"
    if profile_arg not in command_line:
        raise SystemExit('TASK_CHROME_PROFILE_MISMATCH')

    state = {
        'httpWriteBlocks': 0,
        'blockedWritePathClasses': {},
        'readBlocks': {},
        'allowedModelReadPosts': [],
        'modelCatalog': None,
        'modelCatalogHttpStatus': None,
        'modelCatalogContentType': None,
        'modelCatalogResponseBytes': None,
        'websocketConnections': 0,
        'websocketPageFramesDropped': 0,
        'websocketServerFramesForwarded': 0,
        'navigationBlocked': False,
        'markerVerified': False,
        'ownerSessionObserved': False,
        'uiBeforeOpen': None,
        'uiAfterOpen': None,
        'opened': False,
    }

    with sync_playwright() as playwright:
        browser = playwright.chromium.connect_over_cdp(f"http://127.0.0.1:{int(owner['cdpPort'])}")
        if len(browser.contexts) != 1:
            raise SystemExit('TASK_CONTEXT_NOT_UNIQUE')
        context = browser.contexts[0]
        for existing in context.pages:
            try:
                if existing.evaluate('() => window.name') == ROLE:
                    raise SystemExit('MODEL_PAGE_ROLE_ALREADY_EXISTS')
            except SystemExit:
                raise
            except Exception:
                continue

        page = context.new_page()
        page.evaluate('(role) => { window.name = role; }', ROLE)
        if page.evaluate('() => window.name') != ROLE:
            raise SystemExit('MODEL_PAGE_ROLE_MARKER_FAILED')

        registry_lock = ROLE_PATH.with_suffix('.lock')
        with registry_lock.open('a+', encoding='utf-8') as lock_stream:
            fcntl.flock(lock_stream.fileno(), fcntl.LOCK_EX)
            roles = json.loads(ROLE_PATH.read_text(encoding='utf-8'))
            active_roles = roles.setdefault('activePageRoles', {})
            if ROLE in active_roles:
                raise SystemExit('MODEL_PAGE_ROLE_ALREADY_REGISTERED')
            active_roles[ROLE] = {
                'origin': ORIGIN,
                'exactMarkerCount': 1,
                'selection': 'owned_origin_and_exact_marker',
            }
            temp = ROLE_PATH.with_name(f'.{ROLE_PATH.name}.{os.getpid()}.tmp')
            temp.write_text(json.dumps(roles, indent=2) + '\n', encoding='utf-8')
            os.replace(temp, ROLE_PATH)
            fcntl.flock(lock_stream.fileno(), fcntl.LOCK_UN)

        def http_guard(route):
            request = route.request
            parsed = urlsplit(request.url)
            path = parsed.path or '/'
            method = request.method.upper()
            resource_type = request.resource_type.lower()
            same_origin = parsed.scheme == 'https' and parsed.hostname == 'grok.com'
            allowed_model_read = False
            if same_origin and method == 'POST' and path in {'/rest/models', '/rest/modes'} and not parsed.query:
                try:
                    body = request.post_data_json
                    locale = body.get('locale') if isinstance(body, dict) and set(body) == {'locale'} else None
                    allowed_model_read = isinstance(locale, str) and 0 < len(locale) <= 32 and not re.search(r'[\r\n\0]', locale)
                except Exception:
                    allowed_model_read = False
            if method in WRITE_METHODS and not allowed_model_read:
                state['httpWriteBlocks'] += 1
                path_class = _path_class(path)
                counts = state['blockedWritePathClasses']
                counts[path_class] = counts.get(path_class, 0) + 1
                route.abort('blockedbyclient')
                return
            if allowed_model_read:
                state['allowedModelReadPosts'].append({'path': path, 'bodyFieldNames': ['locale']})
                route.continue_()
                return
            if same_origin:
                safe_read = (
                    path == '/api/auth/session' and method == 'GET' and not parsed.query
                ) or (
                    path in {'/rest/models', '/rest/modes'} and method == 'GET' and not parsed.query
                )
                is_static = path == '/' or path.startswith('/_next/') or resource_type in STATIC_TYPES
                if (path.startswith('/rest/') or path.startswith('/api/')) and not safe_read:
                    state['readBlocks'][_path_class(path)] = state['readBlocks'].get(_path_class(path), 0) + 1
                    route.abort('blockedbyclient')
                    return
                if not is_static and resource_type in {'fetch', 'xhr'}:
                    state['readBlocks']['unscoped_fetch'] = state['readBlocks'].get('unscoped_fetch', 0) + 1
                    route.abort('blockedbyclient')
                    return
            elif method not in {'GET', 'HEAD', 'OPTIONS'} and not allowed_model_read:
                route.abort('blockedbyclient')
                return
            route.continue_()

        def websocket_guard(websocket_route):
            state['websocketConnections'] += 1
            server = websocket_route.connect_to_server()

            def drop_page_frame(_message):
                state['websocketPageFramesDropped'] += 1

            def forward_server_frame(message):
                state['websocketServerFramesForwarded'] += 1
                websocket_route.send(message)

            websocket_route.on_message(drop_page_frame)
            server.on_message(forward_server_frame)

        def observe_response(response):
            request = response.request
            parsed = urlsplit(request.url)
            if parsed.scheme != 'https' or parsed.hostname != 'grok.com' or parsed.path != '/rest/modes':
                return
            if request.method.upper() != 'POST':
                return
            state['modelCatalogHttpStatus'] = response.status
            state['modelCatalogContentType'] = response.headers.get('content-type', '').split(';', 1)[0].strip().lower()
            try:
                raw = response.body()
                state['modelCatalogResponseBytes'] = len(raw)
                payload = json.loads(raw.decode('utf-8'))
                state['modelCatalog'] = _normalize_mode_catalog(payload)
            except Exception:
                state['modelCatalog'] = None

        page.route('**/*', http_guard)
        page.route_web_socket('wss://grok.com/**', websocket_guard)
        page.on('response', observe_response)
        if page.evaluate('() => window.name') != ROLE:
            raise SystemExit('MODEL_PAGE_ROLE_CHANGED_BEFORE_NAVIGATION')
        page.goto(ORIGIN + '/', wait_until='domcontentloaded', timeout=90_000)
        page.wait_for_timeout(6_000)
        if page.evaluate('() => window.name') != ROLE or urlsplit(page.url).hostname != 'grok.com':
            raise SystemExit('MODEL_PAGE_ROLE_ORIGIN_MISMATCH')
        state['markerVerified'] = True

        try:
            session = page.evaluate("""async () => {
              const response = await fetch('/api/auth/session', { credentials: 'same-origin' });
              let value = null;
              try { value = await response.json(); } catch {}
              return {
                status: response.status,
                email: typeof value?.session?.email === 'string' ? value.session.email : null
              };
            }""")
            prior_ui_capture = Path('/home/worker/.nad-scratch/provider-runtime-20261005/grok-conversation-native-ui-capture.py').read_text(encoding='utf-8')
            expected_owner_match = re.search(r"EXPECTED_OWNER_SHA256\s*=\s*'([0-9a-f]{64})'", prior_ui_capture)
            email = session.get('email') if isinstance(session, dict) else None
            state['ownerSessionObserved'] = session.get('status') == 200 and isinstance(email, str)
            state['ownerIdentityMatched'] = bool(state['ownerSessionObserved'] and expected_owner_match
                and hashlib.sha256(email.strip().casefold().encode()).hexdigest() == expected_owner_match.group(1))
            email = None
        except Exception:
            state['ownerSessionObserved'] = False
            state['ownerIdentityMatched'] = False

        try:
            mode_read = page.evaluate("""async () => {
              const response = await fetch('/rest/modes', { method: 'POST', credentials: 'same-origin',
                headers: { 'content-type': 'application/json' }, body: JSON.stringify({ locale: 'en' }) });
              const bytes = new Uint8Array(await response.arrayBuffer());
              let data = null;
              try { data = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch {}
              const modes = Array.isArray(data?.modes) ? data.modes.slice(0, 500).map(mode => ({
                id: typeof mode?.id === 'string' ? mode.id : null,
                title: typeof mode?.title === 'string' ? mode.title.slice(0, 512) : null,
                description: typeof mode?.description === 'string' ? mode.description.slice(0, 2000) : null,
                badgeText: typeof mode?.badgeText === 'string' ? mode.badgeText.slice(0, 512) : null,
                iconHint: typeof mode?.iconHint === 'string' ? mode.iconHint.slice(0, 256) : null,
                available: typeof mode?.availability?.available === 'boolean' ? mode.availability.available : null,
                minimumSubscriptionTier: typeof mode?.availability?.requiresUpgrade?.minimumSubscriptionTier === 'string'
                  ? mode.availability.requiresUpgrade.minimumSubscriptionTier : null
              })) : [];
              return { status: response.status, contentType: (response.headers.get('content-type') || '').split(';', 1)[0].trim().toLowerCase(),
                responseBytes: bytes.length, defaultModeId: typeof data?.defaultModeId === 'string' ? data.defaultModeId : null, modes };
            }""")
            if isinstance(mode_read, dict):
                state['modelCatalogHttpStatus'] = mode_read.get('status')
                state['modelCatalogContentType'] = mode_read.get('contentType')
                state['modelCatalogResponseBytes'] = mode_read.get('responseBytes')
                state['modelCatalog'] = {
                    'defaultModeId': mode_read.get('defaultModeId'),
                    'modes': mode_read.get('modes', []),
                }
        except Exception:
            pass

        state['uiBeforeOpen'] = _safe_mode_ui(page)
        if state['uiBeforeOpen'].get('selectorContainerCount') == 1 and state['uiBeforeOpen'].get('triggerCount') == 1:
            page.locator('[data-query-bar-mode-select] button,[data-query-bar-mode-select] [role="button"]').first.click(timeout=5_000)
            page.wait_for_timeout(900)
            state['opened'] = True
            state['uiAfterOpen'] = _safe_mode_ui(page)
        else:
            state['uiAfterOpen'] = state['uiBeforeOpen']

        role_count = sum(
            1 for candidate in context.pages
            if candidate.url.startswith(ORIGIN) and candidate.evaluate('() => window.name') == ROLE
        )
        if role_count != 1:
            raise SystemExit('MODEL_PAGE_ROLE_NOT_UNIQUE')

        receipt = {
            'schemaVersion': 1,
            'serviceId': 'grok-web',
            'featureId': 'models.private-selection',
            'requirementId': 'models.selection-in-chat',
            'observedAt': datetime.now(timezone.utc).isoformat(),
            'execution': 'normal_linux_chrome_cdp_page',
            'pageRole': ROLE,
            'authenticatedSessionObserved': state['ownerSessionObserved'],
            'ownerIdentityMatchedToVerifiedBrowserOwner': state.get('ownerIdentityMatched') is True,
            'pageRoleVerified': state['markerVerified'],
            'selectorMenuOpened': state['opened'],
            'selectorBeforeOpen': state['uiBeforeOpen'],
            'selectorAfterOpen': state['uiAfterOpen'],
            'catalogRead': {
                'operationId': 'models.modes',
                'method': 'POST',
                'path': '/rest/modes',
                'requestFieldNames': sorted({field for item in state['allowedModelReadPosts'] if item['path'] == '/rest/modes' for field in item['bodyFieldNames']}),
                'requestObserved': state['modelCatalogHttpStatus'] == 200 and state['modelCatalogContentType'] == 'application/json',
                'httpStatus': state['modelCatalogHttpStatus'],
                'responseContentType': state['modelCatalogContentType'],
                'responseBytes': state['modelCatalogResponseBytes'],
                'defaultModeId': state['modelCatalog']['defaultModeId'] if state['modelCatalog'] else None,
                'choices': state['modelCatalog']['modes'] if state['modelCatalog'] else [],
            },
            'selectionControl': {
                'sourceState': 'useModesStore.selectedModeId',
                'sourceSetter': 'useModesStore.setSelectedModeId',
                'setterSourceTag': 'user',
                'storageKey': 'modes-selected-id',
                'setterEffect': 'local_sdk_state_and_local_storage',
                'selectedModeLabel': state['uiAfterOpen'].get('triggerLabel'),
                'selectedModeControlReadFrom': 'visible_mode_menuitemradio',
                'selectionOptionClicked': False,
                'standaloneServerMutationObserved': False,
            },
            'guard': {
                'installedBeforeNavigation': True,
                'pageWideHttpWriteGuard': True,
                'browserWriteRequestsBlocked': state['httpWriteBlocks'],
                'blockedWritePathClasses': state['blockedWritePathClasses'],
                'nonModelApiReadsBlocked': state['readBlocks'],
                'allowedModelReadPosts': state['allowedModelReadPosts'],
                'websocketRouteInstalledBeforeNavigation': True,
                'websocketConnections': state['websocketConnections'],
                'pageFramesDropped': state['websocketPageFramesDropped'],
                'serverFramesForwarded': state['websocketServerFramesForwarded'],
                'businessFramesDelivered': 0,
            },
            'safety': {
                'conversationCreated': False,
                'chatResponseRequested': False,
                'imageOrVideoGenerationRequested': False,
                'modelOptionSelected': False,
                'rawRequestOrResponseBodiesPersisted': False,
                'credentialsOrCookiesPersisted': False,
                'accountOrConversationIdentifiersPersisted': False,
                'signedUrlsPersisted': False,
            },
        }
        _write_receipt(receipt)
        print(json.dumps({
            'captureWritten': str(RECEIPT_PATH),
            'authenticatedSessionObserved': state['ownerSessionObserved'],
            'selectorMenuOpened': state['opened'],
            'modeChoiceCount': len(receipt['catalogRead']['choices']),
            'modeCatalogRequestObserved': receipt['catalogRead']['requestObserved'],
            'httpWriteBlocks': state['httpWriteBlocks'],
            'blockedApiReadCategories': state['readBlocks'],
            'websocketPageFramesDropped': state['websocketPageFramesDropped'],
            'businessFramesDelivered': 0,
        }, separators=(',', ':')), flush=True)
        # Keep the loaded page and its guard installed until the operator ends
        # this one-shot capture process; do not close the shared browser/tab.
        time.sleep(90)


if __name__ == '__main__':
    main()
