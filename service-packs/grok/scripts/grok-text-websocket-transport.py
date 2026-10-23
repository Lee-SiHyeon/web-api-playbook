import json
import re
import sys
import time
from urllib.parse import parse_qsl, urlsplit

MAX_PACKET_BYTES = 6 * 1024 * 1024
MAX_FRAME_BYTES = 4 * 1024 * 1024
MAX_CONTROL_FRAME_BYTES = 64 * 1024
MAX_HINTS = 32
EVENT_RE = re.compile(r'^[a-z][a-z0-9_.-]{0,95}$')
MODEL_CODE = re.compile(r'^(?:auto|fast|expert|heavy|build|grok-[a-z0-9]+(?:[._:-][a-z0-9]+)*)$')
ALLOWED_HINT_KEYS = {'conversationId', 'conversation_id', 'responseId', 'response_id'}
TERMINAL_EVENTS = {'response.completed', 'response.done', 'response.finished', 'response.error'}
SAFE_TERMINAL_ATOM = re.compile(r'^[A-Za-z][A-Za-z0-9_.:-]{0,95}$')
CONTROL_X_GROK_FIELDS = {
    'accept_interleaved_phases', 'client_side_toolsets', 'connector_ids', 'conversation_id', 'disable_artifact',
    'disable_text_follow_ups', 'enable_image_generation', 'enable_side_by_side', 'force_concise',
    'force_side_by_side', 'image_generation_count', 'initial_load_id', 'load_existing',
    'protocol_capabilities', 'use_chunk',
}


def contains_workspace_target(value, depth=0):
    if depth > 24:
        return True
    if isinstance(value, dict):
        return any('workspace' in str(key).lower() or contains_workspace_target(child, depth + 1)
                   for key, child in value.items())
    if isinstance(value, list):
        return any(contains_workspace_target(child, depth + 1) for child in value[:512])
    return False


def text_leaves(value, depth=0):
    if depth > 24:
        return []
    if isinstance(value, dict):
        found = []
        for key, child in value.items():
            if key in {'text', 'message'} and isinstance(child, str):
                found.append(child)
            else:
                found.extend(text_leaves(child, depth + 1))
            if len(found) >= 128:
                return found[:128]
        return found
    if isinstance(value, list):
        found = []
        for child in value[:512]:
            found.extend(text_leaves(child, depth + 1))
            if len(found) >= 128:
                return found[:128]
        return found
    return []


def fail():
    raise ValueError('REQUEST_REJECTED')


def valid_initial_load_id(value):
    if value is None or value == '':
        return True
    if not isinstance(value, str) or re.search(r'[\r\n\0]', value):
        return False
    try:
        return len(value.encode('utf-8')) <= 512
    except UnicodeEncodeError:
        return False


