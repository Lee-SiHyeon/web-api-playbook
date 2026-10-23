"""Build settings feature receipts from one already-verified direct HTTP run."""

import hashlib
import json
import pathlib
import re
import shutil
import subprocess
from datetime import datetime, timezone


IDENTITY_IMPLEMENTATION_FILES = (
    'src/client.mjs',
    'src/constants.mjs',
    'src/contract.mjs',
    'src/http-session-bootstrap.mjs',
    'src/http-transport.mjs',
    'src/https-transport.mjs',
    'src/session.mjs',
)

MODEL_LIST_IMPLEMENTATION_FILES = (
    'src/batch-response.mjs',
    'src/cli.mjs',
    'src/client.mjs',
    'src/constants.mjs',
    'src/contract.mjs',
    'src/conversation-lifecycle.mjs',
    'src/http-session-bootstrap.mjs',
    'src/http-transport.mjs',
    'src/https-transport.mjs',
    'src/rpc-adapters.mjs',
    'src/session.mjs',
)

SETTINGS_IMPLEMENTATION_FILES = (
    'src/batch-response.mjs',
    'src/cli.mjs',
    'src/client.mjs',
    'src/constants.mjs',
    'src/contract.mjs',
    'src/conversation-lifecycle.mjs',
    'src/http-session-bootstrap.mjs',
    'src/http-transport.mjs',
    'src/https-transport.mjs',
    'src/journal.mjs',
    'src/mutation.mjs',
    'src/rpc-adapters.mjs',
    'src/session.mjs',
    'src/settings-update.mjs',
)

LOGIN_BOOTSTRAP_IMPLEMENTATION_FILES = (
    'scripts/gemini-settings-update-once.py',
    'src/constants.mjs',
    'src/contract.mjs',
    'src/cli.mjs',
    'src/client.mjs',
    'src/http-session-bootstrap.mjs',
    'src/http-transport.mjs',
    'src/https-transport.mjs',
    'src/session.mjs',
)

SHA256 = re.compile(r'^[a-f0-9]{64}$')
CORRELATION = re.compile(r'^[A-Za-z0-9_-]{12,100}$')


def _sha256(data):
    return hashlib.sha256(data).hexdigest()


def implementation_snapshot(repo, contract_path):
    repo = pathlib.Path(repo).resolve()
    contract_path = pathlib.Path(contract_path).resolve()
    expected_contract_path = (repo / 'discovery/observed-contract.json').resolve()
    if contract_path != expected_contract_path:
        raise ValueError('settings evidence requires the installed observed contract')
    contract_bytes = contract_path.read_bytes()
    implementation_files = []
    for relative in SETTINGS_IMPLEMENTATION_FILES:
        digest = _sha256((repo / relative).read_bytes())
        implementation_files.append({'path': relative, 'sha256': digest})
    canonical = json.dumps(implementation_files, sort_keys=True, separators=(',', ':'), ensure_ascii=True)
    return {
        'contractSha256': _sha256(contract_bytes),
        'implementationFiles': implementation_files,
        'implementationSetSha256': _sha256(canonical.encode('utf-8')),
    }


def identity_snapshot(repo, contract_path):
    repo = pathlib.Path(repo).resolve()
    contract_path = pathlib.Path(contract_path).resolve()
    expected_contract_path = (repo / 'discovery/observed-contract.json').resolve()
    if contract_path != expected_contract_path:
        raise ValueError('settings evidence requires the installed observed contract')
    implementation_files = [
        {'path': relative, 'sha256': _sha256((repo / relative).read_bytes())}
        for relative in IDENTITY_IMPLEMENTATION_FILES
    ]
    canonical = json.dumps(implementation_files, sort_keys=True, separators=(',', ':'), ensure_ascii=True)
    return {
        'contractSha256': _sha256(contract_path.read_bytes()),
        'implementationFiles': implementation_files,
        'implementationSetSha256': _sha256(canonical.encode('utf-8')),
    }


def model_list_snapshot(repo, contract_path):
    repo = pathlib.Path(repo).resolve()
    contract_path = pathlib.Path(contract_path).resolve()
    expected_contract_path = (repo / 'discovery/observed-contract.json').resolve()
    if contract_path != expected_contract_path:
        raise ValueError('model catalog evidence requires the installed observed contract')
    source_scope = feature_source_snapshot(repo, 'model_catalog')
    return {
        'contractSha256': _sha256(contract_path.read_bytes()),
        'implementationFiles': source_scope['implementationUnits'],
        'implementationSetSha256': source_scope['implementationScopeSha256'],
        'sourceScope': source_scope,
    }


