#!/usr/bin/env python3
"""Capture one scoped current-owner session, then run normal CLI readbacks only."""

import asyncio
import fcntl
import hashlib
import json
import os
import pathlib
import shutil
import subprocess
import sys
from datetime import datetime, timezone

from playwright.async_api import async_playwright


REPO = pathlib.Path(__file__).resolve().parent.parent
RUNTIME = pathlib.Path.home() / '.nad-scratch/provider-runtime-20261005'
OWNER_PATH = RUNTIME / 'runtime-owner.json'
ROLE_PATH = RUNTIME / 'page-role-registry.json'
ROLE_LOCK = RUNTIME / 'page-role-registry.lock'
ROLE = 'codex-grok-files-20261006'
ORIGIN = 'https://grok.com'
OWNER_SHA256 = '23e57131977ce522bacf6649eb27538770828a890f7a65589ec4f0960a84b3d7'
TASK_CACHE = pathlib.Path.home() / '.nad-scratch/provider-runtime-20261005/grok-fast-task-private-reference/verified-fast-task.json'
NODE_RUNNER = REPO / 'scripts/grok-fast-task-readonly-cli-once.mjs'
NODE = shutil.which('node') or '/usr/bin/node'
PYTHON = '/home/worker/work/web-api-playbook-inpock-20261004/.venv-oliveyoung/bin/python'
MAX_CACHE_BYTES = 16 * 1024
MAX_NODE_OUTPUT_BYTES = 64 * 1024


class SafeFailure(Exception):
    def __init__(self, code):
        self.code = code


def sha256(value):
    return hashlib.sha256(value).hexdigest()


def read_json(path, limit, *, require_private=True):
    try:
        info = path.lstat()
        if path.is_symlink() or not path.is_file() or info.st_nlink != 1 \
                or info.st_uid != os.getuid() or require_private and info.st_mode & 0o077 \
                or info.st_size < 1 or info.st_size > limit:
            raise SafeFailure('FAST_READ_LOCAL_STATE_INVALID')
        raw = bytearray(path.read_bytes())
    except SafeFailure:
        raise
    except Exception as exc:
        raise SafeFailure('FAST_READ_LOCAL_STATE_UNAVAILABLE') from exc
    try:
        return json.loads(raw.decode('utf-8'))
    except Exception as exc:
        raise SafeFailure('FAST_READ_LOCAL_STATE_INVALID') from exc
    finally:
        raw[:] = b'\0' * len(raw)


def verify_runtime():
    owner = read_json(OWNER_PATH, 16 * 1024, require_private=False)
    if owner.get('taskOwned') is not True or owner.get('mode') != 'cdp_discovery_after_native_bootstrap':
        raise SafeFailure('FAST_READ_RUNTIME_INVALID')
    profile = pathlib.Path(owner.get('profile', ''))
    try:
        profile.relative_to(pathlib.Path.home() / '.nad-scratch')
    except Exception as exc:
        raise SafeFailure('FAST_READ_PROFILE_INVALID') from exc
    pid = owner.get('chromePid')
    port = owner.get('cdpPort')
    if not isinstance(pid, int) or not isinstance(port, int) or not 1 <= port <= 65535:
        raise SafeFailure('FAST_READ_RUNTIME_INVALID')
    try:
        os.kill(pid, 0)
        argv = pathlib.Path(f'/proc/{pid}/cmdline').read_bytes().split(b'\0')
        if f'--user-data-dir={profile}'.encode() not in argv:
            raise SafeFailure('FAST_READ_PROFILE_MISMATCH')
    except SafeFailure:
        raise
    except Exception as exc:
        raise SafeFailure('FAST_READ_RUNTIME_UNAVAILABLE') from exc

    lock_fd = os.open(ROLE_LOCK, os.O_RDONLY)
    try:
        fcntl.flock(lock_fd, fcntl.LOCK_SH)
        roles = read_json(ROLE_PATH, 128 * 1024)
        role = roles.get('activePageRoles', {}).get(ROLE)
        target_id = role.get('targetId') if isinstance(role, dict) else None
        if not isinstance(target_id, str) or len(target_id) < 8:
            raise SafeFailure('FAST_READ_ROLE_UNREGISTERED')
        return port, target_id
    finally:
        fcntl.flock(lock_fd, fcntl.LOCK_UN)
        os.close(lock_fd)


