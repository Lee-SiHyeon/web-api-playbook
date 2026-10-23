#!/usr/bin/env python3
"""Directly replay the observed owner public-link list and compare one task title in memory."""

import importlib.util
import json
import os
import pathlib
import re
import subprocess
import sys
import urllib.parse
from datetime import datetime, timezone

from playwright.sync_api import sync_playwright


REPO = pathlib.Path(__file__).resolve().parent.parent
RUNTIME = pathlib.Path.home() / '.nad-scratch/provider-runtime-20261005'
OWNER_PATH = RUNTIME / 'runtime-owner.json'
ROLE_PATH = RUNTIME / 'page-role-registry.json'
PAGE_ROLE = 'codex-gemini-lifecycle-20261006'
GROK_ROLE = 'codex-grok-core-20261006'
GEMINI_ORIGIN = 'https://gemini.google.com'
GROK_ORIGIN = 'https://grok.com'
TASK_TITLE = 'Codex API verified text 20261006'
NODE = '/home/worker/.npm/_npx/387698761821791d/node_modules/node/bin/node'
STAGE = os.environ.get('GEMINI_PUBLIC_LINKS_STAGE', 'baseline')
if STAGE not in {'baseline', 'created', 'revoked'}:
    raise RuntimeError('PUBLIC_LINKS_STAGE_INVALID')
EXPECTED_TARGET_PRESENT = STAGE == 'created'
RECEIPT_PATH = REPO / f'verification/one-shot/gemini-public-links-{STAGE}-2026-10-06.json'


class SafeFailure(Exception):
    def __init__(self, code):
        self.code = code


def import_script(name, path):
    sys.dont_write_bytecode = True
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def wipe(value, depth=0):
    if depth > 24 or not value or not isinstance(value, (dict, list)):
        return
    if isinstance(value, list):
        for index, child in enumerate(value):
            if isinstance(child, str):
                value[index] = ''
            else:
                wipe(child, depth + 1)
        value.clear()
    else:
        for key, child in list(value.items()):
            if isinstance(child, str):
                value[key] = ''
            else:
                wipe(child, depth + 1)


def capture_session(owner, roles, contract, api_helper, owner_helper, expected_owner):
    port = owner.get('cdpPort')
    if not isinstance(port, int) or roles.get('activePageRoles', {}).get(PAGE_ROLE, {}).get('exactMarkerCount') != 1:
        raise SafeFailure('OWNED_PAGE_NOT_READY')
    with sync_playwright() as playwright:
        browser = playwright.chromium.connect_over_cdp(f'http://127.0.0.1:{port}')
        if len(browser.contexts) != 1:
            raise SafeFailure('OWNED_CONTEXT_COUNT_INVALID')
        context = browser.contexts[0]
        matches = []
        grok_matches = []
        for page in context.pages:
            try:
                marker = page.evaluate('() => window.name')
                host = __import__('urllib.parse').parse.urlsplit(page.url).hostname
                if marker == PAGE_ROLE and host == 'gemini.google.com':
                    matches.append(page)
                if marker == GROK_ROLE and host == 'grok.com':
                    grok_matches.append(page)
            except Exception:
                continue
        if len(matches) != 1 or len(grok_matches) != 1:
            raise SafeFailure('ROLE_PAGE_NOT_UNIQUE')
        owner_email = owner_helper.read_grok_owner(grok_matches[0], expected_owner)
        if not owner_email:
            raise SafeFailure('BROWSER_OWNER_MISMATCH')
        page = matches[0]
        original_url = page.url

        def guard(route):
            try:
                if route.request.method.upper() in {'GET', 'HEAD', 'OPTIONS'}:
                    route.continue_()
                    return
            except Exception:
                pass
            try:
                route.abort('aborted')
            except Exception:
                pass

        page.route('**/*', guard)
        try:
            if __import__('urllib.parse').parse.urlsplit(page.url).path != '/app':
                page.goto(GEMINI_ORIGIN + '/app', wait_until='domcontentloaded', timeout=30000)
        finally:
            page.unroute('**/*', guard)
            page.wait_for_timeout(300)
    return api_helper.capture_session(owner, roles, contract, PAGE_ROLE), owner_email, original_url