def feature_source_snapshot(repo, feature_id):
    repo = pathlib.Path(repo).resolve()
    node = shutil.which('node')
    if not node:
        raise ValueError('Node is required to compute the feature handler closure')
    completed = subprocess.run(
        [node, str(repo / 'scripts/source-scope-snapshot.mjs'), feature_id],
        stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, timeout=30, check=False,
    )
    try:
        source_scope = json.loads(completed.stdout)
    except Exception as exc:
        completed.stdout = ''
        completed.stderr = ''
        raise ValueError('feature source scope could not be parsed') from exc
    completed.stdout = ''
    if completed.returncode != 0 or source_scope.get('featureId') != feature_id:
        completed.stderr = ''
        raise ValueError('feature source scope could not be computed')
    completed.stderr = ''
    return source_scope


def login_bootstrap_snapshot(repo):
    repo = pathlib.Path(repo).resolve()
    implementation_files = [
        {'path': relative, 'sha256': _sha256((repo / relative).read_bytes())}
        for relative in LOGIN_BOOTSTRAP_IMPLEMENTATION_FILES
    ]
    implementation_files.sort(key=lambda item: item['path'])
    canonical = json.dumps(implementation_files, separators=(',', ':'), ensure_ascii=True)
    return {
        'implementationFiles': implementation_files,
        'implementationSetSha256': _sha256(canonical.encode('utf-8')),
    }


def _request_metadata(request, correlation_id=None):
    if not isinstance(request, dict):
        raise ValueError('captured request metadata is missing')
    required = ('method', 'origin', 'path', 'queryKeys', 'headerNames', 'valuesPersisted')
    if any(key not in request for key in required):
        raise ValueError('captured request metadata is incomplete')
    if request['valuesPersisted'] is not False:
        raise ValueError('request values must not be persisted')
    result = {key: request[key] for key in required}
    body_fields = request.get('formFieldNames')
    if body_fields is not None:
        result['bodyFieldNames'] = body_fields
    if request.get('contentType') is not None:
        result['contentType'] = request['contentType']
    if request.get('rpcId') is not None:
        result['rpcId'] = request['rpcId']
    for key in ('preferenceFieldIds', 'preferenceArrayIndex', 'preferenceVectorLength'):
        if key in request:
            result[key] = request[key]
    if correlation_id is not None:
        if not isinstance(correlation_id, str) or not CORRELATION.fullmatch(correlation_id):
            raise ValueError('settings correlation id is invalid')
        result['correlationId'] = correlation_id
    return result


def _response_metadata(source, framing):
    if not isinstance(source, dict):
        raise ValueError('captured response metadata is missing')
    status = source.get('httpStatus')
    content_type = source.get('contentType')
    byte_count = source.get('responseBytes')
    digest = source.get('responseSha256')
    if not isinstance(status, int) or not 200 <= status < 300:
        raise ValueError('captured response status is not successful')
    if not isinstance(content_type, str) or not content_type:
        raise ValueError('captured response MIME type is missing')
    if not isinstance(byte_count, int) or byte_count < 1 or not isinstance(digest, str) or not SHA256.fullmatch(digest):
        raise ValueError('captured response byte count or digest is invalid')
    return {'status': status, 'contentType': content_type, 'bytes': byte_count, 'bodySha256': digest, 'framing': framing}


def pair_record(*, feature_id, operation_id, case_id, contract_hash, client_code_hash,
                request, response, expected_outcome=True, identity_match=False,
                credential_propagated=True, correlation_id=None,
                readback_of_operation=None, readback_of_case_id=None, rpc_id=None):
    request_metadata = _request_metadata(request, correlation_id)
    if rpc_id is not None:
        request_metadata['rpcId'] = rpc_id
    if response.get('requestResponsePaired') is False:
        raise ValueError('a paired request and response are required')
    record = {
        'schema': 'gemini-feature-pair-evidence-v1',
        'service': 'gemini-web',
        'featureId': feature_id,
        'operationId': operation_id,
        'caseId': case_id,
        'contractSha256': contract_hash,
        'clientCodeSha256': client_code_hash,
        'observedAt': datetime.now(timezone.utc).isoformat(),
        'executionHost': 'linux_worker',
        'transport': 'direct_http',
        'evidenceClass': 'direct_http_live',
        'mocked': False,
        'publicOnly': False,
        'requestResponsePaired': True,
        'authenticatedOwnerVerified': True,
        'expectedOutcomeVerified': expected_outcome is True,
        'credentialPropagated': credential_propagated is True,
        'request': request_metadata,
        'response': _response_metadata(response, 'text' if operation_id == 'identity' else 'batchexecute'),
        'secretsPersisted': False,
    }
    if identity_match:
        record['identityMatchVerified'] = True
    if readback_of_operation is not None:
        record['readbackOfOperation'] = readback_of_operation
        record['readbackOfCaseId'] = readback_of_case_id
    return record


