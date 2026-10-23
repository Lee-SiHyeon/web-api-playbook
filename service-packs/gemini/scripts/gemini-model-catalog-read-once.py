#!/usr/bin/env python3
"""Read the current authenticated Gemini model catalog once over direct HTTP."""

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
MODEL_PAIR_PATH = REPO / 'verification/feature-evidence/model_catalog--model_list--available.json'
OWNER_PAIR_PATH = REPO / 'verification/feature-evidence/identity--identity--model_catalog_owner.json'
MODEL_RECEIPT_PATH = REPO / 'verification/features/model_catalog.json'
ONE_SHOT_PATH = REPO / 'verification/one-shot/gemini-model-catalog-read-current-v4-2026-10-06.json'

sys.path.insert(0, str(SCRIPTS))
from gemini_settings_evidence import (  # noqa: E402
    build_current_model_catalog_records,
    feature_source_snapshot,
    model_list_snapshot,
)

SETTINGS_RUNNER_PATH = SCRIPTS / 'gemini-settings-update-once.py'
SETTINGS_RUNNER_SPEC = importlib.util.spec_from_file_location('gemini_settings_update_once_for_models', SETTINGS_RUNNER_PATH)
SETTINGS_RUNNER = importlib.util.module_from_spec(SETTINGS_RUNNER_SPEC)
SETTINGS_RUNNER_SPEC.loader.exec_module(SETTINGS_RUNNER)


class SafeFailure(Exception):
    def __init__(self, code):
        self.code = code


def read_json(path):
    try:
        return json.loads(pathlib.Path(path).read_text(encoding='utf-8'))
    except Exception as exc:
        raise SafeFailure('MODEL_RUNTIME_METADATA_INVALID') from exc


def hash_bytes(data):
    return hashlib.sha256(data).hexdigest()


def json_bytes(value):
    return (json.dumps(value, ensure_ascii=True, indent=2) + '\n').encode('utf-8')


def write_new_json(path, value):
    path = pathlib.Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    encoded = json_bytes(value)
    try:
        descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    except FileExistsError as exc:
        raise SafeFailure('MODEL_EVIDENCE_ALREADY_EXISTS') from exc
    try:
        with os.fdopen(descriptor, 'wb') as stream:
            stream.write(encoded)
            stream.flush()
            os.fsync(stream.fileno())
    except Exception:
        path.unlink(missing_ok=True)
        raise
    return hash_bytes(encoded)


def archive_existing(paths):
    archived = []
    for path in paths:
        path = pathlib.Path(path)
        if not path.exists():
            continue
        original = path.read_bytes()
        archived_value = json.loads(original.decode('utf-8'))
        backup = REPO / 'verification/one-shot' / (
            f'gemini-model-before-refresh-{path.name}-{hash_bytes(original)[:12]}.json'
        )
        if backup.exists():
            if backup.read_bytes() != original:
                raise SafeFailure('MODEL_EVIDENCE_BACKUP_CONFLICT')
        else:
            encoded = json_bytes(archived_value)
            write_new_json(backup, archived_value)
            if backup.read_bytes() != encoded:
                raise SafeFailure('MODEL_EVIDENCE_BACKUP_VERIFY_FAILED')
        archived.append(str(backup.relative_to(REPO)))
    return archived


def replace_json(path, value):
    path = pathlib.Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + f'.pending-{os.getpid()}')
    encoded = json_bytes(value)
    try:
        descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    except FileExistsError as exc:
        raise SafeFailure('MODEL_EVIDENCE_TEMPFILE_EXISTS') from exc
    try:
        with os.fdopen(descriptor, 'wb') as stream:
            stream.write(encoded)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    except Exception:
        temporary.unlink(missing_ok=True)
        raise
    return hash_bytes(encoded)


