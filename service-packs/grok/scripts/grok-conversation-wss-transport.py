#!/usr/bin/env python3
"""One direct Grok WSS response.create send bound to a fresh server session."""

import json
import re
import ssl
import sys
import time
from urllib.parse import parse_qsl, urlsplit

MAX_PACKET_BYTES = 8 * 1024 * 1024
MAX_FRAME_BYTES = 4 * 1024 * 1024
MAX_CONTROL_BYTES = 64 * 1024
EVENT_RE = re.compile(r'^[a-z][a-z0-9_.-]{0,95}$')
CONTROL_FIELDS = {
    'accept_interleaved_phases', 'active_response_id', 'client_side_toolsets', 'connector_ids',
    'conversation_id', 'disable_artifact', 'disable_text_follow_ups', 'enable_image_generation',
    'enable_side_by_side', 'force_concise', 'force_side_by_side', 'image_generation_count',
    'initial_leaf_id', 'initial_load_id', 'load_existing', 'protocol_capabilities', 'use_chunk',
}


def fail():
    raise ValueError('REQUEST_REJECTED')


def contains_workspace_target(value, depth=0):
    if depth > 24:
        return True
    if isinstance(value, dict):
        return any('workspace' in str(key).lower() or contains_workspace_target(child, depth + 1)
                   for key, child in value.items())
    if isinstance(value, list):
        return any(contains_workspace_target(child, depth + 1) for child in value[:512])
    return False


def event_type(frame):
    event = frame.get('event') if isinstance(frame, dict) else None
    value = event.get('type') if isinstance(event, dict) else None
    return value if isinstance(value, str) and EVENT_RE.fullmatch(value) else None


def validate(packet):
    expected = {'socketUrl', 'cookieHeader', 'controlFrameText', 'frameText', 'timeoutMs',
                'conversationId', 'parentResponseId', 'responseIds'}
    if not isinstance(packet, dict) or set(packet) != expected:
        fail()
    if (not isinstance(packet['socketUrl'], str) or not isinstance(packet['cookieHeader'], str)
            or not isinstance(packet['controlFrameText'], str) or not isinstance(packet['frameText'], str)
            or not isinstance(packet['timeoutMs'], int) or not 1000 <= packet['timeoutMs'] <= 600000
            or not isinstance(packet['conversationId'], str) or not packet['conversationId']
            or not isinstance(packet['parentResponseId'], str) or not packet['parentResponseId']
            or not isinstance(packet['responseIds'], list) or not packet['responseIds']
            or len(packet['responseIds']) > 500
            or any(not isinstance(value, str) or not value or len(value) > 512 for value in packet['responseIds'])):
        fail()
    url = urlsplit(packet['socketUrl'])
    query = parse_qsl(url.query, keep_blank_values=True)
    if (url.scheme != 'wss' or url.hostname != 'grok.com' or url.port is not None or url.username or url.password
            or url.path != '/ws/mgw/' or url.fragment or len(query) != 1 or query[0][0] != 'uid' or not query[0][1]):
        fail()
    cookie = packet['cookieHeader']
    if (not cookie.startswith('sso=') or ';' in cookie or any(ch in cookie for ch in '\r\n\0')
            or not cookie[4:] or len(cookie[4:]) > 16384):
        fail()
    control_bytes = packet['controlFrameText'].encode('utf-8')
    frame_bytes = packet['frameText'].encode('utf-8')
    if (not control_bytes or len(control_bytes) > MAX_CONTROL_BYTES or not frame_bytes or len(frame_bytes) > MAX_FRAME_BYTES):
        fail()
    try:
        control = json.loads(control_bytes.decode('utf-8'))
        frame = json.loads(frame_bytes.decode('utf-8'))
    except Exception:
        fail()
    event = control.get('event') if isinstance(control, dict) else None
    session = event.get('session') if isinstance(event, dict) else None
    x_grok = session.get('x_grok') if isinstance(session, dict) else None
    if (not isinstance(control, dict) or set(control) not in ({'event'}, {'event', 'session_id'})
            or ('session_id' in control and not isinstance(control['session_id'], str))
            or not isinstance(event, dict) or set(event) != {'event_id', 'session', 'type'}
            or event.get('type') != 'session.create' or not isinstance(event.get('event_id'), str) or not event['event_id']
            or not isinstance(session, dict) or set(session) != {'model', 'x_grok'}
            or not isinstance(session.get('model'), str) or not isinstance(x_grok, dict)
            or not set(x_grok).issubset(CONTROL_FIELDS)
            or x_grok.get('conversation_id') != packet['conversationId']
            or x_grok.get('load_existing') is not True
            or x_grok.get('active_response_id') not in packet['responseIds']
            or x_grok.get('initial_leaf_id') not in packet['responseIds']
            or contains_workspace_target(control)):
        fail()
    frame_event = frame.get('event') if isinstance(frame, dict) else None
    parent_response_id = frame_event.get('parent_response_id', frame_event.get('parentResponseId')) if isinstance(frame_event, dict) else None
    token = frame_event.get('castle_request_token') if isinstance(frame_event, dict) else None
    if (not isinstance(frame, dict) or not isinstance(frame.get('session_id'), str) or not frame['session_id']
            or not isinstance(frame_event, dict) or frame_event.get('type') != 'response.create'
            or not isinstance(frame_event.get('event_id'), str) or not frame_event['event_id']
            or not isinstance(token, str) or not token.strip() or len(token.encode('utf-8')) > 8192 or re.search(r'[\r\n\0]', token)
            or parent_response_id != packet['parentResponseId'] or contains_workspace_target(frame)):
        fail()
    return control, frame


