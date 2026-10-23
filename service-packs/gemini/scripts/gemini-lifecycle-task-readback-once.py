#!/usr/bin/env python3
"""Resolve and source-read only the newly dispatched lifecycle fixture task."""

import ast
import hashlib
import importlib.util
import json
import os
import pathlib
import shutil
import subprocess
import sys
from datetime import datetime, timedelta


REPO = pathlib.Path(__file__).resolve().parent.parent
RUNTIME = pathlib.Path.home() / '.nad-scratch/provider-runtime-20261005'
OWNER_PATH = RUNTIME / 'runtime-owner.json'
ROLE_PATH = RUNTIME / 'page-role-registry.json'
EXPECTED_OWNER_SHA256 = '23e57131977ce522bacf6649eb27538770828a890f7a65589ec4f0960a84b3d7'
FIXTURE_INTENT = 'gemini-lifecycle-fixture-20261006-v1'
TEXT_RECEIPT = REPO / 'verification/one-shot/gemini-lifecycle-fixture-text-2026-10-06.json'
OUTPUT_PATH = REPO / 'verification/one-shot/gemini-lifecycle-fixture-task-readback-2026-10-06.json'
TEXT_SCRIPT = REPO / 'scripts/run-linux-text-smoke.py'
TASK_SCRIPT = REPO / 'scripts/gemini-lifecycle-fixture-once.py'
TASK_READER = REPO / 'scripts/gemini-lifecycle-task-detail-once.mjs'

sys.path.insert(0, str(REPO / 'scripts'))
SETTINGS_PATH = REPO / 'scripts/gemini-settings-update-once.py'
SETTINGS_SPEC = importlib.util.spec_from_file_location('lifecycle_task_settings_helper', SETTINGS_PATH)
SETTINGS = importlib.util.module_from_spec(SETTINGS_SPEC)
SETTINGS_SPEC.loader.exec_module(SETTINGS)
from gemini_settings_evidence import feature_source_snapshot  # noqa: E402


class SafeFailure(Exception):
    def __init__(self, code):
        self.code = code


def read_json(path):
    try:
        return json.loads(pathlib.Path(path).read_text(encoding='utf-8'))
    except Exception as exc:
        raise SafeFailure('LIFECYCLE_TASK_METADATA_INVALID') from exc


def prompt_from_source(path):
    try:
        tree = ast.parse(pathlib.Path(path).read_text(encoding='utf-8'))
    except Exception as exc:
        raise SafeFailure('LIFECYCLE_TASK_PROMPT_SOURCE_INVALID') from exc
    for statement in tree.body:
        names = []
        value = None
        if isinstance(statement, ast.Assign):
            names = [target.id for target in statement.targets if isinstance(target, ast.Name)]
            value = statement.value
        elif isinstance(statement, ast.AnnAssign) and isinstance(statement.target, ast.Name):
            names = [statement.target.id]
            value = statement.value
        if 'PROMPT' in names and value is not None:
            try:
                prompt = ast.literal_eval(value)
            except Exception as exc:
                raise SafeFailure('LIFECYCLE_TASK_PROMPT_SOURCE_INVALID') from exc
            if isinstance(prompt, str) and prompt.strip() and len(prompt) <= 8000 and '\0' not in prompt:
                return prompt
    raise SafeFailure('LIFECYCLE_TASK_PROMPT_SOURCE_INVALID')


