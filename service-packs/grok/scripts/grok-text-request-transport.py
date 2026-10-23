#!/usr/bin/env python3
"""Two-phase direct WSS transport for source-built Grok text requests.

The child sends the source-derived session.create control, returns the new
session.created ID over a bounded stdin/stdout pipe, and waits for Node to build
one Castle-prepared response.create frame for that ID. It never creates or
persists a token, prompt, URL, cookie, frame, or returned ID.
"""

import json
import re
import select
import ssl
import sys
import time
from urllib.parse import parse_qsl, urlsplit

MAX_START_LINE_BYTES = 256 * 1024
MAX_FRAME_BYTES = 4 * 1024 * 1024
MAX_CONTROL_BYTES = 64 * 1024
# A sanitized guarded native capture observed a genuine 5,941-character token.
# Accept bounded headroom while keeping the full event capped at 4 MiB.
MAX_TOKEN_BYTES = 8192
MAX_ID_HINTS = 32
EVENT_RE = re.compile(r'^[a-z][a-z0-9_.-]{0,95}$')
UUID4 = re.compile(r'^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$', re.I)
CONTROL_X_GROK_FIELDS = {
    'accept_interleaved_phases', 'client_side_toolsets', 'connector_ids', 'conversation_id', 'disable_artifact',
    'disable_text_follow_ups', 'enable_image_generation', 'enable_side_by_side', 'force_concise',
    'force_side_by_side', 'image_generation_count', 'initial_load_id', 'load_existing',
    'protocol_capabilities', 'use_chunk',
}
REQUEST_METADATA_HEADERS = {'x-statsig-id', 'x-xai-request-id'}
TERMINAL_EVENTS = {'response.completed', 'response.done', 'response.finished', 'response.error'}
ID_FIELDS = {
    'conversationId': 'conversation', 'conversation_id': 'conversation',
    'responseId': 'response', 'response_id': 'response',
}


