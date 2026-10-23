#!/usr/bin/env python3
"""Guarded native SDK capture followed by one direct WSS CSV task and scoped file readback."""

import asyncio
from contextlib import AsyncExitStack
import email.utils as email_utils
import fcntl
import hashlib
import json
import os
import pathlib
import re
import shutil
import tempfile
import urllib.parse
import uuid
from datetime import datetime, timezone

from playwright.async_api import async_playwright
from grok_owned_page_guard_lifecycle import OwnedPageGuardLifecycle


REPO = pathlib.Path(__file__).resolve().parent.parent
RUNTIME = pathlib.Path.home() / '.nad-scratch/provider-runtime-20261005'
OWNER_PATH = RUNTIME / 'runtime-owner.json'
ROLE_PATH = RUNTIME / 'page-role-registry.json'
ROLE_LOCK = RUNTIME / 'page-role-registry.lock'
ROLE = 'codex-grok-files-20261006'
ORIGIN = 'https://grok.com'
EXPECTED_OWNER_SHA256 = '23e57131977ce522bacf6649eb27538770828a890f7a65589ec4f0960a84b3d7'
NODE = shutil.which('node') or '/home/worker/.npm/_npx/387698761821791d/node_modules/node/bin/node'
PYTHON = '/home/worker/work/web-api-playbook-inpock-20261004/.venv-oliveyoung/bin/python'
PROMPT = (
    'Use an available file or code tool to create the downloadable workspace file '
    '`07b2d9f8b7b4b2abfa1afcd2e5dce663.csv`. Its complete contents must be exactly two CSV rows: '
    'the header `item,count`, followed by `neutral,14`. Do not browse, use external services, '
    'or use any private data. If no file tool is available, say that without pasting CSV text.'
)
FILE_NAME = '07b2d9f8b7b4b2abfa1afcd2e5dce663.csv'
CAPTURE_RECEIPT = REPO / 'verification/grok-conversation-files-capture-2026-10-06.json'
FILES_RUNNER = REPO / 'scripts/grok-conversation-files-once.mjs'
TEXT_RECEIPT = REPO / 'verification/grok-conversation-files-text-live-2026-10-06.json'
FILES_RECEIPT = REPO / 'verification/grok-conversation-files-live-2026-10-06.json'
CREATE_RECEIPT = REPO / 'verification/grok-conversation-files-create-live-2026-10-06.json'
CID_RECOVERY_RUNNER = REPO / 'scripts/grok-conversation-files-cid-recover-once.mjs'
CID_RECOVERY_RECEIPT = REPO / 'verification/grok-conversation-files-create-cid-reconcile-live-2026-10-06.json'
TASK_RECONCILE_RUNNER = REPO / 'scripts/grok-conversation-files-task-reconcile-once.mjs'
TASK_RECONCILE_RECEIPT = REPO / 'verification/grok-conversation-files-task-cid-reconcile-live-2026-10-06.json'
CID_LOCATE_RUNNER = REPO / 'scripts/grok-conversation-files-cid-locate-once.mjs'
ARTIFACT_READBACK_RUNNER = REPO / 'scripts/grok-conversation-files-artifact-readback-once.mjs'
ARTIFACT_READBACK_RECEIPT = REPO / 'verification/grok-conversation-files-artifact-readback-live-2026-10-06-r4.json'
NODE_READ_POST_PATHS = {
    '/rest/models', '/rest/modes', '/rest/models/imagine/overrides',
    '/rest/connectors/list-v2', '/rest/connectors/list-available-v2',
    '/rest/connectors/finance/connections', '/rest/skills', '/rest/system-prompt/list',
}
EVENT_RE = re.compile(r'^[a-z][a-z0-9_.-]{0,95}$')
SAFE_ROUTE_SEGMENTS = {
    'api', 'rest', 'app-chat', 'conversations', 'new', 'responses', 'load-responses', 'response-node',
    'connectors', 'connector', 'manager', 'mcp', 'tools', 'available', 'discovered', 'catalog',
    'ListConnectorsV2', 'ListAvailableConnectorsV2', 'ListMcpDiscoveredTools',
    'models', 'modes', 'files', 'list', 'content', 'download', 'download-zip', 'workspace',
    'search', 'auth', 'session', 'status', 'assets', 'upload', 'complete', 'media', 'user',
    'v1', 'v2', 'chat', 'message', 'messages', 'events', 'analytics', 'stream', 'query',
}


class SafeFailure(Exception):
    def __init__(self, code):
        self.code = code


def sha256(value):
    return hashlib.sha256(value).hexdigest()


def node_environment():
    allowed = {'PATH', 'HOME', 'LANG', 'LC_ALL', 'TMPDIR', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'REQUESTS_CA_BUNDLE'}
    environment = {name: os.environ[name] for name in allowed if isinstance(os.environ.get(name), str)}
    environment['PYTHONDONTWRITEBYTECODE'] = '1'
    environment['GROK_CHROME_PYTHON'] = PYTHON
    return environment


def load_json(path):
    try:
        return json.loads(path.read_text(encoding='utf-8'))
    except Exception as exc:
        raise SafeFailure('FILES_RUNTIME_METADATA_INVALID') from exc


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


def atomic_json(path, value):
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


def owner_email_sha(email):
    return sha256(email.strip().casefold().encode('utf-8'))


def normalized_path_template(path, conversation_id):
    parts = [part for part in path.split('/') if part]
    safe_parts = []
    for index, part in enumerate(parts):
        if part == conversation_id:
            safe_parts.append('{taskConversationId}')
        elif part in SAFE_ROUTE_SEGMENTS:
            safe_parts.append(part)
        elif len(part) >= 24 or re.fullmatch(r'[0-9a-fA-F-]{32,36}', part):
            safe_parts.append('{id}')
        elif index == 0 and re.fullmatch(r'[a-z][a-z0-9_-]{0,31}', part):
            safe_parts.append(part)
        else:
            safe_parts.append('{segment}')
    return '/' + '/'.join(safe_parts)


def safe_blocked_post_observation(request, parsed, conversation_id):
    observation = {
        'method': request.method.upper(),
        'hostClass': 'grok_origin' if parsed.hostname == 'grok.com'
            else 'grok_subdomain' if isinstance(parsed.hostname, str) and parsed.hostname.endswith('.grok.com')
            else 'other_origin',
        'pathTemplate': normalized_path_template(parsed.path, conversation_id),
        'contentType': None,
        'requestHeaderNames': [],
        'bodyBytes': None,
        'jsonTopLevelFieldNames': [],
        'eventType': None,
        'taskPromptExactValueSeen': False,
        'taskFileNameExactValueSeen': False,
        'taskConversationIdExactValueSeen': False,
    }
    if parsed.hostname != 'grok.com':
        return observation
    try:
        headers = request.headers
        if isinstance(headers, dict):
            observation['requestHeaderNames'] = sorted({
                name.lower() for name in headers
                if isinstance(name, str) and re.fullmatch(r'[A-Za-z0-9-]{1,80}', name)
            })[:64]
        content_type = headers.get('content-type', '') if isinstance(headers, dict) else ''
        observation['contentType'] = content_type.split(';', 1)[0].strip().lower() or None
        body = request.post_data
        if isinstance(body, str):
            body_bytes = body.encode('utf-8')
            observation['bodyBytes'] = len(body_bytes)
            if len(body_bytes) <= 64 * 1024 and observation['contentType'] == 'application/json':
                try:
                    parsed_body = json.loads(body)
                except Exception:
                    parsed_body = None
                if isinstance(parsed_body, dict):
                    observation['jsonTopLevelFieldNames'] = sorted(
                        key for key in parsed_body if isinstance(key, str) and re.fullmatch(r'[A-Za-z][A-Za-z0-9_.-]{0,63}', key)
                    )[:64]
                    def inspect(value, depth=0):
                        if depth > 16:
                            return
                        if isinstance(value, str):
                            if value == PROMPT:
                                observation['taskPromptExactValueSeen'] = True
                            if value == FILE_NAME:
                                observation['taskFileNameExactValueSeen'] = True
                            if value == conversation_id:
                                observation['taskConversationIdExactValueSeen'] = True
                        elif isinstance(value, dict):
                            for key, child in value.items():
                                if key == 'type' and isinstance(child, str) and EVENT_RE.fullmatch(child):
                                    observation['eventType'] = child
                                inspect(child, depth + 1)
                        elif isinstance(value, list):
                            for child in value[:256]:
                                inspect(child, depth + 1)
                    inspect(parsed_body)
            elif len(body_bytes) <= 64 * 1024 and observation['contentType'] == 'application/x-www-form-urlencoded':
                try:
                    names = [key for key, _value in urllib.parse.parse_qsl(body, keep_blank_values=True)[:64]
                             if re.fullmatch(r'[A-Za-z][A-Za-z0-9_.-]{0,63}', key)]
                    observation['formFieldNames'] = sorted(set(names))
                except Exception:
                    observation['formFieldsReadFailed'] = True
    except Exception:
        observation['bodyReadFailed'] = True
    return observation


