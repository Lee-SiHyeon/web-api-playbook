#!/usr/bin/env python3
"""Create one guarded, lifecycle-only neutral Gemini task through the normal text client."""

import copy
import fcntl
import hashlib
import importlib.util
import json
import os
import pathlib
import sys
import urllib.parse
from datetime import datetime, timezone

from playwright.sync_api import sync_playwright


REPO = pathlib.Path(__file__).resolve().parent.parent
RUNTIME = pathlib.Path.home() / '.nad-scratch/provider-runtime-20261005'
OWNER_PATH = RUNTIME / 'runtime-owner.json'
ROLE_PATH = RUNTIME / 'page-role-registry.json'
ROLE_LOCK = RUNTIME / 'page-role-registry.lock'
ROLE = 'codex-gemini-lifecycle-canonical-20261006'
GROK_OWNER_ROLE = 'codex-grok-owner-proof-20261006'
ORIGIN = 'https://gemini.google.com'
BATCH_PATH = '/_/BardChatUi/data/batchexecute'
CONTRACT_PATH = REPO / 'discovery/observed-contract.json'
EXPECTED_OWNER_SHA256 = '23e57131977ce522bacf6649eb27538770828a890f7a65589ec4f0960a84b3d7'
INTENT = 'gemini-lifecycle-fixture-20261006-v1'
PROMPT = ('For a private lifecycle API verification fixture, reply exactly: LIFECYCLE42. '
          'Do not use tools, create media, or include anything else.')
RECEIPT = REPO / 'verification/one-shot/gemini-lifecycle-fixture-text-2026-10-06.json'
TEXT_RUNNER_PATH = REPO / 'scripts/run-linux-text-smoke.py'


class SafeFailure(Exception):
    def __init__(self, code):
        self.code = code


def read_json(path):
    try:
        return json.loads(pathlib.Path(path).read_text(encoding='utf-8'))
    except Exception as exc:
        raise SafeFailure('LIFECYCLE_RUNTIME_METADATA_INVALID') from exc


def target_id(context, page):
    cdp = context.new_cdp_session(page)
    try:
        value = cdp.send('Target.getTargetInfo').get('targetInfo', {}).get('targetId')
    finally:
        cdp.detach()
    if not isinstance(value, str) or not value:
        raise SafeFailure('LIFECYCLE_TARGET_ID_UNAVAILABLE')
    return value