def safe_model_result(stdout_text):
    try:
        output = json.loads(stdout_text)
    except Exception as exc:
        raise SafeFailure('MODEL_CLI_OUTPUT_INVALID') from exc
    catalog = output.get('catalog')
    identity = output.get('identity')
    if isinstance(identity, dict):
        identity = {
            **identity,
            'ownerMatched': output.get('ownerMatched') is True,
            'anonymousOwnerAbsent': output.get('anonymousOwnerAbsent') is True,
        }
    result = {
        'operation': output.get('operation'),
        'ownerMatched': output.get('ownerMatched') is True,
        'anonymousOwnerAbsent': output.get('anonymousOwnerAbsent') is True,
        'credentialPropagated': catalog.get('credentialPropagated') is True if isinstance(catalog, dict) else False,
        'httpStatus': catalog.get('httpStatus') if isinstance(catalog, dict) else None,
        'contentType': catalog.get('contentType') if isinstance(catalog, dict) else None,
        'responseBytes': catalog.get('responseBytes') if isinstance(catalog, dict) else None,
        'responseSha256': catalog.get('responseSha256') if isinstance(catalog, dict) else None,
        'rpcId': catalog.get('rpcId') if isinstance(catalog, dict) else None,
        'request': catalog.get('request') if isinstance(catalog, dict) else None,
        'modelCount': catalog.get('modelCount') if isinstance(catalog, dict) else None,
        'identity': identity,
    }
    if (output.get('outcome') != 'verified_read' or result['operation'] != 'model_list' or result['ownerMatched'] is not True
            or result['anonymousOwnerAbsent'] is not True or result['httpStatus'] != 200
            or result['rpcId'] != 'otAQ7b' or result['modelCount'] is None
            or not isinstance(result['identity'], dict)):
        raise SafeFailure('MODEL_CATALOG_READ_UNVERIFIED')
    return result


def run_model_read(session, expected_owner, contract_path, source_before, identity_scope_before):
    node = shutil.which('node')
    if not node:
        raise SafeFailure('NODE_RUNTIME_UNAVAILABLE')
    current_source = model_list_snapshot(REPO, contract_path)
    current_identity_scope = feature_source_snapshot(REPO, 'identity')
    if current_source != source_before or current_identity_scope != identity_scope_before:
        raise SafeFailure('MODEL_SOURCE_PREFLIGHT_FAILED')
    owner_hash_before = hashlib.sha256(expected_owner.strip().casefold().encode('utf-8')).hexdigest()
    packet = {'session': session, 'expectedOwner': expected_owner}
    command = [node, str(REPO / 'scripts/gemini-model-catalog-http-once.mjs')]
    try:
        completed = subprocess.run(
            command,
            input=json.dumps(packet, separators=(',', ':')),
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=120,
            check=False,
        )
    finally:
        for cookie in packet.get('session', {}).get('cookies', []):
            cookie['value'] = ''
        packet['expectedOwner'] = ''
        packet.clear()
    try:
        output = json.loads(completed.stdout)
    except Exception as exc:
        completed.stdout = ''
        completed.stderr = ''
        raise SafeFailure('MODEL_CLI_OUTPUT_INVALID') from exc
    stderr_text = completed.stderr
    owner_hash_after = hashlib.sha256(expected_owner.strip().casefold().encode('utf-8')).hexdigest()
    if completed.returncode != 0:
        code = next((line for line in stderr_text.splitlines()
                     if re.fullmatch(r'[A-Z][A-Z0-9_]{1,63}', line)), 'MODEL_CLI_FAILED')
        completed.stdout = ''
        completed.stderr = ''
        raise SafeFailure(code)
    result = safe_model_result(json.dumps(output, separators=(',', ':')))
    completed.stdout = ''
    completed.stderr = ''
    producer = {
        'sourceBeforeImports': current_source,
        'sourceAfterRun': model_list_snapshot(REPO, contract_path),
        'identitySourceBeforeImports': identity_scope_before,
        'identitySourceAfterRun': feature_source_snapshot(REPO, 'identity'),
        'expectedOwnerSha256': owner_hash_before,
        'expectedOwnerSha256AfterRun': owner_hash_after,
        'expectedOwnerImmutable': owner_hash_before == owner_hash_after == OWNER_SHA256,
    }
    producer['sourceSnapshotStable'] = (
        producer['sourceBeforeImports'] == producer['sourceAfterRun']
        and producer['identitySourceBeforeImports'] == producer['identitySourceAfterRun']
    )
    if not producer['sourceSnapshotStable'] or not producer['expectedOwnerImmutable']:
        raise SafeFailure('MODEL_SOURCE_OR_OWNER_BINDING_FAILED')
    expected_owner = ''
    return result, producer