async def create_empty_task_conversation(session_bundle, identity):
    intent_id = f'grok-files-conversation-create-20261006-{uuid.uuid4()}'
    packet = {
        'sessionBundle': json.loads(json.dumps(session_bundle)),
        'expectedIdentity': identity,
        'input': {'body': {'systemPromptName': '', 'temporary': False}},
    }
    wire = bytearray(json.dumps(packet, separators=(',', ':')).encode('utf-8'))
    command = [NODE, 'src/cli.mjs', 'conversation', 'create', '--session-stdin', '--confirm',
               '--intent-id', intent_id, '--first-live-source-permit', '--output=json', '--python', PYTHON]
    try:
        process = await asyncio.create_subprocess_exec(*command, cwd=str(REPO), stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE, env=node_environment())
        try:
            stdout, _ = await asyncio.wait_for(process.communicate(bytes(wire)), timeout=120)
        except asyncio.TimeoutError:
            process.kill()
            await process.wait()
            raise SafeFailure('FILES_TASK_CREATE_TIMEOUT')
    finally:
        wire[:] = b'\0' * len(wire)
        packet['expectedIdentity'] = ''
        for origin in packet['sessionBundle'].get('origins', []):
            for item in origin.get('cookies', []):
                item['value'] = ''
    if len(stdout) > 64 * 1024:
        raise SafeFailure('FILES_TASK_CREATE_OUTPUT_INVALID')
    output_bytes = bytearray(stdout)
    try:
        try:
            result = json.loads(output_bytes.decode('utf-8'))
        except Exception as exc:
            raise SafeFailure('FILES_TASK_CREATE_OUTPUT_INVALID') from exc
    finally:
        output_bytes[:] = b'\0' * len(output_bytes)
        stdout = b''
    if not isinstance(result, dict) or result.get('operationId') != 'conversation.create':
        raise SafeFailure('FILES_TASK_CREATE_OUTPUT_INVALID')
    conversation_id = result.get('conversationId')
    valid_id = isinstance(conversation_id, str) and 16 <= len(conversation_id) <= 512 and not re.search(r'[\r\n\0]', conversation_id)
    source = result.get('sourceDiscovery') if isinstance(result.get('sourceDiscovery'), dict) else {}
    safe = {
        'schemaVersion': 1,
        'serviceId': 'grok-web',
        'operationId': 'conversation.create',
        'recordedAt': datetime.now(timezone.utc).isoformat(),
        'status': result.get('state'),
        'verified': result.get('verified') is True,
        'ownerVerified': result.get('ownerVerified') is True,
        'ownerScopeSha256': EXPECTED_OWNER_SHA256,
        'conversationIdSha256': sha256(conversation_id.encode('utf-8')) if valid_id else None,
        'httpStatus': result.get('httpStatus') if isinstance(result.get('httpStatus'), int) else None,
        'readbackStatus': result.get('readbackStatus') if isinstance(result.get('readbackStatus'), int) else None,
        'intentDigest': result.get('intentDigest') if isinstance(result.get('intentDigest'), str)
            else source.get('intentDigest') if isinstance(source.get('intentDigest'), str) else None,
        'requestDigest': result.get('requestDigest') if isinstance(result.get('requestDigest'), str)
            else source.get('requestDigest') if isinstance(source.get('requestDigest'), str) else None,
        'responseDigest': result.get('responseDigest') if isinstance(result.get('responseDigest'), str)
            else source.get('responseDigest') if isinstance(source.get('responseDigest'), str) else None,
        'responseBytes': result.get('responseBytes') if isinstance(result.get('responseBytes'), int)
            else source.get('responseBytes') if isinstance(source.get('responseBytes'), int) else None,
        'sourceFunctionName': result.get('sourceFunctionName') if isinstance(result.get('sourceFunctionName'), str)
            else source.get('sourceFunctionName') if isinstance(source.get('sourceFunctionName'), str) else None,
        'sourceMethod': result.get('method') if isinstance(result.get('method'), str)
            else source.get('method') if isinstance(source.get('method'), str) else None,
        'sourcePathTemplate': result.get('sourcePathTemplate') if isinstance(result.get('sourcePathTemplate'), str)
            else source.get('pathTemplate') if isinstance(source.get('pathTemplate'), str) else None,
        'requestHeaderNames': result.get('requestHeaderNames') if isinstance(result.get('requestHeaderNames'), list)
            else source.get('requestHeaderNames') if isinstance(source.get('requestHeaderNames'), list) else [],
        'cookieNames': result.get('cookieNames') if isinstance(result.get('cookieNames'), list)
            else source.get('cookieNames') if isinstance(source.get('cookieNames'), list) else [],
        'responseJobIdObserved': result.get('responseJobIdObserved') is True or source.get('responseJobIdObserved') is True,
        'rawConversationIdPersisted': False,
        'rawRequestBodyPersisted': False,
        'rawResponseBodyPersisted': False,
    }
    if safe['status'] != 'completed' or safe['verified'] is not True or safe['ownerVerified'] is not True \
            or safe['httpStatus'] != 200 or safe['readbackStatus'] != 200 or not valid_id \
            or safe['ownerScopeSha256'] != EXPECTED_OWNER_SHA256:
        atomic_json(CREATE_RECEIPT, safe)
        if valid_id:
            conversation_id = ''
        result['conversationId'] = ''
        raise SafeFailure('FILES_TASK_CREATE_NOT_VERIFIED')
    if CREATE_RECEIPT.exists():
        conversation_id = ''
        raise SafeFailure('FILES_TASK_CREATE_RECEIPT_ALREADY_EXISTS')
    atomic_json(CREATE_RECEIPT, safe)
    result['conversationId'] = ''
    return conversation_id, safe


async def recover_exact_created_conversation(session_bundle, identity, create_evidence):
    target_hash = create_evidence.get('conversationIdSha256')
    if not isinstance(target_hash, str) or not re.fullmatch(r'[a-f0-9]{64}', target_hash):
        raise SafeFailure('FILES_TASK_CREATE_HASH_MISSING')
    packet = {
        'sessionBundle': json.loads(json.dumps(session_bundle)),
        'expectedIdentity': identity,
        'conversationIdSha256': target_hash,
    }
    wire = bytearray(json.dumps(packet, separators=(',', ':')).encode('utf-8'))
    try:
        process = await asyncio.create_subprocess_exec(
            NODE, str(CID_RECOVERY_RUNNER), cwd=str(REPO), stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE, env=node_environment())
        try:
            stdout, _ = await asyncio.wait_for(process.communicate(bytes(wire)), timeout=120)
        except asyncio.TimeoutError:
            process.kill()
            await process.wait()
            raise SafeFailure('FILES_TASK_CID_RECONCILE_TIMEOUT')
    finally:
        wire[:] = b'\0' * len(wire)
        packet['expectedIdentity'] = ''
        packet['conversationIdSha256'] = ''
        for origin in packet['sessionBundle'].get('origins', []):
            for item in origin.get('cookies', []):
                item['value'] = ''
    if len(stdout) > 16 * 1024:
        raise SafeFailure('FILES_TASK_CID_RECONCILE_OUTPUT_INVALID')
    output = bytearray(stdout)
    try:
        try:
            result = json.loads(output.decode('utf-8'))
        except Exception as exc:
            raise SafeFailure('FILES_TASK_CID_RECONCILE_OUTPUT_INVALID') from exc
    finally:
        output[:] = b'\0' * len(output)
        stdout = b''
    if not isinstance(result, dict) or result.get('operationId') != 'conversation.create.task-cid-reconcile' \
            or result.get('status') != 'completed' or result.get('ownerVerified') is not True \
            or result.get('conversationIdSha256') != target_hash or not isinstance(result.get('conversationId'), str):
        error_code = result.get('errorCode') if isinstance(result, dict) else None
        if isinstance(result, dict):
            result['conversationId'] = ''
        if isinstance(error_code, str) and re.fullmatch(r'[A-Z][A-Z0-9_]{1,63}', error_code):
            raise SafeFailure(f'FILES_TASK_CID_RECONCILE_{error_code}')
        raise SafeFailure('FILES_TASK_CID_RECONCILE_NOT_VERIFIED')
    conversation_id = result.pop('conversationId')
    if sha256(conversation_id.encode('utf-8')) != target_hash:
        result.clear()
        raise SafeFailure('FILES_TASK_CID_RECONCILE_HASH_MISMATCH')
    return conversation_id, result


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
    if data.get('status') != 200 or not isinstance(email, str) or owner_email_sha(email) != EXPECTED_OWNER_SHA256:
        raise SafeFailure('OWNER_IDENTITY_MISMATCH')
    return email


async def read_cmd_enter_preference(page):
    try:
        value = await page.evaluate("""async () => {
          const response = await fetch('/rest/user-settings', {
            method:'GET', credentials:'same-origin', redirect:'error', cache:'no-store'
          });
          if (!response.ok) return {status:response.status, required:null};
          const body = await response.json();
          const flag = body?.preferences?.requireCmdEnterToSubmit;
          return {status:response.status, required:typeof flag === 'boolean' ? flag : null};
        }""")
    except Exception as exc:
        raise SafeFailure('FILES_CMD_ENTER_SETTING_READ_FAILED') from exc
    if not isinstance(value, dict) or value.get('status') != 200 or not isinstance(value.get('required'), bool):
        raise SafeFailure('FILES_CMD_ENTER_SETTING_UNOBSERVED')
    try:
        browser_linux = await page.evaluate("() => /linux/i.test(navigator.platform || navigator.userAgentData?.platform || '')")
    except Exception as exc:
        raise SafeFailure('FILES_BROWSER_PLATFORM_UNVERIFIED') from exc
    if browser_linux is not True:
        raise SafeFailure('FILES_BROWSER_PLATFORM_NOT_LINUX')
    return {'status': value['status'], 'requireCmdEnterToSubmit': value['required'], 'linuxPlatformObserved': True}