def atomic_write_registry(value):
    temporary = ROLE_PATH.with_name(f'{ROLE_PATH.name}.lifecycle-{os.getpid()}.pending')
    encoded = (json.dumps(value, ensure_ascii=False, separators=(',', ':')) + '\n').encode('utf-8')
    try:
        descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    except FileExistsError as exc:
        raise SafeFailure('LIFECYCLE_ROLE_TEMPFILE_EXISTS') from exc
    try:
        with os.fdopen(descriptor, 'wb') as stream:
            stream.write(encoded)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, ROLE_PATH)
        directory = os.open(ROLE_PATH.parent, os.O_RDONLY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    except Exception:
        temporary.unlink(missing_ok=True)
        raise


def find_registered_page(context, role):
    matches = []
    expected_target = role.get('targetId')
    for page in context.pages:
        try:
            if target_id(context, page) == expected_target and page.evaluate('() => window.name') == ROLE:
                parsed = urllib.parse.urlsplit(page.url)
                if parsed.scheme == 'https' and parsed.hostname == 'gemini.google.com':
                    matches.append(page)
        except Exception:
            continue
    if len(matches) != 1:
        raise SafeFailure('LIFECYCLE_ROLE_TARGET_NOT_UNIQUE')
    return matches[0]


def active_principal_matches(page):
    try:
        email = page.evaluate("() => { const value = window.WIZ_global_data?.oPEP7c; return typeof value === 'string' ? value : null; }")
    except Exception:
        return False
    if not isinstance(email, str) or not email.strip():
        return False
    return hashlib.sha256(email.strip().casefold().encode('utf-8')).hexdigest() == EXPECTED_OWNER_SHA256


def ensure_lifecycle_page():
    owner = read_json(OWNER_PATH)
    if owner.get('taskOwned') is not True or owner.get('mode') != 'cdp_discovery_after_native_bootstrap':
        raise SafeFailure('LIFECYCLE_OWNED_RUNTIME_INVALID')
    chrome_pid = owner.get('chromePid')
    cdp_port = owner.get('cdpPort')
    if not isinstance(chrome_pid, int) or not isinstance(cdp_port, int):
        raise SafeFailure('LIFECYCLE_OWNED_RUNTIME_INVALID')
    profile = pathlib.Path(owner.get('profile', '')).resolve()
    try:
        os.kill(chrome_pid, 0)
        process_args = pathlib.Path(f'/proc/{chrome_pid}/cmdline').read_bytes().decode('utf-8', 'replace').split('\0')
    except Exception as exc:
        raise SafeFailure('LIFECYCLE_OWNED_RUNTIME_NOT_ALIVE') from exc
    if f'--user-data-dir={profile}' not in process_args or f'--remote-debugging-port={cdp_port}' not in process_args:
        raise SafeFailure('LIFECYCLE_OWNED_PROFILE_MISMATCH')
    role_registered = False
    created_page = None
    with sync_playwright() as playwright:
        browser = playwright.chromium.connect_over_cdp(f'http://127.0.0.1:{cdp_port}')
        if len(browser.contexts) != 1:
            raise SafeFailure('LIFECYCLE_OWNED_CONTEXT_COUNT_INVALID')
        context = browser.contexts[0]
        with open(ROLE_LOCK, 'a+') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX)
            latest = read_json(ROLE_PATH)
            if latest.get('taskOwned') is not True or latest.get('runtimeChromePid') != chrome_pid:
                fcntl.flock(lock, fcntl.LOCK_UN)
                raise SafeFailure('LIFECYCLE_ROLE_REGISTRY_CHANGED')
            roles = latest.setdefault('activePageRoles', {})
            existing = roles.get(ROLE)
            if existing is not None:
                if (existing.get('origin') != ORIGIN or existing.get('selection') != 'owned_target_id_and_exact_marker'
                        or existing.get('exactMarkerCount') != 1 or not existing.get('targetId')):
                    fcntl.flock(lock, fcntl.LOCK_UN)
                    raise SafeFailure('LIFECYCLE_ROLE_ALREADY_REGISTERED')
                fcntl.flock(lock, fcntl.LOCK_UN)
                page = find_registered_page(context, existing)
                parsed = urllib.parse.urlsplit(page.url)
                if parsed.path != '/app' or not active_principal_matches(page):
                    raise SafeFailure('LIFECYCLE_ROLE_PAGE_NOT_READY')
                return {'registered': True, 'reused': True, 'activeOwnerMatched': True}

            created_page = context.new_page()
            try:
                created_page.evaluate('(marker) => { window.name = marker; }', ROLE)
                local_target_id = target_id(context, created_page)
                browser_route_failures = []
                from importlib.machinery import SourceFileLoader
                spec = importlib.util.spec_from_loader('gemini_lifecycle_text_runner', SourceFileLoader('gemini_lifecycle_text_runner', str(TEXT_RUNNER_PATH)))
                text_runner = importlib.util.module_from_spec(spec)
                spec.loader.exec_module(text_runner)

                def initial_guard(route):
                    try:
                        request = route.request
                        if request.method.upper() in {'GET', 'HEAD', 'OPTIONS'}:
                            route.continue_()
                            return
                        parsed = urllib.parse.urlsplit(request.url)
                        if parsed.hostname == 'gemini.google.com' and parsed.path == BATCH_PATH:
                            rpc_ids = text_runner.rpc_ids_from_request(request.url, request.post_data or '')
                            if rpc_ids and all(rpc_id in text_runner.READ_RPC_IDS for rpc_id in rpc_ids):
                                route.continue_()
                                return
                        route.abort('blockedbyclient')
                    except Exception:
                        browser_route_failures.append(True)
                        try:
                            route.abort('blockedbyclient')
                        except Exception:
                            browser_route_failures.append(True)

                created_page.route('**/*', initial_guard)
                try:
                    created_page.route_web_socket('wss://gemini.google.com/**', lambda websocket: websocket.close(code=1000, reason='lifecycle-fixture-bootstrap'))
                except Exception:
                    pass
                created_page.goto(ORIGIN + '/app', wait_until='domcontentloaded', timeout=90000)
                created_page.wait_for_timeout(7000)
                if urllib.parse.urlsplit(created_page.url).path != '/app':
                    raise SafeFailure('LIFECYCLE_FIXTURE_APP_NOT_READY')
                created_page.evaluate('(marker) => { window.name = marker; }', ROLE)
                if created_page.evaluate('() => window.name') != ROLE:
                    raise SafeFailure('LIFECYCLE_ROLE_MARKER_BINDING_FAILED')
                if target_id(context, created_page) != local_target_id:
                    raise SafeFailure('LIFECYCLE_TARGET_ID_CHANGED')
                if not active_principal_matches(created_page):
                    raise SafeFailure('LIFECYCLE_ACTIVE_OWNER_MISMATCH')
                if browser_route_failures:
                    raise SafeFailure('LIFECYCLE_BOOTSTRAP_GUARD_FAILURE')
                created_page.unroute('**/*', initial_guard)
                try:
                    created_page.unroute_web_socket('wss://gemini.google.com/**')
                except Exception:
                    pass
                same_origin_markers = 0
                for page in context.pages:
                    try:
                        parsed = urllib.parse.urlsplit(page.url)
                        if parsed.scheme == 'https' and parsed.hostname == 'gemini.google.com' and page.evaluate('() => window.name') == ROLE:
                            same_origin_markers += 1
                    except Exception:
                        continue
                if same_origin_markers != 1:
                    raise SafeFailure('LIFECYCLE_ROLE_MARKER_NOT_UNIQUE')
                roles[ROLE] = {
                    'origin': ORIGIN,
                    'exactMarkerCount': 1,
                    'selection': 'owned_target_id_and_exact_marker',
                    'targetId': local_target_id,
                    'targetIdObservedAt': datetime.now(timezone.utc).isoformat(),
                    'purpose': 'lifecycle_fixture_and_share_lifecycle_capture',
                }
                latest['activePageRoles'] = roles
                atomic_write_registry(latest)
                role_registered = True
            except Exception:
                if not role_registered and created_page is not None:
                    try:
                        created_page.close()
                    except Exception:
                        pass
                raise
            finally:
                try:
                    fcntl.flock(lock, fcntl.LOCK_UN)
                except Exception:
                    pass
        return {'registered': True, 'reused': False, 'activeOwnerMatched': True}