def build_current_settings_records(*, run, source_before_imports, source_after_run,
                                   identity_before_imports, expected_owner_sha256,
                                   expected_owner_immutable, browser_writes):
    if source_before_imports != source_after_run:
        raise ValueError('source changed during the direct settings run')
    if identity_before_imports.get('contractSha256') != source_before_imports.get('contractSha256'):
        raise ValueError('identity and settings evidence used different installed contracts')
    if expected_owner_immutable is not True or not SHA256.fullmatch(expected_owner_sha256 or ''):
        raise ValueError('expected owner was not held immutable during the run')
    if run.get('operation') != 'settings_update' or run.get('outputStatus') != 'verified_and_restored':
        raise ValueError('settings test did not complete and restore its baseline')
    if run.get('ownerMatched') is not True or run.get('anonymousOwnerAbsent') is not True:
        raise ValueError('direct settings run did not pass both owner checks')
    if browser_writes != 0:
        raise ValueError('browser business writes were observed')
    correlation_id = run.get('callerIntentCorrelationId')
    if not isinstance(correlation_id, str) or not CORRELATION.fullmatch(correlation_id):
        raise ValueError('settings test caller intent is not a safe correlation id')
    before = run.get('baselineRead')
    applied = run.get('apply')
    restored = run.get('restore')
    if (run.get('baselineValue') is not True or run.get('testValue') is not False
            or run.get('restoredToBaseline') is not True or run.get('writesSent') != 2
            or run.get('automaticRetry') is not False
            or not isinstance(before, dict) or before.get('value') is not True
            or before.get('found') is not True or before.get('valueType') != 'boolean'
            or before.get('rpcId') != 'ESY5D'
            or applied.get('readbackValue') is not False or applied.get('readbackMatched') is not True
            or restored.get('readbackValue') is not True or restored.get('readbackMatched') is not True
            or applied.get('responseRpcMatched') is not True or restored.get('responseRpcMatched') is not True
            or applied.get('dispatchCount') != 1 or restored.get('dispatchCount') != 1
            or applied.get('journalState') != 'reconciled' or restored.get('journalState') != 'reconciled'
            or applied.get('readbackRpcId') != 'ESY5D' or restored.get('readbackRpcId') != 'ESY5D'):
        raise ValueError('the direct false readback and true restoration are not both verified')
    if applied.get('readbackHttpStatus') != 200 or not SHA256.fullmatch(applied.get('readbackResponseSha256') or ''):
        raise ValueError('the immediate false readback response digest is missing')
    if (before.get('httpStatus') != 200 or before.get('contentType') != 'application/json'
            or applied.get('httpStatus') != 200 or applied.get('contentType') != 'application/json'
            or not SHA256.fullmatch(applied.get('responseSha256') or '')
            or applied.get('readbackContentType') != 'application/json'
            or restored.get('httpStatus') != 200 or restored.get('contentType') != 'application/json'
            or not SHA256.fullmatch(restored.get('responseSha256') or '')
            or restored.get('readbackHttpStatus') != 200
            or restored.get('readbackContentType') != 'application/json'
            or not SHA256.fullmatch(restored.get('readbackResponseSha256') or '')):
        raise ValueError('one or more direct HTTP preference responses are incomplete')
    requests = [before.get('request'), applied.get('request'), applied.get('readbackRequest'),
                restored.get('request'), restored.get('readbackRequest')]
    if (any(not isinstance(request, dict) for request in requests)
            or before['request'].get('preferenceFieldIds') != [41]
            or applied['request'].get('rpcId') != 'L5adhe'
            or applied['request'].get('preferenceFieldIds') != [41]
            or applied['request'].get('preferenceArrayIndex') != 40
            or applied['request'].get('preferenceVectorLength') != 41
            or applied['readbackRequest'].get('preferenceFieldIds') != [41]
            or restored['request'].get('rpcId') != 'L5adhe'
            or restored['request'].get('preferenceFieldIds') != [41]
            or restored['readbackRequest'].get('preferenceFieldIds') != [41]):
        raise ValueError('one or more request envelopes do not match the observed field-41 contract')
    identity = before.get('identityRead')
    if (not isinstance(identity, dict) or identity.get('ownerMatched') is not True
            or identity.get('anonymousOwnerAbsent') is not True or identity.get('httpStatus') != 200
            or not SHA256.fullmatch(identity.get('responseSha256') or '')):
        raise ValueError('fresh authenticated owner identity response is incomplete')

    contract_hash = source_before_imports['contractSha256']
    settings_hash = source_before_imports['implementationSetSha256']
    identity_hash = identity_before_imports['implementationSetSha256']
    owner_pair = pair_record(
        feature_id='identity', operation_id='identity', case_id='owner',
        contract_hash=contract_hash, client_code_hash=identity_hash,
        request=identity['request'],
        response={
            'httpStatus': identity['httpStatus'], 'contentType': 'text/html',
            'responseBytes': identity['responseBytes'], 'responseSha256': identity['responseSha256'],
        },
        identity_match=True, credential_propagated=identity.get('credentialPropagated') is True,
    )
    before_pair = pair_record(
        feature_id='settings', operation_id='settings_read', case_id='before',
        contract_hash=contract_hash, client_code_hash=settings_hash,
        request=before['request'], response=before, expected_outcome=before['value'] is True,
        credential_propagated=before.get('credentialPropagated') is True, rpc_id='ESY5D',
    )
    update_pair = pair_record(
        feature_id='settings', operation_id='settings_update', case_id='update',
        contract_hash=contract_hash, client_code_hash=settings_hash,
        request=applied['request'], response=applied,
        expected_outcome=applied.get('readbackMatched') is True,
        credential_propagated=True, correlation_id=correlation_id, rpc_id='L5adhe',
    )
    after_pair = pair_record(
        feature_id='settings', operation_id='settings_read', case_id='after',
        contract_hash=contract_hash, client_code_hash=settings_hash,
        request=applied['readbackRequest'],
        response={
            'httpStatus': applied['readbackHttpStatus'], 'contentType': applied['readbackContentType'],
            'responseBytes': applied['readbackResponseBytes'],
            'responseSha256': applied['readbackResponseSha256'],
        },
        expected_outcome=applied.get('readbackValue') is False,
        credential_propagated=True, correlation_id=correlation_id,
        readback_of_operation='settings_update', readback_of_case_id='update', rpc_id='ESY5D',
    )
    return {
        'identityPair': owner_pair,
        'beforePair': before_pair,
        'updatePair': update_pair,
        'afterPair': after_pair,
        'settingsReceipt': {
            'schema': 'gemini-feature-live-receipt-v1',
            'service': 'gemini-web',
            'featureId': 'settings',
            'outcome': 'verified',
            'checkedAt': datetime.now(timezone.utc).isoformat(),
            'evidenceClass': 'direct_http_live',
            'transport': 'direct_http',
            'executionHost': 'linux_worker',
            'mocked': False,
            'publicOnly': False,
            'authenticatedOwnerVerified': True,
            'secretsPersisted': False,
            'contractSha256': contract_hash,
            'implementationFiles': source_before_imports['implementationFiles'],
            'implementationSetSha256': settings_hash,
            'ownerIdentityEvidence': {
                'path': 'verification/feature-evidence/identity--identity--owner.json',
                'implementationFiles': identity_before_imports['implementationFiles'],
                'implementationSetSha256': identity_hash,
            },
            'operationEvidence': [
                {'operationId': 'settings_read', 'caseId': 'before',
                 'path': 'verification/feature-evidence/settings--settings_read--before.json'},
                {'operationId': 'settings_update', 'caseId': 'update',
                 'path': 'verification/feature-evidence/settings--settings_update--update.json'},
                {'operationId': 'settings_read', 'caseId': 'after',
                 'path': 'verification/feature-evidence/settings--settings_read--after.json'},
            ],
            'readbackBindings': [{
                'writeOperation': 'settings_update', 'writeCaseId': 'update',
                'readOperation': 'settings_read', 'readCaseId': 'after',
                'correlationId': correlation_id, 'sameOwner': True,
                'requestCorrelationVerified': True, 'expectedStateVerified': True,
            }],
        },
    }


