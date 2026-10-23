import importlib.util
import json
import sys
import types
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location('grok_text_ws_transport', ROOT / 'scripts/grok-text-websocket-transport.py')
TRANSPORT = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(TRANSPORT)

CONTROL_FIELDS = [
    'accept_interleaved_phases', 'client_side_toolsets', 'connector_ids', 'disable_artifact',
    'disable_text_follow_ups', 'enable_image_generation', 'enable_side_by_side', 'force_concise',
    'force_side_by_side', 'image_generation_count', 'protocol_capabilities', 'use_chunk',
]


def packet():
    control = {
        'event': {
            'event_id': 'captured-control-event',
            'type': 'session.create',
            'session': {'model': 'grok-3', 'x_grok': {
                **{key: None for key in CONTROL_FIELDS},
                'connector_ids': ['fixture-connector-a'],
                'accept_interleaved_phases': True,
                'client_side_toolsets': [],
                'disable_artifact': False,
                'disable_text_follow_ups': False,
                'enable_image_generation': False,
                'enable_side_by_side': False,
                'force_concise': False,
                'force_side_by_side': False,
                'image_generation_count': 0,
                'protocol_capabilities': [],
                'use_chunk': True,
            }},
        },
    }
    business = {
        'session_id': 'captured-browser-session',
        'event': {
            'event_id': 'captured-business-event',
            'type': 'response.create',
            'castle_request_token': 'captured-castle-token',
            'item': {
                'type': 'message', 'role': 'user',
                'x_grok': {'client_message_id': 'captured-message', 'input_chunks': [{'text': {'text': 'Neutral test text.'}}]},
            },
        },
    }
    return {
        'socketUrl': 'wss://grok.com/ws/mgw/?uid=captured-uid',
        'cookieHeader': 'sso=synthetic-cookie',
        'controlFrameText': json.dumps(control, separators=(',', ':')),
        'frameText': json.dumps(business, separators=(',', ':')),
        'expectedFileAttachmentIds': [],
        'expectedConversationId': None,
        'timeoutMs': 1000,
    }


class FakeConnection:
    def __init__(self, received=None):
        self.connected = True
        self.handshake_response = types.SimpleNamespace(status=101)
        self.sent = []
        self.received = received or [
            json.dumps({'event': {'type': 'session.created'}, 'session_id': 'server-issued-session'}),
            json.dumps({'event': {'type': 'conversation.attached',
                                  'conversation': {'id': 'private-conversation'}}}),
            json.dumps({'event': {'type': 'response.completed', 'response': {'status': 'completed'}}}),
        ]
        self.closed = False

    def settimeout(self, _timeout):
        return None

    def send(self, text, opcode=None):
        self.sent.append((text, opcode))

    def recv(self):
        return self.received.pop(0)

    def close(self, **_kwargs):
        self.closed = True


class FakeWebSocketModule:
    ABNF = types.SimpleNamespace(OPCODE_TEXT=1)
    WebSocketTimeoutException = type('WebSocketTimeoutException', (Exception,), {})
    WebSocketConnectionClosedException = type('WebSocketConnectionClosedException', (Exception,), {})

    def __init__(self, connection):
        self.connection = connection
        self.options = None

    def create_connection(self, url, **kwargs):
        self.options = {'url': url, **kwargs}
        return self.connection