def run_fixture_text_task():
    if RECEIPT.exists():
        raise SafeFailure('LIFECYCLE_FIXTURE_RECEIPT_ALREADY_EXISTS')
    import importlib.machinery
    loader = importlib.machinery.SourceFileLoader('gemini_lifecycle_fixture_text_runner', str(TEXT_RUNNER_PATH))
    spec = importlib.util.spec_from_loader(loader.name, loader)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    role_state = ensure_lifecycle_page()
    module.CALLER_INTENT = INTENT
    module.PROMPT = PROMPT
    module.RECEIPT_PATH = RECEIPT
    module.GEMINI_CORE_ROLE = ROLE
    module.GROK_CORE_ROLE = GROK_OWNER_ROLE

    original_runtime_and_roles = module.runtime_and_roles
    def runtime_and_roles_lifecycle():
        owner, roles, version = original_runtime_and_roles()
        current = roles.get('activePageRoles', {}).get(ROLE, {})
        if (current.get('origin') != ORIGIN or current.get('exactMarkerCount') != 1
                or not current.get('targetId')):
            raise SafeFailure('LIFECYCLE_ROLE_TARGET_UNREGISTERED')
        return owner, roles, version
    module.runtime_and_roles = runtime_and_roles_lifecycle

    original_page_with_marker = module.page_with_marker
    selected_pages = []
    def page_with_marker_lifecycle(context, marker, origin):
        if marker == ROLE:
            page = original_page_with_marker(context, ROLE, ORIGIN)
            selected_pages.append(page)
            return page
        if marker == GROK_OWNER_ROLE and selected_pages:
            return selected_pages[0]
        return original_page_with_marker(context, marker, origin)
    module.page_with_marker = page_with_marker_lifecycle

    def active_gemini_owner(page, expected_hash):
        try:
            email = page.evaluate("() => { const value = window.WIZ_global_data?.oPEP7c; return typeof value === 'string' ? value : null; }")
        except Exception as exc:
            raise SafeFailure('BROWSER_IDENTITY_READ_UNAVAILABLE') from exc
        if not isinstance(email, str) or hashlib.sha256(email.strip().casefold().encode('utf-8')).hexdigest() != expected_hash:
            raise SafeFailure('BROWSER_OWNER_MISMATCH')
        return email.strip().casefold()
    module.read_grok_owner = active_gemini_owner

    baseline_contract = json.loads(module.CONTRACT_PATH.read_text(encoding='utf-8'))
    def guarded_contract_write(candidate):
        comparison = copy.deepcopy(candidate)
        comparison['observedAt'] = baseline_contract.get('observedAt')
        if comparison != baseline_contract:
            raise SafeFailure('LIFECYCLE_FIXTURE_CONTRACT_DELTA_BLOCKED')
        candidate['observedAt'] = baseline_contract.get('observedAt')
    module.write_contract = guarded_contract_write

    original_run_node = module.run_node
    def run_node_with_marker(args, envelope, timeout=240, script=None):
        args = list(args)
        if args[:2] == ['history', 'read'] and '--response-marker' not in args:
            args.extend(['--response-marker', 'LIFECYCLE42'])
        return original_run_node(args, envelope, timeout=timeout, script=script)
    module.run_node = run_node_with_marker

    original_sync_playwright = module.sync_playwright
    pre_stop_reset = {'verified': False}

    class GuardedSyncPlaywright:
        def __init__(self):
            self.manager = original_sync_playwright()

        def __enter__(self):
            return self.manager.__enter__()

        def __exit__(self, exc_type, exc_value, traceback):
            if exc_type is not None:
                # This __exit__ runs while the SDK runner is still inside its
                # with-block, before Playwright stops its driver on the error path.
                frame = sys._getframe(1)
                local = frame.f_locals
                state = local.get('state')
                page = local.get('core')
                cdp = local.get('cdp')
                guard_enabled = local.get('guard_enabled') is True
                if guard_enabled and page is not None and cdp is not None:
                    try:
                        if urllib.parse.urlsplit(page.url).path != '/app':
                            page.goto(ORIGIN + '/app', wait_until='domcontentloaded', timeout=60000)
                        page.wait_for_timeout(2500)
                        quiet = urllib.parse.urlsplit(page.url).path == '/app'
                        if isinstance(state, dict):
                            quiet = quiet and state.get('unknownPostAbortFailures', 0) == 0
                        if quiet:
                            cdp.send('Fetch.disable')
                        if isinstance(state, dict):
                            state['preStopQuietResetVerified'] = quiet
                            if not quiet:
                                state['guardFailure'] = 'PRE_STOP_QUIET_RESET_FAILED'
                        pre_stop_reset['verified'] = quiet
                    except Exception:
                        if isinstance(state, dict):
                            state['preStopQuietResetVerified'] = False
                            state['guardFailure'] = 'PRE_STOP_QUIET_RESET_FAILED'
                        pre_stop_reset['verified'] = False
            return self.manager.__exit__(exc_type, exc_value, traceback)

    module.sync_playwright = GuardedSyncPlaywright
    original_force_quiet_reset = module.force_quiet_reset
    pre_stop_reset = {'verified': False}
    module.force_quiet_reset = lambda owner: True if pre_stop_reset['verified'] else original_force_quiet_reset(owner)

    outcome = module.main()
    if RECEIPT.exists():
        receipt = json.loads(RECEIPT.read_text(encoding='utf-8'))
        receipt['lifecycleFixture'] = {
            'intent': INTENT,
            'promptSha256': hashlib.sha256(PROMPT.encode('utf-8')).hexdigest(),
            'role': ROLE,
            'roleTargetRegistered': role_state['registered'],
            'roleTargetReused': role_state['reused'],
            'browserBusinessWrites': 0,
            'contractChanged': False,
            'preStopQuietResetVerifiedOnFailure': pre_stop_reset['verified'],
            'rawPromptOrConversationIdPersisted': False,
        }
        temp = RECEIPT.with_name(RECEIPT.name + f'.metadata-{os.getpid()}.pending')
        temp.write_text(json.dumps(receipt, ensure_ascii=True, indent=2) + '\n', encoding='utf-8')
        os.chmod(temp, 0o600)
        os.replace(temp, RECEIPT)
    return outcome


def main():
    try:
        status = run_fixture_text_task()
        print(json.dumps({'status': 'verified' if status == 0 else 'needs_review',
                          'operation': 'lifecycle_fixture_text', 'taskIntent': INTENT,
                          'receipt': str(RECEIPT.relative_to(REPO)),
                          'directDispatchCount': 1 if status == 0 else None,
                          'contractChanged': False,
                          'rawPromptOrConversationIdPersisted': False}, separators=(',', ':')))
        return status
    except SafeFailure as error:
        print(json.dumps({'status': 'stopped', 'code': error.code,
                          'operation': 'lifecycle_fixture_text', 'directDispatchCount': 0,
                          'rawPromptOrConversationIdPersisted': False}, separators=(',', ':')))
        return 2


if __name__ == '__main__':
    raise SystemExit(main())