def validate(packet):
    if not isinstance(packet, dict) or set(packet) != {
            'socketUrl', 'cookieHeader', 'controlFrameText', 'frameText', 'expectedFileAttachmentIds',
            'expectedConversationId', 'timeoutMs'}:
        fail()
    if (not isinstance(packet['socketUrl'], str) or not isinstance(packet['cookieHeader'], str)
            or not isinstance(packet['controlFrameText'], str) or not isinstance(packet['frameText'], str)
            or not isinstance(packet['expectedFileAttachmentIds'], list) or len(packet['expectedFileAttachmentIds']) > 64
            or any(not isinstance(item, str) or not 16 <= len(item) <= 512
                   or re.search(r'[\r\n\0]', item) for item in packet['expectedFileAttachmentIds'])
            or len(set(packet['expectedFileAttachmentIds'])) != len(packet['expectedFileAttachmentIds'])
            or packet['expectedConversationId'] is not None
            and (not isinstance(packet['expectedConversationId'], str)
                 or not 16 <= len(packet['expectedConversationId']) <= 512
                 or re.search(r'[\r\n\0]', packet['expectedConversationId']))
            or not isinstance(packet['timeoutMs'], int) or packet['timeoutMs'] < 1000 or packet['timeoutMs'] > 600000):
        fail()
    control_bytes = packet['controlFrameText'].encode('utf-8')
    frame_bytes = packet['frameText'].encode('utf-8')
    if not control_bytes or len(control_bytes) > MAX_CONTROL_FRAME_BYTES or not frame_bytes or len(frame_bytes) > MAX_FRAME_BYTES:
        fail()
    url = urlsplit(packet['socketUrl'])
    query = parse_qsl(url.query, keep_blank_values=True)
    if (url.scheme != 'wss' or url.hostname != 'grok.com' or url.port is not None or url.username or url.password
            or url.path != '/ws/mgw/' or url.fragment or len(query) != 1 or query[0][0] != 'uid' or not query[0][1]):
        fail()
    cookie = packet['cookieHeader']
    if (not cookie.startswith('sso=') or ';' in cookie or '\r' in cookie or '\n' in cookie or '\0' in cookie
            or not cookie[4:] or len(cookie[4:]) > 16384):
        fail()
    try:
        control_frame = json.loads(packet['controlFrameText'])
        frame = json.loads(packet['frameText'])
    except Exception:
        fail()
    control_event = control_frame.get('event') if isinstance(control_frame, dict) else None
    control_session = control_event.get('session') if isinstance(control_event, dict) else None
    control_xgrok = control_session.get('x_grok') if isinstance(control_session, dict) else None
    control_top_keys = set(control_frame) if isinstance(control_frame, dict) else set()
    event_only_control = control_top_keys == {'event'}
    session_id_control = (control_top_keys == {'event', 'session_id'}
                          and isinstance(control_frame.get('session_id'), str) and bool(control_frame['session_id']))
    session_keys = set(control_session) if isinstance(control_session, dict) else set()
    model_only_control = session_keys == {'model'}
    xgrok_session_control = session_keys == {'model', 'x_grok'} and isinstance(control_xgrok, dict)
    observed_xgrok_subset = (xgrok_session_control
                             and set(control_xgrok).issubset(CONTROL_X_GROK_FIELDS)
                             and ('conversation_id' not in control_xgrok
                                  or control_xgrok['conversation_id'] is None
                                  or isinstance(control_xgrok['conversation_id'], str))
                             and ('initial_load_id' not in control_xgrok
                                  or valid_initial_load_id(control_xgrok['initial_load_id']))
                             and ('connector_ids' not in control_xgrok
                                  or isinstance(control_xgrok['connector_ids'], list)
                                  and all(isinstance(item, str) and item and len(item) <= 512
                                          and not re.search(r'[\r\n\0]', item) for item in control_xgrok['connector_ids']))
                             and ('load_existing' not in control_xgrok
                                  or isinstance(control_xgrok['load_existing'], bool)))
    if (not isinstance(control_frame, dict) or not (event_only_control or session_id_control)
            or not isinstance(control_event, dict) or set(control_event) != {'event_id', 'session', 'type'}
            or control_event.get('type') != 'session.create'
            or not isinstance(control_event.get('event_id'), str) or not control_event['event_id']
            or not isinstance(control_session, dict) or not isinstance(control_session.get('model'), str)
            or not (model_only_control or observed_xgrok_subset)
            or contains_workspace_target(control_frame)):
        fail()
    if packet['expectedConversationId'] is None:
        if isinstance(control_xgrok, dict) and control_xgrok.get('load_existing') is True:
            fail()
    elif (not isinstance(control_xgrok, dict)
          or control_xgrok.get('conversation_id') != packet['expectedConversationId']
          or control_xgrok.get('load_existing') is not True):
        fail()
    event = frame.get('event') if isinstance(frame, dict) else None
    item = event.get('item') if isinstance(event, dict) else None
    xgrok = item.get('x_grok') if isinstance(item, dict) else None
    chunks = xgrok.get('input_chunks') if isinstance(xgrok, dict) else None
    chunk_texts = [text for chunk in chunks for text in text_leaves(chunk)] if isinstance(chunks, list) else []
    if (not isinstance(frame.get('session_id'), str) or not frame['session_id']
            or not isinstance(event, dict) or event.get('type') != 'response.create'
            or set(event) not in ({'event_id', 'type', 'castle_request_token', 'item'},
                                  {'event_id', 'type', 'castle_request_token', 'item', 'file_attachment_ids'})
            or not isinstance(event.get('event_id'), str) or not event['event_id']
            or not isinstance(event.get('castle_request_token'), str) or not event['castle_request_token']
            or not isinstance(item, dict) or item.get('type') != 'message' or item.get('role') != 'user'
            or set(item) not in ({'type', 'role', 'x_grok'}, {'type', 'role', 'x_grok', 'file_attachment_ids'})
            or not isinstance(xgrok, dict) or not isinstance(xgrok.get('client_message_id'), str) or not xgrok['client_message_id']
            or not isinstance(chunks, list) or not chunks or len(chunks) > 32
            or any(not isinstance(chunk, dict) or not text_leaves(chunk) for chunk in chunks)
            or not chunk_texts or any(not text.strip() for text in chunk_texts)):
        fail()
    def captured_ids(value):
        if value is None:
            return None
        if (not isinstance(value, list) or not 1 <= len(value) <= 64
                or any(not isinstance(item, str) or not 16 <= len(item) <= 512
                       or re.search(r'[\r\n\0]', item) for item in value)
                or len(set(value)) != len(value)):
            fail()
        return value

    event_file_ids = captured_ids(event.get('file_attachment_ids'))
    item_file_ids = captured_ids(item.get('file_attachment_ids'))
    if event_file_ids is not None and item_file_ids is not None and event_file_ids != item_file_ids:
        fail()
    captured_file_ids = event_file_ids if event_file_ids is not None else item_file_ids or []
    if captured_file_ids != packet['expectedFileAttachmentIds']:
        fail()
    if contains_workspace_target(frame):
        fail()
    if any(text in packet['controlFrameText'] for text in chunk_texts):
        fail()
    return control_frame, frame