def build_current_login_records(*, read_result, source_stable, owner_sha256_before,
                                owner_sha256_after, login_source_before, login_source_after,
                                identity_source, existing_owner_identity_ref,
                                expected_owner_sha256, session_handoff_verified,
                                native_browser_profile):
    if (source_stable is not True or login_source_before != login_source_after
            or owner_sha256_before != owner_sha256_after
            or owner_sha256_before != expected_owner_sha256
            or session_handoff_verified is not True or native_browser_profile is not True):
        raise ValueError('owner handoff sources, profile, or principal were not stable')
    if (read_result.get('operation') != 'settings_read' or read_result.get('outputStatus') != 'verified'
            or read_result.get('ownerMatched') is not True or read_result.get('anonymousOwnerAbsent') is not True
            or read_result.get('sessionContextRefreshed') is not True):
        raise ValueError('the current authenticated session handoff was not verified')
    identity = read_result.get('identityRead')
    if (not isinstance(identity, dict) or identity.get('ownerMatched') is not True
            or identity.get('anonymousOwnerAbsent') is not True or identity.get('httpStatus') != 200
            or identity.get('credentialPropagated') is not True
            or not SHA256.fullmatch(identity.get('responseSha256') or '')):
        raise ValueError('a fresh direct current-owner HTTP identity response is missing')
    if (not isinstance(existing_owner_identity_ref, dict)
            or existing_owner_identity_ref.get('path') != 'verification/feature-evidence/identity--identity--owner.json'
            or not SHA256.fullmatch(existing_owner_identity_ref.get('sha256') or '')
            or existing_owner_identity_ref.get('implementationSetSha256') != identity_source['implementationSetSha256']):
        raise ValueError('the existing canonical owner identity proof is missing or stale')
    identity_pair = pair_record(
        feature_id='login', operation_id='identity', case_id='owner',
        contract_hash=read_result['contractSha256'],
        client_code_hash=identity_source['implementationSetSha256'],
        request=identity['request'],
        response={
            'httpStatus': identity['httpStatus'], 'contentType': 'text/html',
            'responseBytes': identity['responseBytes'], 'responseSha256': identity['responseSha256'],
        },
        identity_match=True, credential_propagated=True,
    )
    pair_path = 'verification/feature-evidence/login--identity--owner.json'
    auth_observed_at = datetime.now(timezone.utc).isoformat()
    auth_recorded_at = datetime.now(timezone.utc).isoformat()
    receipt = {
        'schema': 'gemini-feature-live-receipt-v1',
        'service': 'gemini-web',
        'featureId': 'login',
        'outcome': 'verified',
        'checkedAt': datetime.now(timezone.utc).isoformat(),
        'evidenceClass': 'direct_http_live',
        'transport': 'direct_http',
        'executionHost': 'linux_worker',
        'mocked': False,
        'publicOnly': False,
        'authenticatedOwnerVerified': True,
        'secretsPersisted': False,
        'contractSha256': read_result['contractSha256'],
        'implementationFiles': identity_source['implementationFiles'],
        'implementationSetSha256': identity_source['implementationSetSha256'],
        'ownerIdentityEvidence': existing_owner_identity_ref,
        'operationEvidence': [{
            'operationId': 'identity', 'caseId': 'owner', 'path': pair_path,
            'sha256': None,
        }],
        'sessionHandoffVerified': True,
        'authBootstrapEvidence': {
            'schema': 'gemini-native-auth-bootstrap-evidence-v2',
            'executionHost': 'linux_worker',
            'context': 'native_browser_session_handoff',
            'providerAuthenticatedSessionObserved': True,
            'nativeBrowserProfile': True,
            'sessionHandoffVerified': True,
            'passwordSubmittedToProviderApi': False,
            'challengeBypassUsed': False,
            'evidenceScope': 'same_authenticated_owner',
            'ownerIdentityEvidenceSha256': existing_owner_identity_ref['sha256'],
            'observedAt': auth_observed_at,
            'recordedAt': auth_recorded_at,
            'secretsPersisted': False,
            'implementationFiles': login_source_before['implementationFiles'],
            'implementationSetSha256': login_source_before['implementationSetSha256'],
        },
    }
    return {'identityPair': identity_pair, 'receipt': receipt, 'pairPath': pair_path}


