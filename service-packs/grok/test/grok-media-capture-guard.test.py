import importlib.util
import json
import sys
import unittest
from pathlib import Path

MODULE_PATH = Path(__file__).resolve().parents[1] / 'scripts' / 'grok_media_capture_guard.py'
SPEC = importlib.util.spec_from_file_location('grok_media_capture_guard', MODULE_PATH)
MODULE = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = MODULE
SPEC.loader.exec_module(MODULE)
GrokMediaCaptureGuard = MODULE.GrokMediaCaptureGuard
explicitly_observed_read = MODULE.explicitly_observed_read

PROMPT = 'Neutral pastel geometric study, no text.'


class FakeCdp:
    def __init__(self):
        self.listeners = {}
        self.commands = []
        self.network_ids = {}
        self.emit_loading_failed = True

    def on(self, name, handler):
        self.listeners[name] = handler

    def send(self, name, params=None):
        self.commands.append((name, params or {}))
        if name == 'Fetch.failRequest' and self.emit_loading_failed:
            network_id = self.network_ids.get(params.get('requestId'))
            self.listeners['Network.loadingFailed']({
                'requestId': network_id,
                'errorText': 'net::ERR_BLOCKED_BY_CLIENT',
            })
        return {}

    def detach(self):
        self.commands.append(('detach', {}))


class FakeServer:
    def __init__(self):
        self.sent = []
        self.handler = None

    def send(self, value):
        self.sent.append(value)

    def on_message(self, handler):
        self.handler = handler


class FakeWsRoute:
    def __init__(self):
        self.server = FakeServer()
        self.handler = None

    def connect_to_server(self):
        return self.server

    def on_message(self, handler):
        self.handler = handler

    def send(self, value):
        pass


class FakePage:
    def __init__(self, cdp, marker='codex-grok-media-test'):
        self.url = 'https://grok.com/imagine'
        self.marker = marker
        self.cdp = cdp
        self.websocket_pattern = None
        self.websocket_handler = None
        self.late_retry_at_quiet = False

    def evaluate(self, _script):
        return self.marker

    def route_web_socket(self, pattern, handler):
        self.websocket_pattern = pattern
        self.websocket_handler = handler

    def goto(self, url, **_kwargs):
        self.url = url

    def reload(self, **_kwargs):
        self.url = 'https://grok.com/imagine'

    def wait_for_timeout(self, _milliseconds):
        if self.late_retry_at_quiet:
            self.late_retry_at_quiet = False
            request = {
                'url': 'https://grok.com/rest/workspaces/share',
                'method': 'POST',
                'headers': {'content-type': 'application/json'},
                'postData': '{}',
            }
            self.cdp.network_ids['late-fetch'] = 'late-network'
            self.cdp.listeners['Fetch.requestPaused']({
                'requestId': 'late-fetch', 'networkId': 'late-network', 'resourceType': 'Fetch', 'request': request,
            })


def paused(request_id, network_id, method, url, resource_type, body=None, headers=None):
    request = {'url': url, 'method': method, 'headers': headers or {}}
    if body is not None:
        request['postData'] = body
    return {'requestId': request_id, 'networkId': network_id, 'resourceType': resource_type, 'request': request}


def image_frame(frame_type, prompt=None):
    content = {'type': frame_type}
    if prompt is not None:
        content.update({
            'text': prompt,
            'requestId': '00000000-0000-4000-8000-000000000001',
            'properties': {'num_generations': 4},
        })
    return json.dumps({'type': 'conversation.item.create', 'item': {'type': 'message', 'content': [content]}})


