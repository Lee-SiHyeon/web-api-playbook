import contextlib
import io
import json
import os
import runpy
import sys
import tempfile
import types
import unittest
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[1] / 'scripts' / 'grok_attachment_asset_download.py'
DATA = b'neutral-file-1'


class FakeCookies:
    def __init__(self): self.items = []; self.last_items = []
    def clear(self):
        if self.items: self.last_items = list(self.items)
        self.items.clear()
    def set(self, name, value, *, domain, path): self.items.append((name, value, domain, path))


class FakeResponse:
    status_code = 200
    headers = {'content-type': 'text/plain; charset=utf-8', 'content-length': str(len(DATA))}
    def iter_content(self, chunk_size):
        assert chunk_size == 8192
        yield DATA
    def close(self): pass


class FakeSession:
    def __init__(self, **kwargs):
        assert kwargs == {'impersonate': 'chrome150', 'verify': True, 'trust_env': False, 'retry': 0}
        self.cookies = FakeCookies()
        self.request = None
    def __enter__(self): return self
    def __exit__(self, *_): pass
    def get(self, url, **kwargs):
        self.request = (url, kwargs)
        assert kwargs['allow_redirects'] is False
        assert kwargs['stream'] is True
        assert kwargs['headers']['referer'] == 'https://grok.com/'
        return FakeResponse()


class AttachmentAssetDownloadTest(unittest.TestCase):
    def test_owner_scoped_download_verifies_remote_bytes_and_disk_copy(self):
        artifacts = Path.home() / 'artifacts'
        artifacts.mkdir(exist_ok=True)
        root = Path(tempfile.mkdtemp(prefix='.grok-attachment-reader-test-', dir=artifacts))
        root.chmod(0o700)
        session_holder = {}
        def session_factory(**kwargs):
            session_holder['session'] = FakeSession(**kwargs)
            return session_holder['session']
        requests = types.SimpleNamespace(Session=session_factory)
        curl_cffi = types.SimpleNamespace(__version__='0.16.3', requests=requests)
        old_cffi = sys.modules.get('curl_cffi')
        old_requests = sys.modules.get('curl_cffi.requests')
        sys.modules['curl_cffi'] = curl_cffi
        sys.modules['curl_cffi.requests'] = requests
        stdin = type('PacketStdin', (), {'buffer': io.BytesIO()})()
        packet = {
            'assetUrl': 'https://assets.grok.com/users/task-owner/files/private-task?cache=1',
            'assetOrigin': 'https://assets.grok.com', 'mimeType': 'text/plain',
            'expectedBytes': len(DATA), 'expectedSha256': 'ea625e61c345553c8460eb993d5cb6b9758e4b7768fc348a7f28580eb5c4bd4c',
            'assetCookieScope': {'domain': '.grok.com', 'httpOnly': True, 'path': '/', 'secure': True},
            'ssoCookieValue': 'normal-current-owner-sso',
            'headers': {'referer': 'https://grok.com/', 'user-agent': 'Mozilla/5.0 Chrome/154.0.0.0',
                        'sec-ch-ua-platform': '"Linux"'},
            'ownerIdentityDigest': 'a' * 64, 'outputRoot': str(root), 'outputName': 'roundtrip.txt',
            'maxBytes': 512 * 1024,
        }
        stdin.buffer.write(json.dumps(packet).encode())
        stdin.buffer.seek(0)
        old_stdin, old_stdout = sys.stdin, sys.stdout
        output = io.StringIO()
        try:
            sys.stdin, sys.stdout = stdin, output
            namespace = runpy.run_path(str(SCRIPT))
            code = namespace['main']()
        finally:
            sys.stdin, sys.stdout = old_stdin, old_stdout
            if old_cffi is None: sys.modules.pop('curl_cffi', None)
            else: sys.modules['curl_cffi'] = old_cffi
            if old_requests is None: sys.modules.pop('curl_cffi.requests', None)
            else: sys.modules['curl_cffi.requests'] = old_requests
        try:
            receipt = json.loads(output.getvalue())
            self.assertEqual(code, 0)
            self.assertEqual(receipt['status'], 200)
            self.assertEqual(receipt['mimeType'], 'text/plain')
            self.assertEqual(receipt['bodyBytes'], 14)
            self.assertTrue(receipt['bytesMatch'])
            self.assertEqual(receipt['cookieNamesUsed'], ['sso'])
            self.assertEqual(Path(receipt['artifactPath']).read_bytes(), DATA)
            self.assertEqual(session_holder['session'].cookies.last_items[0][2:], ('.grok.com', '/'))
            self.assertNotIn('normal-current-owner-sso', output.getvalue())
        finally:
            import shutil
            shutil.rmtree(root, ignore_errors=True)


if __name__ == '__main__':
    unittest.main()
