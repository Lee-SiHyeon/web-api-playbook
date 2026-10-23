#!/usr/bin/env python3
"""Run one bounded owner-scoped Gemini list/search/detail verification over direct HTTP."""

import ast
import hashlib
import importlib.util
import json
import os
import pathlib
import re
import shutil
import subprocess
import sys
from datetime import datetime, timezone


REPO = pathlib.Path(__file__).resolve().parent.parent
SCRIPTS = REPO / 'scripts'
RUNTIME = pathlib.Path.home() / '.nad-scratch/provider-runtime-20261005'
OWNER_PATH = RUNTIME / 'runtime-owner.json'
ROLE_PATH = RUNTIME / 'page-role-registry.json'
CONTRACT_PATH = REPO / 'discovery/observed-contract.json'
ROLE = 'codex-gemini-settings-update-20261006'
OWNER_SHA256 = '23e57131977ce522bacf6649eb27538770828a890f7a65589ec4f0960a84b3d7'
MODEL_PROMPT_PATH = RUNTIME / 'root-gemini-model-choice-validation.py'
TASK_INTENT = 'gemini-flash-lite-current-model-validation-20261006-v1'
SEARCH_QUERY = 'MODELBOUND'
OUTPUT_PATH = REPO / 'verification/one-shot/gemini-history-readonly-current-v3-2026-10-06.json'

sys.path.insert(0, str(SCRIPTS))
SETTINGS_RUNNER_PATH = SCRIPTS / 'gemini-settings-update-once.py'
SETTINGS_RUNNER_SPEC = importlib.util.spec_from_file_location('gemini_settings_update_once', SETTINGS_RUNNER_PATH)
SETTINGS_RUNNER = importlib.util.module_from_spec(SETTINGS_RUNNER_SPEC)
SETTINGS_RUNNER_SPEC.loader.exec_module(SETTINGS_RUNNER)
from gemini_settings_evidence import feature_source_snapshot  # noqa: E402


class SafeFailure(Exception):
    def __init__(self, code):
        self.code = code


def sha256(data):
    return hashlib.sha256(data).hexdigest()


def read_json(path):
    try:
        return json.loads(pathlib.Path(path).read_text(encoding='utf-8'))
    except Exception as exc:
        raise SafeFailure('HISTORY_RUNTIME_METADATA_INVALID') from exc


def prompt_from_source(path):
    try:
        tree = ast.parse(pathlib.Path(path).read_text(encoding='utf-8'))
    except Exception as exc:
        raise SafeFailure('HISTORY_TASK_SOURCE_INVALID') from exc
    for statement in tree.body:
        value = None
        names = []
        if isinstance(statement, ast.Assign):
            names = [target.id for target in statement.targets if isinstance(target, ast.Name)]
            value = statement.value
        elif isinstance(statement, ast.AnnAssign) and isinstance(statement.target, ast.Name):
            names = [statement.target.id]
            value = statement.value
        if 'PROMPT' not in names or value is None:
            continue
        try:
            prompt = ast.literal_eval(value)
        except Exception as exc:
            raise SafeFailure('HISTORY_TASK_SOURCE_INVALID') from exc
        if not isinstance(prompt, str) or not prompt.strip() or len(prompt) > 16_384:
            raise SafeFailure('HISTORY_TASK_SOURCE_INVALID')
        return prompt
    raise SafeFailure('HISTORY_TASK_SOURCE_INVALID')


def source_snapshot():
    try:
        return {
            'history': feature_source_snapshot(REPO, 'history'),
            'identity': feature_source_snapshot(REPO, 'identity'),
        }
    except Exception as exc:
        raise SafeFailure('HISTORY_SOURCE_SCOPE_UNAVAILABLE') from exc


def write_new_json(path, value):
    path = pathlib.Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    encoded = (json.dumps(value, ensure_ascii=True, indent=2) + '\n').encode('utf-8')
    try:
        descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    except FileExistsError as exc:
        raise SafeFailure('HISTORY_RECEIPT_ALREADY_EXISTS') from exc
    try:
        with os.fdopen(descriptor, 'wb') as stream:
            stream.write(encoded)
            stream.flush()
            os.fsync(stream.fileno())
    except Exception:
        path.unlink(missing_ok=True)
        raise
    return sha256(encoded)