def one_intent_job(actor):
    canonical = json.dumps(['gemini-web', 'text', actor.strip().lower(), FIXTURE_INTENT], separators=(',', ':'))
    intent_hash = hashlib.sha256(canonical.encode('utf-8')).hexdigest()
    jobs_root = pathlib.Path.home() / '.config/gemini-web-xhr-client/jobs'
    matches = []
    if jobs_root.exists():
        for path in jobs_root.glob('*.json'):
            try:
                job = json.loads(path.read_text(encoding='utf-8'))
            except Exception:
                continue
            if job.get('capability') == 'text' and job.get('version') == 2 and job.get('intentKeyHash') == intent_hash:
                matches.append(job)
    if len(matches) != 1:
        raise SafeFailure('LIFECYCLE_FIXTURE_INTENT_NOT_UNIQUE')
    job = matches[0]
    if job.get('dispatchCount') != 1 or job.get('state') != 'reconciled':
        raise SafeFailure('LIFECYCLE_FIXTURE_WRITE_NOT_RECONCILED')
    created = job.get('createdAt')
    response = job.get('responseReceivedAt') or job.get('updatedAt')
    if not isinstance(created, str) or not isinstance(response, str):
        raise SafeFailure('LIFECYCLE_FIXTURE_TIME_WINDOW_MISSING')
    return job, datetime.fromisoformat(created.replace('Z', '+00:00')), datetime.fromisoformat(response.replace('Z', '+00:00'))


def node_read(session, expected_owner, expected_prompt, start, end, prior_response_id_matched):
    node = shutil.which('node')
    if not node:
        raise SafeFailure('NODE_RUNTIME_UNAVAILABLE')
    packet = {
        'session': session,
        'expectedOwner': expected_owner,
        'expectedPrompt': expected_prompt,
        'windowStart': start.isoformat(),
        'windowEnd': end.isoformat(),
        'priorResponseIdMatched': prior_response_id_matched,
    }
    raw = bytearray(json.dumps(packet, separators=(',', ':')).encode('utf-8'))
    try:
        completed = subprocess.run(
            [node, str(TASK_READER)], input=raw, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            timeout=180, check=False,
            env={key: value for key, value in os.environ.items()
                 if key in {'PATH', 'HOME', 'LANG', 'LC_ALL', 'TMPDIR', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'REQUESTS_CA_BUNDLE'}},
        )
    finally:
        raw[:] = b'\0' * len(raw)
        for cookie in session.get('cookies', []):
            cookie['value'] = ''
    try:
        result = json.loads(completed.stdout.decode('utf-8'))
    except Exception as exc:
        raise SafeFailure('LIFECYCLE_TASK_READBACK_OUTPUT_INVALID') from exc
    if completed.returncode != 0 or result.get('operation') != 'lifecycle_fixture_task_readback':
        raise SafeFailure(result.get('error') if isinstance(result.get('error'), str) else 'LIFECYCLE_TASK_READBACK_FAILED')
    if (result.get('ownerMatched') is not True or result.get('anonymousOwnerAbsent') is not True
            or result.get('windowCandidateCount') != 1 or result.get('detailHttpStatus') != 200
            or result.get('taskPromptMatched') is not True or result.get('apiConversationIdEchoMatched') is not True
            or result.get('routeBindingVerified') is not True or result.get('sourceTurnMatched') is not True
            or result.get('priorDirectResponseIdMatched') is not True):
        raise SafeFailure('LIFECYCLE_TASK_EXACT_HNV_BINDING_FAILED')
    return result


def write_new_json(path, value):
    path = pathlib.Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    encoded = (json.dumps(value, ensure_ascii=True, indent=2) + '\n').encode('utf-8')
    try:
        descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    except FileExistsError as exc:
        raise SafeFailure('LIFECYCLE_TASK_RECEIPT_ALREADY_EXISTS') from exc
    with os.fdopen(descriptor, 'wb') as stream:
        stream.write(encoded)
        stream.flush()
        os.fsync(stream.fileno())
    return hashlib.sha256(encoded).hexdigest()


