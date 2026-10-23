#!/usr/bin/env python3
import hashlib
import json
import os
import subprocess
import uuid
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlsplit

from playwright.sync_api import sync_playwright


ROOT = Path('/home/worker/work/provider-login-20261004/grok-web-xhr-client')
OWNER_FILE = Path('/home/worker/.nad-scratch/provider-runtime-20261005/runtime-owner.json')
ROLES_FILE = Path('/home/worker/.nad-scratch/provider-runtime-20261005/page-role-registry.json')
ROLE = 'codex-grok-core-20261006'
ORIGIN = 'https://grok.com'
EXPECTED_EMAIL_SHA256 = '23e57131977ce522bacf6649eb27538770828a890f7a65589ec4f0960a84b3d7'
NODE = '/home/worker/.npm/_npx/387698761821791d/node_modules/node/bin/node'
HTTP_PYTHON = '/home/worker/work/web-api-playbook-inpock-20261004/.venv-oliveyoung/bin/python'
RUNNER = ROOT / 'scripts/verify-conversations.mjs'
TMP = '/home/worker/.nad-scratch/tmp'


def safe_state(name):
    return {'state': name}


def main():
    owner = json.loads(OWNER_FILE.read_text(encoding='utf-8'))
    role = json.loads(ROLES_FILE.read_text(encoding='utf-8')).get('activePageRoles', {}).get(ROLE, {})
    chrome_pid = int(owner['chromePid'])
    supervisor_pid = int(owner['supervisorPid'])
    profile = str(Path(owner['profile']).resolve())
    command_line = []
    if Path(f'/proc/{chrome_pid}').exists():
        command_line = Path(f'/proc/{chrome_pid}/cmdline').read_bytes().decode(errors='ignore').split('\0')
    if owner.get('taskOwned') is not True or role.get('origin') != ORIGIN or role.get('exactMarkerCount') != 1:
        return safe_state('owned_core_page_precheck_failed')
    if not command_line or not Path(f'/proc/{supervisor_pid}').exists() or f'--user-data-dir={profile}' not in command_line:
        return safe_state('owned_chrome_process_precheck_failed')

    with sync_playwright() as playwright:
        browser = playwright.chromium.connect_over_cdp(f"http://127.0.0.1:{int(owner['cdpPort'])}")
        role_pages = []
        for context in browser.contexts:
            for page in context.pages:
                try:
                    if urlsplit(page.url).hostname == 'grok.com' and page.evaluate('() => window.name') == ROLE:
                        role_pages.append(page)
                except Exception:
                    pass
        if len(role_pages) != 1:
            return safe_state('core_page_role_not_unique')
        page = role_pages[0]
        context = page.context
        identity = page.evaluate("""async () => {
          const response = await fetch('/api/auth/session', { method: 'GET', credentials: 'same-origin', redirect: 'error' });
          return response.ok ? await response.json() : null;
        }""")
        email = identity.get('session', {}).get('email') if isinstance(identity, dict) else None
        if not isinstance(email, str) or hashlib.sha256(email.strip().casefold().encode()).hexdigest() != EXPECTED_EMAIL_SHA256:
            return safe_state('browser_owner_mismatch')
        scoped_cookies = [cookie for cookie in context.cookies([ORIGIN])
                          if cookie.get('name') == 'sso'
                          and str(cookie.get('domain', '')).lstrip('.').lower() == 'grok.com'
                          and isinstance(cookie.get('value'), str) and cookie.get('value')]
        if len(scoped_cookies) != 1:
            return safe_state('scoped_sso_not_unique')
        cookie = scoped_cookies[0]
        session_bundle = {
            'schemaVersion': 1,
            'serviceId': 'grok-web',
            'origin': ORIGIN,
            'capturedAt': datetime.now(timezone.utc).isoformat(),
            'sourceObservationId': f'linux-native-chrome-conversation-read-{uuid.uuid4()}',
            'origins': [{
                'origin': ORIGIN,
                'cookies': [{
                    'name': 'sso',
                    'value': cookie['value'],
                    'domain': 'grok.com',
                    'path': cookie.get('path') or '/',
                    'secure': bool(cookie.get('secure')),
                    'httpOnly': bool(cookie.get('httpOnly')),
                    'expiresAt': datetime.fromtimestamp(cookie['expires'], timezone.utc).isoformat()
                    if isinstance(cookie.get('expires'), (int, float)) and cookie['expires'] > 0 else None,
                }],
                'headers': [],
            }],
        }
        packet = {'sessionBundle': session_bundle, 'expectedIdentity': email}
        packet_bytes = bytearray(json.dumps(packet, separators=(',', ':')).encode('utf-8'))
        env = {key: os.environ[key] for key in (
            'PATH', 'HOME', 'LANG', 'LC_ALL', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'REQUESTS_CA_BUNDLE'
        ) if key in os.environ}
        env.update({
            'TMPDIR': TMP,
            'PYTHONDONTWRITEBYTECODE': '1',
            'GROK_CHROME_PYTHON': HTTP_PYTHON,
        })
        try:
            child = subprocess.run(
                [NODE, str(RUNNER)], input=bytes(packet_bytes), stdout=subprocess.PIPE,
                stderr=subprocess.DEVNULL, env=env, cwd=ROOT, timeout=180, check=False,
            )
        finally:
            packet_bytes[:] = b'\0' * len(packet_bytes)
            session_bundle.clear()
            packet.clear()
            cookie.clear()
            scoped_cookies.clear()
            identity = None
            email = None
        try:
            output = json.loads(child.stdout.decode('utf-8'))
            if isinstance(output, dict):
                return output
        except Exception:
            pass
        return {'state': 'direct_read_output_unreadable', 'returnCode': child.returncode}


if __name__ == '__main__':
    try:
        print(json.dumps(main(), separators=(',', ':')))
    except Exception as error:
        print(json.dumps({'state': 'conversation_read_runner_failed', 'errorClass': type(error).__name__}, separators=(',', ':')))
        raise SystemExit(2)