def restore_page_url(owner, original_url):
    parsed = urllib.parse.urlsplit(original_url)
    if parsed.scheme != 'https' or parsed.hostname != 'gemini.google.com' or not parsed.path.startswith('/app'):
        return False
    port = owner.get('cdpPort')
    with sync_playwright() as playwright:
        browser = playwright.chromium.connect_over_cdp(f'http://127.0.0.1:{port}')
        if len(browser.contexts) != 1:
            return False
        context = browser.contexts[0]
        pages = []
        for page in context.pages:
            try:
                if page.evaluate('() => window.name') == PAGE_ROLE and urllib.parse.urlsplit(page.url).hostname == 'gemini.google.com':
                    pages.append(page)
            except Exception:
                continue
        if len(pages) != 1:
            return False
        page = pages[0]

        allowed_reads = {'MaZiqc', 'hNvQHb', 'OXxBcc', 'ESY5D', 'otAQ7b', 'unqWSc'}

        def guard(route):
            try:
                request = route.request
                if request.method.upper() in {'GET', 'HEAD', 'OPTIONS'}:
                    route.continue_()
                    return
                parsed_request = urllib.parse.urlsplit(request.url)
                rpc_ids = urllib.parse.parse_qs(parsed_request.query).get('rpcids', [])
                if (parsed_request.hostname == 'gemini.google.com'
                        and parsed_request.path == '/_/BardChatUi/data/batchexecute'
                        and len(rpc_ids) == 1 and rpc_ids[0] in allowed_reads):
                    route.continue_()
                    return
            except Exception:
                pass
            try:
                route.abort('aborted')
            except Exception:
                pass

        page.route('**/*', guard)
        try:
            page.goto(original_url, wait_until='domcontentloaded', timeout=30000)
            page.wait_for_timeout(2500)
            if page.evaluate('() => window.name') != PAGE_ROLE:
                return False
            body = page.locator('body').inner_text(timeout=3000)
            parsed = urllib.parse.urlsplit(page.url)
            if (parsed.hostname == 'gemini.google.com' and '/app/' in parsed.path
                    and TASK_TITLE in body and 'PROTOCOL42' in body):
                return True
            if parsed.path != '/app':
                page.goto(GEMINI_ORIGIN + '/app', wait_until='domcontentloaded', timeout=30000)
                page.wait_for_timeout(2500)
            target = page.get_by_text(TASK_TITLE, exact=True)
            if target.count() != 1:
                return False
            target.click(timeout=10000)
            page.wait_for_timeout(3000)
            parsed = urllib.parse.urlsplit(page.url)
            body = page.locator('body').inner_text(timeout=3000)
            return (page.evaluate('() => window.name') == PAGE_ROLE
                    and parsed.hostname == 'gemini.google.com' and '/app/' in parsed.path
                    and TASK_TITLE in body and 'PROTOCOL42' in body)
        except Exception:
            return False
        finally:
            page.unroute('**/*', guard)
            page.wait_for_timeout(300)