def build_current_model_catalog_records(*, model_result, source_before, source_after,
                                        identity_scope_before, identity_scope_after,
                                        owner_sha256_before, owner_sha256_after,
                                        expected_owner_sha256, contract_sha256):
    if source_before != source_after:
        raise ValueError('model catalog source changed during the direct read')
    if identity_scope_before != identity_scope_after:
        raise ValueError('model owner handler scope changed during the direct read')
    if owner_sha256_before != owner_sha256_after or owner_sha256_before != expected_owner_sha256:
        raise ValueError('expected owner changed during model catalog read')
    if (model_result.get('operation') != 'model_list' or model_result.get('ownerMatched') is not True
            or model_result.get('anonymousOwnerAbsent') is not True or model_result.get('rpcId') != 'otAQ7b'
            or model_result.get('httpStatus') != 200 or model_result.get('contentType') != 'application/json'
            or model_result.get('credentialPropagated') is not True
            or not isinstance(model_result.get('modelCount'), int) or model_result.get('modelCount') < 1
            or not SHA256.fullmatch(model_result.get('responseSha256') or '')):
        raise ValueError('the current model catalog response is incomplete')
    identity = model_result.get('identity')
    if (not isinstance(identity, dict) or identity.get('ownerMatched') is not True
            or identity.get('anonymousOwnerAbsent') is not True or identity.get('httpStatus') != 200
            or identity.get('contentType') != 'text/html' or identity.get('credentialPropagated') is not True
            or not SHA256.fullmatch(identity.get('responseSha256') or '')
            or not isinstance(identity.get('responseBytes'), int) or identity.get('responseBytes') < 1):
        raise ValueError('the current direct HTTP identity response is incomplete')
    model_code_hash = source_before['implementationSetSha256']
    observed_at = datetime.now(timezone.utc).isoformat()
    owner_path = 'verification/feature-evidence/identity--identity--model_catalog_owner.json'
    identity_code_hash = identity_scope_before['implementationScopeSha256']
    owner_pair = pair_record(
        feature_id='identity', operation_id='identity', case_id='model_catalog_owner',
        contract_hash=contract_sha256, client_code_hash=identity_code_hash,
        request=identity['request'],
        response={
            'httpStatus': identity['httpStatus'], 'contentType': identity['contentType'],
            'responseBytes': identity['responseBytes'], 'responseSha256': identity['responseSha256'],
        },
        identity_match=True, credential_propagated=True,
    )
    identity_ref = {
        'path': owner_path,
        'sha256': None,
        'implementationFiles': identity_scope_before['implementationUnits'],
        'implementationSetSha256': identity_code_hash,
        'contractSha256': contract_sha256,
        'sourceScope': identity_scope_before,
    }
    model_pair = pair_record(
        feature_id='model_catalog', operation_id='model_list', case_id='available',
        contract_hash=source_before['contractSha256'], client_code_hash=model_code_hash,
        request=model_result['request'], response=model_result,
        expected_outcome=model_result['modelCount'] > 0,
        credential_propagated=True, rpc_id='otAQ7b',
    )
    return {
        'modelPair': model_pair,
        'ownerPair': owner_pair,
        'ownerPairPath': owner_path,
        'receipt': {
            'schema': 'gemini-feature-live-receipt-v1',
            'service': 'gemini-web',
            'featureId': 'model_catalog',
            'outcome': 'verified',
            'checkedAt': observed_at,
            'evidenceClass': 'direct_http_live',
            'transport': 'direct_http',
            'executionHost': 'linux_worker',
            'mocked': False,
            'publicOnly': False,
            'authenticatedOwnerVerified': True,
            'secretsPersisted': False,
            'contractSha256': source_before['contractSha256'],
            'implementationFiles': source_before['implementationFiles'],
            'implementationSetSha256': model_code_hash,
            'sourceScope': source_before['sourceScope'],
            'ownerIdentityEvidence': identity_ref,
            'operationEvidence': [{
                'operationId': 'model_list', 'caseId': 'available',
                'path': 'verification/feature-evidence/model_catalog--model_list--available.json',
            }],
        },
    }
