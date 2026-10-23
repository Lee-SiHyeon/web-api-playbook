import importlib.util
import json
import pathlib
import sys
import unittest
import urllib.parse

ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location('media_history_readback', ROOT / 'scripts' / 'media-history-readback-once.py')
readback = importlib.util.module_from_spec(spec)
spec.loader.exec_module(readback)


class NestedBatchIdTests(unittest.TestCase):
    def request(self, conversation_id):
        rpc_args = json.dumps([conversation_id, 20, None, 1, [1], [4], None, 1], separators=(',', ':'))
        inner = [[['hNvQHb', rpc_args, None, 'generic']]]
        outer = [None, json.dumps(inner, separators=(',', ':'))]
        return urllib.parse.urlencode([
            ('at', 'test-at'),
            ('f.req', json.dumps(outer, separators=(',', ':'))),
        ]).encode()

    def test_exact_raw_prefixed_id_is_found_after_nested_rpc_argument_decode(self):
        raw_id = 'c_0123456789abcdef'
        body = self.request(raw_id)
        state = {'phase': 'candidate_navigation', 'candidate_route_loaded': False, 'detail_request_records': []}
        allowed, rpc_ids, fields, id_match, classification = readback.safe_rpc_request(
            body,
            'https://gemini.google.com/_/BardChatUi/data/batchexecute',
            {'content-type': 'application/x-www-form-urlencoded'},
            'POST',
            'network-request',
            raw_id,
            state,
        )
        self.assertTrue(allowed)
        self.assertEqual(rpc_ids, ['hNvQHb'])
        self.assertEqual(set(fields), {'at', 'f.req'})
        self.assertTrue(id_match)
        self.assertEqual(classification, 'candidate_scoped_detail_read')
        self.assertEqual(
            readback.rpc_argument_template(body, 'hNvQHb', raw_id),
            {'length': 8, 'arguments': ['{{apiConversationId}}', 20, None, 1, [1], [4], None, 1], 'identifierPath': [0]},
        )

    def test_mismatched_raw_id_is_blocked_without_ui_route_context(self):
        body = self.request('c_0123456789abcdef')
        state = {'phase': 'candidate_navigation', 'candidate_route_loaded': False, 'detail_request_records': []}
        allowed, _rpc_ids, _fields, id_match, classification = readback.safe_rpc_request(
            body,
            'https://gemini.google.com/_/BardChatUi/data/batchexecute',
            {'content-type': 'application/x-www-form-urlencoded'},
            'POST',
            'network-request',
            'c_fedcba9876543210',
            state,
        )
        self.assertFalse(allowed)
        self.assertFalse(id_match)
        self.assertEqual(classification, 'blocked_unclassified_post')

    def test_literal_prefix_bijection_keeps_raw_rpc_id_and_route_id_separate(self):
        raw_id = 'c_0123456789abcdef'
        route_id = readback.raw_candidate_route_id(raw_id, ['0123456789abcdef'])
        self.assertEqual(route_id, '0123456789abcdef')
        self.assertEqual(raw_id, 'c_0123456789abcdef')
        self.assertIsNone(readback.raw_candidate_route_id(raw_id, ['0123456789abcdef', '0123456789abcdef']))
        self.assertIsNone(readback.raw_candidate_route_id('x_0123456789abcdef', ['0123456789abcdef']))


if __name__ == '__main__':
    unittest.main()