def collect_id_hints(value, conversations, responses, depth=0):
    if depth > 24 or len(conversations) + len(responses) >= MAX_HINTS:
        return
    if isinstance(value, dict):
        # Current GatewaySession.handleServerEvent consumes this exact first-party
        # shape: conversation.attached -> event.conversation.id.
        event = value.get('event')
        if isinstance(event, dict) and event.get('type') == 'conversation.attached':
            conversation = event.get('conversation')
            conversation_id = conversation.get('id') if isinstance(conversation, dict) else None
            if isinstance(conversation_id, str) and conversation_id and len(conversation_id) <= 512 \
                    and not re.search(r'[\r\n\0]', conversation_id):
                conversations.add(conversation_id)
                if len(conversations) + len(responses) >= MAX_HINTS:
                    return
        for key, child in value.items():
            if key in ALLOWED_HINT_KEYS and isinstance(child, str) and child and len(child) <= 512 and not re.search(r'[\r\n\0]', child):
                (conversations if key in {'conversationId', 'conversation_id'} else responses).add(child)
            collect_id_hints(child, conversations, responses, depth + 1)
            if len(conversations) + len(responses) >= MAX_HINTS:
                return


def safe_model_code(value):
    return value if isinstance(value, str) and len(value) <= 64 and MODEL_CODE.fullmatch(value) else None


def update_provider_model_metadata(event_type, event, metadata):
    if not isinstance(event, dict):
        return
    if event_type == 'session.created':
        session = event.get('session')
        candidates = []
        if isinstance(session, dict) and 'model' in session:
            candidates.append(('event.session.model', session.get('model')))
        if 'model' in event:
            candidates.append(('event.model', event.get('model')))
        for path, value in candidates:
            model = safe_model_code(value)
            if model is not None:
                metadata['sessionCreatedModel'] = model
                if path not in metadata['observedFieldPaths']:
                    metadata['observedFieldPaths'].append(path)
                break
    if event_type in TERMINAL_EVENTS:
        response = event.get('response')
        if not isinstance(response, dict):
            return
        for key, output_key, path in (
            ('model', 'terminalResponseModel', 'event.response.model'),
            ('modelMode', 'terminalResponseMode', 'event.response.modelMode'),
            ('model_mode', 'terminalResponseMode', 'event.response.model_mode'),
        ):
            if metadata.get(output_key) is not None:
                continue
            model = safe_model_code(response.get(key))
            if model is not None:
                metadata[output_key] = model
                if path not in metadata['observedFieldPaths']:
                    metadata['observedFieldPaths'].append(path)