def main():
    if OUTPUT_PATH.exists():
        raise SafeFailure('LIFECYCLE_TASK_RECEIPT_ALREADY_EXISTS')
    text_receipt = read_json(TEXT_RECEIPT)
    if (text_receipt.get('taskIntent') != FIXTURE_INTENT or text_receipt.get('directDispatch', {}).get('count') != 1
            or text_receipt.get('directDispatch', {}).get('httpStatus') != 200):
        raise SafeFailure('LIFECYCLE_FIXTURE_TEXT_RECEIPT_INVALID')
    prior_response_id_matched = text_receipt.get('readback', {}).get('responseIdMatched') is True
    if not prior_response_id_matched:
        raise SafeFailure('LIFECYCLE_FIXTURE_WRITER_RESPONSE_ID_UNBOUND')
    expected_prompt = prompt_from_source(TASK_SCRIPT)
    owner = read_json(OWNER_PATH)
    roles = read_json(ROLE_PATH)
    _, role = SETTINGS.verify_runtime(owner, roles)
    session = None
    cookie_values = {}
    expected_owner = ''
    try:
        session, expected_owner, _, cookie_values = SETTINGS.capture_one_shot_session(owner, role, read_json(REPO / 'discovery/observed-contract.json'))
        owner_hash = hashlib.sha256(expected_owner.strip().casefold().encode('utf-8')).hexdigest()
        if owner_hash != EXPECTED_OWNER_SHA256:
            raise SafeFailure('EXPECTED_OWNER_NOT_UNIQUE')
        job, created, response = one_intent_job(expected_owner)
        start = created - timedelta(seconds=30)
        end = response + timedelta(seconds=60)
        snapshot_before = {'history': feature_source_snapshot(REPO, 'history'), 'identity': feature_source_snapshot(REPO, 'identity')}
        result = node_read(session, expected_owner, expected_prompt, start, end, prior_response_id_matched)
        session = None
        snapshot_after = {'history': feature_source_snapshot(REPO, 'history'), 'identity': feature_source_snapshot(REPO, 'identity')}
        if snapshot_before != snapshot_after:
            raise SafeFailure('LIFECYCLE_TASK_READBACK_SOURCE_CHANGED')
        receipt = {
            'schema': 'gemini-lifecycle-fixture-task-readback-v1',
            'service': 'gemini-web',
            'operation': 'history_read',
            'recordedAt': datetime.now().astimezone().isoformat(),
            'pageRole': 'codex-gemini-lifecycle-canonical-20261006',
            'ownerMatched': True,
            'anonymousOwnerAbsent': True,
            'ownerSha256': owner_hash,
            'intent': FIXTURE_INTENT,
            'intentSha256': hashlib.sha256(FIXTURE_INTENT.encode('utf-8')).hexdigest(),
            'promptSha256': hashlib.sha256(expected_prompt.encode('utf-8')).hexdigest(),
            'dispatchWindow': {'start': start.isoformat(), 'end': end.isoformat()},
            'responseIdMatchedByOriginalOneShot': prior_response_id_matched,
            'sourceBeforeRun': snapshot_before,
            'sourceStableDuringRun': True,
            'readback': result,
            'rawPromptPersisted': False,
            'conversationIdPersisted': False,
            'titlePersisted': False,
            'messageContentPersisted': False,
            'cookiesPersisted': False,
            'responseBodyPersisted': False,
        }
        digest = write_new_json(OUTPUT_PATH, receipt)
        print(json.dumps({'operation': 'history_read', 'verified': result.get('taskBound') is True,
                          'ownerMatched': True, 'candidateCount': 1, 'httpStatus': result.get('detailHttpStatus'),
                          'taskPromptMatched': result.get('taskPromptMatched'),
                          'routeBindingVerified': result.get('routeBindingVerified'),
                          'sourceTurnMatched': result.get('sourceTurnMatched'),
                          'structuredSourceShapeComplete': result.get('structuredSourceShapeComplete'),
                          'assistantMarkerMatched': result.get('assistantMarkerMatched'),
                          'receiptSha256': digest, 'rawValuesPersisted': False}, separators=(',', ':')))
    finally:
        expected_owner = ''
        SETTINGS.wipe_session(session, cookie_values) if session else None


if __name__ == '__main__':
    try:
        main()
    except SafeFailure as error:
        print(json.dumps({'operation': 'history_read', 'verified': False, 'error': error.code,
                          'rawValuesPersisted': False}, separators=(',', ':')))
        raise SystemExit(1)
    except Exception:
        print(json.dumps({'operation': 'history_read', 'verified': False,
                          'error': 'LIFECYCLE_TASK_READBACK_FAILED', 'rawValuesPersisted': False}, separators=(',', ':')))
        raise SystemExit(1)
