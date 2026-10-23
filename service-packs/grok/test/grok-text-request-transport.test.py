import importlib.util
import json
import sys
import types
import unittest
from pathlib import Path

sys.dont_write_bytecode = True
ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location('grok_text_request_transport', ROOT / 'scripts/grok-text-request-transport.py')
TRANSPORT = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(TRANSPORT)

CONTROL = {
    'event': {
        'type': 'session.create',
        'event_id': 'evt_init_00000000-0000-4000-8000-000000000001',
        'session': {
            'model': 'grok-4.7',
            'x_grok': {'connector_ids': ['connector-a', 'connector-b', 'connector-c'], 'enable_image_generation': False},
        },
    },
}


def start_packet():
    return {
        'kind': 'start',
        'socketUrl': 'wss://grok.com/ws/mgw/?uid=fixture-uid',
        'cookieHeader': 'sso=fixture-cookie',
        'requestMetadataHeaders': {'x-xai-request-id': 'fixture-request-id'},
        'controlFrameText': json.dumps(CONTROL, separators=(',', ':')),
        'timeoutMs': 1000,
    }


def business_frame(session_id='server-ack-session'):
    return {
        'session_id': session_id,
        'event': {
            'type': 'response.create',
            'event_id': '00000000-0000-4000-8000-000000000002',
            'castle_request_token': 'fixture-only-token',
            'item': {
                'type': 'message',
                'role': 'user',
                'x_grok': {
                    'client_message_id': '00000000-0000-4000-8000-000000000003',
                    'input_chunks': [{'text': {'text': 'fixture prompt held in memory'}}],
                },
            },
        },
    }


class FakeConnection:
    def __init__(self, received):
        self.connected = True
        self.handshake_response = types.SimpleNamespace(status=101)
        self.received = list(received)
        self.sent = []
        self.closed = False

    def settimeout(self, _timeout):
        return None

    def send(self, value, opcode=None):
        self.sent.append((value, opcode))

    def recv(self):
        return self.received.pop(0)

    def close(self, **_kwargs):
        self.closed = True


class FakeWebSocket:
    ABNF = types.SimpleNamespace(OPCODE_TEXT=1)
    WebSocketTimeoutException = type('WebSocketTimeoutException', (Exception,), {})
    WebSocketConnectionClosedException = type('WebSocketConnectionClosedException', (Exception,), {})

    def __init__(self, connection):
        self.connection = connection
        self.options = None

    def create_connection(self, url, **kwargs):
        self.options = {'url': url, **kwargs}
        return self.connection


class GrokTextRequestTransportTests(unittest.TestCase):
    def test_waits_for_new_ack_then_sends_one_builder_frame_with_that_id(self):
        connection = FakeConnection([
            json.dumps({'event': {'type': 'session.created'}, 'session_id': 'server-ack-session'}),
            json.dumps({'event': {'type': 'session.created'}, 'session_id': 'server-ack-session'}),
            json.dumps({'event': {'type': 'response.completed'}, 'conversation_id': 'private-conversation'}),
        ])
        ws = FakeWebSocket(connection)
        notices = []
        sent = []

        def read_business(_timeout, _max_bytes):
            return {'kind': 'business_frame', 'frameText': json.dumps(business_frame(), separators=(',', ':'))}

        result = TRANSPORT.run(start_packet(), websocket_module=ws, read_business_command=read_business,
                               emit_message=notices.append)
        self.assertEqual(result['handshakeStatus'], 101)
        self.assertEqual(result['normalControlFrameSentCount'], 1)
        self.assertTrue(result['serverSessionAcknowledgementObserved'])
        self.assertTrue(result['businessFrameBoundToServerSession'])
        self.assertEqual(result['businessFrameSentCount'], 1)
        self.assertEqual(len(connection.sent), 2)
        self.assertEqual(connection.sent[0][0], start_packet()['controlFrameText'])
        self.assertEqual(connection.sent[0][1], FakeWebSocket.ABNF.OPCODE_TEXT)
        sent_frame = json.loads(connection.sent[1][0])
        self.assertEqual(sent_frame['session_id'], 'server-ack-session')
        self.assertEqual(result['conversationIdHints'], ['private-conversation'])
        self.assertEqual(notices[0]['kind'], 'session_ack')
        self.assertEqual(notices[0]['sessionId'], 'server-ack-session')
        self.assertNotIn('fixture-only-token', json.dumps(result))
        self.assertNotIn('fixture prompt held in memory', json.dumps(result))
        self.assertTrue(connection.closed)

    def test_abort_or_bad_ack_binding_sends_no_business_frame(self):
        connection = FakeConnection([json.dumps({'event': {'type': 'session.created'}, 'session_id': 'server-ack-session'})])
        ws = FakeWebSocket(connection)
        notices = []
        result = TRANSPORT.run(start_packet(), websocket_module=ws,
                               read_business_command=lambda _timeout, _max: {'kind': 'abort'},
                               emit_message=notices.append)
        self.assertEqual(result['businessFrameSentCount'], 0)
        self.assertTrue(result['serverSessionAcknowledgementObserved'])
        self.assertEqual(len(connection.sent), 1)

        mismatch = FakeConnection([json.dumps({'event': {'type': 'session.created'}, 'session_id': 'server-ack-session'})])
        ws_mismatch = FakeWebSocket(mismatch)
        result = TRANSPORT.run(start_packet(), websocket_module=ws_mismatch,
                               read_business_command=lambda _timeout, _max: {
                                   'kind': 'business_frame', 'frameText': json.dumps(business_frame('wrong-session')),
                               }, emit_message=lambda _value: None)
        self.assertFalse(result['businessFrameBoundToServerSession'])
        self.assertEqual(result['businessFrameSentCount'], 0)
        self.assertEqual(len(mismatch.sent), 1)

    def test_rejects_connection_and_request_data_outside_exact_contract(self):
        bad = start_packet()
        bad['requestMetadataHeaders'] = {'authorization': 'fixture'}
        self.assertEqual(TRANSPORT.run(bad)['businessFrameSentCount'], 0)
        bad = start_packet()
        bad['cookieHeader'] = 'sso=fixture; extra=value'
        self.assertEqual(TRANSPORT.run(bad)['businessFrameSentCount'], 0)
        bad_control = business_frame()
        bad = start_packet()
        bad['controlFrameText'] = json.dumps(bad_control)
        self.assertEqual(TRANSPORT.run(bad)['businessFrameSentCount'], 0)

    def test_accepts_observed_native_token_length_and_rejects_values_over_the_bounded_cap(self):
        captured = business_frame()
        captured['event']['castle_request_token'] = 'x' * 5941
        frame, _ = TRANSPORT.validate_business_command({
            'kind': 'business_frame',
            'frameText': json.dumps(captured, separators=(',', ':')),
        }, 'server-ack-session')
        self.assertEqual(len(frame['event']['castle_request_token']), 5941)

        oversized = business_frame()
        oversized['event']['castle_request_token'] = 'x' * 8193
        with self.assertRaises(ValueError):
            TRANSPORT.validate_business_command({
                'kind': 'business_frame',
                'frameText': json.dumps(oversized, separators=(',', ':')),
            }, 'server-ack-session')


if __name__ == '__main__':
    unittest.main()