def write_model_evidence(result, producer, browser_state, expected_owner_sha256, contract_sha256):
    if ONE_SHOT_PATH.exists():
        raise SafeFailure('MODEL_EVIDENCE_ALREADY_EXISTS')
    try:
        records = build_current_model_catalog_records(
            model_result=result,
            source_before=producer['sourceBeforeImports'],
            source_after=producer['sourceAfterRun'],
            identity_scope_before=producer['identitySourceBeforeImports'],
            identity_scope_after=producer['identitySourceAfterRun'],
            owner_sha256_before=producer['expectedOwnerSha256'],
            owner_sha256_after=producer['expectedOwnerSha256AfterRun'],
            expected_owner_sha256=expected_owner_sha256,
            contract_sha256=contract_sha256,
        )
    except (KeyError, TypeError, ValueError) as exc:
        raise SafeFailure('MODEL_EVIDENCE_PREFLIGHT_FAILED') from exc
    receipt = records['receipt']
    archived = archive_existing([OWNER_PAIR_PATH, MODEL_PAIR_PATH, MODEL_RECEIPT_PATH])
    owner_pair_hash = replace_json(OWNER_PAIR_PATH, records['ownerPair'])
    receipt['ownerIdentityEvidence']['sha256'] = owner_pair_hash
    model_pair_hash = replace_json(MODEL_PAIR_PATH, records['modelPair'])
    receipt['operationEvidence'][0]['sha256'] = model_pair_hash
    receipt_hash = replace_json(MODEL_RECEIPT_PATH, receipt)
    one_shot = {
        'schema': 'gemini-model-catalog-read-live-v1',
        'service': 'gemini-web',
        'operation': 'model_list',
        'recordedAt': datetime.now(timezone.utc).isoformat(),
        'executionHost': 'linux_worker',
        'pageRole': SETTINGS_RUNNER.ROLE,
        'ownerProbe': {
            'ownerMatched': result['ownerMatched'],
            'anonymousOwnerAbsent': result['anonymousOwnerAbsent'],
            'expectedOwnerSha256': expected_owner_sha256,
            'expectedOwnerSha256AfterRun': producer['expectedOwnerSha256AfterRun'],
            'expectedOwnerImmutable': producer['expectedOwnerImmutable'],
            'expectedOwnerPersisted': False,
        },
        'sourceBeforeImports': producer['sourceBeforeImports'],
        'sourceAfterRun': producer['sourceAfterRun'],
        'sourceSnapshotStable': producer['sourceSnapshotStable'],
        'identitySourceBeforeImports': producer['identitySourceBeforeImports'],
        'identitySourceAfterRun': producer['identitySourceAfterRun'],
        'httpStatus': result['httpStatus'],
        'contentType': result['contentType'],
        'responseBytes': result['responseBytes'],
        'responseSha256': result['responseSha256'],
        'rpcId': result['rpcId'],
        'request': result['request'],
        'modelCount': result['modelCount'],
        'accountStatusPersisted': False,
        'modelIdsOrNamesPersisted': False,
        'canonicalEvidence': {
            'receiptPath': str(MODEL_RECEIPT_PATH.relative_to(REPO)),
            'receiptSha256': receipt_hash,
            'modelPairPath': str(MODEL_PAIR_PATH.relative_to(REPO)),
            'modelPairSha256': model_pair_hash,
            'identityPairPath': records['ownerPairPath'],
            'identityPairSha256': owner_pair_hash,
            'archivedPriorEvidence': archived,
        },
        'browserCapture': {
            'startupPreferenceWritesAborted': browser_state.get('abortedPreferenceWrites', 0),
            'startupPreferenceAbortAcknowledged': browser_state.get('preferenceAbortAck', 0),
            'browserBusinessWrites': 0,
        },
        'persistence': {
            'expectedOwnerPersisted': False,
            'emailPersisted': False,
            'cookiesPersisted': False,
            'tokensPersisted': False,
            'modelIdsPersisted': False,
            'modelNamesPersisted': False,
            'requestValuesPersisted': False,
            'responseValuesPersisted': False,
            'requestBodiesPersisted': False,
            'responseBodiesPersisted': False,
        },
    }
    one_shot_hash = write_new_json(ONE_SHOT_PATH, one_shot)
    return {
        'status': 'verified',
        'modelReceiptSha256': receipt_hash,
        'modelPairSha256': model_pair_hash,
        'identityPairSha256': owner_pair_hash,
        'oneShotSha256': one_shot_hash,
    }