def run_verify_history(session, expected_owner, expected_prompt):
    node = shutil.which('node')
    if not node:
        raise SafeFailure('NODE_RUNTIME_UNAVAILABLE')
    packet = {
        'session': session,
        'expectedOwner': expected_owner,
        'query': SEARCH_QUERY,
        'expectedIntent': expected_prompt,
        'preserveExistingIdentityEvidence': True,
    }
    command = [node, str(SCRIPTS / 'verify-history.mjs')]
    try:
        completed = subprocess.run(
            command,
            input=json.dumps(packet, separators=(',', ':')),
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=180,
            check=False,
        )
    finally:
        for cookie in packet.get('session', {}).get('cookies', []):
            cookie['value'] = ''
        packet.clear()
        expected_owner = ''
        expected_prompt = ''
        session = None
    if completed.returncode != 0:
        try:
            result = json.loads(completed.stdout)
        except Exception:
            result = {}
        code = result.get('error')
        if not isinstance(code, str) or not re.fullmatch(r'[A-Z][A-Z0-9_]{1,80}', code):
            code = 'HISTORY_VERIFICATION_FAILED'
        completed.stdout = ''
        completed.stderr = ''
        raise SafeFailure(code)
    try:
        result = json.loads(completed.stdout)
    except Exception as exc:
        raise SafeFailure('HISTORY_VERIFICATION_OUTPUT_INVALID') from exc
    completed.stdout = ''
    completed.stderr = ''
    required = ('listHttpStatus', 'searchHttpStatus', 'detailHttpStatus')
    if (result.get('verified') is not True or result.get('ownerMatched') is not True
            or result.get('anonymousOwnerAbsent') is not True
            or result.get('identityEvidenceFresh') is not True
            or result.get('existingIdentityEvidencePreserved') is not True
            or result.get('codeStableDuringExecution') is not True
            or result.get('uniqueTaskMatchCount') != 1
            or result.get('canonicalReceiptsWritten') != ['history']
            or any(result.get(key) != 200 for key in required)):
        raise SafeFailure('HISTORY_VERIFICATION_UNRESOLVED')
    return result


def history_receipt_summary(result, source_files, prompt_hash, owner_hash, browser_state):
    pair_paths = {
        'history_list': REPO / 'verification/feature-evidence/history--history_list--list.json',
        'history_search': REPO / 'verification/feature-evidence/history--history_search--search.json',
        'history_read': REPO / 'verification/feature-evidence/history--history_read--conversation.json',
    }
    pairs = {}
    for operation, path in pair_paths.items():
        try:
            data = json.loads(path.read_text(encoding='utf-8'))
        except Exception as exc:
            raise SafeFailure('HISTORY_CANONICAL_PAIR_MISSING') from exc
        response = data.get('response', {})
        if (data.get('featureId') != 'history' or data.get('operationId') != operation
                or response.get('status') != 200 or not isinstance(response.get('bytes'), int)
                or not re.fullmatch(r'[a-f0-9]{64}', response.get('bodySha256', ''))):
            raise SafeFailure('HISTORY_CANONICAL_PAIR_INVALID')
        pairs[operation] = {
            'status': response['status'], 'bytes': response['bytes'],
            'bodySha256': response['bodySha256'], 'framing': response.get('framing'),
        }
    return {
        'schema': 'gemini-history-readonly-canonical-v1',
        'service': 'gemini-web',
        'operation': 'history_list_search_detail',
        'recordedAt': datetime.now(timezone.utc).isoformat(),
        'executionHost': 'linux_worker',
        'pageRole': ROLE,
        'ownerProbe': {
            'ownerMatched': True,
            'anonymousOwnerAbsent': True,
            'expectedOwnerSha256': owner_hash,
            'expectedOwnerPersisted': False,
        },
        'search': {
            'querySha256': sha256(SEARCH_QUERY.encode('utf-8')),
            'expectedIntentSha256': prompt_hash,
            'queryPersisted': False,
            'intentPersisted': False,
        },
        'sourceBeforeImports': source_files,
        'sourceStableDuringExecution': result.get('codeStableDuringExecution') is True,
        'listHttpStatus': result.get('listHttpStatus'),
        'searchHttpStatus': result.get('searchHttpStatus'),
        'detailHttpStatus': result.get('detailHttpStatus'),
        'listedConversationCount': result.get('listedConversationCount'),
        'uniqueTaskMatchCount': result.get('uniqueTaskMatchCount'),
        'identityEvidenceFresh': result.get('identityEvidenceFresh') is True,
        'existingIdentityEvidencePreserved': result.get('existingIdentityEvidencePreserved') is True,
        'currentIdentityEvidencePath': result.get('currentIdentityEvidencePath'),
        'priorHistoryEvidenceBackupCount': result.get('priorHistoryEvidenceBackupCount'),
        'responseEvidence': pairs,
        'browserCapture': {
            'startupPreferenceWritesAborted': browser_state.get('abortedPreferenceWrites', 0),
            'startupPreferenceAbortAcknowledged': browser_state.get('preferenceAbortAck', 0),
            'browserBusinessWrites': 0,
        },
        'canonicalReceipts': ['verification/features/history.json'],
        'persistence': {
            'expectedOwnerPersisted': False,
            'emailPersisted': False,
            'cookiesPersisted': False,
            'tokensPersisted': False,
            'queryPersisted': False,
            'intentPersisted': False,
            'conversationIdentifiersPersisted': False,
            'titlesOrMessageContentPersisted': False,
            'requestBodiesPersisted': False,
            'responseBodiesPersisted': False,
        },
    }


