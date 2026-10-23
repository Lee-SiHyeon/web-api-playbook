import pathlib
import importlib.util
import json
import sys
import unittest

REPO = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO / 'scripts'))

from gemini_settings_evidence import (  # noqa: E402
    build_current_login_records,
    build_current_settings_records,
    identity_snapshot,
    implementation_snapshot,
    login_bootstrap_snapshot,
    build_current_model_catalog_records,
    feature_source_snapshot,
    model_list_snapshot,
)

RUNNER_PATH = REPO / 'scripts/gemini-settings-update-once.py'
RUNNER_SPEC = importlib.util.spec_from_file_location('gemini_settings_update_once', RUNNER_PATH)
RUNNER = importlib.util.module_from_spec(RUNNER_SPEC)
RUNNER_SPEC.loader.exec_module(RUNNER)


def read_request(rpc_id):
    return {
        'method': 'POST',
        'origin': 'https://gemini.google.com',
        'path': '/_/BardChatUi/data/batchexecute',
        'queryKeys': ['rpcids', 'source-path', 'bl', 'f.sid', 'hl', '_reqid', 'rt'],
        'headerNames': ['content-type', 'origin', 'referer', 'x-same-domain'],
        'formFieldNames': ['f.req', 'at'],
        'contentType': 'application/x-www-form-urlencoded;charset=UTF-8',
        'rpcId': rpc_id,
        'valuesPersisted': False,
    }


def read_response(value, seed):
    request = read_request('ESY5D')
    request['preferenceFieldIds'] = [41]
    return {
        'operation': 'settings_read',
        'rpcId': 'ESY5D',
        'httpStatus': 200,
        'contentType': 'application/json',
        'responseBytes': 157,
        'responseSha256': seed * 64,
        'credentialPropagated': True,
        'request': request,
        'found': True,
        'valueType': 'boolean',
        'value': value,
        'identityRead': {
            'ownerMatched': True,
            'anonymousOwnerAbsent': True,
            'httpStatus': 200,
            'responseBytes': 1200,
            'responseSha256': 'c' * 64,
            'anonymousHttpStatus': 200,
            'credentialPropagated': True,
            'request': {
                'method': 'GET', 'origin': 'https://gemini.google.com', 'path': '/app',
                'queryKeys': [], 'headerNames': ['user-agent'], 'valuesPersisted': False,
            },
        },
    }


def successful_run():
    baseline = read_response(True, 'a')
    update_request = read_request('L5adhe')
    update_request['preferenceFieldIds'] = [41]
    update_request['preferenceArrayIndex'] = 40
    update_request['preferenceVectorLength'] = 41
    readback = read_response(False, 'b')
    restore_request = read_request('L5adhe')
    restore_request['preferenceFieldIds'] = [41]
    restored_readback = read_response(True, 'd')
    return {
        'operation': 'settings_update',
        'outputStatus': 'verified_and_restored',
        'callerIntentCorrelationId': 'gemini-settings-refresh-20261006-v3',
        'ownerMatched': True,
        'anonymousOwnerAbsent': True,
        'preferenceKey': 'side_nav_open_by_default',
        'baselineValue': True,
        'testValue': False,
        'writesSent': 2,
        'restoredToBaseline': True,
        'automaticRetry': False,
        'baselineRead': baseline,
        'apply': {
            'request': update_request,
            'httpStatus': 200,
            'contentType': 'application/json',
            'responseBytes': 144,
            'responseSha256': 'e' * 64,
            'dispatchCount': 1,
            'responseRpcMatched': True,
            'journalState': 'reconciled',
            'readbackValue': False,
            'readbackMatched': True,
            'readbackHttpStatus': 200,
            'readbackContentType': 'application/json',
            'readbackResponseBytes': readback['responseBytes'],
            'readbackResponseSha256': readback['responseSha256'],
            'readbackRequest': readback['request'],
            'readbackRpcId': 'ESY5D',
        },
        'restore': {
            'request': restore_request,
            'httpStatus': 200,
            'contentType': 'application/json',
            'responseBytes': 145,
            'responseSha256': 'f' * 64,
            'dispatchCount': 1,
            'responseRpcMatched': True,
            'journalState': 'reconciled',
            'readbackValue': True,
            'readbackMatched': True,
            'readbackHttpStatus': 200,
            'readbackContentType': 'application/json',
            'readbackResponseBytes': restored_readback['responseBytes'],
            'readbackResponseSha256': restored_readback['responseSha256'],
            'readbackRpcId': 'ESY5D',
            'readbackRequest': restored_readback['request'],
        },
    }


