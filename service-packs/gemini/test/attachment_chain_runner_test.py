import importlib.util
import hashlib
import socket
import pathlib
import json
import threading
import time
import tempfile
import unittest


SCRIPT = pathlib.Path(__file__).resolve().parents[1] / 'scripts' / 'gemini-attachment-chain-controlled-once.py'
SPEC = importlib.util.spec_from_file_location('gemini_attachment_chain_runner', SCRIPT)
RUNNER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(RUNNER)
V9_SCRIPT = SCRIPT.with_name('gemini-attachment-chain-v9-controlled-once.py')
V9_SPEC = importlib.util.spec_from_file_location('gemini_attachment_chain_v9_runner', V9_SCRIPT)
V9_RUNNER = importlib.util.module_from_spec(V9_SPEC)
V9_SPEC.loader.exec_module(V9_RUNNER)


class AttachmentChainRunnerDiagnosticsTest(unittest.TestCase):
    def test_persisted_url_projection_scrubs_nested_capture_queries_and_keeps_identity_hash(self):
        raw_url = 'https://gemini.google.com/_/captured/path?f.sid=fake-sensitive-value&rt=3'
        source = {
            'nativeAttachmentMessageCaptureAttempts': [{'url': raw_url}],
            'attempts': [{'nativeAttachmentMessageCaptureAttempts': [{'url': raw_url}]}],
            'origin': 'https://gemini.google.com',
        }
        for runner in (RUNNER, V9_RUNNER):
            projected = runner.project_persisted_urls(source)
            expected = {
                'origin': 'https://gemini.google.com',
                'pathFamily': '/_/captured/path',
                'queryKeyNames': ['f.sid', 'rt'],
                'fullUrlSha256': hashlib.sha256(raw_url.encode('utf-8')).hexdigest(),
            }
            self.assertEqual(projected['nativeAttachmentMessageCaptureAttempts'][0]['url'], expected)
            self.assertEqual(projected['attempts'][0]['nativeAttachmentMessageCaptureAttempts'][0]['url'], expected)
            self.assertEqual(projected['origin'], 'https://gemini.google.com')
            self.assertNotIn('fake-sensitive-value', repr(projected))
        self.assertEqual(source['nativeAttachmentMessageCaptureAttempts'][0]['url'], raw_url)

    def test_session_url_comparison_normalizes_only_exact_server_issued_query_identity(self):
        issued = 'https://push.clients6.google.com/upload/?upload_id=opaque-id&upload_protocol=resumable'
        self.assertTrue(RUNNER.same_upload_session_url(
            'https://push.clients6.google.com/upload/?upload_protocol=resumable&upload_id=opaque-id', issued))
        self.assertTrue(RUNNER.same_upload_session_url(
            'https://push.clients6.google.com:443/upload/?upload_protocol=resumable&upload_id=opaque%2Did', issued))
        self.assertFalse(RUNNER.same_upload_session_url(
            'https://push.clients6.google.com/upload/?upload_protocol=resumable&upload_id=other', issued))
        self.assertFalse(RUNNER.same_upload_session_url(issued + '&extra=1', issued))
        self.assertFalse(RUNNER.same_upload_session_url(issued + '&upload_id=duplicate', issued))
        self.assertFalse(RUNNER.same_upload_session_url(
            'https://example.invalid/upload/?upload_id=opaque-id&upload_protocol=resumable', issued))
        self.assertFalse(RUNNER.same_upload_session_url(
            'https://push.clients6.google.com:0/upload/?upload_id=opaque-id&upload_protocol=resumable', issued))
        self.assertFalse(RUNNER.same_upload_session_url(
            'https://push.clients6.google.com/other/?upload_id=opaque-id&upload_protocol=resumable', issued))

    def test_unreset_owned_page_is_marked_closed_atomically_in_the_role_registry(self):
        scratch = pathlib.Path.home() / '.nad-scratch' / 'tmp'
        scratch.mkdir(parents=True, exist_ok=True, mode=0o700)
        previous_file = RUNNER.ROLE_FILE
        previous_lock = RUNNER.ROLE_LOCK
        try:
            with tempfile.TemporaryDirectory(prefix='attachment-role-close-', dir=str(scratch)) as raw_dir:
                root = pathlib.Path(raw_dir)
                role_file = root / 'page-role-registry.json'
                lock_file = root / 'page-role-registry.lock'
                target_id = 'known-owned-target-id'
                role_file.write_text(json.dumps({
                    'taskOwned': True,
                    'runtimeChromePid': 1234,
                    'activePageRoles': {RUNNER.PAGE_ROLE: {'targetId': target_id, 'exactMarkerCount': 1}},
                }))
                RUNNER.ROLE_FILE = role_file
                RUNNER.ROLE_LOCK = lock_file

                RUNNER.mark_page_role_closed(target_id, 1234, 'reset_quiet_unverified')

                result = json.loads(role_file.read_text())
                self.assertNotIn(RUNNER.PAGE_ROLE, result['activePageRoles'])
                self.assertEqual(result['closedPageRoles'][-1]['targetId'], target_id)
                self.assertEqual(result['closedPageRoles'][-1]['reason'], 'reset_quiet_unverified')
        finally:
            RUNNER.ROLE_FILE = previous_file
            RUNNER.ROLE_LOCK = previous_lock

    def test_safe_binding_projection_keeps_field_shapes_and_hashes_but_not_values(self):
        result = RUNNER.safe_attachment_binding({
            'responsePayloadMatchCount': 0,
            'filenameMatchCount': 1,
            'mimeTypeMatchCount': 1,
            'sourceProtoTupleMatchCount': 0,
            'expectedFilenameSha256': 'a' * 64,
            'candidates': [{
                'kind': 'object',
                'fieldNames': ['dh', 'filename', 'mimeType'],
                'filenameBytes': 12,
                'filenameSha256': 'b' * 64,
                'dhBytes': 20,
                'dhSha256': 'c' * 64,
                'mimeType': 'Text/Plain; charset=UTF-8',
                'filenameMatched': True,
                'dhMatched': False,
                'rawValue': 'must-not-persist',
            }],
            'sourceProtoCandidates': [{
                'vePath': [18, 0], 'dqcPath': [18, 0, 2], 'veLength': 3, 'tupleLength': 4,
                'filenameBytes': 12, 'filenameSha256': 'b' * 64, 'filenameMatched': True,
                'dhBytes': 20, 'dhSha256': 'c' * 64, 'dhMatched': False,
                'sizeBytes': 12, 'sizeMatched': True, 'mimeType': 'text/plain', 'mimeTypeMatched': True,
                'matched': False,
            }],
        })
        self.assertEqual(result['responsePayloadMatchCount'], 0)
        self.assertEqual(result['candidates'][0]['fieldNames'], ['dh', 'filename', 'mimeType'])
        self.assertEqual(result['candidates'][0]['mimeType'], 'text/plain')
        self.assertEqual(result['sourceProtoCandidates'][0]['dqcPath'], [18, 0, 2])
        self.assertNotIn('must-not-persist', repr(result))

    def test_tuple_candidate_projection_keeps_only_safe_structure(self):
        result = RUNNER.safe_attachment_binding({
            'uploadedFilesTupleCandidates': [{
                'index': 0,
                'responsePayloadMatchCount': 1,
                'filenameMatchCount': 1,
                'mimeTypeMatchCount': 1,
                'sourceShapeMatchCount': 0,
                'fieldShapes': [{
                    'kind': 'array', 'length': 4,
                    'elementTypes': ['string', 'null', 'number', 'string'],
                    'dhSha256': 'd' * 64, 'mimeType': 'text/plain',
                    'rawValue': 'secret-value',
                }],
            }],
        })
        self.assertEqual(result['uploadedFilesTupleCandidates'][0]['index'], 0)
        shape = result['uploadedFilesTupleCandidates'][0]['fieldShapes'][0]
        self.assertEqual(shape['elementTypes'], ['string', 'null', 'number', 'string'])
        self.assertNotIn('secret-value', repr(result))

    def test_upload_summary_preserves_query_status_and_headers_without_session_or_reference(self):
        result = RUNNER.safe_direct_upload_summary({
            'status': 'verified', 'directDispatchCount': 2, 'startDispatchCount': 1,
            'transferDispatchCount': 1, 'httpRequestCount': 3, 'uploadedFileReadbackVerified': True,
            'transferHttpStatus': 200, 'transferContentType': 'text/html; charset=UTF-8',
            'transferResponseBytes': 125, 'transferResponseSha256': 'a' * 64,
            'fileBytes': 12, 'fileMimeType': 'text/plain', 'fileSha256': 'b' * 64,
            'journalReconciled': True, 'attachmentReferenceAvailable': True,
            'continuationTemplate': {
                'serverIssuedUrlIdentityMatched': True,
                'serverIssuedUrlStringNormalized': True,
                'uploadUrl': 'https://push.clients6.google.com/upload/session?secret=must-not-persist',
            },
            'query': {'httpStatus': 200, 'uploadStatus': 'final', 'sizeReceived': 12,
                'responseBytes': 0, 'responseSha256': 'c' * 64,
                'responseHeaderNames': ['content-type', 'x-goog-upload-status']},
            'transferMetadata': {'fileNameMatched': True, 'fileSizeMatched': True,
                'fileMimeMatched': False, 'fileIdPresent': False, 'fileIdLength': 0},
            'uploadUrl': 'https://push.clients6.google.com/upload/session?secret=must-not-persist',
            'attachmentRef': {'dh': 'must-not-persist'},
        })
        self.assertEqual(result['query']['httpStatus'], 200)
        self.assertEqual(result['query']['uploadStatus'], 'final')
        self.assertEqual(result['query']['sizeReceived'], 12)
        self.assertEqual(result['query']['responseHeaderNames'], ['content-type', 'x-goog-upload-status'])
        self.assertEqual(result['continuationTemplateUrlIdentity'], {
            'serverIssuedUrlIdentityMatched': True, 'serverIssuedUrlStringNormalized': True,
        })
        self.assertNotIn('must-not-persist', repr(result))

    def test_source_binding_resolution_requires_an_exact_reported_path_and_layout(self):
        binding = {'sourceProtoCandidates': [{
            'vePath': [18, 0], 'dqcPath': [18, 0, 0], 'tupleLayout': 'observed_dqc_dh_context_null_mime',
            'filenameMatched': True, 'dhMatched': True, 'sizeMatched': None,
            'mimeTypeMatched': True, 'sourceParentValueMatch': True,
            'contextValueIsNumber': True, 'contextEqualsFileSize': False,
            'tupleElementTypes': ['string', 'number', 'null', 'string'],
        }]}
        scratch = pathlib.Path.home() / '.nad-scratch' / 'tmp'
        scratch.mkdir(parents=True, exist_ok=True, mode=0o700)
        path = scratch / f'attachment-binding-test-{threading.get_ident()}.sock'
        message = json.dumps({'event': 'attachment-binding-resolution', 'vePath': [18, 0],
            'dqcPath': [18, 0, 0], 'tupleLayout': 'observed_dqc_dh_context_null_mime'}).encode('utf-8')

        def send_control():
            deadline = time.monotonic() + 2
            while not path.exists() and time.monotonic() < deadline:
                time.sleep(0.01)
            with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as client:
                client.connect(str(path))
                client.sendall(message)

        sender = threading.Thread(target=send_control, daemon=True)
        sender.start()
        try:
            plan = RUNNER.read_source_binding_resolution(binding, str(path), timeout_seconds=2)
            self.assertEqual(plan, {'vePath': [18, 0], 'dqcPath': [18, 0, 0],
                'tupleLayout': 'observed_dqc_dh_context_null_mime'})
        finally:
            sender.join(timeout=3)
            path.unlink(missing_ok=True)


if __name__ == '__main__':
    unittest.main()