def node_environment():
    allowed = {'PATH', 'HOME', 'LANG', 'LC_ALL', 'TMPDIR', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'REQUESTS_CA_BUNDLE'}
    environment = {key: os.environ[key] for key in allowed if isinstance(os.environ.get(key), str)}
    environment['PYTHONDONTWRITEBYTECODE'] = '1'
    environment['GROK_CHROME_PYTHON'] = PYTHON
    return environment


async def execute_cli_reads(target_id, port):
    playwright = await async_playwright().start()
    browser = None
    cdp = None
    stage = 'connect'
    identity = ''
    session_bundle = None
    packet = None
    wire = None
    cookies = []
    body = None
    body_bytes = None
    cookie = None
    try:
        browser = await playwright.chromium.connect_over_cdp(f'http://127.0.0.1:{port}')
        stage = 'target_discovery'
        cdp = await browser.new_browser_cdp_session()
        target_snapshot = await cdp.send('Target.getTargets')
        matching_targets = [item for item in target_snapshot.get('targetInfos', [])
                            if item.get('targetId') == target_id and item.get('type') == 'page']
        if len(matching_targets) != 1:
            raise SafeFailure('FAST_READ_ROLE_TARGET_NOT_FOUND')
        stage = 'role_page_discovery'
        role_pages = []
        for context in browser.contexts:
            for page in context.pages:
                try:
                    if await page.evaluate('() => window.name') == ROLE:
                        role_pages.append(page)
                except Exception:
                    continue
        if len(role_pages) != 1:
            raise SafeFailure('FAST_READ_ROLE_PAGE_NOT_UNIQUE')
        page = role_pages[0]
        if page.context is None:
            raise SafeFailure('FAST_READ_ROLE_CONTEXT_MISSING')
        stage = 'cookie_read'
        context = page.context
        cookies = await context.cookies([ORIGIN])
        matches = [row for row in cookies if row.get('name') == 'sso'
                   and str(row.get('domain', '')).lstrip('.').lower() == 'grok.com'
                   and row.get('path') == '/' and row.get('secure') is True
                   and isinstance(row.get('value'), str) and row.get('value')]
        if len(matches) != 1:
            raise SafeFailure('FAST_READ_SSO_SCOPE_INVALID')
        cookie = matches[0]

        stage = 'owner_identity_http'
        if any(char in cookie['value'] for char in '\r\n;\0'):
            raise SafeFailure('FAST_READ_SSO_VALUE_INVALID')
        response = await context.request.get(f'{ORIGIN}/api/auth/session',
            headers={'accept': 'application/json', 'cookie': f"sso={cookie['value']}"},
            timeout=20_000, max_redirects=0, fail_on_status_code=False)
        stage = 'owner_identity_status'
        if response.status != 200:
            raise SafeFailure('FAST_READ_OWNER_IDENTITY_HTTP_FAILED')
        stage = 'owner_identity_body'
        body_bytes = bytearray(await response.body())
        stage = 'owner_identity_json'
        body = json.loads(body_bytes.decode('utf-8'))
        stage = 'owner_identity_email'
        session = body.get('session') if isinstance(body, dict) else None
        email = session.get('email') if isinstance(session, dict) else None
        if not isinstance(email, str) or not email.strip() \
                or sha256(email.strip().lower().encode('utf-8')) != OWNER_SHA256:
            raise SafeFailure('FAST_READ_OWNER_IDENTITY_MISMATCH')
        identity = email
        stage = 'owner_identity_receipt'
        owner_bootstrap = {
            'status': response.status,
            'method': 'GET',
            'path': '/api/auth/session',
            'contentType': response.headers.get('content-type'),
            'responseBytes': len(body_bytes),
            'rawResponseDigest': sha256(body_bytes),
            'cookieNames': ['sso'],
            'redirectsFollowed': False,
        }
        session_bundle = {
            'schemaVersion': 1,
            'serviceId': 'grok-web',
            'origin': ORIGIN,
            'capturedAt': datetime.now(timezone.utc).isoformat(),
            'sourceObservationId': 'grok-fast-task-readonly-cli-20261006',
            'origins': [{
                'origin': ORIGIN,
                'cookies': [{
                    'name': 'sso', 'value': cookie['value'], 'origin': ORIGIN,
                    'domain': 'grok.com', 'path': '/', 'secure': True,
                    'httpOnly': bool(cookie.get('httpOnly')),
                }],
                'headers': [],
            }],
        }
        packet = {'sessionBundle': session_bundle, 'expectedIdentity': identity, 'ownerBootstrap': owner_bootstrap}
        wire = bytearray(json.dumps(packet, separators=(',', ':')).encode('utf-8'))
        stage = 'normal_cli_readbacks'
        process = await asyncio.create_subprocess_exec(
            NODE, str(NODE_RUNNER), cwd=str(REPO), stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL, env=node_environment())
        stdout, _ = await asyncio.wait_for(process.communicate(bytes(wire)), timeout=360)
        if len(stdout) > MAX_NODE_OUTPUT_BYTES:
            raise SafeFailure('FAST_READ_NODE_OUTPUT_INVALID')
        try:
            summary = json.loads(stdout.decode('utf-8'))
        except Exception as exc:
            raise SafeFailure('FAST_READ_NODE_OUTPUT_INVALID') from exc
        if not isinstance(summary, dict) or summary.get('operationId') != 'conversation.history.fast-task-readback':
            raise SafeFailure('FAST_READ_NODE_OUTPUT_INVALID')
        if process.returncode != 0:
            print(json.dumps(summary, separators=(',', ':')))
            return 1
        print(json.dumps(summary, separators=(',', ':')))
        return 0 if summary.get('status') == 'completed' else 1
    except SafeFailure:
        raise
    except asyncio.TimeoutError as exc:
        raise SafeFailure('FAST_READ_NODE_TIMEOUT') from exc
    except Exception as exc:
        raise SafeFailure(f'FAST_READ_{stage.upper()}_{type(exc).__name__.upper()[:32]}') from exc
    finally:
        if wire is not None:
            wire[:] = b'\0' * len(wire)
        if packet:
            packet['expectedIdentity'] = ''
            packet['sessionBundle'] = None
        if session_bundle:
            for origin in session_bundle.get('origins', []):
                for row in origin.get('cookies', []):
                    row['value'] = ''
        for row in cookies:
            if isinstance(row, dict): row['value'] = ''
        if body_bytes is not None:
            body_bytes[:] = b'\0' * len(body_bytes)
        if isinstance(body, dict):
            session = body.get('session')
            if isinstance(session, dict): session['email'] = ''
        if 'email' in locals():
            email = ''
        identity = ''
        if cdp is not None:
            try:
                await cdp.detach()
            except Exception:
                pass
        await playwright.stop()


