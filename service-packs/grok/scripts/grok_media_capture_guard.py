"""Page-scoped CDP/WS write guard for Grok Imagine capture.

Only explicitly observed read operations and static resources continue. Unknown
HTTP mutations fail with CDP BlockedByClient; page-originated WSS frames are
captured in memory when they match the active intent and are never forwarded.
The guard remains installed through the task, page reset and quiet window.
"""

import json
import re
from urllib.parse import parse_qsl, urlsplit


STATIC_RESOURCE_TYPES = {'Document', 'Font', 'Image', 'Media', 'Script', 'Stylesheet'}
STATIC_ORIGINS = {
    'https://grok.com', 'https://cdn.grok.com', 'https://assets.grok.com',
    'https://fonts.googleapis.com', 'https://fonts.gstatic.com',
}
ALLOWED_QUERY_KEYS = {
    '/rest/app-chat/conversations': {
        'pageSize', 'excludeProjects', 'filterIsStarred', 'filterIsArchived', 'workspaceId', 'pageToken',
    },
    '/rest/assets': {'includeImagineFiles', 'isLatest', 'orderBy', 'pageSize', 'source', 'pageToken'},
}
OPAQUE_ID = re.compile(r'^[A-Za-z0-9._~-]{8,256}$')
IMAGINE_SOCKET_PATH = '/ws/imagine/listen'
SAFE_ASSET_HEADER_VALUES = {
    'accept', 'accept-language', 'content-type', 'origin', 'referer', 'user-agent',
    'sec-ch-ua', 'sec-ch-ua-mobile', 'sec-ch-ua-platform', 'sec-fetch-dest', 'sec-fetch-mode', 'sec-fetch-site',
}
SAFE_VIDEO_HEADER_VALUES = set(SAFE_ASSET_HEADER_VALUES)


def _safe_json_object(value):
    if not isinstance(value, str) or not value or len(value.encode('utf-8')) > 1_048_576:
        return None
    try:
        result = json.loads(value)
    except Exception:
        return None
    return result if isinstance(result, dict) and not isinstance(result, list) else None


def explicitly_observed_read(method, url, resource_type, post_data=None, headers=None, allowed_asset_urls=None):
    """Return true only for captured reads or safe static resource fetches."""
    try:
        parsed = urlsplit(url)
    except Exception:
        return False
    origin = f'{parsed.scheme}://{parsed.netloc}'
    if parsed.scheme != 'https' or parsed.username or parsed.password or parsed.fragment:
        return False
    method = str(method).upper()

    if method == 'GET':
        if url in (allowed_asset_urls or set()):
            return origin == 'https://assets.grok.com' and parsed.path.startswith('/users/') and '/generated/' in parsed.path
        if resource_type in STATIC_RESOURCE_TYPES and origin in STATIC_ORIGINS:
            if origin == 'https://assets.grok.com':
                return False
            if resource_type == 'Document':
                if origin != 'https://grok.com':
                    return False
                if parsed.path == '/imagine':
                    return not parsed.query
                if re.fullmatch(r'/imagine/post/[A-Za-z0-9._~-]{1,256}', parsed.path):
                    query = parse_qsl(parsed.query, keep_blank_values=True)
                    return len({key for key, _ in query}) == len(query) and set(key for key, _ in query).issubset({'scope', 'conversation'}) \
                        and ('scope' not in dict(query) or dict(query).get('scope') == 'asset')
                return False
            return True
        if parsed.path == '/api/auth/session' and origin == 'https://grok.com' and not parsed.query:
            return True
        if parsed.path == '/rest/assets' and origin == 'https://grok.com':
            query = dict(parse_qsl(parsed.query, keep_blank_values=True))
            if len(query) != len(parse_qsl(parsed.query, keep_blank_values=True)):
                return False
            required = {
                'includeImagineFiles': 'true', 'isLatest': 'true', 'orderBy': 'ORDER_BY_CREATE_TIME',
                'pageSize': '24', 'source': 'SOURCE_ANY',
            }
            return set(query).issubset(ALLOWED_QUERY_KEYS[parsed.path]) and all(query.get(k) == v for k, v in required.items()) and ('pageToken' not in query or len(query['pageToken']) <= 8192)
        if origin == 'https://grok.com' and re.fullmatch(r'/rest/assets/' + OPAQUE_ID.pattern[1:-1], parsed.path):
            return not parsed.query
        if parsed.path == '/rest/app-chat/conversations' and origin == 'https://grok.com':
            query = parse_qsl(parsed.query, keep_blank_values=True)
            return len({key for key, _ in query}) == len(query) and {key for key, _ in query}.issubset(ALLOWED_QUERY_KEYS[parsed.path])
        if origin == 'https://grok.com' and not parsed.query:
            if parsed.path in {
                '/rest/user-settings', '/rest/workspaces', '/rest/workspaces/shared', '/rest/products',
                '/rest/user-skills', '/rest/suggestions/profile', '/auth/user/notification-preferences',
            }:
                return True
        if origin == 'https://grok.com' and re.fullmatch(r'/rest/app-chat/conversations_v2/' + OPAQUE_ID.pattern[1:-1], parsed.path):
            query = dict(parse_qsl(parsed.query, keep_blank_values=True))
            return query == {'includeTaskResult': 'true', 'includeWorkspaces': 'true'}
        if origin == 'https://grok.com' and re.fullmatch(r'/rest/app-chat/conversations/' + OPAQUE_ID.pattern[1:-1] + r'/(?:response-node|sharing)', parsed.path):
            return True
        if origin == 'https://grok.com' and re.fullmatch(r'/rest/app-chat/conversations/' + OPAQUE_ID.pattern[1:-1] + r'/responses', parsed.path):
            query = parse_qsl(parsed.query, keep_blank_values=True)
            if len({key for key, _ in query}) != len(query):
                return False
            values = dict(query)
            allowed = {'conversationKind', 'includeThreads', 'isKidsMode', 'enableNsfw'}
            return set(values).issubset(allowed) \
                and ('conversationKind' not in values or values['conversationKind'] == 'CONVERSATION_KIND_IMAGINE') \
                and all(values.get(key) in {'true', 'false'} for key in ('includeThreads', 'isKidsMode', 'enableNsfw') if key in values)
        return False

    if method == 'POST' and origin == 'https://grok.com' and not parsed.query:
        header_map = {str(key).lower(): value for key, value in (headers or {}).items()}
        content_type = str(header_map.get('content-type', '')).split(';', 1)[0].strip().lower()
        if content_type != 'application/json':
            return False
        body = _safe_json_object(post_data)
        if body is None:
            return False
        read_bodies = {
            '/rest/media/imagine/quota_info': {},
            '/rest/media/search/status': {},
            '/rest/media/reference/list': {'limit': 50},
            '/rest/skills': {'locale': 'en'},
        }
        if re.fullmatch(r'/rest/app-chat/conversations/' + OPAQUE_ID.pattern[1:-1] + r'/load-responses', parsed.path):
            if set(body) != {'responseIds'} or not isinstance(body.get('responseIds'), list):
                return False
            response_ids = body['responseIds']
            if not 1 <= len(response_ids) <= 500 or not all(
                isinstance(value, str) and 0 < len(value) <= 256 and not re.search(r'[\r\n\0]', value)
                for value in response_ids
            ):
                return False
            return len(set(response_ids)) == len(response_ids)
        return parsed.path in read_bodies and body == read_bodies[parsed.path]

    if method in {'HEAD', 'OPTIONS'} and origin == 'https://grok.com':
        return resource_type in {'Preflight', 'Other'}
    return False