def safe_terminal_atom(value):
    return value if isinstance(value, str) and SAFE_TERMINAL_ATOM.fullmatch(value) else None


def terminal_event_metadata(event_type, event):
    if event_type not in TERMINAL_EVENTS or not isinstance(event, dict):
        return None
    response = event.get('response') if isinstance(event.get('response'), dict) else {}
    status_details = response.get('status_details') if isinstance(response.get('status_details'), dict) else {}
    error = event.get('error') if isinstance(event.get('error'), dict) else {}
    error_class = safe_terminal_atom(error.get('type') or error.get('class') or error.get('name'))
    error_code = safe_terminal_atom(error.get('code'))
    response_fields = sorted(key for key in response if isinstance(key, str) and re.fullmatch(r'[A-Za-z][A-Za-z0-9_.-]{0,63}', key))[:64]
    error_fields = sorted(key for key in error if isinstance(key, str) and re.fullmatch(r'[A-Za-z][A-Za-z0-9_.-]{0,63}', key))[:32]
    return {
        'eventType': event_type,
        'responseStatus': safe_terminal_atom(response.get('status') or event.get('status')),
        'responseStatusReason': safe_terminal_atom(status_details.get('reason')),
        'errorClass': error_class,
        'errorCode': error_code,
        'responseFieldNames': response_fields,
        'errorFieldNames': error_fields,
    }