class CaptureGuardTests(unittest.TestCase):
    def test_only_explicit_reads_and_static_gets_continue(self):
        self.assertTrue(explicitly_observed_read(
            'POST', 'https://grok.com/rest/media/imagine/quota_info', 'Fetch', '{}', {'content-type': 'application/json'},
        ))
        self.assertTrue(explicitly_observed_read(
            'GET', 'https://grok.com/api/auth/session', 'Fetch', None, {},
        ))
        self.assertTrue(explicitly_observed_read(
            'GET', 'https://cdn.grok.com/_next/static/app.js', 'Script', None, {},
        ))
        self.assertFalse(explicitly_observed_read(
            'POST', 'https://grok.com/rest/media/imagine/quota_info', 'Fetch', '{"buyCredits":true}', {'content-type': 'application/json'},
        ))
        self.assertFalse(explicitly_observed_read(
            'POST', 'https://grok.com/rest/profile/update', 'Fetch', '{}', {'content-type': 'application/json'},
        ))

    def test_private_imagine_asset_post_reads_are_scoped_to_source_contract(self):
        self.assertTrue(explicitly_observed_read(
            'GET', 'https://grok.com/imagine/post/private-image-asset-0001?scope=asset&conversation=private-conversation-0001',
            'Document', None, {},
        ))
        self.assertTrue(explicitly_observed_read(
            'GET', 'https://grok.com/rest/assets/private-image-asset-0001', 'Fetch', None, {},
        ))
        self.assertFalse(explicitly_observed_read(
            'GET', 'https://grok.com/rest/assets/private-image-asset-0001?requestUserId=unbound', 'Fetch', None, {},
        ))
        self.assertTrue(explicitly_observed_read(
            'GET', 'https://grok.com/rest/app-chat/conversations/private-conversation-0001/responses?conversationKind=CONVERSATION_KIND_IMAGINE',
            'Fetch', None, {},
        ))
        self.assertFalse(explicitly_observed_read(
            'GET', 'https://grok.com/rest/app-chat/conversations/private-conversation-0001/responses?shareLinkId=unbound',
            'Fetch', None, {},
        ))

    def test_video_capture_binds_only_observed_sso_name_and_ordinary_headers(self):
        cdp = FakeCdp()
        page = FakePage(cdp)
        guard = GrokMediaCaptureGuard(page, 'codex-grok-media-test', expected_prompt=PROMPT,
            operation='media.video.create', cdp_session=cdp)
        body = json.dumps({
            'enableImageStreaming': True,
            'enableSideBySide': True,
            'kind': 'CONVERSATION_KIND_IMAGINE',
            'mediaGenInput': {'textToVideo': {'prompt': PROMPT, 'aspectRatio': '2:3', 'duration': 6,
                'resolutionName': '480p', 'skipAudio': True}},
            'message': PROMPT + ' --mode=custom', 'modelName': 'imagine-video-gen',
            'responseMetadata': {'experiments': [], 'modelConfigOverride': {'modelMap': {}}},
            'sendFinalMetadata': True,
        })
        guard._capture_video_http_intent({
            'postData': body,
            'headers': {'x-statsig-id': 'safe-id', 'x-xai-request-id': 'safe-request',
                'content-type': 'application/json', 'user-agent': 'Chrome/154',
                'cookie': 'sso=test-owner-cookie; cf_clearance=must-not-be-copied'},
        }, {'networkId': 'opaque-network-id'})
        guard._on_request_will_be_sent_extra_info({
            'requestId': 'opaque-network-id',
            'headers': {'sec-ch-ua-platform': '"Linux"', 'referer': 'https://grok.com/imagine',
                'cookie': 'sso=test-owner-cookie; cf_clearance=must-not-be-copied'},
        })
        self.assertTrue(guard.video_request_sso_cookie_observed)
        self.assertEqual(guard.video_request_ordinary_headers['sec-ch-ua-platform'], '"Linux"')
        self.assertEqual(guard.video_request_ordinary_headers['referer'], 'https://grok.com/imagine')
        self.assertNotIn('cookie', guard.video_request_ordinary_headers)
        self.assertNotIn('test-owner-cookie', json.dumps(guard.video_request_ordinary_headers))
        self.assertNotIn('cf_clearance', json.dumps(guard.video_request_ordinary_headers))
        self.assertEqual(guard.capture['headers'], {'x-statsig-id': 'safe-id', 'x-xai-request-id': 'safe-request'})
        self.assertFalse(explicitly_observed_read(
            'GET', 'https://grok.com/rest/unknown-business-read', 'Fetch', None, {},
        ))

    def test_request_stage_fail_ack_proves_block_when_chromium_omits_loading_failed(self):
        cdp = FakeCdp()
        cdp.emit_loading_failed = False
        page = FakePage(cdp)
        guard = GrokMediaCaptureGuard(page, page.marker, expected_prompt=PROMPT,
            operation='media.video.create', cdp_session=cdp, quiet_window_ms=1000)
        guard.arm()
        body = json.dumps({
            'message': PROMPT + ' --mode=custom',
            'mediaGenInput': {'textToVideo': {'prompt': PROMPT}},
        })
        cdp.network_ids['create-fetch'] = 'create-network'
        cdp.listeners['Fetch.requestPaused'](paused(
            'create-fetch', 'create-network', 'POST', 'https://grok.com/rest/app-chat/conversations/new', 'Fetch', body,
        ))
        proof = guard.abort_proof()
        self.assertTrue(proof['failRequestAck'])
        self.assertTrue(proof['networkIdPresent'])
        self.assertEqual(proof['loadingFailedCount'], 0)
        self.assertEqual(proof['responseCount'], 0)
        self.assertTrue(proof['intentMatch'])
        self.assertTrue(proof['verified'])
        self.assertTrue(guard.pagewide_http_proof()['verified'])
        guard.mark_task_terminal('failed')
        receipt = guard.close_after_quiescence()
        self.assertEqual(receipt['browserServerWritesDelivered'], 0)

    def test_cdp_block_proof_and_late_http_retry_hold_through_quiet_window(self):
        cdp = FakeCdp()
        page = FakePage(cdp)
        guard = GrokMediaCaptureGuard(page, page.marker, expected_prompt=PROMPT, cdp_session=cdp, quiet_window_ms=1000)
        guard.arm()

        read_event = paused(
            'read-fetch', 'read-network', 'GET', 'https://grok.com/api/auth/session', 'Fetch',
        )
        cdp.network_ids['read-fetch'] = 'read-network'
        cdp.listeners['Fetch.requestPaused'](read_event)
        self.assertIn('Fetch.continueRequest', [name for name, _ in cdp.commands])

        body = json.dumps({
            'modelName': 'imagine-video-gen',
            'message': PROMPT + ' --mode=custom',
            'mediaGenInput': {'textToVideo': {'prompt': PROMPT}},
        })
        create_event = paused(
            'create-fetch', 'create-network', 'POST', 'https://grok.com/rest/app-chat/conversations/new', 'Fetch', body,
            {'content-type': 'application/json', 'x-statsig-id': 'in-memory-only', 'x-xai-request-id': 'in-memory-only'},
        )
        cdp.network_ids['create-fetch'] = 'create-network'
        cdp.listeners['Fetch.requestPaused'](create_event)
        proof = guard.abort_proof()
        self.assertTrue(proof['failRequestAck'])
        self.assertTrue(proof['networkIdPresent'])
        self.assertEqual(proof['loadingFailedCount'], 1)
        self.assertEqual(proof['responseCount'], 0)
        self.assertTrue(proof['intentMatch'])
        self.assertTrue(proof['verified'])
        self.assertEqual(guard.captured_request['intentMatch'], True)
        self.assertEqual(set(guard.captured_request['headers']), {'x-statsig-id', 'x-xai-request-id'})

        page.late_retry_at_quiet = True
        guard.mark_task_terminal('needs_review')
        receipt = guard.close_after_quiescence()
        self.assertEqual(receipt['httpFailRequestAckCount'], 2)
        self.assertEqual(receipt['httpNetworkIdMissingCount'], 0)
        self.assertEqual(receipt['lateHttpRetriesBlocked'], 1)
        self.assertEqual(receipt['browserServerWritesDelivered'], 0)
        self.assertTrue(receipt['noLateBrowserWriteReachedServer'])
        self.assertEqual(page.websocket_pattern, 'wss://grok.com/**')

    def test_wss_intent_frames_are_captured_but_never_forwarded(self):
        cdp = FakeCdp()
        page = FakePage(cdp)
        guard = GrokMediaCaptureGuard(page, page.marker, expected_prompt=PROMPT, cdp_session=cdp)
        guard.arm()
        guard.begin_intent_capture()
        cdp.listeners['Network.webSocketCreated']({
            'requestId': 'ws-1', 'url': 'wss://grok.com/ws/imagine/listen',
        })
        cdp.listeners['Network.webSocketWillSendHandshakeRequest']({
            'requestId': 'ws-1',
            'request': {'headers': {
                'x-statsig-id': 'in-memory-only',
                'x-xai-request-id': 'in-memory-only',
                'x-castle-request-token': 'must-not-capture',
            }},
        })
        self.assertEqual(set(guard.request_metadata_headers), {'x-statsig-id', 'x-xai-request-id'})
        self.assertEqual(guard.unexpected_sdk_header_names, ['x-castle-request-token'])
        cdp.listeners['Network.webSocketHandshakeResponseReceived']({
            'requestId': 'ws-1', 'response': {'status': 101},
        })
        self.assertEqual(guard.websocket_handshake_statuses, [101])
        route = FakeWsRoute()
        page.websocket_handler(route)
        route.handler(image_frame('reset'))
        route.handler(image_frame('input_text', PROMPT))
        self.assertEqual(len(guard.captured_frames), 2)
        self.assertEqual(guard.websocket_intent_matches, 1)
        self.assertEqual(guard.websocket_duplicate_intent_frames, 0)
        self.assertEqual(guard.websocket_frames_forwarded, 0)
        self.assertEqual(route.server.sent, [])
        self.assertTrue(guard.one_shot_image_capture_proof()['verified'])
        guard.note_direct_write_dispatched()
        with self.assertRaisesRegex(RuntimeError, 'MEDIA_DIRECT_WRITE_LIMIT_REACHED'):
            guard.note_direct_write_dispatched()

    def test_current_single_native_input_frame_is_valid_without_a_synthetic_reset(self):
        cdp = FakeCdp()
        page = FakePage(cdp)
        guard = GrokMediaCaptureGuard(page, page.marker, expected_prompt=PROMPT, cdp_session=cdp)
        guard.arm()
        guard.begin_intent_capture()
        cdp.listeners['Network.webSocketCreated']({'requestId': 'ws-image', 'url': 'wss://grok.com/ws/imagine/listen'})
        cdp.listeners['Network.webSocketHandshakeResponseReceived']({'requestId': 'ws-image', 'response': {'status': 101}})
        route = FakeWsRoute()
        page.websocket_handler(route)
        route.handler(image_frame('input_text', PROMPT))
        proof = guard.one_shot_image_capture_proof()
        self.assertTrue(proof['verified'])
        self.assertEqual(proof['resetFrameCount'], 0)
        self.assertEqual(proof['matchingImageFrameCount'], 1)
        self.assertEqual(proof['browserFramesForwarded'], 0)
        self.assertEqual(route.server.sent, [])

    def test_asset_read_allowlist_is_exact_and_records_only_header_and_cookie_names(self):
        cdp = FakeCdp()
        page = FakePage(cdp)
        guard = GrokMediaCaptureGuard(page, page.marker, cdp_session=cdp, quiet_window_ms=1000)
        guard.arm()
        asset_url = 'https://assets.grok.com/users/opaque-user/generated/opaque-image'
        guard.allow_exact_asset_read(asset_url)
        cdp.listeners['Network.requestWillBeSentExtraInfo']({
            'requestId': 'asset-net',
            'headers': {'Cookie': 'sso=never-persist-this', 'Referer': 'https://grok.com/imagine'},
        })
        cdp.listeners['Network.requestWillBeSent']({
            'requestId': 'asset-net',
            'request': {'url': asset_url, 'headers': {'Cookie': 'sso=never-persist-this'}},
        })
        cdp.listeners['Fetch.requestPaused'](paused(
            'asset-fetch', 'asset-net', 'GET', asset_url, 'Document',
        ))
        cdp.listeners['Network.responseReceived']({
            'requestId': 'asset-net',
            'response': {'status': 200, 'mimeType': 'video/mp4', 'headers': {'content-type': 'video/mp4'}},
        })
        self.assertIn('Fetch.continueRequest', [name for name, _ in cdp.commands])
        self.assertEqual(guard._asset_request_cookie_names, {'sso'})
        self.assertEqual(guard._asset_response['status'], 200)

        guard.mark_task_terminal('needs_review')
        receipt = guard.close_after_quiescence()
        self.assertEqual(receipt['assetBrowserRequest']['attempts'], 1)
        self.assertEqual(receipt['assetBrowserRequest']['cookieNames'], ['sso'])
        self.assertNotIn('never-persist-this', json.dumps(receipt))

    def test_read_only_capture_keeps_page_guard_through_asset_read_and_late_retry_quiet_window(self):
        cdp = FakeCdp()
        page = FakePage(cdp)
        guard = GrokMediaCaptureGuard(page, page.marker, cdp_session=cdp, quiet_window_ms=1000)
        guard.arm()
        asset_url = 'https://assets.grok.com/users/opaque-user/generated/opaque-video.mp4?cache=1'
        guard.allow_exact_asset_read(asset_url)
        cdp.listeners['Network.requestWillBeSent']({
            'requestId': 'asset-net', 'request': {'url': asset_url, 'headers': {}},
        })
        cdp.listeners['Fetch.requestPaused'](paused(
            'asset-fetch', 'asset-net', 'GET', asset_url, 'Media',
        ))
        cdp.listeners['Network.responseReceived']({
            'requestId': 'asset-net',
            'response': {'status': 200, 'mimeType': 'video/mp4', 'headers': {'content-type': 'video/mp4'}},
        })
        page.late_retry_at_quiet = True
        guard.mark_task_terminal('completed')
        receipt = guard.close_read_only_after_quiescence()
        self.assertTrue(receipt['cleanPageRestored'])
        self.assertTrue(receipt['noBrowserWriteReachedServer'])
        self.assertEqual(receipt['lateHttpRetriesBlocked'], 1)
        self.assertEqual(receipt['browserServerWritesDelivered'], 0)
        self.assertEqual(receipt['assetBrowserRequests'][0]['requestCount'], 1)
        self.assertNotIn('opaque-video', json.dumps(receipt))

    def test_duplicate_wss_intent_frame_is_blocked_and_invalidates_one_shot_proof(self):
        cdp = FakeCdp()
        page = FakePage(cdp)
        guard = GrokMediaCaptureGuard(page, page.marker, expected_prompt=PROMPT, cdp_session=cdp)
        guard.arm()
        guard.begin_intent_capture()
        cdp.listeners['Network.webSocketCreated']({'requestId': 'ws-2', 'url': 'wss://grok.com/ws/imagine/listen'})
        cdp.listeners['Network.webSocketHandshakeResponseReceived']({'requestId': 'ws-2', 'response': {'status': 101}})
        route = FakeWsRoute()
        page.websocket_handler(route)
        route.handler(image_frame('reset'))
        route.handler(image_frame('input_text', PROMPT))
        route.handler(image_frame('input_text', PROMPT))
        self.assertEqual(guard.websocket_duplicate_intent_frames, 1)
        self.assertEqual(guard.websocket_frames_forwarded, 0)
        self.assertFalse(guard.one_shot_image_capture_proof()['verified'])


if __name__ == '__main__':
    unittest.main()
