import contextlib
import importlib.util
import io
import json
import subprocess
import sys
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
READER = ROOT / 'scripts' / 'grok_media_asset_download.py'
VIDEO_READER = ROOT / 'scripts' / 'grok_media_video_submit.py'


class GrokMediaAssetReaderTest(unittest.TestCase):
    def test_video_helper_emits_safe_response_stage_diagnostics_and_clears_in_memory_payloads(self):
        spec = importlib.util.spec_from_file_location('grok_media_video_submit', VIDEO_READER)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        packet = {'bodyText': 'private prompt', 'cookies': [{'value': 'ephemeral-sso-value'}]}
        response_body = bytearray(b'{"conversationId":"private-conversation-test-1","response":{"responseId":"private-response-test-1"},"token":"must-not-leak"}')
        partial_resources = module.extract_partial_resources(response_body)
        self.assertEqual(partial_resources['conversationIds'], ['private-conversation-test-1'])
        self.assertEqual(partial_resources['responseIds'], ['private-response-test-1'])
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            with self.assertRaises(SystemExit) as raised:
                module.emit_error('CFFI_RESPONSE_STREAM_FAILED', evidence={
                    'stage': 'response_body', 'requestStarted': True, 'responseReceived': True,
                    'httpStatus': 200, 'contentType': 'application/json', 'httpVersion': 'h2',
                    'responseBytesRead': len(response_body), 'requestBodyBytes': 586,
                    'cfMitigated': False, 'errorClass': 'ConnectionError',
                    'requestHeaderNames': ['content-type', 'origin', 'referer', 'x-xai-request-id'],
                    'responseHeaderNames': ['content-type'], 'cookieNamesUsed': ['sso'],
                }, response_body=response_body, partial_resources=partial_resources, packet=packet)
        self.assertEqual(raised.exception.code, 2)
        value = json.loads(output.getvalue())
        self.assertEqual(value['error'], 'CFFI_RESPONSE_STREAM_FAILED')
        self.assertEqual(value['transportEvidence']['stage'], 'response_body')
        self.assertEqual(value['transportEvidence']['httpStatus'], 200)
        self.assertEqual(value['transportEvidence']['responseBytesRead'], len(b'{"conversationId":"private-conversation-test-1","response":{"responseId":"private-response-test-1"},"token":"must-not-leak"}'))
        self.assertEqual(value['transportEvidence']['errorClass'], 'ConnectionError')
        self.assertEqual(value['partialResources']['conversationIds'], ['private-conversation-test-1'])
        self.assertEqual(value['partialResources']['responseIds'], ['private-response-test-1'])
        self.assertNotIn('must-not-leak', output.getvalue())
        self.assertNotIn('"token"', output.getvalue())
        self.assertNotIn('ephemeral-sso-value', output.getvalue())
        self.assertEqual(packet['bodyText'], '')
        self.assertEqual(packet['cookies'][0]['value'], '')
        self.assertEqual(response_body, bytearray(len(response_body)))

    def test_rejects_unapproved_cookie_before_network(self):
        packet = {
            'assetUrl': 'https://assets.grok.com/users/owner/generated/image.jpg?cache=1',
            'mimeType': 'image/jpeg',
            'maxBytes': 10_000,
            'requestTimeoutMs': 10_000,
            'observedCookieNames': ['sso'],
            'cookies': [{'name': 'cf_clearance', 'value': 'never-forward-this', 'domain': '.grok.com',
                         'path': '/', 'secure': True, 'httpOnly': True}],
            'headers': {'referer': 'https://grok.com/', 'user-agent': 'ordinary-test',
                        'sec-ch-ua-platform': '"Linux"'},
        }
        result = subprocess.run([sys.executable, str(READER)], input=json.dumps(packet), text=True,
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=10, check=False)
        self.assertEqual(result.returncode, 2)
        value = json.loads(result.stdout)
        self.assertEqual(value['failure'], 'COOKIE_SCOPE_INVALID')
        self.assertFalse(value['cookiesUsed'])
        self.assertNotIn('never-forward-this', result.stdout)
        self.assertNotIn('cf_clearance', result.stdout)
        self.assertEqual(result.stderr, '')

    def test_rejects_cross_origin_asset_before_network(self):
        packet = {
            'assetUrl': 'https://attacker.example/users/owner/generated/image.jpg?cache=1',
            'mimeType': 'image/jpeg',
            'maxBytes': 10_000,
            'requestTimeoutMs': 10_000,
            'observedCookieNames': ['sso'],
            'cookies': [{'name': 'sso', 'value': 'ordinary-test-cookie', 'domain': '.grok.com',
                         'path': '/', 'secure': True, 'httpOnly': True}],
            'headers': {'referer': 'https://grok.com/', 'user-agent': 'ordinary-test',
                        'sec-ch-ua-platform': '"Linux"'},
        }
        result = subprocess.run([sys.executable, str(READER)], input=json.dumps(packet), text=True,
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=10, check=False)
        self.assertEqual(result.returncode, 2)
        value = json.loads(result.stdout)
        self.assertEqual(value['failure'], 'ASSET_URL_SCOPE')
        self.assertFalse(value['cookiesUsed'])
        self.assertNotIn('ordinary-test-cookie', result.stdout)
        self.assertEqual(result.stderr, '')

    def test_video_transport_rejects_challenge_cookie_before_network(self):
        prompt = 'A neutral test video of slowly drifting geometric shapes.'
        video_body = {
            'enableImageStreaming': True,
            'enableSideBySide': True,
            'kind': 'CONVERSATION_KIND_IMAGINE',
            'mediaGenInput': {'textToVideo': {
                'aspectRatio': '2:3', 'duration': 6, 'prompt': prompt,
                'resolutionName': '480p', 'skipAudio': True,
            }},
            'message': prompt + ' --mode=custom',
            'modelName': 'imagine-video-gen',
            'responseMetadata': {'experiments': [], 'modelConfigOverride': {'modelMap': {}}},
            'sendFinalMetadata': True,
        }
        packet = {
            'url': 'https://grok.com/rest/app-chat/conversations/new',
            'method': 'POST', 'timeoutMs': 20_000,
            'observedCookieNames': ['sso'], 'bodyText': json.dumps(video_body),
            'headers': {
                'accept': 'application/json', 'content-type': 'application/json',
                'origin': 'https://grok.com', 'referer': 'https://grok.com/imagine',
                'user-agent': 'Mozilla/5.0 Chrome/154.0.0.0 Safari/537.36',
                'sec-ch-ua-platform': '"Linux"', 'x-statsig-id': 'safe-sdk-id', 'x-xai-request-id': 'safe-request-id',
            },
            'cookies': [{'name': 'cf_clearance', 'value': 'never-forward-this', 'domain': '.grok.com',
                         'path': '/', 'secure': True, 'httpOnly': True}],
        }
        result = subprocess.run([sys.executable, str(VIDEO_READER)], input=json.dumps(packet), text=True,
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=10, check=False)
        self.assertEqual(result.returncode, 2)
        self.assertEqual(json.loads(result.stdout)['error'], 'COOKIE_SCOPE_INVALID')
        self.assertNotIn('never-forward-this', result.stdout)
        self.assertNotIn('cf_clearance', result.stdout)
        self.assertEqual(result.stderr, '')

    def test_video_http_helper_rejects_challenge_cookie_before_network(self):
        prompt = 'A neutral test video of slowly drifting geometric shapes.'
        body = {
            'enableImageStreaming': True,
            'enableSideBySide': True,
            'kind': 'CONVERSATION_KIND_IMAGINE',
            'mediaGenInput': {'textToVideo': {'prompt': prompt, 'aspectRatio': '2:3', 'duration': 6,
                'resolutionName': '480p', 'skipAudio': True}},
            'message': prompt + ' --mode=custom', 'modelName': 'imagine-video-gen',
            'responseMetadata': {'experiments': [], 'modelConfigOverride': {'modelMap': {}}},
            'sendFinalMetadata': True,
        }
        packet = {
            'url': 'https://grok.com/rest/app-chat/conversations/new', 'method': 'POST',
            'timeoutMs': 20_000, 'observedCookieNames': ['sso'], 'bodyText': json.dumps(body),
            'headers': {
                'accept': 'application/json', 'content-type': 'application/json',
                'origin': 'https://grok.com', 'referer': 'https://grok.com/imagine',
                'user-agent': 'Mozilla/5.0 Chrome/154.0.0.0 Safari/537.36',
                'sec-ch-ua-platform': '"Linux"', 'x-statsig-id': 'safe-sdk-id', 'x-xai-request-id': 'safe-request-id',
            },
            'cookies': [{'name': 'cf_clearance', 'value': 'never-forward-this', 'domain': '.grok.com',
                         'path': '/', 'secure': True, 'httpOnly': True}],
        }
        result = subprocess.run([sys.executable, str(VIDEO_READER)], input=json.dumps(packet), text=True,
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=10, check=False)
        self.assertEqual(result.returncode, 2)
        self.assertEqual(json.loads(result.stdout)['error'], 'COOKIE_SCOPE_INVALID')
        self.assertNotIn('never-forward-this', result.stdout)
        self.assertNotIn('cf_clearance', result.stdout)
        self.assertEqual(result.stderr, '')


if __name__ == '__main__':
    unittest.main()