def main():
    stage = 'receipt_preflight'
    if ONE_SHOT_PATH.exists():
        raise SafeFailure('MODEL_EVIDENCE_ALREADY_EXISTS')
    stage = 'runtime_metadata'
    owner = read_json(OWNER_PATH)
    roles = read_json(ROLE_PATH)
    contract = read_json(CONTRACT_PATH)
    if (contract.get('service') != 'gemini-web'
            or 'model_list' not in contract.get('operations', {})):
        raise SafeFailure('MODEL_CONTRACT_INVALID')
    port, role = SETTINGS_RUNNER.verify_runtime(owner, roles)
    session = None
    cookie_values = {}
    expected_owner = ''
    browser_state = {}
    try:
        stage = 'native_session_capture'
        session, expected_owner, browser_state, cookie_values = SETTINGS_RUNNER.capture_one_shot_session(
            owner, role, contract,
        )
        owner_hash = hashlib.sha256(expected_owner.strip().casefold().encode('utf-8')).hexdigest()
        if owner_hash != OWNER_SHA256:
            raise SafeFailure('EXPECTED_OWNER_NOT_UNIQUE')
        stage = 'source_preflight'
        source_before = model_list_snapshot(REPO, CONTRACT_PATH)
        identity_scope_before = feature_source_snapshot(REPO, 'identity')
        stage = 'direct_model_read'
        result, producer = run_model_read(session, expected_owner, CONTRACT_PATH, source_before, identity_scope_before)
        stage = 'evidence_write'
        evidence = write_model_evidence(result, producer, browser_state, owner_hash, source_before['contractSha256'])
        print(json.dumps({
            'operation': 'model_list',
            'verified': True,
            'ownerMatched': True,
            'anonymousOwnerAbsent': True,
            'httpStatus': result['httpStatus'],
            'responseBytes': result['responseBytes'],
            'responseSha256': result['responseSha256'],
            'rpcId': result['rpcId'],
            'modelCount': result['modelCount'],
            'sourceStable': producer['sourceSnapshotStable'],
            'browserBusinessWrites': 0,
            'canonicalEvidence': evidence,
            'modelNamesOrIdsPersisted': False,
        }, separators=(',', ':')))
    finally:
        if session:
            SETTINGS_RUNNER.wipe_session(session, cookie_values)
        expected_owner = ''


if __name__ == '__main__':
    try:
        main()
    except SafeFailure as error:
        print(error.code)
        raise SystemExit(1)
    except Exception:
        print(f'MODEL_CATALOG_{stage.upper()}_FAILED')
        raise SystemExit(1)