class GrokMediaCaptureGuard:
    def __init__(self, page, role_marker, *, expected_prompt=None, operation='media.image.create', quiet_window_ms=5000, cdp_session=None):
        if not isinstance(role_marker, str) or not role_marker or not isinstance(quiet_window_ms, int) or quiet_window_ms < 1000:
            raise ValueError('MEDIA_GUARD_OPTIONS_INVALID')
        if expected_prompt is not None and (not isinstance(expected_prompt, str) or not expected_prompt.strip() or len(expected_prompt) > 4000):
            raise ValueError('MEDIA_GUARD_PROMPT_INVALID')
        if operation not in {'media.image.create', 'media.video.create'}:
            raise ValueError('MEDIA_GUARD_OPERATION_INVALID')
        self.page = page
        self.role_marker = role_marker
        self.expected_prompt = expected_prompt
        self.operation = operation
        self.quiet_window_ms = quiet_window_ms
        self.cdp = cdp_session or page.context.new_cdp_session(page)
        self.websocket_pattern = 'wss://grok.com/**'
        self.capture = None
        self._captured_frames = []
        self.browser_attempts = 0
        self.late_browser_attempts_blocked = 0
        self.abort_errors = 0
        self.fail_request_ack_count = 0
        self.network_id_missing_count = 0
        self.direct_write_requests = 0
        self.server_writes_delivered = 0
        self.websocket_frames_seen = 0
        self.websocket_frames_blocked = 0
        self.websocket_frames_forwarded = 0
        self.websocket_intent_matches = 0
        self.websocket_duplicate_intent_frames = 0
        self.websocket_duplicate_reset_frames = 0
        self.cdp_socket_input_frames_sent = 0
        self.cdp_socket_intent_frames_sent = 0
        self.websocket_handshake_statuses = []
        self.websocket_frame_sent_events = 0
        self.http_blocks = []
        self._http_by_network_id = {}
        self._websocket_urls = {}
        self._allowed_asset_urls = set()
        self._asset_attempts_by_url = {}
        self._asset_records_by_url = {}
        self._asset_safe_header_values_by_url = {}
        self._asset_network_ids = set()
        self._asset_request_urls = {}
        self._asset_read_attempts = 0
        self._asset_request_ids = set()
        self._asset_request_header_names = set()
        self._asset_request_cookie_names = set()
        self._pending_asset_header_names = {}
        self._pending_asset_cookie_names = {}
        self._pending_asset_safe_header_values = {}
        self._asset_response = None
        self._sdk_headers = {}
        self._sdk_header_names = set()
        self._unexpected_sdk_header_names = set()
        self._video_request_network_id = None
        self._video_request_ordinary_headers = {}
        self._video_request_sso_cookie_observed = False
        self._pending_video_ordinary_headers = {}
        self.task_terminal = False
        self.active = False
        self.capture_enabled = False
        self.page_reloaded_after_arm = False
        self._websocket_handler = self._on_websocket_route

    @property
    def captured_request(self):
        return self.capture

    @property
    def captured_frames(self):
        return list(self._captured_frames)

    @property
    def video_request_ordinary_headers(self):
        return dict(self._video_request_ordinary_headers)

    @property
    def video_request_sso_cookie_observed(self):
        return self._video_request_sso_cookie_observed

    @property
    def request_metadata_headers(self):
        return dict(self._sdk_headers)

    @property
    def unexpected_sdk_header_names(self):
        return sorted(self._unexpected_sdk_header_names)

    def arm(self):
        if self.active:
            raise RuntimeError('MEDIA_GUARD_ALREADY_ARMED')
        current = urlsplit(self.page.url)
        marker = self.page.evaluate('() => window.name')
        if current.scheme != 'https' or current.hostname != 'grok.com' or not current.path.startswith('/imagine') or marker != self.role_marker:
            raise RuntimeError('MEDIA_GUARD_PAGE_ROLE_INVALID')
        self.active = True
        self.cdp.on('Fetch.requestPaused', self._on_request_paused)
        self.cdp.on('Network.requestWillBeSent', self._on_request_will_be_sent)
        self.cdp.on('Network.requestWillBeSentExtraInfo', self._on_request_will_be_sent_extra_info)
        self.cdp.on('Network.responseReceived', self._on_response_received)
        self.cdp.on('Network.loadingFailed', self._on_loading_failed)
        self.cdp.on('Network.webSocketCreated', self._on_websocket_created)
        self.cdp.on('Network.webSocketWillSendHandshakeRequest', self._on_websocket_handshake)
        self.cdp.on('Network.webSocketHandshakeResponseReceived', self._on_websocket_handshake_response)
        self.cdp.on('Network.webSocketFrameSent', self._on_websocket_frame_sent)
        self.page.route_web_socket(self.websocket_pattern, self._websocket_handler)
        self.cdp.send('Network.enable')
        self.cdp.send('Fetch.enable', {'patterns': [{'urlPattern': '*', 'requestStage': 'Request'}]})
        if current.path == '/imagine':
            self.page.reload(wait_until='domcontentloaded', timeout=90_000)
        else:
            self.page.goto('https://grok.com/imagine', wait_until='domcontentloaded', timeout=90_000)
        self.page.wait_for_timeout(500)
        reloaded = urlsplit(self.page.url)
        self.page_reloaded_after_arm = reloaded.scheme == 'https' and reloaded.hostname == 'grok.com' and reloaded.path == '/imagine' and self.page.evaluate('() => window.name') == self.role_marker
        if not self.page_reloaded_after_arm:
            raise RuntimeError('MEDIA_GUARD_RELOAD_AFTER_ARM_FAILED')

    def begin_intent_capture(self, *, clear=False):
        if not self.active or self.expected_prompt is None or not self.page_reloaded_after_arm:
            raise RuntimeError('MEDIA_GUARD_INTENT_NOT_READY')
        if clear:
            self._captured_frames.clear()
            self.websocket_intent_matches = 0
            self.websocket_duplicate_intent_frames = 0
            self.websocket_duplicate_reset_frames = 0
            self.cdp_socket_input_frames_sent = 0
            self.cdp_socket_intent_frames_sent = 0
        self.capture_enabled = True

    def _on_websocket_created(self, event):
        request_id = event.get('requestId')
        url = event.get('url')
        if isinstance(request_id, str) and isinstance(url, str):
            self._websocket_urls[request_id] = url

    def _on_websocket_handshake(self, event):
        request_id = event.get('requestId')
        url = self._websocket_urls.get(request_id, '')
        parsed = urlsplit(url)
        if parsed.scheme != 'wss' or parsed.hostname != 'grok.com' or parsed.path != IMAGINE_SOCKET_PATH:
            return
        request = event.get('request', {})
        headers = request.get('headers', {}) if isinstance(request, dict) else {}
        if not isinstance(headers, dict):
            return
        names = {str(key).lower() for key in headers}
        sdk_names = {'x-statsig-id', 'x-xai-request-id'}
        self._sdk_header_names = names & sdk_names
        self._unexpected_sdk_header_names.update(name for name in names if name.startswith('x-') and name not in sdk_names)
        for name in sdk_names:
            value = next((value for key, value in headers.items() if str(key).lower() == name), None)
            if isinstance(value, str) and value and not re.search(r'[\r\n\0]', value):
                self._sdk_headers[name] = value

    def _on_websocket_handshake_response(self, event):
        request_id = event.get('requestId')
        url = self._websocket_urls.get(request_id, '')
        parsed = urlsplit(url)
        if parsed.scheme == 'wss' and parsed.hostname == 'grok.com' and parsed.path == IMAGINE_SOCKET_PATH:
            response = event.get('response', {})
            status = response.get('status') if isinstance(response, dict) else None
            self.websocket_handshake_statuses.append(status if isinstance(status, int) else None)

    def _on_websocket_frame_sent(self, event):
        request_id = event.get('requestId')
        url = self._websocket_urls.get(request_id, '')
        parsed = urlsplit(url)
        if parsed.scheme == 'wss' and parsed.hostname == 'grok.com' and parsed.path == IMAGINE_SOCKET_PATH:
            self.websocket_frame_sent_events += 1
            response = event.get('response', {})
            payload = response.get('payloadData') if isinstance(response, dict) else None
            frame = _safe_json_object(payload) if isinstance(payload, str) else None
            item = frame.get('item') if isinstance(frame, dict) else None
            content = item.get('content') if isinstance(item, dict) else None
            entry = content[0] if isinstance(content, list) and content and isinstance(content[0], dict) else None
            if isinstance(entry, dict) and entry.get('type') == 'input_text':
                self.cdp_socket_input_frames_sent += 1
                if entry.get('text') == self.expected_prompt:
                    self.cdp_socket_intent_frames_sent += 1

    def _on_request_paused(self, event):
        request_id = event.get('requestId')
        request = event.get('request', {})
        if not isinstance(request_id, str) or not isinstance(request, dict):
            self.abort_errors += 1
            return
        url = request.get('url', '')
        method = request.get('method', '')
        resource_type = event.get('resourceType', 'Other')
        post_data = request.get('postData')
        if url in self._allowed_asset_urls:
            self._asset_read_attempts += 1
            count = self._asset_attempts_by_url.get(url, 0) + 1
            self._asset_attempts_by_url[url] = count
            allowed_asset_attempt = count == 1
        else:
            allowed_asset_attempt = True
        if allowed_asset_attempt and explicitly_observed_read(
            method, url, resource_type, post_data, request.get('headers'), self._allowed_asset_urls,
        ):
            try:
                self.cdp.send('Fetch.continueRequest', {'requestId': request_id})
            except Exception:
                self.abort_errors += 1
            return

        parsed = urlsplit(url)
        network_id = event.get('networkId')
        method_upper = str(method).upper()
        write_like = method_upper in {'POST', 'PUT', 'PATCH', 'DELETE'}
        if write_like:
            self.browser_attempts += 1
            if self.capture is not None or self.captured_frames or self.task_terminal:
                self.late_browser_attempts_blocked += 1
        block = {
            'requestId': request_id,
            'networkId': network_id if isinstance(network_id, str) else None,
            'method': method_upper,
            'origin': f'{parsed.scheme}://{parsed.netloc}' if parsed.scheme and parsed.netloc else None,
            'path': parsed.path,
            'resourceType': resource_type if isinstance(resource_type, str) else 'Other',
            'failRequestAck': False,
            'loadingFailedCount': 0,
            'responseCount': 0,
            'errorText': None,
            'intentMatch': False,
        }
        if not isinstance(network_id, str):
            self.network_id_missing_count += 1
        if write_like and parsed.scheme == 'https' and parsed.hostname == 'grok.com' and parsed.path == '/rest/app-chat/conversations/new' and method_upper == 'POST':
            self._capture_video_http_intent(request, block)
        self.http_blocks.append(block)
        if isinstance(network_id, str):
            self._http_by_network_id[network_id] = block
        try:
            self.cdp.send('Fetch.failRequest', {'requestId': request_id, 'errorReason': 'BlockedByClient'})
            block['failRequestAck'] = True
            self.fail_request_ack_count += 1
        except Exception:
            self.abort_errors += 1

    def allow_exact_asset_read(self, url):
        parsed = urlsplit(url) if isinstance(url, str) else None
        if (parsed is None or parsed.scheme != 'https' or parsed.netloc.lower() != 'assets.grok.com'
            or parsed.username or parsed.password or parsed.fragment
            or not parsed.path.startswith('/users/') or '/generated/' not in parsed.path):
            raise ValueError('MEDIA_GUARD_ASSET_URL_SCOPE_INVALID')
        self._allowed_asset_urls.add(url)
        self._asset_records_by_url.setdefault(url, {
            'requestCount': 0,
            'requestHeaderNames': set(),
            'cookieNames': set(),
            'response': None,
            'bodyBytes': None,
            'magicVerified': False,
        })
        self._asset_safe_header_values_by_url.setdefault(url, {})

    def asset_request_header_values(self, url):
        if url not in self._allowed_asset_urls:
            raise ValueError('MEDIA_GUARD_ASSET_URL_NOT_ALLOWED')
        return dict(self._asset_safe_header_values_by_url.get(url, {}))

    def _on_request_will_be_sent(self, event):
        request_id = event.get('requestId')
        request = event.get('request', {})
        if not isinstance(request_id, str) or not isinstance(request, dict) or request.get('url') not in self._allowed_asset_urls:
            return
        self._asset_request_ids.add(request_id)
        self._asset_network_ids.add(request_id)
        url = request.get('url')
        if isinstance(url, str):
            self._asset_request_urls[request_id] = url
        record = self._asset_records_by_url.get(url)
        if record is not None:
            record['requestCount'] += 1
        headers = request.get('headers', {})
        names, cookies = self._collect_asset_header_names(headers)
        self._asset_request_header_names.update(names)
        self._asset_request_cookie_names.update(cookies)
        if record is not None:
            record['requestHeaderNames'].update(names)
            record['cookieNames'].update(cookies)
            self._asset_capture_safe_header_values(url, headers)
        pending_names = self._pending_asset_header_names.pop(request_id, set())
        pending_cookies = self._pending_asset_cookie_names.pop(request_id, set())
        pending_safe_values = self._pending_asset_safe_header_values.pop(request_id, {})
        self._asset_request_header_names.update(pending_names)
        self._asset_request_cookie_names.update(pending_cookies)
        if record is not None:
            record['requestHeaderNames'].update(pending_names)
            record['cookieNames'].update(pending_cookies)
            self._asset_capture_safe_header_values(url, pending_safe_values)
        redirect = event.get('redirectResponse')
        if isinstance(redirect, dict):
            self._asset_response = {
                'status': redirect.get('status') if isinstance(redirect.get('status'), int) else None,
                'mimeType': redirect.get('mimeType') if isinstance(redirect.get('mimeType'), str) else None,
                'redirectObserved': True,
            }

    def _on_request_will_be_sent_extra_info(self, event):
        request_id = event.get('requestId')
        if not isinstance(request_id, str):
            return
        headers = event.get('headers', {})
        if not isinstance(headers, dict):
            return
        if self.operation == 'media.video.create':
            safe_video_headers, sso_observed = self._video_source_headers(headers)
            if request_id == self._video_request_network_id:
                self._video_request_ordinary_headers.update(safe_video_headers)
                self._video_request_sso_cookie_observed = self._video_request_sso_cookie_observed or sso_observed
            else:
                if request_id not in self._pending_video_ordinary_headers and len(self._pending_video_ordinary_headers) >= 128:
                    self._pending_video_ordinary_headers.pop(next(iter(self._pending_video_ordinary_headers)), None)
                pending = self._pending_video_ordinary_headers.setdefault(request_id, {'headers': {}, 'ssoObserved': False})
                pending['headers'].update(safe_video_headers)
                pending['ssoObserved'] = pending['ssoObserved'] or sso_observed
        names, cookies = self._collect_asset_header_names(headers)
        if request_id in self._asset_request_ids:
            self._asset_request_header_names.update(names)
            self._asset_request_cookie_names.update(cookies)
            url = self._url_for_asset_request(request_id)
            record = self._asset_records_by_url.get(url)
            if record is not None:
                record['requestHeaderNames'].update(names)
                record['cookieNames'].update(cookies)
                self._asset_capture_safe_header_values(url, headers)
        else:
            if request_id not in self._pending_asset_header_names and len(self._pending_asset_header_names) >= 128:
                oldest = next(iter(self._pending_asset_header_names))
                self._pending_asset_header_names.pop(oldest, None)
                self._pending_asset_cookie_names.pop(oldest, None)
                self._pending_asset_safe_header_values.pop(oldest, None)
            self._pending_asset_header_names.setdefault(request_id, set()).update(names)
            self._pending_asset_cookie_names.setdefault(request_id, set()).update(cookies)
            safe_values = self._pending_asset_safe_header_values.setdefault(request_id, {})
            for name, value in headers.items():
                normalized = str(name).lower()
                if normalized in SAFE_ASSET_HEADER_VALUES and isinstance(value, str) and value and len(value) <= 2048 \
                    and not re.search(r'[\r\n\0]', value):
                    safe_values[normalized] = value

    def _collect_asset_header_names(self, headers):
        if not isinstance(headers, dict):
            return set(), set()
        names = {str(name).lower() for name in headers}
        cookie_header = next((value for name, value in headers.items() if str(name).lower() == 'cookie' and isinstance(value, str)), '')
        cookies = set()
        for cookie in cookie_header.split(';'):
            if '=' in cookie:
                cookies.add(cookie.split('=', 1)[0].strip())
        return names, cookies

    def _asset_capture_safe_header_values(self, url, headers):
        if url not in self._allowed_asset_urls or not isinstance(headers, dict):
            return
        values = self._asset_safe_header_values_by_url.setdefault(url, {})
        for name, value in headers.items():
            normalized = str(name).lower()
            if normalized not in SAFE_ASSET_HEADER_VALUES or not isinstance(value, str) or not value or len(value) > 2048:
                continue
            if re.search(r'[\r\n\0]', value):
                continue
            if normalized == 'origin' and value != 'https://grok.com':
                continue
            if normalized == 'referer':
                parsed = urlsplit(value)
                if parsed.scheme != 'https' or parsed.hostname != 'grok.com' or parsed.username or parsed.password:
                    continue
            values[normalized] = value

    def _capture_video_http_intent(self, request, proof):
        raw = request.get('postData')
        body = _safe_json_object(raw)
        message = body.get('message') if isinstance(body, dict) else None
        video = body.get('mediaGenInput', {}).get('textToVideo') if isinstance(body, dict) and isinstance(body.get('mediaGenInput'), dict) else None
        expected_video_message = f'{self.expected_prompt.strip()} --mode=custom' if isinstance(self.expected_prompt, str) else None
        intent_match = isinstance(video, dict) and video.get('prompt') == self.expected_prompt and message == expected_video_message
        proof['intentMatch'] = intent_match
        if self.capture is not None:
            return
        headers = request.get('headers', {})
        if not isinstance(headers, dict):
            headers = {}
        self._video_request_network_id = proof.get('networkId') if isinstance(proof.get('networkId'), str) else None
        safe_headers, sso_observed = self._video_source_headers(headers)
        self._video_request_ordinary_headers.update(safe_headers)
        self._video_request_sso_cookie_observed = self._video_request_sso_cookie_observed or sso_observed
        pending = self._pending_video_ordinary_headers.pop(self._video_request_network_id, None)
        if isinstance(pending, dict):
            self._video_request_ordinary_headers.update(pending.get('headers', {}))
            self._video_request_sso_cookie_observed = self._video_request_sso_cookie_observed or pending.get('ssoObserved', False)
        lowered = {str(key).lower(): value for key, value in headers.items()}
        self.capture = {
            'method': 'POST',
            'path': '/rest/app-chat/conversations/new',
            'bodyText': raw if isinstance(raw, str) else '',
            'headers': {name: lowered[name] for name in ('x-statsig-id', 'x-xai-request-id') if isinstance(lowered.get(name), str)},
            'basicHeaders': {name: lowered[name] for name in ('accept', 'content-type', 'origin', 'referer') if isinstance(lowered.get(name), str)},
            'headerNames': sorted(lowered),
            'intentMatch': intent_match,
            'networkIdPresent': isinstance(proof.get('networkId'), str),
        }

    @staticmethod
    def _video_source_headers(headers):
        if not isinstance(headers, dict):
            return {}, False
        safe = {}
        cookie_header = ''
        for name, value in headers.items():
            normalized = str(name).lower()
            if normalized == 'cookie' and isinstance(value, str):
                cookie_header = value
                continue
            if normalized not in SAFE_VIDEO_HEADER_VALUES or not isinstance(value, str) or not value.strip() or len(value) > 2048:
                continue
            if re.search(r'[\r\n\0]', value):
                continue
            if normalized == 'origin' and value != 'https://grok.com':
                continue
            if normalized == 'referer':
                parsed = urlsplit(value)
                if parsed.scheme != 'https' or parsed.hostname != 'grok.com' or parsed.username or parsed.password or parsed.query or parsed.fragment:
                    continue
            safe[normalized] = value
        sso_observed = any(part.split('=', 1)[0].strip() == 'sso'
            for part in cookie_header.split(';') if '=' in part)
        return safe, sso_observed

    def _on_response_received(self, event):
        request_id = event.get('requestId')
        block = self._http_by_network_id.get(request_id) if isinstance(request_id, str) else None
        if block:
            block['responseCount'] += 1
        if isinstance(request_id, str) and request_id in self._asset_request_ids:
            response = event.get('response', {})
            if isinstance(response, dict):
                headers = response.get('headers', {})
                lowered = {str(name).lower(): value for name, value in headers.items()} if isinstance(headers, dict) else {}
                self._asset_response = {
                    'status': response.get('status') if isinstance(response.get('status'), int) else None,
                    'mimeType': response.get('mimeType') if isinstance(response.get('mimeType'), str) else None,
                    'headerNames': sorted(str(name).lower() for name in headers) if isinstance(headers, dict) else [],
                    'redirectObserved': False,
                    'rangeStartsAtZero': bool(re.match(r'^bytes 0-', str(lowered.get('content-range', '')), re.I)),
                }
                url = self._url_for_asset_request(request_id)
                record = self._asset_records_by_url.get(url)
                if record is not None:
                    record['response'] = self._asset_response.copy()

    def _on_loading_failed(self, event):
        request_id = event.get('requestId')
        block = self._http_by_network_id.get(request_id) if isinstance(request_id, str) else None
        if block:
            block['loadingFailedCount'] += 1
            error_text = event.get('errorText')
            block['errorText'] = error_text if isinstance(error_text, str) and len(error_text) <= 96 else None
        if isinstance(request_id, str) and request_id in self._asset_request_ids:
            error_text = event.get('errorText')
            self._asset_response = {
                'loadingFailed': True,
                'errorText': error_text if isinstance(error_text, str) and len(error_text) <= 96 else None,
            }
            url = self._url_for_asset_request(request_id)
            record = self._asset_records_by_url.get(url)
            if record is not None:
                record['response'] = self._asset_response.copy()

    def _url_for_asset_request(self, request_id):
        return self._asset_request_urls.get(request_id)

    def _on_websocket_route(self, route):
        server = route.connect_to_server()

        def from_page(message):
            self.websocket_frames_seen += 1
            frame = None
            if isinstance(message, str):
                try:
                    frame = json.loads(message)
                except Exception:
                    frame = None
            item = frame.get('item') if isinstance(frame, dict) else None
            content = item.get('content') if isinstance(item, dict) else None
            entry = content[0] if isinstance(content, list) and content and isinstance(content[0], dict) else None
            frame_type = entry.get('type') if isinstance(entry, dict) else None
            if self.capture_enabled and isinstance(frame, dict) and frame.get('type') == 'conversation.item.create' and frame_type == 'reset':
                if not any(isinstance(saved, dict) and _is_reset(saved) for saved in self._captured_frames):
                    self._captured_frames.append(frame)
                else:
                    self.websocket_duplicate_reset_frames += 1
            elif self.capture_enabled and isinstance(entry, dict) and entry.get('type') == 'input_text' and entry.get('text') == self.expected_prompt:
                self.websocket_intent_matches += 1
                if not any(isinstance(saved, dict) and _is_generation(saved) for saved in self._captured_frames):
                    self._captured_frames.append(frame)
                else:
                    self.websocket_duplicate_intent_frames += 1
            self.websocket_frames_blocked += 1
            # Intentionally do not call server.send(message): the page's frame never reaches Grok.

        def from_server(message):
            route.send(message)

        route.on_message(from_page)
        server.on_message(from_server)

    def note_direct_write_dispatched(self):
        if not self.active:
            raise RuntimeError('MEDIA_GUARD_NOT_ACTIVE')
        if self.direct_write_requests >= 1:
            raise RuntimeError('MEDIA_DIRECT_WRITE_LIMIT_REACHED')
        self.direct_write_requests += 1

    def mark_task_terminal(self, state):
        if state not in {'completed', 'failed', 'needs_review', 'outcome_unknown', 'blocked_security_boundary'}:
            raise ValueError('MEDIA_GUARD_TERMINAL_STATE_INVALID')
        self.task_terminal = True

    def abort_proof(self):
        candidates = [block for block in self.http_blocks if block.get('path') == '/rest/app-chat/conversations/new' and block.get('method') == 'POST']
        if len(candidates) != 1:
            return {'verified': False, 'reason': 'TARGET_HTTP_ABORT_COUNT_NOT_ONE', 'failRequestAck': False, 'networkIdPresent': False, 'loadingFailedCount': 0, 'responseCount': 0, 'intentMatch': False}
        block = candidates[0]
        # Request-stage Fetch interception may not emit a matching Network.loadingFailed event.
        return {
            'verified': block['failRequestAck'] is True and block['networkId'] is not None
            and block['loadingFailedCount'] in {0, 1} and block['responseCount'] == 0 and block['intentMatch'] is True,
            'failRequestAck': block['failRequestAck'],
            'networkIdPresent': block['networkId'] is not None,
            'loadingFailedCount': block['loadingFailedCount'],
            'responseCount': block['responseCount'],
            'intentMatch': block['intentMatch'],
            'errorTextDiagnostic': block['errorText'],
        }

    def pagewide_http_proof(self):
        write_blocks = [block for block in self.http_blocks if block.get('method') in {'POST', 'PUT', 'PATCH', 'DELETE'}]
        all_business_writes_blocked = all(
            block['failRequestAck'] is True and block['responseCount'] == 0
            for block in write_blocks
        )
        return {
            'verified': all_business_writes_blocked and self.abort_errors == 0 and self.server_writes_delivered == 0,
            'blockedRequestCount': len(self.http_blocks),
            'blockedBusinessWriteCount': len(write_blocks),
            'unresolvedAncillaryReadCount': sum(
                1 for block in self.http_blocks if block.get('method') in {'GET', 'HEAD', 'OPTIONS'}
                and (block.get('networkId') is None or block.get('loadingFailedCount') != 1 or block.get('responseCount') != 0)
            ),
            'failRequestAckCount': self.fail_request_ack_count,
            'networkIdMissingCount': self.network_id_missing_count,
            'responsesToBlockedRequests': sum(block['responseCount'] for block in self.http_blocks),
            'loadingFailedEventsForBlockedRequests': sum(block['loadingFailedCount'] for block in self.http_blocks),
            'browserServerWritesDelivered': self.server_writes_delivered,
        }

    def one_shot_image_capture_proof(self):
        reset_count = sum(1 for frame in self._captured_frames if _is_reset(frame))
        image_count = sum(
            1 for frame in self._captured_frames
            if _is_generation(frame) and _generation_prompt(frame) == self.expected_prompt
        )
        frame_sequence_valid = image_count == 1 and reset_count in {0, 1} \
            and len(self._captured_frames) == reset_count + image_count
        return {
            'verified': frame_sequence_valid
            and self.websocket_intent_matches == 1 and self.websocket_duplicate_intent_frames == 0
            and self.websocket_duplicate_reset_frames == 0
            and self.websocket_frames_forwarded == 0 and self.websocket_handshake_statuses.count(101) == 1
            and self.cdp_socket_intent_frames_sent == 0 and self.page_reloaded_after_arm,
            'resetFrameCount': reset_count,
            'matchingImageFrameCount': image_count,
            'intentMatchCount': self.websocket_intent_matches,
            'duplicateIntentFramesBlocked': self.websocket_duplicate_intent_frames,
            'duplicateResetFramesBlocked': self.websocket_duplicate_reset_frames,
            'browserFramesForwarded': self.websocket_frames_forwarded,
            'handshake101Count': self.websocket_handshake_statuses.count(101),
            'cdpSocketInputFramesSent': self.cdp_socket_input_frames_sent,
            'cdpSocketIntentFramesSent': self.cdp_socket_intent_frames_sent,
            'pageReloadedAfterWebSocketRouteArmed': self.page_reloaded_after_arm,
            'frameFieldNames': [sorted(frame.keys()) for frame in self._captured_frames],
        }

    def close_after_quiescence(self, reset_url='https://grok.com/imagine'):
        if not self.active or not self.task_terminal:
            raise RuntimeError('MEDIA_GUARD_TASK_NOT_TERMINAL')
        parsed = urlsplit(reset_url)
        if parsed.scheme != 'https' or parsed.hostname != 'grok.com' or parsed.path != '/imagine' or parsed.query or parsed.fragment:
            raise ValueError('MEDIA_GUARD_RESET_URL_INVALID')
        self.page.goto(reset_url, wait_until='domcontentloaded', timeout=90_000)
        try:
            composer = self.page.get_by_role('textbox', name='Ask Grok anything')
            if composer.count() == 1 and composer.is_visible() and composer.inner_text():
                composer.fill('', timeout=5_000)
        except Exception:
            pass
        self.page.wait_for_timeout(self.quiet_window_ms)
        current = urlsplit(self.page.url)
        marker = self.page.evaluate('() => window.name')
        if current.scheme != 'https' or current.hostname != 'grok.com' or current.path != '/imagine' or marker != self.role_marker:
            raise RuntimeError('MEDIA_GUARD_PAGE_RESET_UNVERIFIED')
        if self.abort_errors or self.server_writes_delivered != 0 or self.direct_write_requests > 1:
            raise RuntimeError('MEDIA_GUARD_WRITE_BOUNDARY_FAILED')
        proof = self.abort_proof()
        pagewide_proof = self.pagewide_http_proof()
        if pagewide_proof['verified'] is not True:
            raise RuntimeError('MEDIA_GUARD_HTTP_ABORT_PROOF_INCOMPLETE')
        self.cdp.send('Fetch.disable')
        try:
            self.page.unroute_web_socket(self.websocket_pattern, self._websocket_handler)
        except TypeError:
            self.page.unroute_web_socket(self.websocket_pattern)
        except AttributeError:
            pass
        self.cdp.detach()
        self.active = False
        return {
            'pageWideHttpGuardActiveThroughTask': True,
            'cleanPageRestored': True,
            'quietWindowMs': self.quiet_window_ms,
            'httpMutationAttemptsBlocked': self.browser_attempts,
            'lateHttpRetriesBlocked': self.late_browser_attempts_blocked,
            'httpFailRequestAckCount': self.fail_request_ack_count,
            'httpNetworkIdMissingCount': self.network_id_missing_count,
            'httpAbortProof': proof,
            'pagewideHttpGateProof': pagewide_proof,
            'oneShotImageCaptureProof': self.one_shot_image_capture_proof(),
            'websocketFramesSeen': self.websocket_frames_seen,
            'websocketFramesBlocked': self.websocket_frames_blocked,
            'websocketFramesForwarded': self.websocket_frames_forwarded,
            'websocketHandshakeStatuses': self.websocket_handshake_statuses,
            'websocketFrameSentEvents': self.websocket_frame_sent_events,
            'websocketIntentMatches': self.websocket_intent_matches,
            'websocketDuplicateIntentFramesBlocked': self.websocket_duplicate_intent_frames,
            'cdpSocketInputFramesSent': self.cdp_socket_input_frames_sent,
            'cdpSocketIntentFramesSent': self.cdp_socket_intent_frames_sent,
            'pageReloadedAfterWebSocketRouteArmed': self.page_reloaded_after_arm,
            'capturedFrameCount': len(self._captured_frames),
            'browserServerWritesDelivered': self.server_writes_delivered,
            'directWriteRequests': self.direct_write_requests,
            'noLateBrowserWriteReachedServer': self.server_writes_delivered == 0,
            'unexpectedSdkHeaderNames': self.unexpected_sdk_header_names,
            'assetBrowserRequest': {
                'attempts': self._asset_read_attempts,
                'requestHeaderNames': sorted(self._asset_request_header_names),
                'cookieNames': sorted(self._asset_request_cookie_names),
                'response': self._asset_response,
            },
            'assetBrowserRequests': [
                {
                    'origin': 'https://assets.grok.com',
                    'pathClass': '/users/*/generated/*',
                    'requestCount': record['requestCount'],
                    'requestHeaderNames': sorted(record['requestHeaderNames']),
                    'cookieNames': sorted(record['cookieNames']),
                    'response': record['response'],
                    'bodyCaptured': False,
                }
                for record in self._asset_records_by_url.values()
            ],
        }

    def close_read_only_after_quiescence(self, reset_url='https://grok.com/imagine'):
        if not self.active or not self.task_terminal:
            raise RuntimeError('MEDIA_GUARD_TASK_NOT_TERMINAL')
        parsed = urlsplit(reset_url)
        if parsed.scheme != 'https' or parsed.hostname != 'grok.com' or parsed.path != '/imagine' or parsed.query or parsed.fragment:
            raise ValueError('MEDIA_GUARD_RESET_URL_INVALID')
        self.page.goto(reset_url, wait_until='domcontentloaded', timeout=90_000)
        self.page.wait_for_timeout(self.quiet_window_ms)
        current = urlsplit(self.page.url)
        marker = self.page.evaluate('() => window.name')
        if current.scheme != 'https' or current.hostname != 'grok.com' or current.path != '/imagine' or marker != self.role_marker:
            raise RuntimeError('MEDIA_GUARD_PAGE_RESET_UNVERIFIED')
        if self.abort_errors or self.server_writes_delivered != 0 or self.direct_write_requests != 0:
            raise RuntimeError('MEDIA_GUARD_READ_ONLY_BOUNDARY_FAILED')
        pagewide_proof = self.pagewide_http_proof()
        if pagewide_proof['verified'] is not True:
            raise RuntimeError('MEDIA_GUARD_HTTP_ABORT_PROOF_INCOMPLETE')
        self.cdp.send('Fetch.disable')
        try:
            self.page.unroute_web_socket(self.websocket_pattern, self._websocket_handler)
        except TypeError:
            self.page.unroute_web_socket(self.websocket_pattern)
        except AttributeError:
            pass
        self.cdp.detach()
        self.active = False
        return {
            'pageWideHttpGuardActiveThroughReadback': True,
            'cleanPageRestored': True,
            'quietWindowMs': self.quiet_window_ms,
            'httpMutationAttemptsBlocked': self.browser_attempts,
            'lateHttpRetriesBlocked': self.late_browser_attempts_blocked,
            'browserServerWritesDelivered': self.server_writes_delivered,
            'directWriteRequests': self.direct_write_requests,
            'noBrowserWriteReachedServer': self.server_writes_delivered == 0,
            'pagewideHttpGateProof': pagewide_proof,
            'assetBrowserRequests': [
                {
                    'origin': 'https://assets.grok.com',
                    'pathClass': '/users/*/generated/*',
                    'requestCount': record['requestCount'],
                    'requestHeaderNames': sorted(record['requestHeaderNames']),
                    'cookieNames': sorted(record['cookieNames']),
                    'response': record['response'],
                    'bodyCaptured': False,
                }
                for record in self._asset_records_by_url.values()
            ],
        }


def _is_reset(frame):
    item = frame.get('item') if isinstance(frame, dict) else None
    content = item.get('content') if isinstance(item, dict) else None
    return isinstance(content, list) and bool(content) and isinstance(content[0], dict) and content[0].get('type') == 'reset'


def _is_generation(frame):
    item = frame.get('item') if isinstance(frame, dict) else None
    content = item.get('content') if isinstance(item, dict) else None
    return isinstance(content, list) and bool(content) and isinstance(content[0], dict) and content[0].get('type') == 'input_text'


def _generation_prompt(frame):
    item = frame.get('item') if isinstance(frame, dict) else None
    content = item.get('content') if isinstance(item, dict) else None
    if isinstance(content, list) and content and isinstance(content[0], dict):
        value = content[0].get('text')
        return value if isinstance(value, str) else None
    return None