class TextWebSocketTransportTests(unittest.TestCase):
    def test_initial_load_id_accepts_bounded_native_string_and_rejects_malformed_values(self):
        request = packet()
        control = json.loads(request['controlFrameText'])
        x_grok = control['event']['session']['x_grok']
        x_grok['initial_load_id'] = 'opaque-native-load-token-20261006'
        request['controlFrameText'] = json.dumps(control, separators=(',', ':'))
        TRANSPORT.validate(request)

        exact_boundary = '😀' * 128
        x_grok['initial_load_id'] = exact_boundary
        request['controlFrameText'] = json.dumps(control, separators=(',', ':'))
        TRANSPORT.validate(request)

        for invalid in [42, 'line\nbreak', 'carriage\rreturn', 'nul\0value', 'x' * 513, '😀' * 129]:
            control['event']['session']['x_grok']['initial_load_id'] = invalid
            request['controlFrameText'] = json.dumps(control, separators=(',', ':'))
            with self.subTest(value_type=type(invalid).__name__, chars=len(invalid) if isinstance(invalid, str) else None):
                with self.assertRaises(ValueError):
                    TRANSPORT.validate(request)

        control['event']['session']['x_grok']['initial_load_id'] = None
        request['controlFrameText'] = json.dumps(control, separators=(',', ':'))
        TRANSPORT.validate(request)

    def test_existing_conversation_control_must_match_the_explicit_expected_cid(self):
        request = packet()
        expected = 'empty-task-conversation-1234567890'
        control = json.loads(request['controlFrameText'])
        control['event']['session']['x_grok']['conversation_id'] = expected
        control['event']['session']['x_grok']['load_existing'] = True
        request['controlFrameText'] = json.dumps(control, separators=(',', ':'))
        request['expectedConversationId'] = expected
        TRANSPORT.validate(request)

        request['expectedConversationId'] = 'different-task-conversation-1234567890'
        with self.assertRaises(ValueError):
            TRANSPORT.validate(request)

        request['expectedConversationId'] = None
        with self.assertRaises(ValueError):
            TRANSPORT.validate(request)

    def test_passes_through_only_the_exact_source_captured_file_attachment_ids(self):
        request = packet()
        expected = ['private-upload-asset-id-1234567890']
        request['expectedFileAttachmentIds'] = expected
        frame = json.loads(request['frameText'])
        frame['event']['file_attachment_ids'] = expected
        frame['event']['item']['file_attachment_ids'] = expected
        request['frameText'] = json.dumps(frame, separators=(',', ':'))
        TRANSPORT.validate(request)

        request['expectedFileAttachmentIds'] = ['different-upload-asset-id-1234567890']
        with self.assertRaises(ValueError):
            TRANSPORT.validate(request)

        request = packet()
        request['expectedFileAttachmentIds'] = expected
        frame = json.loads(request['frameText'])
        frame['event']['file_attachment_ids'] = expected
        request['frameText'] = json.dumps(frame, separators=(',', ':'))
        TRANSPORT.validate(request)

    def test_direct_socket_negotiates_new_session_before_business_frame(self):
        connection = FakeConnection()
        fake = FakeWebSocketModule(connection)
        old = sys.modules.get('websocket')
        sys.modules['websocket'] = fake
        try:
            request = packet()
            result = TRANSPORT.run(request)
        finally:
            if old is None:
                sys.modules.pop('websocket', None)
            else:
                sys.modules['websocket'] = old

        self.assertEqual(result['handshakeStatus'], 101)
        self.assertEqual(result['normalControlFrameSentCount'], 1)
        self.assertTrue(result['serverSessionAcknowledgementObserved'])
        self.assertTrue(result['businessFrameBoundToServerSession'])
        self.assertEqual(result['businessFrameSentCount'], 1)
        self.assertEqual(len(connection.sent), 2)
        self.assertEqual(connection.sent[0][0], request['controlFrameText'])
        self.assertEqual(connection.sent[0][1], FakeWebSocketModule.ABNF.OPCODE_TEXT)
        direct_business = json.loads(connection.sent[1][0])
        captured_business = json.loads(request['frameText'])
        self.assertEqual(direct_business['session_id'], 'server-issued-session')
        self.assertEqual(direct_business['session_id'] != captured_business['session_id'], True)
        direct_business.pop('session_id')
        captured_business.pop('session_id')
        self.assertEqual(direct_business, captured_business)
        self.assertEqual(result['eventTypes'], ['conversation.attached', 'response.completed', 'session.created'])
        self.assertEqual(result['conversationIdHints'], ['private-conversation'])
        self.assertEqual(result['terminalMetadata'], {
            'eventType': 'response.completed', 'responseStatus': 'completed', 'responseStatusReason': None,
            'errorClass': None, 'errorCode': None, 'responseFieldNames': ['status'], 'errorFieldNames': [],
        })
        self.assertEqual(result['providerModelMetadata'], {
            'requestedSessionModel': 'grok-3', 'sessionCreatedModel': None,
            'terminalResponseModel': None, 'terminalResponseMode': None, 'observedFieldPaths': [],
        })
        self.assertNotIn('captured-castle-token', json.dumps(result))
        self.assertNotIn('Neutral test text.', json.dumps(result))
        self.assertTrue(connection.closed)
        self.assertEqual(fake.options['cookie'], 'sso=synthetic-cookie')
        self.assertEqual(fake.options['origin'], 'https://grok.com')

    def test_summarizes_only_source_model_fields_from_ack_and_terminal_frames(self):
        connection = FakeConnection(received=[
            json.dumps({'event': {'type': 'session.created', 'session': {'model': 'grok-4.7'}},
                        'session_id': 'server-issued-session'}),
            json.dumps({'event': {'type': 'response.completed',
                                  'response': {'model': 'grok-4.7', 'modelMode': 'fast'}}}),
        ])
        fake = FakeWebSocketModule(connection)
        old = sys.modules.get('websocket')
        sys.modules['websocket'] = fake
        try:
            result = TRANSPORT.run(packet())
        finally:
            if old is None:
                sys.modules.pop('websocket', None)
            else:
                sys.modules['websocket'] = old
        self.assertEqual(result['providerModelMetadata'], {
            'requestedSessionModel': 'grok-3',
            'sessionCreatedModel': 'grok-4.7',
            'terminalResponseModel': 'grok-4.7',
            'terminalResponseMode': 'fast',
            'observedFieldPaths': ['event.session.model', 'event.response.model', 'event.response.modelMode'],
        })
        self.assertEqual(result['terminalMetadata'], {
            'eventType': 'response.completed', 'responseStatus': None, 'responseStatusReason': None,
            'errorClass': None, 'errorCode': None,
            'responseFieldNames': ['model', 'modelMode'], 'errorFieldNames': [],
        })
        encoded = json.dumps(result)
        self.assertNotIn('private-conversation', encoded)
        self.assertNotIn('captured-castle-token', encoded)
        self.assertNotIn('Neutral test text.', encoded)

    def test_opaque_model_lookalikes_remain_unknown(self):
        connection = FakeConnection(received=[
            json.dumps({'event': {'type': 'session.created', 'session': {'model': 'session-0123456789abcdef'}},
                        'session_id': 'server-issued-session'}),
            json.dumps({'event': {'type': 'response.completed',
                                  'response': {'model': 'c_0123456789abcdef', 'modelMode': 'evt_1234567890abcdef'}}}),
        ])
        fake = FakeWebSocketModule(connection)
        old = sys.modules.get('websocket')
        sys.modules['websocket'] = fake
        try:
            result = TRANSPORT.run(packet())
        finally:
            if old is None:
                sys.modules.pop('websocket', None)
            else:
                sys.modules['websocket'] = old
        self.assertEqual(result['providerModelMetadata'], {
            'requestedSessionModel': 'grok-3', 'sessionCreatedModel': None,
            'terminalResponseModel': None, 'terminalResponseMode': None, 'observedFieldPaths': [],
        })

    def test_captures_conversation_attached_id_only_from_source_native_nested_path(self):
        conversations = set()
        responses = set()
        TRANSPORT.collect_id_hints({'event': {'type': 'conversation.attached',
                                               'conversation': {'id': 'native-conversation-id'}}},
                                   conversations, responses)
        self.assertEqual(conversations, {'native-conversation-id'})
        self.assertEqual(responses, set())
        conversations.clear()
        TRANSPORT.collect_id_hints({'event': {'type': 'response.completed',
                                               'conversation': {'id': 'unrelated-object-id'}}},
                                   conversations, responses)
        self.assertEqual(conversations, set())

    def test_terminal_error_metadata_keeps_status_class_and_field_names_but_not_messages(self):
        connection = FakeConnection(received=[
            json.dumps({'event': {'type': 'session.created', 'session': {'model': 'fast'}},
                        'session_id': 'server-issued-session'}),
            json.dumps({'event': {'type': 'response.error',
                                  'response': {'status': 'incomplete', 'status_details': {'reason': 'server_error'},
                                               'message': 'private response body'},
                                  'error': {'type': 'rate_limit_error', 'code': 'quota_exceeded',
                                            'message': 'private error body', 'token': 'private-token'}}}),
        ])
        fake = FakeWebSocketModule(connection)
        old = sys.modules.get('websocket')
        sys.modules['websocket'] = fake
        try:
            result = TRANSPORT.run(packet())
        finally:
            if old is None:
                sys.modules.pop('websocket', None)
            else:
                sys.modules['websocket'] = old
        self.assertEqual(result['terminalMetadata'], {
            'eventType': 'response.error', 'responseStatus': 'incomplete', 'responseStatusReason': 'server_error',
            'errorClass': 'rate_limit_error', 'errorCode': 'quota_exceeded',
            'responseFieldNames': ['message', 'status', 'status_details'],
            'errorFieldNames': ['code', 'message', 'token', 'type'],
        })
        encoded = json.dumps(result)
        self.assertNotIn('private response body', encoded)
        self.assertNotIn('private error body', encoded)
        self.assertNotIn('private-token', encoded)


if __name__ == '__main__':
    unittest.main()