def update_role_registry(target_id):
    with ROLE_LOCK.open('r+') as stream:
        fcntl.flock(stream, fcntl.LOCK_EX)
        latest = load_json(ROLE_PATH)
        roles = latest.setdefault('activePageRoles', {})
        if ROLE in roles or any(value.get('targetId') == target_id for value in roles.values() if isinstance(value, dict)):
            raise SafeFailure('FILES_ROLE_COLLISION')
        roles[ROLE] = {'origin': ORIGIN, 'exactMarkerCount': 1, 'selection': 'cdp_target_id', 'targetId': target_id}
        atomic_json(ROLE_PATH, latest)
        fcntl.flock(stream, fcntl.LOCK_UN)


async def select_or_create_page(context):
    roles = load_json(ROLE_PATH).get('activePageRoles', {})
    registered = roles.get(ROLE)
    matches = []
    for candidate in context.pages:
        try:
            if await candidate.evaluate('() => window.name') == ROLE:
                matches.append(candidate)
        except Exception:
            continue
    if registered is not None:
        if not isinstance(registered, dict) or len(matches) != 1 or not isinstance(registered.get('targetId'), str):
            raise SafeFailure('FILES_ROLE_BINDING_INVALID')
        page = matches[0]
        target = await (await context.new_cdp_session(page)).send('Target.getTargetInfo')
        if target.get('targetInfo', {}).get('targetId') != registered['targetId']:
            raise SafeFailure('FILES_ROLE_TARGET_MISMATCH')
        return page, registered['targetId']
    if matches:
        raise SafeFailure('FILES_UNREGISTERED_ROLE_MARKER_FOUND')
    page = await context.new_page()
    await page.evaluate('(marker) => { window.name = marker; }', ROLE)
    target = await (await context.new_cdp_session(page)).send('Target.getTargetInfo')
    target_id = target.get('targetInfo', {}).get('targetId')
    if not isinstance(target_id, str) or len(target_id) < 8:
        raise SafeFailure('FILES_TARGET_ID_UNAVAILABLE')
    update_role_registry(target_id)
    return page, target_id


def event_type(message):
    if isinstance(message, bytes):
        return 'binary'
    try:
        value = json.loads(message)
    except Exception:
        return 'unclassified'
    event = value.get('event') if isinstance(value, dict) else None
    name = event.get('type') if isinstance(event, dict) else None
    return name if isinstance(name, str) and EVENT_RE.fullmatch(name) else 'unclassified'


def prompt_matches(frame_text):
    try:
        frame = json.loads(frame_text)
        chunks = frame.get('event', {}).get('item', {}).get('x_grok', {}).get('input_chunks', [])
        texts = []
        for chunk in chunks:
            text = chunk.get('text') if isinstance(chunk, dict) else None
            if isinstance(text, dict) and isinstance(text.get('text'), str):
                texts.append(text['text'])
        return texts == [PROMPT]
    except Exception:
        return False


async def task_composer_state(page):
    try:
        result = await page.evaluate("""(expected) => {
          const visible = node => !!(node?.getClientRects().length && getComputedStyle(node).visibility !== 'hidden');
          const candidates = [...document.querySelectorAll('textarea,[contenteditable=true],[role=textbox]')]
            .filter(visible).filter(node => !/(search|filter)/i.test((node.getAttribute('aria-label') || '') + ' ' + (node.getAttribute('placeholder') || '')));
          if (candidates.length !== 1) return {uniqueComposer:false, composerCount:candidates.length};
          const node = candidates[0];
          const current = node.matches('textarea,input') ? String(node.value || '') : String(node.innerText || node.textContent || '');
          const kind = button => {
            const icon = button.querySelector('svg,[data-icon]');
            const descriptor = [button.getAttribute('aria-label') || '', button.getAttribute('title') || '',
              button.getAttribute('data-testid') || '', button.className?.baseVal || button.className || '',
              icon?.getAttribute('aria-label') || '', icon?.getAttribute('title') || '',
              icon?.getAttribute('data-icon') || '', button.innerText || button.textContent || ''].join(' ');
            if (/\b(send|submit)\b|arrow[-_ ]?up/i.test(descriptor)) return 'send';
            if (/\b(attach|file|upload)\b/i.test(descriptor)) return 'attachment';
            if (/\b(mic|voice|audio)\b/i.test(descriptor)) return 'voice';
            return 'other';
          };
          const globalButtons = [...document.querySelectorAll('button,[role=button]')];
          const ancestorButtonSummary = [];
          let sendButtonGlobalIndex = null;
          let parent = node.closest('form') || node.parentElement;
          for (let depth = 0; parent && depth < 8; depth++, parent = parent.parentElement) {
            const buttons = [...parent.querySelectorAll('button,[role=button]')].filter(visible);
            if (!buttons.length) continue;
            const kinds = buttons.map(kind);
            const nodeBox = node.getBoundingClientRect();
            const sendIndices = buttons.map(button => {
              const buttonBox = button.getBoundingClientRect();
              const dx = Math.abs((buttonBox.left + buttonBox.right) / 2 - (nodeBox.left + nodeBox.right) / 2);
              const dy = Math.abs((buttonBox.top + buttonBox.bottom) / 2 - (nodeBox.top + nodeBox.bottom) / 2);
              return kind(button) === 'send' && !button.disabled && button.getAttribute('aria-disabled') !== 'true'
                && dx <= 360 && dy <= 220 ? globalButtons.indexOf(button) : -1;
            }).filter(index => index >= 0);
            ancestorButtonSummary.push({depth, visibleButtonCount:buttons.length,
              enabledButtonCount:buttons.filter(button => !button.disabled && button.getAttribute('aria-disabled') !== 'true').length,
              buttonKinds:kinds, nearbySendCandidateCount:sendIndices.length});
            if (sendButtonGlobalIndex === null && sendIndices.length === 1) sendButtonGlobalIndex = sendIndices[0];
          }
          const firstSummary = ancestorButtonSummary[0] || {visibleButtonCount:0,enabledButtonCount:0,buttonKinds:[]};
          return {uniqueComposer:true, promptStillInComposer:current === expected, composerEmpty:current.length === 0,
            nearbyVisibleButtonCount:firstSummary.visibleButtonCount, nearbyEnabledButtonCount:firstSummary.enabledButtonCount,
            nearbyButtonKinds:firstSummary.buttonKinds, ancestorButtonSummary, sendButtonGlobalIndex};
        }""", PROMPT)
        if isinstance(result, dict):
            return result
    except Exception:
        pass
    return {'uniqueComposer': False, 'composerStateReadFailed': True}