def run(packet):
    control_frame, frame = validate(packet)
    request_session_model = safe_model_code(control_frame.get('event', {}).get('session', {}).get('model'))
    model_metadata = {
        'requestedSessionModel': request_session_model,
        'sessionCreatedModel': None,
        'terminalResponseModel': None,
        'terminalResponseMode': None,
        'observedFieldPaths': [],
    }
    import websocket
    connection = None
    handshake_status = 0
    control_sent_count = 0
    business_sent_count = 0
    session_acknowledged = False
    business_bound_to_server_session = False
    event_types = set()
    conversation_id_hints = set()
    response_id_hints = set()
    terminal = False
    terminal_metadata = None
    try:
        connection = websocket.create_connection(
            packet['socketUrl'],
            cookie=packet['cookieHeader'],
            origin='https://grok.com',
            timeout=15,
            enable_multithread=True,
        )
        response = getattr(connection, 'handshake_response', None)
        handshake_status = getattr(response, 'status', 0)
        if handshake_status != 101 or not bool(getattr(connection, 'connected', False)):
            return {'handshakeStatus': int(handshake_status or 0), 'normalControlFrameSentCount': 0,
                    'serverSessionAcknowledgementObserved': False, 'businessFrameBoundToServerSession': False,
                    'businessFrameSentCount': 0, 'eventTypes': [], 'terminalEventObserved': False,
                    'conversationIdHints': [], 'responseIdHints': [], 'providerModelMetadata': model_metadata,
                    'terminalMetadata': None}
        connection.settimeout(8)

        # First replay only the exact normal-browser negotiation control frame.
        connection.send(packet['controlFrameText'], opcode=websocket.ABNF.OPCODE_TEXT)
        control_sent_count = 1
        control_deadline = time.monotonic() + min(20, packet['timeoutMs'] / 1000)
        server_session_id = None
        while time.monotonic() < control_deadline:
            try:
                message = connection.recv()
            except websocket.WebSocketTimeoutException:
                continue
            except websocket.WebSocketConnectionClosedException:
                break
            if not isinstance(message, str):
                continue
            try:
                parsed = json.loads(message)
            except Exception:
                continue
            event = parsed.get('event') if isinstance(parsed, dict) else None
            event_type = event.get('type') if isinstance(event, dict) else None
            if isinstance(event_type, str) and EVENT_RE.fullmatch(event_type):
                event_types.add(event_type)
            update_provider_model_metadata(event_type, event, model_metadata)
            if event_type == 'session.created' and isinstance(parsed.get('session_id'), str) and parsed['session_id']:
                server_session_id = parsed['session_id']
                session_acknowledged = True
                break
        if not session_acknowledged:
            return {'handshakeStatus': handshake_status, 'normalControlFrameSentCount': control_sent_count,
                    'serverSessionAcknowledgementObserved': False, 'businessFrameBoundToServerSession': False,
                    'businessFrameSentCount': 0, 'eventTypes': sorted(event_types)[:128],
                    'terminalEventObserved': False, 'conversationIdHints': [], 'responseIdHints': [],
                    'providerModelMetadata': model_metadata, 'terminalMetadata': None}

        # Bind the captured business event to the server-issued session on this socket.
        captured_page_session_id = frame['session_id']
        frame['session_id'] = server_session_id
        business_frame_text = json.dumps(frame, separators=(',', ':'), ensure_ascii=False)
        business_bound_to_server_session = frame['session_id'] == server_session_id and server_session_id != captured_page_session_id
        if not business_bound_to_server_session:
            return {'handshakeStatus': handshake_status, 'normalControlFrameSentCount': control_sent_count,
                    'serverSessionAcknowledgementObserved': True, 'businessFrameBoundToServerSession': False,
                    'businessFrameSentCount': 0, 'eventTypes': sorted(event_types)[:128],
                    'terminalEventObserved': False, 'conversationIdHints': [], 'responseIdHints': [],
                    'providerModelMetadata': model_metadata, 'terminalMetadata': None}

        business_sent_count = 1
        connection.send(business_frame_text, opcode=websocket.ABNF.OPCODE_TEXT)
        deadline = time.monotonic() + packet['timeoutMs'] / 1000
        while time.monotonic() < deadline:
            try:
                message = connection.recv()
            except websocket.WebSocketTimeoutException:
                continue
            except websocket.WebSocketConnectionClosedException:
                break
            if not isinstance(message, str):
                continue
            try:
                parsed = json.loads(message)
            except Exception:
                continue
            event = parsed.get('event') if isinstance(parsed, dict) else None
            event_type = event.get('type') if isinstance(event, dict) else None
            if isinstance(event_type, str) and EVENT_RE.fullmatch(event_type):
                event_types.add(event_type)
                if event_type in TERMINAL_EVENTS:
                    terminal = True
            update_provider_model_metadata(event_type, event, model_metadata)
            if terminal_metadata is None and event_type in TERMINAL_EVENTS:
                terminal_metadata = terminal_event_metadata(event_type, event)
            collect_id_hints(parsed, conversation_id_hints, response_id_hints)
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
        'handshakeStatus': handshake_status,
        'normalControlFrameSentCount': control_sent_count,
        'serverSessionAcknowledgementObserved': session_acknowledged,
        'businessFrameBoundToServerSession': business_bound_to_server_session,
        'businessFrameSentCount': business_sent_count,
        'eventTypes': sorted(event_types)[:128],
        'terminalEventObserved': terminal,
        'conversationIdHints': sorted(conversation_id_hints)[:MAX_HINTS],
        'responseIdHints': sorted(response_id_hints)[:MAX_HINTS],
        'providerModelMetadata': model_metadata,
        'terminalMetadata': terminal_metadata,
    }


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
        sys.stdout.write('{"handshakeStatus":0,"normalControlFrameSentCount":0,"serverSessionAcknowledgementObserved":false,"businessFrameBoundToServerSession":false,"businessFrameSentCount":0,"eventTypes":[],"terminalEventObserved":false,"conversationIdHints":[],"responseIdHints":[],"terminalMetadata":null}')
        raise SystemExit(2)