def empty_result(*, handshake_status=0, control_count=0, ack=False):
    return {
        'handshakeStatus': int(handshake_status or 0),
        'normalControlFrameSentCount': int(control_count == 1),
        'serverSessionAcknowledgementObserved': bool(ack),
        'businessFrameBoundToServerSession': False,
        'businessFrameSentCount': 0,
        'eventTypes': [],
        'terminalEventObserved': False,
        'conversationIdHints': [],
        'responseIdHints': [],
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


def valid_text(value, max_bytes=MAX_FRAME_BYTES):
    return isinstance(value, str) and bool(value) and len(value.encode('utf-8')) <= max_bytes and not re.search(r'[\r\n\0]', value)


def validate_start(packet):
    expected = {'kind', 'socketUrl', 'cookieHeader', 'requestMetadataHeaders', 'controlFrameText', 'timeoutMs'}
    if not isinstance(packet, dict) or set(packet) != expected or packet.get('kind') != 'start':
        fail()
    if (not isinstance(packet['socketUrl'], str) or not isinstance(packet['cookieHeader'], str)
            or not isinstance(packet['controlFrameText'], str) or not isinstance(packet['timeoutMs'], int)
            or not 1000 <= packet['timeoutMs'] <= 600000):
        fail()
    if not isinstance(packet['requestMetadataHeaders'], dict):
        fail()
    for name, value in packet['requestMetadataHeaders'].items():
        if str(name).lower() not in REQUEST_METADATA_HEADERS or not valid_text(value, 2048):
            fail()
    control_bytes = packet['controlFrameText'].encode('utf-8')
    if not control_bytes or len(control_bytes) > MAX_CONTROL_BYTES:
        fail()
    url = urlsplit(packet['socketUrl'])
    query = parse_qsl(url.query, keep_blank_values=True)
    if (url.scheme != 'wss' or url.hostname != 'grok.com' or url.port is not None or url.username or url.password
            or url.path != '/ws/mgw/' or url.fragment or len(query) != 1 or query[0][0] != 'uid' or not query[0][1]):
        fail()
    cookie = packet['cookieHeader']
    if (not cookie.startswith('sso=') or ';' in cookie or not valid_text(cookie, 16384)
            or not cookie[4:]):
        fail()
    try:
        control = json.loads(control_bytes.decode('utf-8'))
    except Exception:
        fail()
    event = control.get('event') if isinstance(control, dict) else None
    session = event.get('session') if isinstance(event, dict) else None
    x_grok = session.get('x_grok') if isinstance(session, dict) else None
    if (not isinstance(control, dict) or set(control) != {'event'}
            or not isinstance(event, dict) or set(event) != {'event_id', 'session', 'type'}
            or event.get('type') != 'session.create'
            or not isinstance(event.get('event_id'), str) or not event['event_id'].startswith('evt_init_')
            or not UUID4.fullmatch(event['event_id'][len('evt_init_'):])
            or not isinstance(session, dict) or set(session) not in ({'model'}, {'model', 'x_grok'})
            or not valid_text(session.get('model'), 128)
            or contains_workspace_target(control)):
        fail()
    if x_grok is not None:
        if (not isinstance(x_grok, dict) or not set(x_grok).issubset(CONTROL_X_GROK_FIELDS)
                or ('conversation_id' in x_grok and x_grok['conversation_id'] is not None)
                or ('initial_load_id' in x_grok and x_grok['initial_load_id'] is not None)
                or ('load_existing' in x_grok and x_grok['load_existing'] is not False)
                or ('enable_image_generation' in x_grok and x_grok['enable_image_generation'] is not False)
                or ('image_generation_count' in x_grok and x_grok['image_generation_count'] != 0)
                or ('connector_ids' in x_grok and (not isinstance(x_grok['connector_ids'], list)
                    or len(x_grok['connector_ids']) > 64
                    or any(not valid_text(item, 512) for item in x_grok['connector_ids'])))):
            fail()
    return control


def read_line(timeout_seconds, max_bytes):
    ready, _, _ = select.select([sys.stdin.buffer], [], [], timeout_seconds)
    if not ready:
        return None
    line = sys.stdin.buffer.readline(max_bytes + 1)
    if len(line) > max_bytes or not line.endswith(b'\n'):
        fail()
    try:
        return json.loads(line[:-1].decode('utf-8'))
    except Exception:
        fail()


def emit(value, output=None):
    output = output or sys.stdout
    output.write(json.dumps(value, separators=(',', ':'), ensure_ascii=False) + '\n')
    output.flush()


def validate_business_command(command, session_id):
    if not isinstance(command, dict) or set(command) != {'kind', 'frameText'} or command.get('kind') != 'business_frame':
        fail()
    frame_text = command.get('frameText')
    if not isinstance(frame_text, str):
        fail()
    raw = frame_text.encode('utf-8')
    if not raw or len(raw) > MAX_FRAME_BYTES:
        fail()
    try:
        frame = json.loads(raw.decode('utf-8'))
    except Exception:
        fail()
    event = frame.get('event') if isinstance(frame, dict) else None
    item = event.get('item') if isinstance(event, dict) else None
    x_grok = item.get('x_grok') if isinstance(item, dict) else None
    chunks = x_grok.get('input_chunks') if isinstance(x_grok, dict) else None
    if (not isinstance(frame, dict) or set(frame) != {'session_id', 'event'} or frame.get('session_id') != session_id
            or not isinstance(event, dict) or set(event) != {'castle_request_token', 'event_id', 'item', 'type'}
            or event.get('type') != 'response.create'
            or not isinstance(event.get('event_id'), str) or not UUID4.fullmatch(event['event_id'])
            or not valid_text(event.get('castle_request_token'), MAX_TOKEN_BYTES)
            or not isinstance(item, dict) or set(item) != {'type', 'role', 'x_grok'}
            or item.get('type') != 'message' or item.get('role') != 'user'
            or not isinstance(x_grok, dict) or set(x_grok) != {'client_message_id', 'input_chunks'}
            or not isinstance(x_grok.get('client_message_id'), str) or not UUID4.fullmatch(x_grok['client_message_id'])
            or not isinstance(chunks, list) or len(chunks) != 1
            or not isinstance(chunks[0], dict) or set(chunks[0]) != {'text'}
            or not isinstance(chunks[0]['text'], dict) or set(chunks[0]['text']) != {'text'}
            or not valid_text(chunks[0]['text']['text'], MAX_FRAME_BYTES)
            or contains_workspace_target(frame)):
        fail()
    return frame, frame_text


def collect_id_hints(value, conversations, responses, depth=0):
    if depth > 24 or len(conversations) + len(responses) >= MAX_ID_HINTS:
        return
    if isinstance(value, dict):
        for key, child in value.items():
            category = ID_FIELDS.get(key)
            if category and isinstance(child, str) and child and len(child) <= 512 and not re.search(r'[\r\n\0]', child):
                (conversations if category == 'conversation' else responses).add(child)
            collect_id_hints(child, conversations, responses, depth + 1)
            if len(conversations) + len(responses) >= MAX_ID_HINTS:
                return
    elif isinstance(value, list):
        for child in value[:256]:
            collect_id_hints(child, conversations, responses, depth + 1)
            if len(conversations) + len(responses) >= MAX_ID_HINTS:
                return


def run(packet, websocket_module=None, read_business_command=None, emit_message=None):
    try:
        validate_start(packet)
    except Exception:
        return empty_result()
    if websocket_module is None:
        import websocket as websocket_module
    read_business_command = read_business_command or (lambda timeout, max_bytes: read_line(timeout, max_bytes))
    emit_message = emit_message or (lambda value: emit(value))
    connection = None
    handshake_status = 0
    control_count = 0
    ack_seen = False
    business_bound = False
    business_count = 0
    event_types = set()
    conversation_hints = set()
    response_hints = set()
    terminal = False
    try:
        headers = [f'{name}: {value}' for name, value in packet['requestMetadataHeaders'].items()]
        connection = websocket_module.create_connection(
            packet['socketUrl'],
            cookie=packet['cookieHeader'],
            origin='https://grok.com',
            header=headers,
            timeout=15,
            enable_multithread=True,
            sslopt={'cert_reqs': ssl.CERT_REQUIRED, 'check_hostname': True},
        )
        handshake = getattr(connection, 'handshake_response', None)
        handshake_status = getattr(handshake, 'status', 0)
        if handshake_status != 101 or not bool(getattr(connection, 'connected', False)):
            return empty_result(handshake_status=handshake_status)
        connection.settimeout(1)
        connection.send(packet['controlFrameText'], opcode=websocket_module.ABNF.OPCODE_TEXT)
        control_count = 1
        ack_deadline = time.monotonic() + min(20.0, packet['timeoutMs'] / 1000)
        server_session_id = None
        while time.monotonic() < ack_deadline:
            try:
                raw = connection.recv()
            except websocket_module.WebSocketTimeoutException:
                continue
            except websocket_module.WebSocketConnectionClosedException:
                break
            if not isinstance(raw, str):
                continue
            try:
                received = json.loads(raw)
            except Exception:
                continue
            event = received.get('event') if isinstance(received, dict) else None
            event_type = event.get('type') if isinstance(event, dict) else None
            if isinstance(event_type, str) and EVENT_RE.fullmatch(event_type):
                event_types.add(event_type)
            if event_type == 'session.created' and valid_text(received.get('session_id'), 512):
                server_session_id = received['session_id']
                ack_seen = True
                emit_message({
                    'kind': 'session_ack',
                    'handshakeStatus': 101,
                    'normalControlFrameSentCount': control_count,
                    'serverSessionAcknowledgementObserved': True,
                    'sessionId': server_session_id,
                })
                break
        if not ack_seen:
            return {**empty_result(handshake_status=handshake_status, control_count=control_count),
                    'eventTypes': sorted(event_types)[:128]}

        command = read_business_command(min(5.0, max(2.0, packet['timeoutMs'] / 1000)), MAX_FRAME_BYTES + 1024)
        if not isinstance(command, dict) or command.get('kind') == 'abort':
            return {**empty_result(handshake_status=handshake_status, control_count=control_count, ack=True),
                    'eventTypes': sorted(event_types)[:128]}
        try:
            frame, frame_text = validate_business_command(command, server_session_id)
        except Exception:
            return {**empty_result(handshake_status=handshake_status, control_count=control_count, ack=True),
                    'eventTypes': sorted(event_types)[:128]}
        business_bound = frame['session_id'] == server_session_id
        if not business_bound:
            return {**empty_result(handshake_status=handshake_status, control_count=control_count, ack=True),
                    'eventTypes': sorted(event_types)[:128]}
        connection.send(frame_text, opcode=websocket_module.ABNF.OPCODE_TEXT)
        business_count = 1

        response_deadline = time.monotonic() + packet['timeoutMs'] / 1000
        while time.monotonic() < response_deadline:
            try:
                raw = connection.recv()
            except websocket_module.WebSocketTimeoutException:
                continue
            except websocket_module.WebSocketConnectionClosedException:
                break
            if not isinstance(raw, str):
                continue
            try:
                received = json.loads(raw)
            except Exception:
                continue
            event = received.get('event') if isinstance(received, dict) else None
            event_type = event.get('type') if isinstance(event, dict) else None
            if isinstance(event_type, str) and EVENT_RE.fullmatch(event_type):
                event_types.add(event_type)
                if event_type in TERMINAL_EVENTS:
                    terminal = True
            collect_id_hints(received, conversation_hints, response_hints)
            if terminal:
                break
    except Exception:
        pass
    finally:
        if connection is not None:
            try:
                connection.close(status=1000, reason='')
            except Exception:
                try: connection.close()
                except Exception: pass
    return {
        'handshakeStatus': int(handshake_status or 0),
        'normalControlFrameSentCount': int(control_count == 1),
        'serverSessionAcknowledgementObserved': ack_seen,
        'businessFrameBoundToServerSession': business_bound,
        'businessFrameSentCount': int(business_count == 1),
        'eventTypes': sorted(event_types)[:128],
        'terminalEventObserved': terminal,
        'conversationIdHints': sorted(conversation_hints)[:MAX_ID_HINTS],
        'responseIdHints': sorted(response_hints)[:MAX_ID_HINTS],
    }


def read_start_packet():
    raw = sys.stdin.buffer.readline(MAX_START_LINE_BYTES + 1)
    if len(raw) > MAX_START_LINE_BYTES or not raw.endswith(b'\n'):
        fail()
    try:
        return json.loads(raw[:-1].decode('utf-8'))
    except Exception:
        fail()


def read_business_packet(timeout, max_bytes):
    return read_line(timeout, max_bytes)


def main():
    try:
        packet = read_start_packet()
        result = run(packet, read_business_command=read_business_packet, emit_message=emit)
        emit({'kind': 'result', 'result': result})
    except Exception:
        emit({'kind': 'result', 'result': empty_result(), 'errorCode': 'REQUEST_REJECTED'})
        raise SystemExit(2)


if __name__ == '__main__':
    main()