async def main():
    # A queued SDK action may outlive the collector. Keep business discovery
    # disabled until cleanup is verified before the Playwright driver exits.
    readonly_modes = (
        'GROK_FILES_READ_SETTINGS_ONLY', 'GROK_FILES_DOM_READONLY',
        'GROK_FILES_RECONCILE_ONLY', 'GROK_FILES_ARTIFACT_READBACK_ONLY',
    )
    if not any(os.environ.get(mode) == '1' for mode in readonly_modes):
        raise SafeFailure('FILES_BUSINESS_CAPTURE_DISABLED_PENDING_GUARD_FINALIZER')
    if CAPTURE_RECEIPT.exists() or TEXT_RECEIPT.exists() or FILES_RECEIPT.exists():
        raise SafeFailure('FILES_TASK_RECEIPT_ALREADY_EXISTS')
    port = verify_runtime(load_json(OWNER_PATH))
    state = {
        'httpAbortCount': 0, 'httpReadCount': 0, 'blockedHttpPathClasses': {},
        'blockedPostObservations': [],
        'websocketInterceptCount': 0, 'controlFrameCount': 0, 'businessFrameCount': 0,
        'businessFramesDelivered': 0, 'controlAckObserved': False, 'guardErrors': 0,
        'outOfScopeSocketCount': 0, 'eventTypeCounts': {}, 'capture': None,
    }
    page = None
    browser = None
    context = None
    target_id = None
    lifecycle = None
    page_cdp = None
    browser_cdp = None
    capture_receipt = None
    email = ''
    command_preference = None
    cookies = []
    session_bundle = None
    capture_packet = None
    files_summary = None
    conversation_id = ''
    prompt_bytes = bytearray(PROMPT.encode('utf-8'))

    async def finalize_owned_page_before_driver_stop():
        nonlocal page_cdp, browser_cdp
        if page is None:
            return
        if context is None or browser is None or lifecycle is None:
            raise SafeFailure('FILES_OWNED_PAGE_FINALIZER_NOT_ARMED')
        if page_cdp is None:
            page_cdp = await context.new_cdp_session(page)
        if browser_cdp is None:
            browser_cdp = await browser.new_browser_cdp_session()
        finalizer_result = await lifecycle.finalize_async(
            page=page,
            cdp_session=page_cdp,
            browser_cdp_session=browser_cdp,
            quiet_ms=1_500,
            max_wait_ms=8_000,
        )
        if isinstance(capture_receipt, dict):
            capture_receipt['pageFinalizer'] = finalizer_result
            atomic_json(CAPTURE_RECEIPT, capture_receipt)
        print(json.dumps({
            'phase': 'owned_page_guard_finalizer',
            'status': finalizer_result.get('status'),
            'quietVerified': finalizer_result.get('quietVerified') is True,
            'guardStillActive': finalizer_result.get('guardStillActive') is True,
            'targetClosed': finalizer_result.get('targetClosed') is True,
            'roleClosedAtomic': finalizer_result.get('roleClosedAtomic') is True,
            'reasonCode': finalizer_result.get('reasonCode'),
        }, separators=(',', ':')), flush=True)
        if finalizer_result.get('status') != 'blank_quiet':
            raise SafeFailure('FILES_OWNED_PAGE_FINALIZER_NOT_VERIFIED')
        try:
            await page_cdp.detach()
        except Exception:
            pass
        try:
            await browser_cdp.detach()
        except Exception:
            pass

    try:
        async with AsyncExitStack() as exit_stack:
            playwright = await exit_stack.enter_async_context(async_playwright())
            exit_stack.push_async_callback(finalize_owned_page_before_driver_stop)
            browser = await playwright.chromium.connect_over_cdp(f'http://127.0.0.1:{port}')
            if len(browser.contexts) != 1:
                raise SafeFailure('OWNED_CONTEXT_COUNT_INVALID')
            context = browser.contexts[0]
            page, target_id = await select_or_create_page(context)
            lifecycle = OwnedPageGuardLifecycle(role_registry_path=ROLE_PATH, role=ROLE,
                target_id=target_id, origin=ORIGIN)
            page_cdp = await context.new_cdp_session(page)
            browser_cdp = await browser.new_browser_cdp_session()

            async def http_guard(route):
                request = route.request
                parsed = urllib.parse.urlsplit(request.url)
                method = request.method.upper()
                if method in {'GET', 'HEAD', 'OPTIONS'}:
                    state['httpReadCount'] += 1
                    try:
                        await route.continue_()
                    except Exception:
                        state['guardErrors'] += 1
                    return
                path = parsed.path
                allowed_read_post = parsed.scheme == 'https' and parsed.hostname == 'grok.com' and method == 'POST' \
                    and (path in NODE_READ_POST_PATHS or bool(re.fullmatch(r'/rest/app-chat/conversations/[^/]+/load-responses', path)))
                if allowed_read_post:
                    state['httpReadCount'] += 1
                    try:
                        await route.continue_()
                    except Exception:
                        state['guardErrors'] += 1
                    return
                if method == 'POST' and len(state['blockedPostObservations']) < 32:
                    state['blockedPostObservations'].append(safe_blocked_post_observation(request, parsed, conversation_id))
                state['httpAbortCount'] += 1
                category = 'other_write'
                host_class = 'other_origin'
                if parsed.hostname == 'grok.com':
                    host_class = 'grok_origin'
                elif isinstance(parsed.hostname, str) and parsed.hostname.endswith('.grok.com'):
                    host_class = 'grok_subdomain'
                path_class = 'other_path'
                if parsed.hostname == 'grok.com' and method == 'POST' and path == '/rest/app-chat/conversations':
                    category = 'conversation_create_write'
                    path_class = 'app_chat_conversation_create'
                elif parsed.hostname == 'grok.com' and method == 'POST' and path == '/rest/app-chat/conversations/new':
                    category = 'response_write'
                    path_class = 'app_chat_conversation_new'
                elif parsed.hostname == 'grok.com' and method == 'POST' \
                        and re.fullmatch(r'/rest/app-chat/conversations/[^/]+/responses', path):
                    category = 'conversation_response_submit'
                    path_class = 'app_chat_conversation_responses'
                elif parsed.hostname == 'grok.com' and path.startswith('/rest/app-chat/conversations/'):
                    category = 'conversation_route_other'
                    path_class = 'app_chat_conversation_other'
                elif parsed.hostname == 'grok.com' and path.startswith('/rest/'):
                    category = 'grok_rest_other'
                    path_class = 'grok_rest_other'
                elif parsed.hostname == 'grok.com' and path.startswith('/api/'):
                    path_class = 'grok_api_other'
                elif parsed.hostname == 'grok.com' and path.startswith('/_next/'):
                    path_class = 'grok_next_other'
                key = f'{method}_{category}_{host_class}_{path_class}'
                state['blockedHttpPathClasses'][key] = state['blockedHttpPathClasses'].get(key, 0) + 1
                try:
                    await route.abort('blockedbyclient')
                except Exception:
                    state['guardErrors'] += 1

            async def websocket_guard(socket_route):
                parsed = urllib.parse.urlsplit(socket_route.url)
                if parsed.scheme != 'wss' or parsed.hostname != 'grok.com' or parsed.path != '/ws/mgw/':
                    state['outOfScopeSocketCount'] += 1
                    try: await socket_route.close(code=1000, reason='grok-files-task-out-of-scope')
                    except Exception: state['guardErrors'] += 1
                    return
                state['websocketInterceptCount'] += 1
                server = socket_route.connect_to_server()
                if asyncio.iscoroutine(server):
                    server = await server

                async def from_page(message):
                    kind = event_type(message)
                    state['eventTypeCounts'][kind] = state['eventTypeCounts'].get(kind, 0) + 1
                    if kind == 'session.create':
                        if state['capture'] is not None or not isinstance(message, str):
                            state['guardErrors'] += 1
                            return
                        state['capture'] = {
                            'socketUrl': socket_route.url,
                            'controlFrameText': message,
                            'frameText': None,
                        }
                        state['controlFrameCount'] += 1
                        try:
                            sent = server.send(message)
                            if asyncio.iscoroutine(sent):
                                await sent
                        except Exception: state['guardErrors'] += 1
                    elif kind == 'response.create':
                        if state['capture'] is None or state['capture'].get('frameText') is not None or not isinstance(message, str):
                            state['guardErrors'] += 1
                            return
                        state['capture']['frameText'] = message
                        state['businessFrameCount'] += 1
                        state['businessFramesDelivered'] = 0
                    else:
                        # Only the normal SDK session control is forwarded before the user frame.
                        return

                async def from_server(message):
                    kind = event_type(message)
                    if kind == 'session.created':
                        state['controlAckObserved'] = True
                        try:
                            sent = socket_route.send(message)
                            if asyncio.iscoroutine(sent):
                                await sent
                        except Exception: state['guardErrors'] += 1
                    # No response/business frame is forwarded back into the UI.

                socket_route.on_message(from_page)
                server.on_message(from_server)

            await lifecycle.install_async(page=page, cdp_session=page_cdp,
                http_policy=http_guard, websocket_policy=websocket_guard, websocket_pattern='**/*')
            if page.url != 'about:blank':
                await page.goto('about:blank', wait_until='load', timeout=30_000)
            await page.evaluate('(marker) => { window.name = marker; }', ROLE)
            await page.goto(ORIGIN + '/', wait_until='domcontentloaded', timeout=60_000)
            await page.wait_for_timeout(5_000)
            if await page.evaluate('() => window.name') != ROLE or urllib.parse.urlsplit(page.url).hostname != 'grok.com':
                raise SafeFailure('FILES_ROLE_ORIGIN_MISMATCH')
            email = await owner_email(page)
            command_preference = await read_cmd_enter_preference(page)
            if os.environ.get('GROK_FILES_READ_SETTINGS_ONLY') == '1':
                print(json.dumps({
                    'status': 'settings_read_verified',
                    'operationId': 'settings.read',
                    'ownerVerified': True,
                    'ownerScopeSha256': EXPECTED_OWNER_SHA256,
                    'httpStatus': command_preference['status'],
                    'requireCmdEnterToSubmit': command_preference['requireCmdEnterToSubmit'],
                    'linuxPlatformObserved': command_preference['linuxPlatformObserved'],
                    'settingsChanged': False,
                    'rawSettingsPersisted': False,
                    'cookieValuesPersisted': False,
                }, separators=(',', ':')))
                return 0
            cookie_rows = await context.cookies([ORIGIN])
            matches = [cookie for cookie in cookie_rows
                       if cookie.get('name') == 'sso'
                       and str(cookie.get('domain', '')).lstrip('.').lower() == 'grok.com'
                       and cookie.get('path') == '/' and cookie.get('secure') is True
                       and isinstance(cookie.get('value'), str) and cookie.get('value')]
            if len(matches) != 1:
                raise SafeFailure('GROK_SSO_COOKIE_SCOPE_INVALID')
            cookie = matches[0]
            session_bundle = {
                'schemaVersion': 1, 'serviceId': 'grok-web', 'origin': ORIGIN,
                'capturedAt': datetime.now(timezone.utc).isoformat(),
                'sourceObservationId': 'grok-conversation-files-once-20261006',
                'origins': [{'origin': ORIGIN, 'cookies': [{
                    'name': 'sso', 'value': cookie['value'], 'origin': ORIGIN,
                    'domain': str(cookie.get('domain') or 'grok.com').lstrip('.'),
                    'path': '/', 'secure': True, 'httpOnly': bool(cookie.get('httpOnly')),
                }], 'headers': []}],
            }
            if os.environ.get('GROK_FILES_DOM_READONLY') == '1':
                if not CREATE_RECEIPT.exists() or not TASK_RECONCILE_RECEIPT.exists():
                    raise SafeFailure('FILES_TASK_DOM_READ_RECEIPT_STATE_INVALID')
                create_evidence = load_json(CREATE_RECEIPT)
                reconcile_evidence = load_json(TASK_RECONCILE_RECEIPT)
                target_hash = create_evidence.get('conversationIdSha256')
                if reconcile_evidence.get('status') != 'completed' \
                        or reconcile_evidence.get('conversationIdSha256') != target_hash:
                    raise SafeFailure('FILES_TASK_DOM_READ_HASH_BINDING_INVALID')
                locate_packet = {
                    'sessionBundle': json.loads(json.dumps(session_bundle)),
                    'expectedIdentity': email,
                    'conversationIdSha256': target_hash,
                }
                locate_wire = bytearray(json.dumps(locate_packet, separators=(',', ':')).encode('utf-8'))
                try:
                    locate_process = await asyncio.create_subprocess_exec(
                        NODE, str(CID_LOCATE_RUNNER), cwd=str(REPO), stdin=asyncio.subprocess.PIPE,
                        stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE, env=node_environment())
                    try:
                        locate_stdout, _ = await asyncio.wait_for(
                            locate_process.communicate(bytes(locate_wire)), timeout=120)
                    except asyncio.TimeoutError:
                        locate_process.kill()
                        await locate_process.wait()
                        raise SafeFailure('FILES_TASK_DOM_CID_LOCATE_TIMEOUT')
                finally:
                    locate_wire[:] = b'\0' * len(locate_wire)
                    locate_packet['expectedIdentity'] = ''
                    locate_packet['conversationIdSha256'] = ''
                    for origin in locate_packet['sessionBundle'].get('origins', []):
                        for item in origin.get('cookies', []):
                            item['value'] = ''
                if len(locate_stdout) > 16 * 1024:
                    raise SafeFailure('FILES_TASK_DOM_CID_LOCATE_OUTPUT_INVALID')
                locate_bytes = bytearray(locate_stdout)
                try:
                    locate_result = json.loads(locate_bytes.decode('utf-8'))
                except Exception as exc:
                    raise SafeFailure('FILES_TASK_DOM_CID_LOCATE_OUTPUT_INVALID') from exc
                finally:
                    locate_bytes[:] = b'\0' * len(locate_bytes)
                    locate_stdout = b''
                if not isinstance(locate_result, dict) \
                        or locate_result.get('operationId') != 'conversation.create.task-cid-locate' \
                        or locate_result.get('status') != 'completed' \
                        or locate_result.get('ownerVerified') is not True \
                        or locate_result.get('conversationIdSha256') != target_hash \
                        or not isinstance(locate_result.get('conversationId'), str):
                    raise SafeFailure('FILES_TASK_DOM_CID_LOCATE_NOT_VERIFIED')
                conversation_id = locate_result.pop('conversationId')
                if sha256(conversation_id.encode('utf-8')) != target_hash:
                    conversation_id = ''
                    raise SafeFailure('FILES_TASK_DOM_CID_HASH_MISMATCH')
                expected_path = '/c/' + urllib.parse.quote(conversation_id, safe='')
                await page.goto('about:blank', wait_until='load', timeout=30_000)
                await page.evaluate('(marker) => { window.name = marker; }', ROLE)
                await page.wait_for_timeout(500)
                state.update({
                    'httpAbortCount': 0, 'httpReadCount': 0, 'blockedHttpPathClasses': {},
                    'blockedPostObservations': [], 'websocketInterceptCount': 0,
                    'controlFrameCount': 0, 'businessFrameCount': 0, 'businessFramesDelivered': 0,
                    'controlAckObserved': False, 'guardErrors': 0, 'outOfScopeSocketCount': 0,
                    'eventTypeCounts': {}, 'capture': None,
                })
                await page.goto(ORIGIN + expected_path, wait_until='domcontentloaded', timeout=60_000)
                await page.wait_for_timeout(5_000)
                current = urllib.parse.urlsplit(page.url)
                if current.hostname != 'grok.com' or current.path != expected_path:
                    raise SafeFailure('FILES_TASK_DOM_ROUTE_MISMATCH')
                bound_email = await owner_email(page)
                if owner_email_sha(bound_email) != EXPECTED_OWNER_SHA256:
                    raise SafeFailure('FILES_TASK_OWNER_CHANGED')
                bound_email = ''
                composer_state = await task_composer_state(page)
                composer_state.pop('sendButtonGlobalIndex', None)
                control_target_matched = False
                control_load_existing = False
                if isinstance(state.get('capture'), dict) and isinstance(state['capture'].get('controlFrameText'), str):
                    try:
                        control = json.loads(state['capture']['controlFrameText'])
                        xgrok = control.get('event', {}).get('session', {}).get('x_grok', {})
                        control_target_matched = xgrok.get('conversation_id') == conversation_id
                        control_load_existing = xgrok.get('load_existing') is True
                    except Exception:
                        pass
                print(json.dumps({
                    'status': 'task_page_dom_readonly',
                    'operationId': 'conversation.read.ui-composer-shape',
                    'conversationIdSha256': target_hash,
                    'ownerVerified': True,
                    'settingsReadStatus': command_preference['status'],
                    'requireCmdEnterToSubmit': command_preference['requireCmdEnterToSubmit'],
                    'linuxPlatformObserved': command_preference['linuxPlatformObserved'],
                    'controlTargetMatched': control_target_matched,
                    'controlLoadExisting': control_load_existing,
                    'composerState': composer_state,
                    'httpWriteAbortCount': state['httpAbortCount'],
                    'blockedHttpPathClasses': state['blockedHttpPathClasses'],
                    'blockedPostObservations': state['blockedPostObservations'],
                    'eventTypeCounts': state['eventTypeCounts'],
                    'rawPromptPersisted': False,
                    'rawMessagesRead': False,
                    'rawIdentifiersPersisted': False,
                    'businessFrameDispatched': False,
                }, separators=(',', ':')))
                return 0
            if os.environ.get('GROK_FILES_RECONCILE_ONLY') == '1':
                if not CREATE_RECEIPT.exists() or TASK_RECONCILE_RECEIPT.exists():
                    raise SafeFailure('FILES_TASK_RECONCILE_RECEIPT_STATE_INVALID')
                create_evidence = load_json(CREATE_RECEIPT)
                reconcile_packet = {
                    'sessionBundle': json.loads(json.dumps(session_bundle)),
                    'expectedIdentity': email,
                    'conversationIdSha256': create_evidence.get('conversationIdSha256'),
                    'expectedPrompt': PROMPT,
                    'fileName': FILE_NAME,
                }
                reconcile_wire = bytearray(json.dumps(reconcile_packet, separators=(',', ':')).encode('utf-8'))
                try:
                    reconcile_process = await asyncio.create_subprocess_exec(
                        NODE, str(TASK_RECONCILE_RUNNER), cwd=str(REPO), stdin=asyncio.subprocess.PIPE,
                        stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE, env=node_environment())
                    try:
                        reconcile_stdout, _ = await asyncio.wait_for(
                            reconcile_process.communicate(bytes(reconcile_wire)), timeout=180)
                    except asyncio.TimeoutError:
                        reconcile_process.kill()
                        await reconcile_process.wait()
                        raise SafeFailure('FILES_TASK_RECONCILE_TIMEOUT')
                finally:
                    reconcile_wire[:] = b'\0' * len(reconcile_wire)
                    reconcile_packet['expectedIdentity'] = ''
                    reconcile_packet['expectedPrompt'] = ''
                    reconcile_packet['fileName'] = ''
                    for origin in reconcile_packet['sessionBundle'].get('origins', []):
                        for item in origin.get('cookies', []):
                            item['value'] = ''
                if len(reconcile_stdout) > 32 * 1024:
                    raise SafeFailure('FILES_TASK_RECONCILE_OUTPUT_INVALID')
                reconcile_bytes = bytearray(reconcile_stdout)
                try:
                    reconcile_summary = json.loads(reconcile_bytes.decode('utf-8'))
                except Exception as exc:
                    raise SafeFailure('FILES_TASK_RECONCILE_OUTPUT_INVALID') from exc
                finally:
                    reconcile_bytes[:] = b'\0' * len(reconcile_bytes)
                    reconcile_stdout = b''
                if not isinstance(reconcile_summary, dict) \
                        or reconcile_summary.get('operationId') != 'conversation.files.task-cid-reconcile':
                    raise SafeFailure('FILES_TASK_RECONCILE_OUTPUT_INVALID')
                print(json.dumps(reconcile_summary, separators=(',', ':')))
                return 0 if reconcile_summary.get('status') == 'completed' else 1
            if os.environ.get('GROK_FILES_ARTIFACT_READBACK_ONLY') == '1':
                if not CREATE_RECEIPT.exists() or ARTIFACT_READBACK_RECEIPT.exists():
                    raise SafeFailure('FILES_ARTIFACT_READBACK_RECEIPT_STATE_INVALID')
                create_evidence = load_json(CREATE_RECEIPT)
                if create_evidence.get('operationId') != 'conversation.create' \
                        or create_evidence.get('status') != 'completed' \
                        or create_evidence.get('verified') is not True \
                        or create_evidence.get('ownerScopeSha256') != EXPECTED_OWNER_SHA256:
                    raise SafeFailure('FILES_TASK_CREATE_RECEIPT_INVALID')
                artifact_packet = {
                    'sessionBundle': json.loads(json.dumps(session_bundle)),
                    'expectedIdentity': email,
                    'conversationIdSha256': create_evidence.get('conversationIdSha256'),
                    'expectedPrompt': PROMPT,
                }
                artifact_wire = bytearray(json.dumps(artifact_packet, separators=(',', ':')).encode('utf-8'))
                try:
                    artifact_process = await asyncio.create_subprocess_exec(
                        NODE, str(ARTIFACT_READBACK_RUNNER), cwd=str(REPO), stdin=asyncio.subprocess.PIPE,
                        stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE, env=node_environment())
                    try:
                        artifact_stdout, _ = await asyncio.wait_for(
                            artifact_process.communicate(bytes(artifact_wire)), timeout=300)
                    except asyncio.TimeoutError:
                        artifact_process.kill()
                        await artifact_process.wait()
                        raise SafeFailure('FILES_ARTIFACT_READBACK_TIMEOUT')
                finally:
                    artifact_wire[:] = b'\0' * len(artifact_wire)
                    artifact_packet['expectedIdentity'] = ''
                    artifact_packet['expectedPrompt'] = ''
                    artifact_packet['conversationIdSha256'] = ''
                    for origin in artifact_packet['sessionBundle'].get('origins', []):
                        for item in origin.get('cookies', []):
                            item['value'] = ''
                if len(artifact_stdout) > 32 * 1024:
                    raise SafeFailure('FILES_ARTIFACT_READBACK_OUTPUT_INVALID')
                artifact_bytes = bytearray(artifact_stdout)
                try:
                    artifact_summary = json.loads(artifact_bytes.decode('utf-8'))
                except Exception as exc:
                    raise SafeFailure('FILES_ARTIFACT_READBACK_OUTPUT_INVALID') from exc
                finally:
                    artifact_bytes[:] = b'\0' * len(artifact_bytes)
                    artifact_stdout = b''
                if not isinstance(artifact_summary, dict) \
                        or artifact_summary.get('operationId') != 'conversation.files.artifact-readback':
                    raise SafeFailure('FILES_ARTIFACT_READBACK_OUTPUT_INVALID')
                print(json.dumps(artifact_summary, separators=(',', ':')))
                return 0 if artifact_summary.get('status') != 'needs_review' else 1
            unique_preflight = None
            for attempt in range(2):
                unique_preflight = await page.evaluate("""async (marker) => {
                  const url = new URL('/rest/app-chat/conversations', location.origin);
                  url.searchParams.set('pageSize', '24');
                  url.searchParams.set('searchQuery', marker);
                  const response = await fetch(url, { method:'GET', credentials:'same-origin', redirect:'error', cache:'no-store' });
                  if (!response.ok) return {status:response.status, matches:-1, retryAfter:response.headers.get('retry-after')};
                  const data = await response.json();
                  const matches = Array.isArray(data?.textSearchMatches) ? data.textSearchMatches : [];
                  const matchTypeCounts = {};
                  let exactTitleMatchCount = 0;
                  for (const match of matches) {
                    const type = typeof match?.matchType === 'string' && /^[A-Z_]{1,48}$/.test(match.matchType)
                      ? match.matchType : 'OTHER';
                    matchTypeCounts[type] = (matchTypeCounts[type] || 0) + 1;
                    const title = match?.conversation?.title;
                    if (typeof title === 'string' && title === marker) exactTitleMatchCount++;
                  }
                  return {status:response.status, matches:matches.length, exactTitleMatchCount,
                    matchTypeCounts, conversationsCount:Array.isArray(data?.conversations)?data.conversations.length:0,
                    retryAfter:null};
                }""", FILE_NAME)
                if unique_preflight.get('status') != 429 or attempt == 1:
                    break
                retry_after = unique_preflight.get('retryAfter')
                delay_ms = None
                if isinstance(retry_after, str):
                    try:
                        delay_ms = max(0, int(float(retry_after.strip()) * 1000))
                    except Exception:
                        try:
                            retry_at = email_utils.parsedate_to_datetime(retry_after)
                            if retry_at.tzinfo is None:
                                retry_at = retry_at.replace(tzinfo=timezone.utc)
                            delay_ms = max(0, int((retry_at - datetime.now(timezone.utc)).total_seconds() * 1000))
                        except Exception:
                            delay_ms = None
                if delay_ms is None:
                    raise SafeFailure('FILES_TASK_MARKER_SEARCH_RETRY_AFTER_INVALID')
                if delay_ms > 120_000:
                    raise SafeFailure('FILES_TASK_MARKER_SEARCH_RETRY_AFTER_EXCEEDS_BOUND')
                await page.wait_for_timeout(max(250, delay_ms))
            if unique_preflight.get('status') != 200:
                status = unique_preflight.get('status')
                if isinstance(status, int) and 100 <= status <= 599:
                    raise SafeFailure(f'FILES_TASK_MARKER_SEARCH_HTTP_{status}')
                raise SafeFailure('FILES_TASK_MARKER_SEARCH_FAILED')
            if unique_preflight.get('exactTitleMatchCount') != 0:
                exact_title_count = unique_preflight.get('exactTitleMatchCount', -1)
                raise SafeFailure(f'FILES_TASK_MARKER_TITLE_MATCH_{exact_title_count}')
            search_coverage = 'zero_matches' if unique_preflight.get('matches') == 0 else 'broad_hits_no_exact_title'

            # Close the home-page WSS before opening the directly created task CID,
            # so the normal SDK control frame is source-bound to that exact target.
            await page.goto('about:blank', wait_until='load', timeout=30_000)
            await page.evaluate('(marker) => { window.name = marker; }', ROLE)
            await page.wait_for_timeout(500)
            state.update({
                'httpAbortCount': 0, 'httpReadCount': 0, 'blockedHttpPathClasses': {},
                'blockedPostObservations': [],
                'websocketInterceptCount': 0, 'controlFrameCount': 0, 'businessFrameCount': 0,
                'businessFramesDelivered': 0, 'controlAckObserved': False, 'guardErrors': 0,
                'outOfScopeSocketCount': 0, 'eventTypeCounts': {}, 'capture': None,
            })
            if CREATE_RECEIPT.exists():
                try:
                    create_evidence = load_json(CREATE_RECEIPT)
                except SafeFailure:
                    raise
                if create_evidence.get('operationId') != 'conversation.create' \
                        or create_evidence.get('status') != 'completed' \
                        or create_evidence.get('verified') is not True \
                        or create_evidence.get('ownerVerified') is not True \
                        or create_evidence.get('ownerScopeSha256') != EXPECTED_OWNER_SHA256:
                    raise SafeFailure('FILES_TASK_CREATE_RECEIPT_INVALID')
                conversation_id, recovery_evidence = await recover_exact_created_conversation(
                    session_bundle, email, create_evidence)
            else:
                conversation_id, create_evidence = await create_empty_task_conversation(session_bundle, email)
                recovery_evidence = None
            expected_path = '/c/' + urllib.parse.quote(conversation_id, safe='')
            await page.goto(ORIGIN + expected_path, wait_until='domcontentloaded', timeout=60_000)
            await page.wait_for_timeout(5_000)
            current = urllib.parse.urlsplit(page.url)
            if (await page.evaluate('() => window.name') != ROLE or current.hostname != 'grok.com'
                    or current.path != expected_path):
                raise SafeFailure('FILES_TASK_CONVERSATION_ROUTE_MISMATCH')
            bound_email = await owner_email(page)
            if owner_email_sha(bound_email) != EXPECTED_OWNER_SHA256:
                raise SafeFailure('FILES_TASK_OWNER_CHANGED')
            bound_email = ''

            if os.environ.get('GROK_FILES_DOM_READONLY') == '1':
                composer_state = await task_composer_state(page)
                composer_state.pop('sendButtonGlobalIndex', None)
                control_target_matched = False
                control_load_existing = False
                if isinstance(state.get('capture'), dict) and isinstance(state['capture'].get('controlFrameText'), str):
                    try:
                        control = json.loads(state['capture']['controlFrameText'])
                        xgrok = control.get('event', {}).get('session', {}).get('x_grok', {})
                        control_target_matched = xgrok.get('conversation_id') == conversation_id
                        control_load_existing = xgrok.get('load_existing') is True
                    except Exception:
                        pass
                print(json.dumps({
                    'status': 'task_page_dom_readonly',
                    'operationId': 'conversation.read.ui-composer-shape',
                    'conversationIdSha256': create_evidence.get('conversationIdSha256'),
                    'ownerVerified': True,
                    'settingsReadStatus': command_preference['status'],
                    'requireCmdEnterToSubmit': command_preference['requireCmdEnterToSubmit'],
                    'linuxPlatformObserved': command_preference['linuxPlatformObserved'],
                    'controlTargetMatched': control_target_matched,
                    'controlLoadExisting': control_load_existing,
                    'composerState': composer_state,
                    'httpWriteAbortCount': state['httpAbortCount'],
                    'blockedHttpPathClasses': state['blockedHttpPathClasses'],
                    'blockedPostObservations': state['blockedPostObservations'],
                    'eventTypeCounts': state['eventTypeCounts'],
                    'rawPromptPersisted': False,
                    'rawMessagesRead': False,
                    'rawIdentifiersPersisted': False,
                    'businessFrameDispatched': False,
                }, separators=(',', ':')))
                return 0

            composer = await page.evaluate("""() => {
              const visible = e => !!(e.getClientRects().length && getComputedStyle(e).visibility !== 'hidden');
              const candidates = [...document.querySelectorAll('textarea,[contenteditable=true],[role=textbox]')]
                .filter(visible).filter(e => !/(search|filter)/i.test((e.getAttribute('aria-label') || '') + ' ' + (e.getAttribute('placeholder') || '')));
              return {count:candidates.length, tag:candidates.length === 1 ? candidates[0].tagName.toLowerCase() : null,
                editable:candidates.length === 1 ? candidates[0].getAttribute('contenteditable') === 'true' : false};
            }""")
            if composer.get('count') != 1:
                raise SafeFailure('FILES_COMPOSER_NOT_UNIQUE')
            candidates = page.locator('textarea,[contenteditable="true"],[role="textbox"]')
            visible_indices = []
            for index in range(await candidates.count()):
                item = candidates.nth(index)
                try:
                    if await item.is_visible() and not re.search(r'(search|filter)', (await item.get_attribute('aria-label') or '') + ' ' + (await item.get_attribute('placeholder') or ''), re.I):
                        visible_indices.append(index)
                except Exception:
                    continue
            if len(visible_indices) != 1:
                raise SafeFailure('FILES_COMPOSER_NOT_UNIQUE')
            await candidates.nth(visible_indices[0]).fill(PROMPT)
            await page.keyboard.press('Control+Enter' if command_preference['requireCmdEnterToSubmit'] else 'Enter')
            deadline = asyncio.get_running_loop().time() + 20
            while asyncio.get_running_loop().time() < deadline:
                capture = state.get('capture')
                if isinstance(capture, dict) and isinstance(capture.get('frameText'), str):
                    break
                await page.wait_for_timeout(100)
            capture = state.get('capture')
            if (not isinstance(capture, dict) or not isinstance(capture.get('frameText'), str)
                    or not state['controlAckObserved'] or state['controlFrameCount'] != 1
                    or state['businessFrameCount'] != 1 or state['businessFramesDelivered'] != 0
                    or state['guardErrors'] != 0 or not prompt_matches(capture['frameText'])):
                failures = []
                if not isinstance(capture, dict):
                    failures.append('capture_missing')
                elif not isinstance(capture.get('frameText'), str):
                    failures.append('business_frame_missing')
                if not state['controlAckObserved']:
                    failures.append('session_ack_missing')
                if state['controlFrameCount'] != 1:
                    failures.append('control_count_invalid')
                if state['businessFrameCount'] != 1:
                    failures.append('business_count_invalid')
                if state['businessFramesDelivered'] != 0:
                    failures.append('browser_business_delivery_nonzero')
                if state['guardErrors'] != 0:
                    failures.append('guard_error_observed')
                if isinstance(capture, dict) and isinstance(capture.get('frameText'), str) \
                        and not prompt_matches(capture['frameText']):
                    failures.append('captured_prompt_shape_mismatch')
                failures.extend([
                    f'ws_intercepts_{state["websocketInterceptCount"]}',
                    f'out_of_scope_sockets_{state["outOfScopeSocketCount"]}',
                    f'http_write_aborts_{state["httpAbortCount"]}',
                    f'guard_errors_{state["guardErrors"]}',
                    'event_types_' + '-'.join(sorted(name for name in state['eventTypeCounts']
                        if EVENT_RE.fullmatch(name))) if state['eventTypeCounts'] else 'event_types_none',
                ])
                if isinstance(capture, dict) and isinstance(capture.get('controlFrameText'), str):
                    try:
                        control = json.loads(capture['controlFrameText'])
                        xgrok = control.get('event', {}).get('session', {}).get('x_grok', {})
                        failures.append(f'control_target_matched_{xgrok.get("conversation_id") == conversation_id}')
                        failures.append(f'control_load_existing_{xgrok.get("load_existing") is True}')
                    except Exception:
                        failures.append('control_shape_unreadable')
                for category, count in sorted(state['blockedHttpPathClasses'].items()):
                    if re.fullmatch(r'[A-Z][A-Za-z0-9_]{1,63}', category) and isinstance(count, int):
                        failures.append(f'blocked_{category}_{count}')
                if os.environ.get('GROK_FILES_CAPTURE_ONLY') == '1':
                    composer_state = await task_composer_state(page)
                    composer_state.pop('sendButtonGlobalIndex', None)
                    control_target_matched = False
                    control_load_existing = False
                    if isinstance(capture, dict) and isinstance(capture.get('controlFrameText'), str):
                        try:
                            control = json.loads(capture['controlFrameText'])
                            xgrok = control.get('event', {}).get('session', {}).get('x_grok', {})
                            control_target_matched = xgrok.get('conversation_id') == conversation_id
                            control_load_existing = xgrok.get('load_existing') is True
                        except Exception:
                            pass
                    print(json.dumps({
                        'status': 'capture_only_not_verified',
                        'operationId': 'chat.text.continuation.wss',
                        'conversationIdSha256': create_evidence.get('conversationIdSha256'),
                        'controlTargetMatched': control_target_matched,
                        'controlLoadExisting': control_load_existing,
                        'browserBusinessFramesCaptured': state['businessFrameCount'],
                        'browserBusinessFramesDelivered': state['businessFramesDelivered'],
                        'settingsReadStatus': command_preference['status'],
                        'requireCmdEnterToSubmit': command_preference['requireCmdEnterToSubmit'],
                        'linuxPlatformObserved': command_preference['linuxPlatformObserved'],
                        'httpWriteAbortCount': state['httpAbortCount'],
                        'blockedHttpPathClasses': state['blockedHttpPathClasses'],
                        'blockedPostObservations': state['blockedPostObservations'],
                        'composerState': composer_state,
                        'eventTypeCounts': state['eventTypeCounts'],
                        'rawBodiesPersisted': False,
                        'rawIdentifiersPersisted': False,
                        'businessFrameDispatched': False,
                    }, separators=(',', ':')))
                    return 1
                raise SafeFailure('FILES_NATIVE_CAPTURE_NOT_VERIFIED_' + '_'.join(failures or ['unknown']))

            if os.environ.get('GROK_FILES_CAPTURE_ONLY') == '1':
                control = json.loads(capture['controlFrameText'])
                xgrok = control.get('event', {}).get('session', {}).get('x_grok', {})
                composer_state = await task_composer_state(page)
                composer_state.pop('sendButtonGlobalIndex', None)
                print(json.dumps({
                    'status': 'capture_only_wss_frame_captured',
                    'operationId': 'chat.text.continuation.wss',
                    'sourcePageRole': ROLE,
                    'conversationIdSha256': create_evidence.get('conversationIdSha256'),
                    'controlTargetMatched': xgrok.get('conversation_id') == conversation_id,
                    'controlLoadExisting': xgrok.get('load_existing') is True,
                    'browserBusinessFramesCaptured': state['businessFrameCount'],
                    'browserBusinessFramesDelivered': state['businessFramesDelivered'],
                    'settingsReadStatus': command_preference['status'],
                    'requireCmdEnterToSubmit': command_preference['requireCmdEnterToSubmit'],
                    'linuxPlatformObserved': command_preference['linuxPlatformObserved'],
                    'httpWriteAbortCount': state['httpAbortCount'],
                    'blockedHttpPathClasses': state['blockedHttpPathClasses'],
                    'blockedPostObservations': state['blockedPostObservations'],
                    'composerState': composer_state,
                    'eventTypeCounts': state['eventTypeCounts'],
                    'rawPromptPersisted': False,
                    'rawFramesPersisted': False,
                    'rawIdentifiersPersisted': False,
                    'businessFrameDispatched': False,
                }, separators=(',', ':')))
                return 0

            capture_receipt = {
                'schemaVersion': 1, 'operationId': 'chat.text.continuation.wss', 'featureId': 'artifact-download',
                'observedAt': datetime.now(timezone.utc).isoformat(),
                'pageRole': ROLE, 'pageRoleMatched': True, 'targetIdPersisted': False,
                'ownerVerified': True, 'ownerScopeSha256': EXPECTED_OWNER_SHA256,
                'settingsReadStatus': command_preference['status'],
                'requireCmdEnterToSubmit': command_preference['requireCmdEnterToSubmit'],
                'linuxPlatformObserved': command_preference['linuxPlatformObserved'],
                'createOperationId': 'conversation.create',
                'createIntentDigest': create_evidence.get('intentDigest'),
                'conversationIdSha256': create_evidence.get('conversationIdSha256'),
                'cidRecoveryReceiptPath': 'verification/grok-conversation-files-create-cid-reconcile-live-2026-10-06.json'
                    if recovery_evidence else None,
                'exactMarkerAbsentBeforeWrite': True if search_coverage == 'zero_matches' else None,
                'markerSearchCoverage': search_coverage,
                'markerSearchStatus': unique_preflight['status'],
                'markerSearchMatchCount': unique_preflight['matches'],
                'exactTitleMatchCount': unique_preflight['exactTitleMatchCount'],
                'browserGuards': {
                    'httpGuardInstalledBeforeNavigation': True, 'webSocketGuardInstalledBeforeNavigation': True,
                    'httpAbortCount': state['httpAbortCount'], 'httpReadCount': state['httpReadCount'],
                    'blockedHttpPathClasses': state['blockedHttpPathClasses'],
                    'blockedPostObservations': state['blockedPostObservations'],
                    'websocketInterceptCount': state['websocketInterceptCount'],
                    'controlFrameCount': state['controlFrameCount'],
                    'sessionCreatedAckObserved': state['controlAckObserved'],
                    'businessFrameCount': state['businessFrameCount'],
                    'browserBusinessFramesDelivered': state['businessFramesDelivered'],
                    'eventTypeCounts': state['eventTypeCounts'],
                },
                'promptSha256': sha256(prompt_bytes), 'promptBytes': len(prompt_bytes),
                'rawPromptPersisted': False, 'rawControlFramePersisted': False,
                'rawBusinessFramePersisted': False, 'cookieValuesPersisted': False,
                'browserContextClosed': False, 'browserClosed': False,
            }
            atomic_json(CAPTURE_RECEIPT, capture_receipt)

            capture_packet = {
                'sessionBundle': session_bundle,
                'expectedIdentity': email,
                'intentId': f'grok-files-csv-continuation-20261006-{uuid.uuid4()}',
                'capture': {
                    'sourcePageRole': ROLE, 'browserWriteAbortVerified': True,
                    'browserBusinessFramesCaptured': 1, 'browserBusinessWritesDelivered': 0,
                    'browserControlFramesForwarded': 1,
                    'socketUrl': capture['socketUrl'],
                    'controlFrameText': capture['controlFrameText'],
                    'frameText': capture['frameText'],
                },
            }
            # The owned Chrome profile is persistent; erase the task CID from
            # this navigation entry before resetting the same target.
            await page.evaluate("() => history.replaceState(history.state, '', '/')")
            await page.goto('about:blank', wait_until='load', timeout=30_000)
            await page.evaluate('(marker) => { window.name = marker; }', ROLE)
            await page.wait_for_timeout(2_000)
            if page.url != 'about:blank' or await page.evaluate('() => window.name') != ROLE:
                raise SafeFailure('FILES_PAGE_RESET_FAILED')

            # The production direct-WSS submitter and file client run together,
            # retaining private correlation identifiers only in process memory.
            packet_for_files = {
                'sessionBundle': session_bundle,
                'expectedIdentity': email,
                'expectedPrompt': PROMPT,
                'fileName': FILE_NAME,
                'intentId': capture_packet['intentId'],
                'capture': capture_packet['capture'],
                'conversationId': conversation_id,
                'createEvidence': create_evidence,
                'cidRecoveryEvidence': recovery_evidence,
                'captureEvidence': {
                    'observedAt': capture_receipt['observedAt'],
                    'sourcePageRole': ROLE,
                    'promptSha256': capture_receipt['promptSha256'],
                    'businessFrameCaptured': True,
                    'browserBusinessFramesDelivered': 0,
                    'markerSearchCoverage': search_coverage,
                    'markerSearchStatus': unique_preflight['status'],
                    'markerSearchMatchCount': unique_preflight['matches'],
                    'exactTitleMatchCount': unique_preflight['exactTitleMatchCount'],
                    'conversationIdSha256': create_evidence['conversationIdSha256'],
                    'cidRecoveryReceiptPath': recovery_evidence.get('receiptPath') if recovery_evidence else None,
                },
                'outputDirectory': str(pathlib.Path.home() / 'artifacts' / 'grok-conversation-files-20261006'),
            }
            file_wire = bytearray(json.dumps(packet_for_files, separators=(',', ':')).encode('utf-8'))
            try:
                file_process = await asyncio.create_subprocess_exec(
                    NODE, str(FILES_RUNNER), stdin=asyncio.subprocess.PIPE,
                    stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
                    env=node_environment(),
                )
                try:
                    file_stdout, _ = await asyncio.wait_for(file_process.communicate(bytes(file_wire)), timeout=600)
                except asyncio.TimeoutError:
                    file_process.kill()
                    await file_process.wait()
                    raise SafeFailure('FILES_READBACK_RUNNER_TIMEOUT')
            finally:
                file_wire[:] = b'\0' * len(file_wire)
                packet_for_files['expectedIdentity'] = ''
                packet_for_files['expectedPrompt'] = ''
                packet_for_files['conversationId'] = ''
                packet_for_files['sessionBundle']['origins'][0]['cookies'][0]['value'] = ''
            if len(file_stdout) > 64 * 1024:
                raise SafeFailure('FILES_READBACK_OUTPUT_INVALID')
            try:
                files_summary = json.loads(file_stdout.decode('utf-8'))
            except Exception as exc:
                raise SafeFailure('FILES_READBACK_OUTPUT_INVALID') from exc
            if not isinstance(files_summary, dict) or files_summary.get('operationId') != 'conversation.files.download-once':
                raise SafeFailure('FILES_READBACK_OUTPUT_INVALID')

            cookie['value'] = ''
            email = ''
            matches.clear()
            capture_packet['capture']['controlFrameText'] = ''
            capture_packet['capture']['frameText'] = ''
            capture_packet['capture']['socketUrl'] = ''
            conversation_id = ''
            capture_receipt['directTaskState'] = files_summary.get('textTaskState')
            capture_receipt['directTaskReadbackVerified'] = files_summary.get('textTaskReadbackVerified') is True

            await page.wait_for_timeout(2_000)
            capture_receipt['sameTargetResetToBlank'] = page.url == 'about:blank'
            capture_receipt['sameRoleMarkerPreserved'] = await page.evaluate('() => window.name') == ROLE
            capture_receipt['quietWaitMs'] = 2_000
            capture_receipt['browserClosed'] = False
            capture_receipt['browserContextClosed'] = False
            atomic_json(CAPTURE_RECEIPT, capture_receipt)
            print(json.dumps({
                'status': files_summary.get('status'),
                'operationId': files_summary.get('operationId'),
                'captureReceiptPath': str(CAPTURE_RECEIPT.relative_to(REPO)),
                'createReceiptPath': str(CREATE_RECEIPT.relative_to(REPO)),
                'fileReceiptPath': str(FILES_RECEIPT.relative_to(REPO)),
                'wssTaskState': files_summary.get('textTaskState'),
                'fileApiStatus': files_summary.get('fileApiStatus'),
                'fileDownloadStatus': files_summary.get('fileDownloadStatus'),
                'zipDownloadStatus': files_summary.get('zipDownloadStatus'),
                'workspaceZipStatus': files_summary.get('workspaceZipStatus'),
                'rawIdentifiersPersisted': False,
                'rawPromptPersisted': False,
                'rawUrlsPersisted': False,
            }, separators=(',', ':')))
            return 0 if files_summary.get('status') in {
                'csv_download_verified', 'csv_and_zip_download_verified', 'csv_files_zip_and_workspace_zip_verified'
            } else 1
    except SafeFailure as exc:
        print(exc.code)
        return 1
    except Exception as exc:
        print(f'FILES_TASK_RUNNER_FAILED:{type(exc).__name__}')
        return 1
    finally:
        prompt_bytes[:] = b'\0' * len(prompt_bytes)
        if email:
            email = ''
        if session_bundle and isinstance(session_bundle.get('origins'), list):
            for origin in session_bundle['origins']:
                for item in origin.get('cookies', []) if isinstance(origin, dict) else []:
                    item['value'] = ''
        if capture_packet and isinstance(capture_packet.get('capture'), dict):
            capture_packet['capture']['socketUrl'] = ''
            capture_packet['capture']['controlFrameText'] = ''
            capture_packet['capture']['frameText'] = ''
        # The AsyncExitStack finalizer resets under active guards before the driver disconnects.
        # The shared browser/context are never closed.


if __name__ == '__main__':
    try:
        raise SystemExit(asyncio.run(main()))
    except SafeFailure as exc:
        print(exc.code)
        raise SystemExit(1)
    except Exception as exc:
        print(f'GROK_FILES_CAPTURE_FAILED:{type(exc).__name__}')
        raise SystemExit(1)