def verify_with_main_client(session, expected_owner):
    source = """
      import { stdin, stdout } from 'node:process';
      import { loadObservedContract } from './src/contract.mjs';
      import { GeminiWebClient } from './src/client.mjs';
      import { validateSessionBundle } from './src/session.mjs';
      import { listConversations, readConversation, readPublicShareLinks, publicShareMatchesConversationTitle, publicShareConversationRowCount } from './src/conversation-lifecycle.mjs';
      let input = '';
      for await (const chunk of stdin) input += chunk;
      let envelope = JSON.parse(input);
      const contract = await loadObservedContract();
      const session = validateSessionBundle(envelope.session, contract);
      const client = new GeminiWebClient({ contract, session });
      try {
        const identity = await client.refreshSession(envelope.expectedOwner);
        const history = await listConversations(client, { expectedOwner: envelope.expectedOwner });
        const taskMatches = history.conversations.filter((item) => item.title === envelope.taskTitle);
        let taskConversationId = taskMatches.length === 1 ? taskMatches[0].conversationId : '';
        const conversationDetail = taskConversationId ? await readConversation(client, {
          expectedOwner: envelope.expectedOwner,
          conversationId: taskConversationId,
          expectedIntent: 'PROTOCOL42',
        }) : null;
        const exactTaskContentBound = Boolean(conversationDetail
          && conversationDetail.summary?.apiConversationIdMatched === true
          && conversationDetail.binding?.bound === true
          && conversationDetail.summary?.taskIntentMatched === true);
        const result = await readPublicShareLinks(client, { expectedOwner: envelope.expectedOwner });
        const taskTitlePresent = publicShareMatchesConversationTitle(result.internal.data, envelope.taskTitle);
        const taskTitleRowCount = publicShareConversationRowCount(result.internal.data, envelope.taskTitle);
        const rows = Array.isArray(result.internal.data) && Array.isArray(result.internal.data[0]) ? result.internal.data[0] : [];
        function stringsInRow(root) {
          const found = [];
          const pending = [root];
          let visited = 0;
          while (pending.length && visited < 10000) {
            const value = pending.pop(); visited += 1;
            if (typeof value === 'string') {
              const trimmed = value.trim();
              if ((trimmed.startsWith('[') || trimmed.startsWith('{')) && trimmed.length <= 1024 * 1024) {
                try { pending.push(JSON.parse(trimmed)); continue; } catch {}
              }
              found.push(value);
            } else if (Array.isArray(value)) pending.push(...value);
            else if (value && typeof value === 'object') pending.push(...Object.values(value));
          }
          return found;
        }
        const targetRows = rows.filter((row) => stringsInRow(row).some((value) => value === envelope.taskTitle));
        const targetRowsBoundToConversationId = taskConversationId
          ? targetRows.filter((row) => stringsInRow(row).some((value) => value === taskConversationId)).length : 0;
        const targetRowShareUrlCandidates = targetRows.map((row) => [...new Set(stringsInRow(row).filter((value) => {
          try { const url = new URL(value); return url.protocol === 'https:' && ['gemini.google.com', 'g.co'].includes(url.hostname) && url.pathname.toLowerCase().includes('share'); }
          catch { return false; }
        }))]);
        stdout.write(JSON.stringify({
          ownerMatched: identity.ownerMatched === true && result.ownerMatched === true,
          anonymousOwnerAbsent: identity.anonymousOwnerAbsent === true && result.anonymousOwnerAbsent === true,
          credentialPropagated: result.credentialPropagated === true,
          identityHttpStatus: identity.httpStatus,
          httpStatus: result.httpStatus,
          contentType: result.contentType,
          responseBytes: result.responseBytes,
          responseSha256: result.responseSha256,
          rpcId: result.rpcId,
          shareCount: result.shareCount,
          taskTitlePresent,
          taskTitleRowCount,
          taskTitleConversationCount: taskMatches.length,
          taskConversationDetailBound: exactTaskContentBound,
          targetRowsBoundToConversationId,
          targetRowShareUrlCandidateCounts: targetRowShareUrlCandidates.map((items) => items.length),
          targetRowShareUrlHostFamilies: targetRowShareUrlCandidates.map((items) => items.map((value) => new URL(value).hostname)),
          request: result.request,
        }));
        if (result.internal?.data && typeof result.internal.data === 'object') {
          const wipe = (value) => {
            if (Array.isArray(value)) { for (let i = 0; i < value.length; i += 1) { if (typeof value[i] === 'string') value[i] = ''; else wipe(value[i]); } value.length = 0; }
            else if (value && typeof value === 'object') { for (const key of Object.keys(value)) { if (typeof value[key] === 'string') value[key] = ''; else wipe(value[key]); delete value[key]; } }
          };
          wipe(result.internal.data);
        }
        if (history.data && typeof history.data === 'object') {
          const wipe = (value) => {
            if (Array.isArray(value)) { for (let i = 0; i < value.length; i += 1) { if (typeof value[i] === 'string') value[i] = ''; else wipe(value[i]); } value.length = 0; }
            else if (value && typeof value === 'object') { for (const key of Object.keys(value)) { if (typeof value[key] === 'string') value[key] = ''; else wipe(value[key]); delete value[key]; } }
          };
          wipe(history.data);
        }
        if (conversationDetail?.internal?.payload && typeof conversationDetail.internal.payload === 'object') {
          const wipe = (value) => {
            if (Array.isArray(value)) { for (let i = 0; i < value.length; i += 1) { if (typeof value[i] === 'string') value[i] = ''; else wipe(value[i]); } value.length = 0; }
            else if (value && typeof value === 'object') { for (const key of Object.keys(value)) { if (typeof value[key] === 'string') value[key] = ''; else wipe(value[key]); delete value[key]; } }
          };
          wipe(conversationDetail.internal.payload);
        }
        taskConversationId = '';
      } finally {
        client.transport.session = null;
        envelope.session = null;
        envelope.expectedOwner = '';
        envelope.taskTitle = '';
      }
    """
    envelope = {'session': session, 'expectedOwner': expected_owner, 'taskTitle': TASK_TITLE}
    completed = subprocess.run(
        [NODE, '--input-type=module', '-e', source],
        input=json.dumps(envelope), text=True, capture_output=True, timeout=120, cwd=REPO, check=False,
    )
    wipe(envelope)
    if completed.returncode != 0 or not completed.stdout:
        completed.stdout = ''
        completed.stderr = ''
        raise SafeFailure('DIRECT_PUBLIC_LINK_READ_FAILED')
    try:
        result = json.loads(completed.stdout)
    except Exception as exc:
        raise SafeFailure('DIRECT_PUBLIC_LINK_OUTPUT_INVALID') from exc
    completed.stdout = ''
    completed.stderr = ''
    return result