def main():
    if OUTPUT_PATH.exists():
        raise SafeFailure('HISTORY_RECEIPT_ALREADY_EXISTS')
    source_before_imports = source_snapshot()
    root_owner = read_json(OWNER_PATH)
    role_registry = read_json(ROLE_PATH)
    contract = read_json(CONTRACT_PATH)
    port, role = SETTINGS_RUNNER.verify_runtime(root_owner, role_registry)
    if role.get('targetId') != role_registry['activePageRoles'][ROLE].get('targetId'):
        raise SafeFailure('HISTORY_PAGE_ROLE_INVALID')
    session = None
    cookie_values = {}
    expected_owner = ''
    expected_prompt = ''
    browser_state = {}
    try:
        session, expected_owner, browser_state, cookie_values = SETTINGS_RUNNER.capture_one_shot_session(
            root_owner, role, contract,
        )
        owner_hash = hashlib.sha256(expected_owner.strip().casefold().encode('utf-8')).hexdigest()
        if owner_hash != OWNER_SHA256:
            raise SafeFailure('EXPECTED_OWNER_NOT_UNIQUE')
        expected_prompt = prompt_from_source(MODEL_PROMPT_PATH)
        prompt_hash = hashlib.sha256(expected_prompt.encode('utf-8')).hexdigest()
        result = run_verify_history(session, expected_owner, expected_prompt)
        source_after_run = source_snapshot()
        if source_before_imports != source_after_run:
            raise SafeFailure('HISTORY_SOURCE_CHANGED_DURING_EXECUTION')
        receipt = history_receipt_summary(result, source_after_run, prompt_hash, owner_hash, browser_state)
        receipt['sourceBeforeImports'] = source_before_imports
        write_new_json(OUTPUT_PATH, receipt)
        print(json.dumps({
            'operation': 'history_list_search_detail',
            'verified': True,
            'ownerMatched': True,
            'anonymousOwnerAbsent': True,
            'listHttpStatus': result['listHttpStatus'],
            'searchHttpStatus': result['searchHttpStatus'],
            'detailHttpStatus': result['detailHttpStatus'],
            'uniqueTaskMatchCount': result['uniqueTaskMatchCount'],
            'codeStableDuringExecution': True,
            'identityEvidenceFresh': True,
            'existingIdentityEvidencePreserved': True,
            'canonicalHistoryReceiptWritten': True,
            'oneShotReceiptPath': str(OUTPUT_PATH.relative_to(REPO)),
            'searchAndPromptPersisted': False,
            'conversationIdentifiersPersisted': False,
            'messageContentPersisted': False,
        }, separators=(',', ':')))
    finally:
        if session:
            for cookie in session.get('cookies', []):
                cookie['value'] = ''
            session['cookies'] = []
            session['headers'] = {}
            session['requestHeaders'] = {}
            session['batchContext'] = {}
        cookie_values.clear()
        expected_owner = ''
        expected_prompt = ''


if __name__ == '__main__':
    try:
        main()
    except SafeFailure as error:
        print(error.code)
        raise SystemExit(1)
    except Exception:
        print('HISTORY_CANONICAL_RUN_FAILED')
        raise SystemExit(1)