class GeminiSettingsEvidenceTests(unittest.TestCase):
    def test_source_snapshot_covers_the_installed_contract_and_implementation_files(self):
        snapshot = implementation_snapshot(REPO, REPO / 'discovery/observed-contract.json')
        identity = identity_snapshot(REPO, REPO / 'discovery/observed-contract.json')
        self.assertEqual(snapshot['contractSha256'], identity['contractSha256'])
        self.assertTrue(snapshot['implementationFiles'])
        self.assertTrue(identity['implementationFiles'])
        self.assertEqual(len(snapshot['implementationSetSha256']), 64)

    def test_cli_projection_keeps_immediate_readback_status_digest_and_request_metadata(self):
        request = read_request('ESY5D')
        request['preferenceFieldIds'] = [41]
        raw = {
            'ownerMatched': True,
            'anonymousOwnerAbsent': True,
            'outputStatus': 'verified_and_restored',
            'result': {
                'callerIntentCorrelationId': 'gemini-settings-refresh-20261006-v3',
                'preferenceKey': 'side_nav_open_by_default',
                'baselineValue': True,
                'testValue': False,
                'writesSent': 2,
                'restoredToBaseline': True,
                'baselineRead': read_response(True, 'a'),
                'applied': {
                    'outcome': 'state_readback_verified',
                    'request': read_request('L5adhe'),
                    'dispatch': {
                        'httpStatus': 200, 'responseBytes': 144, 'responseSha256': 'e' * 64,
                        'responseRpcMatched': True, 'providerErrorFieldOne': None, 'journalState': 'reconciled',
                        'response': {'contentType': 'application/json'},
                    },
                    'readback': {
                        'value': False, 'matchedRequestedValue': True, 'httpStatus': 200,
                        'contentType': 'application/json', 'responseBytes': 157, 'responseSha256': 'b' * 64,
                        'rpcId': 'ESY5D', 'request': request,
                        'identityRead': read_response(False, 'b')['identityRead'],
                    },
                },
                'restored': {},
            },
        }
        projected = RUNNER.safe_cli_result(json.dumps(raw), 'settings-update-test')
        self.assertEqual(projected['apply']['readbackResponseBytes'], 157)
        self.assertEqual(projected['apply']['readbackResponseSha256'], 'b' * 64)
        self.assertEqual(projected['apply']['readbackRpcId'], 'ESY5D')
        self.assertEqual(projected['apply']['readbackRequest']['preferenceFieldIds'], [41])

    def test_evidence_builder_binds_false_readback_to_the_write_and_records_true_restore(self):
        source = implementation_snapshot(REPO, REPO / 'discovery/observed-contract.json')
        identity = identity_snapshot(REPO, REPO / 'discovery/observed-contract.json')
        records = build_current_settings_records(
            run=successful_run(), source_before_imports=source, source_after_run=source,
            identity_before_imports=identity, expected_owner_sha256='1' * 64,
            expected_owner_immutable=True, browser_writes=0,
        )
        self.assertEqual(records['afterPair']['response']['bodySha256'], 'b' * 64)
        self.assertEqual(records['afterPair']['readbackOfOperation'], 'settings_update')
        self.assertEqual(records['updatePair']['request']['correlationId'], 'gemini-settings-refresh-20261006-v3')
        self.assertEqual(records['settingsReceipt']['readbackBindings'][0]['expectedStateVerified'], True)

    def test_evidence_builder_rejects_missing_false_readback_digest_or_unrestored_state(self):
        source = implementation_snapshot(REPO, REPO / 'discovery/observed-contract.json')
        identity = identity_snapshot(REPO, REPO / 'discovery/observed-contract.json')
        run = successful_run()
        run['apply']['readbackResponseSha256'] = None
        with self.assertRaises(ValueError):
            build_current_settings_records(
                run=run, source_before_imports=source, source_after_run=source,
                identity_before_imports=identity, expected_owner_sha256='1' * 64,
                expected_owner_immutable=True, browser_writes=0,
            )

    def test_login_receipt_binds_fresh_owner_http_to_profile_handoff(self):
        source = implementation_snapshot(REPO, REPO / 'discovery/observed-contract.json')
        identity = identity_snapshot(REPO, REPO / 'discovery/observed-contract.json')
        bootstrap = login_bootstrap_snapshot(REPO)
        identity_receipt = json.loads((REPO / 'verification/features/identity.json').read_text())
        identity_ref = identity_receipt['ownerIdentityEvidence']
        read_result = {
            'operation': 'settings_read',
            'outputStatus': 'verified',
            'ownerMatched': True,
            'anonymousOwnerAbsent': True,
            'sessionContextRefreshed': True,
            'contractSha256': source['contractSha256'],
            'identityRead': read_response(True, 'a')['identityRead'],
        }
        records = build_current_login_records(
            read_result=read_result, source_stable=True,
            owner_sha256_before='1' * 64, owner_sha256_after='1' * 64,
            login_source_before=bootstrap, login_source_after=bootstrap,
            identity_source=identity, existing_owner_identity_ref=identity_ref,
            expected_owner_sha256='1' * 64, session_handoff_verified=True,
            native_browser_profile=True,
        )
        self.assertEqual(records['identityPair']['response']['status'], 200)
        self.assertEqual(records['receipt']['authBootstrapEvidence']['ownerIdentityEvidenceSha256'], identity_ref['sha256'])
        self.assertFalse(records['receipt']['authBootstrapEvidence']['passwordSubmittedToProviderApi'])
        self.assertEqual(records['pairPath'], 'verification/feature-evidence/login--identity--owner.json')

    def test_model_catalog_receipt_binds_current_typed_ot_aq7b_read_to_fresh_owner_identity(self):
        source = model_list_snapshot(REPO, REPO / 'discovery/observed-contract.json')
        identity_scope = feature_source_snapshot(REPO, 'identity')
        model = {
            'operation': 'model_list', 'ownerMatched': True, 'anonymousOwnerAbsent': True,
            'credentialPropagated': True, 'httpStatus': 200, 'contentType': 'application/json',
            'responseBytes': 1234, 'responseSha256': 'e' * 64, 'rpcId': 'otAQ7b',
            'request': read_request('otAQ7b'), 'modelCount': 3,
            'identity': {
                'httpStatus': 200, 'contentType': 'text/html', 'responseBytes': 1200, 'responseSha256': 'c' * 64,
                'credentialPropagated': True,
                'ownerMatched': True, 'anonymousOwnerAbsent': True,
                'request': {
                    'method': 'GET', 'origin': 'https://gemini.google.com', 'path': '/app',
                    'queryKeys': [], 'headerNames': ['user-agent'], 'valuesPersisted': False,
                },
            },
        }
        records = build_current_model_catalog_records(
            model_result=model, source_before=source, source_after=source,
            identity_scope_before=identity_scope, identity_scope_after=identity_scope,
            owner_sha256_before='1' * 64, owner_sha256_after='1' * 64,
            expected_owner_sha256='1' * 64,
            contract_sha256=source['contractSha256'],
        )
        self.assertEqual(records['modelPair']['request']['rpcId'], 'otAQ7b')
        self.assertEqual(records['modelPair']['response']['status'], 200)
        self.assertEqual(records['receipt']['featureId'], 'model_catalog')
        self.assertEqual(records['receipt']['ownerIdentityEvidence']['path'],
                         'verification/feature-evidence/identity--identity--model_catalog_owner.json')
        self.assertEqual(records['ownerPair']['identityMatchVerified'], True)
        self.assertEqual(records['receipt']['sourceScope']['schema'], 'gemini-feature-source-scope-v1')
        run = successful_run()
        run['restoredToBaseline'] = False
        legacy_identity = identity_snapshot(REPO, REPO / 'discovery/observed-contract.json')
        with self.assertRaises(ValueError):
            build_current_settings_records(
                run=run, source_before_imports=source, source_after_run=source,
                identity_before_imports=legacy_identity, expected_owner_sha256='1' * 64,
                expected_owner_immutable=True, browser_writes=0,
            )


if __name__ == '__main__':
    unittest.main()