async def main():
    cache = read_json(TASK_CACHE, MAX_CACHE_BYTES)
    try:
        if cache.get('serviceId') != 'grok-web' or cache.get('ownerScopeSha256') != OWNER_SHA256 \
                or cache.get('verifiedBy') != 'conversation.read+history.response-nodes+history.load-responses':
            raise SafeFailure('FAST_READ_TASK_CACHE_INVALID')
        port, target_id = verify_runtime()
        await execute_cli_reads(target_id, port)
    finally:
        for key in ('conversationId', 'assistantResponseId', 'expectedPromptSha256', 'assistantTextSha256'):
            cache[key] = ''


if __name__ == '__main__':
    try:
        raise SystemExit(asyncio.run(main()))
    except SafeFailure as exc:
        print(json.dumps({'operationId': 'conversation.history.fast-task-readback',
                          'status': 'needs_review', 'errorCode': exc.code,
                          'rawIdentifiersPersisted': False, 'credentialsPersisted': False}, separators=(',', ':')))
        raise SystemExit(1)
    except Exception as exc:
        print(json.dumps({'operationId': 'conversation.history.fast-task-readback',
                          'status': 'needs_review', 'errorCode': f'FAST_READ_{type(exc).__name__.upper()[:48]}',
                          'rawIdentifiersPersisted': False, 'credentialsPersisted': False}, separators=(',', ':')))
        raise SystemExit(1)