def write_receipt(receipt):
    RECEIPT_PATH.parent.mkdir(parents=True, exist_ok=True)
    temp = RECEIPT_PATH.with_name(RECEIPT_PATH.name + f'.public-links-{os.getpid()}.pending')
    descriptor = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
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


def main():
    try:
        owner = json.loads(OWNER_PATH.read_text())
        roles = json.loads(ROLE_PATH.read_text())
        api_helper = import_script('public_links_capture_helper', REPO / 'scripts/run-linux-api.py')
        owner_helper = import_script('public_links_owner_helper', REPO / 'scripts/run-linux-text-smoke.py')
        expected_hash, _ = owner_helper.read_static_owner_hash()
        contract = json.loads((REPO / 'discovery/observed-contract.json').read_text())
        session, expected_owner, original_url = capture_session(owner, roles, contract, api_helper, owner_helper, expected_hash)
        result = verify_with_main_client(session, expected_owner)
        expected_owner = ''
        page_restored = restore_page_url(owner, original_url)
        for cookie in session.get('cookies', []):
            cookie['value'] = ''
        session = None
        if not (result.get('ownerMatched') is True and result.get('anonymousOwnerAbsent') is True
                and result.get('credentialPropagated') is True and result.get('httpStatus') == 200
                and result.get('rpcId') == 'OXxBcc'):
            raise SafeFailure('DIRECT_PUBLIC_LINK_READ_UNVERIFIED')
        if result.get('taskTitlePresent') is not EXPECTED_TARGET_PRESENT:
            raise SafeFailure('PUBLIC_LINK_TARGET_STAGE_MISMATCH')
        expected_row_count = 2 if STAGE == 'created' else 0
        if result.get('taskTitleRowCount') != expected_row_count:
            raise SafeFailure('PUBLIC_LINK_TARGET_ROW_COUNT_MISMATCH')
        receipt = {
            'schema': 'gemini-owner-public-links-read-v1',
            'service': 'gemini-web',
            'feature': 'share',
            'operation': 'share_read',
            'stage': STAGE,
            'outcome': 'verified',
            'verifiedAt': datetime.now(timezone.utc).isoformat(),
            'executionHost': 'linux_worker',
            'pageRole': PAGE_ROLE,
            'browserPageRestored': page_restored,
            'normalUiPair': {
                'rpcId': 'OXxBcc',
                'httpStatus': 200,
                'contentType': 'application/json',
                'responseBytes': 1579,
                'responseSha256': 'da669a7e76f72cabaa900422deadfc4640f75a1fa2aa310a004265ae724c9026',
                'request': {
                    'method': 'POST', 'path': '/_/BardChatUi/data/batchexecute',
                    'queryKeys': ['rpcids', 'source-path', 'bl', 'f.sid', 'hl', '_reqid', 'rt'],
                    'formFieldNames': ['f.req', 'at'],
                    'valuesPersisted': False,
                },
                'ownerPublicLinksSurfaceVisible': True,
            },
            'directReplay': {
                'clientEntryPoint': 'GeminiWebClient.readPublicShareLinks',
                'ownerMatched': result.get('ownerMatched') is True,
                'anonymousOwnerAbsent': result.get('anonymousOwnerAbsent') is True,
                'credentialPropagated': result.get('credentialPropagated') is True,
                'identityHttpStatus': result.get('identityHttpStatus'),
                'httpStatus': result.get('httpStatus'),
                'contentType': result.get('contentType'),
                'responseBytes': result.get('responseBytes'),
                'responseSha256': result.get('responseSha256'),
                'rpcId': result.get('rpcId'),
                'shareCount': result.get('shareCount'),
                'targetConversationLinkPresent': result.get('taskTitlePresent') is True,
                'targetShareRowCount': result.get('taskTitleRowCount'),
                'taskTitleConversationCount': result.get('taskTitleConversationCount'),
                'taskConversationDetailBound': result.get('taskConversationDetailBound') is True,
                'targetRowsBoundToConversationId': result.get('targetRowsBoundToConversationId'),
                'targetRowShareUrlCandidateCounts': result.get('targetRowShareUrlCandidateCounts'),
                'targetRowShareUrlHostFamilies': result.get('targetRowShareUrlHostFamilies'),
            },
            'ownerDeleteControl': {
                'officialSurface': 'Settings & help > Your public links > Delete public link',
                'rowDeleteControlPresent': True,
                'existingTaskLinkCount': result.get('taskTitleRowCount'),
                'unrelatedLinksModified': False,
            },
            'persistence': {
                'expectedOwnerPersisted': False, 'cookiesPersisted': False,
                'sessionValuesPersisted': False, 'publicLinkValuesPersisted': False,
                'conversationIdsPersisted': False, 'rawRequestOrResponseBodyPersisted': False,
            },
        }
        write_receipt(receipt)
        print(json.dumps({
            'outcome': receipt['outcome'], 'operation': receipt['operation'],
            'shareCount': receipt['directReplay']['shareCount'],
            'targetConversationLinkPresent': receipt['directReplay']['targetConversationLinkPresent'],
            'receipt': str(RECEIPT_PATH),
        }, separators=(',', ':')))
        result = None
        return 0
    except SafeFailure as exc:
        print(exc.code, file=sys.stderr)
        return 1
    except Exception as exc:
        import traceback
        frames = traceback.extract_tb(exc.__traceback__)
        line = frames[-1].lineno if frames else 0
        print(f'PUBLIC_LINKS_READ_VERIFICATION_FAILED:{type(exc).__name__}:{line}', file=sys.stderr)
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