def run(packet):
    control, frame = validate(packet)
    import websocket
    connection = None
    handshake_status = 0
    control_sent = 0
    business_sent = 0
    session_acknowledged = False
    session_bound = False
    terminal = False
    event_types = set()
    try:
        connection = websocket.create_connection(
            packet['socketUrl'],
            cookie=packet['cookieHeader'],
            origin='https://grok.com',
            timeout=15,
            enable_multithread=True,
            sslopt={'cert_reqs': ssl.CERT_REQUIRED, 'check_hostname': True},
        )
        handshake = getattr(connection, 'handshake_response', None)
        handshake_status = getattr(handshake, 'status', 0)
        if handshake_status != 101 or not bool(getattr(connection, 'connected', False)):
            return {'handshakeStatus': int(handshake_status or 0), 'controlFrameSent': False,
                    'serverSessionAcknowledgementObserved': False, 'businessFrameBoundToServerSession': False,
                    'capturedSessionIdMatchedAcknowledgement': False,
                    'businessFrameSent': False, 'terminalEventObserved': False, 'eventTypes': []}
        connection.settimeout(4)
        connection.send(packet['controlFrameText'], opcode=websocket.ABNF.OPCODE_TEXT)
        control_sent = 1
        server_session_id = None
        deadline = time.monotonic() + min(20, packet['timeoutMs'] / 1000)
        while time.monotonic() < deadline:
            try:
                raw = connection.recv()
            except websocket.WebSocketTimeoutException:
                continue
            except websocket.WebSocketConnectionClosedException:
                break
            if not isinstance(raw, str):
                continue
            try:
                received = json.loads(raw)
            except Exception:
                continue
            kind = event_type(received)
            if kind:
                event_types.add(kind)
            if kind == 'session.created' and isinstance(received.get('session_id'), str) and received['session_id']:
                server_session_id = received['session_id']
                session_acknowledged = True
                break
        if not session_acknowledged:
            return {'handshakeStatus': handshake_status, 'controlFrameSent': control_sent == 1,
                    'serverSessionAcknowledgementObserved': False, 'businessFrameBoundToServerSession': False,
                    'capturedSessionIdMatchedAcknowledgement': False,
                    'businessFrameSent': False, 'terminalEventObserved': False, 'eventTypes': sorted(event_types)[:128]}
        captured_session_id = frame['session_id']
        frame['session_id'] = server_session_id
        session_bound = frame['session_id'] == server_session_id
        captured_id_matches_ack = captured_session_id == server_session_id
        if not session_bound:
            return {'handshakeStatus': handshake_status, 'controlFrameSent': control_sent == 1,
                    'serverSessionAcknowledgementObserved': True, 'businessFrameBoundToServerSession': False,
                    'capturedSessionIdMatchedAcknowledgement': captured_id_matches_ack,
                    'businessFrameSent': False, 'terminalEventObserved': False, 'eventTypes': sorted(event_types)[:128]}
        connection.send(json.dumps(frame, separators=(',', ':'), ensure_ascii=False), opcode=websocket.ABNF.OPCODE_TEXT)
        business_sent = 1
        deadline = time.monotonic() + packet['timeoutMs'] / 1000
        while time.monotonic() < deadline:
            try:
                raw = connection.recv()
            except websocket.WebSocketTimeoutException:
                continue
            except websocket.WebSocketConnectionClosedException:
                break
            if not isinstance(raw, str):
                continue
            try:
                received = json.loads(raw)
            except Exception:
                continue
            kind = event_type(received)
            if kind:
                event_types.add(kind)
                if kind in {'response.done', 'response.completed', 'response.finished', 'response.error'}:
                    terminal = True
                    break
    except Exception:
        pass
    finally:
        if connection is not None:
            try:
                connection.close(status=1000, reason='')
            except Exception:
                try:
                    connection.close()
                except Exception:
                    pass
    return {'handshakeStatus': int(handshake_status or 0), 'controlFrameSent': control_sent == 1,
            'serverSessionAcknowledgementObserved': session_acknowledged,
            'businessFrameBoundToServerSession': session_bound,
            'capturedSessionIdMatchedAcknowledgement': captured_id_matches_ack if session_acknowledged else False,
            'businessFrameSent': business_sent == 1,
            'terminalEventObserved': terminal, 'eventTypes': sorted(event_types)[:128]}


def main():
    raw = sys.stdin.buffer.read(MAX_PACKET_BYTES + 1)
    if len(raw) > MAX_PACKET_BYTES:
        fail()
    packet = json.loads(raw.decode('utf-8'))
    result = run(packet)
    sys.stdout.write(json.dumps(result, separators=(',', ':')))


if __name__ == '__main__':
    try:
        main()
    except Exception:
        sys.stdout.write('{"handshakeStatus":0,"controlFrameSent":false,"serverSessionAcknowledgementObserved":false,"businessFrameBoundToServerSession":false,"capturedSessionIdMatchedAcknowledgement":false,"businessFrameSent":false,"terminalEventObserved":false,"eventTypes":[]}')
        raise SystemExit(2)
